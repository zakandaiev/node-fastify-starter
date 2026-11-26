import { settleAlerts } from '#core/alert/index.js';
import { signInForDev } from '#core/auth/dev-login.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { GROUP_SLUG } from '#enums/group.js';
import { HEADER } from '#enums/header.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import { USER_STATUS } from '#enums/user-status.js';
import {
  accept,
  createAlertReceiver,
  readBlock,
  readTitles,
} from '#root/tests/helper/alert.js';
import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  connectAppRedis,
  openLoggedApp,
  readAppRows,
  readClaims,
  runInApp,
  TEST_CLIENT,
} from '#root/tests/helper/session.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { inspect } from 'node:util';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const DEV_ENV = Object.freeze({ APP_MODE: 'dev' });
const ADMIN_EMAIL = 'dev.admin@admin.test';

const DEV_ONLY_MESSAGE = 'signInForDev({ email, client, request }) signs in by an email alone: it runs in dev mode only, APP_MODE=dev';
const ALERT_TITLE = 'Dev sign-in';
const ALERT_MESSAGE = 'A user has signed in by an email alone, through the sign-in of dev mode';

// The request of the route, as the alert describes it.
const REQUEST = Object.freeze({
  method: 'POST',
  url: '/api/v1/auth/login-dev',
  ip: '127.0.0.1',
  id: uuidv7(),
  headers: Object.freeze({ [HEADER.USER_AGENT]: 'dev-login-test-agent' }),
});

const USER_SQL = 'SELECT id, email, email_verified_at, status FROM users WHERE email = :email';
const INSERT_USER_SQL = 'INSERT INTO users (id, email, email_verified_at, status) VALUES (:id, :email, CURRENT_TIMESTAMP(3), :status)';
const SESSIONS_SQL = 'SELECT is_dev FROM sessions WHERE user_id = :userId';
const MEMBERSHIPS_SQL = 'SELECT g.slug FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE ug.user_id = :userId';
const COUNT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM user_groups) AS memberships,
    (SELECT COUNT(*) FROM audit_logs) AS audits,
    (SELECT COUNT(*) FROM sessions) AS sessions
`;

// The state of a session that waits for a lock another session holds on a whole table, of either kind.
const TABLE_WAIT_STATE = 'Waiting for table%';
const TABLE_WAITS_SQL = `
  SELECT COUNT(*) AS total
  FROM information_schema.processlist
  WHERE db = :database AND state LIKE :state AND id <> CONNECTION_ID()
