export function createRateLimitConfig() {
  return Object.freeze({
    // By the user of a checked access token, or by the address of a guest: a whole office or a mobile NAT sits behind
    // one address. A route that names a limit of its own in security.rateLimit counts apart from these.
    tiers: Object.freeze({
      guest: Object.freeze({ max: 100, window: '1m' }),
      user: Object.freeze({ max: 300, window: '1m' }),
    }),

    // More than this many requests above the limit within one window are a ban: the answer is the same 429, the alert is
    // its own. null for none. The tiers and the quota of POST /log/error take this one.
    ban: 30,

    // Limits that routes name in security.rateLimit.
    routes: Object.freeze({
      // A sign-in and a refresh.
      auth: Object.freeze({ max: 10, window: '1m' }),

      // A public GET with a cached answer, which a page reads often: an excess of it is no attack, so it never bans.
      publicRead: Object.freeze({ max: 600, window: '1m', ban: null }),

      // POST /log/error: a page sends a few reports a minute, another app or an SSR server with the key of logs sends
      // those of many pages.
      report: Object.freeze({ max: 20, maxWithKey: 100, window: '1m' }),
    }),

    // The counters a process keeps while Redis is down.
    memoryMaxEntries: 10_000,

    // An excess is told once in this long for each route and key in a process: an alert still builds its message and
    // asks Redis before dedupe holds it back, and a flood would pay that on every request.
    reportWindow: '1m',
    reportMaxEntries: 1000,
  });
}
