import { createAppConfig } from '#config/app.js';
import { createDbConfig } from '#config/db.js';
import { createLoggerConfig } from '#config/logger.js';

export function createConfig(env) {
  if (!env?.APP_MODE) {
    throw new TypeError('createConfig(env) requires the result of initEnv()');
  }

  return Object.freeze({
    app: createAppConfig(env),
    db: createDbConfig(env),
    logger: createLoggerConfig(env),
  });
}
