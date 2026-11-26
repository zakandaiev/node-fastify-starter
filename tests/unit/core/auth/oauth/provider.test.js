import { createOauthConfig } from '#config/oauth.js';
import {
  assertOauthConfig,
  createAuthorization,
  exchangeCode,
  findEnabledProvider,
  listEnabledProviders,
  readProviderProfile,
  RESERVED_ROUTE_NAMES,
} from '#core/auth/oauth/provider.js';
import { createContext, runInContext } from '#core/context/index.js';
import { AppError } from '#core/error/index.js';
import { UpstreamError } from '#core/http/index.js';
import { createLogger, serializeError } from '#core/logger/index.js';
import { CLIENT_AUTHENTICATION } from '#enums/client-authentication.js';
import { ERROR_CATALOG } from '#enums/error-code.js';
import {
  accept,
  createAlertReceiver,
  NO_THROTTLE,
  readBlock,
  readTitles,
  readUrls,
} from '#root/tests/helper/alert.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { rejectionOf, timeIt, waitFor } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { createMockProvider, REFUSAL_DESCRIPTION } from '#root/tests/helper/oauth.js';
import { getFreePort } from '#root/tests/helper/process.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { toTimestamp, toUnixSeconds } from '#utils/date.js';
import { encodeBase64Url, isBase64Url } from '#utils/encoding.js';
import { sha256 } from '#utils/hash.js';
import { freezeDeep, pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const REDIRECT_URI = 'https://app.test/api/v1/auth/mock/callback';
const REQUEST_MESSAGE = 'Upstream request';
const UPSTREAM_ERROR_TITLE = 'Upstream service failed';

// RFC 7636: a verifier of 32 random bytes is 43 characters of base64url.
const VERIFIER_LENGTH = 43;

const SHORT_TIMEOUT = '0.2s';
const QUICK_MS = 2000;

// A whole second: an exp of it is not above now.
const NOW = toTimestamp('2026-11-26T10:00:00.000Z');
const NOW_SECONDS = toUnixSeconds(NOW);

const NUMERIC_CLIENT_ID = '1234567890';
const FLOW_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'response_mode',
  'nonce',
];

// A provider of no service, for the checks that need no answer of one.
const RECORD = freezeDeep({
  id: 'corp',
  name: 'Corp',
  issuers: ['https://sso.corp.example.com'],
  authorizationUrl: 'https://sso.corp.example.com/authorize',
  tokenUrl: 'https://sso.corp.example.com/token',
  scope: 'openid email',
  authorizationParams: { prompt: 'login' },
  clientAuthentication: CLIENT_AUTHENTICATION.POST,
  claims: { subject: 'sub', email: 'email' },
  clientId: null,
  clientSecret: null,
});

const ENABLED_RECORD = freezeDeep({ ...RECORD, clientId: 'corp-client', clientSecret: 'corp-secret' });

function withProviders(...providers) {
  return { ...createTestConfig().oauth, providers };
}

function withRecord(overrides) {
  return withProviders({ ...RECORD, ...overrides });
}

function assertRefused(cases, message) {
  cases.forEach((oauthConfig) => {
    assert.throws(() => assertOauthConfig(oauthConfig), { name: 'TypeError', message }, JSON.stringify(oauthConfig.providers));
  });
}

function assertTaken(cases) {
  cases.forEach((oauthConfig) => assert.equal(assertOauthConfig(oauthConfig), true, JSON.stringify(oauthConfig.providers)));
}

function openContext(sections = {}) {
  const sink = createLogSink();
  const config = createTestConfig({ ...sections, logger: { level: 'info', stream: sink.stream } });
  const context = createContext({ config, log: createLogger(config.logger) });

  function run(fn) {
    return runInContext(context, fn);
  }

  return { config, sink, run };
}

// The authorization the app makes, the consent at the mock and the code it gives, ready to be exchanged.
function prepareExchange(mock, consent = {}) {
  const { url, verifier } = createAuthorization(mock.record, { redirectUri: REDIRECT_URI });
  const { code } = mock.authorize(url, consent);

  return { code, verifier, redirectUri: REDIRECT_URI };
}

function exchangeThrough(mock, run, { consent, record = mock.record } = {}) {
  const exchange = prepareExchange(mock, consent);

  return run(() => exchangeCode(record, exchange));
}

function readIdTokenParts(mock, claims) {
  return mock.createIdToken(claims).split('.');
}

function assertUpstreamFailure(error, reason, label = reason) {
  assert.ok(error instanceof AppError, `${label}: ${error}`);
  assert.equal(error.code, 'UPSTREAM_ERROR', label);
  assert.ok(error.cause instanceof UpstreamError, label);
  assert.equal(error.cause.reason, reason, label);

  return error.cause;
}

