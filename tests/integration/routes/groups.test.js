import { PAGINATION } from '#config/pagination.js';
import { invalidateCacheTables } from '#core/cache/index.js';
import { toStorageKey } from '#core/storage/key.js';
import { GROUP_SLUG } from '#enums/group.js';
import { HEADER } from '#enums/header.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { SCOPE, SCOPE_ALL, SCOPE_CATALOG } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { readRequestId, successBody } from '#root/tests/helper/app.js';
import { createTestDb, findSessionId } from '#root/tests/helper/db.js';
import { DEV_ENV, NO_STORE, readSpec } from '#root/tests/helper/guard.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  assertChallenged,
  assertError,
  assertForbidden,
  assertNoChanges,
  assertNoContent,
  assertNotFound,
  assertOk,
  assertProtected,
  assertTaken,
  blockByHand,
  describeAudit,
  getMembersRequest,
  GROUPS_URL,
  listMemberIds,
  LONG_AGO,
  migrateAndSeed,
  openRouteApp,
  readAnsweredConflicts,
  readDocumentedConflicts,
  readFailures,
  readMemberIds,
  readStatuses,
  refresh,
  send,
  setAdminMembers,
  signInAs,
} from '#root/tests/helper/route.js';
import {
  createUser,
  findGroupId,
  insertGroup,
  insertUser,
  joinGroup,
  readAdminId,
  readAppRows,
  readAudit,
  readAuthCookies,
  readClaims,
  readMemberships,
  readState,
  runInApp,
  takeRefreshCookie,
  toBearer,
} from '#root/tests/helper/session.js';
import * as groupSchema from '#schemas/entity/group.js';
import { mapSeries } from '#utils/async.js';
import { toDate } from '#utils/date.js';
import { uuidv7, uuidVersion } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();

const SCOPES_URL = `${GROUPS_URL}/scopes`;

const XML_MEDIA_TYPE = 'application/xml';
const UUID_V7 = 7;

const CREATE_ACTION = 'group.create';
const UPDATE_ACTION = 'group.update';
const DELETE_ACTION = 'group.delete';
const GRANT_ACTION = 'user.group_grant';
const REVOKE_ACTION = 'user.group_revoke';
const GROUPS_ENTITY = 'groups';
const USERS_ENTITY = 'users';

const CATALOG_CODES = Object.freeze(SCOPE_CATALOG.map((entry) => entry.code));
const SORTED_CATALOG_CODES = Object.freeze([
  SCOPE.GROUPS_ALL,
  SCOPE.GROUPS_MANAGE,
  SCOPE.GROUPS_READ,
  SCOPE.USERS_ALL,
  SCOPE.USERS_MANAGE,
  SCOPE.USERS_READ,
]);
const RECORDED_FIELDS = Object.freeze(['slug', 'name', 'description', 'isSuperadmin', 'scopes']);

// The answers of the routes, in the order listEveryRoute() gives them.
const ALLOWED = Object.freeze([200, 200, 200, 201, 200, 200, 204, 204, 204]);
const DENIED = Object.freeze(ALLOWED.map(() => 403));
const READ_ONLY = Object.freeze([200, 200, 200, 403, 403, 403, 403, 403, 403]);
const READ_MEMBERS = Object.freeze([200, 200, 200, 403, 403, 200, 403, 403, 403]);
const MANAGE_GROUPS = Object.freeze([200, 200, 200, 201, 200, 403, 204, 204, 204]);

// The scopes of a token, "*" for full access, and the answers of the routes to it.
const ROUTE_ACCESS = Object.freeze([
  [[], DENIED],
  [[SCOPE.USERS_ALL], DENIED],
  [[SCOPE.GROUPS_READ], READ_ONLY],
  [[SCOPE.GROUPS_READ, SCOPE.USERS_READ], READ_MEMBERS],
  [[SCOPE.GROUPS_READ, SCOPE.USERS_MANAGE], READ_MEMBERS],
  [[SCOPE.USERS_MANAGE], DENIED],
  [[SCOPE.GROUPS_MANAGE], MANAGE_GROUPS],
  [[SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ], ALLOWED],
  [[SCOPE.GROUPS_MANAGE, SCOPE.USERS_MANAGE], ALLOWED],
  [[SCOPE.GROUPS_ALL], MANAGE_GROUPS],
  [[SCOPE.GROUPS_ALL, SCOPE.USERS_ALL], ALLOWED],
  [[SCOPE_ALL], ALLOWED],
]);

// What one holds, what they give a group, and whether they may.
const GIVING = Object.freeze([
  [[SCOPE.GROUPS_MANAGE], [SCOPE.GROUPS_MANAGE], true],
  [[SCOPE.GROUPS_MANAGE], [SCOPE.GROUPS_READ], false],
  [[SCOPE.GROUPS_MANAGE], [SCOPE.USERS_READ], false],
  [[SCOPE.GROUPS_ALL], [SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE], true],
  [[SCOPE.GROUPS_ALL], [SCOPE.GROUPS_ALL], true],
  [[SCOPE.GROUPS_ALL], [SCOPE.USERS_READ], false],
  [[SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE], [SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE], true],
  [[SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE], [SCOPE.GROUPS_ALL], false],
  [[SCOPE.GROUPS_MANAGE, SCOPE.USERS_ALL], [SCOPE.USERS_ALL, SCOPE.USERS_READ], true],
  [[SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ], [SCOPE.USERS_ALL], false],
]);

// Each over a body that is valid otherwise, with the column and the operator of what is wrong in it.
const INVALID_BODIES = Object.freeze([
  [{ slug: 'Editors' }, [['slug', 'pattern']]],
  [{ slug: 'the editors' }, [['slug', 'pattern']]],
  [{ slug: 'editors-' }, [['slug', 'pattern']]],
  [{ slug: '-editors' }, [['slug', 'pattern']]],
  [{ slug: 'the--editors' }, [['slug', 'pattern']]],
  [{ slug: 'the_editors' }, [['slug', 'pattern']]],
  [{ slug: 'x'.repeat(groupSchema.properties.slug.maxLength + 1) }, [['slug', 'maxLength']]],
  [{ name: undefined }, [['name', 'required']]],
  [{ isSuperadmin: 'yes' }, [['isSuperadmin', 'type']]],
  [{ scopes: ['users:write'] }, [['scopes.0', 'enum']]],
  [{ scopes: [SCOPE_ALL] }, [['scopes.0', 'enum']]],
  [{ scopes: [SCOPE.USERS_READ, SCOPE_ALL] }, [['scopes.1', 'enum']]],
  [{ scopes: [SCOPE.USERS_READ, SCOPE.USERS_READ] }, [['scopes', 'uniqueItems']]],
]);

// A key that names no file: the URL the API makes of it needs none.
const AVATAR_EXTENSION = 'webp';

const PEOPLE = Object.freeze([
  Object.freeze({
    firstName: 'Anna',
    lastName: 'Kovalenko',
    status: USER_STATUS.ACTIVE,
    createdAt: '2026-11-10T08:00:00.000Z',
  }),
  Object.freeze({
    firstName: 'Oleh',
    lastName: 'Bondar',
    avatarKey: toStorageKey(AVATAR_EXTENSION),
    status: USER_STATUS.BLOCKED,
    createdAt: '2026-11-12T08:00:00.000Z',
  }),
  Object.freeze({
    firstName: 'Olena',
    lastName: 'Shevchenko',
    status: USER_STATUS.ACTIVE,
    createdAt: '2026-11-14T08:00:00.000Z',
  }),
]);
const OUTSIDER = Object.freeze({
  firstName: 'Oleksandr',
  lastName: 'Melnyk',
  status: USER_STATUS.ACTIVE,
  createdAt: '2026-11-13T08:00:00.000Z',
});

const GROUP_ROW_SQL = 'SELECT * FROM groups WHERE id = :id';
const SCOPE_ROWS_SQL = 'SELECT scope FROM group_scopes WHERE group_id = :groupId ORDER BY scope';
const GROUPS_OF_USER_SQL = 'SELECT group_id FROM user_groups WHERE user_id = :userId';
const SET_UPDATED_AT_SQL = 'UPDATE groups SET updated_at = :updatedAt WHERE id = :id';
const RENAME_SQL = 'UPDATE groups SET name = :name WHERE id = :id';
const DELETE_GROUP_SQL = 'DELETE FROM groups WHERE id = :id';
const SCOPE_RECORDS_SQL = 'SELECT * FROM group_scopes WHERE group_id = :groupId';
const MEMBERSHIP_RECORDS_SQL = 'SELECT * FROM user_groups WHERE group_id = :groupId';
const RESTORE_GROUP_SQL = `
  INSERT INTO groups (id, slug, name, description, is_superadmin, is_system, created_at, updated_at)
  VALUES (:id, :slug, :name, :description, :is_superadmin, :is_system, :created_at, :updated_at)
`;
const RESTORE_SCOPE_SQL = 'INSERT INTO group_scopes (group_id, scope, created_at, updated_at) VALUES (:group_id, :scope, :created_at, :updated_at)';
const RESTORE_MEMBERSHIP_SQL = `
  INSERT INTO user_groups (user_id, group_id, granted_by, created_at, updated_at)
  VALUES (:user_id, :group_id, :granted_by, :created_at, :updated_at)
`;

