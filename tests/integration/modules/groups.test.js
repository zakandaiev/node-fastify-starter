import { lockUsers } from '#core/auth/user.js';
import { withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { SCOPE, SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import {
  addMember,
  assertAdminGroupsKept,
  createGroup,
  removeGroup,
  removeMember,
  updateGroup,
} from '#modules/groups/groups.service.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createDownDb, createTestDb, REFUSED_CONNECTION_CODE } from '#root/tests/helper/db.js';
import { assertAppError, assertTypeError, REFUSAL } from '#root/tests/helper/error.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import {
  auditRecordOf,
  createActor,
  createUser,
  grantScopes,
  insertGroup,
  joinGroup,
  readAdminId,
  readAudit,
  readMemberships,
  readState,
  readUnlockedIds,
  runInTransaction,
} from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const ACTOR_REFUSAL = /requires the UUID of the actor/;
const SCOPES_REFUSAL = /requires scopes to be distinct codes of the scope catalog in src\/enums\/scope\.js/;
const FIELDS_REFUSAL = /requires the fields of the group/;

const LONG_AGO = '2026-01-01T00:00:00.000Z';

const LEAVE_SQL = 'DELETE FROM user_groups WHERE user_id = :userId AND group_id = :groupId';
const STATUS_SQL = 'UPDATE users SET status = :status WHERE id = :id';
const GROUP_ROW_SQL = 'SELECT id, is_system, created_at FROM groups WHERE id = :id';
// The rows a change of groups writes.
const STATE_TABLES = Object.freeze([TABLE.GROUPS, TABLE.GROUP_SCOPES, TABLE.USER_GROUPS, TABLE.AUDIT_LOGS]);

const WRONG_SCOPES = Object.freeze([
  [SCOPE_ALL],
  ['users:write'],
  [SCOPE.USERS_READ, SCOPE.USERS_READ],
  [null],
  SCOPE.USERS_READ,
]);

async function readGroupRow(id) {
  const [row = null] = await testDb.readRows(GROUP_ROW_SQL, { id });

  return row;
}

function createSlug(word) {
  return `${word}-${uuidv7()}`;
}

describe('the service of groups', { skip: testDb.skip }, () => {
  before(async () => {
    await up();
    await up({ type: MIGRATION_TYPE.SEED });
  });

  test('refuses with a TypeError an actor id that is no UUID, and the actor of a token in its place, in every call that changes groups, and writes nothing', async () => {
    const rootId = await createActor(testDb, [SCOPE_ALL]);
    const userId = await createUser(testDb);
    const group = await testDb.run(() => createGroup({ input: { slug: createSlug('kept'), name: 'Kept' }, actorId: rootId }));
    const actorIds = [undefined, null, '', 'admin', 42, { id: rootId }, [rootId]];
    const callers = [...actorIds.map((actorId) => ({ actorId })), { actor: { id: rootId, scopes: [SCOPE_ALL] } }];
    const calls = callers.flatMap((caller) => [
      () => createGroup({ input: { slug: createSlug('refused'), name: 'Refused' }, ...caller }),
      () => updateGroup({ id: group.id, input: { name: 'Refused' }, ...caller }),
      () => removeGroup({ id: group.id, ...caller }),
      () => addMember({ groupId: group.id, userId, ...caller }),
      () => removeMember({ groupId: group.id, userId, ...caller }),
    ]);
    const stateBefore = await readState(testDb, STATE_TABLES);
    const errors = await mapSeries(calls, (call) => rejectionOf(testDb.run(call)));

    errors.forEach((error) => assertTypeError(error, ACTOR_REFUSAL));
    assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
  });

  test('refuses with a TypeError scopes that are no distinct codes of the catalog, * among them, and fields that are no object, which a route stops by its schema first, and writes nothing', async () => {
    const rootId = await createActor(testDb, [SCOPE_ALL]);
    const group = await testDb.run(() => createGroup({ input: { slug: createSlug('scoped'), name: 'Scoped' }, actorId: rootId }));
    const stateBefore = await readState(testDb, STATE_TABLES);
    const created = await mapSeries(WRONG_SCOPES, (scopes) => rejectionOf(testDb.run(() => createGroup({
      input: { slug: createSlug('refused'), name: 'Refused', scopes },
      actorId: rootId,
    }))));
    const updated = await mapSeries(WRONG_SCOPES, (scopes) => rejectionOf(testDb.run(() => updateGroup({ id: group.id, input: { scopes }, actorId: rootId }))));

    [...created, ...updated].forEach((error) => assertTypeError(error, SCOPES_REFUSAL));
    assertTypeError(await rejectionOf(testDb.run(() => createGroup({ input: 'Refused', actorId: rootId }))), FIELDS_REFUSAL);
    assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
  });

  test('writes no field of a group but those of its body: an id, isSystem and the times a caller passes are left alone', async () => {
    const rootId = await createActor(testDb, [SCOPE_ALL]);
    const [givenId, otherId] = [uuidv7(), uuidv7()];
    const created = await testDb.run(() => createGroup({
      input: {
        id: givenId,
        slug: createSlug('plain'),
        name: 'Plain',
        isSystem: true,
        createdAt: LONG_AGO,
      },
      actorId: rootId,
    }));
    const updated = await testDb.run(() => updateGroup({
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
    const group = await testDb.run(() => createGroup({ input: { slug: createSlug('managed'), name: 'Managed' }, actorId: managerId }));

    assert.equal(await testDb.run(() => addMember({ groupId: group.id, userId: memberId, actorId: managerId })), true);
    await testDb.readRows(LEAVE_SQL, { userId: managerId, groupId: powerId });

    const calls = [managerId, uuidv7()].flatMap((actorId) => [
      () => createGroup({ input: { slug: createSlug('refused'), name: 'Refused' }, actorId }),
      () => updateGroup({ id: group.id, input: { name: 'Refused' }, actorId }),
      () => removeGroup({ id: group.id, actorId }),
      () => addMember({ groupId: group.id, userId: otherId, actorId }),
      () => removeMember({ groupId: group.id, userId: memberId, actorId }),
    ]);
    const stateBefore = await readState(testDb, STATE_TABLES);
    const errors = await mapSeries(calls, (call) => rejectionOf(testDb.run(call)));

    errors.forEach((error) => assertAppError(error, REFUSAL.FORBIDDEN));
    assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);

    const fields = { slug: createSlug('full'), name: 'Full', isSuperadmin: true };

    assertAppError(await rejectionOf(testDb.run(() => createGroup({ input: fields, actorId: promotedId }))), REFUSAL.FORBIDDEN);
    await joinGroup(testDb, { userId: promotedId, groupId: await readAdminId(testDb) });

    const full = await testDb.run(() => createGroup({ input: fields, actorId: promotedId }));

    assert.deepEqual([full.slug, full.isSuperadmin], [fields.slug, true]);
  });

  // Blocked by hand, as a token that is still alive meets it: the database still grants the actor full access.
  test('refuses with 403 every change by an actor who is blocked, though their groups grant them full access, and writes nothing; the same actor active again may change groups', async () => {
    const [rootId, blockedId] = await mapSeries(['root', 'blocked'], () => createActor(testDb, [SCOPE_ALL]));
    const [memberId, otherId] = await mapSeries(['member', 'other'], () => createUser(testDb));
    const group = await testDb.run(() => createGroup({ input: { slug: createSlug('held'), name: 'Held' }, actorId: rootId }));

    assert.equal(await testDb.run(() => addMember({ groupId: group.id, userId: memberId, actorId: blockedId })), true);
    await testDb.readRows(STATUS_SQL, { id: blockedId, status: USER_STATUS.BLOCKED });

    const calls = [
      () => createGroup({ input: { slug: createSlug('refused'), name: 'Refused' }, actorId: blockedId }),
      () => updateGroup({ id: group.id, input: { name: 'Refused' }, actorId: blockedId }),
      () => removeGroup({ id: group.id, actorId: blockedId }),
      () => addMember({ groupId: group.id, userId: otherId, actorId: blockedId }),
      () => removeMember({ groupId: group.id, userId: memberId, actorId: blockedId }),
    ];
    const stateBefore = await readState(testDb, STATE_TABLES);
    const errors = await mapSeries(calls, (call) => rejectionOf(testDb.run(call)));

    errors.forEach((error) => assertAppError(error, REFUSAL.FORBIDDEN));
    assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);

    await testDb.readRows(STATUS_SQL, { id: blockedId, status: USER_STATUS.ACTIVE });

    const renamed = await testDb.run(() => updateGroup({ id: group.id, input: { name: 'Renamed' }, actorId: blockedId }));

    assert.equal(renamed.name, 'Renamed');
  });

  test('lets an active manager add a blocked user to a group and take them out again: true each, granted_by and both records name the manager', async () => {
    const managerId = await createActor(testDb, [SCOPE.GROUPS_MANAGE]);
    const blockedId = await createUser(testDb, { status: USER_STATUS.BLOCKED });
    const group = await testDb.run(() => createGroup({ input: { slug: createSlug('blocked'), name: 'Blocked' }, actorId: managerId }));
    const added = await testDb.run(() => addMember({ groupId: group.id, userId: blockedId, actorId: managerId }));
    const memberships = await readMemberships(testDb, group.id);
    const removed = await testDb.run(() => removeMember({ groupId: group.id, userId: blockedId, actorId: managerId }));

    assert.deepEqual([added, removed], [true, true]);
    assert.deepEqual(memberships, [{ user_id: blockedId, group_id: group.id, granted_by: managerId }]);
    assert.deepEqual(await readMemberships(testDb, group.id), []);
    assert.deepEqual(
      (await readAudit(testDb, blockedId)).map((row) => [row.action, row.actor_id, row.meta]),
      ['user.group_grant', 'user.group_revoke'].map((action) => [action, managerId, { group: group.slug, groupId: group.id }]),
    );
  });

  test('says whether addMember has added the user: true the first time, false once they are a member, with nothing written; outside a request the records carry no ip and no request id', async () => {
    const rootId = await createActor(testDb, [SCOPE_ALL]);
    const userId = await createUser(testDb);
    const group = await testDb.run(() => createGroup({ input: { slug: createSlug('members'), name: 'Members' }, actorId: rootId }));
    const first = await testDb.run(() => addMember({ groupId: group.id, userId, actorId: rootId }));
    const stateAdded = await readState(testDb, STATE_TABLES);
    const second = await testDb.run(() => addMember({ groupId: group.id, userId, actorId: rootId }));

    assert.deepEqual([first, second], [true, false]);
    assert.deepEqual(await readState(testDb, STATE_TABLES), stateAdded);
    assert.equal(await testDb.run(() => removeMember({ groupId: group.id, userId, actorId: rootId })), true);
    assert.deepEqual(await readAudit(testDb, userId), ['user.group_grant', 'user.group_revoke'].map((action) => auditRecordOf(action, {
      entityId: userId,
      actorId: rootId,
      meta: { group: group.slug, groupId: group.id },
      request: null,
    })));
  });
});

const KEPT_MEMBER_REFUSAL = /^assertAdminGroupsKept\(member\) requires the locked row of a user \{ id, status \}$/;
const KEPT_TRANSACTION_REFUSAL = /^assertAdminGroupsKept\(member\) runs inside withTransaction\(\), with the write it guards$/;

// Only a group of the system with full access is guarded: each other kind lacks one of the two flags or both.
const GROUP_KIND = Object.freeze({
  GUARDED: Object.freeze({ isSuperadmin: true, isSystem: true }),
  SYSTEM: Object.freeze({ isSuperadmin: false, isSystem: true }),
  FULL: Object.freeze({ isSuperadmin: true, isSystem: false }),
  PLAIN: Object.freeze({ isSuperadmin: false, isSystem: false }),
});

async function insertGroupOf(kind) {
  const { id } = await insertGroup(testDb, kind);

  return id;
}

// As a block and a deletion call it: with the row of the user locked first, in the same transaction.
function checkKept(userId) {
  return runInTransaction(testDb, async () => {
    const [member] = await lockUsers([userId]);

    return assertAdminGroupsKept(member);
  });
}

describe('assertAdminGroupsKept', { skip: testDb.skip }, () => {
  before(async () => {
    await up();
    await up({ type: MIGRATION_TYPE.SEED });
  });

  test('refuses with a TypeError a member that is no row with the UUID of a user, inside withTransaction() and outside it, before any statement', async (t) => {
    const down = await createDownDb(t);
    const id = uuidv7();
    const wrongMembers = [
      undefined,
      null,
      id,
      [{ id, status: USER_STATUS.ACTIVE }],
      {},
      { status: USER_STATUS.ACTIVE },
      { id: '', status: USER_STATUS.ACTIVE },
      { id: 'user-1', status: USER_STATUS.ACTIVE },
      { id: 42, status: USER_STATUS.ACTIVE },
      { id: id.toUpperCase(), status: USER_STATUS.ACTIVE },
      { userId: id, status: USER_STATUS.ACTIVE },
    ];
    const outside = await mapSeries(wrongMembers, (member) => rejectionOf(testDb.run(() => assertAdminGroupsKept(member))));
    const inside = await runInTransaction(testDb, () => mapSeries(wrongMembers, (member) => rejectionOf(assertAdminGroupsKept(member))));
    const downErrors = await mapSeries(wrongMembers, (member) => rejectionOf(down.run(() => assertAdminGroupsKept(member))));
    const reached = await rejectionOf(down.run(() => withTransaction(() => assertAdminGroupsKept({ id, status: USER_STATUS.ACTIVE }))));

    [outside, inside, downErrors].forEach((errors) => errors.forEach((error) => assertTypeError(error, KEPT_MEMBER_REFUSAL)));
    assert.equal(reached.code, REFUSED_CONNECTION_CODE, reached);
  });

  test('refuses outside withTransaction() with an Error that is no TypeError, before any statement, both a member it passes inside a transaction and one it stops there', async (t) => {
    const down = await createDownDb(t);
    const [freeId, lastId] = await mapSeries(['free', 'last'], () => createUser(testDb));
    const groupId = await insertGroupOf(GROUP_KIND.GUARDED);

    await joinGroup(testDb, { userId: lastId, groupId });

    const members = [freeId, lastId].map((id) => ({ id, status: USER_STATUS.ACTIVE }));
    const errors = [
      ...await mapSeries(members, (member) => rejectionOf(testDb.run(() => assertAdminGroupsKept(member)))),
      ...await mapSeries(members, (member) => rejectionOf(down.run(() => assertAdminGroupsKept(member)))),
    ];

    errors.forEach((error) => {
      assert.ok(!(error instanceof TypeError) && !(error instanceof AppError), error);
      assert.match(error.message, KEPT_TRANSACTION_REFUSAL);
    });
    assert.equal(await checkKept(freeId), true);
    assertAppError(await rejectionOf(checkKept(lastId)), REFUSAL.PROTECTED);
  });

  test('passes a user who is the only active member of groups that are not guarded, and writes nothing: in no group, in a plain group, in a group of the system without full access and in a group with full access that is not of the system', async () => {
    const [loneId, memberId] = await mapSeries(['lone', 'member'], () => createUser(testDb));
    const groupIds = await mapSeries([GROUP_KIND.PLAIN, GROUP_KIND.SYSTEM, GROUP_KIND.FULL], (kind) => insertGroupOf(kind));

    await mapSeries(groupIds, (groupId) => joinGroup(testDb, { userId: memberId, groupId }));

    const stateBefore = await readState(testDb, STATE_TABLES);

    assert.deepEqual(await mapSeries([loneId, memberId], (id) => checkKept(id)), [true, true]);
    assert.deepEqual(await readState(testDb, STATE_TABLES), stateBefore);
  });

  test('throws GROUP_PROTECTED, and writes nothing, for the last active member of a group of the system with full access, in each such group they are in, and passes a blocked member of it and each of two active members', async () => {
    const [groupId, otherGroupId] = await mapSeries(['first', 'other'], () => insertGroupOf(GROUP_KIND.GUARDED));
    const [lastId, secondId] = await mapSeries(['last', 'second'], () => createUser(testDb));
    const blockedId = await createUser(testDb, { status: USER_STATUS.BLOCKED });

    await mapSeries([lastId, blockedId], (userId) => joinGroup(testDb, { userId, groupId }));

    const stateBefore = await readState(testDb, STATE_TABLES);
    const lastError = await rejectionOf(checkKept(lastId));
    const stateAfter = await readState(testDb, STATE_TABLES);
    const isBlockedPassed = await checkKept(blockedId);

    await joinGroup(testDb, { userId: secondId, groupId });

    const arePairPassed = await mapSeries([lastId, secondId], (id) => checkKept(id));

    await joinGroup(testDb, { userId: lastId, groupId: otherGroupId });

    const otherError = await rejectionOf(checkKept(lastId));

    assertAppError(lastError, REFUSAL.PROTECTED);
    assert.deepEqual(stateAfter, stateBefore);
    assert.equal(isBlockedPassed, true);
    assert.deepEqual(arePairPassed, [true, true]);
    assertAppError(otherError, REFUSAL.PROTECTED);
    assert.equal(await checkKept(secondId), true);
  });

  test('holds the row of each guarded group of the member locked until its transaction ends, and no other row of groups: another transaction reads past that row meanwhile', async (t) => {
    const keeper = await testDb.openKeeper(t);
    const [memberId, otherId] = await mapSeries(['member', 'other'], () => createUser(testDb));
    const groupIds = await mapSeries([GROUP_KIND.GUARDED, GROUP_KIND.SYSTEM, GROUP_KIND.FULL, GROUP_KIND.PLAIN], (kind) => insertGroupOf(kind));
    const [guardedId, ...unguardedIds] = groupIds;
    const checked = Promise.withResolvers();
    const released = Promise.withResolvers();

    await mapSeries(groupIds, (groupId) => joinGroup(testDb, { userId: memberId, groupId }));
    await joinGroup(testDb, { userId: otherId, groupId: guardedId });

    const running = runInTransaction(testDb, async () => {
      const [member] = await lockUsers([memberId]);
      const isPassed = await assertAdminGroupsKept(member);

      checked.resolve();
      await released.promise;

      return isPassed;
    });

    t.after(() => released.resolve());
    await Promise.race([checked.promise, running]);

    const unlockedMeanwhile = await readUnlockedIds(keeper, TABLE.GROUPS, groupIds);

    released.resolve();

    const isKept = await running;
    const unlockedAfter = await readUnlockedIds(keeper, TABLE.GROUPS, groupIds);

    assert.equal(isKept, true);
    assert.deepEqual(unlockedMeanwhile, unguardedIds.toSorted());
    assert.deepEqual(unlockedAfter, groupIds.toSorted());
  });
});