function assertInvalidAnswer(error, check, label = check) {
  const cause = assertUpstreamFailure(error, 'invalid-answer', label);

  assert.equal(cause.check, check, label);

  return cause;
}

// The error a call throws, for a test that looks at more of it than assert.throws() compares.
function errorOf(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }

  return assert.fail('The call was expected to throw');
}

function pickNames({ firstName, lastName }) {
  return { firstName, lastName };
}

async function buildAlertApp(t) {
  const receiver = await createAlertReceiver(t, accept);
  const fastify = await buildTestApp({
    env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()), ...receiver.env.webhook },
    alert: { ...receiver.config.alert, throttleWindow: NO_THROTTLE },
  });

  t.after(() => fastify.close());

  return { fastify, receiver };
}

describe('assertOauthConfig: what it takes', () => {
  test('takes the config of the app, with and without credentials, and the mock provider of the tests as a third record', async (t) => {
    const mock = await createMockProvider(t);
    const env = {
      APP_OAUTH_GOOGLE_CLIENT_ID: 'google-client.apps.example.com',
      APP_OAUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
      APP_OAUTH_TELEGRAM_CLIENT_ID: NUMERIC_CLIENT_ID,
      APP_OAUTH_TELEGRAM_CLIENT_SECRET: 'telegram-secret',
    };
    const { oauth } = createTestConfig({ env });

    assertTaken([
      createTestConfig().oauth,
      oauth,
      { ...oauth, providers: [...oauth.providers, mock.record] },
      withProviders(RECORD, { ...ENABLED_RECORD, id: 'corp-2' }),
      withProviders(),
    ]);
  });

  test('takes an id of lower-case letters, digits and "-" from a letter, up to the 32 characters of its column', () => {
    assertTaken(['a', 'corp-sso-2', 'x'.repeat(32), 'a-'].map((id) => withRecord({ id })));
  });
});

