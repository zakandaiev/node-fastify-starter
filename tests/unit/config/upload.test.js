import { createConfig } from '#config/index.js';
import { absPath } from '#config/path.js';
import { createUploadConfig } from '#config/upload.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { createTestEnv } from '#root/tests/helper/config.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { convertStringToMs } from '#utils/date.js';
import { convertStringToBytes } from '#utils/string.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const JPEG_SCANS_MIN = 20;

describe('config.upload', () => {
  test('takes nothing from env: it is the same in every mode', () => {
    const upload = createUploadConfig();

    assert.deepEqual(createConfig(createTestEnv({ APP_MODE: 'prod' })).upload, upload);
    assert.deepEqual(createConfig(createTestEnv({ APP_MODE: 'dev' })).upload, upload);
  });

  test('is frozen together with its sections and its profiles', () => {
    assert.ok(isDeepFrozen(createUploadConfig()));
  });

  test('stores the files in upload/ of the project through the local driver', () => {
    const { storage } = createUploadConfig();

    assert.equal(storage.driver, 'local');
    assert.equal(storage.root, absPath.upload);
  });

  test('serves the files at /upload/, outside the prefixes whose routes must meet the route contract and outside the docs', () => {
    const { app, upload } = createConfig(createTestEnv());
    const { publicPath } = upload.storage;

    assert.equal(publicPath, '/upload/');
    [app.apiPrefix, app.healthPrefix, app.docsPrefix].forEach((prefix) => {
      assert.equal(publicPath.startsWith(`${prefix}/`), false, prefix);
    });
  });

  test('keeps the sizes as text with a unit, and a body takes at least one file of the largest size', () => {
    const {
      maxFileSize,
      maxTotalSize,
      maxBodySize,
      maxPartHeaderSize,
      avatarMaxSize,
      image,
    } = createUploadConfig();

    [maxFileSize, maxTotalSize, maxBodySize, maxPartHeaderSize, avatarMaxSize, image.maxDecodeBytes].forEach((size) => assert.ok(convertStringToBytes(size) > 0, size));
    assert.ok(convertStringToBytes(maxTotalSize) >= convertStringToBytes(maxFileSize));
  });

  test('reads a form up to 12 MB, more than its files with their text, and takes an avatar of up to 5 MB, within a file of the largest size', () => {
    const {
      maxFileSize,
      maxTotalSize,
      maxBodySize,
      avatarMaxSize,
    } = createUploadConfig();

    assert.deepEqual([maxBodySize, avatarMaxSize], ['12MB', '5MB']);
    assert.ok(convertStringToBytes(maxBodySize) > convertStringToBytes(maxTotalSize));
    assert.ok(convertStringToBytes(avatarMaxSize) <= convertStringToBytes(maxFileSize));
  });

  test('keeps the durations as text with a unit', () => {
    const { storage, image } = createUploadConfig();

    [storage.maxAge, image.timeout].forEach((duration) => assert.ok(convertStringToMs(duration) > 0, duration));
  });

  test('counts the parts of a body, the files at work, the pixels of an image and the scans of a JPEG in positive integers', () => {
    const { maxParts, maxActiveFiles, image } = createUploadConfig();

    [maxParts, maxActiveFiles, image.maxPixels, image.maxJpegScans].forEach((count) => {
      assert.ok(Number.isSafeInteger(count) && count > 0, String(count));
    });
  });

  test('never caps the scans of a JPEG below those of a real photo', () => {
    assert.ok(createUploadConfig().image.maxJpegScans >= JPEG_SCANS_MIN);
  });

  test('describes every profile of IMAGE_PROFILE, and no other', () => {
    const { profiles } = createUploadConfig().image;

    assert.deepEqual(Object.keys(profiles).toSorted(), Object.values(IMAGE_PROFILE).toSorted());
  });

  test('turns an avatar into a WebP of at most 512 pixels a side', () => {
    assert.deepEqual(createUploadConfig().image.profiles[IMAGE_PROFILE.AVATAR], { format: 'webp', quality: 80, maxSize: 512 });
  });
});
