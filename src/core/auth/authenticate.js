import { isSessionAlive } from '#core/auth/registry.js';
import { readAccessToken, verifyAccessToken } from '#core/auth/token.js';
import { AppError } from '#core/error/index.js';
import { CACHE_CONTROL } from '#enums/cache-control.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { freezeDeep } from '#utils/object.js';

const CHALLENGE = freezeDeep({ headers: { [HEADER.WWW_AUTHENTICATE]: 'Bearer' } });

export async function authenticateRequest(request) {
  const claims = verifyAccessToken(readAccessToken(request));

  if (claims === null) {
    throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR, CHALLENGE);
  }

  if (!(await isSessionAlive(claims.sid))) {
    throw new AppError(ERROR_CODE.SESSION_REVOKED, CHALLENGE);
  }

  return freezeDeep({
    user: { id: claims.userId, scopes: claims.scopes },
    session: { id: claims.sid },
  });
}

// What a user is answered is theirs alone, also in a cache that keeps whatever it is not told not to. A handler may
// name another policy.
export async function authenticate(request, reply) {
  const { user, session } = await authenticateRequest(request);

  request.user = user;
  request.session = session;
  reply.header(HEADER.CACHE_CONTROL, CACHE_CONTROL.NO_STORE);

  return true;
}
