import { handleError, handleNotFound } from '#core/error/handler.js';
import { loadUniqueFields } from '#core/schema/unique.js';
import fp from 'fastify-plugin';

// The first plugin on purpose: a route keeps the error handler its scope had when its plugin was loaded,
// so a plugin loaded earlier that declares a route (cors does) would leave it on the handler of Fastify.
async function useErrorHandler(fastify) {
  fastify.decorate('uniqueFields', await loadUniqueFields());
  fastify.setErrorHandler(handleError);
  fastify.setNotFoundHandler(handleNotFound);
}

export default fp(useErrorHandler, { name: 'error-handler' });
