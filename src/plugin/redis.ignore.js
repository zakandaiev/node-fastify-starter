import { convertStringToSeconds } from '#src/util/datetime.js';
import Redis from 'ioredis';

async function useRedis(fastify) {
  const host = process.env.APP_REDIS_HOST;
  const port = process.env.APP_REDIS_PORT;
  const username = process.env.APP_REDIS_USER;
  const password = process.env.APP_REDIS_PASSWORD;

  const reconnectCooldown = 1000 * (
    convertStringToSeconds(process.env.APP_REDIS_RECONNECT_COOLDOWN)
    || 300
  );
  const reconnectDelay = 1000 * (
    convertStringToSeconds(process.env.APP_REDIS_RECONNECT_DELAY)
    || 5
  );

  const redis = new Redis({
    host,
    port,
    username,
    password,

    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,

    retryStrategy(times) {
      const delay = times % 5 === 0
        ? reconnectCooldown
        : reconnectDelay;

      const delayRoundSec = Math.round(delay / 1000);
      fastify.log.warn(`Redis reconnect retry #${times}, delaying ${delayRoundSec}s`);

      return delay;
    },
  });

  fastify.decorate('redis', redis);
  fastify.decorate('isRedisReady', false);
  fastify.addHook('onClose', () => {
    redis.disconnect();
  });

  redis.on('ready', () => {
    redis.isReady = true;
    fastify.isRedisReady = true;
    fastify.log.info('redis ready');
  });

  redis.on('close', () => {
    redis.isReady = false;
    fastify.isRedisReady = false;
    fastify.log.warn('redis connection closed');
  });

  redis.on('end', () => {
    redis.isReady = false;
    fastify.isRedisReady = false;
    fastify.log.warn('redis connection ended');
  });

  redis.on('error', (error) => {
    redis.isReady = false;
    fastify.isRedisReady = false;
    fastify.log.error({ error }, 'redis error');
  });
}

export default useRedis;