`;

// The tables belong to the file, not to its first suite: a test that is run alone by its name needs them too.
if (!testDb.skip) {
  before(async () => {
    await up();
    await up({ type: MIGRATION_TYPE.SEED });
  });
}

async function openApp(t, { env = DEV_ENV } = {}) {
  const receiver = await createAlertReceiver(t, accept);
  const { fastify } = await openLoggedApp(t, testDb, { receiver, env: { APP_ADMIN_EMAILS: ADMIN_EMAIL, ...env } });

  await connectAppRedis(fastify);

  return { fastify, receiver };
}

function signIn(fastify, email) {
  return runInApp(fastify, () => signInForDev({ email, client: TEST_CLIENT, request: REQUEST }));
}

async function readUser(fastify, email) {
  const [user = null] = await readAppRows(fastify, USER_SQL, { email });

  return user;
}

async function countRows(fastify) {
  const [counts] = await readAppRows(fastify, COUNT_SQL);

  return counts;
}

async function countTableWaits() {
  const [{ total }] = await testDb.readRows(TABLE_WAITS_SQL, { database: testDb.name, state: TABLE_WAIT_STATE });

  return total;
}

async function readAlerts(fastify, receiver) {
  await settleAlerts(fastify.redis);

  return receiver.requests.map((request) => request.body);
}

describe('signInForDev', { skip: testRedis.skip || testDb.skip }, () => {
  test('makes a user by an email with the email verified, gives a session of dev mode, and tells the admins', async (t) => {
    const { fastify, receiver } = await openApp(t);
    const issued = await signIn(fastify, ' Dev.User@Example.com ');
    const user = await readUser(fastify, 'dev.user@example.com');

    assert.deepEqual(pick(user, ['id', 'status']), { id: issued.userId, status: USER_STATUS.ACTIVE });
    assert.ok(user.email_verified_at instanceof Date);
    assert.deepEqual(await readAppRows(fastify, SESSIONS_SQL, { userId: issued.userId }), [{ is_dev: true }]);
    assert.deepEqual([issued.scopes, readClaims(issued.accessToken).sid], [[], issued.sid]);

    const [body] = await readAlerts(fastify, receiver);

    assert.deepEqual(readTitles(receiver), [ALERT_TITLE]);
    assert.deepEqual(pick(body, ['space', 'throttleClass', 'isSilent']), { space: 'internal', throttleClass: THROTTLE_CLASS.WARNING, isSilent: false });
    assert.deepEqual(readBlock(body, 'Error'), { message: ALERT_MESSAGE, userId: issued.userId });
    assert.deepEqual(pick(readBlock(body, 'Request'), ['method', 'ip', 'requestId']), { method: REQUEST.method, ip: REQUEST.ip, requestId: REQUEST.id });
    assert.equal(JSON.stringify(body).includes(issued.accessToken), false);
  });

  test('tells the admins after the commit: nothing while the row of its session waits to be written', async (t) => {
    const keeper = await testDb.openKeeper(t);
    const { fastify, receiver } = await openApp(t);

    await keeper.lockTables([TABLE.SESSIONS], 'READ');

    const running = signIn(fastify, 'held.alert@example.com');

    await waitFor(async () => (await countTableWaits()) > 0, 'the sign-in to wait for the table of sessions');

    const whileWaiting = await readAlerts(fastify, receiver);

    await keeper.release();

    const issued = await running;
    const bodies = await readAlerts(fastify, receiver);

    assert.deepEqual(whileWaiting, []);
    assert.deepEqual(bodies.map((body) => readBlock(body, 'Error').userId), [issued.userId]);
  });

  test('tells of each user once in the time of dedupe', async (t) => {
    const { fastify, receiver } = await openApp(t);
    const first = await signIn(fastify, 'twice@example.com');
    const again = await signIn(fastify, 'twice@example.com');
    const other = await signIn(fastify, 'other.dev@example.com');
    const bodies = await readAlerts(fastify, receiver);

    assert.equal(again.userId, first.userId);
    assert.deepEqual(bodies.map((body) => readBlock(body, 'Error').userId).toSorted(), [first.userId, other.userId].toSorted());
  });

  test('signs an email of APP_ADMIN_EMAILS in to the admin group, with a token of full access', async (t) => {
    const { fastify } = await openApp(t);
    const issued = await signIn(fastify, ADMIN_EMAIL);

    assert.deepEqual(await readAppRows(fastify, MEMBERSHIPS_SQL, { userId: issued.userId }), [{ slug: GROUP_SLUG.ADMIN }]);
    assert.deepEqual([issued.scopes, readClaims(issued.accessToken).scopes], [[SCOPE_ALL], [SCOPE_ALL]]);
  });

  test('refuses outside dev mode: nothing written, no alert', async (t) => {
    const { fastify, receiver } = await openApp(t, { env: {} });
    const counted = await countRows(fastify);

    await assert.rejects(signIn(fastify, 'prod@example.com'), (error) => error.constructor === Error && error.message === DEV_ONLY_MESSAGE);

    assert.deepEqual(await countRows(fastify), counted);
    assert.equal(await readUser(fastify, 'prod@example.com'), null);
    assert.deepEqual(await readAlerts(fastify, receiver), []);
  });

  test('sends no alert of a sign-in it refuses', async (t) => {
    const { fastify, receiver } = await openApp(t);
    const email = 'blocked.dev.user@example.com';

    await readAppRows(fastify, INSERT_USER_SQL, { id: uuidv7(), email, status: USER_STATUS.BLOCKED });

    const counted = await countRows(fastify);
    const error = await rejectionOf(signIn(fastify, email));

    assert.ok(error instanceof AppError && error.code === ERROR_CODE.AUTHORIZATION_ERROR, inspect(error));
    assert.deepEqual(await countRows(fastify), counted);
    assert.deepEqual(await readAlerts(fastify, receiver), []);
  });
});
