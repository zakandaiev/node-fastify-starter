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

    // Where a browser request may come from: the host of its Origin, or of its Referer without one. Read as a browser
    // writes it, so a default port in APP_HOST ("app.example.com:443") is left out the same way.
    allowedHosts: Object.freeze([new URL(`${env.APP_PROTOCOL}://${env.APP_HOST}`).host]),

    listen: Object.freeze({
      host: '127.0.0.1',
      port: 4173,
    }),

    apiPrefix: '/api',
    healthPrefix: '/health',
    docsPrefix: '/docs',

    bodyLimit: 16 * 1024,
    maxParamLength: 100,

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
