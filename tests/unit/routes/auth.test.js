import { createRateLimitConfig } from '#config/rate-limit.js';
import { RESERVED_ROUTE_NAMES } from '#core/auth/oauth/provider.js';
import { issueTokens } from '#core/auth/token.js';
import { readRefreshLimitKey } from '#core/rate-limit/index.js';
import { assertRouteContract } from '#core/schema/route.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import { TOKEN_TYPE } from '#enums/token-type.js';
import {
  getMeSchema,
  getProvidersSchema,
  getSignInCallbackSchema,
  getSignInSchema,
  postLoginDevSchema,
  postLogoutSchema,
  postRefreshSchema,
} from '#root/src/routes/v1/auth/controller.js';
import useAuthRoutes from '#root/src/routes/v1/auth/index.js';
import { deleteSessionSchema, deleteSessionsSchema, getSessionsSchema } from '#root/src/routes/v1/sessions/controller.js';
import useSessionRoutes from '#root/src/routes/v1/sessions/index.js';
import { accept, createAlertReceiver, readTitles } from '#root/tests/helper/alert.js';
import { describeAnswer, errorBody, successBody } from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import {
  buildDownApp,
  connectAppRedis,
  createMarkedRedisEnv,
  runInApp,
  toBearer,
} from '#root/tests/helper/session.js';
import { example as sessionExample } from '#schemas/entity/session.js';
import { unique } from '#utils/array.js';
import { mapSeries } from '#utils/async.js';
import { nowUtc } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import { omit } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const REFRESH_URL = '/api/v1/auth/refresh';
const PUBLIC = Object.freeze({ auth: false });
const GUARDED = Object.freeze({ auth: true });

// A sign-in and a refresh count apart, the refresh by the person of its cookie and the address.
function readSignInSecurity(fastify) {
  const { auth } = fastify.config.rateLimit.routes;

  return {
    signIn: { auth: false, rateLimit: auth },
    refresh: { auth: false, rateLimit: { ...auth, key: readRefreshLimitKey } },
  };
}
const SCOPES = Object.freeze(['users:read']);

// Google with both credentials, Telegram without, in dev mode.
const GOOGLE_DEV_ENV = Object.freeze({
  APP_MODE: 'dev',
  APP_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
  APP_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
});

const TTL_SECONDS = 600;
const EXPIRED_TTL_SECONDS = -60;
const RETRY_AFTER_SECONDS = '60';
const NO_STORE = 'no-store';
const BEARER = 'Bearer';

const DATABASE_CONNECTION_TITLE = 'Database connection failed';

const STATE_KEYS = Object.freeze(['id', 'scopes']);
const SESSION_KEYS = Object.freeze(['id', 'userAgent', 'ip', 'isDev', 'startedAt', 'rotatedAt', 'expiresAt', 'isCurrent']);
const SECRET_NAME_REGEXP = /token|hash|secret|jti/i;

const AUTH_LIMIT = Object.freeze({ max: 2, window: '1m' });
const ADDRESS = '203.0.113.10';
const OTHER_ADDRESS = '203.0.113.20';
const DEV_PROXY_ADDRESS = '127.0.0.1';
const PROVIDERS_URL = '/api/v1/auth/providers';
const GOOGLE_START_URL = '/api/v1/auth/google';
const LOGIN_DEV_URL = '/api/v1/auth/login-dev';

// APP_HOST of the tests is "app.test", over https.
const SIGN_IN_PAGE_URL = 'https://app.test/auth/login';

function issueFor(fastify) {
  const { issued } = runInApp(fastify, () => issueTokens({
    userId: uuidv7(),
    sid: uuidv7(),
    scopes: SCOPES,
    startedAt: nowUtc(),
  }));

  return issued;
}

function postRefresh(fastify, request) {
  return fastify.inject({ method: 'POST', url: REFRESH_URL, ...request });
}

function toRefreshCookie(refreshToken) {
  return { cookies: { [COOKIE.REFRESH_TOKEN]: refreshToken } };
}

function signRefresh(fastify, { algorithm = 'HS256', expiresIn = TTL_SECONDS, ...claims } = {}) {
  return fastify.jwt.refresh.sign({
    tokenType: TOKEN_TYPE.REFRESH,
    sub: uuidv7(),
    sid: uuidv7(),
    jti: uuidv7(),
    ...claims,
  }, { algorithm, expiresIn });
}

function withoutAlgorithm(token) {
  const [, payload, signature] = token.split('.');
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');

  return { unsigned: `${header}.${payload}.`, signed: `${header}.${payload}.${signature}` };
}

