import { authenticate } from '#core/auth/authenticate.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import { SCOPE } from '#enums/scope.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import {
  BEARER,
  buildOpenApp,
  issueFor,
  NO_STORE,
} from '#root/tests/helper/guard.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { REVOKED_MARK, toBearer } from '#root/tests/helper/session.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const CHALLENGE = Object.freeze({ [HEADER.WWW_AUTHENTICATE]: BEARER });

// Outside the contract and without security, so the auth plugin leaves its requests alone: only the call signs them in.
const PROBE_URL = '/authenticate-probe';

async function describeSignIn(request, reply) {
  const result = await authenticate(request, reply);

  return {
    result,
    user: request.user,
    session: request.session,
    isFrozen: [request.user, request.session].every((value) => isDeepFrozen(value)),
    cacheControl: reply.getHeader(HEADER.CACHE_CONTROL),
  };
}

async function describeRejection(request, reply) {
  const error = await rejectionOf(authenticate(request, reply));

  return {
    name: error.name,
    code: error.code,
    statusCode: error.statusCode,
    headers: error.headers,
    user: request.user,
    session: request.session,
    cacheControl: reply.getHeader(HEADER.CACHE_CONTROL) ?? null,
  };
}

function rejectedWith(code) {
  return {
    name: 'AppError',
    code,
    statusCode: 401,
    headers: CHALLENGE,
    user: null,
    session: null,
    cacheControl: null,
  };
}

describe('authenticate', () => {
  test('signs a request in by the cookie or the Bearer header: the user and the session of the token on the request, frozen through, no-store on the reply, and true', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get(PROBE_URL, describeSignIn);

    const {
      userId,
      sid,
      scopes,
      cookies,
      headers,
    } = issueFor(fastify, [SCOPE.GROUPS_READ, SCOPE.USERS_ALL]);
    const responses = await Promise.all([{ cookies }, { headers }].map((request) => fastify.inject({ url: PROBE_URL, ...request })));

    assert.deepEqual(responses.map((response) => [response.statusCode, response.headers['cache-control']]), [[200, NO_STORE], [200, NO_STORE]]);
    assert.deepEqual(responses.map((response) => response.json()), responses.map(() => ({
      result: true,
      user: { id: userId, scopes },
      session: { id: sid },
      isFrozen: true,
      cacheControl: NO_STORE,
    })));
  });

  test('rejects a request without a token anybody can use with AUTHENTICATION_ERROR that names the Bearer scheme, and leaves the request and the reply as they were', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get(PROBE_URL, describeRejection);

    const { refreshToken } = issueFor(fastify);
    const requests = [
      {},
      { cookies: { [COOKIE.ACCESS_TOKEN]: 'garbage' } },
      { cookies: { [COOKIE.ACCESS_TOKEN]: refreshToken } },
      { headers: toBearer(refreshToken) },
    ];
    const responses = await Promise.all(requests.map((request) => fastify.inject({ url: PROBE_URL, ...request })));

    assert.deepEqual(responses.map((response) => response.json()), requests.map(() => rejectedWith('AUTHENTICATION_ERROR')));
  });

  test('rejects a valid token of a session that is over with SESSION_REVOKED that names the Bearer scheme, and leaves the request and the reply as they were', async (t) => {
    const endedSid = uuidv7();
    const fastify = await buildOpenApp(t, { marks: { [endedSid]: REVOKED_MARK } });

    fastify.get(PROBE_URL, describeRejection);

    const { cookies, headers } = issueFor(fastify, [], { sid: endedSid });
    const responses = await Promise.all([{ cookies }, { headers }].map((request) => fastify.inject({ url: PROBE_URL, ...request })));

    assert.deepEqual(responses.map((response) => response.json()), responses.map(() => rejectedWith('SESSION_REVOKED')));
  });
});