// The rows a change of groups writes: a refused one leaves each of them as it was.
const STATE_TABLES = Object.freeze([TABLE.GROUPS, TABLE.GROUP_SCOPES, TABLE.USER_GROUPS, TABLE.AUDIT_LOGS]);

// The keeper is a connection of the test outside the pools, and takes "?" placeholders.
const LEAVE_BY_KEEPER_SQL = 'DELETE FROM user_groups WHERE user_id = ? AND group_id = ?';
const COMMIT_SQL = 'COMMIT';

// The statement that locks the users of a change of groups, as the server lists it while it waits.
const USERS_LOCK_MARK = 'ORDER BY id FOR UPDATE';

function getGroupsRequest(query = '') {
  return { method: 'GET', url: `${GROUPS_URL}${query}` };
}

function getScopesRequest() {
  return { method: 'GET', url: SCOPES_URL };
}

function getGroupRequest(id) {
  return { method: 'GET', url: `${GROUPS_URL}/${id}` };
}

function postGroupRequest(payload) {
  return { method: 'POST', url: GROUPS_URL, payload };
}

function patchGroupRequest(id, payload) {
  return { method: 'PATCH', url: `${GROUPS_URL}/${id}`, payload };
}

function deleteGroupRequest(id) {
  return { method: 'DELETE', url: `${GROUPS_URL}/${id}` };
}

function putMemberRequest(groupId, userId) {
  return { method: 'PUT', url: `${GROUPS_URL}/${groupId}/members/${userId}` };
}

function deleteMemberRequest(groupId, userId) {
  return { method: 'DELETE', url: `${GROUPS_URL}/${groupId}/members/${userId}` };
}

// The routes in the order one user may run them all on one group: the last one deletes it.
function listEveryRoute(groupId, userId) {
  return [
    getGroupsRequest(),
    getScopesRequest(),
    getGroupRequest(groupId),
    postGroupRequest({ slug: createSlug('every'), name: 'Every route' }),
    patchGroupRequest(groupId, { name: 'Every route, renamed' }),
    getMembersRequest(groupId),
    putMemberRequest(groupId, userId),
    deleteMemberRequest(groupId, userId),
    deleteGroupRequest(groupId),
  ];
}

// Unique in the database of the file, and a slug by its pattern.
function createSlug(word) {
  return `${word}-${uuidv7()}`;
}

async function makeGroup(fastify, actor, fields = {}) {
  const response = await send(fastify, actor, postGroupRequest({ slug: createSlug('group'), name: 'Group', ...fields }));

  assert.equal(response.statusCode, 201, response.body);

  return response.json().data;
}

async function changeGroup(fastify, actor, id, fields) {
  const response = await send(fastify, actor, patchGroupRequest(id, fields));

  assert.equal(response.statusCode, 200, response.body);

  return response.json().data;
}

async function makeMember(fastify, actor, groupId, userId) {
  const response = await send(fastify, actor, putMemberRequest(groupId, userId));

  assertNoContent(response);

  return response;
}

async function dropMember(fastify, actor, groupId, userId) {
  const response = await send(fastify, actor, deleteMemberRequest(groupId, userId));

  assertNoContent(response);

  return response;
}

// A group that grants nothing and a user outside it, made for each actor: whoever may change groups may change it.
async function runEveryRoute(fastify, root, scopes) {
  const actor = await signInAs(fastify, scopes);
  const group = await makeGroup(fastify, root);
  const userId = await createUser(fastify);

  return mapSeries(listEveryRoute(group.id, userId), (request) => send(fastify, actor, request));
}

// A user with a profile, made at the moment the test names: the members list shows these fields of a user, the key of
// the avatar as the URL the storage makes of it.
async function createPerson(fastify, { createdAt, avatarKey = null, ...profile }) {
  const email = `${profile.firstName.toLowerCase()}-${uuidv7()}@example.com`;
  const id = await insertUser(fastify, {
    ...profile,
    email,
    avatarKey,
    createdAt: toDate(createdAt),
  });

  return {
    id,
    email,
    ...profile,
    avatarUrl: avatarKey === null
      ? null
      : fastify.storage.url(avatarKey),
    createdAt,
  };
}

// The device after a refresh: its next requests carry the tokens the refresh has set.
async function refreshDevice(fastify, device) {
  const response = await refresh(fastify, device.refreshCookie);

  assert.equal(response.statusCode, 200, response.body);

  const accessToken = readAuthCookies(response).accessToken.value;
  const { scopes } = readClaims(accessToken);

  assert.deepEqual(response.json().data.scopes, scopes);

  return {
    ...device,
    scopes,
    bearer: toBearer(accessToken),
    refreshCookie: takeRefreshCookie(response),
  };
}

async function readGroupRow(fastify, id) {
  const [row = null] = await readAppRows(fastify, GROUP_ROW_SQL, { id });

  return row;
}

async function readScopeRows(fastify, groupId) {
  const rows = await readAppRows(fastify, SCOPE_ROWS_SQL, { groupId });

  return rows.map((row) => row.scope);
}

async function readGroupIdsOf(fastify, userId) {
  const rows = await readAppRows(fastify, GROUPS_OF_USER_SQL, { userId });

  return rows.map((row) => row.group_id);
}

// The admin row gone with what refers to it, as before the seed. The pool of the file puts it all back as it was once
// the test ends: the app of the test is closed by then.
async function removeAdminRow(t, fastify) {
  const id = await readAdminId(fastify);
  const [[group], scopes, members] = await mapSeries([
    [GROUP_ROW_SQL, { id }],
    [SCOPE_RECORDS_SQL, { groupId: id }],
    [MEMBERSHIP_RECORDS_SQL, { groupId: id }],
  ], ([sql, binding]) => testDb.readRows(sql, binding));
  const restores = [
    [RESTORE_GROUP_SQL, group],
    ...scopes.map((row) => [RESTORE_SCOPE_SQL, row]),
    ...members.map((row) => [RESTORE_MEMBERSHIP_SQL, row]),
  ];

  t.after(() => mapSeries(restores, ([sql, row]) => testDb.readRows(sql, row)));
  await testDb.readRows(DELETE_GROUP_SQL, { id });

  return id;
}

// A change that may lose a race: 204 when it came first, a clean 403 when what came first took its right away. Tells
// which of them it was.
function assertSettled(response) {
  if (response.statusCode === HTTP_STATUS.NO_CONTENT) {
    assertNoContent(response);

    return true;
  }

  assertForbidden(response);

  return false;
}

// Bodies the parser or the schema refuses, and what one who may send them is answered.
function listBadBodies(bodyLimit) {
  const asJson = { [HEADER.CONTENT_TYPE]: MEDIA_TYPE.JSON };

  return [
    [{ payload: JSON.stringify({ slug: 'big', name: 'x'.repeat(bodyLimit) }), headers: asJson }, [413, 'PAYLOAD_TOO_LARGE_ERROR']],
    [{ payload: '{"slug":', headers: asJson }, [400, 'BAD_REQUEST_ERROR']],
    [{ payload: '<group/>', headers: { [HEADER.CONTENT_TYPE]: XML_MEDIA_TYPE } }, [415, 'UNSUPPORTED_MEDIA_TYPE_ERROR']],
    [{ payload: { slug: 'Not A Slug', scopes: [SCOPE_ALL] } }, [422, 'VALIDATION_ERROR']],
  ];
}

