export function createDbConfig(env) {
  return Object.freeze({
    host: env.APP_DATABASE_HOST,
    port: env.APP_DATABASE_PORT,
    database: env.APP_DATABASE_NAME,
    user: env.APP_DATABASE_USER,
    password: env.APP_DATABASE_PASSWORD,

    // The pools of every process (API replicas, worker) plus the migrator must stay below max_connections.
    connectionLimit: 10,
    queueLimit: 50,
    connectTimeout: '10s',

    statementTimeout: '3s',
    slowQueryThreshold: '1s',
  });
}
