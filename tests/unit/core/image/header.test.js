import { hasTooManyJpegScans, readDecodeBytesPerPixel } from '#core/image/header.js';
import { createImage } from '#root/tests/helper/multipart.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sharp from 'sharp';

const MARKER_PREFIX = 0xFF;
const SOI = Object.freeze([MARKER_PREFIX, 0xD8]);
const EOI = Object.freeze([MARKER_PREFIX, 0xD9]);
const SOS_CODE = 0xDA;
const SOF0_CODE = 0xC0;
const FILL = Object.freeze([MARKER_PREFIX, MARKER_PREFIX, MARKER_PREFIX]);
const APP0 = 0xE0;
const APP1 = 0xE1;
const LENGTH_BYTES = 2;

const PRECISION = 8;
const TABLE = 0x00;
const SPECTRUM_END = 0x3F;
const NIBBLE_VALUES = 16;

// What libvips reads of a frame of three components, each in a scan of its own, whatever their sampling factors.
const MULTI_SCAN = Object.freeze({
  format: 'jpeg',
  isProgressive: true,
  chromaSubsampling: '4:2:0',
  channels: 3,
});

// The bytes of the coefficients a decode keeps per pixel, by the sampling factors of each component.
const SAMPLING_COSTS = Object.freeze({
  '1x1 1x1 1x1': 6,
  '2x2 2x2 2x2': 6,
  '4x4 4x4 4x4': 6,
  '2x2 1x1 1x1': 3,
  '2x1 1x1 1x1': 4,
  '1x2 1x1 1x1': 4,
  '1x1 2x2 2x2': 4.5,
  '1x1 1x1 1x1 1x1': 8,
});

// The header of a scan of one component over the whole spectrum, and data with a stuffed 0xFF00 and a restart marker.
const SOS = Object.freeze([MARKER_PREFIX, SOS_CODE, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]);
const SCAN_DATA = Object.freeze([0x12, 0x34, MARKER_PREFIX, 0x00, 0x56, MARKER_PREFIX, 0xD0, 0x78]);
const FAKE_SOS = Object.freeze([MARKER_PREFIX, SOS_CODE, 0x00, 0x02]);
const EXIF_PREFIX = Buffer.from([...Buffer.from('Exif', 'latin1'), 0x00, 0x00]);

const SCANS = 3;
const FAKE_SCANS = 50;
const STANDARD_PROGRESSIVE_SCANS = 10;
const BROKEN_SEGMENT_BYTES = 16;

const SIDE = 64;
const COLOR = Object.freeze({ r: 200, g: 40, b: 40 });
const CLEAR = Object.freeze({ ...COLOR, alpha: 0 });

const NOT_BUFFERS = [undefined, null, 'bytes', [...SOI], new Uint8Array(SOI)];
const NOT_COUNTS = [undefined, null, 0, -1, 1.5, '20', Number.NaN];

const SCANS_MESSAGE = /^hasTooManyJpegScans\(bytes, maxScans\) requires the bytes of a JPEG in a Buffer and a positive integer$/;
const DECODE_MESSAGE = /^readDecodeBytesPerPixel\(metadata, bytes\) requires what sharp read of a JPEG, PNG or WebP, and its bytes in a Buffer$/;

function toSegment(code, payload) {
  const header = Buffer.from([MARKER_PREFIX, code, 0x00, 0x00]);

  header.writeUInt16BE(payload.length + LENGTH_BYTES, LENGTH_BYTES);

  return Buffer.concat([header, payload]);
}

function repeat(bytes, count) {
  return Buffer.from(Array.from({ length: count }, () => bytes).flat());
}

function toScans(count) {
  return repeat([...FILL, ...SOS, ...SCAN_DATA], count);
}

// Not a picture: the markers of one, around scans that hold no image.
function craftJpeg({ scans = SCANS, fakeScans = 0, tail = Buffer.alloc(0) } = {}) {
  const exif = toSegment(APP1, Buffer.concat([EXIF_PREFIX, repeat(FAKE_SOS, fakeScans)]));

  return Buffer.concat([Buffer.from(SOI), exif, toScans(scans), Buffer.from(EOI), tail]);
}

function countRawScans(bytes) {
  return bytes.filter((byte, index) => byte === MARKER_PREFIX && bytes[index + 1] === SOS_CODE).length;
}

function toUInt16(value) {
  const bytes = Buffer.alloc(LENGTH_BYTES);

  bytes.writeUInt16BE(value);

  return [...bytes];
}

// "2x1 1x1 1x1": the horizontal and the vertical sampling factor of each component.
function readSampling(text) {
  return text.split(' ').map((pair) => pair.split('x').map(Number));
}

function toFramePayload(components) {
  const entries = components.flatMap(([horizontal, vertical], index) => [index + 1, horizontal * NIBBLE_VALUES + vertical, TABLE]);

  return Buffer.from([PRECISION, ...toUInt16(SIDE), ...toUInt16(SIDE), components.length, ...entries]);
}

