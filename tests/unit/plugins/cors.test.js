import { createRateLimitConfig } from '#config/rate-limit.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { TEST_ENV } from '#root/tests/helper/config.js';
import { mapSeries } from '#utils/async.js';
import { convertStringToWholeSeconds } from '#utils/date.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PING_URL = '/api/v1/system/ping';

const APP_ORIGIN = `https://${TEST_ENV.APP_HOST}`;
const FRONTEND_ORIGIN = 'http://localhost:5173';
const FOREIGN_ORIGINS = Object.freeze([
  'https://evil.test',
  `http://${TEST_ENV.APP_HOST}`,
  `${APP_ORIGIN}:8443`,
  `https://${TEST_ENV.APP_HOST}.evil.test`,
  'null',
]);

const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE';
const EXPOSED_HEADERS = 'x-request-id, retry-after';
const REQUESTED_HEADERS = 'content-type, authorization';

const COUNTED_CLIENT = Object.freeze({ 'x-forwarded-for': '203.0.113.7' });
const PREFLIGHT_COUNT = 10;
const TWO_REQUESTS = Object.freeze({ max: 2, window: '1m' });

async function buildCorsApp(t, { env = {}, ...sections } = {}) {
  const fastify = await buildTestApp({ ...sections, env: { APP_CORS_ORIGINS: FRONTEND_ORIGIN, ...env } });

  t.after(() => fastify.close());

  return fastify;
}

function preflight(fastify, origin, headers = {}) {
  return fastify.inject({
    method: 'OPTIONS',
    url: PING_URL,
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': REQUESTED_HEADERS,
      ...headers,
    },
  });
}

function readVary(response) {
  return String(response.headers.vary ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase());
}

function describeCors(response) {
  return {
    statusCode: response.statusCode,
    allowOrigin: response.headers['access-control-allow-origin'],
    allowCredentials: response.headers['access-control-allow-credentials'],
    exposeHeaders: response.headers['access-control-expose-headers'],
    allowMethods: response.headers['access-control-allow-methods'],
    isVaryingByOrigin: readVary(response).includes('origin'),
  };
}

function describePreflight(response) {
  return {
    ...describeCors(response),
    payload: response.payload,
    allowHeaders: response.headers['access-control-allow-headers'],
    maxAge: response.headers['access-control-max-age'],
  };
}

describe('cors plugin: a preflight', () => {
  test('from the origin of the app or from one of APP_CORS_ORIGINS gets an empty 204 that names that origin, the credentials, the six methods, the headers asked for and the Max-Age of preflightMaxAge, and varies by Origin', async (t) => {
    const fastify = await buildCorsApp(t);
    const origins = [APP_ORIGIN, FRONTEND_ORIGIN];
    const responses = await Promise.all(origins.map((origin) => preflight(fastify, origin)));

    assert.deepEqual(responses.map(describePreflight), origins.map((origin) => ({
      statusCode: 204,
      allowOrigin: origin,
      allowCredentials: 'true',
      exposeHeaders: EXPOSED_HEADERS,
      allowMethods: ALLOWED_METHODS,
      isVaryingByOrigin: true,
      payload: '',
      allowHeaders: REQUESTED_HEADERS,
      maxAge: String(convertStringToWholeSeconds(fastify.config.cors.preflightMaxAge)),
    })));
  });

  test('is kept by the browser for preflightMaxAge of the config, in whole seconds', async (t) => {
    const fastify = await buildCorsApp(t, { cors: { preflightMaxAge: '1.5m' } });
    const response = await preflight(fastify, APP_ORIGIN);

    assert.equal(response.headers['access-control-max-age'], '90');
  });

  test('from any other origin gets no Access-Control-Allow-Origin, so the browser sends nothing after it', async (t) => {
    const fastify = await buildCorsApp(t);
    const responses = await Promise.all(FOREIGN_ORIGINS.map((origin) => preflight(fastify, origin)));

    assert.deepEqual(
      responses.map((response) => [response.statusCode, response.headers['access-control-allow-origin']]),
      FOREIGN_ORIGINS.map(() => [204, undefined]),
    );
  });

  test('without the headers of a preflight is an OPTIONS like any other: an empty 204, not the 400 in text/plain of the plugin', async (t) => {
    const fastify = await buildCorsApp(t);
    const responses = await Promise.all([
      fastify.inject({ method: 'OPTIONS', url: PING_URL }),
      fastify.inject({ method: 'OPTIONS', url: PING_URL, headers: { origin: APP_ORIGIN } }),
      fastify.inject({ method: 'OPTIONS', url: PING_URL, headers: { 'access-control-request-method': 'POST' } }),
    ]);

    assert.deepEqual(
      responses.map((response) => [response.statusCode, response.payload, response.headers['content-type']]),
      responses.map(() => [204, '', undefined]),
    );
  });

  test('is never limited: an address that sends many still has its whole quota for the requests after them', async (t) => {
    const fastify = await buildCorsApp(t, { rateLimit: { tiers: { ...createRateLimitConfig().tiers, guest: TWO_REQUESTS } } });
    const preflights = await Promise.all(Array.from({ length: PREFLIGHT_COUNT }, () => preflight(fastify, APP_ORIGIN, COUNTED_CLIENT)));
    const requests = await mapSeries([PING_URL, PING_URL, PING_URL], (url) => fastify.inject({ url, headers: { ...COUNTED_CLIENT, origin: APP_ORIGIN } }));

    assert.deepEqual(
      preflights.map((response) => [response.statusCode, response.headers['access-control-allow-origin']]),
      preflights.map(() => [204, APP_ORIGIN]),
    );
    assert.deepEqual(requests.map((response) => response.statusCode), [200, 200, 429]);
  });
});

describe('cors plugin: a request', () => {
  test('from an allowed Origin is answered with that origin and the credentials, and its page may read x-request-id and retry-after', async (t) => {
    const fastify = await buildCorsApp(t);
    const origins = [APP_ORIGIN, FRONTEND_ORIGIN];
    const responses = await Promise.all(origins.map((origin) => fastify.inject({ url: PING_URL, headers: { origin } })));

    assert.deepEqual(responses.map(describeCors), origins.map((origin) => ({
      statusCode: 200,
      allowOrigin: origin,
      allowCredentials: 'true',
      exposeHeaders: EXPOSED_HEADERS,
      allowMethods: undefined,
      isVaryingByOrigin: true,
    })));
  });

  test('without Origin or from a foreign one gets no Access-Control-Allow-Origin, and the answer still varies by Origin for the caches between', async (t) => {
    const fastify = await buildCorsApp(t);
    const responses = await Promise.all([
      fastify.inject(PING_URL),
      ...FOREIGN_ORIGINS.map((origin) => fastify.inject({ url: PING_URL, headers: { origin } })),
    ]);

    assert.deepEqual(
      responses.map((response) => [response.statusCode, response.headers['access-control-allow-origin'], readVary(response).includes('origin')]),
      responses.map(() => [200, undefined, true]),
    );
  });
});
