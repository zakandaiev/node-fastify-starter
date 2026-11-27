import { MODE } from '#config/env.js';
import { createRateLimitConfig } from '#config/rate-limit.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { mapSeries } from '#utils/async.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PING_URL = '/api/v1/system/ping';
const UNKNOWN_URL = '/api/v1/helmet-probe/unknown';
const GUARDED_URL = '/api/v1/auth/me';
const LOG_URL = '/api/v1/log/error';
const DOCS_URL = '/docs';

const FOREIGN_ORIGIN = 'https://evil.test';
const COUNTED_CLIENT = Object.freeze({ 'x-forwarded-for': '203.0.113.7' });

const CONTENT_SECURITY_POLICY = 'content-security-policy';
const API_POLICY = "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";

const SHARED_HEADERS = Object.freeze({
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'DENY',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
});

const PROD_HEADERS = Object.freeze({ [CONTENT_SECURITY_POLICY]: API_POLICY, ...SHARED_HEADERS });
const HEADER_NAMES = Object.freeze(Object.keys(PROD_HEADERS));

// Any work of the event loop is pressure: the check refuses every request a sample or two after the start.
const PRESSURE_OF_ANY_WORK = Object.freeze({
  maxEventLoopDelay: '1s',
  maxEventLoopUtilization: Number.MIN_VALUE,
  utilizationWindow: '0.1s',
  sampleInterval: '0.1s',
});

const ONE_REQUEST = Object.freeze({ max: 1, window: '1m' });

async function buildModeApp(t, mode, { env = {}, ...sections } = {}) {
  const fastify = await buildTestApp({ ...sections, env: { ...env, APP_MODE: mode } });

  t.after(() => fastify.close());

  return fastify;
}

function readSecurityHeaders(response) {
  return pick(response.headers, HEADER_NAMES);
}

function describeAnswers(responses) {
  return responses.map((response) => [response.statusCode, readSecurityHeaders(response)]);
}

function injectAll(fastify, urls) {
  return Promise.all(urls.map((url) => fastify.inject(url)));
}

function waitForPressure(fastify) {
  return waitFor(async () => {
    const response = await fastify.inject(PING_URL);

    return response.statusCode === 503 && response;
  }, 'a 503 of the pressure check');
}

describe('helmet plugin', () => {
  test('puts the same headers on a success, a 404 and a 401 in prod mode, the policy of an API that only answers JSON and redirects among them', async (t) => {
    const fastify = await buildModeApp(t, MODE.PROD);
    const responses = await injectAll(fastify, [PING_URL, UNKNOWN_URL, GUARDED_URL]);

    assert.deepEqual(describeAnswers(responses), [[200, PROD_HEADERS], [404, PROD_HEADERS], [401, PROD_HEADERS]]);
  });

  test('sends the policy in one header: no second one, no policy in report-only mode, and no X-Powered-By', async (t) => {
    const fastify = await buildModeApp(t, MODE.PROD);
    const responses = await injectAll(fastify, [PING_URL, UNKNOWN_URL, GUARDED_URL]);

    responses.forEach((response) => {
      const policyNames = Object.keys(response.headers).filter((name) => name.startsWith(CONTENT_SECURITY_POLICY));

      assert.deepEqual(policyNames, [CONTENT_SECURITY_POLICY]);
      assert.equal(response.headers[CONTENT_SECURITY_POLICY], API_POLICY);
      assert.equal(response.headers['x-powered-by'], undefined);
    });
  });

  test('sends no Content-Security-Policy in dev mode, where Swagger UI runs scripts and styles of its own, and every other header as in prod', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);
    const responses = await injectAll(fastify, [PING_URL, UNKNOWN_URL, GUARDED_URL, DOCS_URL]);

    assert.deepEqual(describeAnswers(responses), [[200, SHARED_HEADERS], [404, SHARED_HEADERS], [401, SHARED_HEADERS], [200, SHARED_HEADERS]]);
  });

  test('puts them on the refusals of the checks after it too: a 503 of the pressure check, a 403 of the origin check and a 429 of the limiter', async (t) => {
    const [pressed, limited] = await Promise.all([
      buildModeApp(t, MODE.PROD, { app: { pressure: PRESSURE_OF_ANY_WORK } }),
      buildModeApp(t, MODE.PROD, { rateLimit: { tiers: { ...createRateLimitConfig().tiers, guest: ONE_REQUEST } } }),
    ]);
    const unavailable = await waitForPressure(pressed);
    const foreign = await limited.inject({ method: 'POST', url: LOG_URL, headers: { origin: FOREIGN_ORIGIN } });
    const [allowed, tooMany] = await mapSeries([PING_URL, PING_URL], (url) => limited.inject({ url, headers: COUNTED_CLIENT }));

    assert.deepEqual([unavailable, foreign, tooMany].map((response) => response.json().code), ['SERVICE_UNAVAILABLE_ERROR', 'ORIGIN_ERROR', 'RATE_LIMIT_ERROR']);
    assert.deepEqual(describeAnswers([unavailable, foreign, allowed, tooMany]), [[503, PROD_HEADERS], [403, PROD_HEADERS], [200, PROD_HEADERS], [429, PROD_HEADERS]]);
  });
});