describe('assertOauthConfig: the record of a provider', () => {
  test('refuses any other id', () => {
    const ids = ['', 'Google', '1corp', '-corp', 'corp_sso', 'corp sso', 'corp.sso', 'x'.repeat(33), 'gооgle', 42, null, undefined];

    assertRefused(ids.map((id) => withRecord({ id })), /requires an id of lower-case letters, digits and "-" that starts with a letter, up to 32 characters$/);
  });

  test('refuses an id that is the name of an auth route, and two providers of one id', () => {
    assert.deepEqual(RESERVED_ROUTE_NAMES, ['me', 'providers', 'refresh', 'logout', 'login-dev']);
    assertRefused(RESERVED_ROUTE_NAMES.map((id) => withRecord({ id })), /requires an id that is not the name of an auth route: me, providers, refresh, logout, login-dev$/);
    assertRefused([withProviders(RECORD, ENABLED_RECORD)], /^config\.oauth holds two providers of the id "corp"$/);
  });

  test('refuses a provider without a name to show, or without issuers its id_token may name', () => {
    assertRefused(['', 42, undefined].map((name) => withRecord({ name })), /requires a name, which the sign-in button shows$/);
    assertRefused([[], [''], [42], 'https://sso.corp.example.com', undefined].map((issuers) => withRecord({ issuers })), /requires issuers/);
    assertRefused([withProviders('corp'), withProviders(null)], /^config\.oauth provider #0 requires a record$/);
  });

  test('takes an authorization and a token endpoint over https, and over http only on a loopback host', () => {
    const endpoints = ['https://sso.example.com/token', 'http://127.0.0.1:8080/token', 'http://127.4.5.6/token', 'http://localhost:8080/token', 'http://[::1]:8080/token'];

    assertTaken(endpoints.flatMap((url) => [withRecord({ tokenUrl: url }), withRecord({ authorizationUrl: url })]));
  });

  test('refuses an endpoint over http elsewhere, another scheme, credentials and what is not a URL', () => {
    const endpoints = [
      'http://sso.example.com/token',
      'http://10.0.0.5/token',
      'http://localhost.example.com/token',
      'ftp://sso.example.com/token',
      'https://anna:secret@sso.example.com/token',
      'sso.example.com/token',
      '',
      undefined,
    ];

    assertRefused(endpoints.map((tokenUrl) => withRecord({ tokenUrl })), /requires tokenUrl to be an https URL without credentials, http only on a loopback host$/);
    assertRefused(endpoints.map((authorizationUrl) => withRecord({ authorizationUrl })), /requires authorizationUrl to be an https URL/);
  });

  test('refuses a scope without openid, and a way of client authentication it does not know', () => {
    assertTaken(['openid', 'email openid profile'].map((scope) => withRecord({ scope })));
    assertRefused(['email profile', 'openidx email', 'OPENID', '', 42].map((scope) => withRecord({ scope })), /requires a scope that holds "openid": without it there is no id_token$/);
    assertRefused(['client_secret_jwt', 'basic', undefined].map((clientAuthentication) => withRecord({ clientAuthentication })), /requires clientAuthentication to be one of: client_secret_post, client_secret_basic$/);
  });

  test('takes claims of one name for subject, email and isEmailVerified, and a name or a list of names for the names', () => {
    const claims = [
      { subject: 'sub' },
      { subject: 'id', firstName: 'given_name' },
      {
        subject: 'sub',
        email: 'email',
        isEmailVerified: 'email_verified',
        firstName: ['given_name', 'name'],
        lastName: ['family_name'],
      },
    ];

    assertTaken(claims.map((value) => withRecord({ claims: value })));
  });

  test('refuses any other claims, a key of another name included: its claim would go unread without a word', () => {
    const claims = [
      undefined,
      {},
      { subject: '' },
      { subject: ['sub'] },
      { subject: 'sub', email: ['email'] },
      { subject: 'sub', isEmailVerified: '' },
      { subject: 'sub', firstName: [] },
      { subject: 'sub', firstName: ['given_name', ''] },
      { subject: 'sub', lastName: 42 },
      { subject: 'sub', emailVerified: 'email_verified' },
    ];

    assertRefused(claims.map((value) => withRecord({ claims: value })), /requires claims of the keys subject, email, isEmailVerified, firstName, lastName/);
  });

  test('refuses authorizationParams that are not a plain object of strings, or that name a parameter the flow sets', () => {
    assertTaken([{}, { prompt: 'login', hd: 'example.com' }].map((authorizationParams) => withRecord({ authorizationParams })));
    assertTaken([withRecord({ authorizationUrl: 'https://sso.corp.example.com/authorize?hd=example.com' })]);
    assertRefused([null, [], { prompt: 1 }, { prompt: null }].map((authorizationParams) => withRecord({ authorizationParams })), /requires authorizationParams to be a plain object of string values$/);
    FLOW_PARAMS.forEach((name) => {
      const message = new RegExp(`names "${name}" in authorizationParams or in the query of authorizationUrl: the flow sets it itself$`);

      assertRefused([
        withRecord({ authorizationParams: { [name]: 'value' } }),
        withRecord({ authorizationUrl: `https://sso.corp.example.com/authorize?${name}=value` }),
      ], message);
    });
  });

  test('refuses one credential without the other, naming both variables of env, and a credential that is not a text', () => {
    const halfMessage = /^config\.oauth provider "corp" has one credential without the other: set both APP_OAUTH_CORP_CLIENT_ID and APP_OAUTH_CORP_CLIENT_SECRET, or neither$/;

    assertRefused([withRecord({ clientId: 'corp-client' }), withRecord({ clientSecret: 'corp-secret' })], halfMessage);
    assertRefused([createTestConfig({ env: { APP_OAUTH_GOOGLE_CLIENT_SECRET: 'google-secret' } }).oauth], /set both APP_OAUTH_GOOGLE_CLIENT_ID and APP_OAUTH_GOOGLE_CLIENT_SECRET, or neither$/);
    assertRefused([{ clientId: 42, clientSecret: 'corp-secret' }, { clientId: '', clientSecret: '' }].map((credentials) => withRecord(credentials)), /requires APP_OAUTH_CORP_CLIENT_ID and APP_OAUTH_CORP_CLIENT_SECRET to be non-empty strings$/);
  });
});

describe('assertOauthConfig: the section', () => {
  test('refuses a duration nobody can read and one of zero', () => {
    const { oauth } = createTestConfig();

    assert.throws(() => assertOauthConfig({ ...oauth, stateTtl: '10 minutes' }), /convertStringToMs\(value\) requires a number with a unit/);
    assert.throws(() => assertOauthConfig({ ...oauth, timeout: '0s' }), { name: 'TypeError', message: 'config.oauth requires stateTtl, timeout to be above zero' });
  });

  test('refuses a path of the sign-in that isSafeRedirectPath refuses, and a success path inside the pages of signing in and out', () => {
    const { oauth } = createTestConfig();
    const paths = [
      { successPath: '//evil.example.com' },
      { successPath: 'https://evil.example.com' },
      { failurePath: '/auth/../login' },
      { signInSection: '' },
    ];

    paths.forEach((section) => {
      assert.throws(() => assertOauthConfig({ ...oauth, ...section }), { name: 'TypeError', message: /requires (successPath|failurePath|signInSection) to be a path of the site that isSafeRedirectPath\(\) takes$/ });
    });
    ['/auth/logout', '/auth', '/AUTH/', '/%61uth/login'].forEach((successPath) => {
      assert.throws(() => assertOauthConfig({ ...oauth, successPath }), { name: 'TypeError', message: 'config.oauth requires successPath outside signInSection' }, successPath);
    });
    assert.equal(assertOauthConfig({ ...oauth, successPath: '/authors' }), true);
  });

  test('refuses what is not the section with its list of providers', () => {
    [undefined, null, {}, { providers: {} }].forEach((oauthConfig) => {
      assert.throws(() => assertOauthConfig(oauthConfig), { name: 'TypeError', message: 'assertOauthConfig(oauthConfig) requires config.oauth with its list of providers' });
    });
  });
});

describe('listEnabledProviders and findEnabledProvider', () => {
  test('give the providers with both credentials alone, in the order of the config', () => {
    const second = { ...ENABLED_RECORD, id: 'corp-2' };
    const oauthConfig = withProviders(ENABLED_RECORD, { ...RECORD, id: 'corp-off' }, second);

    assert.deepEqual(listEnabledProviders(oauthConfig).map((provider) => provider.id), ['corp', 'corp-2']);
    assert.equal(findEnabledProvider(oauthConfig, 'corp-2'), oauthConfig.providers[2]);
    assert.equal(findEnabledProvider(oauthConfig, 'corp-off'), null);
    assert.equal(findEnabledProvider(oauthConfig, 'unknown'), null);
    assert.deepEqual(listEnabledProviders(createOauthConfig({})), []);
  });
});

describe('createAuthorization', () => {
  test('sends the browser to the authorization endpoint with the parameters of the record and those of the flow, PKCE S256 among them', () => {
    const { url, state, verifier } = createAuthorization(ENABLED_RECORD, { redirectUri: REDIRECT_URI });
    const address = new URL(url);

    assert.equal(`${address.origin}${address.pathname}`, ENABLED_RECORD.authorizationUrl);
    assert.deepEqual(Object.fromEntries(address.searchParams), {
      prompt: 'login',
      response_type: 'code',
      client_id: 'corp-client',
      redirect_uri: REDIRECT_URI,
      scope: 'openid email',
      state,
      code_challenge: sha256(verifier, 'base64url'),
      code_challenge_method: 'S256',
    });
    [state, verifier].forEach((value) => {
      assert.equal(value.length, VERIFIER_LENGTH);
      assert.equal(isBase64Url(value), true);
    });
  });

  test('gives a new state and verifier to every authorization, and keeps the query of the authorization URL', () => {
    const record = { ...ENABLED_RECORD, authorizationUrl: 'https://sso.corp.example.com/authorize?hd=example.com' };
    const [first, second] = [1, 2].map(() => createAuthorization(record, { redirectUri: REDIRECT_URI }));

    assert.notEqual(first.state, second.state);
    assert.notEqual(first.verifier, second.verifier);
    assert.notEqual(first.state, first.verifier);
    assert.equal(new URL(first.url).searchParams.get('hd'), 'example.com');
  });

  test('requires a provider with both credentials and the address of its callback', () => {
    [RECORD, { ...RECORD, clientId: 'corp-client' }, null].forEach((record) => {
      assert.throws(() => createAuthorization(record, { redirectUri: REDIRECT_URI }), { name: 'TypeError', message: /requires the record of a provider with both credentials$/ });
    });
    [undefined, '/api/v1/auth/corp/callback', 'ftp://app.test/callback'].forEach((redirectUri) => {
      assert.throws(() => createAuthorization(ENABLED_RECORD, { redirectUri }), { name: 'TypeError', message: /requires redirectUri, the address of its callback$/ });
    });
  });
});

describe('exchangeCode: a code the provider takes', () => {
  test('gives the claims of the id_token, for a form with the code, the verifier, the redirect_uri and the credentials in the body', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const exchange = prepareExchange(mock, { claims: { sub: 'subject-1', email: 'anna@example.com' } });
    const claims = await run(() => exchangeCode(mock.record, exchange));
    const [request] = mock.requests;

    assert.equal(claims.sub, 'subject-1');
    assert.equal(claims.email, 'anna@example.com');
    assert.equal(claims.iss, mock.url);
    assert.equal(claims.aud, 'mock-client');
    assert.deepEqual([request.method, request.path], ['POST', '/token']);
    assert.equal(request.headers.accept, 'application/json');
    assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(request.headers.authorization, undefined);
    assert.deepEqual(request.form, {
      grant_type: 'authorization_code',
      code: exchange.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: exchange.verifier,
      client_id: 'mock-client',
      client_secret: 'mock-secret',
    });
  });

  test('sends client_secret_basic credentials in a Basic header, each form-encoded first, and no secret in the body', async (t) => {
    const { run } = openContext();
    const clientId = 'corp:client id+1';
    const clientSecret = 'secret/=%&~';
    const mock = await createMockProvider(t, { clientAuthentication: CLIENT_AUTHENTICATION.BASIC, clientId, clientSecret });
    const claims = await exchangeThrough(mock, run, { consent: { claims: { sub: 'subject-2' } } });
    const [request] = mock.requests;
    const encoded = Buffer.from('corp%3Aclient+id%2B1:secret%2F%3D%25%26%7E').toString('base64');

    assert.equal(claims.sub, 'subject-2');
    assert.equal(request.headers.authorization, `Basic ${encoded}`);
    assert.equal(request.form.client_id, clientId);
    assert.equal(Object.hasOwn(request.form, 'client_secret'), false);
  });

  test('logs the call once as the service oauth-<id>, with its masked address and status, and none of its secrets', async (t) => {
    const { run, sink } = openContext();
    const mock = await createMockProvider(t);
    const exchange = prepareExchange(mock);

    await run(() => exchangeCode(mock.record, exchange));

    const lines = findLogLines(sink, REQUEST_MESSAGE);
    const written = JSON.stringify(sink.lines);

    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, LOG_LEVEL.INFO);
    assert.deepEqual({ ...lines[0].upstream, durationMs: 0 }, {
      service: 'oauth-mock',
      method: 'POST',
      url: `${mock.url}/token`,
      status: 200,
      durationMs: 0,
    });
    [exchange.code, exchange.verifier, mock.record.clientSecret].forEach((secret) => assert.equal(written.includes(secret), false));
  });

  test('takes config.oauth.timeout: a token endpoint that does not answer in it fails with "timeout"', async (t) => {
    const { run } = openContext({ oauth: { timeout: SHORT_TIMEOUT } });
    const mock = await createMockProvider(t);
    const { result: error, durationMs } = await timeIt(() => rejectionOf(exchangeThrough(mock, run, { consent: { answer: { isHanging: true } } })));

    assertUpstreamFailure(error, 'timeout');
    assert.equal(error.cause.service, 'oauth-mock');
    assert.ok(durationMs < QUICK_MS, `${durationMs} ms`);
  });

  test('fails with "network" when nothing listens on the token endpoint', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const record = { ...mock.record, tokenUrl: `http://127.0.0.1:${await getFreePort()}/token` };
    const error = await rejectionOf(exchangeThrough(mock, run, { record }));

    assert.equal(assertUpstreamFailure(error, 'network').code, 'ECONNREFUSED');
  });

  test('requires a provider with both credentials, a code, a verifier and a redirectUri', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const exchange = prepareExchange(mock);

    await assert.rejects(run(() => exchangeCode({ ...mock.record, clientSecret: null }, exchange)), { name: 'TypeError', message: /requires the record of a provider with both credentials$/ });
    await Promise.all(['code', 'verifier', 'redirectUri'].map((key) => assert.rejects(run(() => exchangeCode(mock.record, { ...exchange, [key]: '' })), {
      name: 'TypeError',
      message: /requires the code of the callback, the verifier of its flow and the redirectUri of its authorization$/,
    }, key)));
    assert.deepEqual(mock.requests, []);
  });
});

