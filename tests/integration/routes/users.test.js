import { PAGINATION } from '#config/pagination.js';
import { invalidateCacheTables } from '#core/cache/index.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { SCHEMA_FORMAT } from '#enums/schema-format.js';
import { SCOPE, SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { DEV_ENV, readSpec } from '#root/tests/helper/guard.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  assertChallenged,
  assertError,
  assertForbidden,
  assertNoChanges,
  assertNotFound,
  assertOk,
  assertTaken,
  assertUnauthenticated,
  blockByHand,
  blockRequest,
  deleteMeRequest,
  deleteUserRequest,
  describeAudit,
  getMeRequest,
  getSessionRequest,
  getUserRequest,
  getUsersRequest,
  LONG_AGO,
  ME_URL,
  migrateAndSeed,
  openRouteApp,
  patchUserRequest,
  readAnsweredConflicts,
  readDocumentedConflicts,
  readFailures,
  readStatuses,
  send,
  setAdminMembers,
  signInAs,
  unblockRequest,
  USERS_URL,
} from '#root/tests/helper/route.js';
import {
  createUser,
  insertUser,
  readAppRows,
  readAudit,
  readSessionRow,
  readState,
  runInApp,
  signIn,
  toBearer,
} from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { rowToCamel } from '#utils/case.js';
import { nowUtc, toDate } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import { PERSON_NAME_MAX_LENGTH } from '#utils/person.js';
import { toJsonTree } from '#utils/serialize.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();

const UPDATE_ACTION = 'user.update';

const VERIFIED_AT = '2026-02-01T00:00:00.000Z';

// A row of a list of users; one user alone is answered with every column of the table.
const LIST_FIELDS = Object.freeze(['id', 'email', 'firstName', 'lastName', 'status', 'createdAt']);

const EMOJI = String.fromCodePoint(0x1F642);
// U+1D54D, a capital V of a mathematical font: a name keeps the plain letter.
const FONT_V = String.fromCodePoint(0x1D54D);
// U+20BB7, a CJK letter beyond the BMP: four bytes in UTF-8, which only utf8mb4 holds.
const WIDE_LETTER = String.fromCodePoint(0x20BB7);
// The first half of the four bytes of an emoji is no UTF-8: the parser of the query string keeps it as it came.
const BROKEN_SEQUENCE = '%F0%9F';
const LIKE_WILDCARD = '%';

// Each test of the list makes its users in a month of its own, which no other user of the file is made in.
const LIST_MONTH = Object.freeze({ createdAtFrom: '2021-03-01T00:00:00.000Z', createdAtTo: '2021-03-31T23:59:59.999Z' });
const TEXT_MONTH = Object.freeze({ createdAtFrom: '2022-03-01T00:00:00.000Z', createdAtTo: '2022-03-31T23:59:59.999Z' });
const CACHE_MONTH = Object.freeze({ createdAtFrom: '2023-03-01T00:00:00.000Z', createdAtTo: '2023-03-31T23:59:59.999Z' });

// Two of them made at one moment, and two first names that differ in case only: the id orders each pair. The name in
// lower case comes first, so that a sort by the bytes of the name would put it last.
const TWIN_MOMENT = '2021-03-12T08:00:00.000Z';
const PEOPLE = Object.freeze([
  Object.freeze({
    firstName: 'олена',
    lastName: 'Бондар',
    status: USER_STATUS.ACTIVE,
    createdAt: '2021-03-10T08:00:00.000Z',
  }),
  Object.freeze({
    firstName: 'Anna',
    lastName: 'Kovalenko',
    status: USER_STATUS.BLOCKED,
    createdAt: TWIN_MOMENT,
  }),
  Object.freeze({
    firstName: 'Олена',
    lastName: 'Шевченко',
    status: USER_STATUS.ACTIVE,
    createdAt: TWIN_MOMENT,
  }),
  Object.freeze({
    firstName: 'Oleh',
    lastName: 'Melnyk',
    status: USER_STATUS.ACTIVE,
    createdAt: '2021-03-14T08:00:00.000Z',
  }),
]);
// A millisecond after the end of the month of the list.
const OUTSIDER = Object.freeze({
  firstName: 'Олена',
  lastName: 'Kravets',
  status: USER_STATUS.ACTIVE,
  createdAt: '2021-04-01T00:00:00.000Z',
});
const TEXT_PEOPLE = Object.freeze([
  Object.freeze({ firstName: `${WIDE_LETTER}乃`, lastName: 'Yamada', createdAt: '2022-03-10T08:00:00.000Z' }),
  Object.freeze({ firstName: 'Олена', lastName: 'Lysenko', createdAt: '2022-03-12T08:00:00.000Z' }),
]);

