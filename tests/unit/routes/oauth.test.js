import { CLIENT_ADDRESS_HEADERS } from '#core/auth/client.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import { getProvidersSchema } from '#root/src/routes/v1/auth/controller.js';
import { buildTestApp, errorBody, successBody } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { DEV_ENV } from '#root/tests/helper/guard.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { createMockProvider, signInThroughProvider } from '#root/tests/helper/oauth.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { buildDownApp } from '#root/tests/helper/session.js';
import { encodeBase64Url } from '#utils/encoding.js';
import { sha256 } from '#utils/hash.js';
import { REDIRECT_PATH_MAX_LENGTH } from '#utils/validate.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PROVIDERS_URL = '/api/v1/auth/providers';
const LOGIN_DEV_URL = '/api/v1/auth/login-dev';
const START_URL = '/api/v1/auth/mock';
const CALLBACK_URL = `${START_URL}/callback`;

// APP_HOST of the tests is "app.test", and the protocol is https unless a test names another.
const APP_URL = 'https://app.test';
const HTTP_APP_URL = 'http://app.test';
const FAILURE_LOCATION = `${APP_URL}/auth/login?authError=AUTHENTICATION_ERROR`;

const HTTP_ENV = Object.freeze({ APP_PROTOCOL: 'http' });
const GOOGLE_ENV = Object.freeze({ APP_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id', APP_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret' });

const NO_STORE = 'no-store';
const STATE_TTL_SECONDS = 600;
const TOKEN_LENGTH = 43;
const EMAIL = 'anna@example.com';
const LOOPBACK = '127.0.0.1';
const FOREIGN_IP = '203.0.113.7';

const SIGN_IN_MESSAGE = 'Sign-in is set up';
const NOBODY_MESSAGE = 'Nobody can sign in: no provider has both of its credentials (APP_OAUTH_<ID>_CLIENT_ID, APP_OAUTH_<ID>_CLIENT_SECRET), and the dev sign-in is there in dev mode alone';

const PROXY_HEADERS = Object.freeze(CLIENT_ADDRESS_HEADERS.filter((name) => name !== HEADER.X_FORWARDED_FOR));

// The attributes of a flow cookie over https.
const FLOW_ATTRIBUTES = Object.freeze({
  path: CALLBACK_URL,
  httpOnly: true,
  sameSite: 'Lax',
  secure: true,
});
const SET = Object.freeze({ ...FLOW_ATTRIBUTES, maxAge: STATE_TTL_SECONDS });
const CLEARED = Object.freeze({
  ...FLOW_ATTRIBUTES,
  value: '',
  maxAge: 0,
  expires: new Date(0),
});

// The mock is the third provider of the config, beside the two of the repository, which have credentials only when env
// gives them.
async function buildApp(t, { mock = null, env = {}, ...sections } = {}) {
  const { providers } = createTestConfig({ env }).oauth;

  return buildDownApp(t, {
    ...sections,
    env,
    oauth: {
      providers: mock === null
        ? providers
        : [...providers, mock.record],
    },
  });
}

function readCookies(response) {
  return response.cookies.map((cookie) => ({ ...cookie }));
}

function findCookie(response, name) {
  return readCookies(response).find((cookie) => cookie.name === name);
}

function describeRedirect(response) {
  return {
    statusCode: response.statusCode,
    location: response.headers[HEADER.LOCATION],
    cacheControl: response.headers[HEADER.CACHE_CONTROL],
    challenge: response.headers[HEADER.WWW_AUTHENTICATE],
    body: response.payload,
  };
}

function redirectTo(location) {
  return {
    statusCode: 302,
    location,
    cacheControl: NO_STORE,
    challenge: undefined,
    body: '',
  };
}

function clearedFlowCookies() {
  return [{ name: COOKIE.OAUTH_STATE, ...CLEARED }, { name: COOKIE.OAUTH_REDIRECT, ...CLEARED }];
}

// The parts of the state cookie of a start, which the test cannot read from anywhere else: the verifier is the
// browser's alone.
function readStateCookie(response) {
  const [state, verifier, mode] = findCookie(response, COOKIE.OAUTH_STATE).value.split('.');

  return { state, verifier, mode };
}

