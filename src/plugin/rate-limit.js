import fastifyRateLimit from '@fastify/rate-limit';

async function useRateLimit(fastify) {
  const redis = fastify.isRedisReady
    ? fastify.redis
    : undefined;

  await fastify.register(fastifyRateLimit, {
    global: true,
    max: 100,
    timeWindow: '1m',
    cache: 10000,
    nameSpace: 'rate-limit:',
    skipOnError: true,
    redis,
  });
}

export default useRateLimit;