// A user whose email a provider has confirmed, with every field of a profile filled.
const VERIFIED_PROFILE = Object.freeze({
  firstName: 'Olha',
  lastName: 'Melnyk',
  emailVerifiedAt: VERIFIED_AT,
  locale: 'uk',
  timezone: 'Europe/Kyiv',
});

// The answers to a token of these scopes, "*" for full access: the list, a user, a change of that user.
const ROUTE_ACCESS = Object.freeze([
  [[], [403, 403, 403]],
  [[SCOPE.GROUPS_ALL], [403, 403, 403]],
  [[SCOPE.USERS_READ], [200, 200, 403]],
  [[SCOPE.USERS_MANAGE], [200, 200, 200]],
  [[SCOPE.USERS_ALL], [200, 200, 200]],
  [[SCOPE_ALL], [200, 200, 200]],
]);

// Each a body against the schema, with the column and the operator of what is wrong in it.
const INVALID_BODIES = Object.freeze([
  [{ firstName: 'Dr. Anna' }, [['firstName', 'format']]],
  [{ firstName: 'Anna2' }, [['firstName', 'format']]],
  [{ lastName: `Kovalenko${EMOJI}` }, [['lastName', 'format']]],
  [{ lastName: 'K'.repeat(PERSON_NAME_MAX_LENGTH + 1) }, [['lastName', 'format']]],
  [{ firstName: '' }, [['firstName', 'format'], ['firstName', 'minLength']]],
  [{ firstName: 42 }, [['firstName', 'type']]],
  [{ email: 'anna.example.com' }, [['email', 'format']]],
]);

// Fields of a user that a change through the body does not write: the schema drops them, and nothing is left.
const FOREIGN_BODIES = Object.freeze([{}, { status: USER_STATUS.BLOCKED }, { emailVerifiedAt: null }, { locale: 'en' }]);

const USER_ROW_SQL = 'SELECT * FROM users WHERE id = :id';
const RENAME_SQL = 'UPDATE users SET last_name = :lastName WHERE id = :id';
const DELETE_USER_SQL = 'DELETE FROM users WHERE id = :id';
const AUDIT_ROWS_SQL = 'SELECT * FROM audit_logs WHERE entity_id = :entityId ORDER BY id';
const AUDIT_LOG_SQL = 'SELECT * FROM audit_logs ORDER BY id';

// The rows a change of a user writes: a refused one, or one with nothing to change, leaves each of them as it was.
const STATE_TABLES = Object.freeze([TABLE.USERS, TABLE.AUDIT_LOGS]);

function toQuery(params) {
  return `?${new URLSearchParams(params)}`;
}

function patchMeRequest(payload) {
  return { method: 'PATCH', url: ME_URL, payload };
}

// A user with every column written as the test names it, and so what the API answers about them.
async function createProfile(fastify, fields = {}) {
  const profile = {
    email: `user-${uuidv7()}@example.com`,
    emailVerifiedAt: null,
    firstName: null,
    lastName: null,
    locale: null,
    timezone: null,
    status: USER_STATUS.ACTIVE,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    ...fields,
  };
  const id = await insertUser(fastify, {
    ...profile,
    emailVerifiedAt: toDate(profile.emailVerifiedAt),
    createdAt: toDate(profile.createdAt),
    updatedAt: toDate(profile.updatedAt),
  });

  return { id, ...profile };
}

async function createListed(fastify, fields) {
  return pick(await createProfile(fastify, fields), LIST_FIELDS);
}

// The row as the API names its columns and writes its moments.
async function readProfile(fastify, id) {
  const [row] = await readAppRows(fastify, USER_ROW_SQL, { id });

  return toJsonTree(rowToCamel(row));
}

