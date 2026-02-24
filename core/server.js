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
  logger: process.env.APP_MODE === 'dev'
    ? {
      transport: {
        target: 'pino-pretty',
      },
    }
    : false,
});

async function startServer() {
  fastify.setErrorHandler(setErrorHandler);
  fastify.setNotFoundHandler(setNotFoundHandler);

  await fastify.register(fastifyAutoLoad, {
    dir: absPath.plugin,
    encapsulate: false,
    forceESM: true,
    ignoreFilter: (path) => path.endsWith('.ignore.js'),
  });

  await fastify.register(fastifyAutoLoad, {
    dir: absPath.router,
    forceESM: true,
    ignoreFilter: (path) => path.endsWith('.ignore.js'),
  });

  await fastify.listen({
    port: processArg.port || 4173,
  });
}

async function stopServer() {
  await fastify.close();
}

export {
  fastify,
  startServer,
  stopServer,
};