function listUnusableTokens(fastify) {
  const genuine = signRefresh(fastify);
  const { unsigned, signed } = withoutAlgorithm(genuine);

  return {
    'an empty cookie': '',
    garbage: 'garbage',
    'three empty parts': '..',
    'alg none, no signature': unsigned,
    'alg none, a signature': signed,
    HS512: signRefresh(fastify, { algorithm: 'HS512' }),
    HS384: signRefresh(fastify, { algorithm: 'HS384' }),
    'a cut signature': genuine.slice(0, -1),
    'no signature': genuine.slice(0, genuine.lastIndexOf('.')),
    expired: signRefresh(fastify, { expiresIn: EXPIRED_TTL_SECONDS }),
    'an access token': issueFor(fastify).accessToken,
    'an access token under the key of refresh tokens': signRefresh(fastify, { tokenType: TOKEN_TYPE.ACCESS }),
    'a session that is no UUID': signRefresh(fastify, { sid: 'a-session' }),
    'a user that is no UUID': signRefresh(fastify, { sub: 'a-user' }),
    'no id of its own': signRefresh(fastify, { jti: undefined }),
  };
}

function describeUnauthenticated(response, challenge) {
  return {
    statusCode: 401,
    body: errorBody(response, 'AUTHENTICATION_ERROR', 'Authentication error'),
    retryAfter: undefined,
    challenge,
    cacheControl: NO_STORE,
    cookies: undefined,
  };
}

function describeUnavailable(response) {
  return {
    statusCode: 503,
    body: errorBody(response, 'SERVICE_UNAVAILABLE_ERROR', 'Service unavailable'),
    retryAfter: RETRY_AFTER_SECONDS,
    challenge: undefined,
    cacheControl: NO_STORE,
    cookies: undefined,
  };
}

function assertUnauthenticated(responses, names, challenge) {
  assert.deepEqual(
    responses.map((response, index) => [names[index], describeAnswer(response)]),
    responses.map((response, index) => [names[index], describeUnauthenticated(response, challenge)]),
  );
}

function readKeys(schema) {
  return Object.keys(schema.properties);
}

function listNames(schema) {
  if (schema === null || typeof schema !== 'object') {
    return [];
  }

  const own = schema.properties
    ? Object.keys(schema.properties)
    : [];

  return [...own, ...Object.values(schema).flatMap((value) => listNames(value))];
}

function createAuthLimits(tiers = {}) {
  const defaults = createRateLimitConfig();

  return { tiers: { ...defaults.tiers, ...tiers }, routes: { ...defaults.routes, auth: AUTH_LIMIT } };
}

// inject() comes from loopback, an internal request the limiter never counts: a proxy that names a client makes it count.
function from(address) {
  return { [HEADER.X_FORWARDED_FOR]: address };
}

function repeat(count, value) {
  return Array.from({ length: count }, () => value);
}

function describeRedirect(response) {
  return {
    statusCode: response.statusCode,
    location: response.headers[HEADER.LOCATION],
    cacheControl: response.headers[HEADER.CACHE_CONTROL],
    retryAfter: response.headers[HEADER.RETRY_AFTER],
    body: response.payload,
  };
}

function redirectTo(location) {
  return {
    statusCode: 302,
    location,
    cacheControl: NO_STORE,
    retryAfter: undefined,
    body: '',
  };
}

function isLimited(response) {
  return response.statusCode === 429 && response.json().code === 'RATE_LIMIT_ERROR';
}