async function changeUser(fastify, actor, id, fields) {
  const response = await send(fastify, actor, patchUserRequest(id, fields));

  assert.equal(response.statusCode, 200, response.body);

  return response.json().data;
}

async function assertNoValues(fastify, entityId, values) {
  const text = JSON.stringify(await readAppRows(fastify, AUDIT_ROWS_SQL, { entityId }));

  values.forEach((value) => assert.ok(!text.includes(value), value));
}

// The text the list has searched the first names for, as the answer names it among its filters.
function readSearched(response) {
  return response.json().filters.find((filter) => filter.name === 'firstName').value;
}

describe('the guard of /api/v1/users', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('answers 401 with the Bearer challenge to a request without a token, with one that is none or with a refresh token, on the reads and the changes of users and of one\'s own profile', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const device = await signInAs(fastify, [SCOPE_ALL]);
    const userId = await createUser(fastify);
    const strangers = [null, { bearer: toBearer('not-a-token') }, { bearer: toBearer(device.issued.refreshToken) }];
    const requests = [
      getMeRequest(),
      patchMeRequest({ firstName: 'Stranger' }),
      getUsersRequest(),
      getUserRequest(userId),
      patchUserRequest(userId, { firstName: 'Stranger' }),
    ];
    const pairs = strangers.flatMap((stranger) => requests.map((request) => [stranger, request]));
    const responses = await mapSeries(pairs, ([stranger, request]) => send(fastify, stranger, request));

    responses.forEach((response) => assertChallenged(response));
  });

  test('lets the list and a user be read with users:read or users:manage and another user be changed with users:manage only, by a wildcard of the resource and full access too; one\'s own profile takes a token of no scope', async (t) => {
    const fastify = await openRouteApp(t, testDb);

    async function runRoutes([scopes]) {
      const actor = await signInAs(fastify, scopes);
      const userId = await createUser(fastify);

      return mapSeries([
        getUsersRequest(),
        getUserRequest(userId),
        patchUserRequest(userId, { firstName: 'Guarded' }),
      ], (request) => send(fastify, actor, request));
    }

    const answers = await mapSeries(ROUTE_ACCESS, runRoutes);
    const plain = await signInAs(fastify);
    const own = await mapSeries([getMeRequest(), patchMeRequest({ firstName: 'Plain' })], (request) => send(fastify, plain, request));

    assert.deepEqual(answers.map((responses, index) => [ROUTE_ACCESS[index][0], readStatuses(responses)]), ROUTE_ACCESS);
    answers.flat().filter((response) => response.statusCode === 403).forEach((response) => assertForbidden(response));
    assert.deepEqual(readStatuses(own), [200, 200]);
  });
});

