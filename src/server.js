import { readArgs } from '#config/arg.js';
import { initEnv } from '#config/env.js';
import { createConfig } from '#config/index.js';
import { runInContext } from '#core/context/index.js';
import { assertMigrated } from '#core/db/migrator.js';
import { handleFatalErrors } from '#core/process/index.js';
import { buildApp } from './app.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];
const FATAL_REASON = 'fatal error';

const config = createConfig(initEnv());
const args = readArgs(['port', 'host']);
const fastify = await buildApp({ config });

let isShuttingDown = false;

async function shutdown(reason) {
  if (isShuttingDown) {
    return false;
  }

  isShuttingDown = true;
  fastify.log.info({ reason }, 'Server is shutting down');

  try {
    await fastify.close();
  } catch (err) {
    fastify.log.error({ err }, 'Server failed to shut down cleanly');
    process.exitCode = 1;
  }

  return true;
}

handleFatalErrors({
  context: fastify.context,
  shutdown: () => shutdown(FATAL_REASON),
  timeout: config.app.fatalShutdownTimeout,
});

try {
  // Redis only speeds the app up: the server starts without it, and its clients go on connecting by themselves.
  fastify.redis.connect();
  fastify.cacheRedis.connect();

  // Before the port is open: a server that cannot reach a fit database must not take traffic.
  const databaseVersion = await fastify.db.verify();

  await runInContext(fastify.context, () => assertMigrated());
  await fastify.listen({ ...config.app.listen, ...args });

  const { name, version, mode } = config.app;
  fastify.log.info({ app: { name, version, mode }, database: { version: databaseVersion } }, 'Server started');

  SHUTDOWN_SIGNALS.forEach((signal) => {
    process.on(signal, () => shutdown(signal));
  });
} catch (err) {
  fastify.log.fatal({ err }, 'Server failed to start');
  process.exitCode = 1;
  await fastify.close();
}