describe('the guard of /api/v1/groups', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('answers 401 with the Bearer challenge on every route to a request without a token, with one that is none or with a refresh token, before it looks for the group', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const device = await signInAs(fastify, [SCOPE_ALL]);
    const strangers = [null, { bearer: toBearer('not-a-token') }, { bearer: toBearer(device.issued.refreshToken) }];
    const requests = listEveryRoute(uuidv7(), uuidv7());
    const pairs = strangers.flatMap((stranger) => requests.map((request) => [stranger, request]));
    const responses = await mapSeries(pairs, ([stranger, request]) => send(fastify, stranger, request));

    responses.forEach((response) => assertChallenged(response));
  });

  test('answers each route by the scopes of the token: 403 without them, and the answer of the route with them, a wildcard of the resource and full access too; the members only beside users:read or users:manage', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const answers = await mapSeries(ROUTE_ACCESS, ([scopes]) => runEveryRoute(fastify, root, scopes));

    assert.deepEqual(answers.map((responses, index) => [ROUTE_ACCESS[index][0], readStatuses(responses)]), ROUTE_ACCESS);
    answers.flat().filter((response) => response.statusCode === 403).forEach((response) => assertForbidden(response));
  });

  test('guards the HEAD twin of each read and every spelling of an address the router takes alike: 401, 403, and the answer of the read, which nobody may store', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const [plain, reader] = await mapSeries([[SCOPE.USERS_READ], [SCOPE.GROUPS_READ, SCOPE.USERS_READ]], (scopes) => signInAs(fastify, scopes));
    const group = await makeGroup(fastify, root);
    const urls = [GROUPS_URL, `${GROUPS_URL}/`, '/api/v1/%67roups', SCOPES_URL, `${GROUPS_URL}/${group.id}`, `${GROUPS_URL}/${group.id}/members`];
    const requests = urls.flatMap((url) => ['GET', 'HEAD'].map((method) => ({ method, url })));
    const [byGuest, byPlain, byReader] = await mapSeries([null, plain, reader], (actor) => mapSeries(requests, (request) => send(fastify, actor, request)));

    assert.deepEqual(
      [readStatuses(byGuest), readStatuses(byPlain), readStatuses(byReader)],
      [requests.map(() => 401), requests.map(() => 403), requests.map(() => 200)],
    );
    assert.deepEqual(byReader.map((response) => response.headers[HEADER.CACHE_CONTROL]), requests.map(() => NO_STORE));
  });

  test('refuses a guest with 401 and one without the scope with 403 before it reads the body: over the limit, not JSON, of another media type or against the schema; one with the scope is told what is wrong with it', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const [root, reader, manager] = await mapSeries([[SCOPE_ALL], [SCOPE.GROUPS_READ], [SCOPE.GROUPS_MANAGE]], (scopes) => signInAs(fastify, scopes));
    const group = await makeGroup(fastify, root);
    const bodies = listBadBodies(fastify.config.app.bodyLimit);
    const requests = bodies.flatMap(([body]) => [{ ...postGroupRequest(), ...body }, { ...patchGroupRequest(group.id), ...body }]);
    const stateBefore = await readState(fastify, STATE_TABLES);
    const [byGuest, byReader, byManager] = await mapSeries([null, reader, manager], (actor) => mapSeries(requests, (request) => send(fastify, actor, request)));

    byGuest.forEach((response) => assertChallenged(response));
    byReader.forEach((response) => assertForbidden(response));
    assert.deepEqual(
      byManager.map((response) => [response.statusCode, response.json().code]),
      bodies.flatMap(([, answer]) => [answer, answer]),
    );
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });
});

describe('GET /api/v1/groups', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('lists the groups with their scopes, by a part of the name in any case, in either order, a page at a time', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const reader = await signInAs(fastify, [SCOPE.GROUPS_READ]);
    const marker = uuidv7().replaceAll('-', '');
    const [zeta, alpha, beta] = await mapSeries([
      { name: `Zeta ${marker}`, scopes: [SCOPE.USERS_READ, SCOPE.GROUPS_READ] },
      { name: `alpha ${marker}`, isSuperadmin: true },
      { name: `Beta ${marker}`, description: 'The second one', scopes: [SCOPE.GROUPS_MANAGE] },
    ], (fields) => makeGroup(fastify, root, fields));

    await makeGroup(fastify, root, { name: 'Elsewhere' });

    const queries = [
      `?name=${marker}`,
      `?name=${marker.toUpperCase()}&sort=name`,
      `?name=${marker}&sort=newest`,
      `?name=${marker}&sort=newest&limit=2`,
      `?name=${marker}&sort=newest&limit=2&offset=2`,
    ];
    const responses = await mapSeries(queries, (query) => send(fastify, reader, getGroupsRequest(query)));
    const whole = {
      total: 3,
      limit: PAGINATION.defaultLimit,
      offset: 0,
      totalPages: 1,
      currentPage: 1,
      canLoadMore: false,
    };

    assert.deepEqual(responses.map((response) => [response.statusCode, response.json().data, response.json().pagination]), [
      [200, [alpha, beta, zeta], whole],
      [200, [alpha, beta, zeta], whole],
      [200, [beta, alpha, zeta], whole],
      [200, [beta, alpha], {
        total: 3,
        limit: 2,
        offset: 0,
        totalPages: 2,
        currentPage: 1,
        canLoadMore: true,
      }],
      [200, [zeta], {
        total: 3,
        limit: 2,
        offset: 2,
        totalPages: 2,
        currentPage: 2,
        canLoadMore: false,
      }],
    ]);
    assert.deepEqual([zeta.scopes, alpha.scopes, beta.scopes], [[SCOPE.GROUPS_READ, SCOPE.USERS_READ], [], [SCOPE.GROUPS_MANAGE]]);
  });

  test('gives the catalog of the scopes a group may grant: the wildcards of the resources are in it, * is not', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const reader = await signInAs(fastify, [SCOPE.GROUPS_READ]);
    const response = await send(fastify, reader, getScopesRequest());

    assertOk(response, SCOPE_CATALOG.map((entry) => ({ ...entry })));
    assert.deepEqual(response.json().data.map((entry) => entry.code), ['groups:*', 'groups:read', 'groups:manage', 'users:*', 'users:read', 'users:manage']);
  });

  test('gives one group with its scopes, and 404 to an id that no group has', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const reader = await signInAs(fastify, [SCOPE.GROUPS_READ]);
    const group = await makeGroup(fastify, root, { description: 'Read one by one', scopes: [SCOPE.USERS_READ] });

    assertOk(await send(fastify, reader, getGroupRequest(group.id)), group);
    assertNotFound(await send(fastify, reader, getGroupRequest(uuidv7())));
  });
});

describe('POST /api/v1/groups', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('creates a group, answers 201 with it and its scopes sorted, and records group.create by its actor; what the body leaves out takes its default', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE, SCOPE.GROUPS_READ, SCOPE.USERS_READ]);
    const full = {
      slug: createSlug('editors'),
      name: 'Editors',
      description: 'They edit the texts',
      isSuperadmin: false,
      scopes: [SCOPE.USERS_READ, SCOPE.GROUPS_READ],
    };
    const short = { slug: createSlug('readers'), name: 'Readers' };
    const [created, defaulted] = await mapSeries([full, short], (payload) => send(fastify, manager, postGroupRequest(payload)));
    const group = created.json().data;
    const sorted = [SCOPE.GROUPS_READ, SCOPE.USERS_READ];

    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json(), successBody(created, {
      ...full,
      id: group.id,
      isSystem: false,
      createdAt: group.createdAt,
      updatedAt: group.createdAt,
      scopes: sorted,
    }));
    assert.equal(uuidVersion(group.id), UUID_V7);
    assert.equal(defaulted.statusCode, 201, defaulted.body);
    assert.deepEqual(pick(defaulted.json().data, [...RECORDED_FIELDS, 'isSystem']), {
      ...short,
      description: null,
      isSuperadmin: false,
      isSystem: false,
      scopes: [],
    });
    assertOk(await send(fastify, manager, getGroupRequest(group.id)), group);
    assert.deepEqual(await readScopeRows(fastify, group.id), sorted);
    assert.deepEqual(await readAudit(fastify, group.id), [describeAudit(created, manager.userId, {
      action: CREATE_ACTION,
      entityType: GROUPS_ENTITY,
      entityId: group.id,
      meta: { ...pick(full, RECORDED_FIELDS), scopes: sorted },
    })]);
  });

  test('answers 422 to a slug that another group has, naming the column and the unique operator, and 409 GROUP_PROTECTED to the slug of the admin group, and writes nothing', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE]);
    const taken = await makeGroup(fastify, manager);
    const stateBefore = await readState(fastify, STATE_TABLES);

    assertTaken(await send(fastify, manager, postGroupRequest({ slug: taken.slug, name: 'Another' })), 'slug', taken.slug);
    assertProtected(await send(fastify, manager, postGroupRequest({ slug: GROUP_SLUG.ADMIN, name: 'Another' })));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });

  test('makes one group of two requests that take one slug at the same moment: 201 to one, 422 to the other, one row and one record', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const slug = createSlug('raced');
    const responses = await Promise.all(['first', 'second'].map((name) => send(fastify, root, postGroupRequest({ slug, name }))));
    const [created] = responses.filter((response) => response.statusCode === 201);
    const [refused] = responses.filter((response) => response.statusCode !== 201);
    const id = await findGroupId(fastify, slug);

    assert.deepEqual(readStatuses(responses).toSorted(), [201, 422]);
    assertTaken(refused, 'slug', slug);
    assert.equal(created.json().data.id, id);
    assert.deepEqual((await readAudit(fastify, id)).map((row) => [row.action, row.request_id]), [[CREATE_ACTION, readRequestId(created)]]);
  });

  test('answers 422 to a holder of * too for a body against the schema, and writes nothing: a slug off its pattern or too long, no name, a scope out of the catalog, * as a scope, a scope given twice', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries(INVALID_BODIES, ([fields]) => send(fastify, root, postGroupRequest({ slug: createSlug('valid'), name: 'Valid', ...fields })));

    assert.deepEqual(
      responses.map((response) => [response.statusCode, response.json().code, readFailures(response)]),
      INVALID_BODIES.map(([, failures]) => [422, 'VALIDATION_ERROR', failures]),
    );
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });

  test('drops isSystem from a body: a group the API makes is never one of the system, and the admin group stays one', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const adminId = await readAdminId(fastify);
    const created = await send(fastify, root, postGroupRequest({ slug: createSlug('system'), name: 'System', isSystem: true }));

    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().data.isSystem, false);
    assertNoChanges(await send(fastify, root, patchGroupRequest(created.json().data.id, { isSystem: true })));
    assertNoChanges(await send(fastify, root, patchGroupRequest(adminId, { isSystem: false })));
    assert.deepEqual(
      [(await readGroupRow(fastify, created.json().data.id)).is_system, (await readGroupRow(fastify, adminId)).is_system],
      [false, true],
    );
  });

  test('lets only a holder of * turn full access on or off: a holder of every scope of the catalog is refused with 403 by POST and by PATCH, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const holder = await signInAs(fastify, CATALOG_CODES);
    const [plain, full] = await mapSeries([{}, { isSuperadmin: true }], (fields) => makeGroup(fastify, root, fields));
    const stateBefore = await readState(fastify, STATE_TABLES);
    const refused = await mapSeries([
      postGroupRequest({ slug: createSlug('full'), name: 'Full', isSuperadmin: true }),
      patchGroupRequest(plain.id, { isSuperadmin: true }),
      patchGroupRequest(full.id, { isSuperadmin: false }),
      patchGroupRequest(full.id, { name: 'Full, renamed' }),
    ], (request) => send(fastify, holder, request));

    refused.forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);

    const listed = await makeGroup(fastify, holder, { isSuperadmin: false, scopes: CATALOG_CODES });
    const made = await makeGroup(fastify, root, { isSuperadmin: true });
    const turnedOn = await changeGroup(fastify, root, plain.id, { isSuperadmin: true });
    const turnedOff = await changeGroup(fastify, root, full.id, { isSuperadmin: false });

    assert.deepEqual([listed.isSuperadmin, listed.scopes], [false, SORTED_CATALOG_CODES]);
    assert.deepEqual([made.isSuperadmin, turnedOn.isSuperadmin, turnedOff.isSuperadmin], [true, true, false]);
  });

  test('lets one who manages groups give a group only the scopes they hold or their wildcard grants, never one they lack nor a wildcard whose actions they hold: by POST and by PATCH', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);

    async function give([held, given]) {
      const actor = await signInAs(fastify, held);
      const group = await makeGroup(fastify, root);
      const created = await send(fastify, actor, postGroupRequest({ slug: createSlug('given'), name: 'Given', scopes: given }));
      const patched = await send(fastify, actor, patchGroupRequest(group.id, { scopes: given }));

      return [held, given, [created.statusCode, patched.statusCode], await readScopeRows(fastify, group.id)];
    }

    assert.deepEqual(await mapSeries(GIVING, give), GIVING.map(([held, given, isAllowed]) => (isAllowed
      ? [held, given, [201, 200], given.toSorted()]
      : [held, given, [403, 403], []])));
  });
});