function toScanHeader(componentId) {
  return toSegment(SOS_CODE, Buffer.from([1, componentId, TABLE, 0x00, SPECTRUM_END, 0x00]));
}

function withFrame(payload) {
  return Buffer.concat([Buffer.from(SOI), toSegment(SOF0_CODE, payload), Buffer.from(EOI)]);
}

// The header of a picture whose components each come in a scan of their own: libjpeg then keeps every coefficient of
// the frame until the last scan. Its scans hold no image.
function craftFrame(sampling, { before = Buffer.alloc(0) } = {}) {
  const components = readSampling(sampling);
  const scans = components.map((factors, index) => Buffer.concat([toScanHeader(index + 1), Buffer.from(SCAN_DATA)]));

  return Buffer.concat([Buffer.from(SOI), before, toSegment(SOF0_CODE, toFramePayload(components)), ...scans, Buffer.from(EOI)]);
}

async function readBytesCost(bytes) {
  return readDecodeBytesPerPixel(await sharp(bytes).metadata(), bytes);
}

async function readCost(image) {
  return readBytesCost(await image.toBuffer());
}

describe('hasTooManyJpegScans', () => {
  test('counts the scans up to the cap: one more is too many', () => {
    const bytes = craftJpeg();

    assert.equal(hasTooManyJpegScans(bytes, SCANS), false);
    assert.equal(hasTooManyJpegScans(bytes, SCANS - 1), true);
  });

  test('finds a scan behind fill bytes, and takes neither a stuffed 0xFF00 nor a restart marker of the data for a segment', () => {
    const one = craftJpeg({ scans: 1 });
    const two = Buffer.concat([one.subarray(0, -EOI.length), toScans(1), Buffer.from(EOI)]);

    assert.equal(hasTooManyJpegScans(one, 1), false);
    assert.equal(hasTooManyJpegScans(two, 1), true);
  });

  test('passes over a segment by its length: markers inside an EXIF segment are not scans', () => {
    const bytes = craftJpeg({ fakeScans: FAKE_SCANS });

    assert.equal(countRawScans(bytes), SCANS + FAKE_SCANS);
    assert.equal(hasTooManyJpegScans(bytes, SCANS), false);
    assert.equal(hasTooManyJpegScans(bytes, SCANS - 1), true);
  });

  test('stops at the first EOI: what follows it is no part of the image, though it would read as a segment of it', () => {
    const tail = Buffer.concat([Buffer.from([0x00, LENGTH_BYTES]), toScans(FAKE_SCANS)]);

    assert.equal(hasTooManyJpegScans(craftJpeg({ tail }), SCANS), false);
  });

  test('counts what is there when the bytes end: before the EOI, inside a segment, in a run of fill, after a lone code', () => {
    const cuts = [
      Buffer.from(SOI),
      Buffer.from([...SOI, ...FILL]),
      Buffer.from([...SOI, MARKER_PREFIX, SOS_CODE]),
      Buffer.from([...SOI, MARKER_PREFIX, SOS_CODE, 0x00]),
      Buffer.concat([Buffer.from(SOI), toSegment(APP0, Buffer.alloc(BROKEN_SEGMENT_BYTES)).subarray(0, BROKEN_SEGMENT_BYTES)]),
    ];
    const unended = craftJpeg().subarray(0, -EOI.length);

    cuts.forEach((cut) => assert.equal(hasTooManyJpegScans(cut, 1), false));
    assert.equal(hasTooManyJpegScans(unended, SCANS), false);
    assert.equal(hasTooManyJpegScans(unended, SCANS - 1), true);
  });

  test('moves on past a segment whose length is below its own two bytes', () => {
    const bytes = Buffer.concat([Buffer.from([...SOI, MARKER_PREFIX, APP0, 0x00, 0x00]), toScans(SCANS), Buffer.from(EOI)]);

    assert.equal(hasTooManyJpegScans(bytes, SCANS), false);
    assert.equal(hasTooManyJpegScans(bytes, SCANS - 1), true);
  });

  test('counts the scans of a real progressive JPEG', async () => {
    const bytes = await createImage(SIDE, SIDE).jpeg({ progressive: true }).toBuffer();

    assert.equal(hasTooManyJpegScans(bytes, STANDARD_PROGRESSIVE_SCANS), false);
    assert.equal(hasTooManyJpegScans(bytes, STANDARD_PROGRESSIVE_SCANS - 1), true);
  });

  test('refuses what is not a Buffer, and a cap that is not a positive integer', () => {
    NOT_BUFFERS.forEach((bytes) => assert.throws(() => hasTooManyJpegScans(bytes, SCANS), { name: 'TypeError', message: SCANS_MESSAGE }));
    NOT_COUNTS.forEach((count) => assert.throws(() => hasTooManyJpegScans(craftJpeg(), count), { name: 'TypeError', message: SCANS_MESSAGE }));
  });
});

