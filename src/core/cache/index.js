import { getContext } from '#core/context/index.js';
import { afterCommit } from '#core/db/transaction.js';
import { REDIS_FAILURE, runRedisSafely } from '#core/redis/index.js';
import { unique } from '#utils/array.js';
import { singleFlight } from '#utils/async.js';
import { convertStringToMs, nowUtc } from '#utils/date.js';
import { objectHash } from '#utils/hash.js';
import { deserializeValue, SERIALIZED_FORMAT, serializeValue } from '#utils/serialize.js';
import {
  isArray,
  isFunction,
  isNonEmptyArray,
  isNonEmptyString,
  isObject,
} from '#utils/type.js';

const CACHE_NAMESPACE = 'cache';
const TABLE_VERSION_NAMESPACE = 'table-version:';
const KEY_SEPARATOR = ':';
const TTL_UNIT = 'PX';
const ONLY_IF_ABSENT = 'NX';

// A version starts from the clock: one that was lost (evicted, deleted by hand) starts again far above every number
// it had, so an entry cached under an old number is never read again. A thousand writes in a millisecond fit in.
const VERSION_PER_MS = 1000;

// The run of the server goes into every key that depends on versions: a restart that lost the last writes of its log,
// or a failover to a replica that lags, turns the versions back, and the entries of the newer ones would come back.
const SERVER_SECTION = 'server';
const SERVER_ID_REGEXP = /^run_id:(\w+)\r?$/m;
const SERVER_ID_FLIGHT = 'run_id';
const PENDING_RETRY_FLIGHT = 'pending bumps';

const READ_FAILED_MESSAGE = 'Cache read failed';
const WRITE_FAILED_MESSAGE = 'Cache write failed';
const DELETE_FAILED_MESSAGE = 'Cache delete failed';
const VERSIONS_READ_FAILED_MESSAGE = 'Cache could not read the versions of its tables: the read goes to the database';
const VERSIONS_START_FAILED_MESSAGE = 'Cache could not start the versions of its tables';
const VERSION_BUMP_FAILED_MESSAGE = 'Cache could not bump the version of a table: it tries again, and reads of the table go to the database meanwhile';
const SERVER_ID_FAILED_MESSAGE = 'Cache could not read the run of its Redis: reads that depend on table versions go to the database';
const CORRUPT_MESSAGE = 'Cache entry cannot be read: it is taken for a miss and written again';
const CALLBACK_FAILED_MESSAGE = 'A cache outage callback failed';

const MISS = Symbol('cache miss');

// What the cache keeps for each client: two apps of one process keep theirs apart. A table whose bump failed is
// not read from the cache until a retry makes it: a process must not serve what it has just written over.
const states = new WeakMap();

// One retry at a time, started by the next read of versions or by "ready", and awaited by neither: a read must
// not pay a second commandTimeout to a Redis that has just failed one.
function retryPendingBumps(redis, state) {
  if (!state.pendingTables.size) {
    return false;
  }

  state.retries(PENDING_RETRY_FLIGHT, () => bumpVersions(redis, state, [...state.pendingTables]));

  return true;
}

function getState(redis) {
  if (!states.has(redis)) {
    const state = {
      flights: singleFlight(),
      serverIdFlights: singleFlight(),
      retries: singleFlight(),
      pendingTables: new Set(),
      failureCounts: new Map(),
      serverId: null,
      connection: 0,
    };

    redis.watchState({
      onDown: () => {
        state.serverId = null;
        state.connection += 1;
      },
      onUp: () => retryPendingBumps(redis, state),
    });
    states.set(redis, state);
  }

  return states.get(redis);
}

function assertKey(key, signature) {
  if (!isNonEmptyString(key)) {
    throw new TypeError(`${signature} requires a key: a non-empty string`);
  }
}

export function assertCacheTtl(ttl, signature) {
  if (convertStringToMs(ttl) <= 0) {
    throw new TypeError(`${signature} requires a ttl above zero, such as "5m": a cache key is never written without one`);
  }
}

function readTtlMs(ttl, config, signature) {
  const value = ttl ?? config.defaultTtl;

  assertCacheTtl(value, signature);

  return convertStringToMs(value);
}

export function assertCacheTables(tables, signature) {
  if (!isNonEmptyArray(tables) || !tables.every((table) => isNonEmptyString(table))) {
    throw new TypeError(`${signature} requires tables to be a non-empty array of table names`);
  }
}

// Sorted and without repeats: ['users', 'groups'] and ['groups', 'users', 'users'] name one set of versions.
function readTables(tables, signature) {
  assertCacheTables(tables, signature);

  return unique(tables).sort();
}

