import {
  ACCOUNT_FIELDS,
  assertActiveUser,
  assertOtherUser,
  lockAccount,
  lockActorAndUser,
  lockUsers,
} from '#core/auth/user.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { appErrorOf, REFUSAL, typeErrorOf } from '#root/tests/helper/error.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import {
  insertUser,
  readUnlockedIds,
  runInApp,
  runInTransaction,
} from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { parseStrictUtc } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { inspect } from 'node:util';

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const LOCKED_FIELDS = Object.freeze(['id', 'email', 'emailVerifiedAt', 'firstName', 'lastName', 'avatarKey', 'status']);

const VERIFIED_AT = parseStrictUtc('2026-11-01T10:00:00.000Z');

const PAIR_SIGNATURE = 'lockActorAndUser({ actorId, userId })';
const OTHER_SIGNATURE = 'assertOtherUser(actorId, userId)';
const CALLER_SIGNATURE = 'blockUser({ id, actorId, request })';
const USER_IDS_REFUSAL = 'lockUsers(userIds) requires a non-empty list of the UUIDs of users';
const ACCOUNT_ID_REFUSAL = 'lockAccount(userId) requires the UUID of a user';
const ACTOR_ID_REFUSAL = `${PAIR_SIGNATURE} requires the UUID of the actor`;
const PAIR_USER_ID_REFUSAL = `${PAIR_SIGNATURE} requires the UUID of a user`;
const LOCK_OUTSIDE_TRANSACTION = Object.freeze({
  name: 'Error',
  message: 'lockUsers(userIds) runs inside withTransaction(): the lock lasts as long as the transaction',
});

const DELETE_USER_SQL = 'DELETE FROM users WHERE id = :id';

const UNAUTHENTICATED = appErrorOf(REFUSAL.UNAUTHENTICATED);
const FORBIDDEN = appErrorOf(REFUSAL.FORBIDDEN);
const NOT_FOUND = appErrorOf(REFUSAL.NOT_FOUND);

// A user with these fields, and the row a lock of theirs gives.
async function insertLockedUser(fields = {}) {
  const row = {
    email: null,
    emailVerifiedAt: null,
    firstName: null,
    lastName: null,
    avatarKey: null,
    status: USER_STATUS.ACTIVE,
    ...fields,
  };

  return { id: await insertUser(testDb, row), ...row };
}

async function insertGoneUser() {
  const id = await insertUser(testDb);

  await testDb.readRows(DELETE_USER_SQL, { id });

  return id;
}

function lockUsersInTransaction(userIds) {
  return runInTransaction(testDb, () => lockUsers(userIds));
}

function lockAccountInTransaction(userId) {
  return runInTransaction(testDb, () => lockAccount(userId));
}

function lockPairInTransaction(pair) {
  return runInTransaction(testDb, () => lockActorAndUser(pair));
}

// Each wrong in one id of a call that is valid otherwise, with the message of its refusal. A call with no argument
// misses the id of the actor first.
function listWrongPairs() {
  const id = uuidv7();
  const wrongIds = [undefined, null, '', 'user-1', 42, id.toUpperCase(), { id }, [id]];

  return [
    [undefined, ACTOR_ID_REFUSAL],
    [{}, ACTOR_ID_REFUSAL],
    ...wrongIds.flatMap((wrong) => [
      [{ actorId: wrong, userId: id }, ACTOR_ID_REFUSAL],
      [{ actorId: id, userId: wrong }, PAIR_USER_ID_REFUSAL],
    ]),
  ];
}

describe('ACCOUNT_FIELDS', () => {
  test('names, frozen, the fields of a locked row in the order of its columns: the id, the email, when it was verified, the names, the key of the avatar and the status', () => {
    assert.deepEqual(ACCOUNT_FIELDS, LOCKED_FIELDS);
    assert.equal(Object.isFrozen(ACCOUNT_FIELDS), true);
  });
});

describe('assertActiveUser', () => {
  test('gives back the row of an active user, the same object', () => {
    const user = { id: uuidv7(), status: USER_STATUS.ACTIVE };

    assert.equal(assertActiveUser(user), user);
  });

  test('refuses with AUTHORIZATION_ERROR a blocked user, one who is not there and what has no status of an active user', () => {
    const id = uuidv7();
    const refused = [
      { id, status: USER_STATUS.BLOCKED },
      null,
      undefined,
      {},
      { id },
      { id, status: USER_STATUS.ACTIVE.toUpperCase() },
      USER_STATUS.ACTIVE,
    ];

    refused.forEach((user) => assert.throws(() => assertActiveUser(user), FORBIDDEN, inspect(user)));
  });
});

