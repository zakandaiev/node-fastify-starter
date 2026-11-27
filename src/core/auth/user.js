import { createQuery } from '#core/db/query.js';
import { isInTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { USER_STATUS } from '#enums/user-status.js';
import { unique } from '#utils/array.js';
import { camelToSnakeKey } from '#utils/case.js';
import { assertUuid, isUuid } from '#utils/id.js';
import { isNonEmptyArray } from '#utils/type.js';

export const ACCOUNT_FIELDS = Object.freeze(['id', 'email', 'emailVerifiedAt', 'firstName', 'lastName', 'status']);
const ACCOUNT_COLUMNS = ACCOUNT_FIELDS.map((field) => camelToSnakeKey(field)).join(', ');

// In the order of the key: two flows that lock the same users take them one after another and never cross.
const LOCK_USERS_SQL = `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id IN (:userIds) ORDER BY id FOR UPDATE`;

export function assertActiveUser(user) {
  if (user?.status !== USER_STATUS.ACTIVE) {
    throw new AppError(ERROR_CODE.AUTHORIZATION_ERROR);
  }

  return user;
}

// The first lock of every flow that changes a user or what refers to one: a lock taken outside a transaction would end
// with its own statement.
export async function lockUsers(userIds) {
  const signature = 'lockUsers(userIds)';

  if (!isNonEmptyArray(userIds) || !userIds.every((userId) => isUuid(userId))) {
    throw new TypeError(`${signature} requires a non-empty list of the UUIDs of users`);
  }

  if (!isInTransaction()) {
    throw new Error(`${signature} runs inside withTransaction(): the lock lasts as long as the transaction`);
  }

  const query = createQuery(LOCK_USERS_SQL, { userIds: unique(userIds) });

  await query.execute();

  return query.fetchAll();
}

// The user of a request, who acts on their own account: one who is there no more is signed out, a blocked one is
// refused.
export async function lockAccount(userId) {
  assertUuid(userId, 'lockAccount(userId)', 'a user');

  const [user = null] = await lockUsers([userId]);

  if (user === null) {
    throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
  }

  return assertActiveUser(user);
}

// A user acting on another: their own account has routes of its own, which a flow on another user would bypass.
export function assertOtherUser(actorId, userId, signature = 'assertOtherUser(actorId, userId)') {
  assertUuid(actorId, signature, 'the actor');
  assertUuid(userId, signature, 'a user');

  if (actorId === userId) {
    throw new AppError(ERROR_CODE.AUTHORIZATION_ERROR);
  }

  return true;
}

// The actor is null once their row is gone, and then holds nothing; the user acted on is not found without theirs.
export async function lockActorAndUser({ actorId, userId } = {}) {
  const signature = 'lockActorAndUser({ actorId, userId })';

  assertUuid(actorId, signature, 'the actor');
  assertUuid(userId, signature, 'a user');

  const users = await lockUsers([actorId, userId]);
  const user = users.find((row) => row.id === userId);

  if (user === undefined) {
    throw new AppError(ERROR_CODE.NOT_FOUND_ERROR);
  }

  return { actor: users.find((row) => row.id === actorId) ?? null, user };
}