describe('exchangeCode: a refusal', () => {
  test('answers invalid_grant with AUTHENTICATION_ERROR in any status: a spent code, a verifier of another flow, a 400 and a 200', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const spent = prepareExchange(mock);
    const other = createAuthorization(mock.record, { redirectUri: REDIRECT_URI });

    await run(() => exchangeCode(mock.record, spent));

    const errors = await Promise.all([
      rejectionOf(run(() => exchangeCode(mock.record, spent))),
      rejectionOf(run(() => exchangeCode(mock.record, { ...prepareExchange(mock), verifier: other.verifier }))),
      rejectionOf(exchangeThrough(mock, run, { consent: { answer: { status: 400, body: { error: 'invalid_grant' } } } })),
      rejectionOf(exchangeThrough(mock, run, { consent: { answer: { status: 200, body: { error: 'invalid_grant' } } } })),
    ]);

    errors.forEach((error, index) => {
      assert.ok(error instanceof AppError, String(index));
      assert.equal(error.code, 'AUTHENTICATION_ERROR', String(index));
      assert.equal(error.cause.providerError, 'invalid_grant', String(index));
      assert.equal(error.cause.service, 'oauth-mock', String(index));
    });
    assert.deepEqual(errors.map((error) => [error.cause.reason, error.cause.status]), [['status', 400], ['status', 400], ['status', 400], ['invalid-answer', 200]]);
    assert.equal(ERROR_CATALOG.AUTHENTICATION_ERROR.isAlertable, false);
  });

  test('raises no alert for invalid_grant: the first alert at the receiver is that of a route that fails after it', async (t) => {
    const mock = await createMockProvider(t);
    const { fastify, receiver } = await buildAlertApp(t);
    const exchange = prepareExchange(mock, { answer: { status: 400, body: { error: 'invalid_grant', error_description: REFUSAL_DESCRIPTION } } });

    fastify.get('/spent', async () => exchangeCode(mock.record, exchange));
    fastify.get('/boom', async () => {
      throw new Error('Route failed');
    });

    const spent = await fastify.inject('/spent');

    await fastify.inject('/boom');
    await waitFor(() => receiver.requests.length > 0, 'the alert of the failed route');

    assert.equal(spent.statusCode, 401);
    assert.equal(spent.json().code, 'AUTHENTICATION_ERROR');
    assert.deepEqual(readUrls(receiver), ['https://app.test/boom']);
  });

  test('answers any other refusal with UPSTREAM_ERROR "status", its status and OAuth error, with an alert, and nothing of its description', async (t) => {
    const mock = await createMockProvider(t);
    const { fastify, receiver } = await buildAlertApp(t);
    const exchange = prepareExchange(mock);

    fastify.get('/refused', async () => exchangeCode({ ...mock.record, clientSecret: 'another-secret' }, exchange));

    const response = await fastify.inject('/refused');
    const [alert] = await waitFor(() => receiver.requests.length > 0 && receiver.requests, 'the alert of the refusal');
    const { cause } = readBlock(alert.body, 'Error');

    assert.equal(response.statusCode, 502);
    assert.deepEqual(readTitles(receiver), [UPSTREAM_ERROR_TITLE]);
    assert.deepEqual(pick(cause, ['type', 'message', 'reason', 'service', 'method', 'url', 'status', 'providerError']), {
      type: 'UpstreamError',
      message: 'The upstream answered with a status that is not a success',
      reason: 'status',
      service: 'oauth-mock',
      method: 'POST',
      url: `${mock.url}/token`,
      status: 401,
      providerError: 'invalid_client',
    });
    assert.equal(JSON.stringify(alert.body).includes(REFUSAL_DESCRIPTION), false);
    assert.equal(JSON.stringify(alert.body).includes('another-secret'), false);
  });

  test('answers a 200 with an error member with UPSTREAM_ERROR "invalid-answer" of the check "error", and takes a null error for none', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const answers = [
      { body: { error: 'invalid_request', error_description: REFUSAL_DESCRIPTION } },
      { body: { error: { code: 400, message: REFUSAL_DESCRIPTION } } },
    ];
    const errors = await Promise.all(answers.map((answer) => rejectionOf(exchangeThrough(mock, run, { consent: { answer } }))));
    const claims = await exchangeThrough(mock, run, { consent: { answer: { body: { error: null, id_token: mock.createIdToken({ sub: 'subject-3' }) } } } });

    assert.deepEqual(errors.map((error) => assertInvalidAnswer(error, 'error').providerError), ['invalid_request', undefined]);
    errors.forEach((error) => assert.equal(JSON.stringify(serializeError(error)).includes(REFUSAL_DESCRIPTION), false));
    assert.equal(claims.sub, 'subject-3');
  });

  test('keeps the OAuth error out of the error when it breaks the syntax of RFC 6749 or is longer than 64 characters', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const values = ['say "no"', 'back\\slash', 'tab\there', 'é', 'x'.repeat(65), '', 42, 'x'.repeat(64)];
    const errors = await Promise.all(values.map((error) => rejectionOf(exchangeThrough(mock, run, { consent: { answer: { status: 400, body: { error } } } }))));

    assert.deepEqual(errors.map((error) => assertUpstreamFailure(error, 'status').providerError), [...values.slice(0, -1).map(() => undefined), 'x'.repeat(64)]);
  });

  test('answers a refusal without JSON by its status, and a success that is not a JSON object with "invalid-answer" of the check "json"', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const refusal = await rejectionOf(exchangeThrough(mock, run, { consent: { answer: { status: 503, body: 'Service Unavailable' } } }));
    const bodies = ['<html>Sign in</html>', '', '[1]', 'null', '"id_token"'];
    const errors = await Promise.all(bodies.map((body) => rejectionOf(exchangeThrough(mock, run, { consent: { answer: { body } } }))));

    assert.equal(assertUpstreamFailure(refusal, 'status').status, 503);
    errors.forEach((error, index) => assert.equal(assertInvalidAnswer(error, 'json', bodies[index]).status, 200));
  });
});

