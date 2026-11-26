import {
  assertCacheTables,
  assertCacheTtl,
  deleteCache,
  invalidateCacheTables,
  readCache,
  watchCacheOutage,
  wrapCache,
  writeCache,
} from '#core/cache/index.js';
import { createContext, runInContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import { createRedis } from '#core/redis/index.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createTestConfig, PROCESS_KEY_PREFIX } from '#root/tests/helper/config.js';
import { createLogSink } from '#root/tests/helper/log.js';
import {
  createFakeRedis,
  createSilentServer,
  FAST_RECONNECT,
  REDIS_DOWN_ENV,
  RESP_OK,
  toRespArray,
  toRespBulk,
  toRespError,
  waitUntilReady,
} from '#root/tests/helper/redis.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

// Several reconnects of FAST_RECONNECT fit in it: a timer started again on every reconnect would never fire.
const OUTAGE = '0.5s';
const OUTAGE_MS = 500;
const PAST_OUTAGE_MS = 900;

// The millisecond clock of libuv floors the moment a timer starts at: a timer may fire a millisecond early.
const TIMER_SLACK_MS = 5;

// The handshake with a server that is silent ends at this, and the client tries again.
const SHORT_DEADLINES = Object.freeze({ ...FAST_RECONNECT, commandTimeout: '0.2s', socketTimeout: '0.2s' });

const UNSTARTED_MESSAGE = 'Cache Redis was never told to connect: nothing reaches it, call connect() in the entrypoint';
const SIGNATURE = 'test(cache)';
const RUN_A = 'a'.repeat(40);
const RUN_B = 'b'.repeat(40);
const QUEUED = `+QUEUED${String.fromCharCode(13, 10)}`;

class Sample {}

function toEnv(port) {
  return { APP_REDIS_HOST: '127.0.0.1', APP_REDIS_PORT: String(port) };
}

function openCache(t, { isRedis = true, env = REDIS_DOWN_ENV, redis: sections = FAST_RECONNECT } = {}) {
  const sink = createLogSink();
  const config = createTestConfig({
    env,
    redis: sections,
    logger: { level: 'debug', stream: sink.stream },
  });
  const { cache, ...main } = config.redis;
  const log = createLogger(config.logger);
  const redis = isRedis
    ? createRedis(main, { log, label: 'Cache Redis' })
    : null;
  const context = createContext({
    config,
    log,
    redis,
    cacheRedis: redis,
  });

  function run(fn) {
    return runInContext(context, fn);
  }

  t.after(() => redis?.close());

  return {
    config,
    log,
    redis,
    sink,
    run,
  };
}

function countCalls() {
  const calls = { count: 0 };

  function fn() {
    calls.count += 1;

    return { count: calls.count, at: new Date(0) };
  }

  return { calls, fn };
}

function watch(t, redis, log, { onOutage = () => true } = {}) {
  const outages = [];
  const recoveries = [];
  const watchdog = watchCacheOutage(redis, {
    after: OUTAGE,
    log,
    onOutage: (outage) => {
      outages.push(outage);

      return onOutage(outage);
    },
    onRecovery: (outage) => recoveries.push(outage),
  });

  t.after(() => watchdog.stop());

  return { outages, recoveries, watchdog };
}

// A Redis that can stop answering and start again: silent, it lets every handshake time out.
async function createSwitchableRedis(t) {
  const switchable = { isSilent: true };
  const fake = await createFakeRedis(t, () => (switchable.isSilent ? '' : null));

  function goDown() {
    switchable.isSilent = true;

    return fake.kill();
  }

  function goUp() {
    switchable.isSilent = false;

    return true;
  }

  return { port: fake.port, goDown, goUp };
}

// Keys and their values in memory, and the run id INFO gives: what the cache sends to read and write an entry.
function createStore(run) {
  const keys = new Map();

  function respond([name, ...args]) {
    if (name === 'info') {
      return toRespBulk(`# Server\r\nrun_id:${run.id}\r\nloading:0\r\n`);
    }

    if (name === 'get') {
      return toRespBulk(keys.get(args[0]) ?? null);
    }

    if (name === 'mget') {
      return toRespArray(args.map((key) => keys.get(key) ?? null));
    }

    if (name === 'set') {
      keys.set(args[0], args[1]);

      return RESP_OK;
    }

    return null;
  }

  return { keys, respond };
}

describe('cache: arguments', () => {
  test('requires a key, a function, a ttl above zero and table names', async (t) => {
    const { run } = openCache(t, { isRedis: false });

    await assert.rejects(run(() => readCache('')), /requires a key/);
    await assert.rejects(run(() => writeCache(1, 'value')), /requires a key/);
    await assert.rejects(run(() => writeCache('key', 'value', { ttl: '0s' })), /ttl above zero/);
    await assert.rejects(run(() => writeCache('key', 'value', { ttl: '5 min' })), /convertStringToMs/);
    await assert.rejects(run(() => deleteCache([])), /a key or a non-empty array of keys/);
    await assert.rejects(run(() => deleteCache(['key', ''])), /a key or a non-empty array of keys/);
    await assert.rejects(run(() => wrapCache('key', 'value')), /requires a function/);
    await assert.rejects(run(() => wrapCache('key', () => 1, { ttl: '0.0001s' })), /ttl above zero/);
    await assert.rejects(run(() => wrapCache('key', () => 1, { tables: [] })), /non-empty array of table names/);
    await assert.rejects(run(() => wrapCache('key', () => 1, { tables: 'users' })), /non-empty array of table names/);
    await assert.rejects(run(() => invalidateCacheTables(['users', ''])), /non-empty array of table names/);
    await assert.rejects(run(() => invalidateCacheTables()), /non-empty array of table names/);
  });

  test('a function refuses what the checkers of the cache refuse, by their message under its own name', async (t) => {
    const { run } = openCache(t, { isRedis: false });

    await assert.rejects(run(() => wrapCache('key', () => 1, { tables: ['users', 1] })), {
      name: 'TypeError',
      message: 'wrapCache(key, fn, { tables }) requires tables to be a non-empty array of table names',
    });
    await assert.rejects(run(() => writeCache('key', 'value', { ttl: '-1m' })), {
      name: 'TypeError',
      message: 'writeCache(key, value, { ttl }) requires a ttl above zero, such as "5m": a cache key is never written without one',
    });
  });

  test('invalidateCacheTables refuses what is not a list of table names by the message of the checker under its own name, before it looks for the tables a foreign key reaches', async (t) => {
    const { run } = openCache(t, { isRedis: false });
    const wrongTables = [undefined, 'users', { users: ['sessions'] }, new Set(['users']), [], ['users', 1], ['users', '']];

    await Promise.all(wrongTables.map((tables) => assert.rejects(run(() => invalidateCacheTables(tables)), {
      name: 'TypeError',
      message: 'invalidateCacheTables(tables) requires tables to be a non-empty array of table names',
    }, String(tables))));
  });

  test('refuses a value it cannot give back the same, whether there is a Redis or not', async (t) => {
    const withoutRedis = openCache(t, { isRedis: false });
    const withDownRedis = openCache(t);

    await Promise.all([withoutRedis, withDownRedis].map(async ({ run }) => {
      await assert.rejects(run(() => writeCache('key', new Map())), /cannot keep/);
      await assert.rejects(run(() => wrapCache('key', () => new Sample())), /cannot keep/);
      await assert.rejects(run(() => wrapCache('key', () => ({ list: [new Set()] }))), /cannot keep/);
      await assert.rejects(run(() => wrapCache('key', () => Object.assign([1], { total: 1 }))), /holes or with keys of its own/);
    }));
  });
});

describe('assertCacheTables and assertCacheTtl', () => {
  test('assertCacheTables takes a non-empty array of non-empty names, repeats among them, and names the caller in its refusal', () => {
    [['users'], ['users', 'groups', 'users']].forEach((tables) => {
      assert.doesNotThrow(() => assertCacheTables(tables, SIGNATURE), tables.join());
    });
    [undefined, null, 'users', {}, [], [''], ['users', 1], ['users', null]].forEach((tables, index) => {
      assert.throws(() => assertCacheTables(tables, SIGNATURE), {
        name: 'TypeError',
        message: `${SIGNATURE} requires tables to be a non-empty array of table names`,
      }, String(index));
    });
  });

  test('assertCacheTtl takes a duration above zero, refuses one that rounds to zero, and names the caller in its refusal', () => {
    ['0.001s', '5m', '1d'].forEach((ttl) => assert.doesNotThrow(() => assertCacheTtl(ttl, SIGNATURE), ttl));
    ['0s', '0.0001s', '-1m'].forEach((ttl) => {
      assert.throws(() => assertCacheTtl(ttl, SIGNATURE), {
        name: 'TypeError',
        message: `${SIGNATURE} requires a ttl above zero, such as "5m": a cache key is never written without one`,
      }, ttl);
    });
    [undefined, '5 min', 5].forEach((ttl) => {
      assert.throws(() => assertCacheTtl(ttl, SIGNATURE), /convertStringToMs\(value\) requires a number with a unit/, String(ttl));
    });
  });
});

describe('cache: without a cache Redis that is up', () => {
  test('without a cache Redis in the context every call runs fn and nothing is read or written', async (t) => {
    const { run } = openCache(t, { isRedis: false });
    const { calls, fn } = countCalls();

    const first = await run(() => wrapCache('key', fn, { tables: ['users'] }));
    const second = await run(() => wrapCache('key', fn));

    assert.deepEqual([first.count, second.count, calls.count], [1, 2, 2]);
    assert.equal(await run(() => readCache('key')), undefined);
    assert.equal(await run(() => writeCache('key', 'value')), false);
    assert.equal(await run(() => deleteCache('key')), false);
    assert.equal(await run(() => invalidateCacheTables(['users'])), false);
  });

  test('with a cache Redis that was never started it is a no-op that asks Redis nothing, and says so once', async (t) => {
    const { run, redis, sink } = openCache(t);
    const { calls, fn } = countCalls();

    const results = await Promise.all(Array.from({ length: 5 }, () => run(() => wrapCache('key', fn, { tables: ['users'] }))));

    assert.equal(calls.count, 5);
    assert.ok(results.every((result) => result.at instanceof Date));
    assert.equal(await run(() => readCache('key')), undefined);
    assert.equal(await run(() => writeCache('key', 'value')), false);
    assert.equal(await run(() => invalidateCacheTables(['users'])), false);
    assert.equal(redis.client.status, 'wait');
    assert.deepEqual(sink.lines.map((line) => line.msg), [UNSTARTED_MESSAGE]);
  });

  test('gives back a copy of what fn returned, also without the cache: a hit and a miss have one shape', async (t) => {
    const { run } = openCache(t, { isRedis: false });
    const value = { createdAt: new Date(5), hash: Buffer.from('ab'), big: 1n };

    const result = await run(() => wrapCache('key', () => value));

    assert.deepStrictEqual(result, value);
    assert.notEqual(result, value);
    assert.notEqual(result.createdAt, value.createdAt);
  });
});

describe('watchCacheOutage', () => {
  test('requires a client of createRedis(), a duration above zero, a logger and two callbacks', (t) => {
    const { redis, log } = openCache(t);
    const callbacks = { onOutage: () => {}, onRecovery: () => {} };

    assert.throws(() => watchCacheOutage(null, { after: '1m', log, ...callbacks }), /requires a client of createRedis/);
    assert.throws(() => watchCacheOutage(redis.client, { after: '1m', log, ...callbacks }), /requires a client of createRedis/);
    assert.throws(() => watchCacheOutage(redis, { after: '0s', log, ...callbacks }), /above zero/);
    assert.throws(() => watchCacheOutage(redis, { after: '1m', ...callbacks }), /requires a client of createRedis/);
    assert.throws(() => watchCacheOutage(redis, { after: '1m', log, onOutage: () => {} }), /requires a client of createRedis/);
  });

  test('does not count a client that was never told to connect as down', async (t) => {
    const { redis, log } = openCache(t);
    const { outages } = watch(t, redis, log);

    await sleep(PAST_OUTAGE_MS);

    assert.deepEqual(outages, []);
  });

  test('reports a cache Redis that stays down once, across many reconnects', async (t) => {
    const { redis, log, sink } = openCache(t);
    const reconnectsBeforeReport = [];

    function countReconnects() {
      return sink.lines.filter((line) => line.msg === 'Cache Redis is still not reachable').length;
    }

    const { outages } = watch(t, redis, log, {
      onOutage: () => {
        reconnectsBeforeReport.push(countReconnects());

        return true;
      },
    });

    redis.connect();
    await waitFor(() => outages.length === 1, 'the outage');
    await sleep(PAST_OUTAGE_MS);

    assert.ok(reconnectsBeforeReport[0] >= 3, `${reconnectsBeforeReport[0]} reconnects before the report`);
    assert.equal(outages.length, 1);
    assert.equal(outages[0].address, redis.address);
    assert.ok(outages[0].downMs >= OUTAGE_MS - TIMER_SLACK_MS, `${outages[0].downMs} ms`);
  });

  test('reports a server that takes connections and never answers', async (t) => {
    const server = await createSilentServer(t);
    const { redis, log } = openCache(t, { env: { APP_REDIS_HOST: '127.0.0.1', APP_REDIS_PORT: String(server.port) } });
    const { outages } = watch(t, redis, log);

    redis.connect();

    await waitFor(() => outages.length === 1, 'the outage to be reported');
  });

  test('reports again "after" later when the report was not delivered', async (t) => {
    const { redis, log } = openCache(t);
    const { outages } = watch(t, redis, log, { onOutage: () => false });

    redis.connect();
    await waitFor(() => outages.length >= 2, 'a second report');

    assert.ok(outages[1].downMs - outages[0].downMs >= OUTAGE_MS - TIMER_SLACK_MS, JSON.stringify(outages));
  });

  test('stop() takes its listener and its timer away', async (t) => {
    const { redis, log } = openCache(t);
    const { outages, watchdog } = watch(t, redis, log);

    redis.connect();
    await waitFor(() => redis.client.status === 'reconnecting', 'the client to retry');
    watchdog.stop();
    await sleep(PAST_OUTAGE_MS);

    assert.deepEqual(outages, []);
  });

  test('logs a callback that throws or rejects instead of letting it out of the timer, and does not call it again', async (t) => {
    const { redis, log, sink } = openCache(t);

    watch(t, redis, log, { onOutage: async () => { throw new Error('alert failed'); } });
    redis.connect();

    const failed = await waitFor(() => sink.lines.find((line) => line.msg === 'A cache outage callback failed'), 'the failure to be logged');

    await sleep(PAST_OUTAGE_MS);

    assert.equal(failed.err.message, 'alert failed');
    assert.equal(sink.lines.filter((line) => line.msg === 'A cache outage callback failed').length, 1);
  });
});

describe('watchCacheOutage: recovery', () => {
  async function openSwitchable(t) {
    const switchable = await createSwitchableRedis(t);
    const opened = openCache(t, { env: toEnv(switchable.port), redis: SHORT_DEADLINES });

    return { ...opened, switchable };
  }

  test('reports the recovery once after a reported outage, with the time it was down', async (t) => {
    const { redis, log, switchable } = await openSwitchable(t);
    const { outages, recoveries } = watch(t, redis, log);

    redis.connect();
    await waitFor(() => outages.length === 1, 'the outage');
    switchable.goUp();
    await waitFor(() => recoveries.length === 1, 'the recovery');
    await sleep(OUTAGE_MS);

    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0].address, redis.address);
    assert.ok(recoveries[0].downMs >= OUTAGE_MS - TIMER_SLACK_MS, `${recoveries[0].downMs} ms`);
  });

  test('reports nothing for an outage shorter than "after"', async (t) => {
    const { redis, log, switchable } = await openSwitchable(t);
    const { outages, recoveries } = watch(t, redis, log);

    switchable.goUp();
    redis.connect();
    await waitUntilReady(redis);
    switchable.goDown();
    await waitFor(() => !redis.isReady(), 'the client to lose its connection');
    switchable.goUp();
    await waitUntilReady(redis);
    await sleep(PAST_OUTAGE_MS);

    assert.deepEqual([outages, recoveries], [[], []]);
  });

  test('reports the recovery of an outage that ends while its report is still being sent, once the report has gone out', async (t) => {
    const { redis, log, switchable } = await openSwitchable(t);
    const held = Promise.withResolvers();
    const { outages, recoveries } = watch(t, redis, log, { onOutage: () => held.promise });

    redis.connect();
    await waitFor(() => outages.length === 1, 'the report to start');
    switchable.goUp();
    await waitUntilReady(redis);

    assert.deepEqual(recoveries, []);

    held.resolve(true);

    await waitFor(() => recoveries.length === 1, 'the recovery');
  });

  test('neither retries nor reports the recovery of an outage that ended while a report that did not go out was sent', async (t) => {
    const { redis, log, switchable } = await openSwitchable(t);
    const held = Promise.withResolvers();
    const { outages, recoveries } = watch(t, redis, log, { onOutage: () => held.promise });

    redis.connect();
    await waitFor(() => outages.length === 1, 'the report to start');
    switchable.goUp();
    await waitUntilReady(redis);
    switchable.goDown();
    await waitFor(() => !redis.isReady(), 'the client to lose its connection again');
    switchable.goUp();
    await waitUntilReady(redis);
    held.resolve(false);
    await sleep(OUTAGE_MS + PAST_OUTAGE_MS);

    assert.equal(outages.length, 1);
    assert.deepEqual(recoveries, []);
  });

  test('reports nothing after stop()', async (t) => {
    const { redis, log, switchable } = await openSwitchable(t);
    const { outages, recoveries, watchdog } = watch(t, redis, log);

    redis.connect();
    await waitFor(() => outages.length === 1, 'the outage');
    watchdog.stop();
    switchable.goUp();
    await waitUntilReady(redis);
    switchable.goDown();
    await sleep(PAST_OUTAGE_MS);

    assert.equal(outages.length, 1);
    assert.deepEqual(recoveries, []);
  });

  test('takes an outage that comes back while its report is still being sent for the same one: one report, then one recovery with the time of the whole outage', async (t) => {
    const { redis, log, switchable } = await openSwitchable(t);
    const held = Promise.withResolvers();
    const { outages, recoveries } = watch(t, redis, log, { onOutage: () => held.promise });

    redis.connect();
    await waitFor(() => outages.length === 1, 'the report to start');
    switchable.goUp();
    await waitUntilReady(redis);
    switchable.goDown();
    await waitFor(() => !redis.isReady(), 'the client to lose its connection again');
    held.resolve(true);
    await sleep(PAST_OUTAGE_MS);

    assert.equal(outages.length, 1);
    assert.deepEqual(recoveries, []);

    switchable.goUp();

    await waitFor(() => recoveries.length === 1, 'the recovery');

    assert.ok(recoveries[0].downMs >= outages[0].downMs + PAST_OUTAGE_MS - TIMER_SLACK_MS, JSON.stringify([outages, recoveries]));
  });
});

