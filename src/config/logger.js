import { MODE } from '#config/env.js';

export function createLoggerConfig(env) {
  return Object.freeze({
    level: 'info',
    isPretty: env.APP_MODE === MODE.DEV,
  });
}
