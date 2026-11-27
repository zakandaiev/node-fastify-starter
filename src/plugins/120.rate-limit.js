import { alert } from '#core/alert/index.js';
import { readRouteName } from '#core/alert/message.js';
import { isInternalRequest } from '#core/auth/client.js';
import { AppError } from '#core/error/index.js';
import {
  assertRateLimitConfig,
  readLimitKey,
  readLimitTier,
  toPluginBan,
  toRouteLimit,
} from '#core/rate-limit/index.js';
import { createLimitStore } from '#core/rate-limit/store.js';
import { RATE_LIMIT_DECORATOR } from '#core/schema/route.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import { convertMsToWholeSeconds, convertStringToMs } from '#utils/date.js';
import { readLru, writeLru } from '#utils/lru.js';
import { isFunction, isObject } from '#utils/type.js';
import fastifyRateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';

const NAMESPACE = 'rate-limit:';

const EXCEEDED = Object.freeze({ kind: 'rate-limit-exceeded', title: 'Rate limit exceeded' });
const BANNED = Object.freeze({ kind: 'rate-limit-ban', title: 'Rate limit ban reached' });
const KEY_SEPARATOR = ':';

// The max a function of the route gave the request it counted: the report must not ask the function again, which may
// be async and may fail where nobody holds it.
const APPLIED_MAX = Symbol('applied max');

// Retry-After goes with the error alone; the counters of a client are no business of its answers.
const NO_HEADERS = Object.freeze({
  'x-ratelimit-limit': false,
  'x-ratelimit-remaining': false,
  'x-ratelimit-reset': false,
  [HEADER.RETRY_AFTER]: false,
});

// A ban is no other answer than an excess: the 403 of the plugin would read as the end of a session to the frontend.
function buildLimitError(request, context) {
  return new AppError(ERROR_CODE.RATE_LIMIT_ERROR, { headers: { [HEADER.RETRY_AFTER]: String(convertMsToWholeSeconds(context.ttl)) } });
}

// The limit a request ran into: that of its route, whose max may depend on the request, or that of its tier.
function describeLimit(request, bucket, rateLimitConfig) {
  const routeLimit = request.routeOptions.config?.rateLimit;

  if (!isObject(routeLimit)) {
    const { max, window } = readLimitTier(rateLimitConfig, bucket);

    return { max, window };
  }

  return {
    max: isFunction(routeLimit.max)
      ? request[APPLIED_MAX]
      : routeLimit.max,
    window: routeLimit.window,
  };
}

// The line and the alert are one for a route and a key in reportWindow in this process, and the alert is deduped across
// processes by the same key. The key is no field name: the logger hides the value of a field whose name holds "key".
function createExcessReporter(rateLimitConfig) {
  const reported = new Map();
  const windowMs = convertStringToMs(rateLimitConfig.reportWindow);

  return function reportExcess(request, bucket, { kind, title }) {
    const route = readRouteName(request);
    const mark = [kind, route, bucket].join(KEY_SEPARATOR);
    const now = performance.now();

    if (readLru(reported, mark, now) !== undefined) {
      return false;
    }

    writeLru(reported, mark, true, { until: now + windowMs, maxEntries: rateLimitConfig.reportMaxEntries });

    const limit = describeLimit(request, bucket, rateLimitConfig);

    request.log.warn({ rateLimit: { route, bucket, ...limit } }, title);
    alert({
      title,
      dedupeKey: mark,
      error: {
        message: title,
        route,
        bucket,
        ...limit,
      },
      throttleClass: THROTTLE_CLASS.WARNING,
      request,
    });

    return true;
  };
}

function rememberMax(max) {
  return async function readAppliedMax(request, key) {
    const applied = await max(request, key);

    request[APPLIED_MAX] = applied;

    return applied;
  };
}

// Before the hook of the plugin, which reads config.rateLimit: a limit of the route has its own counters, false has none.
function limitRoute(routeOptions, rateLimitConfig) {
  const limit = routeOptions.security?.rateLimit;

  if (limit === undefined) {
    return false;
  }

  const routeLimit = toRouteLimit(limit, rateLimitConfig);

  routeOptions.config = {
    ...routeOptions.config,
    rateLimit: isFunction(routeLimit.max)
      ? { ...routeLimit, max: rememberMax(routeLimit.max) }
      : routeLimit,
  };

  return true;
}

// The hook of the plugin is put on each route, behind its own onRequest hooks and before those of auth and the guard: a
// request without a token is counted too. The limiter of a route replaces the global one, never adds to it. A store that
// fails lets the request through.
async function useRateLimit(fastify) {
  const rateLimitConfig = fastify.config.rateLimit;

  assertRateLimitConfig(rateLimitConfig);

  const reportExcess = createExcessReporter(rateLimitConfig);

  fastify.decorateRequest(RATE_LIMIT_DECORATOR, null);
  fastify.decorateRequest(APPLIED_MAX, null);
  fastify.addHook('onRoute', (routeOptions) => limitRoute(routeOptions, rateLimitConfig));

  await fastify.register(fastifyRateLimit, {
    global: true,
    store: createLimitStore({ redis: fastify.redis, namespace: NAMESPACE, memoryMaxEntries: rateLimitConfig.memoryMaxEntries }),
    keyGenerator: readLimitKey,
    max: (request, key) => readLimitTier(rateLimitConfig, key).max,
    timeWindow: (request, key) => convertStringToMs(readLimitTier(rateLimitConfig, key).window),
    ban: toPluginBan(rateLimitConfig.ban),
    // true would start the window again with every request above the limit, a ban that keeps itself up.
    continueExceeding: false,
    skipOnError: true,
    allowList: (request) => isInternalRequest(request),
    addHeaders: NO_HEADERS,
    addHeadersOnExceeding: NO_HEADERS,
    onExceeded: (request, key) => reportExcess(request, key, EXCEEDED),
    onBanReach: (request, key) => reportExcess(request, key, BANNED),
    errorResponseBuilder: buildLimitError,
  });
}

export default fp(useRateLimit, { name: 'rate-limit' });
