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

    bodyLimit: 16 * 1024,
  });
}
