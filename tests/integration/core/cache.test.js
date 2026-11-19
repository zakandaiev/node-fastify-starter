import {
  deleteCache,
  invalidateCacheTables,
  readCache,
  wrapCache,
  writeCache,
} from '#core/cache/index.js';
import { createContext, runInContext } from '#core/context/index.js';
import { withTransaction } from '#core/db/transaction.js';
import { timeIt, waitFor } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import {
  createAclUser,
  createTcpProxy,
  createTestRedis,
  FAST_RECONNECT,
  waitUntilReady,
} from '#root/tests/helper/redis.js';
import { getServiceAddress } from '#root/tests/helper/service.js';
import { convertStringToMs } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import { SERIALIZED_FORMAT } from '#utils/serialize.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const testRedis = await createTestRedis();
const testDb = await createTestDb();

const PARALLEL_MISSES = 50;
const COMMAND_TIMEOUT_MS = 300;
const TTL = '1m';
const TTL_MS = 60000;
const TTL_SLACK_MS = 5000;
const RETRY_WINDOW_PASSED_MS = 150;
const REQUEST_ID = 'request-1';

// A held function that a regression never lets go of fails the test at this, instead of holding the run for ever.
const HANG_TIMEOUT_MS = 5000;

// A deadline per command, and a socket that is never given up within a test: every operation meets a frozen Redis
// that still looks ready.
const HANG_DEADLINES = Object.freeze({ ...FAST_RECONNECT, commandTimeout: '0.3s', socketTimeout: '30s' });
const RECONNECT_DEADLINES = Object.freeze({ ...FAST_RECONNECT, commandTimeout: '0.3s', socketTimeout: '0.6s' });

const CORRUPT_MESSAGE = 'Cache entry cannot be read: it is taken for a miss and written again';
const BUMP_FAILED_MESSAGE = 'Cache could not bump the version of a table: it tries again, and reads of the table go to the database meanwhile';
const TAG = String.fromCharCode(0);

let nameCount = 0;

// A key or a table no other test of the file uses: the entries of one test must not answer the next.
function nextName(name) {
  nameCount += 1;

  return `${name}_${nameCount}`;
}

function countCalls(produce = (count) => ({ count })) {
  const calls = { count: 0 };

  async function fn() {
    calls.count += 1;

    return produce(calls.count);
  }

  return { calls, fn };
}

// A function the test lets go of: no sleeps decide the order of what runs side by side.
function createHeld(value) {
  const { promise, resolve } = Promise.withResolvers();
  const started = Promise.withResolvers();
  const calls = { count: 0 };

  async function fn() {
    calls.count += 1;
    started.resolve();
    await promise;

    return value;
  }

  return {
    calls, fn, release: resolve, started: started.promise,
  };
}

function readVersion(table) {
  return testRedis.admin.get(`${testRedis.keyPrefix}table-version:${table}`);
}

function toEntryKey(config, key) {
  return `${testRedis.keyPrefix}cache:${config.app.version}:${SERIALIZED_FORMAT}:${key}`;
}

async function readCacheKeys() {
  const keys = await testRedis.readKeys();

  return keys.filter((key) => key.startsWith(`${testRedis.keyPrefix}cache:`));
}

// The cache of the file, ready, with a log the test can read. Inside run() the lines carry the id of a request.
async function openCache(sections = {}) {
  const sink = createLogSink();
  const opened = testRedis.open({ ...sections, logger: { level: 'info', stream: sink.stream } }, {
    contextLog: (log) => log.child({ requestId: REQUEST_ID }),
  });

  await waitUntilReady(opened.redis);

  return { ...opened, sink };
}

async function openProxiedCache(t, deadlines) {
  const proxy = await createTcpProxy(t, getServiceAddress('redis'));
  const opened = await openCache({ env: proxy.env, redis: deadlines });

  t.after(() => opened.redis.close());

  return { ...opened, proxy };
}

