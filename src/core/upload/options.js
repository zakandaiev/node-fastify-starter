import { assertImageConfig, IMAGE_INPUT_TYPES } from '#core/image/profile.js';
import { assertDurations } from '#utils/date.js';
import { MIME_WHITELIST } from '#utils/mime.js';
import { findUnknownKey, freezeDeep } from '#utils/object.js';
import { convertStringToBytes, formatBytes } from '#utils/string.js';
import {
  isNonEmptyArray,
  isNonEmptyObject,
  isObject,
  isPositiveInteger,
  isString,
} from '#utils/type.js';
import { inspect } from 'node:util';

// The key of the options of a route with files in its config: Fastify copies the config of a route, symbols included,
// and a key nobody can name is never written by hand.
export const FILE_OPTIONS = Symbol('file options');

const CONFIG_NAME = 'config.upload';
const CONFIG_KEYS = Object.freeze([
  'storage',
  'maxFileSize',
  'maxTotalSize',
  'maxBodySize',
  'maxPartHeaderSize',
  'maxParts',
  'maxActiveFiles',
  'avatarMaxSize',
  'image',
]);
const STORAGE_DURATION_KEYS = Object.freeze(['maxAge']);

const FILES_LABEL = '"files"';
const FILES_KEYS = Object.freeze(['fields', 'maxFiles', 'totalMaxSize']);
const FIELD_KEYS = Object.freeze(['max', 'maxSize', 'mime', 'image']);
const DEFAULT_MAX = 1;

// The name of a field of the API. The parser refuses a part named as a key of Object.prototype ("constructor").
const FIELD_NAME_REGEXP = /^[a-z][A-Za-z0-9]*$/;

const IMAGE_TYPE_PREFIX = 'image/';

function toBytes(value, label) {
  try {
    return convertStringToBytes(value);
  } catch (error) {
    throw new TypeError(`${label} requires a size with a unit B, KB, MB, GB or TB, such as "5MB": received ${inspect(value)}`, { cause: error });
  }
}

function readSize(value, label) {
  const bytes = toBytes(value, label);

  if (bytes === 0) {
    throw new TypeError(`${label} requires a size above zero`);
  }

  return bytes;
}

function readConfigSize(uploadConfig, key) {
  return readSize(uploadConfig[key], `${CONFIG_NAME}.${key}`);
}

function assertConfigSizes(uploadConfig) {
  const maxFileSize = readConfigSize(uploadConfig, 'maxFileSize');
  const maxTotalSize = readConfigSize(uploadConfig, 'maxTotalSize');
  const maxBodySize = readConfigSize(uploadConfig, 'maxBodySize');
  const avatarMaxSize = readConfigSize(uploadConfig, 'avatarMaxSize');

  readConfigSize(uploadConfig, 'maxPartHeaderSize');

  if (maxFileSize > maxTotalSize) {
    throw new TypeError(`${CONFIG_NAME} requires maxFileSize not above maxTotalSize: a body must hold one file of the largest size`);
  }

  if (maxBodySize < maxTotalSize) {
    throw new TypeError(`${CONFIG_NAME} requires maxBodySize not below maxTotalSize: a body must carry the files a route takes`);
  }

  if (avatarMaxSize > maxFileSize) {
    throw new TypeError(`${CONFIG_NAME} requires avatarMaxSize not above maxFileSize: the parser would cut the avatar there`);
  }
}

function assertConfigCounts(uploadConfig) {
  if (!isPositiveInteger(uploadConfig.maxParts) || !isPositiveInteger(uploadConfig.maxActiveFiles)) {
    throw new TypeError(`${CONFIG_NAME} requires maxParts and maxActiveFiles to be positive integers`);
  }
}

// At the start: a limit nobody can read would show itself only on the first upload, as a 500. The storage section is the
// driver's to check, all but maxAge, which the static plugin sends.
export function assertUploadConfig(uploadConfig) {
  if (!isObject(uploadConfig) || !isObject(uploadConfig.storage)) {
    throw new TypeError(`assertUploadConfig(uploadConfig) requires ${CONFIG_NAME} with its storage section`);
  }

  const unknownKey = findUnknownKey(uploadConfig, CONFIG_KEYS);

  if (unknownKey !== undefined) {
    throw new TypeError(`${CONFIG_NAME} names "${unknownKey}", which nothing reads: it takes ${CONFIG_KEYS.join(', ')}`);
  }

  assertDurations(uploadConfig.storage, STORAGE_DURATION_KEYS, `${CONFIG_NAME}.storage`);
  assertConfigSizes(uploadConfig);
  assertConfigCounts(uploadConfig);
  assertImageConfig(uploadConfig.image);

  return true;
}

function readLimits(uploadConfig) {
  if (!isObject(uploadConfig) || !isObject(uploadConfig.image?.profiles)) {
    throw new TypeError(`readFileOptions(files, uploadConfig) requires ${CONFIG_NAME} with its image profiles`);
  }

  return {
    maxFileSize: toBytes(uploadConfig.maxFileSize, `${CONFIG_NAME}.maxFileSize`),
    maxTotalSize: toBytes(uploadConfig.maxTotalSize, `${CONFIG_NAME}.maxTotalSize`),
    maxParts: uploadConfig.maxParts,
    profiles: uploadConfig.image.profiles,
  };
}

function assertFieldName(name) {
  if (!FIELD_NAME_REGEXP.test(name) || name in Object.prototype) {
    throw new TypeError(`${FILES_LABEL} names the field "${name}": a field is named in camelCase, as ${FIELD_NAME_REGEXP.source}, and never as a key of Object.prototype, which the parser refuses`);
  }
}

