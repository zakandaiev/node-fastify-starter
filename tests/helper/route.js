import { ERROR_CATALOG, ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { USER_STATUS } from '#enums/user-status.js';
import { errorBody, readRequestId, successBody } from '#root/tests/helper/app.js';
import { SMALL_POOL } from '#root/tests/helper/db.js';
import { BEARER, listOperations, NO_STORE } from '#root/tests/helper/guard.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import {
  connectAppRedis,
  createUser,
  grantActorScopes,
  joinGroup,
  openLoggedApp,
  readAdminId,
  readAppRows,
  readMemberships,
  signIn,
} from '#root/tests/helper/session.js';
import { unique } from '#utils/array.js';
import { mapSeries } from '#utils/async.js';
import assert from 'node:assert/strict';
import { STATUS_CODES } from 'node:http';

export const USERS_URL = '/api/v1/users';
export const ME_URL = `${USERS_URL}/me`;
export const GROUPS_URL = '/api/v1/groups';
export const LOGIN_DEV_URL = '/api/v1/auth/login-dev';
const SESSION_URL = '/api/v1/auth/me';
const REFRESH_URL = '/api/v1/auth/refresh';

// The address inject() sends every request from.
export const LOOPBACK = '127.0.0.1';

// Before every row a test makes: a write moves updated_at past it.
export const LONG_AGO = '2026-01-01T00:00:00.000Z';

const UNIQUE_OPERATOR = 'unique';

// How the docs name the codes of a conflict: "Conflict: GROUP_PROTECTED, NO_CHANGES".
const CONFLICT_PREFIX = `${STATUS_CODES[HTTP_STATUS.CONFLICT]}: `;
const CODE_SEPARATOR = ', ';

const STATUS_SQL = 'UPDATE users SET status = :status WHERE id = :id';
const EMPTY_GROUP_SQL = 'DELETE FROM user_groups WHERE group_id = :groupId';

export async function migrateAndSeed(testDb) {
  const { up } = bindMigrator(testDb);

  await up();
  await up({ type: MIGRATION_TYPE.SEED });
}

export async function openRouteApp(t, testDb, sections = {}) {
  const fastify = await testDb.buildApp({ ...sections, db: { ...SMALL_POOL, ...sections.db } });

  t.after(() => fastify.close());
  await connectAppRedis(fastify);

  return fastify;
}

export async function openLoggedRouteApp(t, testDb, { db, ...options } = {}) {
  const opened = await openLoggedApp(t, testDb, { ...options, db: { ...SMALL_POOL, ...db } });

  await connectAppRedis(opened.fastify);

  return opened;
}

// The device of a new user with these scopes, carrying the id of the group that grants them.
export async function signInAs(fastify, scopes = []) {
  const userId = await createUser(fastify);
  const groupId = await grantActorScopes(fastify, userId, scopes);

  return { ...(await signIn(fastify, { userId })), groupId };
}

// A statement of the test, not the block of the API: no session of the user is revoked.
export function blockByHand(fastify, userId) {
  return readAppRows(fastify, STATUS_SQL, { id: userId, status: USER_STATUS.BLOCKED });
}

export function send(fastify, actor, request) {
  return fastify.inject({ ...request, headers: { ...actor?.bearer, ...request.headers } });
}

export function refresh(fastify, refreshCookie) {
  return fastify.inject({ method: 'POST', url: REFRESH_URL, cookies: refreshCookie });
}

export function postLoginDev(fastify, email) {
  return fastify.inject({ method: 'POST', url: LOGIN_DEV_URL, payload: { email } });
}

export function getSessionRequest() {
  return { method: 'GET', url: SESSION_URL };
}

export function getMeRequest() {
  return { method: 'GET', url: ME_URL };
}

export function deleteMeRequest() {
  return { method: 'DELETE', url: ME_URL };
}

export function getUsersRequest(query = '') {
  return { method: 'GET', url: `${USERS_URL}${query}` };
}

export function getUserRequest(id) {
  return { method: 'GET', url: `${USERS_URL}/${id}` };
}

export function patchUserRequest(id, payload) {
  return { method: 'PATCH', url: `${USERS_URL}/${id}`, payload };
}

export function deleteUserRequest(id) {
  return { method: 'DELETE', url: `${USERS_URL}/${id}` };
}

export function blockRequest(id) {
  return { method: 'POST', url: `${USERS_URL}/${id}/block` };
}

export function unblockRequest(id) {
  return { method: 'POST', url: `${USERS_URL}/${id}/unblock` };
}