describe('readDecodeBytesPerPixel', () => {
  test('gives 0 for a decode that streams: a baseline JPEG, a plain 8-bit PNG, a lossy WebP without alpha', async () => {
    const costs = await Promise.all([
      readCost(createImage(SIDE, SIDE).jpeg()),
      readCost(createImage(SIDE, SIDE).png()),
      readCost(createImage(SIDE, SIDE, { channels: 4 }).png()),
      readCost(createImage(SIDE, SIDE).webp()),
    ]);

    assert.deepEqual(costs, [0, 0, 0, 0]);
  });

  test('counts the coefficients of a progressive JPEG: two bytes for each sample of its subsampling', async () => {
    const costs = await Promise.all([
      readCost(createImage(SIDE, SIDE).jpeg({ progressive: true })),
      readCost(createImage(SIDE, SIDE).jpeg({ progressive: true, chromaSubsampling: '4:4:4' })),
    ]);

    assert.deepEqual(costs, [3, 6]);
  });

  test('counts each component of a JPEG of many scans at its share of the frame, by its sampling factors: 2x2 or 4x4 everywhere costs what its 1x1 twin does, and 4:2:2 four bytes', async () => {
    const samplings = Object.keys(SAMPLING_COSTS);
    const costs = await Promise.all(samplings.map((sampling) => readBytesCost(craftFrame(sampling))));

    assert.deepEqual(Object.fromEntries(samplings.map((sampling, index) => [sampling, costs[index]])), SAMPLING_COSTS);
  });

  test('reads the first frame header outside other segments: the one of a thumbnail in EXIF is passed over', () => {
    const thumbnail = toSegment(APP1, Buffer.concat([EXIF_PREFIX, toSegment(SOF0_CODE, toFramePayload(readSampling('2x2 1x1 1x1')))]));

    assert.equal(readDecodeBytesPerPixel(MULTI_SCAN, craftFrame('2x2 2x2 2x2', { before: thumbnail })), 6);
  });

  test('counts every channel whole for a progressive JPEG whose frame header it cannot read: none, cut short, of a length other than its components, of no components, a factor outside 1-4', () => {
    const payload = toFramePayload(readSampling('2x2 1x1 1x1'));
    const unreadable = {
      empty: Buffer.alloc(0),
      'no frame header': craftJpeg(),
      'cut short': withFrame(payload).subarray(0, SOI.length + payload.length),
      'a byte past its components': withFrame(Buffer.concat([payload, Buffer.alloc(1)])),
      'no components': withFrame(toFramePayload([])),
      'a factor of 0': craftFrame('0x1 1x1 1x1'),
      'a factor of 5': craftFrame('2x5 1x1 1x1'),
    };

    Object.entries(unreadable).forEach(([name, bytes]) => assert.equal(readDecodeBytesPerPixel(MULTI_SCAN, bytes), 6, name));
  });

  test('counts the frame of an interlaced PNG at its depth, and of a 16-bit one by its channels', async () => {
    const costs = await Promise.all([
      readCost(createImage(SIDE, SIDE).png({ progressive: true })),
      readCost(createImage(SIDE, SIDE, { channels: 4 }).png({ progressive: true })),
      readCost(createImage(SIDE, SIDE).toColourspace('rgb16').png()),
      readCost(createImage(SIDE, SIDE).toColourspace('rgb16').png({ progressive: true })),
    ]);

    assert.deepEqual(costs, [3, 4, 3, 6]);
  });

  test('counts a lossless WebP, one with alpha and one whose chunks it cannot walk as a whole RGBA frame', async () => {
    const costs = await Promise.all([
      readCost(createImage(SIDE, SIDE).webp({ lossless: true })),
      readCost(createImage(SIDE, SIDE, { channels: 4, background: CLEAR }).webp()),
    ]);
    const headerOnly = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x04, 0x00, 0x00, 0x00]), Buffer.from('WEBP', 'latin1')]);

    assert.deepEqual(costs, [4, 4]);
    assert.equal(readDecodeBytesPerPixel({ format: 'webp' }, headerOnly), 4);
  });

  test('refuses what sharp did not read of a JPEG, a PNG or a WebP, and bytes that are not a Buffer', () => {
    const metadata = { format: 'jpeg', isProgressive: false };
    const notMetadata = [undefined, null, 'jpeg', { format: 'gif' }, { format: 'constructor' }, { format: 'toString' }];

    notMetadata.forEach((value) => assert.throws(() => readDecodeBytesPerPixel(value, Buffer.alloc(0)), { name: 'TypeError', message: DECODE_MESSAGE }));
    NOT_BUFFERS.forEach((bytes) => assert.throws(() => readDecodeBytesPerPixel(metadata, bytes), { name: 'TypeError', message: DECODE_MESSAGE }));
  });
});
