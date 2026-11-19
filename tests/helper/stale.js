import { isExpired } from '#utils/date.js';
import { uuidTimestamp } from '#utils/id.js';

// A run that was killed leaves its databases and its Redis keys behind: the next run removes those older than this.
export const STALE_AFTER = '1h';

// The moment is the UUIDv7 the name carries. A name without one is not of the tests' making and is left alone.
export function isStaleId(id) {
  const createdAt = uuidTimestamp(id);

  return createdAt !== null && isExpired(createdAt, STALE_AFTER);
}
