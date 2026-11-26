import {
  setFlowCookies,
  takeFlowCookies,
  toFailureLocation,
  toSuccessLocation,
} from '#core/auth/oauth/flow.js';
import {
  assertOauthConfig,
  createAuthorization,
  exchangeCode,
  readProviderProfile,
} from '#core/auth/oauth/provider.js';
import { AppError } from '#core/error/index.js';
import { CLIENT_AUTHENTICATION } from '#enums/client-authentication.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { createMockProvider, REFUSAL_DESCRIPTION, signInThroughProvider } from '#root/tests/helper/oauth.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { readClaims } from '#root/tests/helper/session.js';
import { encodeFormValue } from '#utils/encoding.js';
import { sha256, timingSafeEqual } from '#utils/hash.js';
import { compact, pick } from '#utils/object.js';
import { randomToken } from '#utils/random.js';
import { isNonEmptyString } from '#utils/type.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const REDIRECT_URI = 'https://app.test/api/v1/auth/mock/callback';
const VERIFIER = randomToken();
const CHALLENGE = sha256(VERIFIER, 'base64url');
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const SHORT_TIMEOUT_MS = 200;

const START_PATH = '/api/v1/auth/mock';
const CALLBACK_PATH = `${START_PATH}/callback`;
const FAILURE_LOCATION = 'https://app.test/auth/login?authError=AUTHENTICATION_ERROR';
// The contract of a route under the API prefix: a redirect is the one answer of a start and of a callback.
const REDIRECT_SCHEMA = Object.freeze({ response: { [HTTP_STATUS.FOUND]: { type: 'null', description: 'Found' } } });

// Never anywhere but at the mock: a pair of the kind form encoding exists for.
const BASIC_CLIENT = Object.freeze({ clientId: 'corp:client id+1', clientSecret: 'secret/=%&~' });

function refusalOf(status, error) {
  return { status, body: { error, error_description: REFUSAL_DESCRIPTION } };
}

function issue(mock, grant = {}) {
  return mock.issueCode({ challenge: CHALLENGE, redirectUri: REDIRECT_URI, ...grant });
}

// The form of a token request as a client of the record sends it; an override of undefined leaves a field out.
function toForm(mock, code, overrides = {}) {
  return compact({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: VERIFIER,
    client_id: mock.record.clientId,
    client_secret: mock.record.clientSecret,
    ...overrides,
  });
}

function toBasic({ clientId, clientSecret }) {
  return `Basic ${Buffer.from(`${encodeFormValue(clientId)}:${encodeFormValue(clientSecret)}`).toString('base64')}`;
}

async function readAnswer(response) {
  const text = await response.text();

  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

async function postToken(mock, form, { headers = {}, signal } = {}) {
  const response = await fetch(`${mock.url}/token`, {
    method: 'POST',
    headers: { 'content-type': FORM_CONTENT_TYPE, ...headers },
    body: new URLSearchParams(form).toString(),
    signal,
  });

  return readAnswer(response);
}

// A start and a callback made of the functions of the core, as small as a walk needs; a start asked for a link refuses.
async function buildSignInApp(t, mock) {
  const fastify = await buildTestApp({ env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()) } });
  const seen = {
    cookies: [],
    agents: [],
    queries: [],
    profiles: [],
  };
  const redirectUri = `${fastify.config.app.url}${CALLBACK_PATH}`;
  const routeOptions = {
    schema: REDIRECT_SCHEMA,
    security: { auth: false },
    exposeHeadRoute: false,
    config: { failureLocation: toFailureLocation },
  };

  t.after(() => fastify.close());

  fastify.get(START_PATH, routeOptions, async (request, reply) => {
    seen.cookies.push(request.headers.cookie ?? null);
    seen.agents.push(request.headers['user-agent']);
    seen.queries.push({ ...request.query });

    if (request.query.link !== undefined) {
      throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
    }

    const { url, state, verifier } = createAuthorization(mock.record, { redirectUri });

    setFlowCookies(reply, {
      path: CALLBACK_PATH,
      state,
      verifier,
      target: request.query.redirect ?? null,
    });

    return reply.redirect(url, HTTP_STATUS.FOUND);
  });

  fastify.get(CALLBACK_PATH, routeOptions, async (request, reply) => {
    const { code, state, error } = request.query;
    const flow = takeFlowCookies(request, reply, { path: CALLBACK_PATH });

    seen.cookies.push(request.headers.cookie ?? null);
    seen.agents.push(request.headers['user-agent']);

    if (flow === null || error !== undefined || !isNonEmptyString(code) || !timingSafeEqual(flow.state, state)) {
      throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
    }

    const claims = await exchangeCode(mock.record, { code, verifier: flow.verifier, redirectUri });

    seen.profiles.push(readProviderProfile(mock.record, claims));

    return reply.redirect(toSuccessLocation(request.server.config, { target: flow.target }), HTTP_STATUS.FOUND);
  });

  return { fastify, seen };
}

