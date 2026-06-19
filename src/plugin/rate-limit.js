import { postLogError } from '#src/controller/v1/log.js';
import { getRequestContext } from '#src/service/request.js';
import fastifyRateLimit from '@fastify/rate-limit';

export default async function useRateLimit(fastify) {
  const timeWindow = '1m';
  const max = 100;
  const cache = 10000;
  const message = 'Rate limit exceeded';

  await fastify.register(fastifyRateLimit, {
    global: true,
    timeWindow,
    max,
    cache,
    redis: fastify?.redis,
    nameSpace: process.env.APP_RATELIMIT_CACHE_PREFIX,
    skipOnError: true,
    // allowList: (request) => !request.url.startsWith('/api/'),
    addHeaders: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
      'retry-after': true,
    },
    addHeadersOnExceeding: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
    },
    onExceeded: (request, key) => {
      const payload = {
        url: `${request.protocol}://${request.host}${request.url}`,
        error: {
          message,
          timeWindow,
          max,
          key,
        },
        app: {
          name: process.env.APP_NAME,
          version: process.env.APP_VERSION,
          mode: process.env.APP_MODE,
        },
        request: getRequestContext(request),
      };

      fastify.log.warn(payload, payload.error.message);

      postLogError({
        body: {
          ...payload,
          title: `⚠️ *${message}*`,
        },
      });
    },
  });
}