export function getMembersRequest(groupId, query = '') {
  return { method: 'GET', url: `${GROUPS_URL}/${groupId}/members${query}` };
}

export function readStatuses(responses) {
  return responses.map((response) => response.statusCode);
}

function readHeaders(response) {
  return [response.headers[HEADER.CACHE_CONTROL], response.headers[HEADER.WWW_AUTHENTICATE]];
}

export function readFailures(response) {
  return response.json().validation.map((entry) => [entry.column, entry.operator]);
}

export function readMemberIds(response) {
  return response.json().data.map((member) => member.id);
}

export function describeAudit(response, actorId, {
  action, entityType, entityId, meta = null,
}) {
  return {
    actor_id: actorId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    meta,
    ip: LOOPBACK,
    request_id: readRequestId(response),
  };
}

// The admin group with these members and no other: the tests of a file share it.
export async function setAdminMembers(fastify, userIds) {
  const adminId = await readAdminId(fastify);

  await readAppRows(fastify, EMPTY_GROUP_SQL, { groupId: adminId });
  await mapSeries(userIds, (userId) => joinGroup(fastify, { userId, groupId: adminId }));

  return adminId;
}

export async function listMemberIds(fastify, groupId) {
  return (await readMemberships(fastify, groupId)).map((row) => row.user_id);
}

function readConflictCodes(operation) {
  const conflict = operation.responses[HTTP_STATUS.CONFLICT];

  if (conflict === undefined) {
    return [];
  }

  assert.ok(conflict.description.startsWith(CONFLICT_PREFIX), conflict.description);

  return conflict.description.slice(CONFLICT_PREFIX.length).split(CODE_SEPARATOR).toSorted();
}

// The codes each operation under the prefix documents for 409, by its name in listOperations().
export function readDocumentedConflicts(paths, prefix) {
  return Object.fromEntries(listOperations(paths, prefix).map(([name, operation]) => [name, readConflictCodes(operation)]));
}

// The codes each operation has answered 409 with, by the name of its scenarios, which come in the order of the responses.
export function readAnsweredConflicts(scenarios, responses) {
  const names = unique(scenarios.map(([name]) => name));

  return Object.fromEntries(names.map((name) => [name, unique(responses
    .filter((response, index) => scenarios[index][0] === name && response.statusCode === HTTP_STATUS.CONFLICT)
    .map((response) => response.json().code)).toSorted()]));
}

function describeError(response, code) {
  return errorBody(response, code, ERROR_CATALOG[code].message);
}

export function assertError(response, code) {
  assert.equal(response.statusCode, ERROR_CATALOG[code].statusCode, response.body);
  assert.deepEqual(response.json(), describeError(response, code));
}

function assertTokenRefused(response, code) {
  assertError(response, code);
  assert.equal(response.headers[HEADER.CACHE_CONTROL], NO_STORE);
}

export function assertUnauthenticated(response) {
  assertTokenRefused(response, ERROR_CODE.AUTHENTICATION_ERROR);
}

export function assertRevoked(response) {
  assertTokenRefused(response, ERROR_CODE.SESSION_REVOKED);
}

// The refusal of the guard, which names the scheme a token is taken by.
export function assertChallenged(response) {
  assertUnauthenticated(response);
  assert.deepEqual(readHeaders(response), [NO_STORE, BEARER]);
}

export function assertForbidden(response) {
  assertError(response, ERROR_CODE.AUTHORIZATION_ERROR);
  assert.deepEqual(readHeaders(response), [NO_STORE, undefined]);
}

export function assertNotFound(response) {
  assertError(response, ERROR_CODE.NOT_FOUND_ERROR);
}

export function assertNoChanges(response) {
  assertError(response, ERROR_CODE.NO_CHANGES);
}

export function assertProtected(response) {
  assertError(response, ERROR_CODE.GROUP_PROTECTED);
}

export function assertTaken(response, column, columnValue) {
  assert.equal(response.statusCode, ERROR_CATALOG[ERROR_CODE.VALIDATION_ERROR].statusCode, response.body);
  assert.deepEqual(response.json(), {
    ...describeError(response, ERROR_CODE.VALIDATION_ERROR),
    validation: [{
      column,
      columnValue,
      operator: UNIQUE_OPERATOR,
      operatorValue: null,
    }],
  });
}

export function assertNoContent(response) {
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.body, '');
}

export function assertOk(response, data) {
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), successBody(response, data));
  assert.equal(response.headers[HEADER.CACHE_CONTROL], NO_STORE);
}