describe('createMockProvider: the token endpoint', () => {
  test('answers a code it issued with an id_token of its claims over the defaults, a token type and an access token', async (t) => {
    const mock = await createMockProvider(t);
    const code = issue(mock, { claims: { sub: 'subject-1', email: 'anna@example.com', iat: undefined } });
    const answer = await postToken(mock, toForm(mock, code));
    const claims = readClaims(answer.body.id_token);

    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body).sort(), ['access_token', 'expires_in', 'id_token', 'token_type']);
    assert.equal(answer.body.token_type, 'Bearer');
    assert.equal(answer.body.id_token.split('.').length, 3);
    assert.deepEqual(pick(claims, ['iss', 'aud', 'sub', 'email']), {
      iss: mock.url,
      aud: 'mock-client',
      sub: 'subject-1',
      email: 'anna@example.com',
    });
    assert.equal(Object.hasOwn(claims, 'iat'), false);
    assert.deepEqual(mock.requests.map(({ method, path, form }) => ({ method, path, form })), [{ method: 'POST', path: '/token', form: toForm(mock, code) }]);
  });

  test('gives an id_token a random subject and ten minutes of life when the code names neither', async (t) => {
    const mock = await createMockProvider(t);
    const [first, second] = await Promise.all([issue(mock), issue(mock)].map((code) => postToken(mock, toForm(mock, code))));
    const [firstClaims, secondClaims] = [first, second].map((answer) => readClaims(answer.body.id_token));

    assert.ok(isNonEmptyString(firstClaims.sub));
    assert.notEqual(firstClaims.sub, secondClaims.sub);
    assert.equal(firstClaims.exp - firstClaims.iat, 600);
  });

  test('checks PKCE S256: a verifier whose hash is not the challenge of its code, one of another form than RFC 7636 and none are invalid_grant', async (t) => {
    const mock = await createMockProvider(t);
    const short = 'a'.repeat(42);
    const answers = await Promise.all([
      postToken(mock, toForm(mock, issue(mock), { code_verifier: randomToken() })),
      postToken(mock, toForm(mock, issue(mock, { challenge: sha256(short, 'base64url') }), { code_verifier: short })),
      postToken(mock, toForm(mock, issue(mock), { code_verifier: undefined })),
    ]);

    assert.deepEqual(answers, answers.map(() => refusalOf(400, 'invalid_grant')));
    assert.equal((await postToken(mock, toForm(mock, issue(mock)))).status, 200);
  });

  test('takes client_secret_post credentials in the body alone: a wrong secret, none, or a Basic header beside them is invalid_client', async (t) => {
    const mock = await createMockProvider(t);
    const answers = await Promise.all([
      postToken(mock, toForm(mock, issue(mock), { client_secret: 'another-secret' })),
      postToken(mock, toForm(mock, issue(mock), { client_secret: undefined })),
      postToken(mock, toForm(mock, issue(mock)), { headers: { authorization: toBasic(mock.record) } }),
    ]);

    assert.deepEqual(answers, answers.map(() => refusalOf(401, 'invalid_client')));
  });

  test('takes client_secret_basic credentials in a Basic header, form-encoded per RFC 6749 §2.3.1, and refuses them otherwise or with a secret in the body', async (t) => {
    const mock = await createMockProvider(t, { clientAuthentication: CLIENT_AUTHENTICATION.BASIC, ...BASIC_CLIENT });
    const raw = `Basic ${Buffer.from(`${BASIC_CLIENT.clientId}:${BASIC_CLIENT.clientSecret}`).toString('base64')}`;
    const withoutSecret = { client_secret: undefined };
    const [taken, ...refused] = await Promise.all([
      postToken(mock, toForm(mock, issue(mock), withoutSecret), { headers: { authorization: toBasic(BASIC_CLIENT) } }),
      postToken(mock, toForm(mock, issue(mock), withoutSecret), { headers: { authorization: raw } }),
      postToken(mock, toForm(mock, issue(mock)), { headers: { authorization: toBasic(BASIC_CLIENT) } }),
      postToken(mock, toForm(mock, issue(mock))),
    ]);

    assert.equal(taken.status, 200);
    assert.deepEqual(refused, refused.map(() => refusalOf(401, 'invalid_client')));
  });

  test('refuses a code used twice, one it never issued and one sent with another redirect_uri with invalid_grant', async (t) => {
    const mock = await createMockProvider(t);
    const code = issue(mock);
    const first = await postToken(mock, toForm(mock, code));
    const answers = await Promise.all([
      postToken(mock, toForm(mock, code)),
      postToken(mock, toForm(mock, 'never-issued')),
      postToken(mock, toForm(mock, issue(mock), { redirect_uri: 'https://evil.example.com/callback' })),
    ]);

    assert.equal(first.status, 200);
    assert.deepEqual(answers, answers.map(() => refusalOf(400, 'invalid_grant')));
  });

  test('refuses another grant type, and a body that is not a form', async (t) => {
    const mock = await createMockProvider(t);
    const answers = await Promise.all([
      postToken(mock, toForm(mock, issue(mock), { grant_type: 'refresh_token' })),
      postToken(mock, toForm(mock, issue(mock)), { headers: { 'content-type': 'application/json' } }),
    ]);

    assert.deepEqual(answers, [refusalOf(400, 'unsupported_grant_type'), refusalOf(400, 'invalid_request')]);
  });

  test('answers with the override of a code once its request passes the checks, and not at all for one that hangs', async (t) => {
    const mock = await createMockProvider(t);
    const override = { status: 503, body: 'Service Unavailable' };
    const answers = await Promise.all([
      postToken(mock, toForm(mock, issue(mock, { answer: override }))),
      postToken(mock, toForm(mock, issue(mock, { answer: override }), { client_secret: 'another-secret' })),
      postToken(mock, toForm(mock, issue(mock, { answer: { body: { error: 'invalid_grant' } } }))),
    ]);

    assert.deepEqual(answers, [override, refusalOf(401, 'invalid_client'), { status: 200, body: { error: 'invalid_grant' } }]);
    await assert.rejects(postToken(mock, toForm(mock, issue(mock, { answer: { isHanging: true } })), { signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) }), { name: 'TimeoutError' });
  });
});

