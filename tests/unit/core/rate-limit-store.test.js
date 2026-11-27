import { createLogger } from '#core/logger/index.js';
import { createLimitStore } from '#core/rate-limit/store.js';
import { createRedis } from '#core/redis/index.js';
import { timeIt } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { createFakeRedis, REDIS_DOWN_ENV, waitUntilReady } from '#root/tests/helper/redis.js';
import { mapSeries } from '#utils/async.js';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const NAMESPACE = 'rate-limit:';
const LABEL = 'Limit Redis';
const LOOPBACK = '127.0.0.1';

const MEMORY_MAX_ENTRIES = 100;
const WINDOW_MS = 1000;
const MAX = 2;
const CLOCK_START = 1_800_000_000_000;

// Counting in memory is far below this; waiting for a connection or a command is not.
const FAST_COUNT_MS = 200;

const KEY = 'ip:8.8.8.8';
const OTHER_KEY = 'ip:8.8.4.4';
const ITEMS_URL = '/api/v1/items';
const OTHER_URL = '/api/v1/other';

// What the plugin hands the store it builds: its own options, with the flags the limiter of the app sets.
const PLUGIN_PARAMS = Object.freeze({ continueExceeding: false, exponentialBackoff: false });

// The status of an ioredis client that nobody has told to connect.
const UNSTARTED_STATUS = 'wait';

// ioredis sends a script whole on the first call over a connection, and by its hash after that.
const SCRIPT_COMMANDS = Object.freeze(['eval', 'evalsha']);

const OPTIONS_MESSAGE = 'createLimitStore({ redis, namespace, memoryMaxEntries }) requires a client of createRedis(), a namespace and a ceiling of counters in memory';
const COUNT_FAILED_MESSAGE = 'Rate limit could not count in Redis: the process counts in memory';
const UNSTARTED_MESSAGE = `${LABEL} was never told to connect: nothing reaches it, call connect() in the entrypoint`;

function toEnv(port) {
  return { APP_REDIS_HOST: LOOPBACK, APP_REDIS_PORT: String(port) };
}

function openRedis(t, env = REDIS_DOWN_ENV) {
  const sink = createLogSink();
  const config = createTestConfig({ env, logger: { level: 'info', stream: sink.stream } });
  const { cache, ...main } = config.redis;
  const redis = createRedis(main, { log: createLogger(config.logger), label: LABEL });

  t.after(() => redis.close());

  return { redis, sink, keyPrefix: main.keyPrefix };
}

function openStore(t, { env, memoryMaxEntries = MEMORY_MAX_ENTRIES, params = PLUGIN_PARAMS } = {}) {
  const opened = openRedis(t, env);
  const LimitStore = createLimitStore({ redis: opened.redis, namespace: NAMESPACE, memoryMaxEntries });

  return { ...opened, LimitStore, store: new LimitStore(params) };
}

// What the plugin hands child(): its options merged with those of the route, which it names routeInfo.
function childOf(store, method, url) {
  return store.child({ ...PLUGIN_PARAMS, routeInfo: { method, url } });
}

// The plugin waits for the callback, never for incr() itself: what the callback gets is the answer.
function count(store, key, { timeWindow = WINDOW_MS, max = MAX } = {}) {
  return new Promise((resolve) => {
    store.incr(key, (...args) => resolve(args), timeWindow, max);
  });
}

function countEach(counters, key) {
  return mapSeries(counters, (counter) => count(counter, key));
}

function readCurrents(counted) {
  return counted.map(([error, result]) => (error === null
    ? result.current
    : error));
}

function freezeClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: CLOCK_START });
}

describe('createLimitStore', () => {
  test('refuses options without a client of createRedis(), a namespace and a positive ceiling of counters in memory', (t) => {
    const { redis } = openRedis(t);
    const valid = { redis, namespace: NAMESPACE, memoryMaxEntries: MEMORY_MAX_ENTRIES };
    const wrong = {
      'no options': undefined,
      'no client': { ...valid, redis: undefined },
      'an object without a client': { ...valid, redis: {} },
      'an empty namespace': { ...valid, namespace: '' },
      'a namespace that is no text': { ...valid, namespace: 5 },
      'no ceiling': { ...valid, memoryMaxEntries: undefined },
      'a ceiling of zero': { ...valid, memoryMaxEntries: 0 },
      'a ceiling that is not whole': { ...valid, memoryMaxEntries: 1.5 },
      'a ceiling as a text': { ...valid, memoryMaxEntries: '100' },
    };

    Object.entries(wrong).forEach(([name, options]) => {
      assert.throws(() => createLimitStore(options), { name: 'TypeError', message: OPTIONS_MESSAGE }, name);
    });
    assert.equal(typeof createLimitStore(valid), 'function');
  });

  test('refuses the client of ioredis itself, which has a client() command of its own', (t) => {
    const { redis } = openRedis(t);

    assert.throws(() => createLimitStore({ redis: redis.client, namespace: NAMESPACE, memoryMaxEntries: MEMORY_MAX_ENTRIES }), { name: 'TypeError', message: OPTIONS_MESSAGE });
  });
});