describe('cache: bumps that failed', () => {
  // The reads start in one tick, each before any reply comes back: the retry of the first is in flight for the others.
  test('are tried again by one retry at a time, however many reads start one side by side', async (t) => {
    const store = createStore({ id: RUN_A });

    function respond(args) {
      const [name] = args;

      if (name === 'exec') {
        return toRespError('OOM command not allowed when used memory > maxmemory');
      }

      if (name === 'multi') {
        return RESP_OK;
      }

      return name === 'incr' || (name === 'set' && args.includes('NX'))
        ? QUEUED
        : store.respond(args);
    }

    const fake = await createFakeRedis(t, respond);
    const { redis, run } = openCache(t, { env: toEnv(fake.port), redis: { ...FAST_RECONNECT, commandTimeout: '0.3s' } });
    const { calls, fn } = countCalls();

    store.keys.set(`${PROCESS_KEY_PREFIX}table-version:pending`, '5');
    store.keys.set(`${PROCESS_KEY_PREFIX}table-version:other`, '7');
    redis.connect();
    await waitUntilReady(redis);

    assert.equal(await run(() => invalidateCacheTables(['pending'])), false);

    const multisBefore = fake.commands.filter(([name]) => name === 'multi').length;

    await Promise.all(Array.from({ length: 5 }, (item, index) => run(() => wrapCache(`other-${index}`, fn, { tables: ['other'] }))));

    assert.equal(calls.count, 5);
    assert.equal(fake.commands.filter(([name]) => name === 'multi').length, multisBefore + 1);
  });
});

