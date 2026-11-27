import { invalidateCacheTables } from '#core/cache/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { COOKIE } from '#enums/cookie.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { SCOPE, SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { createTestDb, RETRY_MESSAGE, waitForBlockedSessions } from '#root/tests/helper/db.js';
import { DEV_ENV } from '#root/tests/helper/guard.js';
import { findLogLines } from '#root/tests/helper/log.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  assertForbidden,
  assertNoContent,
  assertNotFound,
  assertOk,
  assertProtected,
  assertRevoked,
  blockByHand,
  blockRequest,
  deleteMeRequest,
  deleteUserRequest,
  describeAudit,
  getMeRequest,
  getMembersRequest,
  getUserRequest,
  getUsersRequest,
  listMemberIds,
  LONG_AGO,
  migrateAndSeed,
  openLoggedRouteApp,
  openRouteApp,
  patchUserRequest,
  postLoginDev,
  readMemberIds,
  readStatuses,
  refresh,
  send,
  setAdminMembers,
  signInAs,
  unblockRequest,
} from '#root/tests/helper/route.js';
import {
  AUTH_COOKIES,
  createUser,
  insertGroup,
  insertIdentity,
  insertUser,
  joinGroup,
  LONG_MEMORY,
  readAppRows,
  readAudit,
  readAuthCookies,
  readClaims,
  readMemberships,
  readState,
  runInApp,
  signIn,
  takeRefreshCookie,
} from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { toDate } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import { mapValues } from '#utils/object.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();

const PROVIDER_ID = 'google';
const ROOT_PATH = '/';
const EPOCH = '1970-01-01T00:00:00.000Z';
const NO_ID = 'not-a-uuid';
const NEW_NAME = 'Renamed';
const LISTED_DOMAIN = 'admin.test';
const UNLISTED_DOMAIN = 'example.com';

// What a user may hold beyond users:manage alone: one who holds users:manage alone manages none of them.
const WIDER_HOLDINGS = Object.freeze([
  [SCOPE_ALL],
  [SCOPE.USERS_ALL],
  [SCOPE.USERS_READ],
  [SCOPE.GROUPS_READ],
  [SCOPE.USERS_MANAGE, SCOPE.GROUPS_READ],
]);

// In the order of listManagerRoutes(): the record each of its routes leaves.
const MANAGED_ACTIONS = Object.freeze([AUDIT_ACTION.USER_UPDATE, AUDIT_ACTION.USER_BLOCK, AUDIT_ACTION.USER_UNBLOCK, AUDIT_ACTION.USER_DELETE]);

// The answers to listManagerRoutes() of one who may manage the user.
const MANAGED_STATUSES = Object.freeze([200, 200, 200, 204]);

const STATUS_OF_USER_SQL = 'SELECT status FROM users WHERE id = :id';
const OWNER_SQL = 'SELECT id FROM users WHERE email = :email';
const DROP_SCOPE_SQL = 'DELETE FROM group_scopes WHERE group_id = :groupId AND scope = :scope';
const RECORD_SQL = 'INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id) VALUES (:id, :actorId, :action, :entityType, :entityId)';
const RECORD_ACTOR_SQL = 'SELECT actor_id FROM audit_logs WHERE id = :id';
const SESSIONS_SQL = 'SELECT id, revoked_at FROM sessions WHERE user_id = :userId ORDER BY id';

// The rows a deletion takes along with the user.
const OWN_ROWS_SQL = Object.freeze([
  'SELECT id FROM users WHERE id = :userId',
  'SELECT id FROM user_identities WHERE user_id = :userId',
  'SELECT group_id FROM user_groups WHERE user_id = :userId',
  'SELECT id FROM sessions WHERE user_id = :userId',
]);

// The records a user acted in: a deletion leaves them, the user still their actor.
const ACTED_SQL = 'SELECT action, entity_id FROM audit_logs WHERE actor_id = :userId ORDER BY id';

const ROWS_OF_USER_SQL = Object.freeze([...OWN_ROWS_SQL, ACTED_SQL]);

// The rows the routes of users write: a refused one leaves each of them as it was.
const STATE_TABLES = Object.freeze([TABLE.USERS, TABLE.USER_IDENTITIES, TABLE.USER_GROUPS, TABLE.SESSIONS, TABLE.AUDIT_LOGS]);

// The keeper is a connection of the test outside the pools, and takes "?" placeholders.
const BEGIN_SQL = 'BEGIN';
const HOLD_MEMBERSHIP_SQL = 'SELECT user_id FROM user_groups WHERE user_id = ? AND group_id = ? FOR UPDATE';

// The statement that deletes a user, as the server lists it while it runs.
const USER_DELETE_MARK = 'DELETE FROM users';

// The lock of lockUsers() in src/core/auth/user.js, as the server lists it while it waits for a row.
const USERS_LOCK_MARK = 'FROM users WHERE id IN';

// What the server lists of a locking read while it waits for a row.
const LOCKING_READ_MARK = 'FOR UPDATE';

const DEADLOCK_CODE = 'ER_LOCK_DEADLOCK';