describe('exchangeCode: the id_token', () => {
  test('refuses an answer without an id_token, and one that is not three base64url parts with a JSON object in the middle', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const [header, payload, signature] = readIdTokenParts(mock);
    const tokens = [
      undefined,
      42,
      '',
      `${header}.${payload}`,
      `${header}.${payload}.${signature}.${signature}`,
      `${header}.${payload}.`,
      `${header}.${payload}=.${signature}`,
      `${header}.${payload}.sig+nature`,
      `${header}.${encodeBase64Url('{"sub":')}.${signature}`,
      `${header}.${encodeBase64Url('[1]')}.${signature}`,
      `${header}.${encodeBase64Url('"text"')}.${signature}`,
    ];
    const errors = await Promise.all(tokens.map((token) => rejectionOf(exchangeThrough(mock, run, { consent: { answer: { body: { id_token: token, token_type: 'Bearer' } } } }))));

    errors.forEach((error, index) => assertInvalidAnswer(error, 'id_token', String(tokens[index])));
  });

  test('takes an issuer of its list alone', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const record = { ...mock.record, issuers: ['https://first.example.com', 'accounts.mock.test'] };
    const claims = await exchangeThrough(mock, run, { record, consent: { claims: { iss: 'accounts.mock.test' } } });
    const errors = await Promise.all(['https://evil.example.com', undefined, `${mock.url}/`, ['accounts.mock.test']].map((iss) => rejectionOf(exchangeThrough(mock, run, { record, consent: { claims: { iss } } }))));

    assert.equal(claims.iss, 'accounts.mock.test');
    errors.forEach((error) => assertInvalidAnswer(error, 'iss'));
  });

  test('takes an audience that is the client id, as a text, as a number Telegram writes, or alone in a list', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t, { clientId: NUMERIC_CLIENT_ID });
    const audiences = [NUMERIC_CLIENT_ID, Number(NUMERIC_CLIENT_ID), [NUMERIC_CLIENT_ID], [Number(NUMERIC_CLIENT_ID), NUMERIC_CLIENT_ID]];
    const results = await Promise.all(audiences.map((aud) => exchangeThrough(mock, run, { consent: { claims: { aud } } })));

    assert.deepEqual(results.map((claims) => claims.aud), audiences);
  });

  test('takes other audiences in a list only beside an azp of the client id, and refuses any other audience', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t, { clientId: NUMERIC_CLIENT_ID });
    const taken = [
      { aud: [NUMERIC_CLIENT_ID, 'other-client'], azp: NUMERIC_CLIENT_ID },
      { aud: ['other-client', Number(NUMERIC_CLIENT_ID)], azp: Number(NUMERIC_CLIENT_ID) },
    ];
    const refused = [
      { aud: 'other-client' },
      { aud: undefined },
      { aud: 1234567891 },
      { aud: [] },
      { aud: [NUMERIC_CLIENT_ID, 'other-client'] },
      { aud: [NUMERIC_CLIENT_ID, 'other-client'], azp: 'other-client' },
      { aud: ['other-client'], azp: NUMERIC_CLIENT_ID },
      { aud: { id: NUMERIC_CLIENT_ID } },
    ];
    const results = await Promise.all(taken.map((claims) => exchangeThrough(mock, run, { consent: { claims } })));
    const errors = await Promise.all(refused.map((claims) => rejectionOf(exchangeThrough(mock, run, { consent: { claims } }))));

    assert.equal(results.length, taken.length);
    errors.forEach((error, index) => assertInvalidAnswer(error, 'aud', JSON.stringify(refused[index])));
  });

  test('takes an azp only of the client id, also beside a single audience', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const claims = await exchangeThrough(mock, run, { consent: { claims: { azp: 'mock-client' } } });
    const errors = await Promise.all(['other-client', null, ['mock-client']].map((azp) => rejectionOf(exchangeThrough(mock, run, { consent: { claims: { azp } } }))));

    assert.equal(claims.azp, 'mock-client');
    errors.forEach((error) => assertInvalidAnswer(error, 'azp'));
  });

  test('refuses an id_token without an exp, with one that is no number, and with one that is not above now', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });

    const { run } = openContext();
    const mock = await createMockProvider(t);
    const claims = await exchangeThrough(mock, run, { consent: { claims: { exp: NOW_SECONDS + 1 } } });
    const values = [undefined, NOW_SECONDS, NOW_SECONDS - 1, String(NOW_SECONDS + 600), null];
    const errors = await Promise.all(values.map((exp) => rejectionOf(exchangeThrough(mock, run, { consent: { claims: { exp } } }))));

    assert.equal(claims.exp, NOW_SECONDS + 1);
    errors.forEach((error, index) => assertInvalidAnswer(error, 'exp', String(values[index])));
  });

  test('names the call in every such failure: its service, method, masked address, status and duration', async (t) => {
    const { run } = openContext();
    const mock = await createMockProvider(t);
    const error = await rejectionOf(exchangeThrough(mock, run, { consent: { claims: { iss: 'https://evil.example.com' } } }));
    const cause = assertInvalidAnswer(error, 'iss');

    assert.deepEqual({ ...cause, durationMs: 0 }, {
      reason: 'invalid-answer',
      service: 'oauth-mock',
      method: 'POST',
      url: `${mock.url}/token`,
      status: 200,
      durationMs: 0,
      check: 'iss',
    });
  });
});

