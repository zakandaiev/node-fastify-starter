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
    connectTimeout: '4s',

    statementTimeout: '3s',
    slowQueryThreshold: '1s',

    // How long a statement waits for a row or a table another session holds, in whole seconds, before it fails.
    lockWaitTimeout: '5s',

    // A transaction whose function has not settled by then fails, and its connection is closed: one that never
    // settles would keep a connection of the pool for good.
    transactionTimeout: '30s',

    // The first is how long a migrator waits for another one, the second how long a statement of a migration
    // file waits for a table another session holds: without it that is a day, with every query on the table behind it.
    migrationLockTimeout: '5m',
    migrationTableLockTimeout: '1m',

    // How long the connection that holds the lock of a migrator may stand idle while a file runs: the server
    // closes it after its own wait_timeout otherwise, and the lock goes with it.
    migrationIdleTimeout: '1d',
    migrationReferencePrefix: 'migration_verify_',
  });
}
