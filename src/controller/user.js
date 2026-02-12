import {
  deleteUserByConditions,
  getAllUsers as getAllUsersFromModel,
  getUserByConditions,
} from '#src/model/user.js';
import { normalizeDataByColumns, replyError, replySuccess } from '#src/util/response.js';
import { generateSchema } from '#src/util/schema.js';

// NORMALIZATION
const OUTPUT_COLUMNS = [
  'id',
  'email',
  'name',
  'phone',
  'role',
];

// GET ALL USERS
async function getAllUsers(request, reply) {
  const {
    orderBy,
    limit,
    offset,
  } = request.query;

  const payload = {
    orderBy,
    limit,
    offset,
  };
  const options = {
    columns: OUTPUT_COLUMNS,
  };

  const data = await getAllUsersFromModel(payload, options);

  return replySuccess(reply, {
    data,
  });
}
const getAllUsersSchema = generateSchema(
  ['user', 'pagination'],
  {
    queryKeys: ['orderBy', 'limit', 'offset'],
    responseSuccessDataExample: OUTPUT_COLUMNS,
    responseSuccessDataExampleFormat: 'array',
    overwrite: {
      tags: ['User'],
      summary: 'Get users list',
      description: 'Returns all users',
    },
  },
);

// GET CURRENT USER
async function getCurrentUser(request, reply) {
  const { id } = request.user;

  const payload = {
    id,
  };
  const options = {
    columns: OUTPUT_COLUMNS,
    conditions: ['id'],
  };

  const data = await getUserByConditions(payload, options);

  return replySuccess(reply, {
    data: data || normalizeDataByColumns(request.user, OUTPUT_COLUMNS),
  });
}
const getCurrentUserSchema = generateSchema(
  'user',
  {
    responseSuccessDataExample: OUTPUT_COLUMNS,
    overwrite: {
      tags: ['User'],
      summary: 'Get current user',
      description: 'Returns current user',
    },
  },
);

// GET USER BY ID
async function getUserById(request, reply) {
  const { id } = request.params;

  const payload = {
    id,
  };
  const options = {
    columns: OUTPUT_COLUMNS,
    conditions: ['id'],
  };

  const data = await getUserByConditions(payload, options);

  return replySuccess(reply, {
    data,
  });
}
const getUserByIdSchema = generateSchema(
  'user',
  {
    paramKeys: ['id'],
    paramRequiredKeys: ['id'],
    responseSuccessDataExample: OUTPUT_COLUMNS,
    overwrite: {
      tags: ['User'],
      summary: 'Get user by ID',
      description: 'Returns one user by ID',
    },
  },
);

// DELETE USER BY ID
async function deleteUserById(request, reply) {
  const { id } = request.params;

  const payload = {
    id,
  };
  const options = {
    conditions: ['id'],
  };

  const data = await deleteUserByConditions(payload, options);
  if (!data) {
    return replyError(reply, {
      message: 'Invalid id',
      data: 'INVALID_ID',
    });
  }

  return replySuccess(reply, {
    data,
  });
}
const deleteUserByIdSchema = generateSchema(
  'user',
  {
    paramKeys: ['id'],
    paramRequiredKeys: ['id'],
    responseCodeOverwrite: {
      200: {
        dataExample: true,
      },
    },
    overwrite: {
      tags: ['User'],
      summary: 'Delete user by ID',
      description: 'Deletes the user',
    },
  },
);

export {
  deleteUserById,
  deleteUserByIdSchema,
  getAllUsers,
  getAllUsersSchema,
  getCurrentUser,
  getCurrentUserSchema,
  getUserById,
  getUserByIdSchema,
  OUTPUT_COLUMNS,
};
