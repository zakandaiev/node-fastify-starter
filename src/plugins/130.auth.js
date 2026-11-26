import { authenticate } from '#core/auth/authenticate.js';
import { watchRevokedSessions } from '#core/auth/registry.js';
import { AUTH_DECORATOR } from '#core/schema/route.js';
import fp from 'fastify-plugin';

// Behind the onRequest hooks of the route, of its folder and of the plugins before this one, such as the limiter: a
// request without a token is counted too, and none of those hooks reads request.user. Only the guard of scopes comes
// after it. The list is a new one: its author may share theirs between routes.
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