// A user with an address of their own: the sign-in of dev mode finds them by it.
async function createPerson(fastify, { email = `person-${uuidv7()}@${UNLISTED_DOMAIN}`, ...profile } = {}) {
  return { id: await insertUser(fastify, { ...profile, email }), email };
}

// An app whose APP_ADMIN_EMAILS lists an address for each name: unique in the database of the file, as the email of a
// row is.
async function openListingApp(t, names) {
  const emails = names.map((name) => `${name}-${uuidv7()}@${LISTED_DOMAIN}`);
  const fastify = await openRouteApp(t, testDb, { env: { APP_ADMIN_EMAILS: emails.join(', ') } });

  return { fastify, emails };
}

// Whom their next sign-in makes an admin, in no group yet: one whose row holds a listed address nobody has confirmed,
// and one whose row holds none while an identity of theirs holds a listed one that its provider has confirmed.
async function createCandidates(fastify, { rowEmail, identityEmail }) {
  const byRow = await createPerson(fastify, { email: rowEmail });
  const byIdentityId = await createUser(fastify);

  await insertIdentity(fastify, {
    userId: byIdentityId,
    provider: PROVIDER_ID,
    email: identityEmail,
    isEmailVerified: true,
  });

  return [byRow.id, byIdentityId];
}

// The routes of a manager in the order one may run them all on one user: the last one deletes them.
function listManagerRoutes(id) {
  return [
    patchUserRequest(id, { firstName: NEW_NAME }),
    blockRequest(id),
    unblockRequest(id),
    deleteUserRequest(id),
  ];
}

function runManagerRoutes(fastify, actor, id) {
  return mapSeries(listManagerRoutes(id), (request) => send(fastify, actor, request));
}

function readRowsOf(fastify, userId) {
  return mapSeries(ROWS_OF_USER_SQL, (sql) => readAppRows(fastify, sql, { userId }));
}

// What readRowsOf() finds of a deleted user: no row but the records they acted in.
function leftOf(records = []) {
  return [...OWN_ROWS_SQL.map(() => []), records];
}

function actedOf(action, entityId) {
  return { action, entity_id: entityId };
}

async function countRowsOf(fastify, userId) {
  return (await readRowsOf(fastify, userId)).map((rows) => rows.length);
}

function readSessions(fastify, userId) {
  return readAppRows(fastify, SESSIONS_SQL, { userId });
}

async function readStatus(fastify, id) {
  const [row = null] = await readAppRows(fastify, STATUS_OF_USER_SQL, { id });

  return row?.status ?? null;
}

async function readProfile(fastify, actor, id) {
  const response = await send(fastify, actor, getUserRequest(id));

  assert.equal(response.statusCode, 200, response.body);

  return response.json().data;
}

async function readMeStatuses(fastify, devices) {
  return readStatuses(await mapSeries(devices, (device) => send(fastify, device, getMeRequest())));
}

async function readActions(fastify, userId) {
  return (await readAudit(fastify, userId)).map((row) => [row.action, row.actor_id]);
}

// The paths the cookies of a session were set on: a browser drops a cookie of the same name and path only.
function readCookiePaths({ app, auth }) {
  return {
    [COOKIE.ACCESS_TOKEN]: app.apiPrefix,
    [COOKIE.REFRESH_TOKEN]: `${app.apiPrefix}${auth.refreshRoute}`,
    [COOKIE.HAS_SESSION]: ROOT_PATH,
    [COOKIE.HAS_ACCESS]: ROOT_PATH,
  };
}

function describeCookies(response) {
  return mapValues(readAuthCookies(response), (cookie) => [cookie.value, cookie.maxAge, cookie.expires?.toISOString(), cookie.path]);
}

