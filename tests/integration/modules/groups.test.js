import { AppError } from '#core/error/index.js';
import { GROUP_SLUG } from '#enums/group.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { SCOPE, SCOPE_ALL } from '#enums/scope.js';
import { USER_STATUS } from '#enums/user-status.js';
import {
  addMember,
  createGroup,
  removeGroup,
  removeMember,
  updateGroup,
} from '#modules/groups/groups.service.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createUser, grantScopes } from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const ACTOR_REFUSAL = /requires the UUID of the actor/;
const SCOPES_REFUSAL = /requires scopes to be distinct codes of the scope catalog in src\/enums\/scope\.js/;
const FIELDS_REFUSAL = /requires the fields of the group/;

const FORBIDDEN_CODE = 'AUTHORIZATION_ERROR';

const LONG_AGO = '2026-01-01T00:00:00.000Z';

const SLUG_SQL = 'SELECT id FROM groups WHERE slug = :slug';
const JOIN_SQL = 'INSERT INTO user_groups (user_id, group_id) VALUES (:userId, :groupId)';
const LEAVE_SQL = 'DELETE FROM user_groups WHERE user_id = :userId AND group_id = :groupId';
const STATUS_SQL = 'UPDATE users SET status = :status WHERE id = :id';
const MEMBERSHIPS_SQL = 'SELECT user_id, granted_by FROM user_groups WHERE group_id = :groupId';
const GROUP_ROW_SQL = 'SELECT id, is_system, created_at FROM groups WHERE id = :id';
const AUDIT_SQL = `
  SELECT actor_id, action, entity_type, entity_id, meta, ip, request_id
  FROM audit_logs
  WHERE entity_id = :entityId
  ORDER BY id
`;

// The rows a change of groups writes: a refused one leaves each of them as it was.
const STATE_SQL = Object.freeze([
  'SELECT * FROM groups ORDER BY id',
  'SELECT * FROM group_scopes ORDER BY group_id, scope',
  'SELECT * FROM user_groups ORDER BY user_id, group_id',
  'SELECT * FROM audit_logs ORDER BY id',
]);

const WRONG_SCOPES = Object.freeze([
  [SCOPE_ALL],
  ['users:write'],
  [SCOPE.USERS_READ, SCOPE.USERS_READ],
  [null],
  SCOPE.USERS_READ,
]);

function run(fn) {
  return testDb.run(fn);
}

function readState() {
  return mapSeries(STATE_SQL, (sql) => testDb.readRows(sql));
}

async function readGroupRow(id) {
  const [row = null] = await testDb.readRows(GROUP_ROW_SQL, { id });

  return row;
}

async function readAdminId() {
  const [{ id }] = await testDb.readRows(SLUG_SQL, { slug: GROUP_SLUG.ADMIN });

  return id;
}

function createSlug(word) {
  return `${word}-${uuidv7()}`;
}

// The helpers of a session need only a context and a database, which the pool of the file has. "*" stands for full
// access, the flag of a group; the other scopes go into a group of the user's own.
async function createActor(scopes = []) {
  const id = await createUser(testDb);
  const listed = scopes.filter((scope) => scope !== SCOPE_ALL);
  const isSuperadmin = listed.length !== scopes.length;

  if (isSuperadmin || listed.length) {
    await grantScopes(testDb, id, listed, { isSuperadmin });
  }

  return id;
}

function assertRefusal(error, pattern) {
  assert.ok(error instanceof TypeError, error);
  assert.match(error.message, pattern);
}

function assertForbidden(error) {
  assert.ok(error instanceof AppError, error);
  assert.equal(error.code, FORBIDDEN_CODE);
}

