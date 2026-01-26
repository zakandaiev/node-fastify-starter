import {
  getAllUsers as getAllUsersFromModel,
  getUserById as getUserByIdFromModel,
} from '#src/model/user.js';
import paginationProperties from '#src/schema/pagination.json' with { type: 'json' };
import userProperties from '#src/schema/user.json' with { type: 'json' };
import { replyError, replySuccess } from '#src/util/response.js';
import { generateSchemaFromProperties } from '#src/util/schema.js';

const EXAMPLE_OUTPUT = {
  id: 'id-hash',
  email: 'dummy@email.com',
  name: 'Dummy Name',
  phone: null,
  role: 'user',
};

// GET USER BY ID
async function getUserById(request, reply) {
  const { id } = request.params;
  if (!id) {
    return replyError(reply, {
      message: 'User id is invalid',
    });
  }
  const data = await getUserByIdFromModel({ id });

  return replySuccess(reply, {
    data,
  });
}
const getUserByIdSchema = generateSchemaFromProperties(
  userProperties,
  {
    paramKeys: ['id'],
    paramRequiredKeys: ['id'],
    successSchemaOptions: {
      dataExample: EXAMPLE_OUTPUT,
    },
  },
  {
    tags: ['User'],
    summary: 'Get user by ID',
    description: 'Returns one user by ID',
  },
);

// GET ALL USERS
async function getAllUsers(request, reply) {
  const { limit, offset } = request.query;

  const data = await getAllUsersFromModel({ limit, offset });

  return replySuccess(reply, {
    data,
  });
}
const getAllUsersSchema = generateSchemaFromProperties(
  {
    ...userProperties,
    ...paginationProperties,
  },
  {
    queryKeys: ['limit', 'offset'],
    successSchemaOptions: {
      dataExample: [EXAMPLE_OUTPUT],
    },
  },
  {
    tags: ['User'],
    summary: 'Get users list',
    description: 'Returns all users',
  },
);

export {
  getAllUsers,
  getAllUsersSchema,
  getUserById,
  getUserByIdSchema,
};