// The release and the format of the text are in the name of an entry: during a deploy two releases do not read
// each other's entries, whose shape may differ. Versions are not: the writes of one release invalidate the other.
function toEntryKey(context, key) {
  return [CACHE_NAMESPACE, context.config.app.version, SERIALIZED_FORMAT, key].join(KEY_SEPARATOR);
}

function toVersionKey(table) {
  return `${TABLE_VERSION_NAMESPACE}${table}`;
}

function startVersion() {
  return String(nowUtc().getTime() * VERSION_PER_MS);
}

// Inside a transaction the cache is not read: an entry may predate what the transaction has written, and what
// the transaction reads must not be cached before it commits. Without a cache Redis that is up, it is off.
function findUsableRedis(context) {
  const redis = context.cacheRedis;

  return context.transaction === null && redis?.isReady()
    ? redis
    : null;
}

// Writes, deletes and bumps wait for the commit of the transaction they are made in, and are dropped with its
// rollback; outside a transaction they happen at once.
async function afterCommitOrNow(context, operation) {
  if (context.transaction) {
    await afterCommit(operation);

    return true;
  }

  return operation();
}

// The message of a parse error quotes the text it failed on, and the text is a cached value: only its type is logged.
function isReadable(text, key, log) {
  try {
    deserializeValue(text);

    return true;
  } catch (err) {
    log.warn({ cache: { key, reason: err.name } }, CORRUPT_MESSAGE);

    return false;
  }
}

// The text of the entry, MISS when there is none that can be read, or REDIS_FAILURE when Redis did not answer.
async function readText(redis, key, log) {
  const text = await runRedisSafely((client) => client.get(key), READ_FAILED_MESSAGE, { redis });

  if (text === REDIS_FAILURE) {
    return REDIS_FAILURE;
  }

  return text === null || !isReadable(text, key, log)
    ? MISS
    : text;
}

async function writeText(redis, key, text, ttlMs) {
  if (!redis) {
    return false;
  }

  const result = await runRedisSafely((client) => client.set(key, text, TTL_UNIT, ttlMs), WRITE_FAILED_MESSAGE, { redis });

  return result !== REDIS_FAILURE;
}

// A plain key is not tied to tables: no write to the database invalidates it, only deleteCache() and its TTL.
// It holds what may be one TTL old; what is read from tables is cached with wrapCache(key, fn, { tables }).
export async function readCache(key) {
  assertKey(key, 'readCache(key)');

  const context = getContext();
  const redis = findUsableRedis(context);

  if (!redis) {
    return undefined;
  }

  const text = await readText(redis, toEntryKey(context, key), context.log);

  return text === MISS || text === REDIS_FAILURE
    ? undefined
    : deserializeValue(text);
}

// The value is checked to be one the cache gives back the same before anything else: a value it cannot keep
// fails the same way whether Redis is up or not.
export async function writeCache(key, value, { ttl } = {}) {
  assertKey(key, 'writeCache(key, value, options)');

  const context = getContext();
  const ttlMs = readTtlMs(ttl, context.config.cache, 'writeCache(key, value, { ttl })');
  const text = serializeValue(value);
  const entryKey = toEntryKey(context, key);

  return afterCommitOrNow(context, () => writeText(context.cacheRedis, entryKey, text, ttlMs));
}

function readKeys(keys, signature) {
  const list = isArray(keys)
    ? keys
    : [keys];

  if (!list.length || !list.every((key) => isNonEmptyString(key))) {
    throw new TypeError(`${signature} requires a key or a non-empty array of keys`);
  }

  return list;
}

async function unlinkKeys(redis, keys) {
  if (!redis) {
    return false;
  }

  const result = await runRedisSafely((client) => client.unlink(...keys), DELETE_FAILED_MESSAGE, { redis });

  return result !== REDIS_FAILURE;
}

export async function deleteCache(keys) {
  const context = getContext();
  const entryKeys = readKeys(keys, 'deleteCache(keys)').map((key) => toEntryKey(context, key));

  return afterCommitOrNow(context, () => unlinkKeys(context.cacheRedis, entryKeys));
}

// A version that was never there starts from the clock, in the same step as its first bump.
function bumpVersion(redis, table) {
  const key = toVersionKey(table);

  return runRedisSafely(
    (client) => client.multi().set(key, startVersion(), ONLY_IF_ABSENT).incr(key),
    VERSION_BUMP_FAILED_MESSAGE,
    { redis },
  );
}

