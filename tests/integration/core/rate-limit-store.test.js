import { createLimitStore } from '#core/rate-limit/store.js';
import { timeIt, waitFor } from '#root/tests/helper/async.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import {
  createTcpProxy,
  createTestRedis,
  FAST_RECONNECT,
  waitUntilReady,
} from '#root/tests/helper/redis.js';
import { getServiceAddress } from '#root/tests/helper/service.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const testRedis = await createTestRedis();

const NAMESPACE = 'rate-limit:';
const LABEL = 'Proxied Redis';
const MEMORY_MAX_ENTRIES = 100;

// Long enough that no window ends within a test: none of them waits for the end of one.
const WINDOW_MS = 10000;
const MAX = 2;

// Short deadlines, so that a test of a hang takes a fraction of a second.
const SHORT_DEADLINES = Object.freeze({ ...FAST_RECONNECT, commandTimeout: '0.3s', socketTimeout: '0.6s' });
const COMMAND_TIMEOUT_MS = 300;
const TIMEOUT_SLACK_MS = 400;

// Counting in memory is far below this; waiting for the command timeout is not.
const FAST_COUNT_MS = 200;

// How far a window runs down before a count above max shows whether it starts the window again.
const RUN_DOWN_MS = 200;

const ITEMS_URL = '/api/v1/items';
const OTHER_URL = '/api/v1/other';

// What the plugin hands the store it builds: its own options, with the flags the limiter of the app sets.
const PLUGIN_PARAMS = Object.freeze({ continueExceeding: false, exponentialBackoff: false });

const COUNT_FAILED_MESSAGE = 'Rate limit could not count in Redis: the process counts in memory';

function openStore(redis, params = PLUGIN_PARAMS) {
  const LimitStore = createLimitStore({ redis, namespace: NAMESPACE, memoryMaxEntries: MEMORY_MAX_ENTRIES });

  return new LimitStore(params);
}

function childOf(store, method, url) {
  return store.child({ ...PLUGIN_PARAMS, routeInfo: { method, url } });
}

// The plugin waits for the callback, never for incr() itself: what the callback gets is the answer.
function count(store, key, { timeWindow = WINDOW_MS, max = MAX } = {}) {
  return new Promise((resolve) => {
    store.incr(key, (...args) => resolve(args), timeWindow, max);
  });
}

function readCurrents(counted) {
  return counted.map(([error, result]) => (error === null
    ? result.current
    : error));
}

function isWithinWindow(ttl) {
  return ttl > 0 && ttl <= WINDOW_MS;
}

// A counter of its own for each test: the counters of the file outlive their tests.
function createKey() {
  return `user:${uuidv7()}`;
}

function toRedisKey(name) {
  return `${testRedis.keyPrefix}${NAMESPACE}${name}`;
}

function readCount(name) {
  return testRedis.admin.get(toRedisKey(name));
}

function readTtl(name) {
  return testRedis.admin.pttl(toRedisKey(name));
}

// The plugin alone over the store and the Redis of the file, with one key for every request.
async function openPluginApp(t, key) {
  const fastify = Fastify();

  t.after(() => fastify.close());
  await fastify.register(fastifyRateLimit, {
    store: createLimitStore({ redis: testRedis.redis, namespace: NAMESPACE, memoryMaxEntries: MEMORY_MAX_ENTRIES }),
    keyGenerator: () => key,
    max: 10,
    timeWindow: WINDOW_MS,
  });

  return fastify;
}

function injectEach(fastify, requests) {
  return mapSeries(requests, ([method, url]) => fastify.inject({ method, url }));
}

function readStatuses(responses) {
  return responses.map((response) => response.statusCode);
}

// A client of the file's prefix that talks to Redis through a proxy the test can freeze and cut.
async function openProxied(t) {
  const proxy = await createTcpProxy(t, getServiceAddress('redis'));
  const sink = createLogSink();
  const opened = testRedis.open({
    env: proxy.env,
    redis: SHORT_DEADLINES,
    logger: { level: 'info', stream: sink.stream },
  }, { label: LABEL });

  t.after(() => opened.redis.close());
  await waitUntilReady(opened.redis);

  return { ...opened, proxy, sink };
}

