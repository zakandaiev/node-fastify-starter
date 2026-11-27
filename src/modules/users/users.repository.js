import { updateReturning } from '#core/db/index.js';
import { createQuery } from '#core/db/query.js';
import { getStorage } from '#core/storage/index.js';
import { TABLE } from '#enums/table.js';
import * as userSchema from '#schemas/entity/user.js';
import { camelToSnakeKey } from '#utils/case.js';

// A row holds the key of the avatar and the API its URL, which the storage makes of the key at each read: the address
// of the app may change, the key does not.
const AVATAR_URL_FIELD = 'avatarUrl';
export const AVATAR_KEY_FIELD = 'avatarKey';

function toRowFields(fields) {
  return fields.map((field) => (field === AVATAR_URL_FIELD ? AVATAR_KEY_FIELD : field));
}

function toColumns(fields) {
  return toRowFields(fields).map((field) => camelToSnakeKey(field)).join(', ');
}

export const USER_FIELDS = Object.freeze(Object.keys(userSchema.properties));
const USER_ROW_FIELDS = Object.freeze(toRowFields(USER_FIELDS));
const USER_COLUMNS = toColumns(USER_FIELDS);

// A row of a list of users, here and among the members of a group.
export const USER_LIST_FIELDS = Object.freeze(['id', 'email', 'firstName', 'lastName', 'avatarUrl', 'status', 'createdAt']);
export const USER_LIST_COLUMNS = toColumns(USER_LIST_FIELDS);

const LIST_SQL = `SELECT ${USER_LIST_COLUMNS} FROM users`;
const FIND_SQL = `SELECT ${USER_COLUMNS} FROM users WHERE id = :id`;
const DELETE_SQL = 'DELETE FROM users WHERE id = :id';
const GROUP_IDS_SQL = 'SELECT group_id FROM user_groups WHERE user_id = :userId ORDER BY group_id';

function toUser(row) {
  if (row === null) {
    return null;
  }

  const { [AVATAR_KEY_FIELD]: avatarKey, ...user } = row;

  return {
    ...user,
    [AVATAR_URL_FIELD]: avatarKey === null
      ? null
      : getStorage().url(avatarKey),
  };
}

// A page of rows read with USER_LIST_COLUMNS, as the API gives it.
export function toUserList(result) {
  return { ...result, data: result.data.map((row) => toUser(row)) };
}

export async function findUsers(payload) {
  const query = await createQuery(LIST_SQL)
    .filter(userSchema, payload)
    .sort(userSchema, payload)
    .paginate(payload)
    .cache({ tables: [TABLE.USERS] })
    .execute();

  return toUserList(query.getAll());
}

export async function findUser(id) {
  const query = await createQuery(FIND_SQL, { id }).cache({ tables: [TABLE.USERS] }).execute();

  return toUser(query.fetch());
}

// The fields of a row, avatarKey in place of avatarUrl.
export async function updateUserFields(id, fields) {
  const [updated = null] = await updateReturning(TABLE.USERS, fields, { where: { id }, returning: USER_ROW_FIELDS });

  return toUser(updated);
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
