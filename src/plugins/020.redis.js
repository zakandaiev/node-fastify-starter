import { settleAlerts } from '#core/alert/index.js';
import { createContext } from '#core/context/index.js';
import { createRedis } from '#core/redis/index.js';
import fp from 'fastify-plugin';

const MAIN_LABEL = 'Redis';
const CACHE_LABEL = 'Cache Redis';

// The clients open no connection until the entrypoint calls connect(), so the app is built without Redis.
// Without a Redis of its own the cache lives in the main one: both names hold the same client then.
async function useRedis(fastify) {
  const { cache, ...main } = fastify.config.redis;
  const redis = createRedis(main, { log: fastify.log, label: MAIN_LABEL });
  const cacheRedis = cache
    ? createRedis({ ...main, ...cache }, { log: fastify.log, label: CACHE_LABEL })
    : redis;

  fastify.decorate('redis', redis);
  fastify.decorate('cacheRedis', cacheRedis);
  fastify.context = createContext({ ...fastify.context, redis, cacheRedis });
  // An alert still on its way keeps its state in the main Redis: the clients close once it has settled.
  fastify.addHook('onClose', async () => {
    await settleAlerts(redis);
    await Promise.all([redis.close(), cacheRedis.close()]);
  });
}

export default fp(useRedis, { name: 'redis' });
