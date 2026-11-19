export function createCacheConfig() {
  return Object.freeze({
    // Also how long an entry cached before a version bump that failed can be served.
    defaultTtl: '5m',

    // The cache Redis (the main one, when the cache lives there) that has not been ready for this long is reported.
    outageAlertAfter: '1m',
  });
}
