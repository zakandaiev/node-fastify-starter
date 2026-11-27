import { REDIS_FAILURE, runRedisSafely } from '#core/redis/index.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { isFunction, isNonEmptyString, isPositiveInteger } from '#utils/type.js';
import LocalStore from '@fastify/rate-limit/store/LocalStore.js';
import RedisStore from '@fastify/rate-limit/store/RedisStore.js';

const COUNT_FAILED_MESSAGE = 'Rate limit could not count in Redis: the process counts in memory';
const ROUTE_SEPARATOR = ' ';
const NAMESPACE_SEPARATOR = ':';
const PATH_SEPARATOR = '/';

// Methods that read the one resource: a HEAD twin counts with the route it was made for.
const READ_METHODS = Object.freeze([HTTP_METHOD.GET, HTTP_METHOD.HEAD]);

function increment(store, key, timeWindow, max) {
  return new Promise((resolve, reject) => {
    store.incr(key, (error, result) => (error ? reject(error) : resolve(result)), timeWindow, max);
  });
}

// A Redis that is not ready is not asked, so a client nobody started is never started by a request: the process counts
// in memory until Redis is back, and a counter lives on in each process instead of in all of them.
async function count(redis, store, [key, timeWindow, max]) {
  const counted = await runRedisSafely(() => increment(store.inRedis, key, timeWindow, max), COUNT_FAILED_MESSAGE, { redis });

  return counted === REDIS_FAILURE
    ? increment(store.inMemory, `${store.namespace}${key}`, timeWindow, max)
    : counted;
}

// The plugin hands a callback in and nobody holds this promise: it never rejects, an error goes to the callback.
async function countRequest(redis, store, args, callback) {
  let result = null;

  try {
    result = await count(redis, store, args);
  } catch (error) {
    callback(error, null);

    return false;
  }

  callback(null, result);

  return true;
}

// A route whose methods hold GET counts under GET: Fastify makes its HEAD twin with the method HEAD alone. The "/" of a
// prefix is served with and without the slash, and the twin of the second spelling must meet the first.
function readRouteNamespace({ method, url }) {
  const methods = [method].flat();
  const countedMethod = methods.some((name) => READ_METHODS.includes(name))
    ? HTTP_METHOD.GET
    : methods.join();
  const countedUrl = url.length > PATH_SEPARATOR.length && url.endsWith(PATH_SEPARATOR)
    ? url.slice(0, -PATH_SEPARATOR.length)
    : url;

  return `${countedMethod}${ROUTE_SEPARATOR}${countedUrl}${NAMESPACE_SEPARATOR}`;
}

// The store @fastify/rate-limit builds with "new", and a child for each route with a limit of its own. The one in memory
// is shared by the root and its children, so its ceiling of entries is that of the process.
export function createLimitStore(options) {
  const { redis, namespace, memoryMaxEntries } = options ?? {};

  if (!isFunction(redis?.isReady) || !redis.client || !isNonEmptyString(namespace) || !isPositiveInteger(memoryMaxEntries)) {
    throw new TypeError('createLimitStore({ redis, namespace, memoryMaxEntries }) requires a client of createRedis(), a namespace and a ceiling of counters in memory');
  }

  return class LimitStore {
    constructor(params, {
      ownNamespace = namespace,
      memory = new LocalStore(params.continueExceeding, params.exponentialBackoff, memoryMaxEntries),
    } = {}) {
      this.namespace = ownNamespace;
      this.inRedis = new RedisStore(params.continueExceeding, params.exponentialBackoff, redis.client, ownNamespace);
      this.inMemory = memory;
    }

    incr(key, callback, timeWindow, max) {
      countRequest(redis, this, [key, timeWindow, max], callback);
    }

    child(params) {
      return new LimitStore(params, { ownNamespace: `${this.namespace}${readRouteNamespace(params.routeInfo)}`, memory: this.inMemory });
    }
  };
}