function assertMimeType(type, label) {
  if (!MIME_WHITELIST.includes(type)) {
    throw new TypeError(`${label} names the type ${inspect(type)}, which the app does not tell by its bytes: it knows ${MIME_WHITELIST.join(', ')}`);
  }

  if (type.startsWith(IMAGE_TYPE_PREFIX) && !IMAGE_INPUT_TYPES.includes(type)) {
    throw new TypeError(`${label} names "${type}", an image the decoder cannot read: it reads ${IMAGE_INPUT_TYPES.join(', ')} only, and every image is encoded again`);
  }
}

function readMime(mime, label) {
  if (!isNonEmptyArray(mime) || new Set(mime).size !== mime.length) {
    throw new TypeError(`${label} requires mime, a list of distinct types such as ["image/png"]`);
  }

  mime.forEach((type) => assertMimeType(type, label));

  return [...mime];
}

function readProfile(image, mime, { label, profiles }) {
  const isImageField = mime.some((type) => IMAGE_INPUT_TYPES.includes(type));
  const names = Object.keys(profiles).join(', ');

  if (image === undefined) {
    if (isImageField) {
      throw new TypeError(`${label} takes images without a profile to encode them by: give image, one of ${names}`);
    }

    return null;
  }

  if (!isImageField) {
    throw new TypeError(`${label} names an image profile, and mime names no image to encode by it`);
  }

  if (!isString(image) || !Object.hasOwn(profiles, image)) {
    throw new TypeError(`${label} names the image profile ${inspect(image)}, which ${CONFIG_NAME}.image does not have: it has ${names}`);
  }

  return image;
}

function readField(name, field, limits) {
  const label = `"files.fields.${name}"`;

  assertFieldName(name);

  if (!isObject(field)) {
    throw new TypeError(`${label} requires { maxSize, mime } with an optional max and image`);
  }

  const unknownKey = findUnknownKey(field, FIELD_KEYS);

  if (unknownKey !== undefined) {
    throw new TypeError(`${label} names "${unknownKey}", which no upload reads: it takes ${FIELD_KEYS.join(', ')}`);
  }

  const max = field.max === undefined
    ? DEFAULT_MAX
    : field.max;

  if (!isPositiveInteger(max)) {
    throw new TypeError(`${label} requires max, when it is given, to be a positive integer`);
  }

  const maxSize = readSize(field.maxSize, `"files.fields.${name}.maxSize"`);

  if (maxSize > limits.maxFileSize) {
    throw new TypeError(`${label} has maxSize above ${CONFIG_NAME}.maxFileSize, ${formatBytes(limits.maxFileSize)}: the parser would cut the file there`);
  }

  const mime = readMime(field.mime, label);

  return {
    name,
    max,
    maxSize,
    mime,
    profile: readProfile(field.image, mime, { label, profiles: limits.profiles }),
  };
}

function readMaxFiles(maxFiles, fields, limits) {
  const count = maxFiles === undefined
    ? fields.reduce((sum, field) => sum + field.max, 0)
    : maxFiles;

  if (!isPositiveInteger(count)) {
    throw new TypeError(`${FILES_LABEL} requires maxFiles, when it is given, to be a positive integer`);
  }

  if (count >= limits.maxParts) {
    throw new TypeError(`${FILES_LABEL} requires maxFiles below ${CONFIG_NAME}.maxParts, ${limits.maxParts}: the parts limit would cut the body first`);
  }

  return count;
}

function readTotalMaxSize(totalMaxSize, fields, limits) {
  const total = totalMaxSize === undefined
    ? fields.reduce((sum, field) => sum + field.max * field.maxSize, 0)
    : readSize(totalMaxSize, '"files.totalMaxSize"');

  if (total > limits.maxTotalSize) {
    throw new TypeError(`${FILES_LABEL} takes ${formatBytes(total)} of files in a body, above ${CONFIG_NAME}.maxTotalSize, ${formatBytes(limits.maxTotalSize)}: lower totalMaxSize, by default max times maxSize of every field`);
  }

  return total;
}

function readFields(files, limits) {
  if (!isObject(files)) {
    throw new TypeError(`${FILES_LABEL} requires an object such as { fields: { avatar: { maxSize: "5MB", mime: ["image/png"], image: "avatar" } } }`);
  }

  const unknownKey = findUnknownKey(files, FILES_KEYS);

  if (unknownKey !== undefined) {
    throw new TypeError(`${FILES_LABEL} names "${unknownKey}", which no upload reads: it takes ${FILES_KEYS.join(', ')}`);
  }

  if (!isNonEmptyObject(files.fields)) {
    throw new TypeError(`${FILES_LABEL} requires fields, a map of the file fields of the body`);
  }

  return Object.entries(files.fields).map(([name, field]) => readField(name, field, limits));
}

// Sizes in bytes; maxFileSize is the largest maxSize of a field, where the parser cuts a file of the route.
export function readFileOptions(files, uploadConfig) {
  const limits = readLimits(uploadConfig);
  const fields = readFields(files, limits);

  return freezeDeep({
    fields: Object.fromEntries(fields.map((field) => [field.name, field])),
    maxFiles: readMaxFiles(files.maxFiles, fields, limits),
    totalMaxSize: readTotalMaxSize(files.totalMaxSize, fields, limits),
    maxFileSize: Math.max(...fields.map((field) => field.maxSize)),
  });
}
