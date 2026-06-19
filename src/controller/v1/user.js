import {
  deleteUserById as modelDeleteUserById,
  getAllUsers as modelGetAllUsers,
  getUserById as modelGetUserById,
  patchUserById as modelPatchUserById,
} from '#src/model/v1/user.js';
import { normalizeDataByColumns, replyError, replySuccess } from '#src/service/response.js';
import { createSchema } from '#src/service/schema.js';
import {
  deleteUploadedFile,
  getPublicFileUrl,
  parseFormDataRequest,
} from '#src/service/upload.js';
import {
  isArray,
  isBoolean,
  isString,
  isStringBoolean,
} from '#src/util/misc.js';
import bcrypt from 'bcrypt';

// NORMALIZATION
export const FILTER_COLUMNS = [
  'email',
  'name',
  'phone',
  'role',
  'limit',
  'offset',
  'sort',
];
export const OUTPUT_COLUMNS = [
  'id',
  'email',
  'name',
  'phone',
  'avatar',
  'role',
];
export const PATCH_COLUMNS = [
  'email',
  'name',
  'phone',
  'role',
  'isEnabled',
  'password',
];

export const AVATAR_UPLOAD_OPTIONS = {
  allowedExtensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  maxSize: 2 * 1024 * 1024, // 2MB
};

export function normalizeUser(user) {
  const data = normalizeDataByColumns(user, OUTPUT_COLUMNS);
  if (data) {
    data.avatar = getPublicFileUrl(data.avatar);
  }

  return data;
}

// GET ALL USERS
export async function getAllUsers(request, reply) {
  const payload = {};

  FILTER_COLUMNS.forEach((filterColumnKey) => {
    payload[filterColumnKey] = request.query[filterColumnKey];
  });

  const data = await modelGetAllUsers(payload);

  if (isArray(data.data) && data.data.length) {
    data.data = data.data.map((user) => normalizeUser(user));
  }

  return replySuccess(reply, {
    ...data,
  });
}

export const getAllUsersSchema = createSchema('user', 'pagination', 'sort')
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
export async function getUserById(request, reply) {
  const { id } = request.params;

  let user = await modelGetUserById(id);
  if (!user || !user.isEnabled) {
    user = null;
  }

  return replySuccess(reply, {
    data: normalizeUser(user),
  });
}

export const getUserByIdSchema = createSchema('user')
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

// PATCH USER BY ID
export async function patchUserById(request, reply) {
  const { id } = request.params;

  const existingUser = await modelGetUserById(id);
  if (!existingUser) {
    return replyError(reply, {
      message: 'Invalid user ID',
      data: 'INVALID_USER_ID',
    });
  }

  const { fields, files, validation } = await parseFormDataRequest(request, {
    fileFields: {
      avatar: AVATAR_UPLOAD_OPTIONS,
    },
    limits: {
      fileSize: AVATAR_UPLOAD_OPTIONS.maxSize,
    },
  });

  if (validation.length) {
    return replyError(reply, {
      message: 'Validation Error',
      data: 'VALIDATION_ERROR',
      validation,
    });
  }

  const payload = {};
  PATCH_COLUMNS.forEach((columnKey) => {
    if (fields[columnKey] !== undefined) {
      payload[columnKey] = fields[columnKey];
    }
  });

  if (payload.phone === '') {
    payload.phone = null;
  }

  if (payload.isEnabled !== undefined) {
    if (isBoolean(payload.isEnabled) || isStringBoolean(payload.isEnabled)) {
      payload.isEnabled = payload.isEnabled === true || payload.isEnabled === 'true' ? 1 : 0;
    } else {
      delete payload.isEnabled;
    }
  }

  ['email', 'name', 'role'].forEach((columnKey) => {
    if (payload[columnKey] !== undefined && (!isString(payload[columnKey]) || !payload[columnKey].length)) {
      delete payload[columnKey];
    }
  });

  if (payload.password !== undefined) {
    if (!isString(payload.password) || payload.password.length < 8) {
      return replyError(reply, {
        message: 'Validation Error',
        data: 'VALIDATION_ERROR',
        validation: [{
          column: 'password',
          columnValue: undefined,
          operator: 'minLength',
          operatorValue: 8,
        }],
      });
    }

    payload.password = await bcrypt.hash(payload.password, 10);
  }

  if (files.avatar) {
    payload.avatar = files.avatar;
  } else if (fields.avatar === '') {
    payload.avatar = null;
  }

  if (!Object.keys(payload).length) {
    return replyError(reply, {
      message: 'No fields to update',
      data: 'NO_FIELDS_TO_UPDATE',
    });
  }

  await modelPatchUserById(id, payload);

  if ('avatar' in payload && payload.avatar !== existingUser.avatar) {
    await deleteUploadedFile(existingUser.avatar);
  }

  const updatedUser = await modelGetUserById(id);

  return replySuccess(reply, {
    data: normalizeUser(updatedUser),
  });
}

export const patchUserByIdSchema = createSchema('user')
  .params(['id'], ['id'])
  .body([...PATCH_COLUMNS, 'avatar'])
  .defaultResponses()
  .response(200, {
    dataExampleKeys: OUTPUT_COLUMNS,
  })
  .meta({
    consumes: ['multipart/form-data', 'application/json'],
    tags: ['User', 'v1'],
    summary: 'Patch user by ID',
    description: 'Patches the user',
  })
  .build();

// DELETE USER BY ID
export async function deleteUserById(request, reply) {
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

export const deleteUserByIdSchema = createSchema('user')
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
