import { createUploadConfig } from '#config/upload.js';
import { IMAGE_INPUT_TYPES } from '#core/image/profile.js';
import { assertUploadConfig, FILE_OPTIONS, readFileOptions } from '#core/upload/options.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { MIME_WHITELIST } from '#utils/mime.js';
import { convertStringToBytes } from '#utils/string.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const UPLOAD = createUploadConfig();
const { AVATAR } = IMAGE_PROFILE;

const PDF = 'application/pdf';
const GIF = 'image/gif';
const SVG = 'image/svg+xml';

const KB = 1024;
const MB = KB * KB;

const AVATAR_FIELD = Object.freeze({ maxSize: '5MB', mime: IMAGE_INPUT_TYPES, image: AVATAR });
const DOCUMENT_FIELD = Object.freeze({ maxSize: '2MB', mime: [PDF] });

const NOT_OBJECTS = [undefined, null, 'files', 1, [], [{ fields: {} }]];
const NOT_COUNTS = [null, 0, -1, 1.5, '2', Number.NaN, Infinity, 2 ** 53];
const NOT_SIZES = [undefined, null, 5, '', '5', '5mb', '5 MiB', '-5MB', 'big'];

const SIZE_MESSAGE = /requires a size with a unit B, KB, MB, GB or TB, such as "5MB": received /;
const OBJECT_MESSAGE = /^"files" requires an object such as \{ fields: \{ avatar: /;
const FIELDS_MESSAGE = /^"files" requires fields, a map of the file fields of the body$/;
const NAME_MESSAGE = /^"files" names the field ".*": a field is named in camelCase, as \^\[a-z\]\[A-Za-z0-9\]\*\$, and never as a key of Object\.prototype, which the parser refuses$/;
const MAX_MESSAGE = /^"files\.fields\.avatar" requires max, when it is given, to be a positive integer$/;
const MIME_LIST_MESSAGE = /^"files\.fields\.avatar" requires mime, a list of distinct types such as \["image\/png"\]$/;
const MAX_FILES_MESSAGE = /^"files" requires maxFiles, when it is given, to be a positive integer$/;

function withField(field, name = 'avatar') {
  return { fields: { [name]: field } };
}

function withUpload(changes) {
  return { ...UPLOAD, ...changes };
}

describe('FILE_OPTIONS', () => {
  test('is a symbol: Fastify copies it with the config of a route, and no author can write it by hand', () => {
    assert.equal(typeof FILE_OPTIONS, 'symbol');
  });
});

describe('assertUploadConfig', () => {
  test('takes the upload section of the app', () => {
    assert.equal(assertUploadConfig(UPLOAD), true);
  });

  test('refuses what is not an object with a storage section', () => {
    [...NOT_OBJECTS, {}, withUpload({ storage: null }), withUpload({ storage: 'local' })].forEach((upload) => {
      assert.throws(() => assertUploadConfig(upload), {
        name: 'TypeError',
        message: 'assertUploadConfig(uploadConfig) requires config.upload with its storage section',
      });
    });
  });

  test('refuses a key nothing reads, such as a misspelt limit', () => {
    assert.throws(() => assertUploadConfig(withUpload({ maxFilesize: '5MB' })), {
      name: 'TypeError',
      message: 'config.upload names "maxFilesize", which nothing reads: it takes storage, maxFileSize, maxTotalSize, maxBodySize, maxPartHeaderSize, maxParts, maxActiveFiles, avatarMaxSize, image',
    });
  });

  test('refuses a maxAge of the storage section that is no duration above zero: the driver does not read it, the static plugin sends it', () => {
    assert.throws(() => assertUploadConfig(withUpload({ storage: { ...UPLOAD.storage, maxAge: '0s' } })), /^TypeError: config\.upload\.storage requires maxAge to be above zero$/);
    [undefined, '365', 365].forEach((maxAge) => {
      assert.throws(() => assertUploadConfig(withUpload({ storage: { ...UPLOAD.storage, maxAge } })), /convertStringToMs\(value\) requires a number with a unit/);
    });
  });

  test('refuses a maxFileSize or a maxTotalSize that is no size above zero, and a file larger than a whole body', () => {
    NOT_SIZES.forEach((size) => {
      assert.throws(() => assertUploadConfig(withUpload({ maxFileSize: size })), { name: 'TypeError', message: SIZE_MESSAGE });
      assert.throws(() => assertUploadConfig(withUpload({ maxTotalSize: size })), { name: 'TypeError', message: SIZE_MESSAGE });
    });
    assert.throws(() => assertUploadConfig(withUpload({ maxFileSize: '0MB' })), /^TypeError: config\.upload\.maxFileSize requires a size above zero$/);
    assert.throws(() => assertUploadConfig(withUpload({ maxFileSize: '11MB', maxTotalSize: '10MB' })), {
      name: 'TypeError',
      message: 'config.upload requires maxFileSize not above maxTotalSize: a body must hold one file of the largest size',
    });
    assert.equal(assertUploadConfig(withUpload({ maxFileSize: '10MB', maxTotalSize: '10MB' })), true);
  });

  test('refuses a maxBodySize, a maxPartHeaderSize or an avatarMaxSize that is no size above zero', () => {
    ['maxBodySize', 'maxPartHeaderSize', 'avatarMaxSize'].forEach((key) => {
      NOT_SIZES.forEach((size) => {
        assert.throws(() => assertUploadConfig(withUpload({ [key]: size })), { name: 'TypeError', message: SIZE_MESSAGE }, `${key}: ${size}`);
      });
      assert.throws(() => assertUploadConfig(withUpload({ [key]: '0KB' })), { name: 'TypeError', message: `config.upload.${key} requires a size above zero` });
    });
  });

  test('refuses a maxBodySize below maxTotalSize, which would cut a body before its files, and an avatarMaxSize above maxFileSize, where the parser would cut the avatar', () => {
    assert.throws(() => assertUploadConfig(withUpload({ maxBodySize: '9MB', maxTotalSize: '10MB' })), {
      name: 'TypeError',
      message: 'config.upload requires maxBodySize not below maxTotalSize: a body must carry the files a route takes',
    });
    assert.throws(() => assertUploadConfig(withUpload({ avatarMaxSize: '11MB', maxFileSize: '10MB' })), {
      name: 'TypeError',
      message: 'config.upload requires avatarMaxSize not above maxFileSize: the parser would cut the avatar there',
    });
    assert.equal(assertUploadConfig(withUpload({ maxBodySize: '10MB', avatarMaxSize: '10MB' })), true);
  });

  test('refuses maxParts and maxActiveFiles that are not positive integers', () => {
    NOT_COUNTS.forEach((count) => {
      ['maxParts', 'maxActiveFiles'].forEach((key) => {
        assert.throws(() => assertUploadConfig(withUpload({ [key]: count })), {
          name: 'TypeError',
          message: 'config.upload requires maxParts and maxActiveFiles to be positive integers',
        }, `${key}: ${count}`);
      });
    });
  });

  test('refuses an image section that assertImageConfig refuses', () => {
    assert.throws(() => assertUploadConfig(withUpload({ image: { ...UPLOAD.image, maxJpegScans: 5 } })), /^TypeError: config\.upload\.image requires maxJpegScans/);
    assert.throws(() => assertUploadConfig(withUpload({ image: undefined })), /^TypeError: assertImageConfig\(imageConfig\) requires config\.upload\.image with its profiles$/);
  });
});

describe('readFileOptions', () => {
  test('gives a frozen copy with sizes in bytes, one file a field and every limit of the body from the fields', () => {
    const options = readFileOptions({ fields: { avatar: AVATAR_FIELD, document: DOCUMENT_FIELD } }, UPLOAD);

    assert.deepEqual(options, {
      fields: {
        avatar: {
          name: 'avatar',
          max: 1,
          maxSize: 5 * MB,
          mime: IMAGE_INPUT_TYPES,
          profile: AVATAR,
        },
        document: {
          name: 'document',
          max: 1,
          maxSize: 2 * MB,
          mime: [PDF],
          profile: null,
        },
      },
      maxFiles: 2,
      totalMaxSize: 7 * MB,
      maxFileSize: 5 * MB,
    });
    assert.ok(isDeepFrozen(options));
  });

  test('counts max files of a field into the defaults of the body, and takes maxFiles and totalMaxSize as they are given', () => {
    const fields = { photos: { ...AVATAR_FIELD, max: 3, maxSize: '512KB' }, document: DOCUMENT_FIELD };

    assert.deepEqual(readFileOptions({ fields }, UPLOAD), {
      ...readFileOptions({ fields, maxFiles: 4, totalMaxSize: '3.5MB' }, UPLOAD),
      maxFiles: 4,
      totalMaxSize: 3.5 * MB,
    });
    assert.deepEqual(readFileOptions({ fields, maxFiles: 2, totalMaxSize: '1MB' }, UPLOAD), {
      ...readFileOptions({ fields }, UPLOAD),
      maxFiles: 2,
      totalMaxSize: MB,
    });
  });

  test('keeps none of the objects of its author: a list it was given changes nothing after the start', () => {
    const mime = [PDF];
    const options = readFileOptions(withField({ maxSize: '1MB', mime }, 'document'), UPLOAD);

    mime.push(GIF);

    assert.deepEqual(options.fields.document.mime, [PDF]);
  });

  test('refuses options that are not an object, a key no upload reads and fields that are not a map with a field', () => {
    NOT_OBJECTS.forEach((files) => {
      assert.throws(() => readFileOptions(files, UPLOAD), { name: 'TypeError', message: OBJECT_MESSAGE });
    });
    assert.throws(() => readFileOptions({ ...withField(AVATAR_FIELD), maxFile: 1 }, UPLOAD), {
      name: 'TypeError',
      message: '"files" names "maxFile", which no upload reads: it takes fields, maxFiles, totalMaxSize',
    });
    [undefined, null, {}, [], [AVATAR_FIELD], 'avatar'].forEach((fields) => {
      assert.throws(() => readFileOptions({ fields }, UPLOAD), { name: 'TypeError', message: FIELDS_MESSAGE });
    });
  });

  test('refuses a field name that is not camelCase, and one of Object.prototype that the parser would refuse', () => {
    ['Avatar', 'avatar_url', 'avatar-url', '1st', '', 'аватар', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'].forEach((name) => {
      assert.throws(() => readFileOptions(withField(AVATAR_FIELD, name), UPLOAD), { name: 'TypeError', message: NAME_MESSAGE }, name);
    });
    assert.doesNotThrow(() => readFileOptions(withField(AVATAR_FIELD, 'coverPhoto2'), UPLOAD));
  });

  test('refuses a field that is not an object, and a key of a field no upload reads', () => {
    NOT_OBJECTS.forEach((field) => {
      assert.throws(() => readFileOptions(withField(field), UPLOAD), {
        name: 'TypeError',
        message: '"files.fields.avatar" requires { maxSize, mime } with an optional max and image',
      });
    });
    assert.throws(() => readFileOptions(withField({ ...AVATAR_FIELD, profile: AVATAR }), UPLOAD), {
      name: 'TypeError',
      message: '"files.fields.avatar" names "profile", which no upload reads: it takes max, maxSize, mime, image',
    });
  });

  test('refuses a max that is not a positive integer', () => {
    NOT_COUNTS.forEach((max) => {
      assert.throws(() => readFileOptions(withField({ ...AVATAR_FIELD, max }), UPLOAD), { name: 'TypeError', message: MAX_MESSAGE }, String(max));
    });
  });

  test('refuses a maxSize that is no size above zero, and one above maxFileSize of the config, where the parser would cut the file', () => {
    NOT_SIZES.forEach((maxSize) => {
      assert.throws(() => readFileOptions(withField({ ...AVATAR_FIELD, maxSize }), UPLOAD), {
        name: 'TypeError',
        message: /^"files\.fields\.avatar\.maxSize" requires a size with a unit B, KB, MB, GB or TB, such as "5MB": received /,
      }, String(maxSize));
    });
    assert.throws(() => readFileOptions(withField({ ...AVATAR_FIELD, maxSize: '0B' }), UPLOAD), /^TypeError: "files\.fields\.avatar\.maxSize" requires a size above zero$/);
    assert.throws(() => readFileOptions(withField({ ...AVATAR_FIELD, maxSize: '11MB' }), UPLOAD), {
      name: 'TypeError',
      message: '"files.fields.avatar" has maxSize above config.upload.maxFileSize, 10 MB: the parser would cut the file there',
    });
    assert.equal(readFileOptions(withField({ ...AVATAR_FIELD, maxSize: UPLOAD.maxFileSize }), UPLOAD).maxFileSize, convertStringToBytes(UPLOAD.maxFileSize));
  });

  test('refuses a mime that is not a list of distinct types', () => {
    [undefined, null, PDF, [], [PDF, PDF], {}].forEach((mime) => {
      assert.throws(() => readFileOptions(withField({ maxSize: '1MB', mime }), UPLOAD), { name: 'TypeError', message: MIME_LIST_MESSAGE });
    });
  });

  test('refuses a type the app does not tell by its bytes, in any spelling but that of the list', () => {
    ['text/plain', SVG, 'image/PNG', 'image/png; q=1', 'application/octet-stream', 1, null].forEach((type) => {
      assert.throws(() => readFileOptions(withField({ maxSize: '1MB', mime: [type] }), UPLOAD), {
        name: 'TypeError',
        message: new RegExp(`^"files\\.fields\\.avatar" names the type .*, which the app does not tell by its bytes: it knows ${MIME_WHITELIST.join(', ')}$`),
      }, String(type));
    });
  });

  test('refuses an image the decoder cannot read, a GIF: every image is encoded again', () => {
    assert.throws(() => readFileOptions(withField({ maxSize: '1MB', mime: [GIF], image: AVATAR }), UPLOAD), {
      name: 'TypeError',
      message: '"files.fields.avatar" names "image/gif", an image the decoder cannot read: it reads image/jpeg, image/png, image/webp only, and every image is encoded again',
    });
  });

  test('refuses images without a profile, a profile without images and a profile the config does not have', () => {
    assert.throws(() => readFileOptions(withField({ maxSize: '1MB', mime: ['image/png', PDF] }), UPLOAD), {
      name: 'TypeError',
      message: '"files.fields.avatar" takes images without a profile to encode them by: give image, one of avatar',
    });
    assert.throws(() => readFileOptions(withField({ ...DOCUMENT_FIELD, image: AVATAR }), UPLOAD), {
      name: 'TypeError',
      message: '"files.fields.avatar" names an image profile, and mime names no image to encode by it',
    });
    ['cover', 'toString', '', null, 1].forEach((image) => {
      assert.throws(() => readFileOptions(withField({ ...AVATAR_FIELD, image }), UPLOAD), {
        name: 'TypeError',
        message: /^"files\.fields\.avatar" names the image profile .*, which config\.upload\.image does not have: it has avatar$/,
      }, String(image));
    });
    assert.equal(readFileOptions(withField({ maxSize: '1MB', mime: ['image/png', PDF], image: AVATAR }), UPLOAD).fields.avatar.profile, AVATAR);
  });

  test('refuses a body that takes more than maxTotalSize of the config, the default sum of its fields too', () => {
    const fields = { photos: { ...AVATAR_FIELD, max: 3 } };

    assert.throws(() => readFileOptions({ fields }, UPLOAD), {
      name: 'TypeError',
      message: '"files" takes 15 MB of files in a body, above config.upload.maxTotalSize, 10 MB: lower totalMaxSize, by default max times maxSize of every field',
    });
    assert.throws(() => readFileOptions({ ...withField(AVATAR_FIELD), totalMaxSize: '11MB' }, UPLOAD), /^TypeError: "files" takes 11 MB of files in a body, above/);
    assert.throws(() => readFileOptions({ ...withField(AVATAR_FIELD), totalMaxSize: '0KB' }, UPLOAD), /^TypeError: "files\.totalMaxSize" requires a size above zero$/);
    assert.throws(() => readFileOptions({ ...withField(AVATAR_FIELD), totalMaxSize: 1024 }, UPLOAD), /^TypeError: "files\.totalMaxSize" requires a size with a unit/);
    assert.equal(readFileOptions({ fields, totalMaxSize: '10MB' }, UPLOAD).totalMaxSize, 10 * MB);
  });

  test('refuses maxFiles that is not a positive integer, or not below maxParts of the config, which would cut the body first', () => {
    NOT_COUNTS.forEach((maxFiles) => {
      assert.throws(() => readFileOptions({ ...withField(AVATAR_FIELD), maxFiles }, UPLOAD), { name: 'TypeError', message: MAX_FILES_MESSAGE }, String(maxFiles));
    });
    assert.throws(() => readFileOptions({ ...withField({ ...DOCUMENT_FIELD, maxSize: '1KB', max: UPLOAD.maxParts }) }, UPLOAD), {
      name: 'TypeError',
      message: `"files" requires maxFiles below config.upload.maxParts, ${UPLOAD.maxParts}: the parts limit would cut the body first`,
    });
    assert.equal(readFileOptions({ ...withField({ ...DOCUMENT_FIELD, maxSize: '1KB', max: UPLOAD.maxParts - 1 }) }, UPLOAD).maxFiles, UPLOAD.maxParts - 1);
  });

  test('requires the upload section of the config with its image profiles', () => {
    [undefined, null, {}, { ...UPLOAD, image: {} }].forEach((upload) => {
      assert.throws(() => readFileOptions(withField(AVATAR_FIELD), upload), {
        name: 'TypeError',
        message: 'readFileOptions(files, uploadConfig) requires config.upload with its image profiles',
      });
    });
  });
});