describe('readProviderProfile: the subject', () => {
  const PROVIDER = createOauthConfig({}).providers[0];

  function readSubject(sub) {
    return readProviderProfile(PROVIDER, { sub }).subject;
  }

  test('takes printable ASCII up to 255 characters, a space inside it too, and a safe integer that is not negative as its digits', () => {
    ['1', 'abc', '!~', '12 3', 'a'.repeat(255)].forEach((sub) => assert.equal(readSubject(sub), sub));
    assert.deepEqual([0, 123456789, Number.MAX_SAFE_INTEGER].map((sub) => readSubject(sub)), ['0', '123456789', String(Number.MAX_SAFE_INTEGER)]);
  });

  test('refuses a space at either end, which utf8mb4_bin would not tell apart, and any other text or value', () => {
    const values = ['123 ', ' 123', ' ', '', 'a'.repeat(256), 'tab\tx', 'line\nbreak', 'ü', -1, 1.5, 2 ** 53, null, undefined, {}, ['1'], true];

    values.forEach((sub) => {
      const error = errorOf(() => readSubject(sub));

      assert.deepEqual({ ...assertInvalidAnswer(error, 'subject', JSON.stringify(sub)) }, {
        reason: 'invalid-answer',
        service: 'oauth-google',
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        check: 'subject',
      });
    });
  });

  test('reads the subject from the claim the record names: Telegram keys its identity by "id", not by "sub"', () => {
    const telegram = createOauthConfig({}).providers[1];

    assert.equal(readProviderProfile(telegram, { id: 777000, sub: 'opaque-subject' }).subject, '777000');
  });
});

