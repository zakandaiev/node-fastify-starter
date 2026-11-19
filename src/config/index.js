import { createAppConfig } from '#config/app.js';
import { createCacheConfig } from '#config/cache.js';
import { createDbConfig } from '#config/db.js';
import { createLoggerConfig } from '#config/logger.js';
import { createRedisConfig } from '#config/redis.js';

export function createConfig(env) {
  if (!env?.APP_MODE) {
    throw new TypeError('createConfig(env) requires the result of initEnv()');
  }

  return Object.freeze({
    app: createAppConfig(env),
    db: createDbConfig(env),
    redis: createRedisConfig(env),
    cache: createCacheConfig(),
    logger: createLoggerConfig(env),
  });
}
