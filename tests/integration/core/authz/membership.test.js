import { grantMembership, revokeMembership } from '#core/authz/membership.js';
import { invalidateCacheTables } from '#core/cache/index.js';
import { withTransaction } from '#core/db/transaction.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { TABLE } from '#enums/table.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import {
  createDownDb,
  createTestDb,
  REFUSED_CONNECTION_CODE,
  SMALL_POOL,
} from '#root/tests/helper/db.js';
import { assertTypeError } from '#root/tests/helper/error.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  auditRecordOf,
  connectAppRedis,
  createUser,
  insertGroup,
  joinGroup,
  readAudit,
  readCachedMemberIds,
  readMemberships,
  readState,
  runInApp,
  runInTransaction,
  TEST_REQUEST,
} from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
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

const GRANT_REFUSAL = /^grantMembership\(\{ userId, group, actorId, request \}\) requires the UUID of a user, a group \{ id, slug \} and the UUID of the actor, or null for the system$/;
const REVOKE_REFUSAL = /^revokeMembership\(\{ userId, group, actorId, request \}\) requires the UUID of a user, a group \{ id, slug \} and the UUID of the actor, or null for the system$/;
const GRANT_TRANSACTION_REFUSAL = /^grantMembership\(\{ userId, group, actorId, request \}\) runs inside withTransaction\(\), with the record it writes$/;
const REVOKE_TRANSACTION_REFUSAL = /^revokeMembership\(\{ userId, group, actorId, request \}\) runs inside withTransaction\(\), with the record it writes$/;

// The rows a membership writes.
const STATE_TABLES = Object.freeze([TABLE.USER_GROUPS, TABLE.AUDIT_LOGS]);

let fastify = null;

function grant(membership) {
  return runInTransaction(fastify, () => grantMembership({ request: TEST_REQUEST, ...membership }));
}

function revoke(membership) {
  return runInTransaction(fastify, () => revokeMembership({ request: TEST_REQUEST, ...membership }));
}

function createUsers(names) {
  return mapSeries(names, () => createUser(fastify));
}

function membershipOf({ userId, group, grantedBy }) {
  return { user_id: userId, group_id: group.id, granted_by: grantedBy };
}

function membershipRecordOf(action, {
  userId,
  group,
  actorId,
  request,
}) {
  return auditRecordOf(action, {
    entityId: userId,
    actorId,
    meta: { group: group.slug, groupId: group.id },
    request,
  });
}

// Each wrong in one field of a call that is valid otherwise; an actorId left out is the system, not a wrong one.
function listWrongCalls({ userId, group, actorId }) {
  const id = uuidv7();
  const wrongIds = ['', 'user-1', 42, false, id.toUpperCase(), { id }, [id]];
  const wrongGroups = [
    undefined,
    null,
    group.slug,
    [group.id, group.slug],
    { id: group.id },
    { slug: group.slug },
    { id: group.slug, slug: group.slug },
    { id: group.id, slug: '' },
    { id: group.id, slug: 42 },
  ];

  return [
    undefined,
    ...[undefined, null, ...wrongIds].map((wrong) => ({ userId: wrong, group, actorId })),
    ...wrongGroups.map((wrong) => ({ userId, group: wrong, actorId })),
    ...wrongIds.map((wrong) => ({ userId, group, actorId: wrong })),
  ];
}

