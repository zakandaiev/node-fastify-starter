import { resolvePath } from '#core/path.js';
import { replyError, replySuccess } from '#src/util/response.js';
import { generateSchemaFromProperties } from '#src/util/schema.js';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import nodePath from 'node:path';
import { pipeline } from 'node:stream/promises';

async function uploadFile(data) {
  if (!data) {
    return {
      status: 'error',
      message: 'File binary is invalid',
    };
  }

  const { filename, file } = data;

  // CHECK EXTENSION
  const allowedExtensions = (process.env.APP_UPLOAD_EXTENSIONS || '')
    .split(',')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);

  const fileExtension = nodePath.extname(filename)
    .trim()
    .slice(1) // remove dot
    .toLowerCase();

  if (!allowedExtensions.includes(fileExtension)) {
    return {
      status: 'error',
      message: `File extension ".${fileExtension}" is not allowed`,
      data: 'FILE_EXTENSION_IS_INVALID',
      validation: [{
        column: 'extension',
        operator: 'extension',
        operatorValue: allowedExtensions,
      }],
    };
  }

  // CHECK SIZE
  const maxSize = parseInt(process.env.APP_UPLOAD_MAX_SIZE, 10);
  if (maxSize > 0 && data.bytes > maxSize) {
    return {
      status: 'error',
      message: 'File size is too big',
      data: 'FILE_SIZE_IS_INVALID',
      validation: [{
        column: 'size',
        operator: 'maxSize',
        operatorValue: maxSize,
      }],
    };
  }

  // GENERATE NAME&PATHS
  const name = `${randomUUID()}-${filename}`;
  const path = resolvePath('public', 'upload', name);
  const uri = `/upload/${name}`;

  // SAVE FILE ON DISK
  await pipeline(file, createWriteStream(path));

  return {
    status: 'success',
    path,
    uri,
  };
}

async function postUpload(request, reply) {
  const data = await request.file();

  const result = await uploadFile(data);
  if (result.status !== 'success') {
    return replyError(reply, {
      message: result.message,
    });
  }

  return replySuccess(reply, {
    data: result.uri,
  });
}
const postUploadSchema = generateSchemaFromProperties(
  {
    file: {
      type: 'string',
      format: 'binary',
    },
  },
  {
    bodyKeys: ['file'],
    bodyRequiredKeys: ['file'],
    successSchemaOptions: {
      dataExample: '/upload/id-file-hash.file-extension',
    },
    errorSchemaOptions: {
      messageExample: 'File size is too big',
      dataExample: 'FILE_SIZE_IS_INVALID',
      validationExample: [{
        column: 'size',
        operator: 'maxSize',
        operatorValue: 'number in bytes',
      }],
    },
  },
  {
    tags: ['Upload'],
    summary: 'Upload a file',
    description: 'Uploads a file and returns path to it',
  },
);

export {
  postUpload,
  postUploadSchema,
  uploadFile,
};
