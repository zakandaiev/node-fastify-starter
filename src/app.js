import { absPath } from '#config/path.js';
import { createContext } from '#core/context/index.js';
import { assertErrorConfig, handleClientError, handleError } from '#core/error/handler.js';
import { createSchemaErrorFormatter } from '#core/error/validation.js';
import { createLogger } from '#core/logger/index.js';
import { createRouteHook } from '#core/schema/route.js';
import { buildValidator } from '#core/schema/validator.js';
import { assertDurations, convertStringToMs } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import autoload from '@fastify/autoload';
import Fastify, { LogController } from 'fastify';

// A literal on purpose: a numeric trustProxy (hop count) trusts nobody in Fastify 5,
// and request.ip becomes the address of the proxy.
const TRUST_PROXY = 'loopback,uniquelocal';

const REQUEST_ID_LOG_LABEL = 'requestId';

// Zero is no timeout to Node.
const DURATION_KEYS = Object.freeze(['requestTimeout']);

// Autoload gives the path relative to its directory, with a leading slash: "includes" also catches a nested "_" entry.
const IGNORED_PATH_FRAGMENT = '/_';
const ROUTE_IGNORE_PATTERN = /(controller|\.test)\.js$/;

function createFastify(config) {
  return Fastify({
    loggerInstance: createLogger(config.logger),
    logController: new LogController({ requestIdLogLabel: REQUEST_ID_LOG_LABEL }),
    genReqId: () => uuidv7(),
    trustProxy: TRUST_PROXY,
    // Fastify turns the default one of Node off, and a request that never arrives would hold its connection for good.
    requestTimeout: convertStringToMs(config.app.requestTimeout),
    bodyLimit: config.app.bodyLimit,
    routerOptions: {
      maxParamLength: config.app.maxParamLength,
    },
    schemaController: {
      compilersFactory: {
        buildValidator,
      },
    },
    schemaErrorFormatter: createSchemaErrorFormatter(config.app.validation.maxErrors),
    frameworkErrors: handleError,
    clientErrorHandler: handleClientError,
  });
}

async function loadPlugins(fastify) {
  await fastify.register(autoload, {
    dir: absPath.plugin,
    ignoreFilter: IGNORED_PATH_FRAGMENT,
  });
}

async function loadRoutes(fastify) {
  await fastify.register(autoload, {
    dir: absPath.route,
    dirNameRoutePrefix: true,
    ignoreFilter: IGNORED_PATH_FRAGMENT,
    ignorePattern: ROUTE_IGNORE_PATTERN,
    options: {
      prefix: fastify.config.app.apiPrefix,
    },
  });
}

// An onClose hook that rejects must not replace the error that stopped the start.
async function closeQuietly(fastify) {
  try {
    await fastify.close();
  } catch (err) {
    fastify.log.error({ err }, 'Failed to close the app after a failed start');
  }
}

export async function buildApp({ config } = {}) {
  if (!config) {
    throw new TypeError('buildApp({ config }) requires the result of createConfig()');
  }

  assertErrorConfig(config.app);
  assertDurations(config.app, DURATION_KEYS, 'config.app');

  // Created before the instance: a prefix it refuses must not leave an open instance behind.
  const checkRoute = createRouteHook(config.app, { upload: config.upload });
  const fastify = createFastify(config);

  fastify.decorate('config', config);
  fastify.decorate('context', createContext({ config, log: fastify.log }));

  // Before the first plugin: a route declared earlier than the hook is never checked.
  fastify.addHook('onRoute', checkRoute);

  try {
    await loadPlugins(fastify);
    await loadRoutes(fastify);
  } catch (error) {
    // A failed registration poisons the instance: every later register() and ready() rejects with the same error.
    await closeQuietly(fastify);

    throw error;
  }

  return fastify;
}
