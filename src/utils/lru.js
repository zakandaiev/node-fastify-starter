import { isNumber, isPositiveInteger } from '#utils/type.js';

function assertEntries(entries, signature) {
  if (!(entries instanceof Map)) {
    throw new TypeError(`${signature} requires a Map of entries`);
  }
}

// A read moves the entry to the end of the map, so the first one is the entry read longest ago. The caller owns
// the map, its keys and its clock.
export function readLru(entries, key, now) {
  const signature = 'readLru(entries, key, now)';

  assertEntries(entries, signature);

  if (!isNumber(now)) {
    throw new TypeError(`${signature} requires the time now`);
  }

  const entry = entries.get(key);

  entries.delete(key);

  if (entry === undefined || entry.until <= now) {
    return undefined;
  }

  entries.set(key, entry);

  return entry.value;
}

// A map that is full gives up the entry read longest ago, expired or not.
export function writeLru(entries, key, value, { until, maxEntries } = {}) {
  const signature = 'writeLru(entries, key, value, { until, maxEntries })';

  assertEntries(entries, signature);

  if (!isNumber(until) || !isPositiveInteger(maxEntries)) {
    throw new TypeError(`${signature} requires the time the entry ends at and a ceiling of entries above zero`);
  }

  entries.delete(key);

  if (entries.size >= maxEntries) {
    entries.delete(entries.keys().next().value);
  }

  entries.set(key, { value, until });

  return true;
}