describe('cache: the run of the server', () => {
  function countServerReads(fake) {
    return fake.commands.filter(([name, section]) => name === 'info' && section === 'server').length;
  }

  test('reads it once for each connection, and a new run makes every entry read through versions a miss', async (t) => {
    const run = { id: RUN_A };
    const store = createStore(run);
    const fake = await createFakeRedis(t, store.respond);
    const { redis, run: runInCache } = openCache(t, { env: toEnv(fake.port) });
    const { calls, fn } = countCalls();

    store.keys.set(`${PROCESS_KEY_PREFIX}table-version:users`, '5');
    redis.connect();
    await waitUntilReady(redis);

    await runInCache(() => wrapCache('list', fn, { tables: ['users'] }));
    await runInCache(() => wrapCache('list', fn, { tables: ['users'] }));

    assert.equal(calls.count, 1);
    assert.equal(countServerReads(fake), 1);

    const reconnects = { count: 0 };

    redis.client.on('ready', () => {
      reconnects.count += 1;
    });
    run.id = RUN_B;
    fake.kill();
    await waitFor(() => reconnects.count === 1, 'the reconnect');

    await runInCache(() => wrapCache('list', fn, { tables: ['users'] }));
    await runInCache(() => wrapCache('list', fn, { tables: ['users'] }));

    assert.equal(calls.count, 2);
    assert.equal(countServerReads(fake), 2);
  });
});
