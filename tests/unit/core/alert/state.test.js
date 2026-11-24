import {
  claimDedupe,
  isDeduped,
  releaseDedupe,
  addSuppressed,
  takeThrottleSlot,
} from '#core/alert/state.js';
import { createLogger } from '#core/logger/index.js';
import { createRedis } from '#core/redis/index.js';
import { ALERT_SPACE } from '#enums/alert-space.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const LABEL = 'Alert state Redis';

const TTL_MS = 60000;
const SHORT_TTL_MS = 50;
const PAST_SHORT_TTL_MS = 100;
const WINDOW_MS = 100;
const PAST_WINDOW_MS = 160;
const SUPPRESSED_TTL_MS = 86400000;
const MAX_ENTRIES = 1000;
const SMALL_MEMORY = 3;
const FLOOD = 10;

const FAILURE_WINDOW = `${ALERT_SPACE.INTERNAL}:${THROTTLE_CLASS.FAILURE}`;
const WARNING_WINDOW = `${ALERT_SPACE.INTERNAL}:${THROTTLE_CLASS.WARNING}`;
const PUBLIC_FAILURE_WINDOW = `${ALERT_SPACE.PUBLIC}:${THROTTLE_CLASS.FAILURE}`;

const HELD = Object.freeze({ isAllowed: false, suppressedCount: 0 });

function allowed(suppressedCount) {
  return { isAllowed: true, suppressedCount };
}

// A client of the test alone that is never started: every command fails at once, and the state falls back to the
// memory of this client, which no other test shares.
function openState(t, overrides = {}) {
  const config = createTestConfig({ env: REDIS_DOWN_ENV });
  const { cache, ...main } = config.redis;
  const redis = createRedis(main, { log: createLogger(config.logger), label: LABEL });

  t.after(() => redis.close());

  return {
    redis,
    space: ALERT_SPACE.INTERNAL,
    window: FAILURE_WINDOW,
    ttlMs: TTL_MS,
    windowMs: WINDOW_MS,
    suppressedTtlMs: SUPPRESSED_TTL_MS,
    maxEntries: MAX_ENTRIES,
    ...overrides,
  };
}

// One after the other: the order of the claims is the order of use the memory keeps.
function claimInOrder(state, dedupeKeys) {
  return dedupeKeys.reduce(async (previous, dedupeKey) => {
    const claimed = await previous;

    return [...claimed, await claimDedupe({ ...state, dedupeKey })];
  }, Promise.resolve([]));
}

function readMarks(state, dedupeKeys) {
  return Promise.all(dedupeKeys.map((dedupeKey) => isDeduped({ ...state, dedupeKey })));
}