describe('PATCH /api/v1/groups/:id', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('changes the fields it is given, moves updated_at and records group.update with each change from what to what; a null description clears it', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE, SCOPE.GROUPS_READ]);
    const group = await makeGroup(fastify, manager, { name: 'Writers', description: 'They write', scopes: [SCOPE.GROUPS_READ] });
    const slug = createSlug('authors');

    await readAppRows(fastify, SET_UPDATED_AT_SQL, { id: group.id, updatedAt: new Date(LONG_AGO) });

    const response = await send(fastify, manager, patchGroupRequest(group.id, { slug, name: 'Authors', description: null }));
    const { updatedAt } = response.json().data;

    assertOk(response, {
      ...group,
      slug,
      name: 'Authors',
      description: null,
      updatedAt,
    });
    assert.ok(updatedAt > LONG_AGO, updatedAt);
    assert.equal((await readGroupRow(fastify, group.id)).description, null);
    assertOk(await send(fastify, manager, getGroupRequest(group.id)), response.json().data);
    assert.deepEqual((await readAudit(fastify, group.id)).at(-1), describeAudit(response, manager.userId, {
      action: UPDATE_ACTION,
      entityType: GROUPS_ENTITY,
      entityId: group.id,
      meta: {
        changes: {
          slug: { from: group.slug, to: slug },
          name: { from: 'Writers', to: 'Authors' },
          description: { from: 'They write', to: null },
        },
      },
    }));
  });

  test('replaces the whole list of scopes, and a change of the scopes alone moves updated_at too', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const group = await makeGroup(fastify, root, { scopes: [SCOPE.GROUPS_READ, SCOPE.USERS_READ] });

    await readAppRows(fastify, SET_UPDATED_AT_SQL, { id: group.id, updatedAt: new Date(LONG_AGO) });

    const replaced = await send(fastify, root, patchGroupRequest(group.id, { scopes: [SCOPE.USERS_READ, SCOPE.GROUPS_MANAGE] }));
    const { updatedAt } = replaced.json().data;

    assertOk(replaced, { ...group, updatedAt, scopes: [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ] });
    assert.ok(updatedAt > LONG_AGO, updatedAt);
    assert.equal((await readGroupRow(fastify, group.id)).updated_at.toISOString(), updatedAt);
    assert.deepEqual(await readScopeRows(fastify, group.id), [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]);
    assert.deepEqual((await readAudit(fastify, group.id)).at(-1), describeAudit(replaced, root.userId, {
      action: UPDATE_ACTION,
      entityType: GROUPS_ENTITY,
      entityId: group.id,
      meta: { changes: { scopes: { from: [SCOPE.GROUPS_READ, SCOPE.USERS_READ], to: [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ] } } },
    }));

    const emptied = await changeGroup(fastify, root, group.id, { scopes: [] });

    assert.deepEqual([emptied.scopes, await readScopeRows(fastify, group.id)], [[], []]);
  });

  test('answers 200 with the group as it is to the values it has already, its scopes in another order too, and writes nothing', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const group = await makeGroup(fastify, root, { name: 'Same', description: 'The same', scopes: [SCOPE.GROUPS_READ, SCOPE.USERS_READ] });
    const stateBefore = await readState(fastify, STATE_TABLES);
    const response = await send(fastify, root, patchGroupRequest(group.id, {
      slug: group.slug,
      name: 'Same',
      description: 'The same',
      isSuperadmin: false,
      scopes: [SCOPE.USERS_READ, SCOPE.GROUPS_READ],
    }));

    assertOk(response, group);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });

  test('answers 409 NO_CHANGES to an empty body, 404 to an id that no group has, 422 to the slug of another group and 409 GROUP_PROTECTED to the slug of the admin group, and writes nothing', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const [group, other] = await mapSeries([{}, {}], (fields) => makeGroup(fastify, root, fields));
    const stateBefore = await readState(fastify, STATE_TABLES);

    assertNoChanges(await send(fastify, root, patchGroupRequest(group.id, {})));
    assertNotFound(await send(fastify, root, patchGroupRequest(uuidv7(), { name: 'Nobody' })));
    assertTaken(await send(fastify, root, patchGroupRequest(group.id, { slug: other.slug })), 'slug', other.slug);
    assertProtected(await send(fastify, root, patchGroupRequest(group.id, { slug: GROUP_SLUG.ADMIN })));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });
});

describe('DELETE /api/v1/groups/:id', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('deletes a group with its scopes and its memberships, answers 204 and records group.delete with the ids of its members in their order, none for a group without them; the same id once more is 404', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const [group, empty] = await mapSeries([{ description: 'Soon gone', scopes: [SCOPE.USERS_READ, SCOPE.GROUPS_READ] }, {}], (fields) => makeGroup(fastify, root, fields));
    const userIds = await mapSeries(['first', 'second', 'third'], () => createUser(fastify));

    await mapSeries(userIds.toReversed(), (userId) => makeMember(fastify, root, group.id, userId));

    const deleted = await send(fastify, root, deleteGroupRequest(group.id));

    assertNoContent(deleted);
    assertNotFound(await send(fastify, root, getGroupRequest(group.id)));
    assertNotFound(await send(fastify, root, getMembersRequest(group.id)));
    assertNotFound(await send(fastify, root, deleteGroupRequest(group.id)));
    assert.equal(await readGroupRow(fastify, group.id), null);
    assert.deepEqual([await readScopeRows(fastify, group.id), await readMemberships(fastify, group.id)], [[], []]);

    const audit = await readAudit(fastify, group.id);

    assert.deepEqual(audit.map((row) => row.action), [CREATE_ACTION, DELETE_ACTION]);
    assert.deepEqual(audit.at(-1), describeAudit(deleted, root.userId, {
      action: DELETE_ACTION,
      entityType: GROUPS_ENTITY,
      entityId: group.id,
      meta: { ...pick(group, RECORDED_FIELDS), memberIds: userIds.toSorted() },
    }));
    assertNoContent(await send(fastify, root, deleteGroupRequest(empty.id)));
    assert.deepEqual((await readAudit(fastify, empty.id)).at(-1).meta, { ...pick(empty, RECORDED_FIELDS), memberIds: [] });
  });
});

