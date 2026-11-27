import { insertReturning, updateReturning } from '#core/db/index.js';
import { createQuery } from '#core/db/query.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { USER_LIST_COLUMNS } from '#modules/users/users.repository.js';
import * as groupSchema from '#schemas/entity/group.js';
import * as userSchema from '#schemas/entity/user.js';
import { groupBy } from '#utils/array.js';
import { camelToSnakeKey } from '#utils/case.js';

const GROUP_ROW_FIELDS = Object.freeze(['id', 'slug', 'name', 'description', 'isSuperadmin', 'isSystem', 'createdAt', 'updatedAt']);
const GROUP_COLUMNS = GROUP_ROW_FIELDS.map((field) => camelToSnakeKey(field)).join(', ');

const LIST_SQL = `SELECT ${GROUP_COLUMNS} FROM groups`;
const FIND_SQL = `SELECT ${GROUP_COLUMNS} FROM groups WHERE id = :id`;
const LOCK_LIST_SQL = `SELECT ${GROUP_COLUMNS} FROM groups WHERE id IN (:ids) ORDER BY id FOR UPDATE`;
const TOUCH_SQL = 'UPDATE groups SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = :id';
const DELETE_SQL = 'DELETE FROM groups WHERE id = :id';

const SCOPES_SQL = 'SELECT group_id, scope FROM group_scopes WHERE group_id IN (:groupIds) ORDER BY scope';
const INSERT_SCOPES_SQL = 'INSERT INTO group_scopes (group_id, scope) VALUES';
const DELETE_SCOPES_SQL = 'DELETE FROM group_scopes WHERE group_id = :groupId AND scope IN (:scopes)';

// A subquery, not a join: the filters and the sort of the users name their columns without a table.
const MEMBERS_SQL = `
  SELECT ${USER_LIST_COLUMNS}
  FROM users
  WHERE id IN (SELECT user_id FROM user_groups WHERE group_id = :groupId)
`;

const MEMBER_IDS_SQL = 'SELECT user_id FROM user_groups WHERE group_id = :groupId ORDER BY user_id';
const ACTIVE_MEMBERS_SQL = `
  SELECT COUNT(*) AS total
  FROM user_groups ug
  JOIN users u ON u.id = ug.user_id
  WHERE ug.group_id = :groupId AND u.status = :status
`;
const MEMBERSHIP_SQL = 'SELECT user_id FROM user_groups WHERE user_id = :userId AND group_id = :groupId';

// A plain read: every flow that changes the groups of a user holds the lock of the row of that user first.
const PROTECTED_GROUP_IDS_SQL = `
  SELECT ug.group_id
  FROM user_groups ug
  JOIN groups g ON g.id = ug.group_id
  WHERE ug.user_id = :userId AND g.is_system = TRUE AND g.is_superadmin = TRUE
  ORDER BY ug.group_id
`;

// Inside a transaction the cache is skipped: this reads what the transaction sees.
async function readScopes(groupIds) {
  if (!groupIds.length) {
    return {};
  }

  const query = await createQuery(SCOPES_SQL, { groupIds }).cache({ tables: [TABLE.GROUP_SCOPES] }).execute();
  const byGroup = groupBy(query.fetchAll(), 'groupId');

  return Object.fromEntries(groupIds.map((groupId) => [groupId, (byGroup[groupId] ?? []).map((row) => row.scope)]));
}

async function withScopes(group) {
  if (group === null) {
    return null;
  }

  const scopes = await readScopes([group.id]);

  return { ...group, scopes: scopes[group.id] };
}

export async function findGroups(payload) {
  const query = await createQuery(LIST_SQL)
    .filter(groupSchema, payload)
    .sort(groupSchema, payload)
    .paginate(payload)
    .cache({ tables: [TABLE.GROUPS] })
    .execute();
  const result = query.getAll();
  const scopes = await readScopes(result.data.map((group) => group.id));

  return { ...result, data: result.data.map((group) => ({ ...group, scopes: scopes[group.id] })) };
}

export async function hasGroup(id) {
  const query = await createQuery(FIND_SQL, { id }).cache({ tables: [TABLE.GROUPS] }).execute();

  return query.fetch() !== null;
}

export async function findGroup(id) {
  const query = await createQuery(FIND_SQL, { id }).cache({ tables: [TABLE.GROUPS] }).execute();

  return withScopes(query.fetch());
}

// Without their scopes: the caller guards who stays in them, not what they grant.
export async function lockGroups(ids) {
  if (!ids.length) {
    return [];
  }

  const query = await createQuery(LOCK_LIST_SQL, { ids }).execute();

  return query.fetchAll();
}

// The row every change of the group, of its scopes and of its members waits for.
export async function lockGroup(id) {
  const [group = null] = await lockGroups([id]);

  return withScopes(group);
}

export async function readProtectedGroupIds(userId) {
  const query = await createQuery(PROTECTED_GROUP_IDS_SQL, { userId }).execute();

  return query.fetchAll().map((row) => row.groupId);
}

export function insertGroup(row) {
  return insertReturning(TABLE.GROUPS, row, { returning: GROUP_ROW_FIELDS });
}

export async function updateGroupFields(id, fields) {
  const [updated] = await updateReturning(TABLE.GROUPS, fields, { where: { id }, returning: GROUP_ROW_FIELDS });

  return updated;
}

// The scopes live in a table of their own: the time of their change is set on the group by hand.
export async function touchGroup(id) {
  await createQuery(TOUCH_SQL, { id }).cache({ tables: [TABLE.GROUPS] }).execute();

  return true;
}

export async function deleteGroup(id) {
  const query = await createQuery(DELETE_SQL, { id }).cache({ tables: [TABLE.GROUPS] }).execute();

  return query.affectedRows() > 0;
}

// One statement: the binder takes no list of rows, so each value gets a name of its own.
export async function addGroupScopes(groupId, scopes) {
  if (!scopes.length) {
    return false;
  }

  const rows = scopes.map((scope, index) => `(:groupId, :scope${index})`).join(', ');
  const values = Object.fromEntries(scopes.map((scope, index) => [`scope${index}`, scope]));

  await createQuery(`${INSERT_SCOPES_SQL} ${rows}`, { groupId, ...values }).cache({ tables: [TABLE.GROUP_SCOPES] }).execute();

  return true;
}

export async function removeGroupScopes(groupId, scopes) {
  if (!scopes.length) {
    return false;
  }

  await createQuery(DELETE_SCOPES_SQL, { groupId, scopes }).cache({ tables: [TABLE.GROUP_SCOPES] }).execute();

  return true;
}

export async function findMembers(groupId, payload) {
  const query = await createQuery(MEMBERS_SQL, { groupId })
    .filter(userSchema, payload)
    .sort(userSchema, payload)
    .paginate(payload)
    .cache({ tables: [TABLE.USERS, TABLE.USER_GROUPS] })
    .execute();

  return query.getAll();
}

export async function countActiveMembers(groupId) {
  const query = await createQuery(ACTIVE_MEMBERS_SQL, { groupId, status: USER_STATUS.ACTIVE }).execute();

  return query.fetchColumn();
}

export async function readMemberIds(groupId) {
  const query = await createQuery(MEMBER_IDS_SQL, { groupId }).execute();

  return query.fetchAll().map((row) => row.userId);
}

export async function isMember({ userId, groupId }) {
  const query = await createQuery(MEMBERSHIP_SQL, { userId, groupId }).execute();

  return query.fetch() !== null;
}