describe('createMockProvider: the record and the consent', () => {
  test('gives a record with credentials that assertOauthConfig() takes beside the providers of the config, with the fields a test names', async (t) => {
    const mock = await createMockProvider(t);
    const corp = await createMockProvider(t, { id: 'corp', clientAuthentication: CLIENT_AUTHENTICATION.BASIC, authorizationParams: { prompt: 'login' } });
    const { oauth } = createTestConfig({ oauth: { providers: [...createTestConfig().oauth.providers, mock.record, corp.record] } });

    assert.equal(assertOauthConfig(oauth), true);
    assert.ok(Object.isFrozen(mock.record));
    assert.deepEqual(mock.record, {
      id: 'mock',
      name: 'Mock',
      issuers: [mock.url],
      authorizationUrl: `${mock.url}/authorize`,
      tokenUrl: `${mock.url}/token`,
      scope: 'openid email profile',
      authorizationParams: {},
      clientAuthentication: 'client_secret_post',
      claims: {
        subject: 'sub',
        email: 'email',
        isEmailVerified: 'email_verified',
        firstName: ['given_name', 'name'],
        lastName: 'family_name',
      },
      clientId: 'mock-client',
      clientSecret: 'mock-secret',
    });
    assert.deepEqual(pick(corp.record, ['id', 'clientAuthentication', 'authorizationParams']), {
      id: 'corp',
      clientAuthentication: 'client_secret_basic',
      authorizationParams: { prompt: 'login' },
    });
  });

  test('authorize() sends the browser back to the callback with a code bound to the challenge and the redirect_uri, and the state', async (t) => {
    const mock = await createMockProvider(t);
    const redirectUri = `${REDIRECT_URI}?from=test`;
    const { url, state, verifier } = createAuthorization(mock.record, { redirectUri });
    const consent = mock.authorize(url, { claims: { sub: 'subject-2' } });
    const back = new URL(consent.location);
    const answer = await postToken(mock, toForm(mock, consent.code, { code_verifier: verifier, redirect_uri: redirectUri }));

    assert.equal(`${back.origin}${back.pathname}`, REDIRECT_URI);
    assert.deepEqual(Object.fromEntries(back.searchParams), { from: 'test', code: consent.code, state });
    assert.equal(consent.state, state);
    assert.equal(readClaims(answer.body.id_token).sub, 'subject-2');
  });

  test('authorize() sends the browser back with the error of a sign-in the user did not finish, and no code', async (t) => {
    const mock = await createMockProvider(t);
    const { url, state } = createAuthorization(mock.record, { redirectUri: REDIRECT_URI });
    const consent = mock.authorize(url, { error: 'access_denied' });

    assert.equal(consent.code, null);
    assert.deepEqual(Object.fromEntries(new URL(consent.location).searchParams), { error: 'access_denied', state });
  });

  test('authorize() refuses a request a provider would not take, naming what it lacks', async (t) => {
    const mock = await createMockProvider(t);
    const corp = await createMockProvider(t, { id: 'corp', authorizationParams: { prompt: 'login' } });
    const { url } = createAuthorization(mock.record, { redirectUri: REDIRECT_URI });
    const changes = [
      [(params) => params.set('response_type', 'token'), /response_type=code/],
      [(params) => params.set('client_id', 'another-client'), /the client_id of the record/],
      [(params) => params.delete('redirect_uri'), /a redirect_uri/],
      [(params) => params.set('scope', 'email profile'), /a scope with openid/],
      [(params) => params.delete('state'), /a state/],
      [(params) => params.delete('code_challenge'), /a code_challenge/],
      [(params) => params.set('code_challenge_method', 'plain'), /code_challenge_method=S256/],
    ];

    changes.forEach(([change, message]) => {
      const changed = new URL(url);

      change(changed.searchParams);
      assert.throws(() => mock.authorize(changed.href), { message }, String(message));
    });
    assert.throws(() => mock.authorize(url.replace(mock.url, 'https://evil.example.com')), /the address of the authorization endpoint/);
    assert.throws(() => corp.authorize(url.replace(mock.url, corp.url)), /prompt=login/);
  });
});

