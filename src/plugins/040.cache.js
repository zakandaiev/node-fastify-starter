import { watchCacheOutage } from '#core/cache/index.js';
import { runInContext } from '#core/context/index.js';
import fp from 'fastify-plugin';

const SHARED_MESSAGE = 'Cache lives in the main Redis: it must run with noeviction and memory to spare';
const OWN_MESSAGE = 'Cache uses a Redis of its own';

function reportOutage(fastify, redis, outage) {
  fastify.log.warn({ cache: outage }, `${redis.label} is down: the cache is off and reads go to the database`);

  return true;
}

function reportRecovery(fastify, redis, outage) {
  fastify.log.info({ cache: outage }, `${redis.label} is back after a reported outage`);

  return true;
}

// One line at the start says where the cache lives. Its Redis is watched in both cases: an outage takes no request
// down, so nothing else would tell of it. The reports run in the context of the app as it is when they fire,
// with the services of the later plugins in it.
async function useCache(fastify) {
  const { redis, cacheRedis, config } = fastify;

  fastify.log.info({ cache: { redis: cacheRedis.address } }, cacheRedis === redis
    ? SHARED_MESSAGE
    : OWN_MESSAGE);

  const watchdog = watchCacheOutage(cacheRedis, {
    after: config.cache.outageAlertAfter,
    log: fastify.log,
    onOutage: (outage) => runInContext(fastify.context, () => reportOutage(fastify, cacheRedis, outage)),
    onRecovery: (outage) => runInContext(fastify.context, () => reportRecovery(fastify, cacheRedis, outage)),
  });

  fastify.addHook('onClose', () => watchdog.stop());
}

export default fp(useCache, { name: 'cache' });
