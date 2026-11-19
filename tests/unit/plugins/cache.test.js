import { wrapCache } from '#core/cache/index.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { createSilentServer, FAST_RECONNECT, REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const SHARED_MESSAGE = 'Cache lives in the main Redis: it must run with noeviction and memory to spare';
const OWN_MESSAGE = 'Cache uses a Redis of its own';

const SHORT_OUTAGE = '0.2s';
const PAST_SHORT_OUTAGE_MS = 600;

async function buildApp(t, { env = {}, ...sections } = {}) {
  const sink = createLogSink();
  const fastify = await buildTestApp({
    ...sections,
    env: { ...REDIS_DOWN_ENV, ...env },
    redis: FAST_RECONNECT,
    cache: { outageAlertAfter: SHORT_OUTAGE },
    logger: { level: 'info', stream: sink.stream },
  });

  t.after(() => fastify.close());

  return { fastify, sink };
}

async function createOwnCacheEnv(t) {
  const server = await createSilentServer(t);

  return { APP_CACHE_REDIS_HOST: '127.0.0.1', APP_CACHE_REDIS_PORT: String(server.port) };
}

function findOutages(sink, label) {
  return sink.lines.filter((line) => line.msg === `${label} is down: the cache is off and reads go to the database`);
}

describe('cache plugin', () => {
  test('is registered under the name "cache" and says once at the start that the cache lives in the main Redis', async (t) => {
    const { fastify, sink } = await buildApp(t);
    const lines = sink.lines.filter((line) => line.msg === SHARED_MESSAGE);

    assert.equal(fastify.hasPlugin('cache'), true);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 30);
    assert.equal(lines[0].cache.redis, fastify.redis.address);
    assert.equal(sink.lines.some((line) => line.msg === OWN_MESSAGE), false);
  });

  test('says once that the cache uses a Redis of its own, with its address and no credentials', async (t) => {
    const env = { ...(await createOwnCacheEnv(t)), APP_CACHE_REDIS_USER: 'cache', APP_CACHE_REDIS_PASSWORD: 'cache-secret' };
    const { fastify, sink } = await buildApp(t, { env });
    const lines = sink.lines.filter((line) => line.msg === OWN_MESSAGE);

    assert.equal(lines.length, 1);
    assert.equal(lines[0].cache.redis, fastify.cacheRedis.address);
    assert.equal(JSON.stringify(sink.lines).includes('cache-secret'), false);
  });

  test('reports a Redis of its own that stays down, once', async (t) => {
    const { fastify, sink } = await buildApp(t, { env: await createOwnCacheEnv(t) });

    fastify.cacheRedis.connect();

    const outage = await waitFor(() => findOutages(sink, 'Cache Redis')[0], 'the outage to be reported');

    await sleep(PAST_SHORT_OUTAGE_MS);

    assert.equal(outage.level, 40);
    assert.equal(outage.cache.address, fastify.cacheRedis.address);
    assert.equal(findOutages(sink, 'Cache Redis').length, 1);
  });

  test('also reports the main Redis when the cache lives in it: that is the cache Redis then', async (t) => {
    const { fastify, sink } = await buildApp(t);

    fastify.redis.connect();
    await waitFor(() => findOutages(sink, 'Redis').length === 1, 'the outage to be reported');

    assert.equal(findOutages(sink, 'Redis')[0].cache.address, fastify.redis.address);
  });

  test('stops watching when the app closes', async (t) => {
    const { fastify, sink } = await buildApp(t, { env: await createOwnCacheEnv(t) });

    fastify.cacheRedis.connect();
    await fastify.close();
    await sleep(PAST_SHORT_OUTAGE_MS);

    assert.deepEqual(findOutages(sink, 'Cache Redis'), []);
  });

  test('a route that caches answers with what its function gives when Redis is down, not with a 500', async (t) => {
    const { fastify } = await buildApp(t);

    fastify.redis.connect();
    fastify.get('/cached', {
      schema: { response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { at: { type: 'string' } } } } } } },
    }, async (request, reply) => reply.ok(await wrapCache('cached', () => ({ at: new Date(0) }), { tables: ['users'] })));

    const response = await fastify.inject('/cached');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { at: '1970-01-01T00:00:00.000Z' });
  });
});
