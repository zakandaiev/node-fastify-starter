import { createContext, runInContext } from '#core/context/index.js';
import { HEADER } from '#enums/header.js';
import fp from 'fastify-plugin';

async function useContext(fastify) {
  // A callback hook on purpose: the hooks and the handler that follow run inside done(), so the context covers them.
  // An async hook would leave the context as soon as its promise settles. What runs from a socket event stays
  // outside: stream callbacks of a body parser, onRequestAbort, onTimeout - there request.log is the logger.
  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header(HEADER.REQUEST_ID, request.id);

    runInContext(createContext({
      ...fastify.context,
      log: request.log,
      requestId: request.id,
    }), done);
  });
}

export default fp(useContext, { name: 'context' });