describe('createLimitStore: counting in memory while Redis is not ready', () => {
  test('with a client nobody started, counts each key in memory: 1, 2, 3 with what is left of the window as the ttl, and each key apart', async (t) => {
    freezeClock(t);

    const { store } = openStore(t);
    const first = await count(store, KEY);

    t.mock.timers.tick(300);

    const second = await count(store, KEY);
    const other = await count(store, OTHER_KEY);

    t.mock.timers.tick(200);

    const third = await count(store, KEY);

    assert.deepEqual([first, second, other, third], [
      [null, { current: 1, ttl: 1000 }],
      [null, { current: 2, ttl: 700 }],
      [null, { current: 1, ttl: 1000 }],
      [null, { current: 3, ttl: 500 }],
    ]);
  });

  test('starts the count of a key again once its window has ended: at its last millisecond the count goes on, at its end it is 1 with a whole window', async (t) => {
    freezeClock(t);

    const { store } = openStore(t);
    const first = await count(store, KEY);

    t.mock.timers.tick(WINDOW_MS - 1);

    const last = await count(store, KEY);

    t.mock.timers.tick(1);

    const next = await count(store, KEY);
    const after = await count(store, KEY);

    assert.deepEqual([first, last, next, after], [
      [null, { current: 1, ttl: 1000 }],
      [null, { current: 2, ttl: 1 }],
      [null, { current: 1, ttl: 1000 }],
      [null, { current: 2, ttl: 1000 }],
    ]);
  });

  test('takes continueExceeding of the plugin: false leaves the window of a key above max as it was, true starts it again', async (t) => {
    freezeClock(t);

    const kept = openStore(t).store;
    const restarted = openStore(t, { params: { ...PLUGIN_PARAMS, continueExceeding: true } }).store;

    await Promise.all([count(kept, KEY, { max: 1 }), count(restarted, KEY, { max: 1 })]);
    t.mock.timers.tick(300);

    const above = await Promise.all([count(kept, KEY, { max: 1 }), count(restarted, KEY, { max: 1 })]);

    assert.deepEqual(above, [
      [null, { current: 2, ttl: 700 }],
      [null, { current: 2, ttl: 1000 }],
    ]);
  });

  test('keeps at most memoryMaxEntries counters in memory: the key counted least recently goes first', async (t) => {
    const { store } = openStore(t, { memoryMaxEntries: 2 });
    const counted = await mapSeries(['ip:1.1.1.1', 'ip:2.2.2.2', 'ip:3.3.3.3', 'ip:2.2.2.2', 'ip:1.1.1.1'], (key) => count(store, key));

    assert.deepEqual(readCurrents(counted), [1, 1, 1, 2, 1]);
  });

  test('with a client that is started and cannot reach Redis, counts in memory as well, at once, and writes no line of its own', async (t) => {
    const { redis, store, sink } = openStore(t);

    redis.connect();

    const { result: counted, durationMs } = await timeIt(() => mapSeries([KEY, KEY, OTHER_KEY], (key) => count(store, key)));

    assert.equal(redis.isReady(), false);
    assert.ok(durationMs < FAST_COUNT_MS, `counted in ${durationMs} ms`);
    assert.deepEqual(readCurrents(counted), [1, 2, 1]);
    assert.deepEqual(counted.map(([, { ttl }]) => ttl > 0 && ttl <= WINDOW_MS), [true, true, true]);
    assert.deepEqual([findLogLines(sink, COUNT_FAILED_MESSAGE), findLogLines(sink, UNSTARTED_MESSAGE)], [[], []]);
  });

  test('never starts a client nobody started: Redis hears nothing, the client stays unstarted, and says once that it was never told to connect', async (t) => {
    const fake = await createFakeRedis(t);
    const { redis, store, sink } = openStore(t, { env: toEnv(fake.port) });
    const counted = await mapSeries([
      [store, KEY],
      [store, KEY],
      [childOf(store, 'GET', ITEMS_URL), KEY],
      [childOf(store, 'HEAD', ITEMS_URL), OTHER_KEY],
    ], ([counter, key]) => count(counter, key));

    assert.deepEqual(readCurrents(counted), [1, 2, 1, 1]);
    assert.deepEqual([redis.isStarted(), redis.client.status], [false, UNSTARTED_STATUS]);
    assert.deepEqual(fake.commands, []);
    assert.equal(findLogLines(sink, UNSTARTED_MESSAGE).length, 1);
  });
});

