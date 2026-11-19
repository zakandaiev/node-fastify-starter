function readCacheRedis(env) {
  if (!env.APP_CACHE_REDIS_HOST) {
    return null;
  }

  return Object.freeze({
    host: env.APP_CACHE_REDIS_HOST,
    port: env.APP_CACHE_REDIS_PORT,
    username: env.APP_CACHE_REDIS_USER ?? null,
    password: env.APP_CACHE_REDIS_PASSWORD ?? null,
  });
}

export function createRedisConfig(env) {
  return Object.freeze({
    host: env.APP_REDIS_HOST,
    port: env.APP_REDIS_PORT,
    username: env.APP_REDIS_USER ?? null,
    password: env.APP_REDIS_PASSWORD ?? null,

    // A Redis of its own for the cache, or null: the cache then lives in the main one.
    cache: readCacheRedis(env),

    // What the app keeps in Redis belongs to its database: two deployments that share a Redis must not read
    // each other's cache, table versions or sessions, so they must not share the name of their database either.
    keyPrefix: `${env.APP_NAME}:${env.APP_DATABASE_NAME}:`,

    connectTimeout: '10s',
    commandTimeout: '1s',

    // A connection that has not answered a command for this long is torn down: a Redis that hangs would otherwise
    // stay "ready", and every command would wait the whole commandTimeout until TCP keepalive gives up, in minutes.
    socketTimeout: '2s',

    // ioredis counts the attempts from the last "ready": a linear step with a low ceiling, so a Redis that is back
    // is not left unused for minutes.
    reconnectStep: '0.5s',
    reconnectMaxDelay: '5s',

    // How long a Redis that loads its data is waited for between two checks: also how long that wait may hold
    // a process that is closing.
    loadingRetryMaxDelay: '1s',

    // A Redis that is up but refuses commands (MISCONF, OOM, READONLY) would log every failed command: one line
    // of a kind in this window, the rest counted into the next one.
    failureLogWindow: '1m',
  });
}