function postLoginDev(fastify, request = {}) {
  return fastify.inject({
    method: 'POST',
    url: LOGIN_DEV_URL,
    payload: { email: EMAIL },
    ...request,
  });
}

describe('GET /api/v1/auth/providers', () => {
  test('lists the providers that have both credentials, in the order of the config, by id and name alone: the third is one record of the config', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock, env: GOOGLE_ENV });
    const response = await fastify.inject(PROVIDERS_URL);
    const secrets = [...Object.values(GOOGLE_ENV), mock.record.clientId, mock.record.clientSecret];

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), successBody(response, [{ id: 'google', name: 'Google' }, { id: 'mock', name: 'Mock' }]));
    assert.deepEqual(secrets.filter((secret) => response.payload.includes(secret)), []);
  });

  test('is an empty list while no provider has its credentials, and is public: a token nobody can use is no reason to refuse it', async (t) => {
    const fastify = await buildApp(t);
    const responses = await Promise.all([
      fastify.inject(PROVIDERS_URL),
      fastify.inject({ url: PROVIDERS_URL, headers: { [HEADER.AUTHORIZATION]: 'Bearer garbage' } }),
    ]);

    assert.deepEqual(responses.map((response) => [response.statusCode, response.json()]), responses.map((response) => [200, successBody(response, [])]));
  });

  test('lets out the id and the name alone of a record a handler would hand out whole', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock });

    fastify.get('/api/v1/leaks/providers', { schema: getProvidersSchema, security: { auth: false } }, (request, reply) => reply.list({ data: [mock.record] }));

    const response = await fastify.inject('/api/v1/leaks/providers');

    assert.deepEqual(response.json(), successBody(response, [{ id: 'mock', name: 'Mock' }]));
  });
});

describe('routes of a provider', () => {
  test('a provider without its credentials has none: its start and its callback are the 404 of an unknown path; and those of a provider with them have no HEAD twin', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock });
    const disabled = await Promise.all([
      '/api/v1/auth/google',
      '/api/v1/auth/google/callback?code=a-code&state=a-state',
      '/api/v1/auth/telegram',
      '/api/v1/auth/telegram/callback',
    ].map((url) => fastify.inject(url)));
    const heads = await Promise.all([START_URL, CALLBACK_URL].map((url) => fastify.inject({ method: 'HEAD', url })));
    const responses = [...disabled, ...heads];

    assert.deepEqual(
      responses.map((response) => [response.statusCode, response.json(), response.headers[HEADER.SET_COOKIE]]),
      responses.map((response) => [404, errorBody(response, 'NOT_FOUND_ERROR', 'Not found'), undefined]),
    );
    assert.deepEqual(mock.requests, []);
  });

  test('an app whose record of a provider is wrong does not start: this one would take the place of a route of auth', async () => {
    const { providers } = createTestConfig().oauth;
    const env = { ...REDIS_DOWN_ENV, ...(await createDownEnv()) };

    await assert.rejects(
      buildTestApp({ env, oauth: { providers: [...providers, { ...providers[0], id: 'providers' }] } }),
      (error) => error instanceof TypeError && /not the name of an auth route/.test(error.message),
    );
  });
});