describe('alert dedupe state without Redis', () => {
  test('a claimed mark dedupes, a second claim of it is refused, and a release frees it for the next claim', async (t) => {
    const state = { ...openState(t), dedupeKey: 'upstream:payments:network' };

    assert.equal(await isDeduped(state), false);
    assert.equal(await claimDedupe(state), true);
    assert.equal(await isDeduped(state), true);
    assert.equal(await claimDedupe(state), false);
    assert.equal(await releaseDedupe(state), true);
    assert.equal(await isDeduped(state), false);
    assert.equal(await claimDedupe(state), true);
  });

  test('a release says it freed nothing when no mark was set and Redis is not there', async (t) => {
    const state = { ...openState(t), dedupeKey: 'never-claimed' };

    assert.equal(await releaseDedupe(state), false);
  });

  test('a mark of one space does not dedupe the same key in the other', async (t) => {
    const state = { ...openState(t), dedupeKey: 'upstream:payments:network' };

    assert.equal(await claimDedupe(state), true);
    assert.equal(await isDeduped({ ...state, space: ALERT_SPACE.PUBLIC }), false);
    assert.equal(await claimDedupe({ ...state, space: ALERT_SPACE.PUBLIC }), true);
  });

  test('a mark expires after its ttl: it no longer dedupes, and its key may be claimed again', async (t) => {
    const state = openState(t, { ttlMs: SHORT_TTL_MS });

    assert.deepEqual(await claimInOrder(state, ['read', 'claimed']), [true, true]);
    assert.deepEqual(await readMarks(state, ['read', 'claimed']), [true, true]);

    await sleep(PAST_SHORT_TTL_MS);

    assert.equal(await isDeduped({ ...state, dedupeKey: 'read' }), false);
    assert.equal(await claimDedupe({ ...state, dedupeKey: 'claimed' }), true);
  });

  test('the least recently used mark goes once the memory holds maxEntries', async (t) => {
    const state = openState(t, { maxEntries: SMALL_MEMORY });

    assert.deepEqual(await claimInOrder(state, ['a', 'b', 'c', 'd']), [true, true, true, true]);
    assert.deepEqual(await readMarks(state, ['a', 'b', 'c', 'd']), [false, true, true, true]);
  });

  test('a read keeps a mark in use: the one that goes is the one left unread the longest', async (t) => {
    const state = openState(t, { maxEntries: SMALL_MEMORY });

    await claimInOrder(state, ['a', 'b', 'c']);

    assert.equal(await isDeduped({ ...state, dedupeKey: 'a' }), true);
    assert.deepEqual(await claimInOrder(state, ['d']), [true]);
    assert.deepEqual(await readMarks(state, ['a', 'b', 'c', 'd']), [true, false, true, true]);
  });

  test('a flood of the public space evicts nothing of the internal one', async (t) => {
    const state = openState(t, { maxEntries: SMALL_MEMORY });
    const internalSpace = { ...state, space: ALERT_SPACE.INTERNAL };
    const publicSpace = { ...state, space: ALERT_SPACE.PUBLIC };
    const reports = Array.from({ length: FLOOD }, (_, index) => `report:${index}`);

    await claimInOrder(internalSpace, ['upstream:payments:network', 'upstream:mail:network']);
    await claimInOrder(publicSpace, reports);

    assert.deepEqual(await readMarks(internalSpace, ['upstream:payments:network', 'upstream:mail:network']), [true, true]);
    assert.deepEqual(await readMarks(publicSpace, reports.slice(-SMALL_MEMORY)), [true, true, true]);
    assert.equal(await isDeduped({ ...publicSpace, dedupeKey: reports[0] }), false);
  });

  test('two clients keep their memories apart', async (t) => {
    const first = { ...openState(t), dedupeKey: 'upstream:payments:network' };
    const second = { ...openState(t), dedupeKey: 'upstream:payments:network' };

    assert.equal(await claimDedupe(first), true);
    assert.equal(await isDeduped(second), false);
    assert.equal(await claimDedupe(second), true);
  });

  test('without a client every caller of the process shares one memory', async () => {
    const dedupeKey = `detached:${uuidv7()}`;
    const claimed = {
      redis: null,
      space: ALERT_SPACE.INTERNAL,
      dedupeKey,
      ttlMs: TTL_MS,
      maxEntries: MAX_ENTRIES,
    };

    assert.equal(await claimDedupe(claimed), true);
    assert.equal(await isDeduped({ redis: null, space: ALERT_SPACE.INTERNAL, dedupeKey }), true);
    assert.equal(await releaseDedupe({ redis: null, space: ALERT_SPACE.INTERNAL, dedupeKey }), true);
    assert.equal(await isDeduped({ redis: null, space: ALERT_SPACE.INTERNAL, dedupeKey }), false);
  });
});

describe('alert throttle state without Redis', () => {
  test('the first of a window takes the slot, the next are counted, and the first after the window takes the count', async (t) => {
    const state = openState(t);

    assert.deepEqual(await takeThrottleSlot(state), allowed(0));
    assert.deepEqual(await takeThrottleSlot(state), HELD);
    assert.deepEqual(await takeThrottleSlot(state), HELD);

    await sleep(PAST_WINDOW_MS);

    assert.deepEqual(await takeThrottleSlot(state), allowed(2));
    assert.deepEqual(await takeThrottleSlot(state), HELD);

    await sleep(PAST_WINDOW_MS);

    assert.deepEqual(await takeThrottleSlot(state), allowed(1));
  });

  test('a slot taken in one window leaves the other windows free', async (t) => {
    const state = openState(t);

    assert.deepEqual(await takeThrottleSlot(state), allowed(0));
    assert.deepEqual(await takeThrottleSlot({ ...state, window: WARNING_WINDOW }), allowed(0));
    assert.deepEqual(await takeThrottleSlot({ ...state, space: ALERT_SPACE.PUBLIC, window: PUBLIC_FAILURE_WINDOW }), allowed(0));
    assert.deepEqual(await takeThrottleSlot(state), HELD);
  });

  test('addSuppressed adds a count back to a live window, and the first slot after the window takes it all', async (t) => {
    const state = openState(t);

    assert.deepEqual(await takeThrottleSlot(state), allowed(0));
    assert.deepEqual(await takeThrottleSlot(state), HELD);
    assert.equal(await addSuppressed({ ...state, count: 4 }), true);
    assert.deepEqual(await takeThrottleSlot(state), HELD);

    await sleep(PAST_WINDOW_MS);

    assert.deepEqual(await takeThrottleSlot(state), allowed(6));
  });

  test('addSuppressed gives a count to a window that has none yet, and adds nothing for a count of zero', async (t) => {
    const state = { ...openState(t), window: WARNING_WINDOW };

    assert.equal(await addSuppressed({ ...state, count: 0 }), false);
    assert.equal(await addSuppressed({ ...state, count: 3 }), true);
    assert.deepEqual(await takeThrottleSlot(state), allowed(3));
  });
});
