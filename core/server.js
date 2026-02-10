import { processArg } from '#core/app.js';
import { absPath } from '#core/path.js';
import { setErrorHandler, setNotFoundHandler } from '#root/src/util/response.js';
import fastifyAutoLoad from '@fastify/autoload';
import fastifyLib from 'fastify';

const fastify = fastifyLib({
  ajv: {
    customOptions: {
      allErrors: true,
    },
  },
  logger: ['local', 'dev'].includes(process.env.APP_MODE)
    ? {
      transport: {
        target: 'pino-pretty',
      },
    }
    : false,
});

async function start() {
  fastify.setErrorHandler(setErrorHandler);
  fastify.setNotFoundHandler(setNotFoundHandler);

  await fastify.register(fastifyAutoLoad, {
    dir: absPath.plugin,
    encapsulate: false,
  });

  await fastify.register(fastifyAutoLoad, {
    dir: absPath.router,
  });

  await fastify.listen({
    port: processArg.port || 4173,
  });
}

async function stop() {
  await fastify.close();
}

export {
  fastify,
  start,
  stop,
};