describe('POST /api/v1/users/:id/block', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('blocks the user and ends every live session of theirs at once: 200 with the status blocked, revoked_at on each session, 401 SESSION_REVOKED to their access and refresh tokens, 403 to a new sign-in and one record of user.block by the manager; a second block answers 200 as is and writes nothing', async (t) => {
    const fastify = await openRouteApp(t, testDb, { env: DEV_ENV, auth: LONG_MEMORY });
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const person = await createPerson(fastify, { updatedAt: toDate(LONG_AGO) });
    const devices = await mapSeries(['phone', 'laptop'], () => signIn(fastify, { userId: person.id }));
    const profile = await readProfile(fastify, manager, person.id);

    assert.deepEqual(await readMeStatuses(fastify, devices), [200, 200]);

    const blocked = await send(fastify, manager, blockRequest(person.id));
    const { updatedAt } = blocked.json().data;
    const sessions = await readSessions(fastify, person.id);

    assertOk(blocked, { ...profile, status: USER_STATUS.BLOCKED, updatedAt });
    assert.ok(updatedAt > LONG_AGO, updatedAt);
    assert.deepEqual(sessions.map((row) => row.id), devices.map((device) => device.sid).toSorted());
    assert.ok(sessions.every((row) => row.revoked_at instanceof Date), 'A session of the blocked user is not revoked');

    const answers = await mapSeries(devices, async (device) => [
      await send(fastify, device, getMeRequest()),
      await refresh(fastify, device.refreshCookie),
    ]);

    answers.flat().forEach((response) => assertRevoked(response));
    await assert.rejects(signIn(fastify, { userId: person.id }), { code: ERROR_CODE.AUTHORIZATION_ERROR });

    const signedIn = await postLoginDev(fastify, person.email);

    assertForbidden(signedIn);
    assert.deepEqual(readAuthCookies(signedIn), {});
    assert.equal((await readSessions(fastify, person.id)).length, devices.length);
    assert.deepEqual(await readAudit(fastify, person.id), [describeAudit(blocked, manager.userId, {
      action: AUDIT_ACTION.USER_BLOCK,
      entityType: TABLE.USERS,
      entityId: person.id,
    })]);

    const stateBefore = await readState(fastify, STATE_TABLES);

    assertOk(await send(fastify, manager, blockRequest(person.id)), blocked.json().data);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });

  test('of one blocked already by hand answers 200 with them as they are and records nothing, and still ends the session that block left alive', async (t) => {
    const fastify = await openRouteApp(t, testDb, { auth: LONG_MEMORY });
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const device = await signIn(fastify);

    await blockByHand(fastify, device.userId);

    const profile = await readProfile(fastify, manager, device.userId);

    assert.equal(profile.status, USER_STATUS.BLOCKED);
    assert.deepEqual(await readMeStatuses(fastify, [device]), [200]);

    assertOk(await send(fastify, manager, blockRequest(device.userId)), profile);
    assertRevoked(await send(fastify, device, getMeRequest()));
    assert.ok((await readSessions(fastify, device.userId)).every((row) => row.revoked_at instanceof Date));
    assert.deepEqual(await readAudit(fastify, device.userId), []);
  });
});

describe('POST /api/v1/users/:id/unblock', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('unblocks a blocked user: 200 with the status active and a record of user.unblock by the manager, and the user signs in again, while the sessions the block ended stay ended', async (t) => {
    const fastify = await openRouteApp(t, testDb, { env: DEV_ENV });
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const person = await createPerson(fastify);
    const device = await signIn(fastify, { userId: person.id });
    const blocked = await send(fastify, manager, blockRequest(person.id));

    assert.equal(blocked.statusCode, 200, blocked.body);

    const unblocked = await send(fastify, manager, unblockRequest(person.id));
    const { updatedAt } = unblocked.json().data;
    const audit = await readAudit(fastify, person.id);

    assertOk(unblocked, { ...blocked.json().data, status: USER_STATUS.ACTIVE, updatedAt });
    assert.deepEqual(audit.map((row) => row.action), [AUDIT_ACTION.USER_BLOCK, AUDIT_ACTION.USER_UNBLOCK]);
    assert.deepEqual(audit.at(-1), describeAudit(unblocked, manager.userId, {
      action: AUDIT_ACTION.USER_UNBLOCK,
      entityType: TABLE.USERS,
      entityId: person.id,
    }));

    const signedIn = await postLoginDev(fastify, person.email);

    assert.equal(signedIn.statusCode, 200, signedIn.body);
    assert.equal(signedIn.json().data.id, person.id);
    assert.deepEqual(Object.keys(readAuthCookies(signedIn)).toSorted(), AUTH_COOKIES.toSorted());

    const refreshed = await refresh(fastify, takeRefreshCookie(signedIn));

    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.deepEqual(await readMeStatuses(fastify, [await signIn(fastify, { userId: person.id })]), [200]);
    assertRevoked(await send(fastify, device, getMeRequest()));
    assertRevoked(await refresh(fastify, device.refreshCookie));
  });

  test('of one who is active answers 200 with them as they are, and writes nothing', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const device = await signIn(fastify);
    const profile = await readProfile(fastify, manager, device.userId);
    const stateBefore = await readState(fastify, STATE_TABLES);

    assertOk(await send(fastify, manager, unblockRequest(device.userId)), profile);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(await readAudit(fastify, device.userId), []);
    assert.deepEqual(await readMeStatuses(fastify, [device]), [200]);
  });
});

