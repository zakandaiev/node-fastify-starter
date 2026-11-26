import { issueTokens } from '#core/auth/token.js';
import { createContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import { createRouteHook } from '#core/schema/route.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import useErrorHandler from '#root/src/plugins/000.error-handler.js';
import useContext from '#root/src/plugins/010.context.js';
import useRedis from '#root/src/plugins/020.redis.js';
import useDb from '#root/src/plugins/030.db.js';
import useCookie from '#root/src/plugins/090.cookie.js';
import useJwt from '#root/src/plugins/100.jwt.js';
import { describeAnswer, errorBody } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import {
  buildDownApp,
  connectAppRedis,
  createMarkedRedisEnv,
  runInApp,
  toBearer,
} from '#root/tests/helper/session.js';
import { successEnvelope } from '#schemas/common/envelope.js';
import { mapSeries } from '#utils/async.js';
import { nowUtc } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import Fastify from 'fastify';
import assert from 'node:assert/strict';

export const NO_STORE = 'no-store';
export const BEARER = 'Bearer';
export const REVOKED_MARK = '0';

export const UNAUTHENTICATED = Object.freeze({
  statusCode: 401,
  code: 'AUTHENTICATION_ERROR',
  message: 'Authentication error',
  challenge: BEARER,
});
export const REVOKED = Object.freeze({
  statusCode: 401,
  code: 'SESSION_REVOKED',
  message: 'Session revoked',
  challenge: BEARER,
});
export const FORBIDDEN = Object.freeze({ statusCode: 403, code: 'AUTHORIZATION_ERROR', message: 'Authorization error' });
export const UNAVAILABLE = Object.freeze({
  statusCode: 503,
  code: 'SERVICE_UNAVAILABLE_ERROR',
  message: 'Service unavailable',
  retryAfter: '60',
});

// A route under the API prefix needs a response schema: this one is of what the handler of countCalls() answers.
export const DONE_SCHEMA = Object.freeze({
  response: { 200: successEnvelope({ type: 'object', properties: { isDone: { type: 'boolean' } } }) },
});

const PLUGINS_BEFORE_AUTH = Object.freeze([useErrorHandler, useContext, useRedis, useDb, useCookie, useJwt]);

// Redis up and the database down: a valid token passes the guards, and a route that asks the database fails.
export async function buildOpenApp(t, { marks, env, ...sections } = {}) {
  const fastify = await buildDownApp(t, { ...sections, env: { ...(await createMarkedRedisEnv(t, marks)), ...env } });

  await connectAppRedis(fastify);

  return fastify;
}

// Not the app of the tests: after the JWT plugin come the plugins a test lines up, its own before the auth plugin or
// between it and the guard.
export async function buildPluginApp(t, plugins) {
  const config = createTestConfig({ env: { ...(await createMarkedRedisEnv(t)), ...(await createDownEnv()) } });
  const fastify = Fastify({ loggerInstance: createLogger(config.logger), genReqId: () => uuidv7() });

  t.after(() => fastify.close());
  fastify.decorate('config', config);
  fastify.decorate('context', createContext({ config, log: fastify.log }));
  fastify.addHook('onRoute', createRouteHook(config.app));
  await mapSeries([...PLUGINS_BEFORE_AUTH, ...plugins], (plugin) => fastify.register(plugin));
  await connectAppRedis(fastify);

  return fastify;
}

// No row stands behind the session: an app of buildOpenApp() takes it for a live one, one of buildDownApp() answers 503.
export function issueFor(fastify, scopes = [], { userId = uuidv7(), sid = uuidv7() } = {}) {
  const { issued } = runInApp(fastify, () => issueTokens({
    userId,
    sid,
    scopes,
    startedAt: nowUtc(),
  }));

  return {
    ...issued,
    cookies: { [COOKIE.ACCESS_TOKEN]: issued.accessToken },
    headers: toBearer(issued.accessToken),
  };
}

export function countCalls() {
  const calls = { count: 0 };

  function handler() {
    calls.count += 1;

    return { isDone: true };
  }

  return { calls, handler };
}

export function readState(request) {
  return { user: request.user, session: request.session };
}

export function leaveName(events, name) {
  async function onRequest(request) {
    events.push([name, request.user]);
  }

  return onRequest;
}

export function withoutUser(names) {
  return names.map((name) => [name, null]);
}

export function describeRefusal(response, refusal) {
  return {
    statusCode: refusal.statusCode,
    body: errorBody(response, refusal.code, refusal.message),
    retryAfter: refusal.retryAfter,
    challenge: refusal.challenge,
    cacheControl: NO_STORE,
    cookies: undefined,
  };
}

export function assertRefused(responses, refusal, names = responses.map((response, index) => index)) {
  assert.deepEqual(
    responses.map((response, index) => [names[index], describeAnswer(response)]),
    responses.map((response, index) => [names[index], describeRefusal(response, refusal)]),
  );
}

// A HEAD answer has no body: its status and its headers tell the refusal.
export function describeHeaders(response) {
  return [response.statusCode, response.headers[HEADER.CACHE_CONTROL], response.headers[HEADER.WWW_AUTHENTICATE]];
}
