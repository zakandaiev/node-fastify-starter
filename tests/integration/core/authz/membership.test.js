import { grantMembership, revokeMembership } from '#core/authz/membership.js';
import { invalidateCacheTables } from '#core/cache/index.js';
import { createQuery } from '#core/db/query.js';
import { withTransaction } from '#core/db/transaction.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { TABLE } from '#enums/table.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createDownDb, createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  connectAppRedis,
  createUser,
  readAppRows,
  runInApp,
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

// Few on purpose: the files of the tests share the connections of one server.
const CONNECTION_LIMIT = 2;

// What a call records of its request in the audit.
const REQUEST = Object.freeze({ ip: '198.51.100.23', id: uuidv7() });

const GRANT_REFUSAL = /^grantMembership\(\{ userId, group, actorId, request \}\) requires the UUID of a user, a group \{ id, slug \} and the UUID of the actor, or null for the system$/;
const REVOKE_REFUSAL = /^revokeMembership\(\{ userId, group, actorId, request \}\) requires the UUID of a user, a group \{ id, slug \} and the UUID of the actor, or null for the system$/;
const GRANT_TRANSACTION_REFUSAL = /^grantMembership\(\{ userId, group, actorId, request \}\) runs inside withTransaction\(\), with the record it writes$/;
const REVOKE_TRANSACTION_REFUSAL = /^revokeMembership\(\{ userId, group, actorId, request \}\) runs inside withTransaction\(\), with the record it writes$/;
const REFUSED_CONNECTION_CODE = 'ECONNREFUSED';

const GROUP_SQL = 'INSERT INTO groups (id, slug, name) VALUES (:id, :slug, :slug)';
const JOIN_SQL = 'INSERT INTO user_groups (user_id, group_id) VALUES (:userId, :groupId)';
const MEMBERSHIPS_SQL = 'SELECT user_id, group_id, granted_by FROM user_groups WHERE group_id = :groupId ORDER BY user_id';
const MEMBER_IDS_SQL = 'SELECT user_id FROM user_groups WHERE group_id = :groupId ORDER BY user_id';
const AUDIT_SQL = `
  SELECT actor_id, action, entity_type, entity_id, meta, ip, request_id
  FROM audit_logs
  WHERE entity_id = :entityId
  ORDER BY id
`;

// The rows a membership writes: a refused call leaves each of them as it was.
const STATE_SQL = Object.freeze([
  'SELECT * FROM user_groups ORDER BY user_id, group_id',
  'SELECT * FROM audit_logs ORDER BY id',
]);

let fastify = null;

function run(fn) {
  return runInApp(fastify, fn);
}

function runInTransaction(fn) {
  return run(() => withTransaction(fn));
}

function grant(membership) {
  return runInTransaction(() => grantMembership({ request: REQUEST, ...membership }));
}

function revoke(membership) {
  return runInTransaction(() => revokeMembership({ request: REQUEST, ...membership }));
}

function createUsers(names) {
  return mapSeries(names, () => createUser(fastify));
}

async function createGroup() {
  const group = { id: uuidv7(), slug: `members-${uuidv7()}` };

  await readAppRows(fastify, GROUP_SQL, group);

  return group;
}

function readMemberships(groupId) {
  return readAppRows(fastify, MEMBERSHIPS_SQL, { groupId });
}

function readAudit(entityId) {
  return readAppRows(fastify, AUDIT_SQL, { entityId });
}

function readState() {
  return mapSeries(STATE_SQL, (sql) => readAppRows(fastify, sql));
}

// Outside a transaction, as a read of the API runs: served from the cache while the version of user_groups stays.
async function readCachedMemberIds(groupId) {
  const query = await run(() => createQuery(MEMBER_IDS_SQL, { groupId }).cache({ tables: [TABLE.USER_GROUPS] }).execute());

  return query.fetchAll().map((row) => row.userId);
}

function membershipOf({ userId, group, grantedBy }) {
  return { user_id: userId, group_id: group.id, granted_by: grantedBy };
}

