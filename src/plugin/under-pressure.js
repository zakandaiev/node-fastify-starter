import { postLogError } from '#src/controller/v1/log.js';
import { getRequestContext } from '#src/service/request.js';
import fastifyUnderPressure from '@fastify/under-pressure';

export default async function useUnderPressure(fastify) {
  const retryAfter = 60;
  const message = 'Service unavailable';
  const messageCode = 'SERVICE_UNAVAILABLE_ERROR';

  await fastify.register(fastifyUnderPressure, {
    maxEventLoopDelay: 1000,
    maxEventLoopUtilization: 0.8,
    retryAfter,
    message,
    pressureHandler: (request, reply, type, value) => {
      const payload = {
        url: `${request.protocol}://${request.host}${request.url}`,
        error: {
          message,
          type,
          value,
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
        ...request,
        body: {
          ...payload,
          title: `⚠️ *${message}*`,
        },
      });

      reply
        .status(503)
        .header('Retry-After', String(retryAfter));

      return {
        status: 'error',
        message,
        data: messageCode,
      };
    },
  });
}
