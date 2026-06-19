import { resolvePath } from '#core/path.js';
import {
  isArray,
  isObject,
  isString,
  toNumber,
} from '#src/util/misc.js';
import { randomUUIDv7 } from '#src/util/random.js';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import nodePath from 'node:path';
import { pipeline } from 'node:stream/promises';

export function getPublicFileUrl(path) {
  if (!isString(path) || !path.length) {
    return null;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `https://${process.env.APP_HOST}${path}`;
}

export async function uploadFile(data, {
  allowedExtensions,
  maxSize,
} = {}) {
  if (!data) {
    return {
      status: 'error',
      message: 'File binary is invalid',
      data: 'FILE_BINARY_IS_INVALID',
    };
  }

  const { filename, file } = data;

  // CHECK EXTENSION
  const safeAllowedExtensions = (
    isArray(allowedExtensions)
      ? allowedExtensions
      : (process.env.APP_UPLOAD_EXTENSIONS || '').split(',')
  )
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);

  const fileExtension = nodePath.extname(filename)
    .trim()
    .slice(1) // remove dot
    .toLowerCase();

  if (!safeAllowedExtensions.includes(fileExtension)) {
    return {
      status: 'error',
      message: `File extension ".${fileExtension}" is not allowed`,
      data: 'FILE_EXTENSION_IS_INVALID',
      validation: [{
        column: 'extension',
        columnValue: fileExtension,
        operator: 'extension',
        operatorValue: safeAllowedExtensions,
      }],
    };
  }

  // GENERATE NAME&PATHS
  const name = randomUUIDv7();
  const path = resolvePath('upload', name);
  const uri = `/upload/${name}`;

  // SAVE FILE ON DISK
  const safeMaxSize = toNumber(maxSize) ?? toNumber(process.env.APP_UPLOAD_MAX_SIZE);
  const sizeErrorResult = {
    status: 'error',
    message: 'File size is too big',
    data: 'FILE_SIZE_IS_INVALID',
    validation: [{
      column: 'size',
      columnValue: file.bytesRead,
      operator: 'maxSize',
      operatorValue: safeMaxSize,
    }],
  };

  await mkdir(nodePath.dirname(path), { recursive: true });

  try {
    await pipeline(file, createWriteStream(path));
  } catch (error) {
    try {
      await unlink(path);
    } catch {
      // partial file may not exist
    }

    if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
      sizeErrorResult.validation[0].columnValue = file.bytesRead;
      return sizeErrorResult;
    }

    throw error;
  }

  // CHECK SIZE
  if (file.truncated || (safeMaxSize > 0 && file.bytesRead > safeMaxSize)) {
    await unlink(path);
    sizeErrorResult.validation[0].columnValue = file.bytesRead;
    return sizeErrorResult;
  }

  return {
    status: 'success',
    path,
    uri,
  };
}

export async function deleteUploadedFile(uri) {
  if (!isString(uri) || !uri.startsWith('/upload/')) {
    return false;
  }

  const name = uri.slice('/upload/'.length);
  if (!name || /[/\\]|\.\./.test(name)) {
    return false;
  }

  try {
    await unlink(resolvePath('upload', name));
  } catch {
    return false;
  }

  return true;
}

export async function parseFormDataRequest(request, {
  fileFields = {},
  limits = {},
} = {}) {
  const fields = {};
  const files = {};
  const validation = [];

  if (!request.isMultipart()) {
    if (isObject(request.body)) {
      Object.assign(fields, request.body);
    }

    return {
      fields,
      files,
      validation,
    };
  }

  const parts = request.parts({ limits });

  try {
    /* eslint-disable no-restricted-syntax */
    for await (const part of parts) {
      if (part.type !== 'file') {
        fields[part.fieldname] = part.value;
      } else if (!part.filename) {
        part.file.resume();
      } else if (!isObject(fileFields[part.fieldname])) {
        part.file.resume();
      } else {
        const result = await uploadFile(part, fileFields[part.fieldname]);

        if (result.status === 'success') {
          files[part.fieldname] = result.uri;
        } else {
          const resultValidation = result.validation || [{
            column: part.fieldname,
            columnValue: part.filename,
            operator: 'file',
            operatorValue: null,
          }];

          validation.push(...resultValidation.map((entry) => ({
            ...entry,
            column: `${part.fieldname}.${entry.column}`,
          })));
        }
      }
    }
    /* eslint-enable no-restricted-syntax */
  } catch (error) {
    if (error.code !== 'FST_REQ_FILE_TOO_LARGE') {
      throw error;
    }

    const hasSizeError = validation.some((entry) => entry.operator === 'maxSize');
    if (!hasSizeError) {
      validation.push({
        column: 'size',
        columnValue: null,
        operator: 'maxSize',
        operatorValue: toNumber(limits.fileSize) ?? toNumber(process.env.APP_UPLOAD_MAX_SIZE),
      });
    }
  }

  return {
    fields,
    files,
    validation,
  };
}
