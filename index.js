import { fastify, startServer, stopServer } from '#core/server.js';

try {
  await startServer();
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}

process.on('SIGTERM', () => stopServer('SIGTERM', 0));
process.on('SIGINT', () => stopServer('SIGINT', 0));
