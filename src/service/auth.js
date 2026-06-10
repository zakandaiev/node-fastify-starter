import { fastify } from '#core/server.js';
import { isFunction } from '#src/util/misc.js';

export function generateAccessToken(payload = {}, options = {}) {
  if (!isFunction(fastify.jwt?.sign)) {
    return null;
  }

  return fastify.jwt.sign(
    {
      tokenType: 'access',
      ...payload,
    },
    {
      expiresIn: process.env.APP_JWT_ACCESS_TTL,
      ...options,
    },
  );
}

export function generateRefreshToken(payload = {}, options = {}) {
  if (!isFunction(fastify.jwt?.refresh?.sign)) {
    return null;
  }

  return fastify.jwt.refresh.sign(
    {
      tokenType: 'refresh',
      ...payload,
    },
    {
      expiresIn: process.env.APP_JWT_REFRESH_TTL,
      ...options,
    },
  );
}