// A success clears the mark of its table only when no bump of that table has failed since it was sent: an earlier
// bump that comes back late must not hide a later write whose bump failed meanwhile.
async function bumpTable(redis, state, table) {
  const failuresBefore = state.failureCounts.get(table) ?? 0;
  const result = await bumpVersion(redis, table);

  if (result === REDIS_FAILURE) {
    state.failureCounts.set(table, (state.failureCounts.get(table) ?? 0) + 1);
    state.pendingTables.add(table);

    return false;
  }

  if ((state.failureCounts.get(table) ?? 0) === failuresBefore) {
    state.pendingTables.delete(table);
  }

  return true;
}

// Each table on its own: one version key that refuses INCR (a type someone else wrote, an ACL) must not keep
// the others pending, nor have them bumped again on every read.
async function bumpVersions(redis, state, tables) {
  const results = await Promise.all(tables.map((table) => bumpTable(redis, state, table)));

  return results.every(Boolean);
}

export async function invalidateCacheTables(tables) {
  const names = readTables(tables, 'invalidateCacheTables(tables)');
  const context = getContext();
  const redis = context.cacheRedis;

  return afterCommitOrNow(context, () => (redis
    ? bumpVersions(redis, getState(redis), names)
    : false));
}

async function fetchServerId(redis) {
  const info = await runRedisSafely((client) => client.info(SERVER_SECTION), SERVER_ID_FAILED_MESSAGE, { redis });

  return info === REDIS_FAILURE
    ? null
    : SERVER_ID_REGEXP.exec(info)?.[1] ?? null;
}

// Read once for each connection: a run read before the connection dropped must not stand for the one after it.
async function readServerId(redis, state) {
  if (state.serverId) {
    return state.serverId;
  }

  const { connection } = state;
  const serverId = await state.serverIdFlights(SERVER_ID_FLIGHT, () => fetchServerId(redis));

  if (connection === state.connection) {
    state.serverId = serverId;
  }

  return serverId;
}

// A version that is missing is started and this read goes to the database: hashed as nothing, it would make
// the number of a lost version usable again.
async function startVersions(redis, tables) {
  await runRedisSafely(
    (client) => tables.reduce((pipeline, table) => pipeline.set(toVersionKey(table), startVersion(), ONLY_IF_ABSENT), client.pipeline()),
    VERSIONS_START_FAILED_MESSAGE,
    { redis },
  );

  return null;
}

// The versions are read before fn runs: a value fn computes before a write commits lands under the versions
// that write bumps, where no one reads it again. Null sends the read to the database.
async function readVersions(redis, state, tables) {
  retryPendingBumps(redis, state);

  if (tables.some((table) => state.pendingTables.has(table))) {
    return null;
  }

  const serverId = await readServerId(redis, state);

  if (!serverId) {
    return null;
  }

  const values = await runRedisSafely((client) => client.mget(...tables.map((table) => toVersionKey(table))), VERSIONS_READ_FAILED_MESSAGE, { redis });

  if (values === REDIS_FAILURE) {
    return null;
  }

  const missing = tables.filter((table, index) => values[index] === null);

  return missing.length
    ? startVersions(redis, missing)
    : { serverId, versions: Object.fromEntries(tables.map((table, index) => [table, values[index]])) };
}

async function toCacheKey(context, redis, key, tables) {
  if (!tables) {
    return toEntryKey(context, key);
  }

  const read = await readVersions(redis, getState(redis), tables);

  return read
    ? toEntryKey(context, objectHash({ key, ...read }))
    : null;
}

async function compute(fn) {
  return serializeValue(await fn());
}

// A Redis that has just failed to answer the read is not asked to write: a call costs one commandTimeout at most.
async function readOrCompute(redis, key, fn, ttlMs, log) {
  const stored = await readText(redis, key, log);

  if (stored !== MISS && stored !== REDIS_FAILURE) {
    return stored;
  }

  const text = await compute(fn);

  if (stored === MISS) {
    await writeText(redis, key, text, ttlMs);
  }

  return text;
}

// Callers of one key at once share one call of fn, made in the context of the first: what fn returns must depend
// on the key only. Each caller decodes its own copy of the text, so none changes what another holds. Without
// the cache nothing is shared: without versions a shared result could predate the caller's own write.
export async function wrapCache(key, fn, { ttl, tables } = {}) {
  assertKey(key, 'wrapCache(key, fn, options)');

  if (!isFunction(fn)) {
    throw new TypeError('wrapCache(key, fn, options) requires a function');
  }

  const context = getContext();
  const ttlMs = readTtlMs(ttl, context.config.cache, 'wrapCache(key, fn, { ttl })');
  const tableNames = tables === undefined
    ? null
    : readTables(tables, 'wrapCache(key, fn, { tables })');
  const redis = findUsableRedis(context);
  const cacheKey = redis
    ? await toCacheKey(context, redis, key, tableNames)
    : null;

  if (!cacheKey) {
    return deserializeValue(await compute(fn));
  }

  const { flights } = getState(redis);

  return deserializeValue(await flights(cacheKey, () => readOrCompute(redis, cacheKey, fn, ttlMs, context.log)));
}

