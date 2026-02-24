import { resolvePath } from '#core/path.js';
import { toNumber } from '#src/util/misc.js';
import { replyError, replySuccess } from '#src/util/response.js';
import { createSchema } from '#src/util/schema.js';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import nodePath from 'node:path';
import { pipeline } from 'node:stream/promises';

// NORMALIZATION
const OUTPUT_COLUMNS = ['file'];

// UPLOAD UTIL
async function uploadFile(data) {
  if (!data) {
    return {
      status: 'error',
      message: 'File binary is invalid',
      data: 'FILE_BINARY_IS_INVALID',
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
        columnValue: fileExtension,
        operator: 'extension',
        operatorValue: allowedExtensions,
      }],
    };
  }

  // CHECK SIZE
  const maxSize = toNumber(process.env.APP_UPLOAD_MAX_SIZE);
  if (maxSize > 0 && data.bytes > maxSize) {
    return {
      status: 'error',
      message: 'File size is too big',
      data: 'FILE_SIZE_IS_INVALID',
      validation: [{
        column: 'size',
        columnValue: data.bytes,
        operator: 'maxSize',
        operatorValue: maxSize,
      }],
    };
  }

  // GENERATE NAME&PATHS
  const name = randomUUID();
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

// UPLOAD ROUTE
async function postUpload(request, reply) {
  const data = await request.file();

  const result = await uploadFile(data);
  if (result.status !== 'success') {
    delete result.status;
    return replyError(reply, result);
  }

  return replySuccess(reply, {
    data: result.uri,
  });
}
const postUploadSchema = createSchema('upload')
  .body(OUTPUT_COLUMNS, OUTPUT_COLUMNS)
  .defaultResponses()
  .response(200, {
    dataExampleKeys: OUTPUT_COLUMNS,
    dataExampleKeysFormat: 'string',
  })
  .response(400, {
    messageExample: 'File size is too big',
    dataExample: 'FILE_SIZE_IS_INVALID',
    validationExample: [{
      column: 'size',
      operator: 'maxSize',
      operatorValue: 'number in bytes',
    }],
  })
  .meta({
    tags: ['Upload', 'v1'],
    summary: 'Upload a file',
    description: 'Uploads a file and returns path to it',
  })
  .build();

export {
  OUTPUT_COLUMNS,
  postUpload,
  postUploadSchema,
  uploadFile,
};
