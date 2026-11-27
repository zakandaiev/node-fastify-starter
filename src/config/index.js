import { createAlertConfig } from '#config/alert.js';
import { createAppConfig } from '#config/app.js';
import { createAuthConfig } from '#config/auth.js';
import { createCacheConfig } from '#config/cache.js';
import { createCorsConfig } from '#config/cors.js';
import { createDbConfig } from '#config/db.js';
import { createHttpConfig } from '#config/http.js';
import { createLoggerConfig } from '#config/logger.js';
import { createOauthConfig } from '#config/oauth.js';
import { createRateLimitConfig } from '#config/rate-limit.js';
import { createRedisConfig } from '#config/redis.js';
import { createUploadConfig } from '#config/upload.js';

export function createConfig(env) {
  if (!env?.APP_MODE) {
    throw new TypeError('createConfig(env) requires the result of initEnv()');
  }

  return Object.freeze({
    app: createAppConfig(env),
    cors: createCorsConfig(env),
    rateLimit: createRateLimitConfig(),
    db: createDbConfig(env),
    redis: createRedisConfig(env),
    cache: createCacheConfig(),
    auth: createAuthConfig(env),
    oauth: createOauthConfig(env),
    http: createHttpConfig(),
    upload: createUploadConfig(),
    alert: createAlertConfig(env),
    logger: createLoggerConfig(env),
  });
}