describe('DELETE /api/v1/users/:id', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('deletes the user with their identities, memberships and sessions, answers 204 and records user.delete by the manager with the ids of their groups in their order: a membership they granted stays without granted_by, a record they wrote keeps them as its actor, their token gets 401, and the reads stop showing them at once', async (t) => {
    const fastify = await openRouteApp(t, testDb, { auth: LONG_MEMORY });

    // The first read of a table whose version is not there yet starts it and goes to the database, caching nothing.
    await runInApp(fastify, () => invalidateCacheTables([TABLE.USERS, TABLE.USER_GROUPS]));

    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE, SCOPE.GROUPS_READ]);
    const target = await signIn(fastify);
    const otherId = await createUser(fastify);
    const groupIds = await mapSeries(['first', 'second', 'third'], async () => (await insertGroup(fastify)).id);
    const [sharedId] = groupIds;
    const recordId = uuidv7();

    await mapSeries(groupIds.toReversed(), (groupId) => joinGroup(fastify, { userId: target.userId, groupId }));
    await joinGroup(fastify, { userId: otherId, groupId: sharedId, grantedBy: target.userId });
    await insertIdentity(fastify, { userId: target.userId, provider: PROVIDER_ID });
    await readAppRows(fastify, RECORD_SQL, {
      id: recordId,
      actorId: target.userId,
      action: AUDIT_ACTION.USER_UPDATE,
      entityType: TABLE.USERS,
      entityId: otherId,
    });

    assert.equal((await readProfile(fastify, manager, target.userId)).id, target.userId);
    assert.deepEqual(readMemberIds(await send(fastify, manager, getMembersRequest(sharedId))).toSorted(), [target.userId, otherId].toSorted());
    assert.deepEqual(await readMeStatuses(fastify, [target]), [200]);
    assert.deepEqual(await countRowsOf(fastify, target.userId), [1, 1, groupIds.length, 1, 1]);

    const deleted = await send(fastify, manager, deleteUserRequest(target.userId));

    assertNoContent(deleted);
    assert.deepEqual(await readRowsOf(fastify, target.userId), leftOf([actedOf(AUDIT_ACTION.USER_UPDATE, otherId)]));
    assert.deepEqual(await readMemberships(fastify, sharedId), [{ user_id: otherId, group_id: sharedId, granted_by: null }]);
    assert.deepEqual(await readAppRows(fastify, RECORD_ACTOR_SQL, { id: recordId }), [{ actor_id: target.userId }]);
    assertRevoked(await send(fastify, target, getMeRequest()));
    assertNotFound(await send(fastify, manager, getUserRequest(target.userId)));
    assert.deepEqual(readMemberIds(await send(fastify, manager, getMembersRequest(sharedId))), [otherId]);
    assert.deepEqual(await readAudit(fastify, target.userId), [describeAudit(deleted, manager.userId, {
      action: AUDIT_ACTION.USER_DELETE,
      entityType: TABLE.USERS,
      entityId: target.userId,
      meta: { groupIds: groupIds.toSorted() },
    })]);
    assertNotFound(await send(fastify, manager, deleteUserRequest(target.userId)));
  });
});

describe('DELETE /api/v1/users/me', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('with the cookies of the session deletes the account: 204 with the four cookies cleared on their paths, no row of the user left but the record of the deletion, every token of theirs refused, and user.delete recorded with the user as its actor and the ids of their groups in their order', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const device = await signIn(fastify);
    const other = await signIn(fastify, { userId: device.userId });
    const groupIds = await mapSeries(['first', 'second'], async () => (await insertGroup(fastify)).id);

    await mapSeries(groupIds.toReversed(), (groupId) => joinGroup(fastify, { userId: device.userId, groupId }));
    await insertIdentity(fastify, { userId: device.userId, provider: PROVIDER_ID });
    assert.deepEqual(await countRowsOf(fastify, device.userId), [1, 1, groupIds.length, 2, 0]);

    const response = await fastify.inject({ ...deleteMeRequest(), cookies: device.accessCookie });

    assertNoContent(response);
    assert.deepEqual(response.cookies.map((cookie) => cookie.name).toSorted(), AUTH_COOKIES.toSorted());
    assert.deepEqual(describeCookies(response), mapValues(readCookiePaths(fastify.config), (path) => ['', 0, EPOCH, path]));
    assert.deepEqual(await readRowsOf(fastify, device.userId), leftOf([actedOf(AUDIT_ACTION.USER_DELETE, device.userId)]));
    assertRevoked(await fastify.inject({ ...getMeRequest(), cookies: device.accessCookie }));
    assertRevoked(await refresh(fastify, device.refreshCookie));
    assertRevoked(await send(fastify, other, getMeRequest()));
    assert.deepEqual(await readAudit(fastify, device.userId), [describeAudit(response, device.userId, {
      action: AUDIT_ACTION.USER_DELETE,
      entityType: TABLE.USERS,
      entityId: device.userId,
      meta: { groupIds: groupIds.toSorted() },
    })]);
  });

  test('with a Bearer token deletes the account and leaves the cookies of the browser alone: 204 with no cookie set or cleared', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const device = await signIn(fastify);
    const browser = await signIn(fastify);
    const response = await fastify.inject({ ...deleteMeRequest(), headers: device.bearer, cookies: browser.accessCookie });

    assertNoContent(response);
    assert.equal(response.headers[HEADER.SET_COOKIE], undefined);
    assert.deepEqual(readAuthCookies(response), {});
    assert.deepEqual(await readRowsOf(fastify, device.userId), leftOf([actedOf(AUDIT_ACTION.USER_DELETE, device.userId)]));
    assertRevoked(await send(fastify, device, getMeRequest()));
    assert.deepEqual(await countRowsOf(fastify, browser.userId), [1, 0, 0, 1, 0]);
    assert.equal((await fastify.inject({ ...getMeRequest(), cookies: browser.accessCookie })).statusCode, 200);
  });
});

