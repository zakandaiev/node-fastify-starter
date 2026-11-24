import { addWindowCount, takeWindowSlot } from '#utils/window.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const WINDOW_MS = 1000;

describe('takeWindowSlot', () => {
  test('lets the first event of a window pass and counts the rest of it', () => {
    const windows = new Map();

    assert.deepEqual(takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: 0 }), { isAllowed: true, suppressedCount: 0 });
    assert.deepEqual(takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: 10 }), { isAllowed: false, suppressedCount: 0 });
    assert.deepEqual(takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: 999 }), { isAllowed: false, suppressedCount: 0 });
    assert.equal(windows.get('a').suppressedCount, 2);
  });

  test('gives the first event after the window the count of those held back', () => {
    const windows = new Map();

    takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: 0 });
    takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: 10 });
    takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: 20 });

    assert.deepEqual(takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: WINDOW_MS }), { isAllowed: true, suppressedCount: 2 });
    assert.equal(windows.get('a').suppressedCount, 0);
  });

  test('keeps the windows of two keys apart', () => {
    const windows = new Map();

    takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: 0 });

    assert.equal(takeWindowSlot(windows, 'b', { windowMs: WINDOW_MS, now: 10 }).isAllowed, true);
  });

  test('requires a map, a window of whole milliseconds above zero and the time now', () => {
    assert.throws(() => takeWindowSlot({}, 'a', { windowMs: WINDOW_MS, now: 0 }), { name: 'TypeError' });
    [0, -1, 1.5, '1s'].forEach((windowMs) => {
      assert.throws(() => takeWindowSlot(new Map(), 'a', { windowMs, now: 0 }), { name: 'TypeError' }, String(windowMs));
    });
    assert.throws(() => takeWindowSlot(new Map(), 'a', { windowMs: WINDOW_MS, now: Number.NaN }), { name: 'TypeError' });
  });
});

describe('addWindowCount', () => {
  test('counts into a live window without changing its end', () => {
    const windows = new Map();

    takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: 0 });
    addWindowCount(windows, 'a', 3);

    assert.deepEqual(windows.get('a'), { until: WINDOW_MS, suppressedCount: 3 });
    assert.equal(takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: 10 }).isAllowed, false);
  });

  test('gives a key without a window a count that the next event to pass takes', () => {
    const windows = new Map();

    addWindowCount(windows, 'a', 4);

    assert.deepEqual(takeWindowSlot(windows, 'a', { windowMs: WINDOW_MS, now: 0 }), { isAllowed: true, suppressedCount: 4 });
  });

  test('requires a map and a count above zero', () => {
    assert.throws(() => addWindowCount([], 'a', 1), { name: 'TypeError' });
    [0, -1, 1.5].forEach((count) => {
      assert.throws(() => addWindowCount(new Map(), 'a', count), { name: 'TypeError' }, String(count));
    });
  });
});
