import { settleAlerts } from '#core/alert/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { COOKIE } from '#enums/cookie.js';
import { GROUP_SLUG } from '#enums/group.js';
import { HEADER } from '#enums/header.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import {
  accept,
  createAlertReceiver,
  readBlock,
  readTitles,
} from '#root/tests/helper/alert.js';
import { errorBody, successBody } from '#root/tests/helper/app.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  connectAppRedis,
  openLoggedApp,
  readAppRows,
  readClaims,
  toBearer,
} from '#root/tests/helper/session.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const LOGIN_DEV_URL = '/api/v1/auth/login-dev';
const ME_URL = '/api/v1/auth/me';

const DEV_ENV = Object.freeze({ APP_MODE: 'dev' });
const ADMIN_EMAIL = 'dev.route.admin@admin.test';

const LOOPBACK = '127.0.0.1';
const FOREIGN_IP = '203.0.113.7';
const NO_STORE = 'no-store';
const ALERT_TITLE = 'Dev sign-in';

const AUTH_NAMES = Object.freeze([COOKIE.ACCESS_TOKEN, COOKIE.HAS_ACCESS, COOKIE.HAS_SESSION, COOKIE.REFRESH_TOKEN]);
const COOKIE_NAME_REGEXP = /^([^=]+)=/;

// Few on purpose: the files of the tests share the connections of one server.
const SMALL_POOL = Object.freeze({ connectionLimit: 2 });

const USER_SQL = 'SELECT id, email, email_verified_at, status FROM users WHERE email = :email';
const INSERT_USER_SQL = 'INSERT INTO users (id, email, email_verified_at, status) VALUES (:id, :email, CURRENT_TIMESTAMP(3), :status)';
const SESSIONS_SQL = 'SELECT id, ip, is_dev FROM sessions WHERE user_id = :userId';
const MEMBERSHIPS_SQL = 'SELECT g.slug FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE ug.user_id = :userId';
const SLUG_SQL = 'SELECT id FROM groups WHERE slug = :slug';
const AUDIT_SQL = 'SELECT actor_id, action, entity_type, entity_id, meta FROM audit_logs WHERE entity_id = :userId';
const COUNT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM user_groups) AS memberships,
    (SELECT COUNT(*) FROM audit_logs) AS audits,
    (SELECT COUNT(*) FROM sessions) AS sessions
`;

// The tables belong to the file, not to its first suite: a test that is run alone by its name needs them too.
if (!testDb.skip) {
  before(async () => {
    await up();
    await up({ type: MIGRATION_TYPE.SEED });
  });
}

async function openApp(t, { receiver } = {}) {
  const { fastify } = await openLoggedApp(t, testDb, {
    receiver,
    env: { ...DEV_ENV, APP_ADMIN_EMAILS: ADMIN_EMAIL },
    db: SMALL_POOL,
  });

  await connectAppRedis(fastify);

  return fastify;
}

// The dev proxy of a frontend on this machine: it keeps the Host, adds the address of its client to X-Forwarded-For
// and passes the answer back as it came.
async function createLocalProxy(t, appPort) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const forwardedFor = [request.headers[HEADER.X_FORWARDED_FOR], request.socket.remoteAddress].filter(Boolean).join(', ');
    const forwarded = http.request({
      host: LOOPBACK,
      port: appPort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, [HEADER.X_FORWARDED_FOR]: forwardedFor },
      agent: false,
    }, (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });

    request.pipe(forwarded);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  t.after(() => {
    sockets.forEach((socket) => socket.destroy());
    server.close();
  });

  server.listen(0, LOOPBACK);
  await once(server, 'listening');

  return `http://${LOOPBACK}:${server.address().port}`;
}

// A real socket on both legs: the app reads the address of the proxy from it, not from a header.
async function openProxiedApp(t, options) {
  const fastify = await openApp(t, options);

  await fastify.listen({ host: LOOPBACK, port: 0 });

  return { fastify, proxyUrl: await createLocalProxy(t, fastify.server.address().port) };
}

async function postThrough(proxyUrl, email, headers = {}) {
  const response = await fetch(`${proxyUrl}${LOGIN_DEV_URL}`, {
    method: 'POST',
    headers: { [HEADER.CONTENT_TYPE]: MEDIA_TYPE.JSON, ...headers },
    body: JSON.stringify({ email }),
  });

  return {
    status: response.status,
    cacheControl: response.headers.get(HEADER.CACHE_CONTROL),
    cookieNames: response.headers.getSetCookie().map((cookie) => COOKIE_NAME_REGEXP.exec(cookie)[1]).toSorted(),
    body: await response.json(),
  };
}

function postLoginDev(fastify, email) {
  return fastify.inject({ method: 'POST', url: LOGIN_DEV_URL, payload: { email } });
}

function getMeByBearer(fastify, accessToken) {
  return fastify.inject({ url: ME_URL, headers: toBearer(accessToken) });
}

async function readUser(fastify, email) {
  const [user = null] = await readAppRows(fastify, USER_SQL, { email });

  return user;
}