describe('GET /api/v1/auth/<id>: the start of a sign-in', () => {
  test('sends the browser to the provider with the parameters of the flow, and sets the two flow cookies on the path of the callback: httpOnly, Lax, Secure over https, for ten minutes', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock });
    const response = await fastify.inject(`${START_URL}?redirect=/profile`);
    const location = new URL(response.headers[HEADER.LOCATION]);
    const { state, verifier, mode } = readStateCookie(response);

    assert.deepEqual(describeRedirect(response), redirectTo(location.href));
    assert.equal(`${location.origin}${location.pathname}`, mock.record.authorizationUrl);
    assert.deepEqual(Object.fromEntries(location.searchParams), {
      response_type: 'code',
      client_id: mock.record.clientId,
      redirect_uri: `${APP_URL}${CALLBACK_URL}`,
      scope: 'openid email profile',
      state,
      code_challenge: sha256(verifier, 'base64url'),
      code_challenge_method: 'S256',
    });
    assert.deepEqual([state.length, verifier.length, mode], [TOKEN_LENGTH, TOKEN_LENGTH, 'login']);
    assert.deepEqual(readCookies(response), [
      { name: COOKIE.OAUTH_STATE, value: `${state}.${verifier}.login`, ...SET },
      { name: COOKIE.OAUTH_REDIRECT, value: encodeBase64Url('/profile'), ...SET },
    ]);
    assert.doesNotThrow(() => mock.authorize(location.href));
    assert.deepEqual(mock.requests, []);
  });

  test('over http sets the flow cookies without Secure and names a callback of http', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock, env: HTTP_ENV });
    const response = await fastify.inject(START_URL);
    const location = new URL(response.headers[HEADER.LOCATION]);

    assert.equal(location.searchParams.get('redirect_uri'), `${HTTP_APP_URL}${CALLBACK_URL}`);
    assert.deepEqual(readCookies(response).map(({ name, secure }) => [name, secure]), [[COOKIE.OAUTH_STATE, undefined], [COOKIE.OAUTH_REDIRECT, undefined]]);
  });

  test('starts each sign-in with a state and a verifier of its own', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock });
    const [first, second] = await Promise.all([fastify.inject(START_URL), fastify.inject(START_URL)]);

    assert.notDeepEqual(readStateCookie(first), readStateCookie(second));
  });

  test('takes no target off the site or inside the pages of signing in: it clears the redirect cookie, so that one of an earlier attempt does not outlive it', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock });
    const targets = ['/.//evil.com', '/auth/logout', '/auth', '//evil.com', 'https://evil.com/profile'];
    const responses = await Promise.all(targets.map((target) => fastify.inject({ url: START_URL, query: { redirect: target } })));

    assert.deepEqual(
      responses.map((response, index) => [targets[index], response.statusCode, findCookie(response, COOKIE.OAUTH_REDIRECT)]),
      responses.map((response, index) => [targets[index], 302, { name: COOKIE.OAUTH_REDIRECT, ...CLEARED }]),
    );
    assert.deepEqual(responses.map((response) => readStateCookie(response).mode), targets.map(() => 'login'));
  });

  test('a link asked for without a usable access token fails to the page it was asked from, with no flow cookie and no call of the provider', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock });
    const responses = await Promise.all([
      fastify.inject(`${START_URL}?link=true&redirect=/settings`),
      fastify.inject({ url: `${START_URL}?link=true&redirect=/settings`, headers: { [HEADER.AUTHORIZATION]: 'Bearer garbage' } }),
      fastify.inject({ url: `${START_URL}?link=true&redirect=/settings`, cookies: { [COOKIE.ACCESS_TOKEN]: 'garbage' } }),
      fastify.inject(`${START_URL}?link=true&redirect=/auth/login`),
    ]);

    assert.deepEqual(responses.map((response) => describeRedirect(response)), [
      redirectTo(`${APP_URL}/settings?authError=AUTHENTICATION_ERROR`),
      redirectTo(`${APP_URL}/settings?authError=AUTHENTICATION_ERROR`),
      redirectTo(`${APP_URL}/settings?authError=AUTHENTICATION_ERROR`),
      redirectTo(`${APP_URL}/?authError=AUTHENTICATION_ERROR`),
    ]);
    assert.deepEqual(responses.map((response) => response.headers[HEADER.SET_COOKIE]), responses.map(() => undefined));
    assert.deepEqual(mock.requests, []);
  });

  test('answers a query its schema refuses with a redirect too, never with JSON', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock });
    const responses = await Promise.all([
      fastify.inject({ url: START_URL, query: { redirect: `/${'x'.repeat(REDIRECT_PATH_MAX_LENGTH)}` } }),
      fastify.inject({ url: START_URL, query: { link: 'perhaps' } }),
    ]);

    assert.deepEqual(responses.map((response) => describeRedirect(response)), responses.map(() => redirectTo(`${APP_URL}/auth/login?authError=VALIDATION_ERROR`)));
  });
});