describe('GET /api/v1/users', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('lists the users with the fields of a row of a list and no other: newest first, the later id first of two made at one moment, or by first name, the earlier id first of two that differ in case only; a page at a time, by status, by a range of createdAt that holds both its bounds, and by a part of the first name in any case', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const reader = await signInAs(fastify, [SCOPE.USERS_READ]);
    const [lowerOlena, anna, olena, oleh] = await mapSeries(PEOPLE, (person) => createListed(fastify, person));

    await createListed(fastify, OUTSIDER);

    const queries = [
      toQuery(LIST_MONTH),
      toQuery({ ...LIST_MONTH, sort: 'newest' }),
      toQuery({ ...LIST_MONTH, sort: 'name' }),
      toQuery({ ...LIST_MONTH, limit: 3 }),
      toQuery({ ...LIST_MONTH, limit: 3, offset: 3 }),
      toQuery({ ...LIST_MONTH, status: USER_STATUS.BLOCKED }),
      toQuery({ ...LIST_MONTH, status: USER_STATUS.ACTIVE }),
      toQuery({ createdAtFrom: TWIN_MOMENT, createdAtTo: TWIN_MOMENT }),
      toQuery({ ...LIST_MONTH, firstName: 'олен' }),
      toQuery({ ...LIST_MONTH, firstName: 'ОЛЕН' }),
    ];
    const responses = await mapSeries(queries, (query) => send(fastify, reader, getUsersRequest(query)));
    const whole = {
      total: PEOPLE.length,
      limit: PAGINATION.defaultLimit,
      offset: 0,
      totalPages: 1,
      currentPage: 1,
      canLoadMore: false,
    };

    assert.deepEqual(responses.map((response) => [response.statusCode, response.json().data]), [
      [200, [oleh, olena, anna, lowerOlena]],
      [200, [oleh, olena, anna, lowerOlena]],
      [200, [anna, oleh, lowerOlena, olena]],
      [200, [oleh, olena, anna]],
      [200, [lowerOlena]],
      [200, [anna]],
      [200, [oleh, olena, lowerOlena]],
      [200, [olena, anna]],
      [200, [olena, lowerOlena]],
      [200, [olena, lowerOlena]],
    ]);
    assert.deepEqual([0, 3, 4].map((index) => responses[index].json().pagination), [
      whole,
      {
        total: PEOPLE.length,
        limit: 3,
        offset: 0,
        totalPages: 2,
        currentPage: 1,
        canLoadMore: true,
      },
      {
        total: PEOPLE.length,
        limit: 3,
        offset: 3,
        totalPages: 2,
        currentPage: 2,
        canLoadMore: false,
      },
    ]);
  });

  test('takes any text as a part of the first name and never fails with 500: an emoji finds nobody, a letter beyond the BMP finds its name, and a broken percent-encoded sequence and a LIKE wildcard are searched for as they came', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const reader = await signInAs(fastify, [SCOPE.USERS_READ]);
    const [wide] = await mapSeries(TEXT_PEOPLE, (person) => createListed(fastify, person));
    const searches = [
      [toQuery({ ...TEXT_MONTH, firstName: EMOJI }), EMOJI, []],
      [toQuery({ ...TEXT_MONTH, firstName: WIDE_LETTER }), WIDE_LETTER, [wide]],
      [`${toQuery(TEXT_MONTH)}&firstName=${BROKEN_SEQUENCE}`, BROKEN_SEQUENCE, []],
      [toQuery({ ...TEXT_MONTH, firstName: LIKE_WILDCARD }), LIKE_WILDCARD, []],
    ];
    const responses = await mapSeries(searches, ([query]) => send(fastify, reader, getUsersRequest(query)));

    assert.deepEqual(
      responses.map((response) => [response.statusCode, readSearched(response), response.json().data]),
      searches.map(([, searched, found]) => [200, searched, found]),
    );
  });
});

describe('GET /api/v1/users/:id', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('gives a user with every field to one who reads users and to one who manages them, and 404 to an id that no user has, to one that is no UUID and to the id of the user in upper case', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const [reader, manager] = await mapSeries([[SCOPE.USERS_READ], [SCOPE.USERS_MANAGE]], (scopes) => signInAs(fastify, scopes));
    const user = await createProfile(fastify, { ...VERIFIED_PROFILE, createdAt: '2025-11-10T08:00:00.000Z' });
    const refused = await mapSeries([uuidv7(), 'not-a-uuid', user.id.toUpperCase()], (id) => send(fastify, reader, getUserRequest(id)));

    assertOk(await send(fastify, reader, getUserRequest(user.id)), user);
    assertOk(await send(fastify, manager, getUserRequest(user.id)), user);
    refused.forEach((response) => assertNotFound(response));
  });
});

describe('GET /api/v1/users/me', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('gives the user of the token their own profile with every field, to a token of no scope too', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const user = await createProfile(fastify, VERIFIED_PROFILE);
    const device = await signIn(fastify, { userId: user.id });

    assertOk(await send(fastify, device, getMeRequest()), user);
  });

  // Deleted outside the API, the user takes the rows of their sessions along through the foreign key, and nobody marks
  // the sessions revoked: Redis keeps the mark of a live one, which lets the token past the guard until it ends.
  test('answers 401 AUTHENTICATION_ERROR to GET and to PATCH once the row of the user is gone while their session is still taken for alive', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const device = await signInAs(fastify);

    await readAppRows(fastify, DELETE_USER_SQL, { id: device.userId });
    assert.equal(await readSessionRow(fastify, device.sid), null);
    assertOk(await send(fastify, device, getSessionRequest()), { id: device.userId, scopes: [] });
    assertUnauthenticated(await send(fastify, device, getMeRequest()));
    assertUnauthenticated(await send(fastify, device, patchMeRequest({ firstName: 'Gone' })));
  });
});