describe('createLimitStore: a client that is ready', () => {
  test('is asked for each count under its key prefix and the namespace, a child under the method and the path of its route, a HEAD child under its GET', async (t) => {
    const fake = await createFakeRedis(t);
    const { redis, store, keyPrefix } = openStore(t, { env: toEnv(fake.port) });

    redis.connect();
    await waitUntilReady(redis);
    await mapSeries([
      [store, KEY],
      [childOf(store, 'GET', ITEMS_URL), KEY],
      [childOf(store, 'HEAD', ITEMS_URL), OTHER_KEY],
    ], ([counter, key]) => count(counter, key));

    const scripts = fake.commands.filter(([name]) => SCRIPT_COMMANDS.includes(name.toLowerCase()));

    assert.deepEqual(scripts.map((args) => args.slice(2)), [
      ['1', `${keyPrefix}rate-limit:ip:8.8.8.8`, '1000', '2', 'false', 'false'],
      ['1', `${keyPrefix}rate-limit:GET /api/v1/items:ip:8.8.8.8`, '1000', '2', 'false', 'false'],
      ['1', `${keyPrefix}rate-limit:GET /api/v1/items:ip:8.8.4.4`, '1000', '2', 'false', 'false'],
    ]);
  });

  test('that refuses the command makes the store count in memory: the callback gets the count with no error, and the failure is logged once in its window', async (t) => {
    const fake = await createFakeRedis(t);
    const { redis, store, sink } = openStore(t, { env: toEnv(fake.port) });

    redis.connect();
    await waitUntilReady(redis);

    const counted = await mapSeries([KEY, KEY, OTHER_KEY], (key) => count(store, key));
    const failures = findLogLines(sink, COUNT_FAILED_MESSAGE);

    assert.deepEqual(readCurrents(counted), [1, 2, 1]);
    assert.deepEqual(failures.map((line) => [line.level, line.redis.address]), [[LOG_LEVEL.ERROR, redis.address]]);
    assert.match(failures[0].err.message, /unknown command/);
  });
});

describe('createLimitStore: the counters of a route', () => {
  test('a child of a route counts apart from the root and from the child of another method or another path', async (t) => {
    const { store } = openStore(t);
    const items = childOf(store, 'GET', ITEMS_URL);
    const counted = await countEach([store, items, items, childOf(store, 'POST', ITEMS_URL), childOf(store, 'GET', OTHER_URL), store], KEY);

    assert.deepEqual(readCurrents(counted), [1, 1, 2, 1, 1, 2]);
  });

  test('the HEAD twin of a GET route counts with its GET, in memory as in Redis: both read the one resource', async (t) => {
    const { store } = openStore(t);
    const items = childOf(store, 'GET', ITEMS_URL);
    const head = childOf(store, 'HEAD', ITEMS_URL);
    const counted = await countEach([items, head, items, head], KEY);

    assert.deepEqual(readCurrents(counted), [1, 2, 3, 4]);
  });

  test('is built by the plugin with new and asked for a child for each route with a limit of its own, which counts apart from the global limit', async (t) => {
    const { LimitStore } = openStore(t);
    const fastify = Fastify();

    t.after(() => fastify.close());
    await fastify.register(fastifyRateLimit, { store: LimitStore, max: 2, timeWindow: WINDOW_MS });
    fastify.get(ITEMS_URL, { config: { rateLimit: { max: 1, timeWindow: WINDOW_MS } } }, () => ({ isDone: true }));
    fastify.get(OTHER_URL, () => ({ isDone: true }));

    const responses = await mapSeries([ITEMS_URL, ITEMS_URL, OTHER_URL, OTHER_URL, OTHER_URL], (url) => fastify.inject(url));

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 429, 200, 200, 429]);
  });
});