describe('a group that grants more than one holds', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('is not theirs to change: its name, its scopes, its full access, its deletion and its members are refused with 403, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE, SCOPE.GROUPS_READ]);
    const [wider, full] = await mapSeries([{ scopes: [SCOPE.USERS_READ] }, { isSuperadmin: true }], (fields) => makeGroup(fastify, root, fields));
    const [member, stranger] = await mapSeries(['member', 'stranger'], () => createUser(fastify));

    await mapSeries([wider, full], (group) => makeMember(fastify, root, group.id, member));

    const requests = [
      ...[wider, full].flatMap((group) => [
        patchGroupRequest(group.id, { name: 'Taken over' }),
        patchGroupRequest(group.id, { scopes: [] }),
        deleteGroupRequest(group.id),
        putMemberRequest(group.id, stranger),
        deleteMemberRequest(group.id, member),
      ]),
      patchGroupRequest(full.id, { isSuperadmin: false }),
    ];
    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries(requests, (request) => send(fastify, manager, request));

    responses.forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);

    const peer = await signInAs(fastify, [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]);
    const renamed = await changeGroup(fastify, peer, wider.id, { name: 'Renamed by a peer' });

    assert.equal(renamed.name, 'Renamed by a peer');
    await makeMember(fastify, peer, wider.id, stranger);
    await dropMember(fastify, peer, wider.id, member);
    assert.deepEqual((await readMemberships(fastify, wider.id)).map((row) => row.user_id), [stranger]);
  });
});

describe('the system group admin', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('is never deleted and keeps its slug and its full access, a holder of * asking too: 409 GROUP_PROTECTED, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const adminId = await readAdminId(fastify);
    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries([
      deleteGroupRequest(adminId),
      patchGroupRequest(adminId, { slug: 'root' }),
      patchGroupRequest(adminId, { isSuperadmin: false }),
      patchGroupRequest(adminId, { name: 'Renamed', isSuperadmin: false }),
    ], (request) => send(fastify, root, request));

    responses.forEach((response) => assertProtected(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });

  test('may be renamed and described anew by a holder of *, and takes members from them: its slug, its full access and its mark of the system stay', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const member = await signInAs(fastify);
    const adminId = await readAdminId(fastify);
    const admin = (await send(fastify, root, getGroupRequest(adminId))).json().data;
    const response = await send(fastify, root, patchGroupRequest(adminId, {
      slug: GROUP_SLUG.ADMIN,
      name: `${admin.name} of the app`,
      description: null,
      isSuperadmin: true,
    }));

    assertOk(response, {
      ...admin,
      name: `${admin.name} of the app`,
      description: null,
      updatedAt: response.json().data.updatedAt,
    });
    assert.deepEqual(pick(response.json().data, ['slug', 'isSuperadmin', 'isSystem']), { slug: GROUP_SLUG.ADMIN, isSuperadmin: true, isSystem: true });
    assert.deepEqual((await readAudit(fastify, adminId)).at(-1).meta, {
      changes: {
        name: { from: admin.name, to: `${admin.name} of the app` },
        description: { from: admin.description, to: null },
      },
    });

    await makeMember(fastify, root, adminId, member.userId);
    assert.deepEqual((await refreshDevice(fastify, member)).scopes, [SCOPE_ALL]);
  });

  test('tells one who manages groups 409 for what nobody may do before 403 for what only a holder of * may, and 404 before both', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE, SCOPE.GROUPS_READ]);
    const adminId = await readAdminId(fastify);
    const userId = await createUser(fastify);
    const stateBefore = await readState(fastify, STATE_TABLES);

    assertNotFound(await send(fastify, manager, deleteGroupRequest(uuidv7())));
    assertNotFound(await send(fastify, manager, patchGroupRequest(uuidv7(), { slug: 'root' })));
    assertProtected(await send(fastify, manager, deleteGroupRequest(adminId)));
    assertProtected(await send(fastify, manager, patchGroupRequest(adminId, { slug: 'root' })));
    assertProtected(await send(fastify, manager, patchGroupRequest(adminId, { isSuperadmin: false })));
    assertForbidden(await send(fastify, manager, patchGroupRequest(adminId, { name: 'Ours now' })));
    assertForbidden(await send(fastify, manager, putMemberRequest(adminId, userId)));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });

  test('keeps its last member: a holder of * from another group is answered 409 GROUP_PROTECTED, after 404 for one who is no member and before 403 for one who may not change the group, while one of two members may go', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE, SCOPE.GROUPS_READ]);
    const [firstId, secondId, outsiderId] = await mapSeries(['first', 'second', 'outsider'], () => createUser(fastify));
    const adminId = await setAdminMembers(fastify, [firstId, secondId]);

    assertForbidden(await send(fastify, manager, deleteMemberRequest(adminId, secondId)));
    await dropMember(fastify, root, adminId, secondId);

    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries([root, manager], (actor) => mapSeries(
      [deleteMemberRequest(adminId, outsiderId), deleteMemberRequest(adminId, firstId)],
      (request) => send(fastify, actor, request),
    ));

    responses.forEach(([outside, last]) => {
      assertNotFound(outside);
      assertProtected(last);
    });
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(await listMemberIds(fastify, adminId), [firstId]);
  });

  test('keeps its last active member: blocked members do not count, and may go themselves while the active one stays', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const [activeId, firstBlockedId, secondBlockedId] = await mapSeries(['active', 'first blocked', 'second blocked'], () => createUser(fastify));

    await mapSeries([firstBlockedId, secondBlockedId], (id) => blockByHand(fastify, id));

    const adminId = await setAdminMembers(fastify, [activeId, firstBlockedId, secondBlockedId]);
    const stateBefore = await readState(fastify, STATE_TABLES);

    assertProtected(await send(fastify, root, deleteMemberRequest(adminId, activeId)));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);

    await mapSeries([firstBlockedId, secondBlockedId], (userId) => dropMember(fastify, root, adminId, userId));
    assertProtected(await send(fastify, root, deleteMemberRequest(adminId, activeId)));
    assert.deepEqual(await listMemberIds(fastify, adminId), [activeId]);
  });

  test('lets the last member go of a group with full access that is not of the system, and of a group of the system without full access', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const full = await makeGroup(fastify, root, { isSuperadmin: true });
    const { id: systemId } = await insertGroup(fastify, { isSystem: true });
    const [fullMemberId, systemMemberId] = await mapSeries(['full', 'system'], () => createUser(fastify));

    await mapSeries([[full.id, fullMemberId], [systemId, systemMemberId]], ([groupId, userId]) => makeMember(fastify, root, groupId, userId));
    await mapSeries([[full.id, fullMemberId], [systemId, systemMemberId]], ([groupId, userId]) => dropMember(fastify, root, groupId, userId));
    assert.deepEqual([await listMemberIds(fastify, full.id), await listMemberIds(fastify, systemId)], [[], []]);
  });

  test('keeps its slug to itself while its row is there and while it is missing: a new group and a change of the slug of another group to it are 409 GROUP_PROTECTED, before the 403 of one who may not give full access, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE]);
    const [plain, full] = await mapSeries([{}, { isSuperadmin: true }], (fields) => makeGroup(fastify, root, fields));
    const refusals = [
      [root, postGroupRequest({ slug: GROUP_SLUG.ADMIN, name: 'Admins' })],
      [root, patchGroupRequest(plain.id, { slug: GROUP_SLUG.ADMIN })],
      [root, patchGroupRequest(full.id, { slug: GROUP_SLUG.ADMIN })],
      [manager, postGroupRequest({ slug: GROUP_SLUG.ADMIN, name: 'Admins', isSuperadmin: true })],
      [manager, patchGroupRequest(plain.id, { slug: GROUP_SLUG.ADMIN, isSuperadmin: true })],
      [manager, patchGroupRequest(full.id, { slug: GROUP_SLUG.ADMIN })],
    ];

    async function assertRefused() {
      const stateBefore = await readState(fastify, STATE_TABLES);
      const responses = await mapSeries(refusals, ([actor, request]) => send(fastify, actor, request));

      responses.forEach((response) => assertProtected(response));
      assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    }

    await assertRefused();
    await removeAdminRow(t, fastify);
    assert.equal(await findGroupId(fastify, GROUP_SLUG.ADMIN), null);
    await assertRefused();
  });
});

