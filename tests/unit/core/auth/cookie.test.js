import { clearAuthCookies, endAuthCookies, setAuthCookies } from '#core/auth/cookie.js';
import { issueTokens, readAccessToken, readRefreshToken } from '#core/auth/token.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { buildTestApp, errorBody } from '#root/tests/helper/app.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { toDate, toTimestamp } from '#utils/date.js';
import { omit } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const HTTP_ENV = Object.freeze({ APP_PROTOCOL: 'http' });
const HTTPS_ENV = Object.freeze({ APP_PROTOCOL: 'https' });

const LIFETIMES = Object.freeze({ accessTtl: '10m', refreshTtl: '30d', sessionMaxAge: '90d' });

// Five minutes before a session that began then has lived its 90 days.
const NOW = toTimestamp('2026-11-25T10:00:00.900Z');
const STARTED_AT = '2026-08-27T10:05:00.437Z';
const SECONDS_LEFT = 300;

const ISSUED = Object.freeze({
  userId: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b',
  sid: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2d',
  scopes: Object.freeze(['users:read']),
  accessToken: 'header.access-claims.signature',
  refreshToken: 'header.refresh-claims.signature',
  accessTtl: 600,
  refreshTtl: 2592000,
});

// Secure is the one attribute https adds.
const SET_OVER_HTTP = [
  {
    name: 'accessToken',
    value: ISSUED.accessToken,
    maxAge: 600,
    path: '/api',
    httpOnly: true,
    sameSite: 'Lax',
  },
  {
    name: 'refreshToken',
    value: ISSUED.refreshToken,
    maxAge: 2592000,
    path: '/api/v1/auth/refresh',
    httpOnly: true,
    sameSite: 'Lax',
  },
  {
    name: 'hasSession',
    value: '1',
    maxAge: 2592000,
    path: '/',
    sameSite: 'Lax',
  },
  {
    name: 'hasAccess',
    value: '1',
    maxAge: 600,
    path: '/',
    sameSite: 'Lax',
  },
];

const EPOCH = toDate(0);
const CLEARED_OVER_HTTP = SET_OVER_HTTP.map((cookie) => ({
  ...cookie,
  value: '',
  maxAge: 0,
  expires: EPOCH,
}));

// A browser keeps none above this, its name and attributes included.
const COOKIE_MAX_BYTES = 4096;

const COOKIE_REQUESTS = [{}, { [HEADER.AUTHORIZATION]: 'Basic dXNlcjpwYXNzd29yZA==' }, { [HEADER.AUTHORIZATION]: 'Bearertoken' }];
const BEARER_REQUESTS = ['Bearer token', 'bearer token', 'Bearer', 'Bearer one two'].map((value) => ({ [HEADER.AUTHORIZATION]: value }));

function toSecure(cookies) {
  return cookies.map((cookie) => ({ ...cookie, secure: true }));
}

function readCookies(response) {
  return response.cookies.map((cookie) => ({ ...cookie }));
}

// A route for each of the functions, which answers with what the function gave.
async function buildApp(t, { env = HTTP_ENV, ...sections } = {}) {
  const fastify = await buildTestApp({ ...sections, env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()), ...env } });

  t.after(() => fastify.close());

  fastify.post('/set', async (request, reply) => ({ result: setAuthCookies(reply, ISSUED) }));
  fastify.post('/clear', async (request, reply) => ({ result: clearAuthCookies(reply) }));
  fastify.post('/end', async (request, reply) => ({ result: endAuthCookies(request, reply) }));

  return fastify;
}

function post(fastify, url, options) {
  return fastify.inject({ method: 'POST', url, ...options });
}

