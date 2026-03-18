import {
  deleteUserById as modelDeleteUserById,
  getAllUsers as modelGetAllUsers,
  getUserById as modelGetUserById,
} from '#root/src/model/v1/user.js';
import { normalizeDataByColumns, replyError, replySuccess } from '#src/util/response.js';
import { createSchema } from '#src/util/schema.js';

// NORMALIZATION
const FILTER_COLUMNS = [
  'email',
  'name',
  'phone',
  'role',
  'limit',
  'offset',
  'sort',
];
const OUTPUT_COLUMNS = [
  'id',
  'email',
  'name',
  'phone',
  'role',
];

// GET ALL USERS
async function getAllUsers(request, reply) {
  const payload = {
    sortAllowedColumns: OUTPUT_COLUMNS,
  };

  FILTER_COLUMNS.forEach((filterColumnKey) => {
    payload[filterColumnKey] = request.query[filterColumnKey];
  });

  const data = await modelGetAllUsers(payload);

  if (Array.isArray(data.data) && data.data.length) {
    data.data = data.data.map((user) => normalizeDataByColumns(user, OUTPUT_COLUMNS));
  }

  return replySuccess(reply, {
    ...data,
  });
}
const getAllUsersSchema = createSchema('user', 'pagination', 'sort')
  .query(FILTER_COLUMNS)
  .defaultResponses()
  .response(200, {
    dataExampleKeys: OUTPUT_COLUMNS,
    dataExampleKeysFormat: 'array',
    paginationExampleKeys: ['*'],
    sortExampleKeys: ['*'],
    sortExampleKeysFormat: (example) => example.sort,
  })
  .meta({
    tags: ['User', 'v1'],
    summary: 'Get users list',
    description: 'Returns all users',
  })
  .build();

// GET USER BY ID
async function getUserById(request, reply) {
  const { id } = request.params;

  let user = await modelGetUserById(id);
  if (!user || !user.isEnabled) {
    user = null;
  }

  return replySuccess(reply, {
    data: normalizeDataByColumns(user, OUTPUT_COLUMNS),
  });
}
const getUserByIdSchema = createSchema('user')
  .params(['id'], ['id'])
  .defaultResponses()
  .response(200, {
    dataExampleKeys: OUTPUT_COLUMNS,
  })
  .meta({
    tags: ['User', 'v1'],
    summary: 'Get user by ID',
    description: 'Returns one user by ID',
  })
  .build();

// DELETE USER BY ID
async function deleteUserById(request, reply) {
  const { id } = request.params;

  const data = await modelDeleteUserById(id);
  if (!data) {
    return replyError(reply, {
      message: 'Invalid user ID',
      data: 'INVALID_USER_ID',
    });
  }

  return replySuccess(reply, {
    data,
  });
}
const deleteUserByIdSchema = createSchema('user')
  .params(['id'], ['id'])
  .defaultResponses()
  .response(200, {
    dataExample: true,
  })
  .meta({
    tags: ['User', 'v1'],
    summary: 'Delete user by ID',
    description: 'Deletes the user',
  })
  .build();

export {
  deleteUserById,
  deleteUserByIdSchema,
  FILTER_COLUMNS,
  getAllUsers,
  getAllUsersSchema,
  getUserById,
  getUserByIdSchema,
  OUTPUT_COLUMNS,
};
