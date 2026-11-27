import { updateReturning } from '#core/db/index.js';
import { createQuery } from '#core/db/query.js';
import { TABLE } from '#enums/table.js';
import * as userSchema from '#schemas/entity/user.js';
import { camelToSnakeKey } from '#utils/case.js';

export const USER_FIELDS = Object.freeze(Object.keys(userSchema.properties));
const USER_COLUMNS = USER_FIELDS.map((field) => camelToSnakeKey(field)).join(', ');

// A row of a list of users, here and among the members of a group.
export const USER_LIST_FIELDS = Object.freeze(['id', 'email', 'firstName', 'lastName', 'status', 'createdAt']);
export const USER_LIST_COLUMNS = USER_LIST_FIELDS.map((field) => camelToSnakeKey(field)).join(', ');

const LIST_SQL = `SELECT ${USER_LIST_COLUMNS} FROM users`;
const FIND_SQL = `SELECT ${USER_COLUMNS} FROM users WHERE id = :id`;
const DELETE_SQL = 'DELETE FROM users WHERE id = :id';
const GROUP_IDS_SQL = 'SELECT group_id FROM user_groups WHERE user_id = :userId ORDER BY group_id';

export async function findUsers(payload) {
  const query = await createQuery(LIST_SQL)
    .filter(userSchema, payload)
    .sort(userSchema, payload)
    .paginate(payload)
    .cache({ tables: [TABLE.USERS] })
    .execute();

  return query.getAll();
}

export async function findUser(id) {
  const query = await createQuery(FIND_SQL, { id }).cache({ tables: [TABLE.USERS] }).execute();

  return query.fetch();
}

export async function updateUserFields(id, fields) {
  const [updated] = await updateReturning(TABLE.USERS, fields, { where: { id }, returning: USER_FIELDS });

  return updated;
}

// The identities, the memberships and the sessions go with the row through their foreign keys.
export async function deleteUser(id) {
  const query = await createQuery(DELETE_SQL, { id }).cache({ tables: [TABLE.USERS] }).execute();

  return query.affectedRows() > 0;
}

export async function readGroupIds(userId) {
  const query = await createQuery(GROUP_IDS_SQL, { userId }).execute();

  return query.fetchAll().map((row) => row.groupId);
}