describe('POST /api/v1/auth/refresh with the database down', () => {
  test('answers 401 AUTHENTICATION_ERROR that names no scheme and sets no cookie for a token nobody can use, which it never asks the database about, and 503 for a genuine one', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const fastify = await buildDownApp(t, { env: receiver.env.webhook, alert: receiver.config.alert });
    const tokens = Object.entries(listUnusableTokens(fastify));
    const requests = [['no cookie', {}], ...tokens.map(([name, token]) => [name, toRefreshCookie(token)])];
    const responses = await Promise.all(requests.map(([, request]) => postRefresh(fastify, request)));
    const genuine = await postRefresh(fastify, toRefreshCookie(signRefresh(fastify)));

    await waitFor(() => receiver.requests.length > 0, 'the alert of the database');

    assertUnauthenticated(responses, requests.map(([name]) => name));
    assert.deepEqual(describeAnswer(genuine), describeUnavailable(genuine));
    // The first of them all to raise an alert is the genuine one.
    assert.deepEqual(readTitles(receiver), [DATABASE_CONNECTION_TITLE]);
  });

  test('takes a refresh token from its cookie alone: the same token in a header, a body, a query or another cookie is not there', async (t) => {
    const fastify = await buildDownApp(t);
    const { refreshToken, accessToken } = issueFor(fastify);
    const requests = Object.entries({
      'the Authorization header': { headers: toBearer(refreshToken) },
      'the Authorization header beside an empty cookie': { headers: toBearer(refreshToken), cookies: { [COOKIE.REFRESH_TOKEN]: '' } },
      'a header of its name': { headers: { [COOKIE.REFRESH_TOKEN]: refreshToken } },
      'the body': { payload: { refreshToken } },
      'the query': { query: { refreshToken } },
      'a cookie of another name': { cookies: { [COOKIE.ACCESS_TOKEN]: refreshToken, token: refreshToken } },
      'nowhere, an access token in both places instead': { headers: toBearer(accessToken), cookies: { [COOKIE.ACCESS_TOKEN]: accessToken } },
    });
    const responses = await Promise.all(requests.map(([, request]) => postRefresh(fastify, request)));
    const inCookie = await postRefresh(fastify, toRefreshCookie(refreshToken));

    assertUnauthenticated(responses, requests.map(([name]) => name));
    assert.deepEqual(describeAnswer(inCookie), describeUnavailable(inCookie));
  });

  test('is public: no token of access is asked of it, and one nobody can use is no reason to refuse it', async (t) => {
    const fastify = await buildDownApp(t);
    const { cookies } = toRefreshCookie(issueFor(fastify).refreshToken);
    const responses = await Promise.all([
      postRefresh(fastify, { cookies }),
      postRefresh(fastify, { cookies, headers: { [HEADER.AUTHORIZATION]: 'Bearer garbage' } }),
      postRefresh(fastify, { cookies: { ...cookies, [COOKIE.ACCESS_TOKEN]: 'garbage' } }),
    ]);

    assert.deepEqual(responses.map((response) => describeAnswer(response)), responses.map((response) => describeUnavailable(response)));
  });
});

// The routes a registration of the auth and the session routes declares, under prefixes of their own.
async function listDeclaredRoutes(fastify) {
  const routes = [];

  // A copy: Fastify writes the second spelling of the root of a prefix into the same options.
  fastify.addHook('onRoute', (routeOptions) => routes.push({ ...routeOptions }));
  await fastify.register(useAuthRoutes, { prefix: '/api/v2/auth' });
  await fastify.register(useSessionRoutes, { prefix: '/api/v2/sessions' });

  return routes;
}

