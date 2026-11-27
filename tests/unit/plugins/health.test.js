import { MODE } from '#config/env.js';
import { createRateLimitConfig } from '#config/rate-limit.js';
import { buildTestApp, successBody } from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { issueFor } from '#root/tests/helper/guard.js';
import { buildDownApp } from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const LIVE_URL = '/health/live';
const PING_URL = '/api/v1/system/ping';
const ME_URL = '/api/v1/auth/me';
const SPEC_URL = '/docs/json';

const ALIVE = Object.freeze({ isAlive: true });
const ALIVE_SCHEMA = Object.freeze({ type: 'object', properties: { isAlive: { type: 'boolean' } } });

// A socket of the internet: a request of the own network that names no client is never counted.
const PUBLIC_CLIENT = Object.freeze({ remoteAddress: '8.8.8.8' });
const PROBES_PER_METHOD = 5;
const ONE_REQUEST = Object.freeze({ max: 1, window: '1m' });

// Any work of the event loop is pressure: the check refuses every request a sample or two after the start.
const PRESSURE_OF_ANY_WORK = Object.freeze({
  maxEventLoopDelay: '1s',
  maxEventLoopUtilization: Number.MIN_VALUE,
  utilizationWindow: '0.1s',
  sampleInterval: '0.1s',
});

async function buildHealthApp(t, sections) {
  const fastify = await buildTestApp(sections);

  t.after(() => fastify.close());

  return fastify;
}

function probeLive(fastify) {
  return Promise.all(['GET', 'HEAD'].flatMap((method) => Array.from(
    { length: PROBES_PER_METHOD },
    () => fastify.inject({ method, url: LIVE_URL, ...PUBLIC_CLIENT }),
  )));
}

function readStatuses(responses) {
  return responses.map((response) => response.statusCode);
}

describe('health plugin: GET /health/live', () => {
  test('answers 200 with { isAlive: true } in the envelope, and its HEAD twin 200 without a body', async (t) => {
    const fastify = await buildHealthApp(t);
    const [live, head] = await Promise.all([fastify.inject(LIVE_URL), fastify.inject({ method: 'HEAD', url: LIVE_URL })]);

    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), successBody(live, ALIVE));
    assert.deepEqual([head.statusCode, head.payload], [200, '']);
  });

  test('answers while the database and Redis are down: it asks neither, where a route that needs them answers 503', async (t) => {
    const fastify = await buildDownApp(t);
    const [live, me] = await Promise.all([fastify.inject(LIVE_URL), fastify.inject({ url: ME_URL, headers: issueFor(fastify).headers })]);

    assert.deepEqual(readStatuses([live, me]), [200, 503]);
    assert.deepEqual(live.json(), successBody(live, ALIVE));
  });

  test('is outside the limiter: its probes take nothing of the quota of an address, and an address that has spent it still gets every answer', async (t) => {
    const fastify = await buildHealthApp(t, { rateLimit: { tiers: { ...createRateLimitConfig().tiers, guest: ONE_REQUEST } } });
    const before = await probeLive(fastify);
    const limited = await mapSeries([PING_URL, PING_URL], (url) => fastify.inject({ url, ...PUBLIC_CLIENT }));
    const after = await probeLive(fastify);

    assert.deepEqual(readStatuses(limited), [200, 429]);
    assert.deepEqual(readStatuses([...before, ...after]), [...before, ...after].map(() => 200));
  });

  test('answers under pressure, its HEAD twin too, while the other routes answer 503', async (t) => {
    const fastify = await buildHealthApp(t, { app: { pressure: PRESSURE_OF_ANY_WORK } });
    const refused = await waitFor(async () => {
      const response = await fastify.inject(PING_URL);

      return response.statusCode === 503 && response;
    }, 'a 503 of the pressure check');
    const [live, head] = await Promise.all([fastify.inject(LIVE_URL), fastify.inject({ method: 'HEAD', url: LIVE_URL })]);

    assert.equal(refused.json().code, 'SERVICE_UNAVAILABLE_ERROR');
    assert.deepEqual(readStatuses([live, head]), [200, 200]);
    assert.deepEqual(live.json(), successBody(live, ALIVE));
  });

  test('is documented in dev mode once, without its HEAD twin, under the tag Health and without security', async (t) => {
    const fastify = await buildHealthApp(t, { env: { APP_MODE: MODE.DEV } });
    const spec = await fastify.inject(SPEC_URL);
    const path = spec.json().paths[LIVE_URL];

    assert.equal(spec.statusCode, 200);
    assert.deepEqual(Object.keys(path), ['get']);
    assert.deepEqual(path.get.tags, ['Health']);
    assert.equal(Object.hasOwn(path.get, 'security'), false);
    assert.deepEqual(Object.keys(path.get.responses), ['200']);
    assert.deepEqual(path.get.responses['200'].content['application/json'].schema.properties.data, ALIVE_SCHEMA);
  });
});
