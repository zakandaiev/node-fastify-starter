import { REDIS_FAILURE, runRedisSafely } from '#core/redis/index.js';
import { sha256 } from '#utils/hash.js';
import { addWindowCount, takeWindowSlot } from '#utils/window.js';

const DEDUPE_NAMESPACE = 'alert:dedupe:';
const THROTTLE_NAMESPACE = 'alert:throttle:';
const SUPPRESSED_NAMESPACE = 'alert:suppressed:';
const KEY_SEPARATOR = ':';

const TTL_UNIT = 'PX';
const ONLY_IF_ABSENT = 'NX';
const MARK = '1';
const SET_OK = 'OK';

const DEDUPE_READ_FAILED_MESSAGE = 'Alert could not read its dedupe mark: memory decides';
const DEDUPE_WRITE_FAILED_MESSAGE = 'Alert could not set its dedupe mark: memory holds it';
const DEDUPE_RELEASE_FAILED_MESSAGE = 'Alert could not release its dedupe mark: the same alert waits for its TTL';
const THROTTLE_FAILED_MESSAGE = 'Alert could not take a slot of its throttle window: memory decides';
const SUPPRESSED_FAILED_MESSAGE = 'Alert could not count a suppressed one: memory holds the count';

// What a process keeps while Redis is down, for each client: two apps of one process keep theirs apart.
// A space has a dedupe map of its own, so reports of the public cannot evict the marks of the internal one.
const memories = new WeakMap();
const detachedMemory = { spaces: new Map() };

function getMemory(redis) {
  if (redis === null) {
    return detachedMemory;
  }

  if (!memories.has(redis)) {
    memories.set(redis, { spaces: new Map() });
  }

  return memories.get(redis);
}

function getSpaceMemory(redis, space) {
  const { spaces } = getMemory(redis);

  if (!spaces.has(space)) {
    spaces.set(space, { marks: new Map(), windows: new Map() });
  }

  return spaces.get(space);
}

// The least recently used mark goes first once the map is full: a read moves a mark to the end.
function readMark(memory, key, now) {
  const entry = memory.marks.get(key);

  memory.marks.delete(key);

  if (entry === undefined || entry.until <= now) {
    return false;
  }

  memory.marks.set(key, entry);

  return true;
}

function writeMark(memory, key, { ttlMs, maxEntries }, now) {
  memory.marks.delete(key);

  if (memory.marks.size >= maxEntries) {
    memory.marks.delete(memory.marks.keys().next().value);
  }

  memory.marks.set(key, { until: now + ttlMs });

  return true;
}

function toDedupeKey(space, dedupeKey) {
  return `${DEDUPE_NAMESPACE}${space}${KEY_SEPARATOR}${sha256(dedupeKey)}`;
}

function toWindowKey(namespace, window) {
  return `${namespace}${window}`;
}

// A mark in memory counts too: while Redis refused writes and answered reads, the marks went there.
export async function isDeduped({ redis, space, dedupeKey }) {
  const key = toDedupeKey(space, dedupeKey);
  const isInMemory = readMark(getSpaceMemory(redis, space), key, performance.now());
  const found = await runRedisSafely((client) => client.exists(key), DEDUPE_READ_FAILED_MESSAGE, { redis });

  return isInMemory || (found !== REDIS_FAILURE && found > 0);
}

// Taken right before the send: of two equal alerts at the same moment, one sends. Without Redis the memory decides.
export async function claimDedupe({
  redis,
  space,
  dedupeKey,
  ttlMs,
  maxEntries,
}) {
  const key = toDedupeKey(space, dedupeKey);
  const memory = getSpaceMemory(redis, space);
  const now = performance.now();
  const reply = await runRedisSafely((client) => client.set(key, MARK, TTL_UNIT, ttlMs, ONLY_IF_ABSENT), DEDUPE_WRITE_FAILED_MESSAGE, { redis });

  if (reply !== REDIS_FAILURE) {
    return reply === SET_OK;
  }

  if (readMark(memory, key, now)) {
    return false;
  }

  return writeMark(memory, key, { ttlMs, maxEntries }, now);
}

// Released where the mark was set: a mark held by memory while Redis was away is gone with the memory one.
export async function releaseDedupe({ redis, space, dedupeKey }) {
  const key = toDedupeKey(space, dedupeKey);
  const isInMemory = getSpaceMemory(redis, space).marks.delete(key);
  const reply = await runRedisSafely((client) => client.del(key), DEDUPE_RELEASE_FAILED_MESSAGE, { redis });

  return isInMemory || reply !== REDIS_FAILURE;
}

// Into the count of the window, in Redis or else in memory, for the next message of that window to carry.
export async function addSuppressed({
  redis,
  space,
  window,
  count,
  suppressedTtlMs,
}) {
  if (count <= 0) {
    return false;
  }

  const key = toWindowKey(SUPPRESSED_NAMESPACE, window);
  const reply = await runRedisSafely((client) => client.multi().incrby(key, count).pexpire(key, suppressedTtlMs), SUPPRESSED_FAILED_MESSAGE, { redis });

  if (reply === REDIS_FAILURE) {
    addWindowCount(getSpaceMemory(redis, space).windows, window, count);
  }

  return true;
}

// One message for each window: the first alert takes the slot and the count of those suppressed since the last one.
// The count is read apart from the slot: one suppressed in between is counted into this message, never lost.
export async function takeThrottleSlot(state) {
  const {
    redis,
    space,
    window,
    windowMs,
  } = state;
  const { windows } = getSpaceMemory(redis, space);
  const slotKey = toWindowKey(THROTTLE_NAMESPACE, window);
  const slot = await runRedisSafely((client) => client.set(slotKey, MARK, TTL_UNIT, windowMs, ONLY_IF_ABSENT), THROTTLE_FAILED_MESSAGE, { redis });

  if (slot === REDIS_FAILURE) {
    return takeWindowSlot(windows, window, { windowMs, now: performance.now() });
  }

  if (slot !== SET_OK) {
    await addSuppressed({ ...state, count: 1 });

    return { isAllowed: false, suppressedCount: 0 };
  }

  const taken = await runRedisSafely((client) => client.getdel(toWindowKey(SUPPRESSED_NAMESPACE, window)), THROTTLE_FAILED_MESSAGE, { redis });
  const memoryCount = windows.get(window)?.suppressedCount ?? 0;

  windows.delete(window);

  return {
    isAllowed: true,
    suppressedCount: (taken === REDIS_FAILURE ? 0 : Number(taken ?? 0)) + memoryCount,
  };
}