describe('GET /api/v1/auth/<id>/callback: what it refuses before the token endpoint', () => {
  test('a state that is not the one of its cookie, none, an error of the provider and no code end on the sign-in page with AUTHENTICATION_ERROR, and clear both flow cookies', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock });
    const walks = await Promise.all([
      signInThroughProvider(fastify, mock, { redirect: '/profile', callbackQuery: { state: 'forged-state' } }),
      signInThroughProvider(fastify, mock, { callbackQuery: { state: null } }),
      signInThroughProvider(fastify, mock, { error: 'access_denied' }),
      signInThroughProvider(fastify, mock, { callbackQuery: { code: null } }),
    ]);

    assert.deepEqual(walks.map(({ callback }) => describeRedirect(callback)), walks.map(() => redirectTo(FAILURE_LOCATION)));
    assert.deepEqual(walks.map(({ callback }) => readCookies(callback)), walks.map(() => clearedFlowCookies()));
    assert.deepEqual(mock.requests, []);
  });

  test('a callback without the cookies of a flow, or with the cookies of another, signs nobody in: the callback URL of an attacker opened in the browser of a victim', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock });
    const [attacker, victim] = await Promise.all([fastify.inject(START_URL), fastify.inject(START_URL)]);
    const callback = new URL(mock.authorize(attacker.headers[HEADER.LOCATION]).location);
    const url = `${callback.pathname}${callback.search}`;
    const responses = await Promise.all([
      fastify.inject(url),
      fastify.inject({ url, cookies: { [COOKIE.OAUTH_STATE]: findCookie(victim, COOKIE.OAUTH_STATE).value } }),
      fastify.inject({ url, cookies: { [COOKIE.OAUTH_STATE]: 'garbage' } }),
    ]);

    assert.deepEqual(responses.map((response) => describeRedirect(response)), responses.map(() => redirectTo(FAILURE_LOCATION)));
    assert.deepEqual(responses.map((response) => readCookies(response)), responses.map(() => clearedFlowCookies()));
    assert.deepEqual(mock.requests, []);
  });
});

describe('POST /api/v1/auth/login-dev without a database', () => {
  test('is not there outside dev mode: a request of this machine gets the 404 of an unknown path', async (t) => {
    const fastify = await buildApp(t);
    const response = await postLoginDev(fastify);

    assert.equal(fastify.hasRoute({ method: 'POST', url: LOGIN_DEV_URL }), false);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), errorBody(response, 'NOT_FOUND_ERROR', 'Not found'));
  });

  test('answers a client that is not on this machine with the 404 of an unknown path, before it reads the body: {}, a text body, one above the limit and a valid one alike', async (t) => {
    const fastify = await buildApp(t, { env: DEV_ENV });
    const bodies = [
      ['{}', { payload: {} }],
      ['a text body', { headers: { [HEADER.CONTENT_TYPE]: 'text/plain' }, payload: EMAIL }],
      ['a body above the limit', { payload: { email: EMAIL, padding: 'x'.repeat(fastify.config.app.bodyLimit) } }],
      ['a valid body', { payload: { email: EMAIL } }],
    ];
    const sources = [
      ['a socket of another address', { remoteAddress: FOREIGN_IP }],
      ['a foreign hop in X-Forwarded-For', { headers: { [HEADER.X_FORWARDED_FOR]: `${FOREIGN_IP}, ${LOOPBACK}` } }],
      ...PROXY_HEADERS.map((name) => [`the header ${name}`, { headers: { [name]: LOOPBACK } }]),
      ['a Host of another machine', { headers: { [HEADER.HOST]: 'evil.example.com' } }],
    ];
    const cases = sources.flatMap(([source, from]) => bodies.map(([body, sent]) => [`${source}, ${body}`, {
      ...from,
      ...sent,
      headers: { ...from.headers, ...sent.headers },
    }]));
    const responses = await Promise.all(cases.map(([, request]) => postLoginDev(fastify, request)));

    assert.deepEqual(
      responses.map((response, index) => [cases[index][0], response.statusCode, response.json(), response.headers[HEADER.SET_COOKIE]]),
      responses.map((response, index) => [cases[index][0], 404, errorBody(response, 'NOT_FOUND_ERROR', `Route POST ${LOGIN_DEV_URL} not found`), undefined]),
    );
  });

  test('lets a request of this machine through to its body and its handler, one through a local proxy that names a loopback client too', async (t) => {
    const fastify = await buildApp(t, { env: DEV_ENV });
    const [empty, tooLarge, proxied, direct] = await Promise.all([
      postLoginDev(fastify, { payload: {} }),
      postLoginDev(fastify, { payload: { email: EMAIL, padding: 'x'.repeat(fastify.config.app.bodyLimit) } }),
      postLoginDev(fastify, { headers: { [HEADER.X_FORWARDED_FOR]: `${LOOPBACK}, ::1` } }),
      postLoginDev(fastify),
    ]);

    assert.deepEqual([empty.statusCode, empty.json().code], [422, 'VALIDATION_ERROR']);
    assert.deepEqual(empty.json().validation.map(({ column, operator }) => [column, operator]), [['email', 'required']]);
    assert.deepEqual([tooLarge.statusCode, tooLarge.json().code], [413, 'PAYLOAD_TOO_LARGE_ERROR']);
    // The 500 of the database that is down: the handler has been reached.
    assert.deepEqual([proxied, direct].map((response) => [response.statusCode, response.json().code]), [[500, 'SERVER_ERROR'], [500, 'SERVER_ERROR']]);
  });
});

