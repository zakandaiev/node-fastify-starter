import { authenticateRequest } from '#core/auth/authenticate.js';
import { watchRevokedSessions } from '#core/auth/registry.js';
import { AUTH_DECORATOR } from '#core/schema/route.js';
import { CACHE_CONTROL } from '#enums/cache-control.js';
import { HEADER } from '#enums/header.js';
import fp from 'fastify-plugin';

// What a user is answered is theirs alone, also in a cache that keeps whatever it is not told not to. A handler may
// name another policy.
async function authenticate(request, reply) {
  const { user, session } = await authenticateRequest(request);

  request.user = user;
  request.session = session;
  reply.header(HEADER.CACHE_CONTROL, CACHE_CONTROL.NO_STORE);

  return true;
}

// The last of the onRequest hooks of its route, behind the limiter an earlier plugin puts there: a request without
// a token is counted too. So a hook of the route itself, or of its folder, runs before it and never reads request.user.
// The list is a new one: its author may share theirs between routes.
function guardRoute(routeOptions) {
  if (routeOptions.security?.auth === true) {
    routeOptions.onRequest = [...[routeOptions.onRequest ?? []].flat(), authenticate];
  }
}

async function useAuth(fastify) {
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('session', null);
  fastify.decorateRequest(AUTH_DECORATOR, null);
  fastify.addHook('onRoute', guardRoute);
  watchRevokedSessions(fastify.context);
}

export default fp(useAuth, { name: 'auth' });