function recordOf(action, {
  userId,
  group,
  actorId,
  request = REQUEST,
}) {
  return {
    actor_id: actorId,
    action,
    entity_type: TABLE.USERS,
    entity_id: userId,
    meta: { group: group.slug, groupId: group.id },
    ip: request?.ip ?? null,
    request_id: request?.id ?? null,
  };
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

function assertRefusal(error, pattern) {
  assert.ok(error instanceof TypeError, inspect(error));
  assert.match(error.message, pattern);
}

describe('grantMembership and revokeMembership', { skip: testRedis.skip || testDb.skip }, () => {
  before(async () => {
    await up();

    fastify = await testDb.buildApp({ db: { connectionLimit: CONNECTION_LIMIT } });
    await connectAppRedis(fastify);

    // The first read of a table whose version is not there yet starts it and goes to the database, caching nothing.
    await run(() => invalidateCacheTables([TABLE.USER_GROUPS]));
  });

  after(() => fastify?.close());

  test('grantMembership adds the user to the group with granted_by of the actor and a record of user.group_grant by the actor, with the group by its slug and its id and the request, and says true', async () => {
    const [userId, actorId] = await createUsers(['member', 'actor']);
    const group = await createGroup();
    const granted = await grant({ userId, group, actorId });

    assert.equal(granted, true);
    assert.deepEqual(await readMemberships(group.id), [membershipOf({ userId, group, grantedBy: actorId })]);
    assert.deepEqual(await readAudit(userId), [recordOf(AUDIT_ACTION.USER_GROUP_GRANT, { userId, group, actorId })]);
  });

  test('revokeMembership takes the user out of the group with a record of user.group_revoke by the actor, and says true', async () => {
    const [userId, granterId, actorId] = await createUsers(['member', 'granter', 'actor']);
    const group = await createGroup();

    await grant({ userId, group, actorId: granterId });

    const revoked = await revoke({ userId, group, actorId });

    assert.equal(revoked, true);
    assert.deepEqual(await readMemberships(group.id), []);
    assert.deepEqual(await readAudit(userId), [
      recordOf(AUDIT_ACTION.USER_GROUP_GRANT, { userId, group, actorId: granterId }),
      recordOf(AUDIT_ACTION.USER_GROUP_REVOKE, { userId, group, actorId }),
    ]);
  });

  test('revokeMembership says false and writes nothing for a user who is no member of the group: one who has left it, one who is a member of another group only, one who is no user', async () => {
    const [leftId, elsewhereId, actorId] = await createUsers(['left', 'elsewhere', 'actor']);
    const [group, other] = await mapSeries(['group', 'other'], () => createGroup());

    await grant({ userId: leftId, group, actorId });
    await revoke({ userId: leftId, group, actorId });
    await grant({ userId: elsewhereId, group: other, actorId });

    const stateBefore = await readState();
    const results = await mapSeries([leftId, elsewhereId, uuidv7()], (userId) => revoke({ userId, group, actorId }));

    assert.deepEqual(results, [false, false, false]);
    assert.deepEqual(await readState(), stateBefore);
    assert.deepEqual(await readMemberships(other.id), [membershipOf({ userId: elsewhereId, group: other, grantedBy: actorId })]);
  });

  test('both write in the transaction of their caller: a rollback after them takes back the row, the deletion and the record', async () => {
    const [userId, memberId, actorId] = await createUsers(['newcomer', 'member', 'actor']);
    const group = await createGroup();
    const failure = new Error('The caller fails after the membership is written');

    await grant({ userId: memberId, group, actorId });

    const stateBefore = await readState();
    const errors = await mapSeries([
      () => grantMembership({
        userId,
        group,
        actorId,
        request: REQUEST,
      }),
      () => revokeMembership({
        userId: memberId,
        group,
        actorId,
        request: REQUEST,
      }),
    ], (write) => rejectionOf(runInTransaction(async () => {
      assert.equal(await write(), true);

      throw failure;
    })));

    assert.deepEqual(errors, [failure, failure]);
    assert.deepEqual(await readState(), stateBefore);
    assert.deepEqual(await readMemberships(group.id), [membershipOf({ userId: memberId, group, grantedBy: actorId })]);
  });

  // The row behind the back is written by a statement that moves no version: the cached read does not learn of it.
  test('both move the version of user_groups once their transaction commits: a cached read of the members, which a write behind its back does not reach, is read again after each and shows it', async () => {
    const [behindId, userId, actorId] = await createUsers(['behind', 'member', 'actor']);
    const group = await createGroup();
    const cached = await readCachedMemberIds(group.id);

    await readAppRows(fastify, JOIN_SQL, { userId: behindId, groupId: group.id });

    const stale = await readCachedMemberIds(group.id);

    await grant({ userId, group, actorId });

    const granted = await readCachedMemberIds(group.id);

    await revoke({ userId: behindId, group, actorId });

    assert.deepEqual([cached, stale, granted, await readCachedMemberIds(group.id)], [[], [], [behindId, userId].toSorted(), [userId]]);
  });

  test('both record the actorId they are given and null, the system, when it is null or left out, whoever the request has signed in: the record and granted_by name one actor', async () => {
    const [signedInId, plainId, requesterId] = await createUsers(['signed-in', 'plain', 'requester']);
    const group = await createGroup();
    const signedIn = { ...REQUEST, user: { id: requesterId } };

    await grant({
      userId: signedInId,
      group,
      actorId: null,
      request: signedIn,
    });
    await runInTransaction(() => grantMembership({ userId: plainId, group }));

    assert.deepEqual(await readMemberships(group.id), [signedInId, plainId].toSorted().map((userId) => membershipOf({ userId, group, grantedBy: null })));

    await revoke({ userId: signedInId, group, request: signedIn });
    await runInTransaction(() => revokeMembership({ userId: plainId, group, actorId: null }));

    assert.deepEqual(await readMemberships(group.id), []);
    assert.deepEqual(await readAudit(signedInId), [AUDIT_ACTION.USER_GROUP_GRANT, AUDIT_ACTION.USER_GROUP_REVOKE].map((action) => recordOf(action, {
      userId: signedInId,
      group,
      actorId: null,
    })));
    assert.deepEqual(await readAudit(plainId), [AUDIT_ACTION.USER_GROUP_GRANT, AUDIT_ACTION.USER_GROUP_REVOKE].map((action) => recordOf(action, {
      userId: plainId,
      group,
      actorId: null,
      request: null,
    })));
  });

  test('both refuse a userId, a group or an actorId of the wrong kind with a TypeError before any statement: with the database down as with it up, where a transaction that commits after the refusals holds nothing of them', async (t) => {
    const down = await createDownDb(t);
    const [newcomerId, memberId, actorId] = await createUsers(['newcomer', 'member', 'actor']);
    const group = await createGroup();

    await grant({ userId: memberId, group, actorId });

    const calls = [
      [grantMembership, GRANT_REFUSAL, listWrongCalls({ userId: newcomerId, group, actorId })],
      [revokeMembership, REVOKE_REFUSAL, listWrongCalls({ userId: memberId, group, actorId })],
    ];
    const stateBefore = await readState();
    const downErrors = await mapSeries(calls, ([call, , wrongCalls]) => mapSeries(wrongCalls, (wrong) => rejectionOf(down.run(() => call(wrong)))));
    const upErrors = await runInTransaction(() => mapSeries(calls, ([call, , wrongCalls]) => mapSeries(wrongCalls, (wrong) => rejectionOf(call(wrong)))));
    const reached = await rejectionOf(down.run(() => withTransaction(() => grantMembership({ userId: newcomerId, group, actorId }))));

    [downErrors, upErrors].forEach((errors) => errors.forEach((byCall, index) => {
      assert.equal(byCall.length, calls[index][2].length);
      byCall.forEach((error) => assertRefusal(error, calls[index][1]));
    }));
    assert.equal(reached.code, REFUSED_CONNECTION_CODE, inspect(reached));
    assert.deepEqual(await readState(), stateBefore);
  });

  test('grantMembership outside withTransaction() is refused before its statement and leaves neither the row nor a record behind', async () => {
    const [userId, actorId] = await createUsers(['member', 'actor']);
    const group = await createGroup();
    const error = await rejectionOf(run(() => grantMembership({
      userId,
      group,
      actorId,
      request: REQUEST,
    })));

    assert.ok(!(error instanceof TypeError), inspect(error));
    assert.match(error.message, GRANT_TRANSACTION_REFUSAL);
    assert.deepEqual([await readMemberships(group.id), await readAudit(userId)], [[], []]);
  });

  test('revokeMembership outside withTransaction() is refused before its statement and leaves the membership and its records as they were', async () => {
    const [userId, actorId] = await createUsers(['member', 'actor']);
    const group = await createGroup();

    await grant({ userId, group, actorId });

    const error = await rejectionOf(run(() => revokeMembership({
      userId,
      group,
      actorId,
      request: REQUEST,
    })));

    assert.ok(!(error instanceof TypeError), inspect(error));
    assert.match(error.message, REVOKE_TRANSACTION_REFUSAL);
    assert.deepEqual(
      [await readMemberships(group.id), await readAudit(userId)],
      [[membershipOf({ userId, group, grantedBy: actorId })], [recordOf(AUDIT_ACTION.USER_GROUP_GRANT, { userId, group, actorId })]],
    );
  });
});