async function countRows(fastify) {
  const [counts] = await readAppRows(fastify, COUNT_SQL);

  return counts;
}

describe('POST /api/v1/auth/login-dev', { skip: testRedis.skip || testDb.skip }, () => {
  test('through a local proxy that names its client 127.0.0.1 signs in: a session of dev mode, the cookies, an access token that GET /api/v1/auth/me takes as Bearer without cookies, and an alert to the admins', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, proxyUrl } = await openProxiedApp(t, { receiver });
    const answer = await postThrough(proxyUrl, ' Dev.Route@Example.com ');
    const { id, scopes, accessToken } = answer.body.data;
    const user = await readUser(fastify, 'dev.route@example.com');
    const me = await getMeByBearer(fastify, accessToken);

    await settleAlerts(fastify.redis);

    assert.deepEqual(pick(answer, ['status', 'cacheControl', 'cookieNames']), { status: 200, cacheControl: NO_STORE, cookieNames: AUTH_NAMES.toSorted() });
    assert.deepEqual(Object.keys(answer.body.data), ['id', 'scopes', 'accessToken']);
    assert.deepEqual([user.id, user.status, scopes], [id, USER_STATUS.ACTIVE, []]);
    assert.ok(user.email_verified_at instanceof Date);
    assert.deepEqual(await readAppRows(fastify, SESSIONS_SQL, { userId: id }), [{ id: readClaims(accessToken).sid, ip: LOOPBACK, is_dev: true }]);
    assert.deepEqual(me.json(), successBody(me, { id, scopes: [] }));
    assert.equal(me.raw.req.headers[HEADER.COOKIE], undefined);
    assert.deepEqual(readTitles(receiver), [ALERT_TITLE]);
    assert.equal(readBlock(receiver.requests[0].body, 'Error').userId, id);
  });

  test('through the same proxy, a client that names a hop of another address first gets the 404 of an unknown path, and nothing is written', async (t) => {
    const { fastify, proxyUrl } = await openProxiedApp(t);
    const counted = await countRows(fastify);
    const answer = await postThrough(proxyUrl, 'foreign.route@example.com', { [HEADER.X_FORWARDED_FOR]: FOREIGN_IP });

    assert.deepEqual(pick(answer, ['status', 'cookieNames']), { status: 404, cookieNames: [] });
    assert.deepEqual(pick(answer.body, ['status', 'code', 'message']), { status: 'error', code: 'NOT_FOUND_ERROR', message: `Route POST ${LOGIN_DEV_URL} not found` });
    assert.deepEqual(await countRows(fastify), counted);
    assert.equal(await readUser(fastify, 'foreign.route@example.com'), null);
  });

  test('an email of APP_ADMIN_EMAILS signs in to the group admin, with a record of the audit that names the group by its slug and its id, and a token of full access', async (t) => {
    const fastify = await openApp(t);
    const response = await postLoginDev(fastify, ADMIN_EMAIL);
    const { id, scopes, accessToken } = response.json().data;
    const me = await getMeByBearer(fastify, accessToken);
    const [{ id: groupId }] = await readAppRows(fastify, SLUG_SQL, { slug: GROUP_SLUG.ADMIN });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(scopes, [SCOPE_ALL]);
    assert.deepEqual(await readAppRows(fastify, MEMBERSHIPS_SQL, { userId: id }), [{ slug: GROUP_SLUG.ADMIN }]);
    assert.deepEqual(await readAppRows(fastify, AUDIT_SQL, { userId: id }), [{
      actor_id: null,
      action: AUDIT_ACTION.USER_GROUP_GRANT,
      entity_type: TABLE.USERS,
      entity_id: id,
      meta: { group: GROUP_SLUG.ADMIN, groupId },
    }]);
    assert.deepEqual(me.json(), successBody(me, { id, scopes: [SCOPE_ALL] }));
  });

  test('a user that is there signs in to that account, and a blocked one is refused with 403 and no session', async (t) => {
    const fastify = await openApp(t);
    const [knownId, blockedId] = [uuidv7(), uuidv7()];

    await readAppRows(fastify, INSERT_USER_SQL, { id: knownId, email: 'known.route@example.com', status: USER_STATUS.ACTIVE });
    await readAppRows(fastify, INSERT_USER_SQL, { id: blockedId, email: 'blocked.route@example.com', status: USER_STATUS.BLOCKED });

    const known = await postLoginDev(fastify, 'Known.Route@Example.com');
    const blocked = await postLoginDev(fastify, 'blocked.route@example.com');

    assert.deepEqual([known.statusCode, known.json().data.id], [200, knownId]);
    assert.equal(blocked.statusCode, 403);
    assert.deepEqual(blocked.json(), errorBody(blocked, 'AUTHORIZATION_ERROR', 'Authorization error'));
    assert.equal(blocked.headers[HEADER.SET_COOKIE], undefined);
    assert.deepEqual(await readAppRows(fastify, SESSIONS_SQL, { userId: blockedId }), []);
  });
});