describe('routes of auth and sessions: who may call them', () => {
  test('each has the method, the path and the security of its contract: only the refresh and the list of providers are public, and a provider without credentials has no routes', async (t) => {
    const fastify = await buildDownApp(t);
    const { refresh } = readSignInSecurity(fastify);
    const routes = await listDeclaredRoutes(fastify);

    assert.deepEqual(routes.filter(({ method }) => method !== 'HEAD').map(({ method, url, security }) => [method, url, security]), [
      ['GET', '/api/v2/auth/me', GUARDED],
      ['GET', '/api/v2/auth/providers', PUBLIC],
      ['POST', '/api/v2/auth/refresh', refresh],
      ['POST', '/api/v2/auth/logout', GUARDED],
      ['GET', '/api/v2/sessions', GUARDED],
      ['DELETE', '/api/v2/sessions', GUARDED],
      ['DELETE', '/api/v2/sessions/:id', GUARDED],
    ]);
    routes.forEach((route) => {
      assert.doesNotThrow(() => assertRouteContract(route));
    });
  });

  test('a provider with both credentials gets a public start and a public callback without a HEAD twin, and dev mode the public dev sign-in', async (t) => {
    const fastify = await buildDownApp(t, { env: GOOGLE_DEV_ENV });
    const { signIn, refresh } = readSignInSecurity(fastify);
    const routes = await listDeclaredRoutes(fastify);
    const authRoutes = routes.filter(({ url }) => url.startsWith('/api/v2/auth/'));

    assert.deepEqual(authRoutes.map(({ method, url, security }) => [method, url, security]), [
      ['GET', '/api/v2/auth/me', GUARDED],
      ['HEAD', '/api/v2/auth/me', GUARDED],
      ['GET', '/api/v2/auth/providers', PUBLIC],
      ['HEAD', '/api/v2/auth/providers', PUBLIC],
      ['POST', '/api/v2/auth/refresh', refresh],
      ['POST', '/api/v2/auth/logout', GUARDED],
      ['GET', '/api/v2/auth/google', signIn],
      ['GET', '/api/v2/auth/google/callback', signIn],
      ['POST', '/api/v2/auth/login-dev', signIn],
    ]);
    authRoutes.forEach((route) => {
      assert.doesNotThrow(() => assertRouteContract(route));
    });
  });

  test('every route of the folder but those of a provider is named in RESERVED_ROUTE_NAMES: a provider of such an id would take its place', async (t) => {
    const routes = await listDeclaredRoutes(await buildDownApp(t, { env: GOOGLE_DEV_ENV }));
    const segments = routes
      .filter(({ url }) => url.startsWith('/api/v2/auth/'))
      .map(({ url }) => url.slice('/api/v2/auth/'.length).split('/')[0])
      .filter((segment) => segment !== 'google');

    assert.deepEqual(unique(segments).toSorted(), [...RESERVED_ROUTE_NAMES].toSorted());
  });

  test('a guest gets 401 that names the Bearer scheme from every guarded one, before a wrong id, a wrong query or a body too large is looked at', async (t) => {
    const fastify = await buildDownApp(t);
    const requests = [
      { url: '/api/v1/auth/me' },
      { method: 'POST', url: '/api/v1/auth/logout' },
      { method: 'POST', url: '/api/v1/auth/logout', payload: { text: 'x'.repeat(fastify.config.app.bodyLimit) } },
      { url: '/api/v1/sessions' },
      { url: '/api/v1/sessions/' },
      { method: 'DELETE', url: '/api/v1/sessions?scope=all' },
      { method: 'DELETE', url: '/api/v1/sessions' },
      { method: 'DELETE', url: '/api/v1/sessions?scope=nothing' },
      { method: 'DELETE', url: `/api/v1/sessions/${uuidv7()}` },
      { method: 'DELETE', url: '/api/v1/sessions/not-a-uuid' },
    ];
    const responses = await Promise.all(requests.map((request) => fastify.inject(request)));

    assertUnauthenticated(responses, requests.map(({ method, url }) => [method, url]), BEARER);
  });

  test('none answers another method: a link or an image of another site cannot log anyone out', async (t) => {
    const fastify = await buildDownApp(t);
    const { cookies } = toRefreshCookie(issueFor(fastify).refreshToken);
    const responses = await Promise.all([
      fastify.inject({ url: REFRESH_URL, cookies }),
      fastify.inject({ url: '/api/v1/auth/logout', cookies }),
      fastify.inject({ method: 'POST', url: '/api/v1/auth/me', cookies }),
      fastify.inject({ method: 'POST', url: '/api/v1/sessions', cookies }),
      fastify.inject({ url: `/api/v1/sessions/${uuidv7()}`, cookies }),
    ]);

    assert.deepEqual(
      responses.map((response) => [response.statusCode, response.json(), response.headers[HEADER.SET_COOKIE]]),
      responses.map((response) => [404, errorBody(response, 'NOT_FOUND_ERROR', 'Not found'), undefined]),
    );
  });
});

describe('routes of auth and sessions with the database down', () => {
  test('what could not be ended is not over for the browser either: the answer is the 500 of the outage and clears no cookie', async (t) => {
    const fastify = await buildDownApp(t, { env: await createMarkedRedisEnv(t) });

    await connectAppRedis(fastify);

    const { sid, accessToken } = issueFor(fastify);
    const cookies = { [COOKIE.ACCESS_TOKEN]: accessToken };
    const requests = [
      { method: 'POST', url: '/api/v1/auth/logout' },
      { method: 'DELETE', url: `/api/v1/sessions/${sid}` },
      { method: 'DELETE', url: '/api/v1/sessions?scope=all' },
      { method: 'DELETE', url: '/api/v1/sessions?except=current' },
      { method: 'GET', url: '/api/v1/sessions' },
    ];
    const me = await fastify.inject({ url: '/api/v1/auth/me', cookies });
    const responses = await Promise.all(requests.map((request) => fastify.inject({ ...request, cookies })));

    assert.equal(me.statusCode, 200);
    assert.deepEqual(
      responses.map((response, index) => [requests[index].url, describeAnswer(response)]),
      responses.map((response, index) => [requests[index].url, {
        statusCode: 500,
        body: errorBody(response, 'SERVER_ERROR', 'Server error'),
        retryAfter: undefined,
        challenge: undefined,
        cacheControl: NO_STORE,
        cookies: undefined,
      }]),
    );
  });
});