describe('cache on a Redis', { skip: testRedis.skip }, () => {
  test('50 misses of one key at once call fn once, and every caller gets a copy of its own', async () => {
    const { run } = await openCache();
    const key = nextName('parallel');
    const table = nextName('parallel');
    const held = createHeld({ rows: [{ id: 1, createdAt: new Date(0) }] });

    await run(() => invalidateCacheTables([table]));

    const waiting = Promise.all(Array.from({ length: PARALLEL_MISSES }, () => run(() => wrapCache(key, held.fn, { tables: [table] }))));

    await held.started;
    held.release();

    const results = await waiting;

    results[0].rows[0].id = 99;

    assert.equal(held.calls.count, 1);
    assert.ok(results.slice(1).every((result) => result.rows[0].id === 1 && result.rows[0].createdAt instanceof Date));
    assert.equal(new Set(results).size, PARALLEL_MISSES);
  });

  test('a hit gives back the shape of the miss: a Date, a Buffer, a BigInt, undefined, -0 and null', async () => {
    const { run } = await openCache();
    const key = nextName('shape');
    const value = {
      createdAt: new Date('2026-11-19T10:00:00.123Z'),
      hash: Buffer.from([0, 255]),
      big: 2n ** 70n,
      missing: undefined,
      minusZero: -0,
      note: null,
      rows: [{ id: 'a', tags: ['x'] }],
    };
    const { calls, fn } = countCalls(() => value);

    const miss = await run(() => wrapCache(key, fn));
    const hit = await run(() => wrapCache(key, fn));

    assert.equal(calls.count, 1);
    assert.deepStrictEqual(miss, value);
    assert.deepStrictEqual(hit, miss);
    assert.notEqual(hit, miss);
  });

  test('a value the cache cannot keep fails with Redis up as it fails without it', async () => {
    const { run } = await openCache();

    await assert.rejects(run(() => wrapCache(nextName('map'), () => new Map())), /cannot keep/);
    await assert.rejects(run(() => writeCache(nextName('map'), new Set())), /cannot keep/);
  });

  test('every cache key is written with a TTL, and table-version keys never get one', async () => {
    const { run } = await openCache();
    const table = nextName('ttl');

    await run(() => invalidateCacheTables([table]));
    await run(() => wrapCache(nextName('ttl'), () => 1, { ttl: TTL, tables: [table] }));
    await run(() => wrapCache(nextName('ttl'), () => 2));
    await run(() => writeCache(nextName('ttl'), 3));

    const cacheKeys = await readCacheKeys();
    const cacheTtls = await Promise.all(cacheKeys.map((key) => testRedis.admin.pttl(key)));

    assert.ok(cacheKeys.length >= 3);
    assert.ok(cacheTtls.every((ttl) => ttl > 0), JSON.stringify(cacheTtls));
    assert.equal(await testRedis.admin.ttl(`${testRedis.keyPrefix}table-version:${table}`), -1);
  });

  test('the TTL of a write is the one asked for, and the default of the config without one', async () => {
    const { run, config } = await openCache();
    const asked = nextName('ttl');
    const defaulted = nextName('ttl');
    const defaultTtlMs = convertStringToMs(config.cache.defaultTtl);

    await run(() => writeCache(asked, 'a', { ttl: TTL }));
    await run(() => writeCache(defaulted, 'b'));

    const [askedTtl, defaultTtl] = await Promise.all([asked, defaulted].map((key) => testRedis.admin.pttl(toEntryKey(config, key))));

    assert.ok(askedTtl > TTL_MS - TTL_SLACK_MS && askedTtl <= TTL_MS, String(askedTtl));
    assert.ok(defaultTtl > defaultTtlMs - TTL_SLACK_MS && defaultTtl <= defaultTtlMs, String(defaultTtl));
  });

  test('a version starts from the clock and moves by one for each bump; a list that repeats a table bumps it once', async () => {
    const { run } = await openCache();
    const table = nextName('versions');
    const before = Date.now() * 1000;

    await run(() => invalidateCacheTables([table]));

    const first = Number(await readVersion(table));

    await run(() => invalidateCacheTables([table, table]));

    assert.ok(first > before, `${first} after ${before}`);
    assert.equal(Number(await readVersion(table)), first + 1);
  });

  test('a read of a table that has no version yet goes to the database once, caches nothing and starts the version', async () => {
    const { run } = await openCache();
    const key = nextName('fresh');
    const table = nextName('fresh');
    const { calls, fn } = countCalls();
    const entriesBefore = (await readCacheKeys()).length;

    await run(() => wrapCache(key, fn, { tables: [table] }));

    assert.notEqual(await readVersion(table), null);
    assert.equal((await readCacheKeys()).length, entriesBefore);

    await run(() => wrapCache(key, fn, { tables: [table] }));
    await run(() => wrapCache(key, fn, { tables: [table] }));

    assert.equal(calls.count, 2);
    assert.equal((await readCacheKeys()).length, entriesBefore + 1);
  });

  test('a bump of a table makes the next read run fn again; other tables and the order of the list do not matter', async () => {
    const { run } = await openCache();
    const key = nextName('versions');
    const otherKey = nextName('versions');
    const users = nextName('users');
    const groups = nextName('groups');
    const { calls, fn } = countCalls();

    await run(() => invalidateCacheTables([users, groups]));
    await run(() => wrapCache(key, fn, { tables: [users, groups] }));
    await run(() => wrapCache(key, fn, { tables: [groups, users, users] }));
    assert.equal(calls.count, 1);

    await run(() => invalidateCacheTables([users]));

    const fresh = await run(() => wrapCache(key, fn, { tables: [users, groups] }));
    const other = await run(() => wrapCache(otherKey, fn, { tables: [groups] }));

    await run(() => invalidateCacheTables([users]));

    const otherAgain = await run(() => wrapCache(otherKey, fn, { tables: [groups] }));

    assert.deepEqual([fresh.count, other.count, otherAgain.count], [2, 3, 3]);
  });

  test('a value fn computes while a write bumps the version lands under the old version: the next read runs fn again', async () => {
    const { run } = await openCache();
    const key = nextName('race');
    const table = nextName('race');
    let isFirst = true;

    async function fn() {
      if (isFirst) {
        isFirst = false;
        await invalidateCacheTables([table]);

        return 'before the write';
      }

      return 'after the write';
    }

    await run(() => invalidateCacheTables([table]));

    assert.equal(await run(() => wrapCache(key, fn, { tables: [table] })), 'before the write');
    assert.equal(await run(() => wrapCache(key, fn, { tables: [table] })), 'after the write');
  });

  test('a caller that comes after a bump does not join the read that started before it', { timeout: HANG_TIMEOUT_MS }, async () => {
    const { run } = await openCache();
    const key = nextName('join');
    const table = nextName('join');
    const before = createHeld('before the write');

    await run(() => invalidateCacheTables([table]));

    const first = run(() => wrapCache(key, before.fn, { tables: [table] }));

    await before.started;
    await run(() => invalidateCacheTables([table]));

    const second = await run(() => wrapCache(key, () => 'after the write', { tables: [table] }));

    before.release();

    assert.deepEqual([await first, second], ['before the write', 'after the write']);
  });

  test('when fn rejects, every caller that joined it rejects with the same error, nothing is written, and the next call runs fn again', { timeout: HANG_TIMEOUT_MS }, async () => {
    const { run, config } = await openCache();
    const key = nextName('reject');
    const held = createHeld(null);
    const failure = new Error('database failed');

    async function fn() {
      await held.fn();

      throw failure;
    }

    const callers = Array.from({ length: 3 }, () => run(() => wrapCache(key, fn)));

    await held.started;
    held.release();

    const results = await Promise.allSettled(callers);

    assert.ok(results.every((result) => result.status === 'rejected' && result.reason === failure));
    assert.equal(held.calls.count, 1);
    assert.equal(await testRedis.admin.exists(toEntryKey(config, key)), 0);
    assert.equal(await run(() => wrapCache(key, () => 'computed again')), 'computed again');
  });

  test('corrupt data in a key is a miss: fn runs and the entry is written again, and the stored text stays out of the log', async () => {
    const { run, sink, config } = await openCache();
    const key = nextName('corrupt');
    const marker = `marker-${uuidv7()}`;
    const { calls, fn } = countCalls();
    const corrupt = [`{"email":"${marker}`, JSON.stringify({ [TAG]: ['nope'] }), JSON.stringify({ [`${TAG}x`]: 1 })];

    await Promise.all(corrupt.map(async (text, index) => {
      const ownKey = `${key}:${index}`;

      await testRedis.admin.set(toEntryKey(config, ownKey), text, 'PX', TTL_MS);
      assert.equal(await run(() => readCache(ownKey)), undefined);
    }));

    await testRedis.admin.set(toEntryKey(config, key), 'not json', 'PX', TTL_MS);

    const result = await run(() => wrapCache(key, fn));

    assert.deepEqual(result, { count: 1 });
    assert.equal(calls.count, 1);
    assert.deepEqual(await run(() => readCache(key)), { count: 1 });
    assert.ok(await testRedis.admin.pttl(toEntryKey(config, key)) > 0);
    assert.equal(sink.lines.filter((line) => line.msg === CORRUPT_MESSAGE).length, corrupt.length + 1);
    assert.equal(JSON.stringify(sink.lines).includes(marker), false);
  });

  test('readCache, writeCache and deleteCache keep and drop plain keys', async () => {
    const { run } = await openCache();
    const first = nextName('plain');
    const second = nextName('plain');

    assert.equal(await run(() => writeCache(first, { at: new Date(7) })), true);
    assert.equal(await run(() => writeCache(second, [1, 2])), true);
    assert.deepStrictEqual(await run(() => readCache(first)), { at: new Date(7) });

    assert.equal(await run(() => deleteCache(first)), true);
    assert.equal(await run(() => readCache(first)), undefined);
    assert.equal(await run(() => deleteCache([second, nextName('absent')])), true);
    assert.equal(await run(() => readCache(second)), undefined);
  });

  test('an entry of another release is not read: the version of the app is in its name', async () => {
    const current = await openCache();
    const next = await openCache({ app: { ...current.config.app, version: '99.0.0' } });
    const key = nextName('release');

    await current.run(() => writeCache(key, 'of this release'));

    assert.equal(await next.run(() => readCache(key)), undefined);
    assert.equal(await current.run(() => readCache(key)), 'of this release');
  });

  test('two prefixes on one Redis do not see each other: neither the entries nor the versions', async () => {
    const own = await openCache();
    const other = await openCache({ redis: { keyPrefix: `${testRedis.keyPrefix}other:` } });
    const key = nextName('prefix');
    const table = nextName('prefix');

    await own.run(() => writeCache(key, 'own'));
    await own.run(() => invalidateCacheTables([table]));

    assert.equal(await other.run(() => readCache(key)), undefined);
    assert.equal(await testRedis.admin.get(`${testRedis.keyPrefix}other:table-version:${table}`), null);
  });
});