describe('routes of signing in at the start and in the docs', () => {
  test('say in one info line which providers sign in and whether the dev sign-in is on, and warn in prod when nobody can sign in', async (t) => {
    const mock = await createMockProvider(t);
    const runs = [
      ['prod, no provider', {}],
      ['dev, no provider', { env: DEV_ENV }],
      ['prod, google and the mock', { mock, env: GOOGLE_ENV }],
    ];
    const sinks = await Promise.all(runs.map(async ([, options]) => {
      const sink = createLogSink();

      await buildApp(t, { ...options, logger: { level: 'info', stream: sink.stream } });

      return sink;
    }));

    assert.deepEqual(sinks.map((sink) => findLogLines(sink, SIGN_IN_MESSAGE).map((line) => [line.level, line.signIn])), [
      [[LOG_LEVEL.INFO, { providers: [], isDevSignInOn: false }]],
      [[LOG_LEVEL.INFO, { providers: [], isDevSignInOn: true }]],
      [[LOG_LEVEL.INFO, { providers: ['google', 'mock'], isDevSignInOn: false }]],
    ]);
    assert.deepEqual(sinks.map((sink) => findLogLines(sink, NOBODY_MESSAGE).map((line) => line.level)), [[LOG_LEVEL.WARN], [], []]);
  });

  test('are in the docs of dev mode: the start and the callback of a provider with credentials by their query and one redirect, without HEAD, and the dev sign-in by its body', async (t) => {
    const mock = await createMockProvider(t);
    const fastify = await buildApp(t, { mock, env: DEV_ENV });
    const response = await fastify.inject('/docs/json');
    const { paths } = response.json();
    const [start, callback] = [paths[START_URL], paths[CALLBACK_URL]];

    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(paths).filter((path) => path.startsWith('/api/v1/auth/')), [
      '/api/v1/auth/me',
      PROVIDERS_URL,
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
      START_URL,
      CALLBACK_URL,
      LOGIN_DEV_URL,
    ]);
    assert.deepEqual([start, callback].map((path) => Object.keys(path)), [['get'], ['get']]);
    assert.deepEqual([start.get, callback.get].map(({ responses }) => Object.keys(responses)), [['302'], ['302']]);
    assert.deepEqual([start.get, callback.get].map(({ parameters }) => parameters.map(({ name, in: part }) => [name, part])), [
      [['redirect', 'query'], ['link', 'query']],
      [['code', 'query'], ['state', 'query'], ['error', 'query']],
    ]);
    assert.deepEqual(Object.keys(paths[LOGIN_DEV_URL].post.requestBody.content['application/json'].schema.properties), ['email']);
  });
});
