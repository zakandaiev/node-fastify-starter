import '#root/bootstrap.js';
// BOOTSTRAP FIRST IS REQUIRED

import { fastify, startServer } from '#core/server.js';

// START THE SERVER
try {
  await startServer();
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