describe('a manager acting on themselves', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('is refused with 403 by PATCH, DELETE, block and unblock of /:id before the database, a holder of * who is the last active member of admin too, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const actors = await mapSeries([[SCOPE.USERS_MANAGE], [SCOPE_ALL]], (scopes) => signInAs(fastify, scopes));
    const [, root] = actors;

    await setAdminMembers(fastify, [root.userId]);

    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries(actors, (actor) => runManagerRoutes(fastify, actor, actor.userId));

    responses.flat().forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(await readMeStatuses(fastify, actors), [200, 200]);
  });
});

describe('one who holds users:manage', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('may change, block, unblock and delete a user who holds no scope and a peer who holds users:manage alone, each step recorded by them', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const targets = await mapSeries([[], [SCOPE.USERS_MANAGE]], (scopes) => signInAs(fastify, scopes));
    const answers = await mapSeries(targets, (target) => runManagerRoutes(fastify, manager, target.userId));

    assert.deepEqual(answers.map((responses) => readStatuses(responses)), targets.map(() => MANAGED_STATUSES));
    assert.deepEqual(answers.map(([changed]) => changed.json().data.firstName), targets.map(() => NEW_NAME));
    assert.deepEqual(answers.map(([, blocked, unblocked]) => [blocked.json().data.status, unblocked.json().data.status]), targets.map(() => [USER_STATUS.BLOCKED, USER_STATUS.ACTIVE]));
    assert.deepEqual(await mapSeries(targets, async (target) => (await readRowsOf(fastify, target.userId)).flat()), targets.map(() => []));
    assert.deepEqual(
      await mapSeries(targets, (target) => readActions(fastify, target.userId)),
      targets.map(() => MANAGED_ACTIONS.map((action) => [action, manager.userId])),
    );
  });

  test('is refused with 403 by every route of a manager on a user who holds *, users:* or a scope they lack, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const targets = await mapSeries(WIDER_HOLDINGS, (scopes) => signInAs(fastify, scopes));
    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries(targets, (target) => runManagerRoutes(fastify, manager, target.userId));

    responses.flat().forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(await readMeStatuses(fastify, targets), targets.map(() => 200));
  });

  test('is judged by what the database grants now: one whose group lost users:manage and one blocked by hand after the token was issued are refused with 403 by every route of a manager, though the token still carries the scope past the guard, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const actors = await mapSeries(['demoted', 'blocked'], () => signInAs(fastify, [SCOPE.USERS_MANAGE]));
    const [demoted, blocked] = actors;
    const userId = await createUser(fastify);

    await readAppRows(fastify, DROP_SCOPE_SQL, { groupId: demoted.groupId, scope: SCOPE.USERS_MANAGE });
    await blockByHand(fastify, blocked.userId);

    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries(actors, (actor) => runManagerRoutes(fastify, actor, userId));

    responses.flat().forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(actors.map((actor) => readClaims(actor.issued.accessToken).scopes), actors.map(() => [SCOPE.USERS_MANAGE]));
    assert.deepEqual(readStatuses(await mapSeries(actors, (actor) => send(fastify, actor, getUsersRequest()))), [200, 200]);
  });

  test('is judged under the lock of their own row: a block that waits for that row while their group loses users:manage is refused with 403 once it goes on, and nothing is written', async (t) => {
    const keeper = await testDb.openKeeper(t);
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const userId = await createUser(fastify);
    const stateBefore = await readState(fastify, STATE_TABLES);

    await keeper.holdRow(TABLE.USERS, manager.userId);

    const blocking = send(fastify, manager, blockRequest(userId));

    await waitForBlockedSessions(testDb, USERS_LOCK_MARK, 1);
    await readAppRows(fastify, DROP_SCOPE_SQL, { groupId: manager.groupId, scope: SCOPE.USERS_MANAGE });
    await keeper.release();

    assertForbidden(await blocking);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(await readAudit(fastify, userId), []);
    assert.equal(await readStatus(fastify, userId), USER_STATUS.ACTIVE);
  });
});

