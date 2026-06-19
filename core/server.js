import { processArg } from '#core/app.js';
import { absPath } from '#core/path.js';
import { setErrorHandler, setNotFoundHandler } from '#src/service/response.js';
import { toNumber } from '#src/util/misc.js';
import fastifyAutoLoad from '@fastify/autoload';
import fastifyLib from 'fastify';

export const fastify = fastifyLib({
  ajv: {
    customOptions: {
      allErrors: true,
    },
  },
  logger: {
    level: process.env.APP_LOG_LEVEL || 'info',
    ...(process.env.APP_MODE === 'dev' && {
      transport: {
        target: 'pino-pretty',
      },
    }),
  },
  trustProxy: toNumber(process.env.APP_PROXY_TRUST_HOPS) || 1,
});

export async function startServer() {
  fastify.setErrorHandler(setErrorHandler);
  fastify.setNotFoundHandler(setNotFoundHandler);

  await fastify.register(fastifyAutoLoad, {
    dir: absPath.plugin,
    encapsulate: false,
    forceESM: true,
    ignoreFilter: (path) => path.startsWith('/_'),
  });

  await fastify.register(fastifyAutoLoad, {
    dir: absPath.router,
    forceESM: true,
    ignoreFilter: (path) => path.startsWith('/_'),
  });

  await fastify.listen({
    port: processArg.port || 4173,
    host: processArg.host || '0.0.0.0',
  });
}

export async function stopServer(reason, code = 0) {
  if (reason) {
    fastify.log.warn({ reason }, 'Shutdown');
  }

  try {
    await fastify.close();
    process.exit(code);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}