describe('readProviderProfile: the rest of it', () => {
  const PROVIDER = createOauthConfig({}).providers[0];
  const SUBJECT = { sub: 'subject-4' };

  function readProfile(claims) {
    return readProviderProfile(PROVIDER, { ...SUBJECT, ...claims });
  }

  test('reads an email in its normal form, and null for a value that is not one', () => {
    assert.equal(readProfile({ email: '  Anna.Petrenko@Example.COM ' }).email, 'anna.petrenko@example.com');
    ['not-an-email', 'anna@example', '', 42, null, ['anna@example.com'], { email: 'anna@example.com' }, `${'a'.repeat(250)}@example.com`].forEach((email) => {
      assert.equal(readProfile({ email, email_verified: true }).email, null, JSON.stringify(email));
    });
  });

  test('takes an email as verified for true or "true" alone, and never an email it has not read', () => {
    const verified = [true, 'true'].map((value) => readProfile({ email: 'anna@example.com', email_verified: value }).isEmailVerified);
    const unverified = [false, 'false', 'TRUE', 1, null, undefined].map((value) => readProfile({ email: 'anna@example.com', email_verified: value }).isEmailVerified);

    assert.deepEqual(verified, [true, true]);
    assert.deepEqual(unverified, unverified.map(() => false));
    assert.equal(readProfile({ email: 'not-an-email', email_verified: true }).isEmailVerified, false);
    assert.equal(readProfile({ email_verified: true }).isEmailVerified, false);
  });

  test('takes the first word of a name: "Anna Maria" is Anna, and "😀" no name at all', () => {
    assert.deepEqual(pickNames(readProfile({ given_name: 'Anna Maria', family_name: 'Kovalenko' })), { firstName: 'Anna', lastName: 'Kovalenko' });
    assert.deepEqual(pickNames(readProfile({ given_name: '😀', family_name: '😀' })), { firstName: null, lastName: null });
    assert.deepEqual(pickNames(readProfile({})), { firstName: null, lastName: null });
  });

  test('takes the next claim the record lists when the first gives no name', () => {
    assert.equal(readProfile({ given_name: '😀', name: 'Borys Petrenko' }).firstName, 'Borys');
    assert.equal(readProfile({ given_name: 42, name: 'Borys' }).firstName, 'Borys');
    assert.equal(readProfile({ given_name: 'Anna', name: 'Borys' }).firstName, 'Anna');
  });

  test('reads no email from a provider whose record names none, and keeps the claims as they came', () => {
    const telegram = createOauthConfig({}).providers[1];
    const claims = {
      id: 777000,
      email: 'anna@example.com',
      email_verified: true,
      given_name: 'Anna',
    };
    const profile = readProviderProfile(telegram, claims);

    assert.deepEqual({ ...profile, claims: null }, {
      subject: '777000',
      email: null,
      isEmailVerified: false,
      firstName: 'Anna',
      lastName: null,
      claims: null,
    });
    assert.equal(profile.claims, claims);
  });

  test('requires the record of a provider and the claims', () => {
    [[null, SUBJECT], [PROVIDER, null], [PROVIDER, [SUBJECT]], [{}, SUBJECT]].forEach(([provider, claims]) => {
      assert.throws(() => readProviderProfile(provider, claims), { name: 'TypeError', message: /^readProviderProfile\(provider, claims\) requires/ });
    });
  });
});
