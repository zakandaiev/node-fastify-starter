import { fastify } from '#core/server.js';
import { isFunction } from '#src/util/misc.js';

export const ALLOWED_HOSTS = [process.env.APP_HOST]
  .concat(process.env.APP_CORS_ALLOWED_HOSTS.split(','))
  .filter(Boolean)
  .map((h) => h.trim().toLowerCase());

export const ALLOWED_METHODS = process.env.APP_CORS_ALLOWED_METHODS.split(',')
  .filter(Boolean)
  .map((d) => d.trim().toUpperCase());

export const ALLOWED_DOMAINS = ALLOWED_HOSTS
  .map((h) => `https://${h}`)
  .concat(process.env.APP_MODE === 'dev' ? ALLOWED_HOSTS.map((h) => `http://${h}`) : []);

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