describe('createLimitStore on a Redis', { skip: testRedis.skip }, () => {
  test('counts in Redis under the key prefix of the file and "rate-limit:": each key apart, with a TTL above zero and at most the window', async () => {
    const store = openStore(testRedis.redis);
    const [key, otherKey] = [createKey(), createKey()];
    const counted = await mapSeries([key, key, otherKey, key], (name) => count(store, name));
    const [counts, ttls, unprefixed] = await Promise.all([
      Promise.all([key, otherKey].map((name) => readCount(name))),
      Promise.all([key, otherKey].map((name) => readTtl(name))),
      testRedis.admin.exists(`${NAMESPACE}${key}`, key),
    ]);

    assert.deepEqual(readCurrents(counted), [1, 2, 1, 3]);
    assert.equal(counted[0][1].ttl, WINDOW_MS);
    assert.deepEqual(counted.map(([, { ttl }]) => isWithinWindow(ttl)), [true, true, true, true]);
    assert.deepEqual(counts, ['3', '1']);
    assert.deepEqual(ttls.map((ttl) => isWithinWindow(ttl)), [true, true]);
    assert.equal(unprefixed, 0);
  });

  test('stores of two processes, each over a client of its own, and two stores over one client share the count of a key', async (t) => {
    const second = testRedis.open({}, { label: 'Redis of another process' });

    t.after(() => second.redis.close());
    await waitUntilReady(second.redis);

    const stores = [openStore(testRedis.redis), openStore(second.redis), openStore(testRedis.redis)];
    const key = createKey();
    const counted = await mapSeries([stores[0], stores[1], stores[2], stores[1]], (store) => count(store, key));

    assert.deepEqual(readCurrents(counted), [1, 2, 3, 4]);
    assert.equal(await readCount(key), '4');
  });

  test('a child of a route counts under "rate-limit:<METHOD> <url>:<key>", apart from the root, and its HEAD twin under the key of its GET', async () => {
    const root = openStore(testRedis.redis);
    const items = childOf(root, 'GET', ITEMS_URL);
    const head = childOf(root, 'HEAD', ITEMS_URL);
    const key = createKey();
    const counted = await mapSeries([items, head, items, childOf(root, 'POST', ITEMS_URL), root], (store) => count(store, key));
    const counts = await Promise.all([
      `GET ${ITEMS_URL}:${key}`,
      `POST ${ITEMS_URL}:${key}`,
      `HEAD ${ITEMS_URL}:${key}`,
      key,
    ].map((name) => readCount(name)));

    assert.deepEqual(readCurrents(counted), [1, 2, 3, 1, 1]);
    assert.deepEqual(counts, ['3', '1', null, '1']);
  });

  test('through the plugin, a route with a limit of its own counts under its method and path, its HEAD twin with its GET, and a route without one under the root', async (t) => {
    const key = createKey();
    const fastify = await openPluginApp(t, key);

    fastify.get(ITEMS_URL, { config: { rateLimit: { max: 2, timeWindow: WINDOW_MS } } }, () => ({ isDone: true }));
    fastify.get(OTHER_URL, () => ({ isDone: true }));

    const responses = await injectEach(fastify, [
      ['GET', ITEMS_URL],
      ['HEAD', ITEMS_URL],
      ['GET', ITEMS_URL],
      ['GET', OTHER_URL],
    ]);
    const counts = await Promise.all([`GET ${ITEMS_URL}:${key}`, key].map((name) => readCount(name)));

    assert.deepEqual(readStatuses(responses), [200, 200, 429, 200]);
    assert.deepEqual(counts, ['3', '1']);
  });

  test('through the plugin, the HEAD twin of a route declared with a list of methods that holds GET counts with that route', async (t) => {
    const fastify = await openPluginApp(t, createKey());

    fastify.route({
      method: ['GET', 'POST'],
      url: ITEMS_URL,
      config: { rateLimit: { max: 2, timeWindow: WINDOW_MS } },
      handler: () => ({ isDone: true }),
    });

    const responses = await injectEach(fastify, [['GET', ITEMS_URL], ['HEAD', ITEMS_URL], ['POST', ITEMS_URL]]);

    assert.deepEqual(readStatuses(responses), [200, 200, 429]);
  });

  test('a count above max leaves the TTL of its window as it was, while a store told to continueExceeding starts the window again', async () => {
    const kept = openStore(testRedis.redis);
    const restarting = openStore(testRedis.redis, { ...PLUGIN_PARAMS, continueExceeding: true });
    const [key, restartedKey] = [createKey(), createKey()];
    const limit = { max: 1 };

    await Promise.all([count(kept, key, limit), count(restarting, restartedKey, limit)]);

    const ranDown = await waitFor(async () => {
      const ttls = await Promise.all([readTtl(key), readTtl(restartedKey)]);

      return ttls.every((ttl) => ttl <= WINDOW_MS - RUN_DOWN_MS) && ttls;
    }, 'the windows to run down');
    const above = await mapSeries([key, key, key], (name) => count(kept, name, limit));
    const restarted = await count(restarting, restartedKey, limit);
    const ttls = await Promise.all([readTtl(key), readTtl(restartedKey)]);

    assert.deepEqual(readCurrents(above), [2, 3, 4]);
    assert.deepEqual(above.map(([, { ttl }]) => ttl > 0 && ttl <= ranDown[0]), [true, true, true]);
    assert.equal(ttls[0] > 0 && ttls[0] <= ranDown[0], true, `the TTL went from ${ranDown[0]} to ${ttls[0]} ms`);
    assert.deepEqual(restarted, [null, { current: 2, ttl: WINDOW_MS }]);
    assert.equal(ttls[1] > ranDown[1], true, `the TTL went from ${ranDown[1]} to ${ttls[1]} ms`);
  });

  test('a Redis that stops answering makes the store count in memory once the command times out: the callback gets a count with no error, and the failure is logged', async (t) => {
    const { redis, proxy, sink } = await openProxied(t);
    const store = openStore(redis);
    const key = createKey();
    const inRedis = await count(store, key);

    proxy.freeze();

    const { result, durationMs } = await timeIt(() => count(store, key));
    const failures = findLogLines(sink, COUNT_FAILED_MESSAGE);

    assert.deepEqual(inRedis, [null, { current: 1, ttl: WINDOW_MS }]);
    assert.deepEqual(result, [null, { current: 1, ttl: WINDOW_MS }]);
    assert.ok(durationMs < COMMAND_TIMEOUT_MS + TIMEOUT_SLACK_MS, `counted in ${durationMs} ms`);
    assert.deepEqual(failures.map((line) => [line.level, line.redis.address]), [[LOG_LEVEL.ERROR, redis.address]]);
    assert.match(failures[0].err.message, /timed out/i);
    assert.equal(await readCount(key), '1');
  });

  test('a connection that is cut is not asked: the store counts in memory at once with no line of its own, and in Redis again once the client is back', async (t) => {
    const { redis, proxy, sink } = await openProxied(t);
    const store = openStore(redis);
    const key = createKey();
    const inRedis = await count(store, key);

    // Frozen, the proxy takes the reconnects and holds their handshake: the client stays down until it is thawed.
    proxy.freeze();
    proxy.kill();
    await waitFor(() => !redis.isReady(), 'the client to see its connection cut');

    const { result, durationMs } = await timeIt(() => count(store, key));

    assert.deepEqual(inRedis, [null, { current: 1, ttl: WINDOW_MS }]);
    assert.deepEqual(result, [null, { current: 1, ttl: WINDOW_MS }]);
    assert.ok(durationMs < FAST_COUNT_MS, `counted in ${durationMs} ms`);
    assert.deepEqual(findLogLines(sink, COUNT_FAILED_MESSAGE), []);

    proxy.thaw();
    await waitUntilReady(redis);

    assert.deepEqual(readCurrents([await count(store, key)]), [2]);
    assert.equal(await readCount(key), '2');
  });

  test('a command Redis refuses makes the store count in memory, and the failure is logged once in its window', async (t) => {
    const sink = createLogSink();
    const { redis } = testRedis.open({ logger: { level: 'info', stream: sink.stream } }, { label: 'Logged Redis' });

    t.after(() => redis.close());
    await waitUntilReady(redis);

    const store = openStore(redis);
    const key = createKey();

    await testRedis.admin.set(toRedisKey(key), 'not a number', 'PX', WINDOW_MS);

    const counted = await mapSeries([key, key], (name) => count(store, name));
    const failures = findLogLines(sink, COUNT_FAILED_MESSAGE);

    assert.deepEqual(readCurrents(counted), [1, 2]);
    assert.deepEqual(failures.map((line) => line.level), [LOG_LEVEL.ERROR]);
    assert.match(failures[0].err.message, /not an integer/);
    assert.equal(await readCount(key), 'not a number');
  });
});
