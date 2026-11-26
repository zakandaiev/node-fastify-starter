import { authenticate } from '#core/auth/authenticate.js';
import { assertScopeRequirement, isRequirementMet } from '#core/authz/match.js';
import { AppError } from '#core/error/index.js';
import { SCOPES_DECORATOR } from '#core/schema/route.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { freezeDeep } from '#utils/object.js';
import { isString } from '#utils/type.js';
import fp from 'fastify-plugin';

const GUARD_SIGNATURE = 'fastify.guard.scope(requirement)';

// A guard put on a route by hand may meet a request nobody has signed in yet: it signs it in first, so it never
// lets a guest through. A copy is kept: the list its author passed may change later.
function createScopeGuard(requirement) {
  const terms = freezeDeep(structuredClone(requirement));

  async function guardScopes(request, reply) {
    if (!request.user) {
      await authenticate(request, reply);
    }

    if (!isRequirementMet(request.user.scopes, terms)) {
      throw new AppError(ERROR_CODE.AUTHORIZATION_ERROR);
    }

    return true;
  }

  return guardScopes;
}

// Behind the hook of the auth plugin, which an earlier onRoute hook has put last: request.user is there by then. The
// route hook has checked the scopes already. The list is a new one: its author may share theirs between routes.
function guardRoute(routeOptions) {
  const scopes = routeOptions.security?.scopes;

  if (scopes !== undefined) {
    routeOptions.onRequest = [...[routeOptions.onRequest ?? []].flat(), createScopeGuard(scopes)];
  }
}

function guardScope(requirement) {
  const listed = isString(requirement)
    ? [requirement]
    : requirement;

  assertScopeRequirement(listed, GUARD_SIGNATURE);

  return createScopeGuard(listed);
}

async function useGuard(fastify) {
  fastify.decorateRequest(SCOPES_DECORATOR, null);
  fastify.decorate('guard', Object.freeze({ auth: authenticate, scope: guardScope }));
  fastify.addHook('onRoute', guardRoute);
}

export default fp(useGuard, { name: 'guard' });