describe('the members of a group', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('lists the members with the fields of a user and no other, the avatar as the URL of its file or null, by the filters and the sort of the users, a page at a time; an unknown group is 404', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const reader = await signInAs(fastify, [SCOPE.GROUPS_READ, SCOPE.USERS_READ]);
    const group = await makeGroup(fastify, root);
    const [anna, oleh, olena] = await mapSeries(PEOPLE, (person) => createPerson(fastify, person));

    await createPerson(fastify, OUTSIDER);
    await mapSeries([anna, oleh, olena], (person) => makeMember(fastify, root, group.id, person.id));

    const queries = [
      '',
      '?sort=name',
      '?firstName=OLE',
      '?status=blocked',
      '?createdAtFrom=2026-11-11T00:00:00.000Z&createdAtTo=2026-11-13T00:00:00.000Z',
      '?limit=1&offset=1',
    ];
    const responses = await mapSeries(queries, (query) => send(fastify, reader, getMembersRequest(group.id, query)));

    assert.deepEqual(responses.map((response) => [response.statusCode, response.json().data]), [
      [200, [olena, oleh, anna]],
      [200, [anna, oleh, olena]],
      [200, [olena, oleh]],
      [200, [oleh]],
      [200, [oleh]],
      [200, [oleh]],
    ]);
    assert.deepEqual(responses.at(-1).json().pagination, {
      total: 3,
      limit: 1,
      offset: 1,
      totalPages: 3,
      currentPage: 2,
      canLoadMore: true,
    });
    assertNotFound(await send(fastify, reader, getMembersRequest(uuidv7())));
  });

  test('adds another user with PUT and takes them out with DELETE, 204 each: granted_by and the records of user.group_grant and user.group_revoke name the actor; a second PUT writes nothing', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE, SCOPE.GROUPS_READ, SCOPE.USERS_READ]);
    const group = await makeGroup(fastify, manager);
    const userId = await createUser(fastify);
    const meta = { group: group.slug, groupId: group.id };
    const added = await makeMember(fastify, manager, group.id, userId);
    const stateAdded = await readState(fastify, STATE_TABLES);

    assert.deepEqual(await readMemberships(fastify, group.id), [{ user_id: userId, group_id: group.id, granted_by: manager.userId }]);
    assert.deepEqual(readMemberIds(await send(fastify, manager, getMembersRequest(group.id))), [userId]);

    await makeMember(fastify, manager, group.id, userId);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateAdded);

    const removed = await dropMember(fastify, manager, group.id, userId);

    assert.deepEqual(await readMemberships(fastify, group.id), []);
    assert.deepEqual(readMemberIds(await send(fastify, manager, getMembersRequest(group.id))), []);
    assert.deepEqual(await readAudit(fastify, userId), [
      describeAudit(added, manager.userId, {
        action: GRANT_ACTION,
        entityType: USERS_ENTITY,
        entityId: userId,
        meta,
      }),
      describeAudit(removed, manager.userId, {
        action: REVOKE_ACTION,
        entityType: USERS_ENTITY,
        entityId: userId,
        meta,
      }),
    ]);
  });

  test('adds a member once when two requests add them at the same moment: both 204, one row and one record', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const group = await makeGroup(fastify, root);
    const userId = await createUser(fastify);
    const responses = await Promise.all(['first', 'second'].map(() => send(fastify, root, putMemberRequest(group.id, userId))));

    responses.forEach((response) => assertNoContent(response));
    assert.deepEqual(await readMemberships(fastify, group.id), [{ user_id: userId, group_id: group.id, granted_by: root.userId }]);
    assert.deepEqual((await readAudit(fastify, userId)).map((row) => row.action), [GRANT_ACTION]);
  });

  test('answers 404 to a group or a user that does not exist, by PUT and by DELETE, and to one who is no member by DELETE, and writes nothing', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const group = await makeGroup(fastify, root);
    const userId = await createUser(fastify);
    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries([
      putMemberRequest(uuidv7(), userId),
      putMemberRequest(group.id, uuidv7()),
      deleteMemberRequest(uuidv7(), userId),
      deleteMemberRequest(group.id, uuidv7()),
      deleteMemberRequest(group.id, userId),
    ], (request) => send(fastify, root, request));

    responses.forEach((response) => assertNotFound(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });

  test('lets nobody add themselves or take themselves out, a holder of * neither, and says so before it looks for the group: 403, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE]);
    const group = await makeGroup(fastify, root);
    const adminId = await readAdminId(fastify);
    const [ownGroupId] = await readGroupIdsOf(fastify, root.userId);
    const stateBefore = await readState(fastify, STATE_TABLES);
    const refusals = [
      [root, putMemberRequest(group.id, root.userId)],
      [root, putMemberRequest(adminId, root.userId)],
      [root, deleteMemberRequest(ownGroupId, root.userId)],
      [root, putMemberRequest(uuidv7(), root.userId)],
      [root, deleteMemberRequest(uuidv7(), root.userId)],
      [manager, putMemberRequest(group.id, manager.userId)],
    ];
    const responses = await mapSeries(refusals, ([actor, request]) => send(fastify, actor, request));

    responses.forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(await readGroupIdsOf(fastify, root.userId), [ownGroupId]);
  });
});

describe('a change of groups and the access token', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('reaches a member on their next refresh and not before: the token they hold keeps the scopes it was issued with as scopes come and go', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const member = await signInAs(fastify);
    const group = await makeGroup(fastify, root, { scopes: [SCOPE.GROUPS_READ] });
    const list = getGroupsRequest();
    const members = getMembersRequest(group.id);

    assertForbidden(await send(fastify, member, list));
    await makeMember(fastify, root, group.id, member.userId);
    assertForbidden(await send(fastify, member, list));

    const joined = await refreshDevice(fastify, member);

    assert.deepEqual(joined.scopes, [SCOPE.GROUPS_READ]);
    assert.equal((await send(fastify, joined, list)).statusCode, 200);
    assertForbidden(await send(fastify, joined, members));

    await changeGroup(fastify, root, group.id, { scopes: [SCOPE.GROUPS_READ, SCOPE.USERS_READ] });
    assertForbidden(await send(fastify, joined, members));

    const widened = await refreshDevice(fastify, joined);

    assert.deepEqual(widened.scopes, [SCOPE.GROUPS_READ, SCOPE.USERS_READ]);
    assert.equal((await send(fastify, widened, members)).statusCode, 200);

    await changeGroup(fastify, root, group.id, { scopes: [] });
    assert.equal((await send(fastify, widened, members)).statusCode, 200);

    const emptied = await refreshDevice(fastify, widened);

    assert.deepEqual(emptied.scopes, []);
    assertForbidden(await send(fastify, emptied, list));

    await changeGroup(fastify, root, group.id, { isSuperadmin: true });

    const promoted = await refreshDevice(fastify, emptied);

    assert.deepEqual(promoted.scopes, [SCOPE_ALL]);
    assert.equal((await send(fastify, promoted, postGroupRequest({ slug: createSlug('promoted'), name: 'Promoted' }))).statusCode, 201);

    await dropMember(fastify, root, group.id, member.userId);
    assert.equal((await send(fastify, promoted, list)).statusCode, 200);

    const left = await refreshDevice(fastify, promoted);

    assert.deepEqual(left.scopes, []);
    assertForbidden(await send(fastify, left, list));
  });

  test('takes the scopes of a deleted group from its members on their next refresh', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const member = await signInAs(fastify);
    const group = await makeGroup(fastify, root, { scopes: [SCOPE.GROUPS_READ] });

    await makeMember(fastify, root, group.id, member.userId);

    const joined = await refreshDevice(fastify, member);

    assert.deepEqual(joined.scopes, [SCOPE.GROUPS_READ]);
    assertNoContent(await send(fastify, root, deleteGroupRequest(group.id)));
    assert.equal((await send(fastify, joined, getGroupsRequest())).statusCode, 200);

    const left = await refreshDevice(fastify, joined);

    assert.deepEqual(left.scopes, []);
    assertForbidden(await send(fastify, left, getGroupsRequest()));
  });
});

