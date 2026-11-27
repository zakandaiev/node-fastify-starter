import { createUploadConfig } from '#config/upload.js';
import {
  IMAGE_DEFAULT_QUALITY,
  IMAGE_INPUT_TYPES,
  IMAGE_OUTPUT_FORMATS,
  assertImageConfig,
  assertImageProfile,
} from '#core/image/profile.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { MIME_WHITELIST, extFromMime } from '#utils/mime.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const IMAGE = createUploadConfig().image;
const PROFILE = Object.freeze({ format: 'webp', quality: 80, maxSize: 512 });
const LABEL = 'config.upload.image.profiles.avatar';

const QUALITY_MAX = 100;
const SIZE_MAX = 16383;
const JPEG_SCANS_MIN = 20;
const ABOVE_SAFE_INTEGER = 2 ** 53;

const NOT_OBJECTS = [undefined, null, 'webp', 42, [], [PROFILE]];
const NOT_FORMATS = [undefined, null, '', 'gif', 'avif', 'source', 'WEBP', 'jpg', 'constructor', 1];
const NOT_QUALITIES = [null, 0, -1, 101, 1.5, '80', Number.NaN, Infinity];
const NOT_SIZES = [undefined, null, 0, -1, 16384, 1.5, '512', Number.NaN, Infinity];
const NOT_COUNTS = [undefined, null, 0, -1, 1.5, '100', Number.NaN, Infinity, ABOVE_SAFE_INTEGER];
const NOT_SCAN_CAPS = [...NOT_COUNTS, JPEG_SCANS_MIN - 1, JPEG_SCANS_MIN + 0.5];
const NOT_SIZE_TEXTS = [undefined, null, 100, '', 'big', '5', '5mb', '5 MiB', '-5MB'];
const NOT_DURATIONS = [undefined, null, 20, '', '20', '20ms', '20 s'];
const NOT_POSITIVE_DURATIONS = ['0s', '-1s', '0m'];
const NOT_TIMEOUTS = ['1.5s', '0.5s', '1.01m', '3601s', '2h', '1d'];

const FORMAT_MESSAGE = /^config\.upload\.image\.profiles\.avatar requires format, one of webp, jpeg, png$/;
const QUALITY_MESSAGE = /^config\.upload\.image\.profiles\.avatar requires quality, when it is given, to be an integer from 1 to 100$/;
const SIZE_MESSAGE = /^config\.upload\.image\.profiles\.avatar requires maxSize, the longest side in pixels, to be an integer from 1 to 16383$/;

const SECTION_MESSAGE = /^assertImageConfig\(imageConfig\) requires config\.upload\.image with its profiles$/;
const PIXELS_MESSAGE = /^config\.upload\.image requires maxPixels to be a positive integer$/;
const BYTES_MESSAGE = /^convertStringToBytes\(value\) requires a non-negative number with a unit B, KB, MB, GB or TB/;
const ZERO_BYTES_MESSAGE = /^config\.upload\.image requires maxDecodeBytes to be above zero$/;
const SCANS_MESSAGE = /^config\.upload\.image requires maxJpegScans to be an integer of at least 20, the scans of a real photo$/;
const DURATION_MESSAGE = /^convertStringToMs\(value\) requires a number with a unit s, m, h, d or w/;
const ZERO_DURATION_MESSAGE = /^config\.upload\.image requires timeout to be above zero$/;
const TIMEOUT_MESSAGE = /^config\.upload\.image requires timeout in whole seconds, at most 3600s, as sharp counts it$/;

function objectMessage(label) {
  return `${label} requires a profile { format, quality, maxSize }`;
}

function withProfile(changes) {
  return { ...PROFILE, ...changes };
}

function withImage(changes) {
  return { ...IMAGE, ...changes };
}

function assertProfileRefused(profiles, message) {
  profiles.forEach((profile) => assert.throws(() => assertImageProfile(profile, LABEL), { name: 'TypeError', message }));
}

function assertConfigRefused(sections, message) {
  sections.forEach((section) => assert.throws(() => assertImageConfig(section), { name: 'TypeError', message }));
}

function cross(key, values) {
  return values.map((value) => ({ [key]: value }));
}

describe('IMAGE_INPUT_TYPES', () => {
  test('names what the decoder reads: JPEG, PNG and WebP, each a type of the whitelist', () => {
    assert.deepEqual(IMAGE_INPUT_TYPES, ['image/jpeg', 'image/png', 'image/webp']);
    assert.ok(Object.isFrozen(IMAGE_INPUT_TYPES));
    IMAGE_INPUT_TYPES.forEach((type) => assert.ok(MIME_WHITELIST.includes(type), type));
  });
});

describe('IMAGE_OUTPUT_FORMATS', () => {
  test('names each format sharp writes with its type and the extension the whitelist gives that type', () => {
    assert.deepEqual({ ...IMAGE_OUTPUT_FORMATS }, {
      webp: { mime: 'image/webp', extension: 'webp' },
      jpeg: { mime: 'image/jpeg', extension: 'jpg' },
      png: { mime: 'image/png', extension: 'png' },
    });
    assert.ok(isDeepFrozen(IMAGE_OUTPUT_FORMATS));
    Object.values(IMAGE_OUTPUT_FORMATS).forEach(({ mime, extension }) => assert.equal(extension, extFromMime(mime)));
  });
});