describe('cache on a Redis that fails', { skip: testRedis.skip }, () => {
  test('a Redis that hangs: every operation gives up within one commandTimeout, and wrapCache gives what fn gives', async (t) => {
    const { run, proxy } = await openProxiedCache(t, HANG_DEADLINES);
    const plainKey = nextName('hang');
    const table = nextName('hang');

    await run(() => invalidateCacheTables([table]));
    await run(() => wrapCache(plainKey, () => 'cached'));
    proxy.freeze();
    t.after(() => proxy.thaw());

    const operations = [
      ['wrapCache', () => wrapCache(plainKey, () => 'computed'), 'computed'],
      ['wrapCache with tables', () => wrapCache(nextName('hang'), () => 'computed', { tables: [table] }), 'computed'],
      ['readCache', () => readCache(plainKey), undefined],
      ['writeCache', () => writeCache(nextName('hang'), 'value'), false],
      ['deleteCache', () => deleteCache(plainKey), false],
      ['invalidateCacheTables', () => invalidateCacheTables([nextName('hang')]), false],
      ['wrapCache with tables after a failed bump', () => wrapCache(nextName('hang'), () => 'computed', { tables: [table] }), 'computed'],
    ];
    const timings = await operations.reduce(async (previous, [name, operation, expected]) => {
      const done = await previous;
      const { result, durationMs } = await timeIt(() => run(operation));

      assert.deepEqual(result, expected, name);

      return [...done, [name, Math.round(durationMs)]];
    }, Promise.resolve([]));

    timings.forEach(([name, durationMs]) => {
      assert.ok(durationMs >= COMMAND_TIMEOUT_MS - 5 && durationMs < 1.5 * COMMAND_TIMEOUT_MS, `${name}: ${durationMs} ms`);
    });
  });

  test('a bump that failed is made as soon as the cache Redis is back, outside any request', async (t) => {
    const { run, proxy, redis } = await openProxiedCache(t, RECONNECT_DEADLINES);
    const table = nextName('pending');

    await run(() => invalidateCacheTables([table]));

    const before = Number(await readVersion(table));

    proxy.freeze();
    assert.equal(await run(() => invalidateCacheTables([table])), false);
    proxy.kill();
    proxy.thaw();
    await waitUntilReady(redis);

    await waitFor(async () => Number(await readVersion(table)) === before + 1, 'the bump to be made after the reconnect');
  });

  // The bump the frozen connection held reaches Redis on the thaw, and the retry the next read starts makes one more.
  test('a bump that failed on a connection that stayed up is made again by the next read, which goes to the database meanwhile', async (t) => {
    const { run, proxy } = await openProxiedCache(t, HANG_DEADLINES);
    const key = nextName('pending');
    const table = nextName('pending');
    const { fn } = countCalls();

    await run(() => invalidateCacheTables([table]));

    const before = Number(await readVersion(table));

    await run(() => wrapCache(key, fn, { tables: [table] }));
    proxy.freeze();
    assert.equal(await run(() => invalidateCacheTables([table])), false);
    proxy.thaw();

    assert.equal((await run(() => wrapCache(key, fn, { tables: [table] }))).count, 2);

    await waitFor(async () => Number(await readVersion(table)) === before + 2, 'the bump of the retry');

    assert.equal((await run(() => wrapCache(key, fn, { tables: [table] }))).count, 3);
    assert.equal((await run(() => wrapCache(key, fn, { tables: [table] }))).count, 3);
    assert.equal(proxy.countConnections(), 1);
  });

  test('a table whose version refuses its bump goes on being read from the database, the other tables of the write do not', async () => {
    const { run } = await openCache();
    const poisoned = nextName('poisoned');
    const healthy = nextName('healthy');
    const poisonedKey = nextName('poisoned');
    const healthyKey = nextName('healthy');
    const { calls, fn } = countCalls();

    await run(() => invalidateCacheTables([poisoned, healthy]));

    const healthyBefore = Number(await readVersion(healthy));

    await testRedis.admin.set(`${testRedis.keyPrefix}table-version:${poisoned}`, 'not a number');

    assert.equal(await run(() => invalidateCacheTables([poisoned, healthy])), false);
    assert.equal(Number(await readVersion(healthy)), healthyBefore + 1);

    const readsOfPoisoned = [await run(() => wrapCache(poisonedKey, fn, { tables: [poisoned] })), await run(() => wrapCache(poisonedKey, fn, { tables: [poisoned] }))];
    const readsOfHealthy = [await run(() => wrapCache(healthyKey, fn, { tables: [healthy] })), await run(() => wrapCache(healthyKey, fn, { tables: [healthy] }))];

    assert.deepEqual(readsOfPoisoned.map((result) => result.count), [1, 2]);
    assert.deepEqual(readsOfHealthy.map((result) => result.count), [3, 3]);
    assert.equal(calls.count, 3);
    assert.equal(Number(await readVersion(healthy)), healthyBefore + 1);
  });

  // The retry after the reconnect runs where ioredis emits "ready", with no request around it: it must log with
  // the logger of the client and neither throw nor reject.
  test('a bump whose retry fails again after a reconnect is logged outside any request, and the process goes on', async (t) => {
    const {
      run, proxy, redis, sink,
    } = await openProxiedCache(t, { ...RECONNECT_DEADLINES, failureLogWindow: '0.1s' });
    const table = nextName('poisoned');
    const failures = [];

    function recordFailure(error) {
      failures.push(error);
    }

    process.on('unhandledRejection', recordFailure);
    process.on('uncaughtException', recordFailure);
    t.after(() => {
      process.off('unhandledRejection', recordFailure);
      process.off('uncaughtException', recordFailure);
    });

    await run(() => invalidateCacheTables([table]));
    await testRedis.admin.set(`${testRedis.keyPrefix}table-version:${table}`, 'not a number');
    assert.equal(await run(() => invalidateCacheTables([table])), false);
    await sleep(RETRY_WINDOW_PASSED_MS);

    proxy.kill();
    await waitUntilReady(redis);

    const [inRequest, outsideRequest] = await waitFor(() => {
      const lines = findLogLines(sink, BUMP_FAILED_MESSAGE);

      return lines.length >= 2 && lines;
    }, 'the retry to be logged');

    assert.deepEqual(failures, []);
    assert.equal(inRequest.requestId, REQUEST_ID);
    assert.equal(outsideRequest.requestId, undefined);
    assert.match(outsideRequest.err.message, /not an integer/);
  });
});

