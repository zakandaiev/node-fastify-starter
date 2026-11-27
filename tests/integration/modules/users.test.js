import { SESSION_TRANSACTION } from '#core/auth/session.js';
import { invalidateCacheTables } from '#core/cache/index.js';
import { findUniqueViolation } from '#core/error/classify.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { SCOPE, SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { UNIQUE_INDEX } from '#enums/unique-index.js';
import { USER_STATUS } from '#enums/user-status.js';
import { listMembers } from '#modules/groups/groups.service.js';
import { USER_FIELDS, USER_LIST_FIELDS } from '#modules/users/users.repository.js';
import {
  blockUser,
  listUsers,
  readOwnProfile,
  readUser,
  removeOwnAccount,
  removeUser,
  unblockUser,
  updateOwnProfile,
  updateUser,
} from '#modules/users/users.service.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import {
  createDownDb,
  createTestDb,
  REFUSED_CONNECTION_CODE,
  SMALL_POOL,
} from '#root/tests/helper/db.js';
import { assertAppError, assertTypeError, REFUSAL } from '#root/tests/helper/error.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  ALIVE_MARK,
  auditRecordOf,
  connectAppRedis,
  createActor,
  createUser,
  insertGroup,
  insertIdentity,
  insertUser,
  isAliveIn,
  joinGroup,
  readAdminId,
  readAudit,
  readRegistryMarks,
  readState,
  REVOKED_MARK,
  runInApp,
  runInTransaction,
  signIn,
  signInByProvider,
  TEST_REQUEST,
  verifiedProfileOf,
} from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { nowUtc, parseStrictUtc } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import { normalizePersonName, PERSON_NAME_MAX_LENGTH } from '#utils/person.js';
import { EMAIL_MAX_LENGTH } from '#utils/validate.js';
import assert from 'node:assert/strict';
import {
  after,
  before,
  describe,
  test,
} from 'node:test';
import { inspect } from 'node:util';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

// An address of its own for each user of the tests: the rows of the file stay for the tests after it.
const ADMIN = Object.freeze({
  VERIFIED: 'verified@admin.test',
  UNVERIFIED: 'unverified@admin.test',
  IDENTITY: 'identity@admin.test',
  BLOCKED: 'blocked@admin.test',
  SET: 'set@admin.test',
  BEHIND: 'behind@admin.test',
  BESIDE: 'beside@admin.test',
  HELD: 'held@admin.test',
  HELD_IDENTITY: 'held.identity@admin.test',
  GIVEN: 'given@admin.test',
  UNCONFIRMED: 'unconfirmed@admin.test',
  CLEARED: 'cleared@admin.test',
  LISTED_LATER: 'listed.later@admin.test',
});
const ADMIN_ENV = Object.freeze({ APP_ADMIN_EMAILS: Object.values(ADMIN).join(', ') });

const GOOGLE = 'google';
const ROLLBACK_MESSAGE = 'The test rolls back the transaction around the call';

const VERIFIED_AT = parseStrictUtc('2026-11-01T10:00:00.000Z');

const SIGNATURE = Object.freeze({
  READ_USER: 'readUser(id)',
  READ_PROFILE: 'readOwnProfile(userId)',
  UPDATE_USER: 'updateUser({ id, input, actorId, request })',
  BLOCK_USER: 'blockUser({ id, actorId, request })',
  UNBLOCK_USER: 'unblockUser({ id, actorId, request })',
  REMOVE_USER: 'removeUser({ id, actorId, request })',
  UPDATE_PROFILE: 'updateOwnProfile({ userId, input })',
  REMOVE_ACCOUNT: 'removeOwnAccount({ userId, request })',
});
const A_USER = 'a user';
const THE_ACTOR = 'the actor';
const A_NAME = 'a name of a person';
const AN_EMAIL = 'an email';
const BODY_REFUSAL = 'buildPatch(body, { allowed }) requires body to be a plain object';
const LIST_REFUSAL = 'buildFilter(schema, payload, { options, disabled }) requires payload to be a plain object, such as request.query';

const NAME_FIELDS = Object.freeze(['firstName', 'lastName']);
const SORTED_USER_FIELDS = Object.freeze(USER_FIELDS.toSorted());
const SORTED_LIST_FIELDS = Object.freeze(USER_LIST_FIELDS.toSorted());

// By their code points: a combining mark is invisible in the source, and an editor may compose it with its letter.
const COMBINING_DIAERESIS = String.fromCharCode(0x308);
const SMALL_E_WITH_DIAERESIS = String.fromCharCode(0xEB);
const COMBINING_ACUTE = String.fromCharCode(0x301);
const SMALL_E_WITH_ACUTE = String.fromCharCode(0xE9);
const BOLD_CAPITAL_K = String.fromCodePoint(0x1D40A);
const EMOJI = String.fromCodePoint(0x1F600);

const DECOMPOSED_NAME = `Zoe${COMBINING_DIAERESIS}`;
const COMPOSED_NAME = `Zo${SMALL_E_WITH_DIAERESIS}`;

// What the schema of the routes refuses as a name and as an email.
const WRONG_NAMES = Object.freeze([
  'Dr. X',
  'Anna Maria',
  'R2-D2',
  '',
  'a'.repeat(PERSON_NAME_MAX_LENGTH + 1),
  EMOJI,
  42,
  true,
  ['Anna'],
]);
const WRONG_EMAILS = Object.freeze([
  'not-an-email',
  '',
  'anna@',
  '@example.test',
  'anna@example',
  'an na@example.test',
  `${'a'.repeat(EMAIL_MAX_LENGTH)}@example.test`,
  42,
  ['anna@example.test'],
]);
const WRONG_INPUTS = Object.freeze([undefined, null, 'Anna', 42, ['Anna']]);

// Inputs that hold no field the call changes: a field of another kind, alone, or one left undefined.
const NO_MANAGED_FIELDS = Object.freeze([
  {},
  { firstName: undefined },
  { status: USER_STATUS.BLOCKED },
  { emailVerifiedAt: VERIFIED_AT },
  { id: uuidv7() },
  { locale: 'uk', timezone: 'Europe/Kyiv' },
]);
const NO_PROFILE_FIELDS = Object.freeze([
  {},
  { lastName: undefined },
  { email: 'own@example.test' },
  { status: USER_STATUS.BLOCKED },
  { emailVerifiedAt: VERIFIED_AT },
]);

const USER_SQL = 'SELECT email, email_verified_at, first_name, last_name, status, updated_at FROM users WHERE id = :id';
const STATUS_SQL = 'UPDATE users SET status = :status WHERE id = :id';
const RENAME_SQL = 'UPDATE users SET first_name = :firstName WHERE id = :id';
const DELETE_USER_SQL = 'DELETE FROM users WHERE id = :id';
const GRANTED_BY_SQL = 'SELECT granted_by FROM user_groups WHERE user_id = :userId';
const SESSIONS_SQL = 'SELECT revoked_at FROM sessions WHERE user_id = :userId ORDER BY id';
const INSERT_AUDIT_SQL = 'INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (:actorId, :action, :entityType, :entityId)';
const LEFT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM users WHERE id IN (:ids)) AS users,
    (SELECT COUNT(*) FROM user_identities WHERE user_id IN (:ids)) AS identities,
    (SELECT COUNT(*) FROM user_groups WHERE user_id IN (:ids)) AS memberships,
    (SELECT COUNT(*) FROM sessions WHERE user_id IN (:ids)) AS sessions
