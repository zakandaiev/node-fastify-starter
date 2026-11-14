import { createContext } from '#core/context/index.js';
import { createDb } from '#core/db/index.js';
import fp from 'fastify-plugin';

// The pool opens no connection until the first statement, so the app is built without a database.
// Whether the database is there and fit is checked by the entrypoint, with db.verify(), before it listens.
async function useDb(fastify) {
  const db = createDb(fastify.config.db);

  fastify.decorate('db', db);
  fastify.context = createContext({ ...fastify.context, db });
  fastify.addHook('onClose', () => db.close());
}

export default fp(useDb, { name: 'db' });
