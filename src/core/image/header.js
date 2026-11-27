import { isObject, isPositiveInteger } from '#utils/type.js';

const MARKER_PREFIX = 0xFF;
const STUFFED_BYTE = 0x00;
const TEM = 0x01;
const RST0 = 0xD0;
const SOI = 0xD8;
const EOI = 0xD9;
const SOS = 0xDA;
const SOI_BYTES = 2;
const LENGTH_BYTES = 2;

// SOF0-3, SOF5-7, SOF9-11 and SOF13-15: the codes between them are DHT, JPG and DAC.
const SOF_CODES = Object.freeze([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);

// An SOF after its code: the length, the precision, the height and the width, the count of components, then for each
// component its id, a byte of its sampling factors with the horizontal one in the high four bits, and its table.
const COUNT_OFFSET = 7;
const COMPONENTS_OFFSET = 8;
const COMPONENT_BYTES = 3;
const FACTORS_OFFSET = 1;
const NIBBLE_VALUES = 16;
const MIN_FACTOR = 1;
const MAX_FACTOR = 4;

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const FOURCC_BYTES = 4;
const FOURCC_ENCODING = 'latin1';
const CHUNK_ALIGNMENT = 2;
const LOSSY_CHUNK = 'VP8 ';
const FULL_FRAME_CHUNKS = Object.freeze(['VP8L', 'ALPH']);

const STREAMED = 0;
const COEFFICIENT_BYTES = 2;
const SAMPLE_BYTES = 1;
const WIDE_SAMPLE_BYTES = 2;
const WIDE_DEPTH = 'ushort';
const RGBA_BYTES = 4;

const SCANS_SIGNATURE = 'hasTooManyJpegScans(bytes, maxScans)';
const DECODE_SIGNATURE = 'readDecodeBytesPerPixel(metadata, bytes)';

function isStandaloneCode(code) {
  return code === STUFFED_BYTE || code === TEM || (code >= RST0 && code <= SOI);
}

// As libjpeg finds a marker: a run of 0xFF is fill, 0xFF00 is a byte of data, and RST0-7, TEM and SOI have no length.
// A byte that is no marker is passed over rather than ending the count: bytes written in would lead past the cap.
function findNextMarker(bytes, start) {
  let index = bytes.indexOf(MARKER_PREFIX, start);

  while (index !== -1) {
    let codeIndex = index + 1;

    while (bytes[codeIndex] === MARKER_PREFIX) {
      codeIndex += 1;
    }

    if (codeIndex >= bytes.length) {
      return -1;
    }

    if (!isStandaloneCode(bytes[codeIndex])) {
      return codeIndex;
    }

    index = bytes.indexOf(MARKER_PREFIX, codeIndex + 1);
  }

  return -1;
}

// The index of the code of the marker of one of these codes that comes after skipCount others of them, or -1. A segment
// is passed over by its length, as the thumbnail in EXIF is a JPEG with markers of its own; past the first EOI libvips
// decodes nothing.
function findMarker(bytes, codes, skipCount = 0) {
  let foundCount = 0;
  let codeIndex = findNextMarker(bytes, SOI_BYTES);

  while (codeIndex !== -1 && codeIndex + LENGTH_BYTES < bytes.length && bytes[codeIndex] !== EOI) {
    if (codes.includes(bytes[codeIndex])) {
      foundCount += 1;
    }

    if (foundCount > skipCount) {
      return codeIndex;
    }

    codeIndex = findNextMarker(bytes, codeIndex + 1 + bytes.readUInt16BE(codeIndex + 1));
  }

  return -1;
}

// libvips does not cap the scans of a progressive JPEG, and each one walks the whole frame.
export function hasTooManyJpegScans(bytes, maxScans) {
  if (!Buffer.isBuffer(bytes) || !isPositiveInteger(maxScans)) {
    throw new TypeError(`${SCANS_SIGNATURE} requires the bytes of a JPEG in a Buffer and a positive integer`);
  }

  return findMarker(bytes, [SOS], maxScans) !== -1;
}

function readFactors(byte) {
  return { horizontal: Math.floor(byte / NIBBLE_VALUES), vertical: byte % NIBBLE_VALUES };
}

function isFactor(factor) {
  return factor >= MIN_FACTOR && factor <= MAX_FACTOR;
}

// The sampling factors of each component of the first SOF, or null for one libjpeg would refuse: no components, a
// length other than theirs, a factor outside 1-4.
function readSamplingFactors(bytes) {
  const codeIndex = findMarker(bytes, SOF_CODES);

  if (codeIndex === -1) {
    return null;
  }

  const start = codeIndex + 1;
  const length = bytes.readUInt16BE(start);
  const count = bytes[start + COUNT_OFFSET];

  if (!isPositiveInteger(count) || length !== COMPONENTS_OFFSET + count * COMPONENT_BYTES || start + length > bytes.length) {
    return null;
  }

  const components = Array.from({ length: count }, (item, index) => readFactors(bytes[start + COMPONENTS_OFFSET + index * COMPONENT_BYTES + FACTORS_OFFSET]));

  return components.every(({ horizontal, vertical }) => isFactor(horizontal) && isFactor(vertical))
    ? components
    : null;
}

// libjpeg keeps each component at its share of the frame, its factors against the largest ones: 2x2 everywhere is the
// whole frame, as 1x1 is, though libvips calls any factor above 1x1 "4:2:0". A header the walk cannot read counts every
// channel whole.
function readJpegBytes(metadata, bytes) {
  if (!metadata.isProgressive) {
    return STREAMED;
  }

  const components = readSamplingFactors(bytes);

  if (components === null) {
    return metadata.channels * COEFFICIENT_BYTES;
  }

  const maxHorizontal = Math.max(...components.map(({ horizontal }) => horizontal));
  const maxVertical = Math.max(...components.map(({ vertical }) => vertical));
  const blocks = components.reduce((sum, { horizontal, vertical }) => sum + horizontal * vertical, 0);

  return (COEFFICIENT_BYTES * blocks) / (maxHorizontal * maxVertical);
}

function readPngBytes(metadata) {
  const sampleBytes = metadata.depth === WIDE_DEPTH
    ? WIDE_SAMPLE_BYTES
    : SAMPLE_BYTES;

  if (metadata.isProgressive) {
    return metadata.channels * sampleBytes;
  }

  return sampleBytes > SAMPLE_BYTES
    ? metadata.channels
    : STREAMED;
}

// A file the walk cannot read is counted as the dearer kind.
function isWebpFullFrame(bytes) {
  let offset = RIFF_HEADER_BYTES;

  while (offset + CHUNK_HEADER_BYTES <= bytes.length) {
    const fourcc = bytes.toString(FOURCC_ENCODING, offset, offset + FOURCC_BYTES);

    if (FULL_FRAME_CHUNKS.includes(fourcc)) {
      return true;
    }

    if (fourcc === LOSSY_CHUNK) {
      return false;
    }

    const size = bytes.readUInt32LE(offset + FOURCC_BYTES);

    offset += CHUNK_HEADER_BYTES + size + (size % CHUNK_ALIGNMENT);
  }

  return true;
}

function readWebpBytes(metadata, bytes) {
  return isWebpFullFrame(bytes)
    ? RGBA_BYTES
    : STREAMED;
}

const DECODE_READERS = Object.freeze({
  jpeg: readJpegBytes,
  png: readPngBytes,
  webp: readWebpBytes,
});

// What a decode holds whole, per pixel: the coefficients of a progressive JPEG, the frame of an interlaced or 16-bit PNG,
// of a lossless WebP or one with alpha. 0 for a decode that streams, whose memory the cap of pixels holds.
export function readDecodeBytesPerPixel(metadata, bytes) {
  if (!isObject(metadata) || !Object.hasOwn(DECODE_READERS, metadata.format) || !Buffer.isBuffer(bytes)) {
    throw new TypeError(`${DECODE_SIGNATURE} requires what sharp read of a JPEG, PNG or WebP, and its bytes in a Buffer`);
  }

  return DECODE_READERS[metadata.format](metadata, bytes);
}
