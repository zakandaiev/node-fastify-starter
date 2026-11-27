import { MODE } from '#config/env.js';
import { issueTokens } from '#core/auth/token.js';
import { createContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import { createRouteHook } from '#core/schema/route.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import useErrorHandler from '#root/src/plugins/000.error-handler.js';
import useContext from '#root/src/plugins/010.context.js';
import useRedis from '#root/src/plugins/020.redis.js';
import useDb from '#root/src/plugins/030.db.js';
import useCookie from '#root/src/plugins/090.cookie.js';
import useJwt from '#root/src/plugins/100.jwt.js';
import { describeAnswer, errorBody, readRequestId } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownEnv, REFUSED_CONNECTION_CODE } from '#root/tests/helper/db.js';
import { findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
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
import { freezeDeep, pick } from '#utils/object.js';
import Fastify from 'fastify';
import assert from 'node:assert/strict';

export const NO_STORE = 'no-store';
export const BEARER = 'Bearer';
export const DEV_ENV = Object.freeze({ APP_MODE: MODE.DEV });

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
export const OUTAGE = Object.freeze({ statusCode: 500, code: 'SERVER_ERROR', message: 'Server error' });

// The one line readFailureLines() finds for a request whose route has asked the database of buildOpenApp().
export const REFUSED_CONNECTION = freezeDeep([LOG_LEVEL.ERROR, { type: 'DbError', code: REFUSED_CONNECTION_CODE, isConnectFailure: true }]);

const TOO_LARGE = Object.freeze({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE_ERROR', message: 'Payload too large' });
const MALFORMED = Object.freeze({ statusCode: 400, code: 'BAD_REQUEST_ERROR', message: 'Bad request' });

const REQUEST_FAILED_MESSAGE = 'Request failed';
const FAILURE_FIELDS = Object.freeze(['type', 'code', 'isConnectFailure']);
const GET_PREFIX = `${HTTP_METHOD.GET} `;
const FILLER = 'x';
const SPEC_PATH = '/json';

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

export function assertHeadsRefused(responses, refusal, names = responses.map((response, index) => index)) {
  assert.deepEqual(
    responses.map((response, index) => [names[index], describeHeaders(response)]),
    responses.map((response, index) => [names[index], [refusal.statusCode, NO_STORE, refusal.challenge]]),
  );
}

export function withHeaders(request, headers) {
  return { ...request, headers: { ...request.headers, ...headers } };
}

export function injectAs(fastify, { headers }, entries) {
  return Promise.all(entries.map(([, request]) => fastify.inject(withHeaders(request, headers))));
}

// Fastify gives every GET route a HEAD twin, and the guard of the route guards it too.
export function listHeadTwins(entries) {
  return entries
    .filter(([, request]) => request.method === HTTP_METHOD.GET)
    .map(([name, request]) => [`${HTTP_METHOD.HEAD} ${name.slice(GET_PREFIX.length)}`, { ...request, method: HTTP_METHOD.HEAD }]);
}

// A probe is a request and what its route answers once the guard lets it in. A HEAD twin has no body to tell its
// refusal, and a probe its route answers with 200 is refused for nothing: neither is a wrong request.
export function listWrongRequests(probes, names = Object.keys(probes)) {
  return names
    .filter((name) => probes[name][0].method !== HTTP_METHOD.HEAD && probes[name][1] !== HTTP_STATUS.OK)
    .map((name) => [`${name} that its validation refuses`, probes[name][0]]);
}

// The body holds a field its route takes: only its size or its syntax is wrong. Each entry comes with the refusal of
// the parser, which answers it once the guard lets it in.
export function listBadBodies(fastify, entries, field) {
  const tooLarge = { [field]: FILLER.repeat(fastify.config.app.bodyLimit) };
  const broken = `{"${field}":`;

  return entries.flatMap(([name, request]) => [
    [`${name} with a body over bodyLimit`, { ...request, payload: tooLarge }, TOO_LARGE],
    [`${name} with invalid JSON`, withHeaders({ ...request, payload: broken }, { [HEADER.CONTENT_TYPE]: MEDIA_TYPE.JSON }), MALFORMED],
  ]);
}

export async function probeGuard(fastify, probes, scopes, names) {
  const { headers } = issueFor(fastify, scopes);
  const responses = await Promise.all(names.map((name) => fastify.inject(withHeaders(probes[name][0], headers))));

  return responses.map((response, index) => [names[index], response.statusCode]);
}

export function expectStatuses(probes, names, passing) {
  return names.map((name) => [name, passing.includes(name)
    ? probes[name][1]
    : FORBIDDEN.statusCode]);
}

// The lines come in the order the requests failed: each answer finds its own by the id of its request.
export function readFailureLines(sink, responses) {
  const lines = findLogLines(sink, REQUEST_FAILED_MESSAGE);

  return responses.map((response) => lines
    .filter((line) => line.requestId === readRequestId(response))
    .map((line) => [line.level, pick(line.err, FAILURE_FIELDS)]));
}

export async function listDeclaredRoutes(fastify, plugin, prefix) {
  const routes = [];

  // A copy: Fastify writes the second spelling of the root of a prefix into the same options.
  fastify.addHook('onRoute', (routeOptions) => routes.push({ ...routeOptions }));
  await fastify.register(plugin, { prefix });

  return routes;
}

// The spec of an app of DEV_ENV: another mode serves no docs.
export function readSpec(fastify) {
  return fastify.inject(`${fastify.config.app.docsPrefix}${SPEC_PATH}`);
}

// Each operation of the spec under the prefix, by "METHOD /path" as the docs spell it.
export function listOperations(paths, prefix) {
  return Object.entries(paths)
    .filter(([path]) => path.startsWith(prefix))
    .flatMap(([path, operations]) => Object.entries(operations).map(([method, operation]) => [`${method.toUpperCase()} ${path}`, operation]));
}

export async function readDocumentedOperations(t, prefix) {
  const response = await readSpec(await buildDownApp(t, { env: DEV_ENV }));

  assert.equal(response.statusCode, HTTP_STATUS.OK);

  return listOperations(response.json().paths, prefix);
}

// OpenAPI names a term of the scopes once for each way the token rides in.
export function bothWays(term) {
  return [{ cookieAuth: term }, { bearerAuth: term }];
}
