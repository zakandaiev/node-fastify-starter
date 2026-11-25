import { clearAuthCookies, endAuthCookies, setAuthCookies } from '#core/auth/cookie.js';
import { refreshSession } from '#core/auth/refresh.js';
import { revokeSession } from '#core/auth/session.js';
import { readRefreshToken } from '#core/auth/token.js';
import { createSchema } from '#core/schema/create-schema.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { text, uuid } from '#schemas/common/field.js';
import { freezeDeep } from '#utils/object.js';

const STATE_KEYS = Object.freeze(['id', 'scopes']);

const authState = freezeDeep({
  properties: {
    id: uuid('User id'),
    scopes: { type: 'array', items: text('Scope'), description: 'What the user may do; * is everything' },
  },
  example: {
    id: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b',
    scopes: ['users:read', 'users:write'],
  },
});

export async function getMe(request, reply) {
  return reply.ok(request.user);
}

export const getMeSchema = createSchema(authState)
  .meta({
    tags: ['Auth'],
    summary: 'Get the state of the sign-in',
    description: 'The id and the scopes the access token carries',
  })
  .response(HTTP_STATUS.OK, { data: STATE_KEYS })
  .defaultResponses()
  .build();

// reply.raw tells of a client that has gone: request.raw is destroyed after every POST read to its end.
async function rotate(request, reply) {
  try {
    return await refreshSession({
      token: readRefreshToken(request),
      request,
      isAbandoned: () => reply.raw.destroyed,
    });
  } catch (error) {
    if (error?.code === ERROR_CODE.SESSION_REVOKED) {
      clearAuthCookies(reply);
    }

    throw error;
  }
}

export async function postRefresh(request, reply) {
  const issued = await rotate(request, reply);

  setAuthCookies(reply, issued);

  return reply.ok({ id: issued.userId, scopes: issued.scopes });
}

export const postRefreshSchema = createSchema(authState)
  .meta({
    tags: ['Auth'],
    summary: 'Rotate the tokens',
    description: 'Takes the refresh token from its cookie only and sets new cookies. SESSION_REVOKED: the session is over, also because the token had been replaced before; the cookies are cleared. AUTHENTICATION_ERROR: there is no usable token, or the session has changed since it was read (another request has just rotated the token, or the session has ended); the cookies stay. 503: nothing was rotated, try again',
  })
  .response(HTTP_STATUS.OK, { data: STATE_KEYS })
  .defaultResponses()
  .build();

export async function postLogout(request, reply) {
  await revokeSession({ sid: request.session.id, userId: request.user.id });
  endAuthCookies(request, reply);

  return reply.noContent();
}

export const postLogoutSchema = createSchema(authState)
  .meta({ tags: ['Auth'], summary: 'End the current session' })
  .response(HTTP_STATUS.NO_CONTENT)
  .defaultResponses()
  .build();