// An account without INFO: ioredis skips its ready check with a warning of its own, and the cache cannot learn
// the run of the server.
describe('cache on a Redis that does not say which run it is', { skip: testRedis.skip }, () => {
  test('reads that depend on table versions go to the database, plain keys are still cached', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const account = await createAclUser(testRedis.admin, ['+@all', '-@dangerous']);
    const { run, redis } = await openCache({ env: account.env });

    t.after(async () => {
      await redis.close();
      await account.remove();
    });
    const table = nextName('runless');
    const versionedKey = nextName('runless');
    const plainKey = nextName('runless');
    const versioned = countCalls();
    const plain = countCalls();

    await run(() => invalidateCacheTables([table]));
    await run(() => wrapCache(versionedKey, versioned.fn, { tables: [table] }));
    await run(() => wrapCache(versionedKey, versioned.fn, { tables: [table] }));
    await run(() => wrapCache(plainKey, plain.fn));
    await run(() => wrapCache(plainKey, plain.fn));

    assert.equal(versioned.calls.count, 2);
    assert.equal(plain.calls.count, 1);
    assert.ok(warn.mock.callCount() >= 1);
  });
});

describe('cache inside a transaction', { skip: testRedis.skip || testDb.skip }, () => {
  async function openWithDatabase() {
    const opened = await openCache();
    const context = createContext({ ...opened.context, db: testDb.db });

    function run(fn) {
      return runInContext(context, fn);
    }

    return { ...opened, run };
  }

  test('is neither read nor written: fn runs on every call, also for a key that is cached, and does not join a read outside', { timeout: HANG_TIMEOUT_MS }, async () => {
    const { run } = await openWithDatabase();
    const key = nextName('transaction');
    const heldKey = nextName('transaction');
    const outside = createHeld('outside');
    const { calls, fn } = countCalls();

    await run(() => wrapCache(key, fn));

    const waiting = run(() => wrapCache(heldKey, outside.fn));

    await outside.started;
    await run(() => withTransaction(async () => {
      await wrapCache(key, fn);
      await wrapCache(heldKey, fn);

      assert.equal(await readCache(key), undefined);
    }));
    outside.release();

    assert.equal(await waiting, 'outside');
    assert.equal(calls.count, 3);
    assert.deepEqual(await run(() => readCache(key)), { count: 1 });
    assert.equal(await run(() => readCache(heldKey)), 'outside');
  });

  test('bumps a version only after the commit, and never after a rollback of the transaction or of its savepoint', async () => {
    const { run } = await openWithDatabase();
    const committed = nextName('committed');
    const rolledBack = nextName('rolled_back');
    const savepoint = nextName('savepoint');
    let versionInside = 'unread';

    await run(() => invalidateCacheTables([committed, rolledBack, savepoint]));

    const [committedBefore, rolledBackBefore, savepointBefore] = await Promise.all([committed, rolledBack, savepoint].map(readVersion));

    await run(() => withTransaction(async () => {
      await invalidateCacheTables([committed]);
      versionInside = await readVersion(committed);

      await assert.rejects(withTransaction(async () => {
        await invalidateCacheTables([savepoint]);

        throw new Error('savepoint rollback');
      }), /savepoint rollback/);
    }));

    await assert.rejects(run(() => withTransaction(async () => {
      await invalidateCacheTables([rolledBack]);

      throw new Error('rollback');
    })), /rollback/);

    assert.equal(versionInside, committedBefore);
    assert.equal(Number(await readVersion(committed)), Number(committedBefore) + 1);
    assert.equal(await readVersion(rolledBack), rolledBackBefore);
    assert.equal(await readVersion(savepoint), savepointBefore);
  });

  test('writes and deletes an entry only after the commit', async () => {
    const { run, config } = await openWithDatabase();
    const kept = nextName('kept');
    const dropped = nextName('dropped');
    const never = nextName('never');

    await run(() => writeCache(dropped, 'old'));
    await run(() => withTransaction(async () => {
      await writeCache(kept, 'new');
      await deleteCache(dropped);

      assert.equal(await testRedis.admin.exists(toEntryKey(config, kept)), 0);
      assert.equal(await testRedis.admin.exists(toEntryKey(config, dropped)), 1);
    }));

    await assert.rejects(run(() => withTransaction(async () => {
      await writeCache(never, 'never');

      throw new Error('rollback');
    })), /rollback/);

    assert.equal(await run(() => readCache(kept)), 'new');
    assert.equal(await run(() => readCache(dropped)), undefined);
    assert.equal(await testRedis.admin.exists(toEntryKey(config, never)), 0);
  });
});