describe('routes of auth and sessions: what they say', () => {
  test('the schema of the state of the sign-in names the id and the scopes alone, that of a session its eight fields, and no schema names a secret', () => {
    const schemas = [getMeSchema, postRefreshSchema, postLogoutSchema, getSessionsSchema, deleteSessionSchema, deleteSessionsSchema];

    assert.deepEqual(readKeys(getMeSchema.response[200].properties.data), STATE_KEYS);
    assert.deepEqual(readKeys(postRefreshSchema.response[200].properties.data), STATE_KEYS);
    assert.deepEqual(readKeys(getSessionsSchema.response[200].properties.data.items), SESSION_KEYS);
    assert.deepEqual(
      [postLogoutSchema, deleteSessionSchema, deleteSessionsSchema].map(({ response }) => omit(response[204], ['description'])),
      [{ type: 'null' }, { type: 'null' }, { type: 'null' }],
    );
    assert.deepEqual(schemas.flatMap(({ response }) => listNames(response)).filter((name) => SECRET_NAME_REGEXP.test(name)), []);
  });

  test('of the routes of signing in only the dev sign-in names a token, the access token it hands out for the header; a provider is its id and its name, and its start and its callback answer with a redirect alone', () => {
    const schemas = [getProvidersSchema, getSignInSchema, getSignInCallbackSchema];

    assert.deepEqual(readKeys(getProvidersSchema.response[200].properties.data.items), ['id', 'name']);
    assert.deepEqual(readKeys(postLoginDevSchema.response[200].properties.data), [...STATE_KEYS, 'accessToken']);
    assert.deepEqual([postLoginDevSchema.body.required, postLoginDevSchema.body.properties.email.type], [['email'], 'string']);
    assert.deepEqual(
      [getSignInSchema, getSignInCallbackSchema].map(({ response }) => Object.keys(response)),
      [['302'], ['302']],
    );
    assert.deepEqual(schemas.flatMap(({ response }) => listNames(response)).filter((name) => SECRET_NAME_REGEXP.test(name)), []);
  });

  test('a token and a hash a handler would hand out by mistake never reach the body', async (t) => {
    const fastify = await buildDownApp(t);
    const issued = issueFor(fastify);
    const state = { id: issued.userId, scopes: SCOPES };

    fastify.get('/api/v1/leaks/me', { schema: getMeSchema, security: PUBLIC }, (request, reply) => reply.ok({ ...issued, ...state }));
    fastify.post('/api/v1/leaks/refresh', { schema: postRefreshSchema, security: PUBLIC }, (request, reply) => reply.ok({ ...issued, ...state }));
    fastify.get('/api/v1/leaks/sessions', { schema: getSessionsSchema, security: PUBLIC }, (request, reply) => reply.list({
      data: [{ ...sessionExample, ...issued, refreshTokenHash: issued.refreshToken }],
    }));

    const [me, refresh, sessions] = await Promise.all([
      fastify.inject('/api/v1/leaks/me'),
      fastify.inject({ method: 'POST', url: '/api/v1/leaks/refresh' }),
      fastify.inject('/api/v1/leaks/sessions'),
    ]);

    assert.deepEqual(me.json(), successBody(me, state));
    assert.deepEqual(refresh.json(), successBody(refresh, state));
    assert.deepEqual(sessions.json(), successBody(sessions, [sessionExample]));
  });
});