describe('setAuthCookies', () => {
  test('sets the two tokens for the API alone, out of reach of scripts, and the two markers for the whole site, within their reach', async (t) => {
    const fastify = await buildApp(t);
    const response = await post(fastify, '/set');

    assert.deepEqual(response.json(), { result: true });
    assert.deepEqual(readCookies(response), SET_OVER_HTTP);
  });

  test('adds Secure to all four when the app is served over https', async (t) => {
    const fastify = await buildApp(t, { env: HTTPS_ENV });

    assert.deepEqual(readCookies(await post(fastify, '/set')), toSecure(SET_OVER_HTTP));
  });

  test('the tokens follow the prefix of the API, the refresh one to the route that takes it, and the markers do not', async (t) => {
    const fastify = await buildApp(t, { app: { apiPrefix: '/service/api' } });
    const paths = readCookies(await post(fastify, '/set')).map((cookie) => cookie.path);

    assert.deepEqual(paths, ['/service/api', '/service/api/v1/auth/refresh', '/', '/']);
    assert.equal(fastify.hasRoute({ method: 'POST', url: paths[1] }), true);
  });

  test('a cookie lives as long as its token and a marker as long as the token it tells of, also near the end of a session', async (t) => {
    const fastify = await buildApp(t, { auth: LIFETIMES });
    const answers = [];

    fastify.post('/issue', async (request, reply) => {
      const { issued } = issueTokens({
        userId: ISSUED.userId,
        sid: ISSUED.sid,
        scopes: ISSUED.scopes,
        startedAt: toDate(STARTED_AT),
      });

      answers.push(issued);

      return { result: setAuthCookies(reply, issued) };
    });
    t.mock.timers.enable({ apis: ['Date'], now: NOW });

    const response = await post(fastify, '/issue');
    const [{ accessToken, refreshToken }] = answers;
    const values = [accessToken, refreshToken, '1', '1'];

    assert.equal(response.statusCode, 200);
    assert.deepEqual(readCookies(response), SET_OVER_HTTP.map((cookie, index) => ({
      ...cookie,
      value: values[index],
      maxAge: SECONDS_LEFT,
    })));
  });

  test('a request that brings the cookies back gives the tokens as they were issued', async (t) => {
    const fastify = await buildApp(t);

    fastify.get('/read', (request) => ({ accessToken: readAccessToken(request), refreshToken: readRefreshToken(request) }));

    const set = readCookies(await post(fastify, '/set'));
    const cookies = Object.fromEntries(set.map((cookie) => [cookie.name, cookie.value]));
    const response = await fastify.inject({ url: '/read', cookies });

    assert.deepEqual(response.json(), { accessToken: ISSUED.accessToken, refreshToken: ISSUED.refreshToken });
  });

  test('an access token as large as the config lets it be makes a cookie a browser keeps', async (t) => {
    const fastify = await buildApp(t, { env: HTTPS_ENV });
    const accessToken = 'x'.repeat(fastify.config.auth.accessTokenMaxBytes);

    fastify.post('/large', async (request, reply) => ({ result: setAuthCookies(reply, { ...ISSUED, accessToken }) }));

    const response = await post(fastify, '/large');
    const bytes = Buffer.byteLength(response.headers[HEADER.SET_COOKIE][0]);

    assert.equal(readCookies(response)[0].value, accessToken);
    assert.ok(bytes <= COOKIE_MAX_BYTES, `${bytes} bytes`);
  });

  test('cookies set before an error of the app leave with its answer', async (t) => {
    const fastify = await buildApp(t);

    fastify.post('/set-and-fail', async (request, reply) => {
      setAuthCookies(reply, ISSUED);

      throw new AppError(ERROR_CODE.AUTHORIZATION_ERROR);
    });

    const response = await post(fastify, '/set-and-fail');

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), errorBody(response, 'AUTHORIZATION_ERROR', 'Authorization error'));
    assert.deepEqual(readCookies(response), SET_OVER_HTTP);
  });
});

describe('clearAuthCookies', () => {
  test('ends all four at once', async (t) => {
    const fastify = await buildApp(t);
    const response = await post(fastify, '/clear');

    assert.deepEqual(response.json(), { result: true });
    assert.deepEqual(readCookies(response), CLEARED_OVER_HTTP);
  });

  test('ends them with the attributes they were set with, over https and under another prefix as well: a browser drops no other cookie', async (t) => {
    const fastify = await buildApp(t, { env: HTTPS_ENV, app: { apiPrefix: '/service/api' } });
    const set = readCookies(await post(fastify, '/set'));
    const cleared = readCookies(await post(fastify, '/clear'));

    assert.deepEqual(cleared, set.map((cookie) => ({
      ...cookie,
      value: '',
      maxAge: 0,
      expires: EPOCH,
    })));
    assert.deepEqual(
      set.map((cookie) => omit(cookie, ['path'])),
      toSecure(SET_OVER_HTTP).map((cookie) => omit(cookie, ['path'])),
    );
  });

  test('cookies cleared before an error of the app leave with its answer', async (t) => {
    const fastify = await buildApp(t);

    fastify.post('/clear-and-fail', async (request, reply) => {
      clearAuthCookies(reply);

      throw new AppError(ERROR_CODE.SESSION_REVOKED);
    });

    const response = await post(fastify, '/clear-and-fail');

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), errorBody(response, 'SESSION_REVOKED', 'Session revoked'));
    assert.deepEqual(readCookies(response), CLEARED_OVER_HTTP);
  });
});

describe('endAuthCookies', () => {
  async function end(fastify, headers) {
    const response = await post(fastify, '/end', { headers, cookies: { accessToken: ISSUED.accessToken } });

    return { ...response.json(), cookies: readCookies(response) };
  }

  test('clears the cookies of a request that came with them, also beside a header of another scheme', async (t) => {
    const fastify = await buildApp(t);
    const answers = await Promise.all(COOKIE_REQUESTS.map((headers) => end(fastify, headers)));

    assert.deepEqual(answers, COOKIE_REQUESTS.map(() => ({ result: true, cookies: CLEARED_OVER_HTTP })));
  });

  test('leaves the cookies alone for a request with a Bearer header, also one nobody can read: they may be of another session', async (t) => {
    const fastify = await buildApp(t);
    const answers = await Promise.all(BEARER_REQUESTS.map((headers) => end(fastify, headers)));

    assert.deepEqual(answers, BEARER_REQUESTS.map(() => ({ result: false, cookies: [] })));
  });
});