describe('assertOtherUser', () => {
  test('refuses with AUTHORIZATION_ERROR an actor who is the user, and says true for an actor who is another', () => {
    const [actorId, userId] = [uuidv7(), uuidv7()];

    assert.throws(() => assertOtherUser(actorId, actorId), FORBIDDEN);
    assert.throws(() => assertOtherUser(actorId, actorId, CALLER_SIGNATURE), FORBIDDEN);
    assert.deepEqual([assertOtherUser(actorId, userId), assertOtherUser(userId, actorId)], [true, true]);
  });

  test('refuses with a TypeError an actor id or a user id that is no UUID, under its own signature or the one it is given, before it compares the two: also when both are the same', () => {
    const id = uuidv7();
    const wrongIds = [{ id }, id.toUpperCase(), null, 42, undefined];
    const signatures = [[undefined, OTHER_SIGNATURE], [CALLER_SIGNATURE, CALLER_SIGNATURE]];

    signatures.forEach(([given, named]) => wrongIds.forEach((wrong) => {
      assert.throws(() => assertOtherUser(wrong, id, given), typeErrorOf(`${named} requires the UUID of the actor`), inspect(wrong));
      assert.throws(() => assertOtherUser(id, wrong, given), typeErrorOf(`${named} requires the UUID of a user`), inspect(wrong));
      assert.throws(() => assertOtherUser(wrong, wrong, given), typeErrorOf(`${named} requires the UUID of the actor`), inspect(wrong));
    }));
  });
});

describe('lockUsers', { skip: testDb.skip }, () => {
  before(() => up());

  test('refuses an empty list, an id that is no UUID and what is no list with a TypeError, before it looks for a transaction', async () => {
    const lists = [[], ['user-1'], [uuidv7(), uuidv7().toUpperCase()], [uuidv7(), null], uuidv7(), new Set([uuidv7()]), null, undefined];

    await Promise.all(lists.map((userIds) => assert.rejects(runInApp(testDb, () => lockUsers(userIds)), typeErrorOf(USER_IDS_REFUSAL), inspect(userIds))));
  });

  test('throws outside withTransaction(): a lock taken there would end with its own statement', async () => {
    const userId = await insertUser(testDb);

    await assert.rejects(runInApp(testDb, () => lockUsers([userId])), LOCK_OUTSIDE_TRANSACTION);
  });

  test('gives the rows in the order of the key whatever the order of the ids, a user named twice once, and nothing for an id that is no user', async () => {
    const keyOrder = (await Promise.all([insertUser(testDb), insertUser(testDb), insertUser(testDb)])).toSorted();
    const [first, second, third] = keyOrder;
    const shuffled = await lockUsersInTransaction([third, uuidv7(), first, third, second]);
    const reversed = await lockUsersInTransaction(keyOrder.toReversed());

    assert.deepEqual(shuffled.map((row) => row.id), keyOrder);
    assert.deepEqual(reversed.map((row) => row.id), keyOrder);
    assert.deepEqual(await lockUsersInTransaction([uuidv7()]), []);
  });

  test('gives of each user the fields of ACCOUNT_FIELDS as the row holds them, and judges nobody: a blocked user is among the rows', async () => {
    const active = await insertLockedUser({
      email: 'locked@example.com',
      emailVerifiedAt: VERIFIED_AT,
      firstName: 'Anna',
      lastName: 'Kovalenko',
      avatarKey: `${uuidv7()}.webp`,
    });
    const blocked = await insertLockedUser({ status: USER_STATUS.BLOCKED });
    const rows = await lockUsersInTransaction([blocked.id, active.id]);

    assert.deepEqual(rows.map((row) => Object.keys(row)), [ACCOUNT_FIELDS, ACCOUNT_FIELDS]);
    assert.deepEqual(rows, [active, blocked]);
    assert.ok(rows[0].emailVerifiedAt instanceof Date);
  });

  test('holds the rows locked until its transaction ends: another session passes over them meanwhile and takes them after', async (t) => {
    const keeper = await testDb.openKeeper(t);
    const [lockedId, freeId] = await Promise.all([insertUser(testDb), insertUser(testDb)]);
    const seen = await runInTransaction(testDb, async () => {
      await lockUsers([lockedId]);

      return readUnlockedIds(keeper, TABLE.USERS, [lockedId, freeId]);
    });

    assert.deepEqual(seen, [freeId]);
    assert.deepEqual(await readUnlockedIds(keeper, TABLE.USERS, [lockedId, freeId]), [lockedId, freeId]);
  });
});

