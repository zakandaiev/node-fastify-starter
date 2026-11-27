import { FILE_CHECK } from '#enums/file-check.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { camelToSnakeKey } from '#utils/case.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function toEnumName(value) {
  return camelToSnakeKey(value).toUpperCase();
}

describe('FILE_CHECK', () => {
  test('names the operators of the refusals of a file in validation[], which the frontend reads', () => {
    assert.deepEqual(FILE_CHECK, {
      MAX_SIZE: 'maxSize',
      MAX_FILES: 'maxFiles',
      TOTAL_MAX_SIZE: 'totalMaxSize',
      MIME: 'mime',
      IMAGE: 'image',
      MAX_PIXELS: 'maxPixels',
    });
    assert.ok(Object.isFrozen(FILE_CHECK));
  });

  test('every name is its operator in upper snake case', () => {
    Object.entries(FILE_CHECK).forEach(([name, operator]) => assert.equal(name, toEnumName(operator)));
  });
});

describe('IMAGE_PROFILE', () => {
  test('names the profiles of config.upload.image that a route takes for an image field', () => {
    assert.deepEqual(IMAGE_PROFILE, { AVATAR: 'avatar' });
    assert.ok(Object.isFrozen(IMAGE_PROFILE));
  });

  test('every name is its profile in upper snake case', () => {
    Object.entries(IMAGE_PROFILE).forEach(([name, profile]) => assert.equal(name, toEnumName(profile)));
  });
});