describe('PATCH /api/v1/users/:id', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('changes the fields it is given and answers 200 with every field: the email trimmed and in lower case counts as confirmed by the manager at the moment of the change, the names are trimmed, updatedAt moves, and user.update names the changed fields in their order and holds none of their values', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const user = await createProfile(fastify, VERIFIED_PROFILE);
    const sent = { email: `  Olha.New-${user.id}@Example.COM `, firstName: ' Ольга ', lastName: 'Мельник' };

    // The route confirms the email by the clock of this process; updatedAt comes from the clock of the database, which
    // differs from it.
    const startedAt = nowUtc().toISOString();
    const response = await send(fastify, manager, patchUserRequest(user.id, sent));
    const endedAt = nowUtc().toISOString();
    const { emailVerifiedAt, updatedAt } = response.json().data;
    const email = `olha.new-${user.id}@example.com`;

    assertOk(response, {
      ...user,
      email,
      emailVerifiedAt,
      firstName: 'Ольга',
      lastName: 'Мельник',
      updatedAt,
    });
    assert.ok(startedAt <= emailVerifiedAt && emailVerifiedAt <= endedAt, `${emailVerifiedAt} is not between ${startedAt} and ${endedAt}`);
    assert.ok(updatedAt > user.updatedAt, updatedAt);
    assert.deepEqual(await readProfile(fastify, user.id), response.json().data);
    assert.deepEqual(await readAudit(fastify, user.id), [describeAudit(response, manager.userId, {
      action: UPDATE_ACTION,
      entityType: TABLE.USERS,
      entityId: user.id,
      meta: { fields: ['email', 'firstName', 'lastName', 'emailVerifiedAt'] },
    })]);
    await assertNoValues(fastify, user.id, [user.email, sent.email.trim(), email, user.firstName, user.lastName, 'Ольга', 'Мельник']);
  });

  test('keeps every column the body leaves out and clears the one it gives null: a first name alone keeps the last name and the confirmed email, and a null email takes its confirmation along', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const user = await createProfile(fastify, VERIFIED_PROFILE);
    const renamed = await changeUser(fastify, manager, user.id, { firstName: 'Iryna' });
    const cleared = await changeUser(fastify, manager, user.id, { lastName: null });
    const unmailed = await changeUser(fastify, manager, user.id, { email: null });

    assert.deepEqual(renamed, { ...user, firstName: 'Iryna', updatedAt: renamed.updatedAt });
    assert.deepEqual(cleared, { ...renamed, lastName: null, updatedAt: cleared.updatedAt });
    assert.deepEqual(unmailed, {
      ...cleared,
      email: null,
      emailVerifiedAt: null,
      updatedAt: unmailed.updatedAt,
    });
    assert.deepEqual(await readProfile(fastify, user.id), unmailed);
    assert.deepEqual((await readAudit(fastify, user.id)).map((row) => [row.actor_id, row.meta]), [
      [manager.userId, { fields: ['firstName'] }],
      [manager.userId, { fields: ['lastName'] }],
      [manager.userId, { fields: ['email', 'emailVerifiedAt'] }],
    ]);
  });

  test('answers 200 with the user as they are and writes nothing to the values they hold already, the email in upper case and with spaces around it and a name with spaces too, and to a body it has just applied: updatedAt and the confirmation stay, and no record is made', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const user = await createProfile(fastify, VERIFIED_PROFILE);
    const stateBefore = await readState(fastify, STATE_TABLES);
    const response = await send(fastify, manager, patchUserRequest(user.id, {
      email: ` ${user.email.toUpperCase()} `,
      firstName: ` ${user.firstName} `,
      lastName: user.lastName,
    }));

    assertOk(response, user);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);

    const body = { lastName: ' Kravets ' };
    const changed = await changeUser(fastify, manager, user.id, body);
    const stateChanged = await readState(fastify, STATE_TABLES);

    assert.deepEqual(changed, { ...user, lastName: 'Kravets', updatedAt: changed.updatedAt });
    assertOk(await send(fastify, manager, patchUserRequest(user.id, body)), changed);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateChanged);
    assert.equal((await readAudit(fastify, user.id)).length, 1);
  });

  test('answers 422 to an email another user holds, in any case and with spaces around it: the column, the value as it was sent and the unique operator, and nothing of the body is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const [user, other] = await mapSeries([VERIFIED_PROFILE, {}], (fields) => createProfile(fastify, fields));
    const sent = ` ${other.email.toUpperCase()} `;
    const stateBefore = await readState(fastify, STATE_TABLES);

    assertTaken(await send(fastify, manager, patchUserRequest(user.id, { email: sent })), 'email', sent);
    assertTaken(await send(fastify, manager, patchUserRequest(user.id, { email: other.email, firstName: 'Changed' })), 'email', other.email);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });

  test('answers 409 NO_CHANGES to an empty body and to one of fields it does not write, 422 to a name that is no name of a person and to an email that is none, and 404 to an id that no user has or that is no UUID; nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.USERS_MANAGE]);
    const user = await createProfile(fastify, VERIFIED_PROFILE);
    const stateBefore = await readState(fastify, STATE_TABLES);
    const unchanged = await mapSeries(FOREIGN_BODIES, (payload) => send(fastify, manager, patchUserRequest(user.id, payload)));
    const invalid = await mapSeries(INVALID_BODIES, ([payload]) => send(fastify, manager, patchUserRequest(user.id, payload)));
    const missing = await mapSeries([uuidv7(), 'not-a-uuid'], (id) => send(fastify, manager, patchUserRequest(id, { firstName: 'Nobody' })));

    unchanged.forEach((response) => assertNoChanges(response));
    assert.deepEqual(
      invalid.map((response) => [response.statusCode, response.json().code, readFailures(response)]),
      INVALID_BODIES.map(([, failures]) => [422, 'VALIDATION_ERROR', failures]),
    );
    assert.deepEqual(invalid[0].json().validation, [{
      column: 'firstName',
      columnValue: 'Dr. Anna',
      operator: 'format',
      operatorValue: SCHEMA_FORMAT.PERSON_NAME,
    }]);
    missing.forEach((response) => assertNotFound(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });
});