describe('lockAccount', { skip: testDb.skip }, () => {
  before(() => up());

  test('refuses an id that is no UUID with a TypeError, before it looks for a transaction', async () => {
    const ids = ['user-1', uuidv7().toUpperCase(), [uuidv7()], null, undefined];

    await Promise.all(ids.map((userId) => assert.rejects(runInApp(testDb, () => lockAccount(userId)), typeErrorOf(ACCOUNT_ID_REFUSAL), inspect(userId))));
    await assert.rejects(runInApp(testDb, () => lockAccount(uuidv7())), { name: 'Error', message: /runs inside withTransaction\(\)/ });
  });

  test('refuses a user who is not there with AUTHENTICATION_ERROR, and a blocked one with AUTHORIZATION_ERROR', async () => {
    const blockedId = await insertUser(testDb, { email: 'blocked.account@example.com', emailVerifiedAt: VERIFIED_AT, status: USER_STATUS.BLOCKED });

    await assert.rejects(lockAccountInTransaction(uuidv7()), UNAUTHENTICATED);
    await assert.rejects(lockAccountInTransaction(blockedId), FORBIDDEN);
  });

  test('gives the row of an active user, with the fields of lockUsers()', async () => {
    const user = await insertLockedUser({
      email: 'account@example.com',
      emailVerifiedAt: VERIFIED_AT,
      firstName: 'Olha',
      lastName: 'Shevchenko',
    });
    const account = await lockAccountInTransaction(user.id);

    assert.deepEqual(Object.keys(account), ACCOUNT_FIELDS);
    assert.deepEqual(account, user);
    assert.equal(account.status, USER_STATUS.ACTIVE);
  });
});

describe('lockActorAndUser', { skip: testDb.skip }, () => {
  before(() => up());

  test('refuses with a TypeError an actor id or a user id that is no UUID, before any statement and before it looks for a transaction: outside any context as inside a transaction', async () => {
    const pairs = listWrongPairs();

    await mapSeries(pairs, ([pair, message]) => assert.rejects(lockActorAndUser(pair), typeErrorOf(message), inspect(pair)));
    await mapSeries(pairs, ([pair, message]) => assert.rejects(runInTransaction(testDb, () => lockActorAndUser(pair)), typeErrorOf(message), inspect(pair)));
  });

  test('throws outside withTransaction(), before its statement', async () => {
    const [actorId, userId] = await mapSeries(['actor', 'user'], () => insertUser(testDb));

    await assert.rejects(runInApp(testDb, () => lockActorAndUser({ actorId, userId })), LOCK_OUTSIDE_TRANSACTION);
  });

  test('gives the row of the actor and that of the user with the fields of ACCOUNT_FIELDS, whichever of them comes first in the key', async () => {
    const [anna, olha] = await mapSeries([
      { email: 'anna.pair@example.com', emailVerifiedAt: VERIFIED_AT, firstName: 'Anna' },
      { email: 'olha.pair@example.com', lastName: 'Kovalenko' },
    ], (fields) => insertLockedUser(fields));
    const forward = await lockPairInTransaction({ actorId: anna.id, userId: olha.id });
    const backward = await lockPairInTransaction({ actorId: olha.id, userId: anna.id });

    assert.deepEqual(forward, { actor: anna, user: olha });
    assert.deepEqual(backward, { actor: olha, user: anna });
    assert.deepEqual([Object.keys(forward.actor), Object.keys(forward.user)], [ACCOUNT_FIELDS, ACCOUNT_FIELDS]);
  });

  test('judges nobody: a blocked actor and a blocked user are given as their rows, and an actor who is the user as that user', async () => {
    const [actor, user] = await mapSeries(['actor', 'user'], () => insertLockedUser({ status: USER_STATUS.BLOCKED }));

    assert.deepEqual(await lockPairInTransaction({ actorId: actor.id, userId: user.id }), { actor, user });
    assert.deepEqual(await lockPairInTransaction({ actorId: user.id, userId: user.id }), { actor: user, user });
  });

  test('gives null for an actor who is there no more, beside the row of the user', async () => {
    const user = await insertLockedUser({ firstName: 'Taras' });
    const actorIds = [await insertGoneUser(), uuidv7()];

    assert.deepEqual(
      await mapSeries(actorIds, (actorId) => lockPairInTransaction({ actorId, userId: user.id })),
      actorIds.map(() => ({ actor: null, user })),
    );
  });

  test('refuses with NOT_FOUND_ERROR a user who is not there, whoever the actor is: one who is there, one whose row is gone and an id of nobody', async () => {
    const actorIds = [await insertUser(testDb), await insertGoneUser(), uuidv7()];
    const userIds = [await insertGoneUser(), uuidv7()];
    const pairs = userIds.flatMap((userId) => actorIds.map((actorId) => ({ actorId, userId })));

    await mapSeries(pairs, (pair) => assert.rejects(lockPairInTransaction(pair), NOT_FOUND, inspect(pair)));
  });

  test('holds both rows locked until its transaction ends: another session passes over them meanwhile and takes them after', async (t) => {
    const keeper = await testDb.openKeeper(t);
    const [actorId, userId, freeId] = await mapSeries(['actor', 'user', 'free'], () => insertUser(testDb));
    const ids = [actorId, userId, freeId];
    const seen = await runInTransaction(testDb, async () => {
      await lockActorAndUser({ actorId, userId });

      return readUnlockedIds(keeper, TABLE.USERS, ids);
    });

    assert.deepEqual(seen, [freeId]);
    assert.deepEqual(await readUnlockedIds(keeper, TABLE.USERS, ids), ids.toSorted());
  });
});
