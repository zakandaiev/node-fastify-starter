import useAuth from '#root/src/plugins/130.auth.js';
import { describeAnswer } from '#root/tests/helper/app.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import {
  assertRefused,
  buildOpenApp,
  buildPluginApp,
  countCalls,
  describeHeaders,
  DONE_SCHEMA,
  FORBIDDEN,
  issueFor,
  leaveName,
  NO_STORE,
  readState,
  REVOKED,
  REVOKED_MARK,
  UNAUTHENTICATED,
  withoutUser,
} from '#root/tests/helper/guard.js';
import { readAppRows, readClaims } from '#root/tests/helper/session.js';
import { uuidv7, uuidVersion } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const GUARDED = Object.freeze({ auth: true });
const GUARDED_URL = '/api/v1/guarded';
const UUID_V7 = 7;

describe('guard helper', () => {
  test('issueFor signs a token of the scopes, the user and the session it is told, or of new ids and no scope, and hands it out as a cookie and as a Bearer header', async (t) => {
    const fastify = await buildOpenApp(t);
    const userId = uuidv7();
    const sid = uuidv7();
    const told = issueFor(fastify, ['groups:read'], { userId, sid });
    const fresh = issueFor(fastify);

    assert.deepEqual(pick(told, ['userId', 'sid', 'scopes']), { userId, sid, scopes: ['groups:read'] });
    assert.deepEqual(pick(readClaims(told.accessToken), ['sub', 'sid', 'scopes']), { sub: userId, sid, scopes: ['groups:read'] });
    assert.deepEqual(told.cookies, { accessToken: told.accessToken });
    assert.deepEqual(told.headers, { authorization: `Bearer ${told.accessToken}` });
    assert.deepEqual([uuidVersion(fresh.userId), uuidVersion(fresh.sid), fresh.scopes], [UUID_V7, UUID_V7, []]);
  });

  test('buildOpenApp lets a valid token in unless its session is marked as over, and has its database down', async (t) => {
    const endedSid = uuidv7();
    const fastify = await buildOpenApp(t, { marks: { [endedSid]: REVOKED_MARK } });

    fastify.get('/guarded', { security: GUARDED }, readState);

    const alive = issueFor(fastify);
    const [served, ended] = await Promise.all([alive, issueFor(fastify, [], { sid: endedSid })].map(({ headers }) => fastify.inject({ url: '/guarded', headers })));
    const { name, code } = await rejectionOf(readAppRows(fastify, 'SELECT 1'));

    assert.deepEqual(describeHeaders(served), [200, NO_STORE, undefined]);
    assert.deepEqual(served.json(), { user: { id: alive.userId, scopes: [] }, session: { id: alive.sid } });
    assertRefused([ended], REVOKED);
    assert.deepEqual([name, code], ['DbError', 'ECONNREFUSED']);
  });

  test('buildPluginApp registers after the JWT plugin only the plugins it is given, checks the contract of a route and connects Redis', async (t) => {
    const fastify = await buildPluginApp(t, [useAuth]);
    const { calls, handler } = countCalls();

    fastify.get(GUARDED_URL, { schema: DONE_SCHEMA, security: GUARDED }, handler);

    assert.throws(() => fastify.get(`${GUARDED_URL}/untyped`, { security: GUARDED }, handler), { message: `Route GET ${GUARDED_URL}/untyped has no response schema for a 2xx or a 3xx status` });

    const [guest, user] = await Promise.all([fastify.inject(GUARDED_URL), fastify.inject({ url: GUARDED_URL, cookies: issueFor(fastify).cookies })]);

    assert.deepEqual(['jwt', 'auth', 'guard'].map((name) => fastify.hasPlugin(name)), [true, true, false]);
    assert.equal(fastify.redis.isReady(), true);
    assertRefused([guest], UNAUTHENTICATED);
    assert.deepEqual([user.statusCode, calls.count], [200, 1]);
  });

  test('assertRefused passes the answers of the refusal and fails one of another refusal under the name it is given', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get('/guarded', { security: GUARDED }, countCalls().handler);

    const guest = await fastify.inject('/guarded');

    assert.doesNotThrow(() => assertRefused([guest], UNAUTHENTICATED));
    assert.throws(() => assertRefused([guest], FORBIDDEN, ['guest']), { name: 'AssertionError', actual: [['guest', describeAnswer(guest)]] });
  });

  test('leaveName makes a hook that leaves its name and the user it meets, withoutUser what such hooks leave for a guest, and readState is the user and the session of a request', async () => {
    const events = [];
    const request = { user: { id: uuidv7(), scopes: [] }, session: { id: uuidv7() } };

    await leaveName(events, 'first')(request);
    await leaveName(events, 'second')({ user: null });

    assert.deepEqual(events, [['first', request.user], ['second', null]]);
    assert.deepEqual(withoutUser(['first', 'second']), [['first', null], ['second', null]]);
    assert.deepEqual(readState(request), request);
  });
});