describe('the cache of the reads of groups', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('with Redis up serves a read again from the cache until a change through the API, which the next read shows: the list, the group, its scopes and its members', async (t) => {
    const fastify = await openRouteApp(t, testDb);

    // The first read of a table whose version is not there yet starts it and goes to the database, caching nothing.
    await runInApp(fastify, () => invalidateCacheTables([TABLE.GROUPS, TABLE.GROUP_SCOPES, TABLE.USERS, TABLE.USER_GROUPS]));

    const root = await signInAs(fastify, [SCOPE_ALL]);
    const reader = await signInAs(fastify, [SCOPE.GROUPS_READ, SCOPE.USERS_READ]);
    const [userId, otherId] = await mapSeries(['member', 'other'], () => createUser(fastify));
    const group = await makeGroup(fastify, root, { name: 'Cached' });
    const newest = getGroupsRequest('?sort=newest&limit=1');

    async function readNewest() {
      return (await send(fastify, reader, newest)).json().data;
    }

    async function readOne() {
      return (await send(fastify, reader, getGroupRequest(group.id))).json().data;
    }

    async function readMembers() {
      return readMemberIds(await send(fastify, reader, getMembersRequest(group.id)));
    }

    assert.deepEqual([await readNewest(), await readOne(), await readMembers()], [[group], group, []]);

    await readAppRows(fastify, RENAME_SQL, { id: group.id, name: 'Renamed behind the back' });
    await joinGroup(fastify, { userId: otherId, groupId: group.id });
    assert.deepEqual([await readNewest(), await readOne(), await readMembers()], [[group], group, []]);

    const described = await changeGroup(fastify, root, group.id, { description: 'Changed through the API' });

    assert.equal(described.name, 'Renamed behind the back');
    assert.deepEqual([await readNewest(), await readOne()], [[described], described]);

    const scoped = await changeGroup(fastify, root, group.id, { scopes: [SCOPE.USERS_READ] });

    assert.deepEqual([await readNewest(), await readOne()], [[scoped], scoped]);

    await makeMember(fastify, root, group.id, userId);
    assert.deepEqual(await readMembers(), [otherId, userId]);

    await dropMember(fastify, root, group.id, otherId);
    assert.deepEqual(await readMembers(), [userId]);

    assertNoContent(await send(fastify, root, deleteGroupRequest(group.id)));
    assertNotFound(await send(fastify, reader, getGroupRequest(group.id)));
    assert.notEqual((await readNewest())[0]?.id, group.id);
  });
});

describe('a write with the token of one who was just demoted', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('is judged by what the database grants the actor now: a manager taken out of the group that gave them groups:manage is refused with 403 by every change at once, though the old token still passes the guard, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const member = await signInAs(fastify);
    const [power, target] = await mapSeries([{ scopes: [SCOPE.GROUPS_MANAGE, SCOPE.GROUPS_READ] }, {}], (fields) => makeGroup(fastify, root, fields));
    const [insiderId, outsiderId] = await mapSeries(['insider', 'outsider'], () => createUser(fastify));

    await mapSeries([[power.id, member.userId], [target.id, insiderId]], ([groupId, userId]) => makeMember(fastify, root, groupId, userId));

    const manager = await refreshDevice(fastify, member);

    assert.deepEqual(manager.scopes, [SCOPE.GROUPS_MANAGE, SCOPE.GROUPS_READ]);
    await changeGroup(fastify, manager, target.id, { name: 'Managed' });
    await dropMember(fastify, root, power.id, manager.userId);

    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries([
      postGroupRequest({ slug: createSlug('stale'), name: 'Stale' }),
      patchGroupRequest(target.id, { name: 'Stale' }),
      deleteGroupRequest(target.id),
      putMemberRequest(target.id, outsiderId),
      deleteMemberRequest(target.id, insiderId),
    ], (request) => send(fastify, manager, request));

    responses.forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.equal((await send(fastify, manager, getGroupRequest(target.id))).statusCode, 200);
    assertNotFound(await send(fastify, manager, patchGroupRequest(uuidv7(), { name: 'Nobody' })));

    const refreshed = await refreshDevice(fastify, manager);

    assert.deepEqual(refreshed.scopes, []);
    assertForbidden(await send(fastify, refreshed, patchGroupRequest(uuidv7(), { name: 'Nobody' })));
  });

  test('lets no manager taken out of the group that gave them groups:manage add a second account to any group with the old token, that group among them: 403, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const member = await signInAs(fastify);
    const groups = await mapSeries([{ scopes: [SCOPE.GROUPS_MANAGE] }, {}, { scopes: [SCOPE.GROUPS_MANAGE] }], (fields) => makeGroup(fastify, root, fields));
    const [power, plain] = groups;
    const [secondId, otherId] = await mapSeries(['second', 'other'], () => createUser(fastify));

    await makeMember(fastify, root, power.id, member.userId);

    const manager = await refreshDevice(fastify, member);

    await makeMember(fastify, manager, plain.id, otherId);
    await dropMember(fastify, root, power.id, manager.userId);

    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries(groups, (group) => send(fastify, manager, putMemberRequest(group.id, secondId)));

    responses.forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(await readGroupIdsOf(fastify, secondId), []);
  });

  test('lets no holder of * whom another one took out of the admin group take that one out with the old token, nor change the group: 403, and the admin group keeps them', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const devices = await mapSeries(['taker', 'taken'], () => signInAs(fastify));
    const [thirdId, newcomerId] = await mapSeries(['third', 'newcomer'], () => createUser(fastify));
    const adminId = await readAdminId(fastify);

    await mapSeries([...devices.map((device) => device.userId), thirdId], (userId) => makeMember(fastify, root, adminId, userId));

    const [taker, taken] = await mapSeries(devices, (device) => refreshDevice(fastify, device));

    assert.deepEqual([taker.scopes, taken.scopes], [[SCOPE_ALL], [SCOPE_ALL]]);
    await dropMember(fastify, taker, adminId, taken.userId);

    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries([
      deleteMemberRequest(adminId, taker.userId),
      deleteMemberRequest(adminId, thirdId),
      putMemberRequest(adminId, newcomerId),
      patchGroupRequest(adminId, { name: 'Taken over' }),
    ], (request) => send(fastify, taken, request));

    responses.forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.ok((await listMemberIds(fastify, adminId)).includes(taker.userId));
    assert.deepEqual((await refreshDevice(fastify, taken)).scopes, []);
  });

  test('lets no member of a group whose full access was just turned off turn it back on with the old token, nor give it to a new group: 403, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const member = await signInAs(fastify);
    const full = await makeGroup(fastify, root, { isSuperadmin: true });

    await makeMember(fastify, root, full.id, member.userId);

    const holder = await refreshDevice(fastify, member);

    assert.deepEqual(holder.scopes, [SCOPE_ALL]);
    await changeGroup(fastify, root, full.id, { isSuperadmin: false });

    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries([
      patchGroupRequest(full.id, { isSuperadmin: true }),
      postGroupRequest({ slug: createSlug('full'), name: 'Full again', isSuperadmin: true }),
    ], (request) => send(fastify, holder, request));

    responses.forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.equal((await readGroupRow(fastify, full.id)).is_superadmin, false);
  });

  test('loses a scope taken from a group of the actor at once, while the reads go by the token until its next refresh, which leaves the scope out', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const member = await signInAs(fastify);
    const [power, readers] = await mapSeries([{ scopes: [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ] }, { scopes: [SCOPE.USERS_READ] }], (fields) => makeGroup(fastify, root, fields));
    const userId = await createUser(fastify);

    await makeMember(fastify, root, power.id, member.userId);

    const manager = await refreshDevice(fastify, member);

    assert.deepEqual(manager.scopes, [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]);
    await changeGroup(fastify, manager, readers.id, { name: 'Readers' });
    await changeGroup(fastify, root, power.id, { scopes: [SCOPE.GROUPS_MANAGE] });

    const stateBefore = await readState(fastify, STATE_TABLES);
    const responses = await mapSeries([
      patchGroupRequest(readers.id, { name: 'Readers again' }),
      putMemberRequest(readers.id, userId),
      postGroupRequest({ slug: createSlug('readers'), name: 'Readers', scopes: [SCOPE.USERS_READ] }),
    ], (request) => send(fastify, manager, request));

    responses.forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.equal((await send(fastify, manager, getMembersRequest(readers.id))).statusCode, 200);

    const narrowed = await refreshDevice(fastify, manager);

    assert.deepEqual(narrowed.scopes, [SCOPE.GROUPS_MANAGE]);
    assertForbidden(await send(fastify, narrowed, getMembersRequest(readers.id)));
    assert.equal((await changeGroup(fastify, narrowed, power.id, { name: 'Power' })).name, 'Power');
  });
});

