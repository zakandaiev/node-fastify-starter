import { processArg } from '#core/app.js';
import { absPath } from '#core/path.js';
import { setErrorHandler, setNotFoundHandler } from '#src/util/response.js';
import fastifyAutoLoad from '@fastify/autoload';
import fastifyLib from 'fastify';

export const fastify = fastifyLib({
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

export async function startServer() {
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
    host: processArg.host || '0.0.0.0',
  });
}

export async function stopServer(reason, code = 0) {
  if (reason) {
    fastify.log.warn({ reason }, 'shutdown');
  }

  try {
    await fastify.close();
    process.exit(code);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}