describe('routes of signing in: their quota', () => {
  test('POST /api/v1/auth/refresh counts by the person of the refresh cookie and the address: two people behind one address do not share, one person from two addresses does not either, and a request without a usable cookie counts by the address', async (t) => {
    const fastify = await buildDownApp(t, { rateLimit: createAuthLimits() });
    const anna = toRefreshCookie(issueFor(fastify).refreshToken);
    const olha = toRefreshCookie(issueFor(fastify).refreshToken);
    const count = AUTH_LIMIT.max + 1;
    const requests = [
      ...repeat(count, ['Anna behind an address', { ...anna, headers: from(ADDRESS) }]),
      ...repeat(count, ['Olha behind the same address', { ...olha, headers: from(ADDRESS) }]),
      ...repeat(count, ['Anna from another address', { ...anna, headers: from(OTHER_ADDRESS) }]),
      ['no cookie behind the address', { headers: from(ADDRESS) }],
      ['a cookie nobody can use behind the address', { ...toRefreshCookie('garbage'), headers: from(ADDRESS) }],
      ['no cookie behind the address', { headers: from(ADDRESS) }],
    ];
    const responses = await mapSeries(requests, ([, request]) => postRefresh(fastify, request));
    const limited = responses[AUTH_LIMIT.max];

    assert.deepEqual(responses.map((response, index) => [requests[index][0], response.statusCode]), [
      ['Anna behind an address', 503],
      ['Anna behind an address', 503],
      ['Anna behind an address', 429],
      ['Olha behind the same address', 503],
      ['Olha behind the same address', 503],
      ['Olha behind the same address', 429],
      ['Anna from another address', 503],
      ['Anna from another address', 503],
      ['Anna from another address', 429],
      ['no cookie behind the address', 401],
      ['a cookie nobody can use behind the address', 401],
      ['no cookie behind the address', 429],
    ]);
    assert.deepEqual(limited.json(), errorBody(limited, 'RATE_LIMIT_ERROR', 'Rate limit exceeded'));
    assert.deepEqual([limited.headers[HEADER.CACHE_CONTROL], limited.headers[HEADER.SET_COOKIE]], [NO_STORE, undefined]);
  });

  test('the quota of the refresh is its own: it is not the global quota of the client, and the refresh takes none of that', async (t) => {
    const fastify = await buildDownApp(t, { rateLimit: createAuthLimits({ guest: { max: 1, window: '1m' } }) });
    const requests = [
      ['refresh', { method: 'POST', url: REFRESH_URL }],
      ['providers', { url: PROVIDERS_URL }],
      ['providers', { url: PROVIDERS_URL }],
      ['refresh', { method: 'POST', url: REFRESH_URL }],
      ['refresh', { method: 'POST', url: REFRESH_URL }],
    ];
    const responses = await mapSeries(requests, ([, request]) => fastify.inject({ ...request, headers: from(ADDRESS) }));

    assert.deepEqual(responses.map((response, index) => [requests[index][0], response.statusCode]), [
      ['refresh', 401],
      ['providers', 200],
      ['providers', 429],
      ['refresh', 401],
      ['refresh', 429],
    ]);
  });

  test('a provider start counts by the address, 10 a minute by default, and answers its 429 with the redirect of every failure of the route, to the sign-in page with authError=RATE_LIMIT_ERROR; another address and the callback count apart', async (t) => {
    const fastify = await buildDownApp(t, { env: GOOGLE_DEV_ENV });
    const { auth } = fastify.config.rateLimit.routes;
    const { authorizationUrl } = fastify.config.oauth.providers.find(({ id }) => id === 'google');
    const starts = await mapSeries(repeat(auth.max + 1, from(ADDRESS)), (headers) => fastify.inject({ url: GOOGLE_START_URL, headers }));
    const elsewhere = await fastify.inject({ url: GOOGLE_START_URL, headers: from(OTHER_ADDRESS) });
    const callback = await fastify.inject({ url: `${GOOGLE_START_URL}/callback`, headers: from(ADDRESS) });

    assert.deepEqual(auth, { max: 10, window: '1m' });
    assert.deepEqual(
      [...starts.slice(0, -1), elsewhere].map((response) => [response.statusCode, response.headers[HEADER.LOCATION].startsWith(`${authorizationUrl}?`)]),
      repeat(auth.max + 1, [302, true]),
    );
    assert.deepEqual(describeRedirect(starts.at(-1)), redirectTo(`${SIGN_IN_PAGE_URL}?authError=RATE_LIMIT_ERROR`));
    assert.deepEqual(describeRedirect(callback), redirectTo(`${SIGN_IN_PAGE_URL}?authError=AUTHENTICATION_ERROR`));
  });

  test('the dev sign-in counts with rateLimit.routes.auth by the address its dev proxy names, apart from the refresh', async (t) => {
    const fastify = await buildDownApp(t, { env: GOOGLE_DEV_ENV, rateLimit: createAuthLimits() });
    const signIns = await mapSeries(repeat(AUTH_LIMIT.max + 1, from(DEV_PROXY_ADDRESS)), (headers) => fastify.inject({
      method: 'POST',
      url: LOGIN_DEV_URL,
      payload: { email: 'anna@example.com' },
      headers,
    }));
    const refresh = await postRefresh(fastify, { headers: from(DEV_PROXY_ADDRESS) });

    assert.deepEqual(signIns.map((response) => isLimited(response)), [false, false, true]);
    assert.equal(refresh.statusCode, 401);
  });
});