`;

// What the transaction around a call sees of the user once the call is done.
const SEEN_SQL = `
  SELECT
    (SELECT status FROM users WHERE id = :userId) AS status,
    (SELECT COUNT(*) FROM sessions WHERE user_id = :userId AND revoked_at IS NULL) AS live,
    (SELECT COUNT(*) FROM audit_logs WHERE entity_id = :userId) AS records
`;

// The rows a call of the service writes.
const STATE_TABLES = Object.freeze([TABLE.USERS, TABLE.USER_IDENTITIES, TABLE.USER_GROUPS, TABLE.SESSIONS, TABLE.AUDIT_LOGS]);

let fastify = null;

async function readUserRow(id) {
  const [row = null] = await testDb.readRows(USER_SQL, { id });

  return row;
}

function createEmail(word) {
  return `${word}-${uuidv7()}@example.test`;
}

async function readRevokedFlags(userId) {
  return (await testDb.readRows(SESSIONS_SQL, { userId })).map((session) => session.revoked_at !== null);
}

// updateUser() confirms an address by the clock of this process: the clock of the database differs from it.
async function timeCall(call) {
  const startedAt = nowUtc();
  const result = await call();

  return [result, { startedAt, endedAt: nowUtc() }];
}

function assertWithin(moment, { startedAt, endedAt }) {
  assert.ok(moment instanceof Date && moment >= startedAt && moment <= endedAt, `${inspect(moment)} is not between ${startedAt.toISOString()} and ${endedAt.toISOString()}`);
}

function update(id, input, actorId) {
  return runInApp(fastify, () => updateUser({
    id,
    input,
    actorId,
    request: TEST_REQUEST,
  }));
}

function block(id, actorId) {
  return runInApp(fastify, () => blockUser({ id, actorId, request: TEST_REQUEST }));
}

function unblock(id, actorId) {
  return runInApp(fastify, () => unblockUser({ id, actorId, request: TEST_REQUEST }));
}

function remove(id, actorId) {
  return runInApp(fastify, () => removeUser({ id, actorId, request: TEST_REQUEST }));
}

function updateOwn(userId, input) {
  return runInApp(fastify, () => updateOwnProfile({ userId, input }));
}

function removeOwn(userId) {
  return runInApp(fastify, () => removeOwnAccount({ userId, request: TEST_REQUEST }));
}

// The four calls of a manager on one user, outside any context: the caller runs each in the context it tests.
function listManagedCalls(id, actorId) {
  const request = TEST_REQUEST;

  return [
    () => updateUser({
      id,
      input: { firstName: 'Taras' },
      actorId,
      request,
    }),
    () => blockUser({ id, actorId, request }),
    () => unblockUser({ id, actorId, request }),
    () => removeUser({ id, actorId, request }),
  ];
}

function idRefusal(signature, what) {
  return `${signature} requires the UUID of ${what}`;
}

function fieldRefusal(signature, field, expected) {
  return `${signature} requires ${field} to be ${expected} or null`;
}

// Each wrong in one id of a call that is valid otherwise, with the message of its refusal. A call with no argument
// misses its first id.
function listWrongIdCalls({ userId, actorId }) {
  const id = uuidv7();
  const wrongIds = [undefined, null, '', 'user-1', 42, false, id.toUpperCase(), { id }, [id]];
  const input = { firstName: 'Taras' };

  return [
    [() => readUser(), idRefusal(SIGNATURE.READ_USER, A_USER)],
    [() => readOwnProfile(), idRefusal(SIGNATURE.READ_PROFILE, A_USER)],
    [() => updateUser(), idRefusal(SIGNATURE.UPDATE_USER, A_USER)],
    [() => blockUser(), idRefusal(SIGNATURE.BLOCK_USER, A_USER)],
    [() => unblockUser(), idRefusal(SIGNATURE.UNBLOCK_USER, A_USER)],
    [() => removeUser(), idRefusal(SIGNATURE.REMOVE_USER, A_USER)],
    [() => updateOwnProfile(), idRefusal(SIGNATURE.UPDATE_PROFILE, A_USER)],
    [() => removeOwnAccount(), idRefusal(SIGNATURE.REMOVE_ACCOUNT, A_USER)],
    ...wrongIds.flatMap((wrong) => [
      [() => readUser(wrong), idRefusal(SIGNATURE.READ_USER, A_USER)],
      [() => readOwnProfile(wrong), idRefusal(SIGNATURE.READ_PROFILE, A_USER)],
      [() => updateUser({ id: wrong, input, actorId }), idRefusal(SIGNATURE.UPDATE_USER, A_USER)],
      [() => updateUser({ id: userId, input, actorId: wrong }), idRefusal(SIGNATURE.UPDATE_USER, THE_ACTOR)],
      [() => blockUser({ id: wrong, actorId }), idRefusal(SIGNATURE.BLOCK_USER, A_USER)],
      [() => blockUser({ id: userId, actorId: wrong }), idRefusal(SIGNATURE.BLOCK_USER, THE_ACTOR)],
      [() => unblockUser({ id: wrong, actorId }), idRefusal(SIGNATURE.UNBLOCK_USER, A_USER)],
      [() => unblockUser({ id: userId, actorId: wrong }), idRefusal(SIGNATURE.UNBLOCK_USER, THE_ACTOR)],
      [() => removeUser({ id: wrong, actorId }), idRefusal(SIGNATURE.REMOVE_USER, A_USER)],
      [() => removeUser({ id: userId, actorId: wrong }), idRefusal(SIGNATURE.REMOVE_USER, THE_ACTOR)],
      [() => updateOwnProfile({ userId: wrong, input }), idRefusal(SIGNATURE.UPDATE_PROFILE, A_USER)],
      [() => removeOwnAccount({ userId: wrong }), idRefusal(SIGNATURE.REMOVE_ACCOUNT, A_USER)],
    ]),
  ];
}

// Each with the message of its refusal: one wrong field refuses the whole input, the right fields beside it too.
function listWrongInputCalls({ userId, actorId }) {
  function managed(input, message) {
    return [() => updateUser({ id: userId, input, actorId }), message];
  }

  function own(input, message) {
    return [() => updateOwnProfile({ userId, input }), message];
  }

  return [
    ...WRONG_INPUTS.flatMap((input) => [managed(input, BODY_REFUSAL), own(input, BODY_REFUSAL)]),
    ...WRONG_NAMES.flatMap((name) => NAME_FIELDS.flatMap((field) => [
      managed({ [field]: name }, fieldRefusal(SIGNATURE.UPDATE_USER, field, A_NAME)),
      own({ [field]: name }, fieldRefusal(SIGNATURE.UPDATE_PROFILE, field, A_NAME)),
    ])),
    ...WRONG_EMAILS.map((email) => managed({ email }, fieldRefusal(SIGNATURE.UPDATE_USER, 'email', AN_EMAIL))),
    managed({ firstName: 'Taras', lastName: 'Shevchenko', email: 'not-an-email' }, fieldRefusal(SIGNATURE.UPDATE_USER, 'email', AN_EMAIL)),
    own({ firstName: 'Taras', lastName: 'Dr. X' }, fieldRefusal(SIGNATURE.UPDATE_PROFILE, 'lastName', A_NAME)),
    [() => listUsers('firstName=Anna'), LIST_REFUSAL],
  ];
}

function listUnchangingCalls({ userId, actorId }) {
  return [
    ...NO_MANAGED_FIELDS.map((input) => () => updateUser({ id: userId, input, actorId })),
    ...NO_PROFILE_FIELDS.map((input) => () => updateOwnProfile({ userId, input })),
  ];
}

function updateRecordOf(entityId, actorId, fields) {
  return auditRecordOf(AUDIT_ACTION.USER_UPDATE, { entityId, actorId, meta: { fields } });
}

// The call inside a transaction that the test rolls back once the call is done, with what the transaction has seen of
// the user by then.
async function runRolledBack(call, userId) {
  let seen = null;
  const error = await rejectionOf(runInTransaction(fastify, async () => {
    const result = await call();
    const { rows: [row] } = await fastify.db.query(SEEN_SQL, { userId });

    seen = { result, ...row };

    throw new Error(ROLLBACK_MESSAGE);
  }, SESSION_TRANSACTION));

  assert.equal(error.message, ROLLBACK_MESSAGE, inspect(error));

  return seen;
}

describe('the service of users', { skip: testRedis.skip || testDb.skip }, () => {
  before(async () => {
    await up();
    await up({ type: MIGRATION_TYPE.SEED });

    fastify = await testDb.buildApp({ env: ADMIN_ENV, db: SMALL_POOL });
    await connectAppRedis(fastify);

    // The first read of a table whose version is not there yet starts it and goes to the database, caching nothing.
    await runInApp(fastify, () => invalidateCacheTables([TABLE.USERS, TABLE.USER_GROUPS]));
  });

  after(() => fastify?.close());

  describe('a call that is malformed or not allowed at all', () => {
    test('refuses with a TypeError an id, an actor id or a user id that is no UUID in every call, before any statement: with the database down as with it up, where nothing is written', async (t) => {
      const down = await createDownDb(t);
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const userId = await insertUser(testDb, { firstName: 'Anna' });
      const calls = listWrongIdCalls({ userId, actorId: managerId });
      const stateBefore = await readState(testDb, STATE_TABLES);
      const downErrors = await mapSeries(calls, ([call]) => rejectionOf(down.run(call)));
      const upErrors = await mapSeries(calls, ([call]) => rejectionOf(runInApp(fastify, call)));
      const reached = await rejectionOf(down.run(() => readUser(userId)));

      [downErrors, upErrors].forEach((errors) => errors.forEach((error, index) => assertTypeError(error, calls[index][1])));
      assert.equal(reached.code, REFUSED_CONNECTION_CODE, inspect(reached));
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
    });

    test('refuses with a TypeError an input that is no object and a name or an email the schema of the routes refuses, and with 409 NO_CHANGES an input with no field the call changes, before any statement: with the database down as with it up, where nothing is written', async (t) => {
      const down = await createDownDb(t);
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const userId = await insertUser(testDb, { email: createEmail('kept'), firstName: 'Anna' });
      const calls = listWrongInputCalls({ userId, actorId: managerId });
      const unchanging = listUnchangingCalls({ userId, actorId: managerId });
      const stateBefore = await readState(testDb, STATE_TABLES);
      const runs = [down.run, (call) => runInApp(fastify, call)];
      const errors = await mapSeries(runs, (runIn) => mapSeries(calls, ([call]) => rejectionOf(runIn(call))));
      const unchanged = await mapSeries(runs, (runIn) => mapSeries(unchanging, (call) => rejectionOf(runIn(call))));
      const reached = await rejectionOf(down.run(() => updateUser({ id: userId, input: { firstName: 'Taras' }, actorId: managerId })));

      errors.forEach((byContext) => byContext.forEach((error, index) => assertTypeError(error, calls[index][1])));
      unchanged.forEach((byContext) => byContext.forEach((error) => assertAppError(error, REFUSAL.NO_CHANGES)));
      assert.equal(reached.code, REFUSED_CONNECTION_CODE, inspect(reached));
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
    });

    test('refuses with 403 a manager who would change, block, unblock or delete themselves, before any statement and though they hold full access: their row, their sessions and the records stay', async (t) => {
      const down = await createDownDb(t);
      const rootId = await createActor(testDb, [SCOPE_ALL]);
      const { sid } = await signIn(fastify, { userId: rootId });
      const calls = listManagedCalls(rootId, rootId);
      const stateBefore = await readState(testDb, STATE_TABLES);
      const errors = [
        ...await mapSeries(calls, (call) => rejectionOf(down.run(call))),
        ...await mapSeries(calls, (call) => rejectionOf(runInApp(fastify, call))),
      ];

      errors.forEach((error) => assertAppError(error, REFUSAL.FORBIDDEN));
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
      assert.equal(await isAliveIn(fastify, sid), true);
    });
  });

  describe('the reads of users', () => {
    test('listUsers gives the rows of a list, newest first, each with the fields of a list row only, filtered by the first name and the status as the query of the route names them', async () => {
      const [activeId, blockedId] = await mapSeries([USER_STATUS.ACTIVE, USER_STATUS.BLOCKED], (status) => insertUser(testDb, { email: createEmail('listed'), firstName: 'Bohdana', status }));

      await insertUser(testDb, { firstName: 'Svitlana' });

      const [named, blocked] = await mapSeries([
        { firstName: 'Bohdana' },
        { firstName: 'Bohdana', status: [USER_STATUS.BLOCKED] },
      ], (payload) => runInApp(fastify, () => listUsers(payload)));

      assert.deepEqual(named.data.map((user) => user.id), [blockedId, activeId]);
      assert.deepEqual(blocked.data.map((user) => user.id), [blockedId]);
      named.data.forEach((user) => assert.deepEqual(Object.keys(user).toSorted(), SORTED_LIST_FIELDS));
    });

    test('readUser and readOwnProfile read a user with every field of the schema, the one as the other', async () => {
      const userId = await insertUser(testDb, {
        email: createEmail('read'),
        emailVerifiedAt: VERIFIED_AT,
        firstName: 'Anna',
        lastName: 'Kovalenko',
      });
      const [read, own] = await mapSeries([readUser, readOwnProfile], (call) => runInApp(fastify, () => call(userId)));

      assert.deepEqual(Object.keys(read).toSorted(), SORTED_USER_FIELDS);
      assert.deepEqual(own, read);
      assert.deepEqual(pick(read, ['id', 'emailVerifiedAt', 'firstName', 'lastName', 'status']), {
        id: userId,
        emailVerifiedAt: VERIFIED_AT,
        firstName: 'Anna',
        lastName: 'Kovalenko',
        status: USER_STATUS.ACTIVE,
      });
    });

    test('readUser answers 404 for a user who is not there, as every call of a manager does before the manager is judged: also for an actor who holds nothing or is no user, and nothing is written', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const nobodyId = await createUser(testDb);
      const missingId = uuidv7();
      const calls = [
        () => readUser(missingId),
        ...[managerId, nobodyId, uuidv7()].flatMap((actorId) => listManagedCalls(missingId, actorId)),
      ];
      const stateBefore = await readState(testDb, STATE_TABLES);
      const errors = await mapSeries(calls, (call) => rejectionOf(runInApp(fastify, call)));

      errors.forEach((error) => assertAppError(error, REFUSAL.NOT_FOUND));
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
    });
  });

  describe('the calls of one\'s own account', () => {
    test('sign out one whose user is there no more and refuse one who is blocked: readOwnProfile, updateOwnProfile and removeOwnAccount answer 401 for the first, the last two 403 for the second, whose row, memberships and sessions stay', async () => {
      const [deletedId, blockedId] = await mapSeries(['deleted', 'blocked'], () => insertUser(testDb, { firstName: 'Anna' }));
      const { id: groupId } = await insertGroup(testDb);

      await testDb.readRows(DELETE_USER_SQL, { id: deletedId });
      await joinGroup(testDb, { userId: blockedId, groupId });

      const { sid } = await signIn(fastify, { userId: blockedId });

      // Blocked by hand, as a session that is still alive meets it.
      await testDb.readRows(STATUS_SQL, { id: blockedId, status: USER_STATUS.BLOCKED });

      const stateBefore = await readState(testDb, STATE_TABLES);
      const goneErrors = await mapSeries([deletedId, uuidv7()].flatMap((userId) => [
        () => readOwnProfile(userId),
        () => updateOwnProfile({ userId, input: { firstName: 'Taras' } }),
        () => removeOwnAccount({ userId, request: TEST_REQUEST }),
      ]), (call) => rejectionOf(runInApp(fastify, call)));
      const blockedErrors = await mapSeries([
        () => updateOwnProfile({ userId: blockedId, input: { firstName: 'Taras' } }),
        () => removeOwnAccount({ userId: blockedId, request: TEST_REQUEST }),
      ], (call) => rejectionOf(runInApp(fastify, call)));

      goneErrors.forEach((error) => assertAppError(error, REFUSAL.UNAUTHENTICATED));
      blockedErrors.forEach((error) => assertAppError(error, REFUSAL.FORBIDDEN));
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
      assert.equal(await isAliveIn(fastify, sid), true);
    });

    test('updateOwnProfile stores a name as normalizePersonName makes it, trimmed, a letter of a font made plain and composed to NFC, and never an email; null clears a name, one left out keeps its column, the names a user has already in another form are answered as they are, and no record is written', async () => {
      const email = createEmail('own');
      const userId = await insertUser(testDb, { email, firstName: 'Anna', lastName: 'Shevchenko' });
      const rawFirstName = `  ${DECOMPOSED_NAME} `;
      const rawLastName = `${BOLD_CAPITAL_K}ovalenko`;
      const named = await updateOwn(userId, { firstName: rawFirstName, lastName: rawLastName, email: createEmail('ignored') });
      const namedRow = await readUserRow(userId);
      const cleared = await updateOwn(userId, { lastName: null });
      const same = await updateOwn(userId, { firstName: DECOMPOSED_NAME, lastName: null });

      assert.deepEqual([normalizePersonName(rawFirstName), normalizePersonName(rawLastName)], [COMPOSED_NAME, 'Kovalenko']);
      assert.deepEqual(pick(named, ['email', 'firstName', 'lastName']), { email, firstName: COMPOSED_NAME, lastName: 'Kovalenko' });
      assert.deepEqual([namedRow.email, namedRow.first_name, namedRow.last_name], [email, COMPOSED_NAME, 'Kovalenko']);
      assert.deepEqual(Object.keys(named).toSorted(), SORTED_USER_FIELDS);
      assert.deepEqual([cleared.firstName, cleared.lastName], [COMPOSED_NAME, null]);
      assert.deepEqual(same, cleared);
      assert.deepEqual(await readAudit(testDb, userId), []);
    });
  });

  describe('updateUser', () => {
    test('stores an email trimmed, in lower case and composed to NFC, and confirms it at the moment of the change only when the stored address changes: the same address in another form changes nothing, a confirmed one keeps the moment of its confirmation and one nobody has confirmed stays unconfirmed', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const tag = uuidv7();
      const composed = `jos${SMALL_E_WITH_ACUTE}-${tag}@example.test`;
      const userId = await insertUser(testDb, { email: composed, emailVerifiedAt: VERIFIED_AT });
      const unconfirmed = createEmail('unconfirmed');
      const unconfirmedId = await insertUser(testDb, { email: unconfirmed });
      const sameForms = [` ${composed.toUpperCase()} `, `JOSE${COMBINING_ACUTE}-${tag.toUpperCase()}@Example.TEST`];
      const kept = await mapSeries(sameForms, (email) => update(userId, { email }, managerId));
      const keptRow = await readUserRow(userId);
      const retyped = await update(unconfirmedId, { email: ` ${unconfirmed.toUpperCase()} ` }, managerId);
      const [moved, span] = await timeCall(() => update(userId, { email: `  Zoe${COMBINING_DIAERESIS}-${tag}@Example.TEST ` }, managerId));
      const movedRow = await readUserRow(userId);
      const movedEmail = `zo${SMALL_E_WITH_DIAERESIS}-${tag}@example.test`;

      kept.forEach((user) => assert.deepEqual([user.email, user.emailVerifiedAt], [composed, VERIFIED_AT]));
      assert.deepEqual([keptRow.email, keptRow.email_verified_at], [composed, VERIFIED_AT]);
      assert.deepEqual([retyped.email, retyped.emailVerifiedAt], [unconfirmed, null]);
      assert.equal(moved.email, movedEmail);
      assertWithin(moved.emailVerifiedAt, span);
      assert.deepEqual([movedRow.email, movedRow.email_verified_at], [movedEmail, moved.emailVerifiedAt]);
      assert.deepEqual(await mapSeries([userId, unconfirmedId], (id) => readAudit(testDb, id)), [
        [updateRecordOf(userId, managerId, ['email', 'emailVerifiedAt'])],
        [],
      ]);
    });

    test('records user.update by the manager with the names of the changed fields in the order email, firstName, lastName, emailVerifiedAt and none of their values: emailVerifiedAt whenever the change of the email changes its confirmation, a new address confirmed at that moment and null cleared, and the values a user has already write no record and keep updatedAt and that moment', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const verifiedId = await insertUser(testDb, {
        email: createEmail('verified'),
        emailVerifiedAt: VERIFIED_AT,
        firstName: 'Anna',
        lastName: 'Kovalenko',
      });
      const unverifiedId = await insertUser(testDb, { email: createEmail('unverified'), firstName: 'Anna' });
      const clearedId = await insertUser(testDb, { email: createEmail('cleared'), emailVerifiedAt: VERIFIED_AT, firstName: 'Anna' });
      const unmailedId = await insertUser(testDb, { email: createEmail('unmailed'), firstName: 'Anna' });
      const moved = createEmail('moved');
      const [changed, changedSpan] = await timeCall(() => update(verifiedId, { lastName: ' Shevchenko ', firstName: 'Taras', email: moved.toUpperCase() }, managerId));
      const same = await update(verifiedId, { firstName: ' Taras', lastName: 'Shevchenko', email: ` ${moved} ` }, managerId);
      const [renamed, renamedSpan] = await timeCall(() => update(unverifiedId, { email: createEmail('other'), firstName: 'Taras' }, managerId));
      const cleared = await update(clearedId, { email: null, firstName: null }, managerId);
      const unmailed = await update(unmailedId, { email: null }, managerId);

      assert.deepEqual(pick(changed, ['email', 'firstName', 'lastName']), { email: moved, firstName: 'Taras', lastName: 'Shevchenko' });
      assertWithin(changed.emailVerifiedAt, changedSpan);
      assert.deepEqual(Object.keys(changed).toSorted(), SORTED_USER_FIELDS);
      assert.deepEqual(same, changed);
      assert.equal(renamed.firstName, 'Taras');
      assertWithin(renamed.emailVerifiedAt, renamedSpan);
      assert.deepEqual(pick(cleared, ['email', 'emailVerifiedAt', 'firstName']), { email: null, emailVerifiedAt: null, firstName: null });
      assert.deepEqual(pick(unmailed, ['email', 'emailVerifiedAt']), { email: null, emailVerifiedAt: null });
      assert.deepEqual(await mapSeries([verifiedId, unverifiedId, clearedId, unmailedId], (id) => readAudit(testDb, id)), [
        [updateRecordOf(verifiedId, managerId, ['email', 'firstName', 'lastName', 'emailVerifiedAt'])],
        [updateRecordOf(unverifiedId, managerId, ['email', 'firstName', 'emailVerifiedAt'])],
        [updateRecordOf(clearedId, managerId, ['email', 'firstName', 'emailVerifiedAt'])],
        [updateRecordOf(unmailedId, managerId, ['email'])],
      ]);
    });

    test('refuses an email another user holds, in whatever case it is typed, with the unique violation of uq_users_email, and writes neither the email nor the names beside it', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const taken = createEmail('taken');

      await insertUser(testDb, { email: taken, emailVerifiedAt: VERIFIED_AT });

      const userId = await insertUser(testDb, { firstName: 'Anna' });
      const stateBefore = await readState(testDb, STATE_TABLES);
      const error = await rejectionOf(update(userId, { firstName: 'Taras', email: ` ${taken.toUpperCase()} ` }, managerId));

      assert.equal(findUniqueViolation(error)?.constraint, UNIQUE_INDEX.USERS_EMAIL, inspect(error));
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
    });

    test('has the manager answer for an address it sets: a sign-in whose provider verifies that address for a subject no account has merges into that user, whether the address was their first or replaced a confirmed one, as into a user whose address was confirmed before, and makes no user', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const confirmed = createEmail('confirmed');
      const confirmedId = await insertUser(testDb, { email: confirmed, emailVerifiedAt: VERIFIED_AT });
      const freshId = await insertUser(testDb);
      const movedId = await insertUser(testDb, { email: createEmail('before'), emailVerifiedAt: VERIFIED_AT });
      const [free, moved] = [createEmail('free'), createEmail('moved')];

      await update(freshId, { email: free }, managerId);
      await update(movedId, { email: moved }, managerId);

      const usersBefore = await readState(testDb, [TABLE.USERS]);
      const signedIn = await mapSeries([free, moved, confirmed], (email) => signInByProvider(fastify, GOOGLE, verifiedProfileOf(email)));

      assert.deepEqual(signedIn.map((session) => session.userId), [freshId, movedId, confirmedId]);
      assert.deepEqual(await readState(testDb, [TABLE.USERS]), usersBefore);
    });

    test('lets a new subject of an address it sets merge into the account before any sign-in of the owner, and keeps the moment of the change as the confirmation when the owner\'s own identity signs in with that address verified later', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const userId = await insertUser(testDb, { firstName: 'Anna' });
      const subject = await insertIdentity(testDb, { userId, provider: GOOGLE });
      const address = createEmail('owned');
      const [, span] = await timeCall(() => update(userId, { email: address }, managerId));
      const confirmed = await readUserRow(userId);
      const merged = await signInByProvider(fastify, GOOGLE, verifiedProfileOf(address));
      const own = await signInByProvider(fastify, GOOGLE, verifiedProfileOf(address, { subject }));

      assertWithin(confirmed.email_verified_at, span);
      assert.deepEqual([merged.userId, own.userId], [userId, userId]);
      assert.deepEqual(await readUserRow(userId), confirmed);
    });
  });

  describe('blockUser and unblockUser', () => {
    test('blockUser makes the user blocked, revokes every session of theirs in the database, in the memory of the process and in Redis, and records user.block by the manager; a block of one who is blocked already ends the sessions made since and writes no record', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const userId = await createUser(testDb);
      const sids = await mapSeries(['first', 'second'], async () => (await signIn(fastify, { userId })).sid);
      const blocked = await block(userId, managerId);

      // A session made around a block written outside this API.
      await testDb.readRows(STATUS_SQL, { id: userId, status: USER_STATUS.ACTIVE });

      const { sid: laterSid } = await signIn(fastify, { userId });

      await testDb.readRows(STATUS_SQL, { id: userId, status: USER_STATUS.BLOCKED });

      const again = await block(userId, managerId);
      const allSids = [...sids, laterSid];

      assert.deepEqual([blocked.status, again.status], [USER_STATUS.BLOCKED, USER_STATUS.BLOCKED]);
      assert.deepEqual(Object.keys(blocked).toSorted(), SORTED_USER_FIELDS);
      assert.deepEqual(await readRevokedFlags(userId), [true, true, true]);
      assert.deepEqual(await mapSeries(allSids, (sid) => isAliveIn(fastify, sid)), [false, false, false]);
      assert.deepEqual(await readRegistryMarks(testRedis, allSids), [REVOKED_MARK, REVOKED_MARK, REVOKED_MARK]);
      assert.deepEqual(await readAudit(testDb, userId), [auditRecordOf(AUDIT_ACTION.USER_BLOCK, { entityId: userId, actorId: managerId })]);
    });

    test('unblockUser makes a blocked user active again with a record of user.unblock by the manager, the ended sessions stay ended, and an active user is answered as they are with no write and no record', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const userId = await createUser(testDb);
      const { sid } = await signIn(fastify, { userId });

      await block(userId, managerId);

      const unblocked = await unblock(userId, managerId);
      const again = await unblock(userId, managerId);

      assert.equal(unblocked.status, USER_STATUS.ACTIVE);
      assert.deepEqual(Object.keys(unblocked).toSorted(), SORTED_USER_FIELDS);
      assert.deepEqual(again, unblocked);
      assert.equal(await isAliveIn(fastify, sid), false);
      assert.deepEqual(await readAudit(testDb, userId), [
        auditRecordOf(AUDIT_ACTION.USER_BLOCK, { entityId: userId, actorId: managerId }),
        auditRecordOf(AUDIT_ACTION.USER_UNBLOCK, { entityId: userId, actorId: managerId }),
      ]);
    });
  });

  describe('removeUser and removeOwnAccount', () => {
    test('remove a user with their identities, memberships and sessions, tell the registry and record user.delete with the sorted ids of their groups, by the manager for removeUser and by the user themselves for removeOwnAccount; a membership they granted stays without their id and a record they wrote keeps it, the reads stop showing them at once, and their identity signs in again as a new user, since a deletion is no ban', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const groupIds = await mapSeries(['first', 'second'], async () => (await insertGroup(testDb)).id);
      const [firstGroupId] = groupIds;
      const userIds = await mapSeries(['own', 'removed'], () => insertUser(testDb, { firstName: 'Anna' }));
      const [ownId, removedId] = userIds;
      const keptId = await createUser(testDb);

      const [ownSubject] = await mapSeries(userIds, async (userId) => {
        await mapSeries(groupIds.toReversed(), (groupId) => joinGroup(testDb, { userId, groupId }));

        return insertIdentity(testDb, { userId, provider: GOOGLE });
      });

      await joinGroup(testDb, { userId: keptId, groupId: firstGroupId, grantedBy: ownId });
      await testDb.readRows(INSERT_AUDIT_SQL, {
        actorId: ownId,
        action: AUDIT_ACTION.USER_UPDATE,
        entityType: TABLE.USERS,
        entityId: keptId,
      });

      const sids = await mapSeries(userIds, async (userId) => (await signIn(fastify, { userId })).sid);

      // Outside a transaction, as a read of the API runs: served from the cache while the version of users stays.
      await runInApp(fastify, () => readUser(ownId));
      await testDb.readRows(RENAME_SQL, { id: ownId, firstName: 'Olena' });

      const cached = await runInApp(fastify, () => readUser(ownId));
      const membersBefore = await runInApp(fastify, () => listMembers({ groupId: firstGroupId, payload: {} }));
      const removed = [await removeOwn(ownId), await remove(removedId, managerId)];
      const [left] = await testDb.readRows(LEFT_SQL, { ids: userIds });
      const membersAfter = await runInApp(fastify, () => listMembers({ groupId: firstGroupId, payload: {} }));
      const readError = await rejectionOf(runInApp(fastify, () => readUser(ownId)));
      const groupIdsSorted = groupIds.toSorted();

      assert.equal(cached.firstName, 'Anna');
      assert.deepEqual(removed, [true, true]);
      assert.deepEqual(left, {
        users: 0,
        identities: 0,
        memberships: 0,
        sessions: 0,
      });
      assert.deepEqual(membersBefore.data.map((user) => user.id).toSorted(), [...userIds, keptId].toSorted());
      assert.deepEqual(membersAfter.data.map((user) => user.id), [keptId]);
      assertAppError(readError, REFUSAL.NOT_FOUND);
      assert.deepEqual(await testDb.readRows(GRANTED_BY_SQL, { userId: keptId }), [{ granted_by: null }]);
      assert.deepEqual((await readAudit(testDb, keptId)).map((record) => record.actor_id), [ownId]);
      assert.deepEqual(await readAudit(testDb, ownId), [auditRecordOf(AUDIT_ACTION.USER_DELETE, {
        entityId: ownId,
        actorId: ownId,
        meta: { groupIds: groupIdsSorted },
      })]);
      assert.deepEqual(await readAudit(testDb, removedId), [auditRecordOf(AUDIT_ACTION.USER_DELETE, {
        entityId: removedId,
        actorId: managerId,
        meta: { groupIds: groupIdsSorted },
      })]);
      assert.deepEqual(await mapSeries(sids, (sid) => isAliveIn(fastify, sid)), [false, false]);
      assert.deepEqual(await readRegistryMarks(testRedis, sids), [REVOKED_MARK, REVOKED_MARK]);

      const returned = await signInByProvider(fastify, GOOGLE, verifiedProfileOf(createEmail('back'), { subject: ownSubject }));

      assert.equal(userIds.includes(returned.userId), false);
      assert.equal((await readUserRow(returned.userId))?.status, USER_STATUS.ACTIVE);
    });

    test('a removal or a block that the transaction around it rolls back leaves nothing of any statement it has run: the user, their identity, memberships, sessions and records stay, and no session is marked revoked in the memory of the process or in Redis', async () => {
      const rootId = await createActor(testDb, [SCOPE_ALL]);
      const { id: groupId } = await insertGroup(testDb);
      const userIds = await mapSeries(['own', 'removed', 'blocked'], () => insertUser(testDb, { firstName: 'Anna' }));
      const [ownId, removedId, blockedId] = userIds;

      await mapSeries(userIds, async (userId) => {
        await joinGroup(testDb, { userId, groupId, grantedBy: rootId });
        await insertIdentity(testDb, { userId, provider: GOOGLE });
      });

      const sids = await mapSeries(userIds, async (userId) => (await signIn(fastify, { userId })).sid);
      const stateBefore = await readState(testDb, STATE_TABLES);
      const seen = await mapSeries([
        [() => removeOwnAccount({ userId: ownId, request: TEST_REQUEST }), ownId],
        [() => removeUser({ id: removedId, actorId: rootId, request: TEST_REQUEST }), removedId],
        [() => blockUser({ id: blockedId, actorId: rootId, request: TEST_REQUEST }), blockedId],
      ], ([call, userId]) => runRolledBack(call, userId));

      assert.deepEqual([seen[0].result, seen[1].result, seen[2].result.status], [true, true, USER_STATUS.BLOCKED]);
      assert.deepEqual(seen.map((item) => pick(item, ['status', 'live', 'records'])), [
        { status: null, live: 0, records: 1 },
        { status: null, live: 0, records: 1 },
        { status: USER_STATUS.BLOCKED, live: 0, records: 1 },
      ]);
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
      assert.deepEqual(await mapSeries(sids, (sid) => isAliveIn(fastify, sid)), [true, true, true]);
      assert.deepEqual(await readRegistryMarks(testRedis, sids), [ALIVE_MARK, ALIVE_MARK, ALIVE_MARK]);
    });
  });

  describe('the manager', () => {
    test('is judged by what the database holds at each call: one who lacks users:manage, a scope the user holds or the full access the user holds, one blocked and one whose row is gone since their last call are refused with 403 by every call of a manager, and nothing is written', async () => {
      const readerId = await createActor(testDb, [SCOPE.USERS_READ]);
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const [blockedId, goneId] = await mapSeries(['blocked', 'gone'], () => createActor(testDb, [SCOPE_ALL]));
      const plainId = await createUser(testDb);
      const scopedId = await createActor(testDb, [SCOPE.GROUPS_READ]);
      const fullId = await createActor(testDb, [SCOPE_ALL]);
      const lastCalls = [await update(plainId, { firstName: 'Anna' }, goneId), await update(plainId, { lastName: 'Kovalenko' }, blockedId)];

      await testDb.readRows(DELETE_USER_SQL, { id: goneId });
      await testDb.readRows(STATUS_SQL, { id: blockedId, status: USER_STATUS.BLOCKED });

      const calls = [
        [readerId, plainId],
        [managerId, scopedId],
        [managerId, fullId],
        [blockedId, plainId],
        [goneId, plainId],
      ].flatMap(([actorId, id]) => listManagedCalls(id, actorId));
      const stateBefore = await readState(testDb, STATE_TABLES);
      const errors = await mapSeries(calls, (call) => rejectionOf(runInApp(fastify, call)));

      assert.deepEqual(lastCalls.map((user) => [user.firstName, user.lastName]), [['Anna', null], ['Anna', 'Kovalenko']]);
      errors.forEach((error) => assertAppError(error, REFUSAL.FORBIDDEN));
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
    });

    test('may change, block, unblock and delete a user whose every scope they hold: users:* holds users:manage and users:read, and only full access holds a user with full access', async () => {
      const wildId = await createActor(testDb, [SCOPE.USERS_ALL]);
      const readerId = await createActor(testDb, [SCOPE.USERS_READ]);
      const [rootId, fullId] = await mapSeries(['root', 'full'], () => createActor(testDb, [SCOPE_ALL]));
      const refused = await rejectionOf(update(fullId, { firstName: 'Ivan' }, wildId));
      const outcomes = [
        await update(readerId, { firstName: 'Taras' }, wildId),
        await block(readerId, wildId),
        await unblock(readerId, wildId),
        await update(fullId, { firstName: 'Ivan' }, rootId),
        await block(fullId, rootId),
        await unblock(fullId, rootId),
      ];
      const removed = [await remove(readerId, wildId), await remove(fullId, rootId)];

      assertAppError(refused, REFUSAL.FORBIDDEN);
      assert.deepEqual(outcomes.map((user) => [user.id, user.firstName, user.status]), [
        [readerId, 'Taras', USER_STATUS.ACTIVE],
        [readerId, 'Taras', USER_STATUS.BLOCKED],
        [readerId, 'Taras', USER_STATUS.ACTIVE],
        [fullId, 'Ivan', USER_STATUS.ACTIVE],
        [fullId, 'Ivan', USER_STATUS.BLOCKED],
        [fullId, 'Ivan', USER_STATUS.ACTIVE],
      ]);
      assert.deepEqual(removed, [true, true]);
      assert.deepEqual(await mapSeries([readerId, fullId], (id) => readUserRow(id)), [null, null]);
    });

    test('cannot block or delete the last active member of a group of the system with full access, admin of the seed: blockUser, removeUser and removeOwnAccount answer 409 GROUP_PROTECTED, before 403 for an actor who holds nothing, where updateUser and unblockUser judge the actor; a blocked member may be deleted, and with another active member the last one may be blocked', async () => {
      const adminId = await readAdminId(testDb);
      const rootId = await createActor(testDb, [SCOPE_ALL]);
      const [nobodyId, lastId] = await mapSeries(['nobody', 'last'], () => createUser(testDb));
      const blockedMemberId = await createUser(testDb, { status: USER_STATUS.BLOCKED });

      await mapSeries([lastId, blockedMemberId], (userId) => joinGroup(testDb, { userId, groupId: adminId }));

      const stateBefore = await readState(testDb, STATE_TABLES);
      const protectedErrors = await mapSeries([
        () => block(lastId, rootId),
        () => remove(lastId, rootId),
        () => block(lastId, nobodyId),
        () => remove(lastId, nobodyId),
        () => removeOwn(lastId),
      ], (call) => rejectionOf(call()));
      const forbiddenErrors = await mapSeries([
        () => update(lastId, { firstName: 'Taras' }, nobodyId),
        () => unblock(lastId, nobodyId),
      ], (call) => rejectionOf(call()));

      protectedErrors.forEach((error) => assertAppError(error, REFUSAL.PROTECTED));
      forbiddenErrors.forEach((error) => assertAppError(error, REFUSAL.FORBIDDEN));
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);

      const secondId = await createUser(testDb);
      const renamed = await update(lastId, { firstName: 'Taras' }, rootId);
      const isBlockedMemberRemoved = await remove(blockedMemberId, rootId);

      await joinGroup(testDb, { userId: secondId, groupId: adminId });

      const blocked = await block(lastId, rootId);
      const secondError = await rejectionOf(removeOwn(secondId));

      assert.equal(renamed.firstName, 'Taras');
      assert.equal(isBlockedMemberRemoved, true);
      assert.equal(blocked.status, USER_STATUS.BLOCKED);
      assertAppError(secondError, REFUSAL.PROTECTED);
    });
  });

  // APP_ADMIN_EMAILS makes such a user an admin at their next sign-in: they count as a holder of full access.
  describe('an admin candidate', () => {
    // The app of the before() lists the address; this one, as a server before the list grew, does not.
    test('is not made by an address a manager without full access sets before it is listed: under the list the own sign-in of that account gets no full access, and the owner of the address is refused with CONTACT_TAKEN and writes nothing', async (t) => {
      const unlistedApp = await testDb.buildApp({ db: SMALL_POOL });

      t.after(() => unlistedApp.close());

      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const altId = await insertUser(testDb);
      const altEmail = createEmail('alt');
      const altSubject = await insertIdentity(testDb, {
        userId: altId,
        provider: GOOGLE,
        email: altEmail,
        isEmailVerified: true,
      });

      await runInApp(unlistedApp, () => updateUser({
        id: altId,
        input: { email: ADMIN.LISTED_LATER },
        actorId: managerId,
        request: TEST_REQUEST,
      }));

      const own = await signInByProvider(fastify, GOOGLE, verifiedProfileOf(altEmail, { subject: altSubject }));
      const stateBefore = await readState(testDb, STATE_TABLES);
      const error = await rejectionOf(signInByProvider(fastify, GOOGLE, verifiedProfileOf(ADMIN.LISTED_LATER)));

      assert.deepEqual([own.userId, own.scopes], [altId, []]);
      assert.notEqual((await readUserRow(altId)).email_verified_at, null);
      assertAppError(error, REFUSAL.CONTACT_TAKEN);
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
    });

    test('is refused with 403 to a manager without full access by every call of a manager: an address of the list on the row, verified or not, blocked or not, and, while the row has none, a listed address of an identity that its provider has confirmed; nothing is written and their session stays', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const verifiedId = await insertUser(testDb, { email: ADMIN.VERIFIED, emailVerifiedAt: VERIFIED_AT, firstName: 'Anna' });
      const unverifiedId = await insertUser(testDb, { email: ADMIN.UNVERIFIED, firstName: 'Anna' });
      const identityId = await insertUser(testDb, { firstName: 'Anna' });
      const blockedId = await insertUser(testDb, { email: ADMIN.BLOCKED, status: USER_STATUS.BLOCKED });

      await insertIdentity(testDb, {
        userId: identityId,
        provider: GOOGLE,
        email: ADMIN.IDENTITY,
        isEmailVerified: true,
      });

      const { sid } = await signIn(fastify, { userId: verifiedId });
      const calls = [verifiedId, unverifiedId, identityId, blockedId].flatMap((id) => listManagedCalls(id, managerId));
      const stateBefore = await readState(testDb, STATE_TABLES);
      const errors = await mapSeries(calls, (call) => rejectionOf(runInApp(fastify, call)));

      errors.forEach((error) => assertAppError(error, REFUSAL.FORBIDDEN));
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
      assert.equal(await isAliveIn(fastify, sid), true);
    });

    test('is made by a change that a manager without full access is refused with 403: an address of the list set on the row, in whatever form it is typed, and the address taken off a row while an identity holds a listed one that its provider has confirmed; nothing is written', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const plainId = await insertUser(testDb, { email: createEmail('plain'), firstName: 'Anna' });
      const behindId = await insertUser(testDb, { email: createEmail('behind') });

      await insertIdentity(testDb, {
        userId: behindId,
        provider: GOOGLE,
        email: ADMIN.BEHIND,
        isEmailVerified: true,
      });

      const stateBefore = await readState(testDb, STATE_TABLES);
      const errors = await mapSeries([
        [plainId, { email: ADMIN.SET }],
        [plainId, { email: ` ${ADMIN.SET.toUpperCase()} ` }],
        [plainId, { firstName: 'Taras', email: ADMIN.SET }],
        [behindId, { email: null }],
      ], ([id, input]) => rejectionOf(update(id, input, managerId)));

      errors.forEach((error) => assertAppError(error, REFUSAL.FORBIDDEN));
      assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
    });

    test('is none for an address off the list on the row, beside a listed one of an identity too, for a listed address of an identity that its provider has not confirmed, nor for a user with no listed address anywhere: a manager without full access changes, blocks, unblocks and deletes them, and takes the address off a row beside an unconfirmed listed one', async () => {
      const managerId = await createActor(testDb, [SCOPE.USERS_MANAGE]);
      const plainId = await insertUser(testDb, { email: createEmail('plain'), emailVerifiedAt: VERIFIED_AT });
      const besideId = await insertUser(testDb, { email: createEmail('beside') });
      const unconfirmedId = await insertUser(testDb);
      const bareId = await insertUser(testDb);
      const clearedId = await insertUser(testDb, { email: createEmail('cleared') });
      const moved = createEmail('moved');

      await mapSeries([
        [besideId, ADMIN.BESIDE, true],
        [unconfirmedId, ADMIN.UNCONFIRMED, false],
        [bareId, createEmail('identity'), true],
        [clearedId, ADMIN.CLEARED, false],
      ], ([userId, email, isEmailVerified]) => insertIdentity(testDb, {
        userId,
        provider: GOOGLE,
        email,
        isEmailVerified,
      }));

      const userIds = [plainId, besideId, unconfirmedId, bareId];
      const outcomes = await mapSeries(userIds, async (id) => [
        await update(id, { firstName: 'Taras' }, managerId),
        await block(id, managerId),
        await unblock(id, managerId),
      ]);
      const [movedUser, movedSpan] = await timeCall(() => update(plainId, { email: moved }, managerId));
      const clearedUser = await update(clearedId, { email: null }, managerId);
      const removed = await mapSeries(userIds, (id) => remove(id, managerId));

      assert.deepEqual(outcomes.map((users) => users.map((user) => [user.id, user.firstName, user.status])), userIds.map((id) => [
        [id, 'Taras', USER_STATUS.ACTIVE],
        [id, 'Taras', USER_STATUS.BLOCKED],
        [id, 'Taras', USER_STATUS.ACTIVE],
      ]));
      assert.equal(movedUser.email, moved);
      assertWithin(movedUser.emailVerifiedAt, movedSpan);
      assert.deepEqual([clearedUser.id, clearedUser.email], [clearedId, null]);
      assert.deepEqual(removed, [true, true, true, true]);
      assert.deepEqual(await mapSeries(userIds, (id) => readUserRow(id)), [null, null, null, null]);
    });

    test('is managed by a holder of full access: they change, block, unblock and delete a candidate of the row and one of an identity, and make one by either change', async () => {
      const rootId = await createActor(testDb, [SCOPE_ALL]);
      const heldId = await insertUser(testDb, { email: ADMIN.HELD, emailVerifiedAt: VERIFIED_AT });
      const identityId = await insertUser(testDb, { email: createEmail('kept') });
      const plainId = await insertUser(testDb);

      await insertIdentity(testDb, {
        userId: identityId,
        provider: GOOGLE,
        email: ADMIN.HELD_IDENTITY,
        isEmailVerified: true,
      });

      const outcomes = [
        await update(heldId, { firstName: 'Ivan' }, rootId),
        await block(heldId, rootId),
        await unblock(heldId, rootId),
        await update(plainId, { email: ADMIN.GIVEN }, rootId),
        await update(identityId, { email: null }, rootId),
        await block(identityId, rootId),
        await unblock(identityId, rootId),
      ];
      const userIds = [heldId, plainId, identityId];
      const removed = await mapSeries(userIds, (id) => remove(id, rootId));

      assert.deepEqual(outcomes.map((user) => [user.id, user.email, user.firstName, user.status]), [
        [heldId, ADMIN.HELD, 'Ivan', USER_STATUS.ACTIVE],
        [heldId, ADMIN.HELD, 'Ivan', USER_STATUS.BLOCKED],
        [heldId, ADMIN.HELD, 'Ivan', USER_STATUS.ACTIVE],
        [plainId, ADMIN.GIVEN, null, USER_STATUS.ACTIVE],
        [identityId, null, null, USER_STATUS.ACTIVE],
        [identityId, null, null, USER_STATUS.BLOCKED],
        [identityId, null, null, USER_STATUS.ACTIVE],
      ]);
      assert.deepEqual(removed, [true, true, true]);
      assert.deepEqual(await mapSeries(userIds, (id) => readUserRow(id)), [null, null, null]);
    });
  });
});