// A callback that throws counts as delivered: it must not be called again and again.
async function runQuietly(fn, outage, log) {
  try {
    return await fn(outage);
  } catch (err) {
    log.error({ err }, CALLBACK_FAILED_MESSAGE);

    return true;
  }
}

function assertWatchOptions(redis, { log, onOutage, onRecovery }) {
  if (!isObject(redis) || !isFunction(redis.watchState) || !isFunction(log?.error) || !isFunction(onOutage) || !isFunction(onRecovery)) {
    throw new TypeError('watchCacheOutage(redis, { after, log, onOutage, onRecovery }) requires a client of createRedis(), a logger and two functions');
  }
}

// Rounded up: setTimeout() cuts a fraction of a millisecond off, and the report would come before "after".
function scheduleReport(watch, outage, delayMs) {
  clearTimeout(watch.timer);
  watch.timer = setTimeout(() => reportOutage(watch, outage), Math.ceil(delayMs));
  watch.timer.unref();

  return true;
}

function reportRecovery(watch, downMs) {
  runQuietly(watch.onRecovery, { address: watch.redis.address, downMs }, watch.log);

  return true;
}

// The outage may end while onOutage is still sending its report: the recovery is then reported once the report
// has gone out, and a report that did not go out is not tried again for an outage that is over.
async function reportOutage(watch, outage) {
  watch.timer = null;

  if (watch.isStopped || watch.outage !== outage) {
    return false;
  }

  outage.isReporting = true;
  watch.reporting = outage;

  const isDelivered = await runQuietly(watch.onOutage, {
    address: watch.redis.address,
    downMs: Math.round(performance.now() - outage.downSince),
  }, watch.log);

  outage.isReporting = false;
  watch.reporting = null;

  if (isDelivered === false) {
    if (!watch.isStopped && watch.outage === outage) {
      scheduleReport(watch, outage, watch.afterMs);
    }

    return false;
  }

  outage.isReported = true;

  if (outage.recoveredDownMs !== null) {
    reportRecovery(watch, outage.recoveredDownMs);
  }

  return true;
}

// Down again while the report of the last outage is still being sent: it is that outage going on, not a new one,
// so the channel gets one report and later one recovery, in that order.
function markOutageDown(watch, downSince) {
  if (watch.isStopped || watch.outage !== null) {
    return false;
  }

  if (watch.reporting) {
    watch.reporting.recoveredDownMs = null;
    watch.outage = watch.reporting;

    return true;
  }

  const outage = {
    downSince,
    isReporting: false,
    isReported: false,
    recoveredDownMs: null,
  };

  watch.outage = outage;

  return scheduleReport(watch, outage, Math.max(0, watch.afterMs - (performance.now() - downSince)));
}

// From the start of the outage: after a flap during its report, the time the client gives covers the last stretch only.
function markOutageUp(watch) {
  const { outage } = watch;

  if (!outage) {
    return false;
  }

  const downMs = Math.round(performance.now() - outage.downSince);

  clearTimeout(watch.timer);
  watch.timer = null;
  watch.outage = null;

  if (outage.isReporting) {
    outage.recoveredDownMs = downMs;

    return false;
  }

  if (outage.isReported) {
    reportRecovery(watch, downMs);
  }

  return outage.isReported;
}

// One report for each time the cache Redis stays away longer than "after", and one when it is back after one:
// the reconnects in between are not counted, and a client that was never told to connect is not down.
// onOutage that resolves false (an alert that was not sent) is called again "after" later.
export function watchCacheOutage(redis, {
  after,
  log,
  onOutage,
  onRecovery,
} = {}) {
  assertWatchOptions(redis, { log, onOutage, onRecovery });

  const afterMs = convertStringToMs(after);

  if (afterMs <= 0) {
    throw new TypeError('watchCacheOutage(redis, { after }) requires a duration above zero');
  }

  const watch = {
    redis,
    afterMs,
    log,
    onOutage,
    onRecovery,
    outage: null,
    reporting: null,
    timer: null,
    isStopped: false,
  };
  const unwatch = redis.watchState({
    onDown: (downSince) => markOutageDown(watch, downSince),
    onUp: () => markOutageUp(watch),
  });

  function stop() {
    watch.isStopped = true;
    clearTimeout(watch.timer);
    watch.timer = null;
    unwatch();

    return true;
  }

  return { stop };
}