describe('signInThroughProvider', () => {
  test('walks the start, the consent and the callback as a browser: the flow cookies ride to the callback alone, and the sign-in ends on its target', async (t) => {
    const mock = await createMockProvider(t);
    const { fastify, seen } = await buildSignInApp(t, mock);
    const claims = {
      sub: 'subject-3',
      email: 'Anna@Example.com',
      email_verified: true,
      given_name: 'Anna Maria',
    };
    const result = await signInThroughProvider(fastify, mock, { claims, redirect: '/profile' });

    assert.equal(result.start.statusCode, 302);
    assert.equal(mock.isAuthorizationUrl(result.start.headers.location), true);
    assert.deepEqual(result.start.cookies.map(({ name, path }) => [name, path]), [['oauthState', CALLBACK_PATH], ['oauthRedirect', CALLBACK_PATH]]);
    assert.equal(result.authorization.state, new URL(result.start.headers.location).searchParams.get('state'));
    assert.deepEqual([result.callback.statusCode, result.location], [302, 'https://app.test/profile']);
    assert.deepEqual(result.callback.cookies.map(({ name, maxAge }) => [name, maxAge]), [['oauthState', 0], ['oauthRedirect', 0]]);
    assert.deepEqual(pick(seen.profiles[0], ['subject', 'email', 'isEmailVerified', 'firstName']), {
      subject: 'subject-3',
      email: 'anna@example.com',
      isEmailVerified: true,
      firstName: 'Anna',
    });
    assert.deepEqual(seen.queries, [{ redirect: '/profile' }]);
    assert.equal(seen.cookies[0], null);
    assert.match(seen.cookies[1], /^oauthState=[\w-]+\.[\w-]+\.login; oauthRedirect=[\w-]+$/);
    assert.equal(mock.requests.length, 1);
  });

  test('sends the cookies and the headers it is given to the start and to the callback, and the cookies given for the callback in their place there', async (t) => {
    const mock = await createMockProvider(t);
    const { fastify, seen } = await buildSignInApp(t, mock);
    const headers = { 'user-agent': 'walk-agent' };

    await signInThroughProvider(fastify, mock, { cookies: { marker: 'browser' }, headers });
    await signInThroughProvider(fastify, mock, { cookies: { marker: 'browser' }, callbackCookies: { marker: 'other-browser' } });

    assert.equal(seen.cookies[0], 'marker=browser');
    assert.match(seen.cookies[1], /^marker=browser; oauthState=/);
    assert.equal(seen.cookies[2], 'marker=browser');
    assert.match(seen.cookies[3], /^marker=other-browser; oauthState=/);
    assert.deepEqual(seen.agents.slice(0, 2), ['walk-agent', 'walk-agent']);
    assert.notEqual(seen.agents[2], 'walk-agent');
    assert.equal(seen.profiles.length, 2);
  });

  test('changes the query of the callback as it is told: a forged state or no code ends the sign-in without a call of the token endpoint', async (t) => {
    const mock = await createMockProvider(t);
    const { fastify } = await buildSignInApp(t, mock);
    const results = await Promise.all([{ state: 'forged-state' }, { code: null }].map((callbackQuery) => signInThroughProvider(fastify, mock, { callbackQuery })));

    assert.deepEqual(results.map((result) => result.location), [FAILURE_LOCATION, FAILURE_LOCATION]);
    assert.equal(new URL(results[1].callback.raw.req.url, 'https://app.test').searchParams.has('code'), false);
    assert.deepEqual(mock.requests, []);
  });

  test('carries the error of the consent and the answer of the code to the provider', async (t) => {
    const mock = await createMockProvider(t);
    const { fastify, seen } = await buildSignInApp(t, mock);
    const denied = await signInThroughProvider(fastify, mock, { error: 'access_denied' });
    const refused = await signInThroughProvider(fastify, mock, { answer: { status: 400, body: { error: 'invalid_grant' } } });

    assert.equal(denied.authorization.code, null);
    assert.deepEqual([denied.location, refused.location], [FAILURE_LOCATION, FAILURE_LOCATION]);
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(seen.profiles, []);
  });

  test('ends the walk at a start that does not send the browser to the provider, with the location it gave', async (t) => {
    const mock = await createMockProvider(t);
    const { fastify, seen } = await buildSignInApp(t, mock);
    const result = await signInThroughProvider(fastify, mock, { link: true, redirect: '/settings' });

    assert.deepEqual(pick(result, ['authorization', 'callback', 'location']), { authorization: null, callback: null, location: FAILURE_LOCATION });
    assert.equal(result.start.statusCode, 302);
    assert.deepEqual(seen.queries, [{ redirect: '/settings', link: 'true' }]);
    assert.deepEqual(mock.requests, []);
  });
});
