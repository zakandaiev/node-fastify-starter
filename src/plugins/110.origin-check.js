import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { readRequestOrigin } from '#utils/header.js';
import fp from 'fastify-plugin';

const MUTATING_METHODS = Object.freeze([HTTP_METHOD.POST, HTTP_METHOD.PUT, HTTP_METHOD.PATCH, HTTP_METHOD.DELETE]);

// Every mutating request, whatever its path: the router matches the decoded path, and a condition on "/api" would let
// "/%61pi/..." through. One without Origin and Referer is let through: only a browser can be made to send a request
// with the cookies of its user, and a browser sends Origin.
async function refuseForeignOrigin(request) {
  if (!MUTATING_METHODS.includes(request.method)) {
    return false;
  }

  const origin = readRequestOrigin(request.headers);

  if (origin === null || request.server.config.cors.allowedOrigins.includes(origin)) {
    return false;
  }

  throw new AppError(ERROR_CODE.ORIGIN_ERROR);
}

async function useOriginCheck(fastify) {
  fastify.addHook('onRequest', refuseForeignOrigin);
}

export default fp(useOriginCheck, { name: 'origin-check' });