describe('PATCH /api/v1/users/me', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('changes the names of the user of the token, trimmed and with the letter of a font made plain, keeps what the body leaves out, clears a name given null, and records nothing', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const user = await createProfile(fastify, VERIFIED_PROFILE);
    const device = await signIn(fastify, { userId: user.id });
    const auditBefore = await readAppRows(fastify, AUDIT_LOG_SQL);
    const renamed = await send(fastify, device, patchMeRequest({ firstName: `  ${FONT_V}ira  ` }));
    const { updatedAt } = renamed.json().data;

    assertOk(renamed, { ...user, firstName: 'Vira', updatedAt });
    assert.ok(updatedAt > user.updatedAt, updatedAt);

    const cleared = await send(fastify, device, patchMeRequest({ lastName: null }));

    assertOk(cleared, { ...renamed.json().data, lastName: null, updatedAt: cleared.json().data.updatedAt });
    assert.deepEqual(await readProfile(fastify, user.id), cleared.json().data);
    assert.deepEqual(await readAppRows(fastify, AUDIT_LOG_SQL), auditBefore);
  });

  test('takes no email, as its schema drops it: alone it leaves an empty body, 409 NO_CHANGES as {} does, and beside a name only the name changes; a name that is none is 422, and no refusal writes anything', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const user = await createProfile(fastify, VERIFIED_PROFILE);
    const device = await signIn(fastify, { userId: user.id });
    const email = `new-${user.id}@example.com`;
    const stateBefore = await readState(fastify, STATE_TABLES);
    const refused = await mapSeries([{ email }, {}, { firstName: 'Dr. Olha' }], (payload) => send(fastify, device, patchMeRequest(payload)));

    assertNoChanges(refused[0]);
    assertNoChanges(refused[1]);
    assert.deepEqual([refused[2].statusCode, readFailures(refused[2])], [422, [['firstName', 'format']]]);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);

    const renamed = await send(fastify, device, patchMeRequest({ firstName: 'Iryna', email }));

    assertOk(renamed, { ...user, firstName: 'Iryna', updatedAt: renamed.json().data.updatedAt });
  });

  test('refuses with 403 a user blocked outside the API whose token is still alive, and writes nothing', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const device = await signInAs(fastify);

    await blockByHand(fastify, device.userId);

    const stateBefore = await readState(fastify, STATE_TABLES);

    assertForbidden(await send(fastify, device, patchMeRequest({ firstName: 'Blocked' })));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });
});