describe('a user whom APP_ADMIN_EMAILS makes an admin at their next sign-in', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('is refused with 403 to one who holds users:manage without * by every route of a manager, whose row holds a listed email nobody has confirmed or holds none while a confirmed identity of theirs holds a listed one, and so is a PATCH that gives a user a listed email or takes the email of one whose confirmed identity holds a listed one; nothing is written', async (t) => {
    const { fastify, emails: [rowEmail, identityEmail, givenEmail] } = await openListingApp(t, ['row', 'identity', 'given']);
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const candidateIds = await createCandidates(fastify, { rowEmail, identityEmail });
    const plainId = await createUser(fastify);
    const mailed = await createPerson(fastify);

    await insertIdentity(fastify, {
      userId: mailed.id,
      provider: PROVIDER_ID,
      email: identityEmail,
      isEmailVerified: true,
    });

    const stateBefore = await readState(fastify, STATE_TABLES);
    const managed = await mapSeries(candidateIds, (id) => runManagerRoutes(fastify, manager, id));
    const patched = await mapSeries([
      patchUserRequest(plainId, { email: givenEmail }),
      patchUserRequest(mailed.id, { email: null }),
    ], (request) => send(fastify, manager, request));

    [...managed.flat(), ...patched].forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });

  test('is managed by a holder of *, who may also give a user a listed email, while one who holds users:manage alone still manages a user whose row and identities hold no listed email, and one whose row holds none while an identity of theirs holds a listed one nobody has confirmed', async (t) => {
    const { fastify, emails: [rowEmail, identityEmail, givenEmail, unconfirmedEmail] } = await openListingApp(t, ['row', 'identity', 'given', 'unconfirmed']);
    const [manager, root] = await mapSeries([[SCOPE.USERS_MANAGE], [SCOPE_ALL]], (scopes) => signInAs(fastify, scopes));
    const candidateIds = await createCandidates(fastify, { rowEmail, identityEmail });
    const plain = await createPerson(fastify);
    const [unlistedId, unconfirmedId, givenId] = await mapSeries(['unlisted', 'unconfirmed', 'given'], () => createUser(fastify));

    await mapSeries([
      { userId: unlistedId, email: `unlisted-${unlistedId}@${UNLISTED_DOMAIN}`, isEmailVerified: true },
      { userId: unconfirmedId, email: unconfirmedEmail },
    ], (identity) => insertIdentity(fastify, { ...identity, provider: PROVIDER_ID }));

    const byRoot = await mapSeries(candidateIds, (id) => runManagerRoutes(fastify, root, id));
    const given = await send(fastify, root, patchUserRequest(givenId, { email: givenEmail }));
    const byManager = await mapSeries([plain.id, unlistedId, unconfirmedId], (id) => runManagerRoutes(fastify, manager, id));

    assert.deepEqual([...byRoot, ...byManager].map((responses) => readStatuses(responses)), [...byRoot, ...byManager].map(() => MANAGED_STATUSES));
    assert.deepEqual([given.statusCode, given.json().data.email], [200, givenEmail]);
    assert.deepEqual(
      await mapSeries(candidateIds, (id) => readActions(fastify, id)),
      candidateIds.map(() => MANAGED_ACTIONS.map((action) => [action, root.userId])),
    );
    assert.deepEqual(await readActions(fastify, unconfirmedId), MANAGED_ACTIONS.map((action) => [action, manager.userId]));
  });
});

describe('the last active member of the admin group', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('stays: their DELETE /me by the Bearer token and by the cookie of the session, which keeps its cookies, and a DELETE /:id and a block of them by a holder of * from another group, answer 409 GROUP_PROTECTED, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const last = await signIn(fastify);
    const adminId = await setAdminMembers(fastify, [last.userId]);
    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries([
      [last, deleteMeRequest()],
      [root, deleteUserRequest(last.userId)],
      [root, blockRequest(last.userId)],
    ], ([actor, request]) => send(fastify, actor, request));
    const kept = await fastify.inject({ ...deleteMeRequest(), cookies: last.accessCookie });

    [...responses, kept].forEach((response) => assertProtected(response));
    assert.deepEqual(readAuthCookies(kept), {});
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(await listMemberIds(fastify, adminId), [last.userId]);
    assert.deepEqual(await readMeStatuses(fastify, [last]), [200]);
  });

  test('is no longer the last once another member is active: a block, an unblock and a DELETE /:id by a holder of *, and a DELETE /me, each go through while one active member stays', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const [first, second, third] = await mapSeries(['first', 'second', 'third'], () => signIn(fastify));
    const adminId = await setAdminMembers(fastify, [first.userId, second.userId]);
    const changes = await mapSeries([blockRequest(first.userId), unblockRequest(first.userId)], (request) => send(fastify, root, request));

    assert.deepEqual(changes.map((response) => [response.statusCode, response.json().data.status]), [[200, USER_STATUS.BLOCKED], [200, USER_STATUS.ACTIVE]]);
    assertNoContent(await send(fastify, root, deleteUserRequest(first.userId)));
    assert.deepEqual(await listMemberIds(fastify, adminId), [second.userId]);

    await setAdminMembers(fastify, [second.userId, third.userId]);
    assertNoContent(await send(fastify, second, deleteMeRequest()));
    assert.deepEqual(await listMemberIds(fastify, adminId), [third.userId]);
    assertProtected(await send(fastify, third, deleteMeRequest()));
    assert.deepEqual(await listMemberIds(fastify, adminId), [third.userId]);
  });

  test('is counted among the active members alone: beside blocked members the active one stays, while a blocked member may be blocked again and deleted', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const active = await signIn(fastify);
    const blockedIds = await mapSeries(['first', 'second'], () => createUser(fastify, { status: USER_STATUS.BLOCKED }));
    const [firstBlockedId, secondBlockedId] = blockedIds;
    const adminId = await setAdminMembers(fastify, [active.userId, ...blockedIds]);
    const stateBefore = await readState(fastify, STATE_TABLES);
    const refusals = await mapSeries([
      [active, deleteMeRequest()],
      [root, deleteUserRequest(active.userId)],
      [root, blockRequest(active.userId)],
    ], ([actor, request]) => send(fastify, actor, request));

    refusals.forEach((response) => assertProtected(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);

    const reblocked = await send(fastify, root, blockRequest(firstBlockedId));

    assert.deepEqual([reblocked.statusCode, reblocked.json().data.status], [200, USER_STATUS.BLOCKED]);
    assertNoContent(await send(fastify, root, deleteUserRequest(secondBlockedId)));
    assert.deepEqual(await listMemberIds(fastify, adminId), [active.userId, firstBlockedId].toSorted());
    assert.deepEqual(await readAudit(fastify, firstBlockedId), []);
  });
});