// Blocked by hand: nothing revokes the session, and its access token stays alive until it ends.
describe('a user who was just blocked', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('changes no group with the token they still hold, which the guard lets through to the reads: every write is refused with 403 though their groups grant full access, and nothing is written', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const [root, actor] = await mapSeries(['root', 'actor'], () => signInAs(fastify, [SCOPE_ALL]));
    const group = await makeGroup(fastify, root);
    const [insiderId, outsiderId] = await mapSeries(['insider', 'outsider'], () => createUser(fastify));

    await makeMember(fastify, actor, group.id, insiderId);
    await blockByHand(fastify, actor.userId);

    const stateBefore = await readState(fastify, STATE_TABLES);
    const writes = await mapSeries([
      postGroupRequest({ slug: createSlug('blocked'), name: 'Blocked' }),
      patchGroupRequest(group.id, { name: 'Blocked' }),
      deleteGroupRequest(group.id),
      putMemberRequest(group.id, outsiderId),
      deleteMemberRequest(group.id, insiderId),
    ], (request) => send(fastify, actor, request));
    const reads = await mapSeries([
      getGroupsRequest(),
      getScopesRequest(),
      getGroupRequest(group.id),
      getMembersRequest(group.id),
    ], (request) => send(fastify, actor, request));

    writes.forEach((response) => assertForbidden(response));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(readStatuses(reads), [200, 200, 200, 200]);
    assert.deepEqual(readMemberIds(reads.at(-1)), [insiderId]);
  });

  test('may still be added to a group and taken out of it by an active manager: 204 each, and granted_by and the records of user.group_grant and user.group_revoke name the manager', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]);
    const group = await makeGroup(fastify, manager);
    const blockedId = await createUser(fastify, { status: USER_STATUS.BLOCKED });
    const meta = { group: group.slug, groupId: group.id };
    const added = await makeMember(fastify, manager, group.id, blockedId);

    assert.deepEqual(await readMemberships(fastify, group.id), [{ user_id: blockedId, group_id: group.id, granted_by: manager.userId }]);
    assert.deepEqual(readMemberIds(await send(fastify, manager, getMembersRequest(group.id, `?status=${USER_STATUS.BLOCKED}`))), [blockedId]);

    const removed = await dropMember(fastify, manager, group.id, blockedId);

    assert.deepEqual(await readMemberships(fastify, group.id), []);
    assert.deepEqual(await readAudit(fastify, blockedId), [
      describeAudit(added, manager.userId, {
        action: GRANT_ACTION,
        entityType: USERS_ENTITY,
        entityId: blockedId,
        meta,
      }),
      describeAudit(removed, manager.userId, {
        action: REVOKE_ACTION,
        entityType: USERS_ENTITY,
        entityId: blockedId,
        meta,
      }),
    ]);
  });
});

describe('the conflicts of the routes of groups', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('are the ones the docs name for each route: GROUP_PROTECTED to POST, GROUP_PROTECTED and NO_CHANGES to PATCH, GROUP_PROTECTED to the DELETE of a group and of a member, and none to the others', async (t) => {
    const fastify = await openRouteApp(t, testDb, { env: DEV_ENV });
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const group = await makeGroup(fastify, root);
    const [memberId, lastId] = await mapSeries(['member', 'last'], () => createUser(fastify));
    const adminId = await setAdminMembers(fastify, [lastId]);

    await makeMember(fastify, root, group.id, memberId);

    const spec = await readSpec(fastify);
    const scenarios = [
      [`GET ${GROUPS_URL}`, getGroupsRequest(), 200],
      [`GET ${SCOPES_URL}`, getScopesRequest(), 200],
      [`GET ${GROUPS_URL}/{id}`, getGroupRequest(adminId), 200],
      [`POST ${GROUPS_URL}`, postGroupRequest({ slug: GROUP_SLUG.ADMIN, name: 'Admins' }), 409],
      [`POST ${GROUPS_URL}`, postGroupRequest({ slug: group.slug, name: 'Taken' }), 422],
      [`PATCH ${GROUPS_URL}/{id}`, patchGroupRequest(group.id, {}), 409],
      [`PATCH ${GROUPS_URL}/{id}`, patchGroupRequest(group.id, { slug: GROUP_SLUG.ADMIN }), 409],
      [`PATCH ${GROUPS_URL}/{id}`, patchGroupRequest(adminId, { slug: 'root' }), 409],
      [`PATCH ${GROUPS_URL}/{id}`, patchGroupRequest(adminId, { isSuperadmin: false }), 409],
      [`DELETE ${GROUPS_URL}/{id}`, deleteGroupRequest(adminId), 409],
      [`GET ${GROUPS_URL}/{groupId}/members`, getMembersRequest(adminId), 200],
      [`PUT ${GROUPS_URL}/{groupId}/members/{userId}`, putMemberRequest(group.id, memberId), 204],
      [`DELETE ${GROUPS_URL}/{groupId}/members/{userId}`, deleteMemberRequest(adminId, lastId), 409],
    ];
    const responses = await mapSeries(scenarios, ([, request]) => send(fastify, root, request));

    assert.equal(spec.statusCode, 200);
    assert.deepEqual(readStatuses(responses), scenarios.map(([, , statusCode]) => statusCode));
    assert.deepEqual(readAnsweredConflicts(scenarios, responses), readDocumentedConflicts(spec.json().paths, GROUPS_URL));
    responses.filter((response) => response.statusCode === HTTP_STATUS.CONFLICT).forEach((response) => assertError(response, response.json().code));
  });
});

describe('changes of groups at the same moment', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => migrateAndSeed(testDb));

  test('settle when two managers take each other out of groups at once, with 204 or a clean 403 and never a 500 or a hang: both go out of groups that gave them nothing, and of the two that gave each of them groups:manage only the first to come goes', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const managers = await mapSeries(['first', 'second'], () => signInAs(fastify, [SCOPE.GROUPS_MANAGE]));
    const powerIds = await mapSeries(managers, async (manager) => (await readGroupIdsOf(fastify, manager.userId))[0]);
    const plains = await mapSeries(managers, () => makeGroup(fastify, root));

    await mapSeries(managers, (manager, index) => makeMember(fastify, root, plains[index].id, manager.userId));

    const [first, second] = managers;
    const apart = await Promise.all([
      send(fastify, first, deleteMemberRequest(plains[1].id, second.userId)),
      send(fastify, second, deleteMemberRequest(plains[0].id, first.userId)),
    ]);

    apart.forEach((response) => assertNoContent(response));
    assert.deepEqual(await mapSeries(plains, (plain) => listMemberIds(fastify, plain.id)), [[], []]);

    const crossed = await Promise.all([
      send(fastify, first, deleteMemberRequest(powerIds[1], second.userId)),
      send(fastify, second, deleteMemberRequest(powerIds[0], first.userId)),
    ]);
    const isFirstAhead = assertSettled(crossed[0]);

    assert.equal(assertSettled(crossed[1]), !isFirstAhead);
    assert.deepEqual(
      await mapSeries(managers, (manager) => readGroupIdsOf(fastify, manager.userId)),
      isFirstAhead
        ? [[powerIds[0]], []]
        : [[], [powerIds[1]]],
    );
  });

  test('settle when a change of the members of a group and a PATCH of it come at once: the PATCH 200, and the change 204 when it is first or a clean 403 after a PATCH that gives the group a scope its actor lacks', async (t) => {
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const manager = await signInAs(fastify, [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]);
    const group = await makeGroup(fastify, root, { scopes: [SCOPE.USERS_READ] });
    const [firstId, secondId] = await mapSeries(['first', 'second'], () => createUser(fastify));
    const [added, renamed] = await Promise.all([
      send(fastify, manager, putMemberRequest(group.id, firstId)),
      send(fastify, root, patchGroupRequest(group.id, { name: 'Renamed at once' })),
    ]);

    assertNoContent(added);
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal((await readGroupRow(fastify, group.id)).name, 'Renamed at once');

    const [raced, widened] = await Promise.all([
      send(fastify, manager, putMemberRequest(group.id, secondId)),
      send(fastify, root, patchGroupRequest(group.id, { scopes: [SCOPE.GROUPS_READ, SCOPE.USERS_READ] })),
    ]);
    const isAdded = assertSettled(raced);

    assert.equal(widened.statusCode, 200, widened.body);
    assert.deepEqual(await readScopeRows(fastify, group.id), [SCOPE.GROUPS_READ, SCOPE.USERS_READ]);
    assert.deepEqual(
      await listMemberIds(fastify, group.id),
      isAdded
        ? [firstId, secondId]
        : [firstId],
    );
  });

  test('reads what the actor holds once it has locked them: a write that waits for the row of its actor is refused with 403 when a demotion commits meanwhile, and writes nothing', async (t) => {
    const keeper = await testDb.openKeeper(t);
    const fastify = await openRouteApp(t, testDb);
    const root = await signInAs(fastify, [SCOPE_ALL]);
    const member = await signInAs(fastify);
    const [power, plain] = await mapSeries([{ scopes: [SCOPE.GROUPS_MANAGE] }, {}], (fields) => makeGroup(fastify, root, fields));
    const userId = await createUser(fastify);

    await makeMember(fastify, root, power.id, member.userId);

    const manager = await refreshDevice(fastify, member);

    await keeper.holdRow(TABLE.USERS, manager.userId);

    const waiting = send(fastify, manager, putMemberRequest(plain.id, userId));

    await findSessionId(testDb, USERS_LOCK_MARK);
    await keeper.query(LEAVE_BY_KEEPER_SQL, [manager.userId, power.id]);
    await keeper.query(COMMIT_SQL);
    assertForbidden(await waiting);
    assert.deepEqual(await readMemberships(fastify, plain.id), []);
    assert.deepEqual(await readAudit(fastify, userId), []);
  });
});
