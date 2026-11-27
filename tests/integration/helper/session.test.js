import { readUserScopes } from '#core/authz/scope.js';
import { getContext } from '#core/context/index.js';
import { createTestDb, SMALL_POOL } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  connectAppRedis,
  createUser,
  grantScopes,
  readAppRows,
  readAuthCookies,
  readSessionRow,
  runInApp,
  signIn,
  takeRefreshCookie,
  TEST_CLIENT,
  toBearer,
} from '#root/tests/helper/session.js';
import { sha256 } from '#utils/hash.js';
import { uuidv7, uuidVersion } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const ME_URL = '/api/v1/auth/me';
const REFRESH_URL = '/api/v1/auth/refresh';

const UUID_V7 = 7;

async function openApp(t) {
  const fastify = await testDb.buildApp({ db: SMALL_POOL });

  t.after(() => fastify.close());

  return fastify;
}

describe('a session of the tests', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => up());

  test('connectAppRedis starts the Redis of an app as its entrypoint does: until then the app has none', async (t) => {
    const fastify = await openApp(t);

    assert.equal(fastify.redis.isStarted(), false);
    assert.equal(await connectAppRedis(fastify), true);
    assert.equal(fastify.redis.isReady(), true);
  });

  test('runInApp and readAppRows work in the context of the app, on its database', async (t) => {
    const fastify = await openApp(t);

    assert.equal(runInApp(fastify, () => getContext()), fastify.context);
    assert.deepEqual(await readAppRows(fastify, 'SELECT DATABASE() AS name, :value AS value', { value: 'bound' }), [{ name: testDb.name, value: 'bound' }]);
  });

  test('createUser makes an active user with an id of its own, or the one it is told to', async (t) => {
    const fastify = await openApp(t);
    const id = uuidv7();
    const userId = await createUser(fastify);

    assert.equal(await createUser(fastify, { id, status: 'blocked' }), id);
    assert.equal(uuidVersion(userId), UUID_V7);
    assert.deepEqual(
      await readAppRows(fastify, 'SELECT id, status FROM users WHERE id IN (:ids) ORDER BY status', { ids: [id, userId] }),
      [{ id: userId, status: 'active' }, { id, status: 'blocked' }],
    );
  });

  test('grantScopes puts the user into a group of its own with the scopes, or with full access', async (t) => {
    const fastify = await openApp(t);
    const [editorId, adminId, guestId] = await Promise.all([createUser(fastify), createUser(fastify), createUser(fastify)]);
    const groupIds = [
      await grantScopes(fastify, editorId, ['users:write', 'users:read']),
      await grantScopes(fastify, adminId, [], { isSuperadmin: true }),
    ];

    assert.notEqual(groupIds[0], groupIds[1]);
    assert.deepEqual(await runInApp(fastify, () => readUserScopes(editorId)), ['users:read', 'users:write']);
    assert.deepEqual(await runInApp(fastify, () => readUserScopes(adminId)), ['*']);
    assert.deepEqual(await runInApp(fastify, () => readUserScopes(guestId)), []);
  });

  test('signIn makes a session of a new user or of the one it is given: its cookie and its Bearer header let a request in', async (t) => {
    const fastify = await openApp(t);
    const userId = await createUser(fastify);
    const first = await signIn(fastify, { userId });
    const second = await signIn(fastify, { isDev: true, client: { userAgent: null, ip: '::1' } });
    const row = await readSessionRow(fastify, first.sid);
    const [byCookie, byHeader] = await Promise.all([
      fastify.inject({ url: ME_URL, cookies: first.accessCookie }),
      fastify.inject({ url: ME_URL, headers: second.bearer }),
    ]);

    assert.equal(Object.isFrozen(TEST_CLIENT), true);
    assert.equal(first.userId, userId);
    assert.notEqual(second.userId, userId);
    assert.deepEqual(pick(row, ['id', 'user_id', 'refresh_token_hash', 'user_agent', 'ip', 'is_dev']), {
      id: first.sid,
      user_id: userId,
      refresh_token_hash: sha256(first.issued.refreshToken),
      user_agent: TEST_CLIENT.userAgent,
      ip: TEST_CLIENT.ip,
      is_dev: false,
    });
    assert.deepEqual(pick(await readSessionRow(fastify, second.sid), ['user_agent', 'ip', 'is_dev']), { user_agent: null, ip: '::1', is_dev: true });
    assert.equal(await readSessionRow(fastify, uuidv7()), null);
    assert.deepEqual(second.bearer, { authorization: `Bearer ${second.issued.accessToken}` });
    assert.deepEqual(toBearer(second.issued.accessToken), second.bearer);
    assert.deepEqual([byCookie, byHeader].map((response) => response.json().data.id), [userId, second.userId]);
  });

  test('readAuthCookies and takeRefreshCookie read what an answer sets: the cookies of sign-in by name, no other, and the one the next refresh sends', async (t) => {
    const fastify = await openApp(t);

    fastify.get('/cookies', async (request, reply) => {
      reply.setCookie('theme', 'dark').setCookie('accessToken', 'an-access-token', { path: '/api' });

      return {};
    });

    const { refreshCookie, issued } = await signIn(fastify);
    const [refreshed, other] = await Promise.all([
      fastify.inject({ method: 'POST', url: REFRESH_URL, cookies: refreshCookie }),
      fastify.inject('/cookies'),
    ]);
    const next = takeRefreshCookie(refreshed);

    assert.deepEqual(Object.keys(readAuthCookies(refreshed)).toSorted(), ['accessToken', 'hasAccess', 'hasSession', 'refreshToken']);
    assert.deepEqual(Object.keys(next), ['refreshToken']);
    assert.notEqual(next.refreshToken, issued.refreshToken);
    assert.equal((await fastify.inject({ method: 'POST', url: REFRESH_URL, cookies: next })).statusCode, 200);

    assert.deepEqual(Object.keys(readAuthCookies(other)), ['accessToken']);
    assert.equal(readAuthCookies(other).accessToken.path, '/api');
    assert.deepEqual(takeRefreshCookie(other), {});
  });
});
