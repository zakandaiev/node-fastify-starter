import {
  readAccessToken,
  readRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '#core/auth/token.js';
import { convertStringToMs, isPositiveDuration } from '#utils/date.js';
import { findUnknownKey } from '#utils/object.js';
import {
  isFunction,
  isNonNegativeInteger,
  isObject,
  isPositiveInteger,
} from '#utils/type.js';
import { toIpAddress } from '#utils/validate.js';
import { normalizeIP } from '@fastify/rate-limit';

const USER_PREFIX = 'user:';
const ADDRESS_PREFIX = 'ip:';
const KEY_SEPARATOR = ':';

// request.ip is what a trusted proxy wrote, and a proxy can write anything there.
const UNKNOWN_ADDRESS = 'unknown';

// What @fastify/rate-limit reads as no ban.
const NO_BAN = -1;

const ROUTE_LIMIT_KEYS = Object.freeze(['max', 'window', 'ban', 'key']);
const TIER_NAMES = Object.freeze(['guest', 'user']);
const COUNT_KEYS = Object.freeze(['memoryMaxEntries', 'reportMaxEntries']);

// The tiers and the quota of POST /log/error take the ban of config.rateLimit.
const WINDOW_KEY = 'window';
const TIER_KEYS = Object.freeze(['max', WINDOW_KEY]);
const REPORT_ROUTE = 'report';
const REPORT_KEYS = Object.freeze(['max', 'maxWithKey', WINDOW_KEY]);

const ROUTE_LIMIT_FORM = 'false, or { max, window } with an optional ban and key';

// IPv6 by its /64: a network gets a subnet as one address, and a key of each address would give it no limit at all.
function readAddress(request) {
  const address = toIpAddress(request.ip);

  return address === null
    ? UNKNOWN_ADDRESS
    : normalizeIP(address);
}

export function readAddressKey(request) {
  return `${ADDRESS_PREFIX}${readAddress(request)}`;
}

// A checked token, never a decoded one, which would let anyone fill the bucket of another user or take a new one on each
// request; accessJwtVerify() reads no cookie, no previous secret and no claim. Read as the guard reads it, cookie and
// Bearer give one user one key.
export function readLimitKey(request) {
  const claims = verifyAccessToken(readAccessToken(request));

  return claims === null
    ? readAddressKey(request)
    : `${USER_PREFIX}${claims.userId}`;
}

// For the refresh route alone, where the access token has mostly run out: by its address, the people behind one would
// share the limit of a guest. The address stays in the key, so a stolen token used from another one cannot hold its
// owner in 429.
export function readRefreshLimitKey(request) {
  const claims = verifyRefreshToken(readRefreshToken(request));

  return claims === null
    ? readAddressKey(request)
    : `${USER_PREFIX}${claims.userId}${KEY_SEPARATOR}${readAddress(request)}`;
}

export function readLimitTier(rateLimitConfig, key) {
  return key.startsWith(USER_PREFIX)
    ? rateLimitConfig.tiers.user
    : rateLimitConfig.tiers.guest;
}

function isBan(value) {
  return value === undefined || value === null || isNonNegativeInteger(value);
}

// A limit of a route, as security.rateLimit names it: false for none, or a counter of its own.
export function assertRouteLimit(limit, name = 'security.rateLimit') {
  if (limit === false) {
    return true;
  }

  if (!isObject(limit)) {
    throw new TypeError(`${name} requires ${ROUTE_LIMIT_FORM}`);
  }

  const unknownKey = findUnknownKey(limit, ROUTE_LIMIT_KEYS);

  if (unknownKey !== undefined) {
    throw new TypeError(`${name} names "${unknownKey}", which no limiter reads: it takes ${ROUTE_LIMIT_KEYS.join(', ')}`);
  }

  if (!(isPositiveInteger(limit.max) || isFunction(limit.max)) || !isPositiveDuration(limit.window)) {
    throw new TypeError(`${name} requires max, a positive integer or a function (request, key) that gives one, and window, a duration above zero such as "1m"`);
  }

  if (!isBan(limit.ban) || !(limit.key === undefined || isFunction(limit.key))) {
    throw new TypeError(`${name} requires ban to be null or an integer not below zero, and key a function (request) that gives the key`);
  }

  return true;
}

function assertCount(value, name) {
  if (!isPositiveInteger(value)) {
    throw new TypeError(`${name} requires a positive integer`);
  }
}

// Every key of the form is read: another one, such as a ban of a tier, would pass the start and change nothing.
function assertPreset(preset, keys, name) {
  const counts = keys.filter((key) => key !== WINDOW_KEY);
  const isValid = isObject(preset)
    && Object.keys(preset).every((key) => keys.includes(key))
    && counts.every((key) => isPositiveInteger(preset[key]))
    && isPositiveDuration(preset.window);

  if (!isValid) {
    const terms = [...counts.map((key) => `${key} a positive integer`), `${WINDOW_KEY} a duration above zero`];

    throw new TypeError(`${name} takes ${keys.join(', ')} alone: ${terms.join(', ')}`);
  }
}

function assertRoutePreset(route, preset) {
  const name = `config.rateLimit.routes.${route}`;

  return route === REPORT_ROUTE
    ? assertPreset(preset, REPORT_KEYS, name)
    : assertRouteLimit(preset, name);
}

// At the start: a limit nobody can read would only show itself as a route nobody limits, or as a 500 on its first request.
export function assertRateLimitConfig(rateLimitConfig) {
  if (!isObject(rateLimitConfig?.tiers) || !isObject(rateLimitConfig.routes) || !isObject(rateLimitConfig.routes[REPORT_ROUTE])) {
    throw new TypeError(`assertRateLimitConfig(rateLimitConfig) requires config.rateLimit with tiers and routes, ${REPORT_ROUTE} among them`);
  }

  TIER_NAMES.forEach((tier) => assertPreset(rateLimitConfig.tiers[tier], TIER_KEYS, `config.rateLimit.tiers.${tier}`));
  Object.entries(rateLimitConfig.routes).forEach(([route, preset]) => assertRoutePreset(route, preset));
  COUNT_KEYS.forEach((key) => assertCount(rateLimitConfig[key], `config.rateLimit.${key}`));

  if (!isBan(rateLimitConfig.ban) || !isPositiveDuration(rateLimitConfig.reportWindow)) {
    throw new TypeError('config.rateLimit requires ban to be null or an integer not below zero, and reportWindow a duration above zero');
  }

  return true;
}

export function toPluginBan(ban) {
  return ban === null
    ? NO_BAN
    : ban;
}

// The options @fastify/rate-limit takes from config.rateLimit of a route: they are merged over those of the plugin, so a
// key the route does not name is left out rather than given as undefined. The window stays as written, for the reports.
export function toRouteLimit(limit, rateLimitConfig) {
  if (limit === false) {
    return false;
  }

  return {
    max: limit.max,
    window: limit.window,
    timeWindow: convertStringToMs(limit.window),
    ban: toPluginBan(limit.ban === undefined
      ? rateLimitConfig.ban
      : limit.ban),
    ...(limit.key !== undefined && { keyGenerator: limit.key }),
  };
}
