import fastifyRateLimit from '@fastify/rate-limit';

export default async function useRateLimit(fastify) {
  const redis = fastify.isRedisReady
    ? fastify.redis
    : undefined;

  await fastify.register(fastifyRateLimit, {
    global: true,
    timeWindow: '1m',
    max: 1000,
    cache: 10000,
    nameSpace: 'rate-limit:',
    skipOnError: true,
    redis,
  });
}
