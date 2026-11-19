import { getContext } from '#core/context/index.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { createSilentServer, REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { Redis } from 'ioredis';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const QUIET_MS = 200;

async function buildApp(t, sections = {}) {
  const fastify = await buildTestApp({ ...sections, env: { ...REDIS_DOWN_ENV, ...sections.env } });

  t.after(() => fastify.close());

  return fastify;
}

async function createCacheEnv(t) {
  const server = await createSilentServer(t);

  return { server, env: { APP_CACHE_REDIS_HOST: '127.0.0.1', APP_CACHE_REDIS_PORT: String(server.port) } };
}

describe('redis plugin', () => {
  test('is registered under the name "redis" and puts both clients into the context of the app', async (t) => {
    const fastify = await buildApp(t);

    assert.equal(fastify.hasPlugin('redis'), true);
    assert.equal(fastify.context.redis, fastify.redis);
    assert.equal(fastify.context.cacheRedis, fastify.cacheRedis);
    assert.equal(fastify.context.db, fastify.db);
    assert.ok(Object.isFrozen(fastify.context));
  });

  test('without a Redis of its own the cache lives in the main one: both names hold one client', async (t) => {
    const fastify = await buildApp(t);

    assert.equal(fastify.cacheRedis, fastify.redis);
    assert.equal(fastify.redis.label, 'Redis');
  });

  test('gives the cache a client of its own when APP_CACHE_REDIS_HOST is set, with the key prefix of the app', async (t) => {
    const { env } = await createCacheEnv(t);
    const fastify = await buildApp(t, { env });

    assert.notEqual(fastify.cacheRedis, fastify.redis);
    assert.equal(fastify.cacheRedis.label, 'Cache Redis');
    assert.equal(fastify.cacheRedis.address, `127.0.0.1:${env.APP_CACHE_REDIS_PORT}`);
    assert.equal(fastify.cacheRedis.keyPrefix, fastify.redis.keyPrefix);
    assert.equal(fastify.cacheRedis.client.options.commandTimeout, fastify.redis.client.options.commandTimeout);
  });

  test('opens no connection while the app is built and while it serves requests: the entrypoint connects', async (t) => {
    const { server, env } = await createCacheEnv(t);
    const fastify = await buildApp(t, { env });

    fastify.get('/redis', () => ({ isSame: getContext().redis === fastify.redis, isReady: getContext().cacheRedis.isReady() }));

    const response = await fastify.inject('/redis');

    await sleep(QUIET_MS);

    assert.deepEqual(response.json(), { isSame: true, isReady: false });
    assert.equal(fastify.redis.client.status, 'wait');
    assert.equal(fastify.cacheRedis.client.status, 'wait');
    assert.equal(server.countAccepted(), 0);
  });

  test('closes both clients when the app closes', async (t) => {
    const { env } = await createCacheEnv(t);
    const fastify = await buildApp(t, { env });

    await fastify.close();

    assert.equal(await fastify.redis.close(), false);
    assert.equal(await fastify.cacheRedis.close(), false);
    assert.equal(fastify.redis.connect(), false);
  });

  test('a failed start closes the clients it has made', async (t) => {
    const sink = createLogSink();
    const disconnect = t.mock.method(Redis.prototype, 'disconnect');

    await assert.rejects(buildApp(t, { app: { apiPrefix: '/*/x' }, logger: { level: 'error', stream: sink.stream } }), /Wildcard/);
    assert.equal(disconnect.mock.callCount(), 1);
    assert.deepEqual(sink.lines.filter((line) => line.msg === 'Failed to close the app after a failed start'), []);
  });
});