describe('grantMembership and revokeMembership', { skip: testRedis.skip || testDb.skip }, () => {
  before(async () => {
    await up();

    fastify = await testDb.buildApp({ db: SMALL_POOL });
    await connectAppRedis(fastify);

    // The first read of a table whose version is not there yet starts it and goes to the database, caching nothing.
    await runInApp(fastify, () => invalidateCacheTables([TABLE.USER_GROUPS]));
  });

  after(() => fastify?.close());

  test('grantMembership adds the user to the group with granted_by of the actor and a record of user.group_grant by the actor, with the group by its slug and its id and the request, and says true', async () => {
    const [userId, actorId] = await createUsers(['member', 'actor']);
    const group = await insertGroup(fastify);
    const granted = await grant({ userId, group, actorId });

    assert.equal(granted, true);
    assert.deepEqual(await readMemberships(fastify, group.id), [membershipOf({ userId, group, grantedBy: actorId })]);
    assert.deepEqual(await readAudit(fastify, userId), [membershipRecordOf(AUDIT_ACTION.USER_GROUP_GRANT, { userId, group, actorId })]);
  });

  test('revokeMembership takes the user out of the group with a record of user.group_revoke by the actor, and says true', async () => {
    const [userId, granterId, actorId] = await createUsers(['member', 'granter', 'actor']);
    const group = await insertGroup(fastify);

    await grant({ userId, group, actorId: granterId });

    const revoked = await revoke({ userId, group, actorId });

    assert.equal(revoked, true);
    assert.deepEqual(await readMemberships(fastify, group.id), []);
    assert.deepEqual(await readAudit(fastify, userId), [
      membershipRecordOf(AUDIT_ACTION.USER_GROUP_GRANT, { userId, group, actorId: granterId }),
      membershipRecordOf(AUDIT_ACTION.USER_GROUP_REVOKE, { userId, group, actorId }),
    ]);
  });

  test('revokeMembership says false and writes nothing for a user who is no member of the group: one who has left it, one who is a member of another group only, one who is no user', async () => {
    const [leftId, elsewhereId, actorId] = await createUsers(['left', 'elsewhere', 'actor']);
    const [group, other] = await mapSeries(['group', 'other'], () => insertGroup(fastify));

    await grant({ userId: leftId, group, actorId });
    await revoke({ userId: leftId, group, actorId });
    await grant({ userId: elsewhereId, group: other, actorId });

    const stateBefore = await readState(fastify, STATE_TABLES);
    const results = await mapSeries([leftId, elsewhereId, uuidv7()], (userId) => revoke({ userId, group, actorId }));

    assert.deepEqual(results, [false, false, false]);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(await readMemberships(fastify, other.id), [membershipOf({ userId: elsewhereId, group: other, grantedBy: actorId })]);
  });

  test('both write in the transaction of their caller: a rollback after them takes back the row, the deletion and the record', async () => {
    const [userId, memberId, actorId] = await createUsers(['newcomer', 'member', 'actor']);
    const group = await insertGroup(fastify);
    const failure = new Error('The caller fails after the membership is written');

    await grant({ userId: memberId, group, actorId });

    const stateBefore = await readState(fastify, STATE_TABLES);
    const errors = await mapSeries([
      () => grantMembership({
        userId,
        group,
        actorId,
        request: TEST_REQUEST,
      }),
      () => revokeMembership({
        userId: memberId,
        group,
        actorId,
        request: TEST_REQUEST,
      }),
    ], (write) => rejectionOf(runInTransaction(fastify, async () => {
      assert.equal(await write(), true);

      throw failure;
    })));

    assert.deepEqual(errors, [failure, failure]);
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
    assert.deepEqual(await readMemberships(fastify, group.id), [membershipOf({ userId: memberId, group, grantedBy: actorId })]);
  });

  // The row behind the back is written by a statement that moves no version: the cached read does not learn of it.
  test('both move the version of user_groups once their transaction commits: a cached read of the members, which a write behind its back does not reach, is read again after each and shows it', async () => {
    const [behindId, userId, actorId] = await createUsers(['behind', 'member', 'actor']);
    const group = await insertGroup(fastify);
    const cached = await readCachedMemberIds(fastify, group.id);

    await joinGroup(fastify, { userId: behindId, groupId: group.id });

    const stale = await readCachedMemberIds(fastify, group.id);

    await grant({ userId, group, actorId });

    const granted = await readCachedMemberIds(fastify, group.id);

    await revoke({ userId: behindId, group, actorId });

    assert.deepEqual([cached, stale, granted, await readCachedMemberIds(fastify, group.id)], [[], [], [behindId, userId].toSorted(), [userId]]);
  });

  test('both record the actorId they are given and null, the system, when it is null or left out, whoever the request has signed in: the record and granted_by name one actor', async () => {
    const [signedInId, plainId, requesterId] = await createUsers(['signed-in', 'plain', 'requester']);
    const group = await insertGroup(fastify);
    const signedIn = { ...TEST_REQUEST, user: { id: requesterId } };

    await grant({
      userId: signedInId,
      group,
      actorId: null,
      request: signedIn,
    });
    await runInTransaction(fastify, () => grantMembership({ userId: plainId, group }));

    assert.deepEqual(await readMemberships(fastify, group.id), [signedInId, plainId].toSorted().map((userId) => membershipOf({ userId, group, grantedBy: null })));

    await revoke({ userId: signedInId, group, request: signedIn });
    await runInTransaction(fastify, () => revokeMembership({ userId: plainId, group, actorId: null }));

    assert.deepEqual(await readMemberships(fastify, group.id), []);
    assert.deepEqual(await readAudit(fastify, signedInId), [AUDIT_ACTION.USER_GROUP_GRANT, AUDIT_ACTION.USER_GROUP_REVOKE].map((action) => membershipRecordOf(action, {
      userId: signedInId,
      group,
      actorId: null,
    })));
    assert.deepEqual(await readAudit(fastify, plainId), [AUDIT_ACTION.USER_GROUP_GRANT, AUDIT_ACTION.USER_GROUP_REVOKE].map((action) => membershipRecordOf(action, {
      userId: plainId,
      group,
      actorId: null,
      request: null,
    })));
  });

  test('both refuse a userId, a group or an actorId of the wrong kind with a TypeError before any statement: with the database down as with it up, where a transaction that commits after the refusals holds nothing of them', async (t) => {
    const down = await createDownDb(t);
    const [newcomerId, memberId, actorId] = await createUsers(['newcomer', 'member', 'actor']);
    const group = await insertGroup(fastify);

    await grant({ userId: memberId, group, actorId });

    const calls = [
      [grantMembership, GRANT_REFUSAL, listWrongCalls({ userId: newcomerId, group, actorId })],
      [revokeMembership, REVOKE_REFUSAL, listWrongCalls({ userId: memberId, group, actorId })],
    ];
    const stateBefore = await readState(fastify, STATE_TABLES);
    const downErrors = await mapSeries(calls, ([call, , wrongCalls]) => mapSeries(wrongCalls, (wrong) => rejectionOf(down.run(() => call(wrong)))));
    const upErrors = await runInTransaction(fastify, () => mapSeries(calls, ([call, , wrongCalls]) => mapSeries(wrongCalls, (wrong) => rejectionOf(call(wrong)))));
    const reached = await rejectionOf(down.run(() => withTransaction(() => grantMembership({ userId: newcomerId, group, actorId }))));

    [downErrors, upErrors].forEach((errors) => errors.forEach((byCall, index) => byCall.forEach((error) => assertTypeError(error, calls[index][1]))));
    assert.equal(reached.code, REFUSED_CONNECTION_CODE, inspect(reached));
    assert.deepEqual(await readState(fastify, STATE_TABLES), stateBefore);
  });

  test('grantMembership outside withTransaction() is refused before its statement and leaves neither the row nor a record behind', async () => {
    const [userId, actorId] = await createUsers(['member', 'actor']);
    const group = await insertGroup(fastify);
    const error = await rejectionOf(runInApp(fastify, () => grantMembership({
      userId,
      group,
      actorId,
      request: TEST_REQUEST,
    })));

    assert.ok(!(error instanceof TypeError), inspect(error));
    assert.match(error.message, GRANT_TRANSACTION_REFUSAL);
    assert.deepEqual([await readMemberships(fastify, group.id), await readAudit(fastify, userId)], [[], []]);
  });

  test('revokeMembership outside withTransaction() is refused before its statement and leaves the membership and its records as they were', async () => {
    const [userId, actorId] = await createUsers(['member', 'actor']);
    const group = await insertGroup(fastify);

    await grant({ userId, group, actorId });

    const error = await rejectionOf(runInApp(fastify, () => revokeMembership({
      userId,
      group,
      actorId,
      request: TEST_REQUEST,
    })));

    assert.ok(!(error instanceof TypeError), inspect(error));
    assert.match(error.message, REVOKE_TRANSACTION_REFUSAL);
    assert.deepEqual(
      [await readMemberships(fastify, group.id), await readAudit(fastify, userId)],
      [[membershipOf({ userId, group, grantedBy: actorId })], [membershipRecordOf(AUDIT_ACTION.USER_GROUP_GRANT, { userId, group, actorId })]],
    );
  });
});
