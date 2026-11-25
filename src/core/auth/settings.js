import { assertDurations, convertStringToSeconds } from '#utils/date.js';
import { isNonEmptyString, isPositiveInteger } from '#utils/type.js';

// In seconds: the least a token or a mark can live.
export const TTL_MIN = 1;

const DURATION_KEYS = Object.freeze(['accessTtl', 'refreshTtl', 'sessionMaxAge', 'registryMemoryTtl', 'readTimeout']);
const LIMIT_KEYS = Object.freeze(['accessTokenMaxBytes', 'maxSessions', 'registryMemoryMaxEntries']);

export function readLifetimes(authConfig) {
  return {
    accessTtl: convertStringToSeconds(authConfig.accessTtl),
    refreshTtl: convertStringToSeconds(authConfig.refreshTtl),
    sessionMaxAge: convertStringToSeconds(authConfig.sessionMaxAge),
  };
}

// At the start: a part of a second would only show itself after a rotation is committed, when its cookies are written.
export function assertAuthConfig(authConfig) {
  assertDurations(authConfig, DURATION_KEYS, 'config.auth');

  const { accessTtl, refreshTtl, sessionMaxAge } = readLifetimes(authConfig);

  if (![accessTtl, refreshTtl, sessionMaxAge].every((seconds) => isPositiveInteger(seconds))) {
    throw new TypeError('config.auth requires accessTtl, refreshTtl and sessionMaxAge to be whole seconds');
  }

  if (accessTtl > refreshTtl || refreshTtl > sessionMaxAge) {
    throw new TypeError('config.auth requires accessTtl not to be above refreshTtl, and refreshTtl not to be above sessionMaxAge');
  }

  if (!LIMIT_KEYS.every((key) => isPositiveInteger(authConfig[key]))) {
    throw new TypeError(`config.auth requires ${LIMIT_KEYS.join(', ')} to be positive integers`);
  }

  if (!isNonEmptyString(authConfig.refreshRoute)) {
    throw new TypeError('config.auth requires refreshRoute: the route the refresh cookie rides to');
  }

  return true;
}