describe('the refusals of the routes of a manager', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('come in the order 404, 409, 403: an unknown id and one that is no id are 404 to every holder of users:manage, a blocked one too, and the last active member of admin is 409 to a block and a DELETE by one without *, who gets 403 for a change and an unblock of them, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const actors = await mapSeries([[SCOPE.USERS_MANAGE], [SCOPE_ALL], [SCOPE.USERS_MANAGE]], (scopes) => signInAs(fastify, scopes));
    const [manager, , stale] = actors;
    const lastId = await createUser(fastify);

    await blockByHand(fastify, stale.userId);
    await setAdminMembers(fastify, [lastId]);

    const stateBefore = await readState(fastify, STATE_TABLES);
    const unknown = await mapSeries(actors, (actor) => mapSeries([uuidv7(), NO_ID], (id) => runManagerRoutes(fastify, actor, id)));
    const protectedAnswers = await mapSeries([
      [manager, deleteUserRequest(lastId)],
      [manager, blockRequest(lastId)],
      [stale, deleteUserRequest(lastId)],
      [stale, blockRequest(lastId)],
    ], ([actor, request]) => send(fastify, actor, request));
    const forbiddenAnswers = await mapSeries([
      patchUserRequest(lastId, { firstName: NEW_NAME }),
      unblockRequest(lastId),
    ], (request) => send(fastify, manager, request));

    unknown.flat(2).forEach((response) => assertNotFound(response));
    protectedAnswers.forEach((response) => assertProtected(response));
    forbiddenAnswers.forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });
});

