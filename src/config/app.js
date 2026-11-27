import { MODE } from '#config/env.js';

export function createAppConfig(env) {
  return Object.freeze({
    mode: env.APP_MODE,
    isDev: env.APP_MODE === MODE.DEV,

    name: env.APP_NAME,
    nameFormatted: env.APP_NAME_FORMATTED,
    version: env.APP_VERSION,
    author: env.APP_AUTHOR,
    repository: env.APP_REPOSITORY,
    description: env.APP_DESCRIPTION,

    protocol: env.APP_PROTOCOL,
    host: env.APP_HOST,
    url: `${env.APP_PROTOCOL}://${env.APP_HOST}`,

    listen: Object.freeze({
      host: '127.0.0.1',
      port: 4173,
    }),

    apiPrefix: '/api',
    healthPrefix: '/health',
    docsPrefix: '/docs',

    bodyLimit: 16 * 1024,
    maxParamLength: 100,

    // The whole request, its body included: one that never arrives must not hold its connection for ever, and a file
    // sent over a slow mobile link fits.
    requestTimeout: '2m',

    // A smaller answer goes as it is: compressing it costs more than it saves.
    compressMinBytes: 1024,

    // A process this busy answers 503 to every request but /health/live and the OPTIONS that CORS answers before: its
    // event loop lags behind by more than maxEventLoopDelay on average, or was busy for more than maxEventLoopUtilization
    // of the last utilizationWindow, a whole number of samples.
    pressure: Object.freeze({
      maxEventLoopDelay: '1s',
      maxEventLoopUtilization: 0.8,
      utilizationWindow: '10s',
      sampleInterval: '1s',
    }),

    validation: Object.freeze({
      maxErrors: 20,
      maxValueLength: 256,
      maxListLength: 20,
    }),

    unavailableRetryAfter: '1m',

    // A process that failed is shut down gracefully, and exits anyway once this has passed: a close that hangs
    // on a dead service must not keep a broken process up.
    fatalShutdownTimeout: '15s',
  });
}
