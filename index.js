import '#root/bootstrap.js';
// BOOTSTRAP FIRST IS REQUIRED

import { fastify, start } from '#core/server.js';

// START THE SERVER
try {
  await start();
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