describe('assertImageProfile', () => {
  test('accepts every profile of the config, one without quality, and the bounds of quality and maxSize', () => {
    const profiles = [
      ...Object.values(IMAGE.profiles),
      ...Object.keys(IMAGE_OUTPUT_FORMATS).map((format) => withProfile({ format })),
      { format: 'png', maxSize: 1 },
      withProfile({ quality: 1, maxSize: SIZE_MAX }),
      withProfile({ quality: QUALITY_MAX }),
    ];

    profiles.forEach((profile) => assert.equal(assertImageProfile(profile, LABEL), true));
  });

  test('takes 80 for the quality a profile leaves out', () => {
    assert.equal(IMAGE_DEFAULT_QUALITY, 80);
  });

  test('refuses what is not a profile, naming the label, or its own signature without one', () => {
    assertProfileRefused(NOT_OBJECTS, objectMessage(LABEL));
    assert.throws(() => assertImageProfile(null), { name: 'TypeError', message: objectMessage('assertImageProfile(profile)') });
  });

  test('refuses a key no encoder reads', () => {
    ['thumbnail', 'width', 'Format', 'lossless'].forEach((key) => {
      assert.throws(() => assertImageProfile(withProfile({ [key]: 1 }), LABEL), {
        name: 'TypeError',
        message: `${LABEL} names "${key}", which no encoder reads: it takes format, quality, maxSize`,
      });
    });
  });

  test('refuses a format sharp does not write for a profile', () => {
    assertProfileRefused(cross('format', NOT_FORMATS).map(withProfile), FORMAT_MESSAGE);
  });

  test('refuses a quality that is not an integer from 1 to 100', () => {
    assertProfileRefused(cross('quality', NOT_QUALITIES).map(withProfile), QUALITY_MESSAGE);
  });

  test('refuses a maxSize that is missing or not an integer from 1 to 16383', () => {
    assertProfileRefused(cross('maxSize', NOT_SIZES).map(withProfile), SIZE_MESSAGE);
  });
});

describe('assertImageConfig', () => {
  test('accepts the section of the config', () => {
    assert.equal(assertImageConfig(IMAGE), true);
  });

  test('accepts the bounds: a scan cap of 20, a timeout from a second to an hour, a byte of budget, no profiles at all', () => {
    const sections = [
      { maxJpegScans: JPEG_SCANS_MIN },
      { timeout: '1s' },
      { timeout: '1h' },
      { timeout: '1.5m' },
      { maxDecodeBytes: '1B' },
      { maxPixels: 1 },
      { profiles: {} },
    ];

    sections.forEach((changes) => assert.equal(assertImageConfig(withImage(changes)), true));
  });

  test('refuses what is not the section with its profiles', () => {
    assertConfigRefused([...NOT_OBJECTS, {}, withImage({ profiles: null }), withImage({ profiles: [] })], SECTION_MESSAGE);
  });

  test('refuses a key nothing reads', () => {
    assert.throws(() => assertImageConfig(withImage({ maxMegapixels: 70 })), {
      name: 'TypeError',
      message: 'config.upload.image names "maxMegapixels", which nothing reads: it takes maxPixels, maxDecodeBytes, maxJpegScans, timeout, profiles',
    });
  });

  test('refuses a cap of pixels that is not a positive integer', () => {
    assertConfigRefused(cross('maxPixels', NOT_COUNTS).map(withImage), PIXELS_MESSAGE);
  });

  test('refuses a decode budget nobody can read, or of zero bytes', () => {
    assertConfigRefused(cross('maxDecodeBytes', NOT_SIZE_TEXTS).map(withImage), BYTES_MESSAGE);
    assertConfigRefused(cross('maxDecodeBytes', ['0B', '0MB', '0.0001B']).map(withImage), ZERO_BYTES_MESSAGE);
  });

  test('refuses a cap of scans below that of a real photo, or not an integer', () => {
    assertConfigRefused(cross('maxJpegScans', NOT_SCAN_CAPS).map(withImage), SCANS_MESSAGE);
  });

  test('refuses a timeout nobody can read, one not above zero, a part of a second and one past an hour', () => {
    assertConfigRefused(cross('timeout', NOT_DURATIONS).map(withImage), DURATION_MESSAGE);
    assertConfigRefused(cross('timeout', NOT_POSITIVE_DURATIONS).map(withImage), ZERO_DURATION_MESSAGE);
    assertConfigRefused(cross('timeout', NOT_TIMEOUTS).map(withImage), TIMEOUT_MESSAGE);
  });

  test('refuses a profile that is refused, naming it', () => {
    const profiles = { [IMAGE_PROFILE.AVATAR]: withProfile({ format: 'gif' }) };

    assertConfigRefused([withImage({ profiles })], FORMAT_MESSAGE);
    assertConfigRefused([withImage({ profiles: { banner: null } })], objectMessage('config.upload.image.profiles.banner'));
  });
});