describe('the cache of the reads of users', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('with Redis up serves a user and the list again from the cache until PATCH /:id, whose change the next reads show at once, with what was written behind its back', async (t) => {
    const fastify = await openRouteApp(t, testDb);

    // The first read of a table whose version is not there yet starts it and goes to the database, caching nothing.
    await runInApp(fastify, () => invalidateCacheTables([TABLE.USERS]));

    const [reader, manager] = await mapSeries([[SCOPE.USERS_READ], [SCOPE.USERS_MANAGE]], (scopes) => signInAs(fastify, scopes));
    const user = await createProfile(fastify, { firstName: 'Taras', lastName: 'Lysenko', createdAt: '2023-03-10T08:00:00.000Z' });

    async function readBoth() {
      const [one, list] = await mapSeries([getUserRequest(user.id), getUsersRequest(toQuery(CACHE_MONTH))], (request) => send(fastify, reader, request));

      return [one.json().data, list.json().data];
    }

    assert.deepEqual(await readBoth(), [user, [pick(user, LIST_FIELDS)]]);

    await readAppRows(fastify, RENAME_SQL, { id: user.id, lastName: 'Behind' });
    assert.deepEqual(await readBoth(), [user, [pick(user, LIST_FIELDS)]]);

    const changed = await changeUser(fastify, manager, user.id, { firstName: 'Ostap' });

    assert.deepEqual(changed, {
      ...user,
      firstName: 'Ostap',
      lastName: 'Behind',
      updatedAt: changed.updatedAt,
    });
    assert.deepEqual(await readBoth(), [changed, [pick(changed, LIST_FIELDS)]]);
  });
});

describe('the conflicts of the routes of users', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('are the ones the docs name for each route: NO_CHANGES to both PATCH routes, GROUP_PROTECTED to both DELETE routes and to the block, and none to the others', async (t) => {
    const fastify = await openRouteApp(t, testDb, { env: DEV_ENV });
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const last = await signInAs(fastify);
    const userId = await createUser(fastify);

    await setAdminMembers(fastify, [last.userId]);

    const spec = await readSpec(fastify);
    const scenarios = [
      [`GET ${ME_URL}`, root, getMeRequest(), 200],
      [`PATCH ${ME_URL}`, root, patchMeRequest({}), 409],
      [`PATCH ${ME_URL}`, root, patchMeRequest({ firstName: 'Roman' }), 200],
      [`DELETE ${ME_URL}`, last, deleteMeRequest(), 409],
      [`GET ${USERS_URL}`, root, getUsersRequest(), 200],
      [`GET ${USERS_URL}/{id}`, root, getUserRequest(userId), 200],
      [`PATCH ${USERS_URL}/{id}`, root, patchUserRequest(userId, {}), 409],
      [`PATCH ${USERS_URL}/{id}`, root, patchUserRequest(userId, { firstName: 'Petro' }), 200],
      [`DELETE ${USERS_URL}/{id}`, root, deleteUserRequest(last.userId), 409],
      [`POST ${USERS_URL}/{id}/block`, root, blockRequest(last.userId), 409],
      [`POST ${USERS_URL}/{id}/unblock`, root, unblockRequest(userId), 200],
    ];
    const responses = await mapSeries(scenarios, ([, actor, request]) => send(fastify, actor, request));

    assert.equal(spec.statusCode, 200);
    assert.deepEqual(readStatuses(responses), scenarios.map(([, , , statusCode]) => statusCode));
    assert.deepEqual(readAnsweredConflicts(scenarios, responses), readDocumentedConflicts(spec.json().paths, USERS_URL));
    responses.filter((response) => response.statusCode === HTTP_STATUS.CONFLICT).forEach((response) => assertError(response, response.json().code));
  });
});
