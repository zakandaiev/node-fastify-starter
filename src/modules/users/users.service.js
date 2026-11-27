import { writeAudit } from '#core/audit/index.js';
import { isAdminCandidate } from '#core/auth/account.js';
import { revokeAllSessions, SESSION_TRANSACTION } from '#core/auth/session.js';
import { assertOtherUser, lockAccount, lockActorAndUser } from '#core/auth/user.js';
import { assertActorHolds, readUserScopes } from '#core/authz/scope.js';
import { buildPatch } from '#core/db/patch.js';
import { withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { SCOPE, SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { assertAdminGroupsKept } from '#modules/groups/groups.service.js';
import {
  deleteUser,
  findUser,
  findUsers,
  readGroupIds,
  updateUserFields,
} from '#modules/users/users.repository.js';
import { mapSeries } from '#utils/async.js';
import { nowUtc } from '#utils/date.js';
import { assertUuid } from '#utils/id.js';
import { diff, mapValues, pick } from '#utils/object.js';
import { isValidPersonName, normalizePersonName } from '#utils/person.js';
import { isString } from '#utils/type.js';
import { isEmail, toValidEmail } from '#utils/validate.js';

const NAME_FIELDS = Object.freeze(['firstName', 'lastName']);

// The status is no field of a change: a block ends the sessions, a write of the column would not.
const MANAGED_FIELDS = Object.freeze(['email', ...NAME_FIELDS]);

// A changed email changes its confirmation too.
const CHANGED_FIELDS = Object.freeze([...MANAGED_FIELDS, 'emailVerifiedAt']);

const MANAGE_REQUIREMENT = Object.freeze([SCOPE.USERS_MANAGE]);

const STATUS_ACTIONS = Object.freeze({
  [USER_STATUS.BLOCKED]: AUDIT_ACTION.USER_BLOCK,
  [USER_STATUS.ACTIVE]: AUDIT_ACTION.USER_UNBLOCK,
});

// The schema of a route checks the same: a caller outside a request is held to it too. A value is stored in the form
// it is searched and compared in.
const FIELD_FORMS = Object.freeze({
  email: { isValid: isEmail, normalize: toValidEmail, expected: 'an email' },
  firstName: { isValid: isValidPersonName, normalize: normalizePersonName, expected: 'a name of a person' },
  lastName: { isValid: isValidPersonName, normalize: normalizePersonName, expected: 'a name of a person' },
});

function notFound() {
  return new AppError(ERROR_CODE.NOT_FOUND_ERROR);
}

function normalizeField(field, value, signature) {
  if (value === null) {
    return null;
  }

  const form = FIELD_FORMS[field];

  if (!isString(value) || !form.isValid(value)) {
    throw new TypeError(`${signature} requires ${field} to be ${form.expected} or null`);
  }

  return form.normalize(value);
}

function readPatch(input, allowed, signature) {
  return mapValues(buildPatch(input, { allowed }), (value, field) => normalizeField(field, value, signature));
}

// The manager who sets an address answers for it: a sign-in through a provider that confirms the same address signs
// into this user.
function applyPatch(user, patch) {
  const after = { ...user, ...patch };

  if (!Object.hasOwn(patch, 'email') || patch.email === user.email) {
    return after;
  }

  return {
    ...after,
    emailVerifiedAt: patch.email === null
      ? null
      : nowUtc(),
  };
}

function readChangedFields(before, after) {
  return Object.keys(diff(pick(before, CHANGED_FIELDS), pick(after, CHANGED_FIELDS)));
}

// One's own account has the routes of /me: here a manager would change their own email, which /me does not, or their
// own status.
function assertManagedCall({ id, actorId }, signature) {
  assertUuid(id, signature, 'a user');
  assertUuid(actorId, signature, 'the actor');

  return assertOtherUser(actorId, id, signature);
}

async function readHeldScopes(user) {
  return (await isAdminCandidate(user))
    ? [SCOPE_ALL]
    : readUserScopes(user.id);
}

// Every scope the user holds, before the change and after it: otherwise managing users would switch full access on
// or off for others.
async function assertManagedBy(actor, users) {
  const scopes = await mapSeries(users, (user) => readHeldScopes(user));

  return assertActorHolds(actor, { requirement: MANAGE_REQUIREMENT, scopes: scopes.flat() });
}

export function listUsers(payload) {
  return findUsers(payload);
}

export async function readUser(id) {
  assertUuid(id, 'readUser(id)', 'a user');

  const user = await findUser(id);

  if (user === null) {
    throw notFound();
  }

  return user;
}

async function changeUser(id, patch, { actorId, request }) {
  const { actor, user } = await lockActorAndUser({ actorId, userId: id });
  const after = applyPatch(user, patch);

  await assertManagedBy(actor, [user, after]);

  const fields = readChangedFields(user, after);

  if (!fields.length) {
    return findUser(id);
  }

  const updated = await updateUserFields(id, pick(after, fields));

  // The names of the fields, not their values: the record outlives the user, and an email or a name is theirs.
  await writeAudit({
    action: AUDIT_ACTION.USER_UPDATE,
    entityType: TABLE.USERS,
    entityId: id,
    actorId,
    meta: { fields },
    request,
  });

  return updated;
}

export async function updateUser({
  id,
  input,
  actorId,
  request,
} = {}) {
  const signature = 'updateUser({ id, input, actorId, request })';

  assertManagedCall({ id, actorId }, signature);

  const patch = readPatch(input, MANAGED_FIELDS, signature);

  return withTransaction(() => changeUser(id, patch, { actorId, request }), SESSION_TRANSACTION);
}

async function changeStatus(user, status, { actorId, request }) {
  const changed = await updateUserFields(user.id, { status });

  await writeAudit({
    action: STATUS_ACTIONS[status],
    entityType: TABLE.USERS,
    entityId: user.id,
    actorId,
    request,
  });

  return changed;
}

// The sessions end even when the status is blocked already: a session may have been made around a block written
// outside this API. They end first: their marks then come right after the commit, ahead of the bumps of the cache,
// which wait for its Redis.
export async function blockUser({ id, actorId, request } = {}) {
  assertManagedCall({ id, actorId }, 'blockUser({ id, actorId, request })');

  return withTransaction(async () => {
    const { actor, user } = await lockActorAndUser({ actorId, userId: id });

    await assertAdminGroupsKept(user);
    await assertManagedBy(actor, [user]);
    await revokeAllSessions(id);

    return user.status === USER_STATUS.BLOCKED
      ? findUser(id)
      : changeStatus(user, USER_STATUS.BLOCKED, { actorId, request });
  }, SESSION_TRANSACTION);
}

export async function unblockUser({ id, actorId, request } = {}) {
  assertManagedCall({ id, actorId }, 'unblockUser({ id, actorId, request })');

  return withTransaction(async () => {
    const { actor, user } = await lockActorAndUser({ actorId, userId: id });

    await assertManagedBy(actor, [user]);

    return user.status === USER_STATUS.ACTIVE
      ? findUser(id)
      : changeStatus(user, USER_STATUS.ACTIVE, { actorId, request });
  }, SESSION_TRANSACTION);
}

// The foreign keys erase the memberships without records of their own: the record of the deletion names the groups,
// as that of a deleted group names its members. The sessions are revoked before their rows go, so that every process
// is told.
async function removeLocked(user, { actorId, request }) {
  const groupIds = await readGroupIds(user.id);

  await revokeAllSessions(user.id);
  await deleteUser(user.id);
  await writeAudit({
    action: AUDIT_ACTION.USER_DELETE,
    entityType: TABLE.USERS,
    entityId: user.id,
    actorId,
    meta: { groupIds },
    request,
  });

  return true;
}

export async function removeUser({ id, actorId, request } = {}) {
  assertManagedCall({ id, actorId }, 'removeUser({ id, actorId, request })');

  return withTransaction(async () => {
    const { actor, user } = await lockActorAndUser({ actorId, userId: id });

    await assertAdminGroupsKept(user);
    await assertManagedBy(actor, [user]);

    return removeLocked(user, { actorId, request });
  }, SESSION_TRANSACTION);
}

export async function readOwnProfile(userId) {
  assertUuid(userId, 'readOwnProfile(userId)', 'a user');

  const user = await findUser(userId);

  // A session outlives its user only between the check of the request and this read.
  if (user === null) {
    throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
  }

  return user;
}

export async function updateOwnProfile({ userId, input } = {}) {
  const signature = 'updateOwnProfile({ userId, input })';

  assertUuid(userId, signature, 'a user');

  const patch = readPatch(input, NAME_FIELDS, signature);

  return withTransaction(async () => {
    const user = await lockAccount(userId);
    const after = applyPatch(user, patch);
    const fields = readChangedFields(user, after);

    return fields.length
      ? updateUserFields(userId, pick(after, fields))
      : findUser(userId);
  }, SESSION_TRANSACTION);
}

export async function removeOwnAccount({ userId, request } = {}) {
  assertUuid(userId, 'removeOwnAccount({ userId, request })', 'a user');

  return withTransaction(async () => {
    const user = await lockAccount(userId);

    await assertAdminGroupsKept(user);

    return removeLocked(user, { actorId: userId, request });
  }, SESSION_TRANSACTION);
}
