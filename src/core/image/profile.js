import { assertDurations, convertStringToSeconds } from '#utils/date.js';
import { extFromMime } from '#utils/mime.js';
import { findUnknownKey, freezeDeep, mapValues } from '#utils/object.js';
import { convertStringToBytes } from '#utils/string.js';
import { isObject, isPositiveInteger } from '#utils/type.js';

export const IMAGE_INPUT_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

// Keyed by the names sharp gives the formats, in metadata().format and in its encoders.
const OUTPUT_TYPES = Object.freeze({
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
});

export const IMAGE_OUTPUT_FORMATS = freezeDeep(mapValues(OUTPUT_TYPES, (mime) => ({ mime, extension: extFromMime(mime) })));

export const IMAGE_DEFAULT_QUALITY = 80;

const QUALITY_MAX = 100;

// A WebP holds no longer side.
const SIZE_MAX = 16383;

// A real progressive JPEG has up to about 18 scans: a lower cap refuses photos.
const JPEG_SCANS_MIN = 20;

// The longest timeout() of sharp, which counts it in whole seconds.
const TIMEOUT_MAX_SECONDS = 3600;

const PROFILE_KEYS = Object.freeze(['format', 'quality', 'maxSize']);
const CONFIG_KEYS = Object.freeze(['maxPixels', 'maxDecodeBytes', 'maxJpegScans', 'timeout', 'profiles']);
const DURATION_KEYS = Object.freeze(['timeout']);

const CONFIG_NAME = 'config.upload.image';

function isOptionalQuality(quality) {
  return quality === undefined || (isPositiveInteger(quality) && quality <= QUALITY_MAX);
}

export function assertImageProfile(profile, label = 'assertImageProfile(profile)') {
  if (!isObject(profile)) {
    throw new TypeError(`${label} requires a profile { format, quality, maxSize }`);
  }

  const unknownKey = findUnknownKey(profile, PROFILE_KEYS);

  if (unknownKey !== undefined) {
    throw new TypeError(`${label} names "${unknownKey}", which no encoder reads: it takes ${PROFILE_KEYS.join(', ')}`);
  }

  if (!Object.hasOwn(IMAGE_OUTPUT_FORMATS, profile.format)) {
    throw new TypeError(`${label} requires format, one of ${Object.keys(IMAGE_OUTPUT_FORMATS).join(', ')}`);
  }

  if (!isOptionalQuality(profile.quality)) {
    throw new TypeError(`${label} requires quality, when it is given, to be an integer from 1 to ${QUALITY_MAX}`);
  }

  if (!(isPositiveInteger(profile.maxSize) && profile.maxSize <= SIZE_MAX)) {
    throw new TypeError(`${label} requires maxSize, the longest side in pixels, to be an integer from 1 to ${SIZE_MAX}`);
  }

  return true;
}

function assertTimeout(imageConfig) {
  assertDurations(imageConfig, DURATION_KEYS, CONFIG_NAME);

  const seconds = convertStringToSeconds(imageConfig.timeout);

  if (!Number.isInteger(seconds) || seconds > TIMEOUT_MAX_SECONDS) {
    throw new TypeError(`${CONFIG_NAME} requires timeout in whole seconds, at most ${TIMEOUT_MAX_SECONDS}s, as sharp counts it`);
  }
}

// At the start: a limit nobody can read would show itself only on the first upload, as a 500.
export function assertImageConfig(imageConfig) {
  if (!isObject(imageConfig) || !isObject(imageConfig.profiles)) {
    throw new TypeError(`assertImageConfig(imageConfig) requires ${CONFIG_NAME} with its profiles`);
  }

  const unknownKey = findUnknownKey(imageConfig, CONFIG_KEYS);

  if (unknownKey !== undefined) {
    throw new TypeError(`${CONFIG_NAME} names "${unknownKey}", which nothing reads: it takes ${CONFIG_KEYS.join(', ')}`);
  }

  if (!isPositiveInteger(imageConfig.maxPixels)) {
    throw new TypeError(`${CONFIG_NAME} requires maxPixels to be a positive integer`);
  }

  if (!(convertStringToBytes(imageConfig.maxDecodeBytes) > 0)) {
    throw new TypeError(`${CONFIG_NAME} requires maxDecodeBytes to be above zero`);
  }

  if (!(isPositiveInteger(imageConfig.maxJpegScans) && imageConfig.maxJpegScans >= JPEG_SCANS_MIN)) {
    throw new TypeError(`${CONFIG_NAME} requires maxJpegScans to be an integer of at least ${JPEG_SCANS_MIN}, the scans of a real photo`);
  }

  assertTimeout(imageConfig);
  Object.entries(imageConfig.profiles).forEach(([name, profile]) => assertImageProfile(profile, `${CONFIG_NAME}.profiles.${name}`));

  return true;
}
