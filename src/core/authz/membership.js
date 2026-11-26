import { writeAudit } from '#core/audit/index.js';
import { createQuery } from '#core/db/query.js';
import { isInTransaction } from '#core/db/transaction.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { TABLE } from '#enums/table.js';
import { isUuid } from '#utils/id.js';
import { isNonEmptyString, isObject } from '#utils/type.js';

const GRANT_SQL = 'INSERT INTO user_groups (user_id, group_id, granted_by) VALUES (:userId, :groupId, :grantedBy)';
const REVOKE_SQL = 'DELETE FROM user_groups WHERE user_id = :userId AND group_id = :groupId';

// Before the statement: outside a transaction it would commit at once, and the record would then be refused.
function assertMembership({ userId, group, actorId }, signature) {
  const isValid = isUuid(userId)
    && isObject(group)
    && isUuid(group.id)
    && isNonEmptyString(group.slug)
    && (actorId === null || isUuid(actorId));

  if (!isValid) {
    throw new TypeError(`${signature} requires the UUID of a user, a group { id, slug } and the UUID of the actor, or null for the system`);
  }

  if (!isInTransaction()) {
    throw new Error(`${signature} runs inside withTransaction(), with the record it writes`);
  }
}

function recordMembership(action, { userId, group, actorId }, request) {
  return writeAudit({
    action,
    entityType: TABLE.USERS,
    entityId: userId,
    actorId,
    meta: { group: group.slug, groupId: group.id },
    request,
  });
}

// A membership and its record are written together: the grant of the admin group at a sign-in, and those of the API.
// The caller holds the lock of the row of the user and knows the user is no member yet.
export async function grantMembership({
  userId,
  group,
  actorId = null,
  request,
} = {}) {
  const membership = { userId, group, actorId };

  assertMembership(membership, 'grantMembership({ userId, group, actorId, request })');
  await createQuery(GRANT_SQL, { userId, groupId: group.id, grantedBy: actorId }).cache({ tables: [TABLE.USER_GROUPS] }).execute();
  await recordMembership(AUDIT_ACTION.USER_GROUP_GRANT, membership, request);

  return true;
}

export async function revokeMembership({
  userId,
  group,
  actorId = null,
  request,
} = {}) {
  const membership = { userId, group, actorId };

  assertMembership(membership, 'revokeMembership({ userId, group, actorId, request })');

  const query = await createQuery(REVOKE_SQL, { userId, groupId: group.id }).cache({ tables: [TABLE.USER_GROUPS] }).execute();

  if (query.affectedRows() === 0) {
    return false;
  }

  await recordMembership(AUDIT_ACTION.USER_GROUP_REVOKE, membership, request);

  return true;
}
