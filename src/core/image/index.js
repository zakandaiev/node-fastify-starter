import { getContext } from '#core/context/index.js';
import { hasTooManyJpegScans, readDecodeBytesPerPixel } from '#core/image/header.js';
import { IMAGE_DEFAULT_QUALITY, IMAGE_INPUT_TYPES, IMAGE_OUTPUT_FORMATS } from '#core/image/profile.js';
import { FILE_CHECK } from '#enums/file-check.js';
import { pLimit } from '#utils/async.js';
import { convertStringToSeconds } from '#utils/date.js';
import { detectMime } from '#utils/mime.js';
import { convertStringToBytes } from '#utils/string.js';
import { toString } from '#utils/type.js';
import { inspect } from 'node:util';
import sharp from 'sharp';

// The cache of operations and the threads of libvips only raise the peak of memory. libvips picks a loader by its own
// sniffing: the buffer loaders of JPEG, PNG and WebP alone are left, or it would decode SVG, TIFF, GIF and HEIC too.
sharp.cache(false);
sharp.concurrency(1);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'] });

const DECODES_AT_ONCE = 1;
const FAIL_ON = 'warning';
const RESIZE_FIT = 'inside';
const JPEG_TYPE = IMAGE_OUTPUT_FORMATS.jpeg.mime;

// flatten() of sharp lays an image on black.
const JPEG_BACKGROUND = '#ffffff';

const PNG_COMPRESSION_LEVEL = 9;

// quality, effort or colours would each turn the palette on, and a palette loses colours.
const PNG_OPTIONS = Object.freeze({ compressionLevel: PNG_COMPRESSION_LEVEL, adaptiveFiltering: true, palette: false });

const LINE_BREAK = '\n';
const FAILURE_MESSAGE = 'Image processing failed';
const TIMEOUT_REASON = 'timeout';
const UNEXPECTED_REASON = 'unexpected error';
const TIMEOUT_PREFIX = 'timeout:';
const PIXEL_LIMIT_PREFIX = 'Input image exceeds pixel limit';

// sharp gives no code, only a text: a text not known here is a failure of our own, and an alert.
const INVALID_FILE_PREFIXES = Object.freeze([
  'Input Buffer is empty',
  'Input buffer contains unsupported image format',
  'Input buffer has corrupt header',
  'Input image exceeds channel limit',
  'Warning treated as error due to failOn setting',
  'VipsJpeg:',
  'vipspng:',
  'webp:',
  'webpload',
  'webp2vips:',
  // sharp passes over a broken colour profile: a line of VipsIcc is a decode that failed under the colour transform.
  'VipsIcc:',
]);

const PROCESS_SIGNATURE = 'processImage(bytes, profileName)';

// libvips keeps one queue of warnings for the whole process: two decodes at once would fail on each other's warnings.
const imageQueue = pLimit(DECODES_AT_ONCE);

export function isImageQueueIdle() {
  return imageQueue.activeCount === 0 && imageQueue.pendingCount === 0;
}

function refuse(operator, operatorValue = null) {
  return { refusal: { operator, operatorValue } };
}

// A failure of our own has a text that never changes: the alert of its 500 is deduped by it.
function classifyFailure(error, imageConfig) {
  const [line] = toString(error?.message).split(LINE_BREAK);
  const text = line.trim();

  if (text.startsWith(PIXEL_LIMIT_PREFIX)) {
    return refuse(FILE_CHECK.MAX_PIXELS, imageConfig.maxPixels);
  }

  if (INVALID_FILE_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return refuse(FILE_CHECK.IMAGE);
  }

  const reason = text.startsWith(TIMEOUT_PREFIX)
    ? TIMEOUT_REASON
    : UNEXPECTED_REASON;

  throw new Error(`${FAILURE_MESSAGE}: ${reason}`, { cause: error });
}

function openImage(bytes, imageConfig) {
  return sharp(bytes, { autoOrient: true, failOn: FAIL_ON, limitInputPixels: imageConfig.maxPixels });
}

function encodeWebp(pipeline, quality) {
  return pipeline.webp({ quality });
}

function encodeJpeg(pipeline, quality) {
  return pipeline
    .flatten({ background: JPEG_BACKGROUND })
    .jpeg({ quality, mozjpeg: true });
}

function encodePng(pipeline) {
  return pipeline.png(PNG_OPTIONS);
}

const ENCODERS = Object.freeze({
  webp: encodeWebp,
  jpeg: encodeJpeg,
  png: encodePng,
});

// The pixels a decode may hold whole within maxDecodeBytes; one that streams is held by maxPixels alone.
function readPixelLimit(metadata, bytes, imageConfig) {
  const bytesPerPixel = readDecodeBytesPerPixel(metadata, bytes);

  return bytesPerPixel > 0
    ? Math.min(imageConfig.maxPixels, Math.floor(convertStringToBytes(imageConfig.maxDecodeBytes) / bytesPerPixel))
    : imageConfig.maxPixels;
}

// No metadata is kept: the EXIF of a photo carries the place it was taken.
async function encodeImage(bytes, profile, imageConfig) {
  const { format, quality = IMAGE_DEFAULT_QUALITY, maxSize } = profile;
  const { mime, extension } = IMAGE_OUTPUT_FORMATS[format];
  const pipeline = openImage(bytes, imageConfig)
    .timeout({ seconds: convertStringToSeconds(imageConfig.timeout) })
    .resize({
      width: maxSize,
      height: maxSize,
      fit: RESIZE_FIT,
      withoutEnlargement: true,
    });
  const { data, info } = await ENCODERS[format](pipeline, quality).toBuffer({ resolveWithObject: true });

  return {
    image: {
      bytes: data,
      mime,
      extension,
      width: info.width,
      height: info.height,
    },
  };
}

async function decodeImage(bytes, { mime, profile, imageConfig }) {
  try {
    const metadata = await openImage(bytes, imageConfig).metadata();

    // The magic bytes and the loader of libvips must name one format: when they do not, the file is forged.
    if (IMAGE_OUTPUT_FORMATS[metadata.format]?.mime !== mime) {
      return refuse(FILE_CHECK.IMAGE);
    }

    const pixelLimit = readPixelLimit(metadata, bytes, imageConfig);

    if (metadata.width * metadata.height > pixelLimit) {
      return refuse(FILE_CHECK.MAX_PIXELS, pixelLimit);
    }

    return await encodeImage(bytes, profile, imageConfig);
  } catch (error) {
    return classifyFailure(error, imageConfig);
  }
}

function readProfile(imageConfig, profileName) {
  if (!Object.hasOwn(imageConfig.profiles, profileName)) {
    throw new TypeError(`${PROCESS_SIGNATURE} requires the name of a profile of config.upload.image: received ${inspect(profileName)}`);
  }

  return imageConfig.profiles[profileName];
}

export async function processImage(bytes, profileName) {
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError(`${PROCESS_SIGNATURE} requires the bytes of the file in a Buffer`);
  }

  const imageConfig = getContext().config.upload.image;
  const profile = readProfile(imageConfig, profileName);
  const mime = detectMime(bytes);

  if (!IMAGE_INPUT_TYPES.includes(mime)) {
    return refuse(FILE_CHECK.IMAGE);
  }

  if (mime === JPEG_TYPE && hasTooManyJpegScans(bytes, imageConfig.maxJpegScans)) {
    return refuse(FILE_CHECK.IMAGE);
  }

  return imageQueue(() => decodeImage(bytes, { mime, profile, imageConfig }));
}
