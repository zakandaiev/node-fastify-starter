import { readArgs } from '#config/arg.js';
import { initEnv } from '#config/env.js';
import { createConfig } from '#config/index.js';
import { buildApp } from './app.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];

const config = createConfig(initEnv());
const args = readArgs(['port', 'host']);
const fastify = await buildApp({ config });

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) {
    return false;
  }

  isShuttingDown = true;
  fastify.log.info({ signal }, 'Server is shutting down');

  try {
    await fastify.close();
  } catch (err) {
    fastify.log.error({ err }, 'Server failed to shut down cleanly');
    process.exitCode = 1;
  }

  return true;
}

try {
  await fastify.listen({ ...config.app.listen, ...args });

  const { name, version, mode } = config.app;
  fastify.log.info({ app: { name, version, mode } }, 'Server started');

  SHUTDOWN_SIGNALS.forEach((signal) => {
    process.on(signal, () => shutdown(signal));
  });
} catch (err) {
  fastify.log.fatal({ err }, 'Server failed to start');
  process.exitCode = 1;
  await fastify.close();
}
