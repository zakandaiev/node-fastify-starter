import { isNumber, isPositiveInteger } from '#utils/type.js';

function assertWindows(windows, signature) {
  if (!(windows instanceof Map)) {
    throw new TypeError(`${signature} requires a Map of windows`);
  }
}

// A fixed window for each key: the first event of a window passes and takes the count of those held back since
// the last one that passed; the rest of the window is counted. The caller owns the map, its keys and its clock.
export function takeWindowSlot(windows, key, { windowMs, now } = {}) {
  assertWindows(windows, 'takeWindowSlot(windows, key, { windowMs, now })');

  if (!isPositiveInteger(windowMs) || !isNumber(now)) {
    throw new TypeError('takeWindowSlot(windows, key, { windowMs, now }) requires a window of whole milliseconds above zero and the time now');
  }

  const entry = windows.get(key);

  if (entry !== undefined && now < entry.until) {
    entry.suppressedCount += 1;

    return { isAllowed: false, suppressedCount: 0 };
  }

  windows.set(key, { until: now + windowMs, suppressedCount: 0 });

  return { isAllowed: true, suppressedCount: entry?.suppressedCount ?? 0 };
}

// Counts into a window without opening it: the next event that passes takes the count with its own.
export function addWindowCount(windows, key, count) {
  assertWindows(windows, 'addWindowCount(windows, key, count)');

  if (!isPositiveInteger(count)) {
    throw new TypeError('addWindowCount(windows, key, count) requires a count above zero');
  }

  const entry = windows.get(key);

  windows.set(key, { until: entry?.until ?? 0, suppressedCount: (entry?.suppressedCount ?? 0) + count });

  return true;
}