describe('changes of users at the same moment', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('leave the admin group one active member when its last two delete their own accounts at once: 204 to one, 409 GROUP_PROTECTED to the other, who stays', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const members = await mapSeries(['first', 'second'], () => signIn(fastify));
    const adminId = await setAdminMembers(fastify, members.map((member) => member.userId));
    const responses = await Promise.all(members.map((member) => send(fastify, member, deleteMeRequest())));
    const isFirstGone = responses[0].statusCode === 204;
    const [gone, kept] = isFirstGone
      ? members
      : members.toReversed();
    const [left, refused] = isFirstGone
      ? responses
      : responses.toReversed();

    assert.deepEqual(readStatuses(responses).toSorted(), [204, 409]);
    assertNoContent(left);
    assertProtected(refused);
    assert.deepEqual(await listMemberIds(fastify, adminId), [kept.userId]);
    assert.equal(await readStatus(fastify, kept.userId), USER_STATUS.ACTIVE);
    assert.deepEqual(await readRowsOf(fastify, gone.userId), leftOf([actedOf(AUDIT_ACTION.USER_DELETE, gone.userId)]));
  });

  test('leave the admin group one active member when its last two block each other at once: 200 to one, 409 GROUP_PROTECTED to the other, who is the one blocked, and neither is run again', async (t) => {
    const { fastify, sink } = await openLoggedRouteApp(t, testDb, { level: 'warn', auth: LONG_MEMORY });
    const adminIds = await mapSeries(['first', 'second'], () => createUser(fastify));
    const adminId = await setAdminMembers(fastify, adminIds);
    const admins = await mapSeries(adminIds, (userId) => signIn(fastify, { userId }));
    const [first, second] = admins;

    assert.deepEqual(admins.map((admin) => readClaims(admin.issued.accessToken).scopes), [[SCOPE_ALL], [SCOPE_ALL]]);
    assert.deepEqual(await readMeStatuses(fastify, admins), [200, 200]);

    const responses = await Promise.all([
      send(fastify, first, blockRequest(second.userId)),
      send(fastify, second, blockRequest(first.userId)),
    ]);
    const isFirstAhead = responses[0].statusCode === 200;
    const [winner, loser] = isFirstAhead
      ? admins
      : admins.toReversed();
    const [won, lost] = isFirstAhead
      ? responses
      : responses.toReversed();

    assert.deepEqual(readStatuses(responses).toSorted(), [200, 409]);
    assert.deepEqual([won.json().data.id, won.json().data.status], [loser.userId, USER_STATUS.BLOCKED]);
    assertProtected(lost);
    assert.deepEqual(await mapSeries([winner, loser], (admin) => readStatus(fastify, admin.userId)), [USER_STATUS.ACTIVE, USER_STATUS.BLOCKED]);
    assert.deepEqual(await listMemberIds(fastify, adminId), adminIds.toSorted());
    assert.deepEqual(await readMeStatuses(fastify, [winner, loser]), [200, 401]);
    assert.deepEqual(await readActions(fastify, loser.userId), [[AUDIT_ACTION.USER_BLOCK, winner.userId]]);
    assert.deepEqual(findLogLines(sink, RETRY_MESSAGE), []);
  });

  test('settle when the cascades of two users who granted each other a membership cross while both delete their own accounts: the deadlock is run again once, both answer 204 and never a 500, and neither leaves a row behind but the record of their deletion', async (t) => {
    const keeper = await testDb.openKeeper(t);
    const { fastify, sink } = await openLoggedRouteApp(t, testDb, { level: 'warn' });

    // Whichever of fk_user_groups_granted_by and fk_user_groups_user InnoDB runs first, the cascade of the first user
    // takes a membership the second one needs and stops at one the keeper holds, while the second waits for it: once
    // the keeper lets go, the first waits for the second.
    const userIds = [uuidv7(), uuidv7(), uuidv7()].toSorted();
    const [firstId, secondId, thirdId] = userIds;

    await mapSeries(userIds, (id) => createUser(fastify, { id }));

    const users = await mapSeries([firstId, secondId], (userId) => signIn(fastify, { userId }));
    const groupIds = await mapSeries(['first', 'second', 'held', 'fourth'], async () => (await insertGroup(fastify)).id);
    const [firstGroupId, secondGroupId, heldGroupId, fourthGroupId] = groupIds;

    await mapSeries([
      { userId: secondId, groupId: firstGroupId, grantedBy: firstId },
      { userId: firstId, groupId: secondGroupId, grantedBy: secondId },
      { userId: thirdId, groupId: heldGroupId, grantedBy: firstId },
      { userId: firstId, groupId: fourthGroupId },
    ], (membership) => joinGroup(fastify, membership));
    await keeper.query(BEGIN_SQL);
    await mapSeries([[thirdId, heldGroupId], [firstId, fourthGroupId]], (held) => keeper.query(HOLD_MEMBERSHIP_SQL, held));

    const [first, second] = users;
    const firstRun = send(fastify, first, deleteMeRequest());

    await waitForBlockedSessions(testDb, USER_DELETE_MARK, 1);

    const secondRun = send(fastify, second, deleteMeRequest());

    await waitForBlockedSessions(testDb, USER_DELETE_MARK, 2);
    await keeper.release();

    const responses = await Promise.all([firstRun, secondRun]);

    responses.forEach((response) => assertNoContent(response));
    assert.deepEqual(findLogLines(sink, RETRY_MESSAGE).map((line) => line.err.code), [DEADLOCK_CODE]);
    assert.deepEqual(await mapSeries(users, (user) => readRowsOf(fastify, user.userId)), users.map((user) => leftOf([actedOf(AUDIT_ACTION.USER_DELETE, user.userId)])));
    assert.deepEqual(await mapSeries(groupIds, (groupId) => readMemberships(fastify, groupId)), [
      [],
      [],
      [{ user_id: thirdId, group_id: heldGroupId, granted_by: null }],
      [],
    ]);
    assert.deepEqual(await mapSeries(users, async (user) => (await readAudit(fastify, user.userId)).map((row) => [row.action, row.actor_id, row.meta])), [
      [[AUDIT_ACTION.USER_DELETE, firstId, { groupIds: [secondGroupId, fourthGroupId].toSorted() }]],
      [[AUDIT_ACTION.USER_DELETE, secondId, { groupIds: [firstGroupId] }]],
    ]);
  });

  test('settle when a sign-in of dev mode by the email of a user comes while their deletion waits: the deletion answers 204, the sign-in, which waits for the row of the user, answers 200 with a new user of that email, and neither is run again', async (t) => {
    const keeper = await testDb.openKeeper(t);
    const { fastify, sink } = await openLoggedRouteApp(t, testDb, { level: 'warn', env: DEV_ENV });
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const person = await createPerson(fastify);
    const device = await signIn(fastify, { userId: person.id });

    // The deletion locks the row of the user, then waits for their session, which the keeper holds. The sign-in finds
    // the user by the email without a lock and waits for that row: a lock through the entry of the email first would
    // cross the deletion, which takes that entry once it goes on.
    await keeper.holdRow(TABLE.SESSIONS, device.sid);

    const deleting = send(fastify, manager, deleteUserRequest(person.id));

    await waitForBlockedSessions(testDb, LOCKING_READ_MARK, 1);

    const signingIn = postLoginDev(fastify, person.email);

    await waitForBlockedSessions(testDb, LOCKING_READ_MARK, 2);
    await keeper.release();

    const [deleted, signedIn] = await Promise.all([deleting, signingIn]);

    assertNoContent(deleted);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    assert.notEqual(signedIn.json().data.id, person.id);
    assert.deepEqual(await readAppRows(fastify, OWNER_SQL, { email: person.email }), [{ id: signedIn.json().data.id }]);
    assert.deepEqual(await readRowsOf(fastify, person.id), leftOf());
    assert.deepEqual(await readActions(fastify, person.id), [[AUDIT_ACTION.USER_DELETE, manager.userId]]);
    assert.deepEqual(findLogLines(sink, RETRY_MESSAGE), []);
  });
});