describe('the service of groups', { skip: testDb.skip }, () => {
  before(async () => {
    await up();
    await up({ type: MIGRATION_TYPE.SEED });
  });

  test('refuses with a TypeError an actor id that is no UUID, and the actor of a token in its place, in every call that changes groups, and writes nothing', async () => {
    const rootId = await createActor([SCOPE_ALL]);
    const userId = await createUser(testDb);
    const group = await run(() => createGroup({ input: { slug: createSlug('kept'), name: 'Kept' }, actorId: rootId }));
    const actorIds = [undefined, null, '', 'admin', 42, { id: rootId }, [rootId]];
    const callers = [...actorIds.map((actorId) => ({ actorId })), { actor: { id: rootId, scopes: [SCOPE_ALL] } }];
    const calls = callers.flatMap((caller) => [
      () => createGroup({ input: { slug: createSlug('refused'), name: 'Refused' }, ...caller }),
      () => updateGroup({ id: group.id, input: { name: 'Refused' }, ...caller }),
      () => removeGroup({ id: group.id, ...caller }),
      () => addMember({ groupId: group.id, userId, ...caller }),
      () => removeMember({ groupId: group.id, userId, ...caller }),
    ]);
    const stateBefore = await readState();
    const errors = await mapSeries(calls, (call) => rejectionOf(run(call)));

    errors.forEach((error) => assertRefusal(error, ACTOR_REFUSAL));
    assert.deepEqual(await readState(), stateBefore);
  });

  test('refuses with a TypeError scopes that are no distinct codes of the catalog, * among them, and fields that are no object, which a route stops by its schema first, and writes nothing', async () => {
    const rootId = await createActor([SCOPE_ALL]);
    const group = await run(() => createGroup({ input: { slug: createSlug('scoped'), name: 'Scoped' }, actorId: rootId }));
    const stateBefore = await readState();
    const created = await mapSeries(WRONG_SCOPES, (scopes) => rejectionOf(run(() => createGroup({
      input: { slug: createSlug('refused'), name: 'Refused', scopes },
      actorId: rootId,
    }))));
    const updated = await mapSeries(WRONG_SCOPES, (scopes) => rejectionOf(run(() => updateGroup({ id: group.id, input: { scopes }, actorId: rootId }))));

    [...created, ...updated].forEach((error) => assertRefusal(error, SCOPES_REFUSAL));
    assertRefusal(await rejectionOf(run(() => createGroup({ input: 'Refused', actorId: rootId }))), FIELDS_REFUSAL);
    assert.deepEqual(await readState(), stateBefore);
  });

  test('writes no field of a group but those of its body: an id, isSystem and the times a caller passes are left alone', async () => {
    const rootId = await createActor([SCOPE_ALL]);
    const [givenId, otherId] = [uuidv7(), uuidv7()];
    const created = await run(() => createGroup({
      input: {
        id: givenId,
        slug: createSlug('plain'),
        name: 'Plain',
        isSystem: true,
        createdAt: LONG_AGO,
      },
      actorId: rootId,
    }));
    const updated = await run(() => updateGroup({
      id: created.id,
      input: {
        id: otherId,
        name: 'Still plain',
        isSystem: true,
        createdAt: LONG_AGO,
      },
      actorId: rootId,
    }));
    const row = await readGroupRow(created.id);

    assert.notEqual(created.id, givenId);
    assert.notEqual(created.createdAt.toISOString(), LONG_AGO);
    assert.deepEqual([created.isSystem, updated.id, updated.name, updated.isSystem], [false, created.id, 'Still plain', false]);
    assert.deepEqual([row.is_system, row.created_at], [false, created.createdAt]);
    assert.deepEqual([await readGroupRow(givenId), await readGroupRow(otherId)], [null, null]);
  });

  test('judges the actor by what the database grants them at the call: one taken out of the group of groups:manage a moment ago is refused with 403 by every change, as an id no user has, and one put into the admin group a moment ago may give full access', async () => {
    const managerId = await createUser(testDb);
    const [memberId, otherId, promotedId] = await mapSeries(['member', 'other', 'promoted'], () => createUser(testDb));
    const powerId = await grantScopes(testDb, managerId, [SCOPE.GROUPS_MANAGE]);
    const group = await run(() => createGroup({ input: { slug: createSlug('managed'), name: 'Managed' }, actorId: managerId }));

    assert.equal(await run(() => addMember({ groupId: group.id, userId: memberId, actorId: managerId })), true);
    await testDb.readRows(LEAVE_SQL, { userId: managerId, groupId: powerId });

    const calls = [managerId, uuidv7()].flatMap((actorId) => [
      () => createGroup({ input: { slug: createSlug('refused'), name: 'Refused' }, actorId }),
      () => updateGroup({ id: group.id, input: { name: 'Refused' }, actorId }),
      () => removeGroup({ id: group.id, actorId }),
      () => addMember({ groupId: group.id, userId: otherId, actorId }),
      () => removeMember({ groupId: group.id, userId: memberId, actorId }),
    ]);
    const stateBefore = await readState();
    const errors = await mapSeries(calls, (call) => rejectionOf(run(call)));

    errors.forEach((error) => assertForbidden(error));
    assert.deepEqual(await readState(), stateBefore);

    const fields = { slug: createSlug('full'), name: 'Full', isSuperadmin: true };

    assertForbidden(await rejectionOf(run(() => createGroup({ input: fields, actorId: promotedId }))));
    await testDb.readRows(JOIN_SQL, { userId: promotedId, groupId: await readAdminId() });

    const full = await run(() => createGroup({ input: fields, actorId: promotedId }));

    assert.deepEqual([full.slug, full.isSuperadmin], [fields.slug, true]);
  });

  // Blocked by hand, as a token that is still alive meets it: the database still grants the actor full access.
  test('refuses with 403 every change by an actor who is blocked, though their groups grant them full access, and writes nothing; the same actor active again may change groups', async () => {
    const [rootId, blockedId] = await mapSeries(['root', 'blocked'], () => createActor([SCOPE_ALL]));
    const [memberId, otherId] = await mapSeries(['member', 'other'], () => createUser(testDb));
    const group = await run(() => createGroup({ input: { slug: createSlug('held'), name: 'Held' }, actorId: rootId }));

    assert.equal(await run(() => addMember({ groupId: group.id, userId: memberId, actorId: blockedId })), true);
    await testDb.readRows(STATUS_SQL, { id: blockedId, status: USER_STATUS.BLOCKED });

    const calls = [
      () => createGroup({ input: { slug: createSlug('refused'), name: 'Refused' }, actorId: blockedId }),
      () => updateGroup({ id: group.id, input: { name: 'Refused' }, actorId: blockedId }),
      () => removeGroup({ id: group.id, actorId: blockedId }),
      () => addMember({ groupId: group.id, userId: otherId, actorId: blockedId }),
      () => removeMember({ groupId: group.id, userId: memberId, actorId: blockedId }),
    ];
    const stateBefore = await readState();
    const errors = await mapSeries(calls, (call) => rejectionOf(run(call)));

    errors.forEach((error) => assertForbidden(error));
    assert.deepEqual(await readState(), stateBefore);

    await testDb.readRows(STATUS_SQL, { id: blockedId, status: USER_STATUS.ACTIVE });

    const renamed = await run(() => updateGroup({ id: group.id, input: { name: 'Renamed' }, actorId: blockedId }));

    assert.equal(renamed.name, 'Renamed');
  });

  test('lets an active manager add a blocked user to a group and take them out again: true each, granted_by and both records name the manager', async () => {
    const managerId = await createActor([SCOPE.GROUPS_MANAGE]);
    const blockedId = await createUser(testDb, { status: USER_STATUS.BLOCKED });
    const group = await run(() => createGroup({ input: { slug: createSlug('blocked'), name: 'Blocked' }, actorId: managerId }));
    const added = await run(() => addMember({ groupId: group.id, userId: blockedId, actorId: managerId }));
    const memberships = await testDb.readRows(MEMBERSHIPS_SQL, { groupId: group.id });
    const removed = await run(() => removeMember({ groupId: group.id, userId: blockedId, actorId: managerId }));

    assert.deepEqual([added, removed], [true, true]);
    assert.deepEqual(memberships, [{ user_id: blockedId, granted_by: managerId }]);
    assert.deepEqual(await testDb.readRows(MEMBERSHIPS_SQL, { groupId: group.id }), []);
    assert.deepEqual(
      (await testDb.readRows(AUDIT_SQL, { entityId: blockedId })).map((row) => [row.action, row.actor_id, row.meta]),
      ['user.group_grant', 'user.group_revoke'].map((action) => [action, managerId, { group: group.slug, groupId: group.id }]),
    );
  });

  test('says whether addMember has added the user: true the first time, false once they are a member, with nothing written; outside a request the records carry no ip and no request id', async () => {
    const rootId = await createActor([SCOPE_ALL]);
    const userId = await createUser(testDb);
    const group = await run(() => createGroup({ input: { slug: createSlug('members'), name: 'Members' }, actorId: rootId }));
    const first = await run(() => addMember({ groupId: group.id, userId, actorId: rootId }));
    const stateAdded = await readState();
    const second = await run(() => addMember({ groupId: group.id, userId, actorId: rootId }));

    assert.deepEqual([first, second], [true, false]);
    assert.deepEqual(await readState(), stateAdded);
    assert.equal(await run(() => removeMember({ groupId: group.id, userId, actorId: rootId })), true);
    assert.deepEqual(await testDb.readRows(AUDIT_SQL, { entityId: userId }), ['user.group_grant', 'user.group_revoke'].map((action) => ({
      actor_id: rootId,
      action,
      entity_type: 'users',
      entity_id: userId,
      meta: { group: group.slug, groupId: group.id },
      ip: null,
      request_id: null,
    })));
  });
});
