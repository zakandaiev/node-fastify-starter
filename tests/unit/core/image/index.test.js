import { createContext, runInContext } from '#core/context/index.js';
import { isImageQueueIdle, processImage } from '#core/image/index.js';
import { IMAGE_OUTPUT_FORMATS } from '#core/image/profile.js';
import { FILE_CHECK } from '#enums/file-check.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createImage } from '#root/tests/helper/multipart.js';
import { detectMime } from '#utils/mime.js';
import { omit } from '#utils/object.js';
import { convertStringToBytes } from '#utils/string.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sharp from 'sharp';

const LOG = Object.freeze({});
const IMAGE = createTestConfig().upload.image;
const { AVATAR } = IMAGE_PROFILE;
const AVATAR_SIZE = IMAGE.profiles[AVATAR].maxSize;

const WIDTH = 800;
const HEIGHT = 600;
const SIDE = 64;
const SMALL_WIDTH = 100;
const SMALL_HEIGHT = 50;
const LARGE_SIDE = 3000;
const PROFILE_SIZE = 256;
const CLEAR = Object.freeze({
  r: 255, g: 0, b: 0, alpha: 0,
});
const WHITE_MIN = 250;

const RIGHT_ANGLE_ORIENTATION = 6;

const DECODE_BUDGET = '1MB';
const BUDGET_SIDE = 1000;
const COEFFICIENT_BYTES_420 = 3;
const RGB_BYTES = 3;
const RGBA_BYTES = 4;

const SCAN_CAP = 20;
const STANDARD_PROGRESSIVE_SCANS = 10;
const FAKE_SCANS = 30;
const MARKER_PREFIX = 0xFF;
const SOS_CODE = 0xDA;
const FILL = Object.freeze([MARKER_PREFIX, MARKER_PREFIX, MARKER_PREFIX]);
const EOI_BYTES = 2;

// A scan of one component over the whole spectrum, with a stuffed 0xFF00 and a restart marker in its data.
const SCAN = Object.freeze([
  ...FILL,
  MARKER_PREFIX, SOS_CODE, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00,
  0x12, MARKER_PREFIX, 0x00, 0x34, MARKER_PREFIX, 0xD0, 0x56,
]);
const FAKE_SOS = Object.freeze([MARKER_PREFIX, SOS_CODE, 0x00, 0x02]);
const DESCRIPTION = 'D'.repeat(FAKE_SCANS * FAKE_SOS.length);

const EXIF = Object.freeze({
  IFD0: { Copyright: 'Somebody', ImageDescription: 'A street at night' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '50/1 27/1 1/1',
    GPSLongitudeRef: 'E',
    GPSLongitude: '30/1 31/1 2/1',
  },
});
const EXIF_HEADER_BYTES = 6;
const LITTLE_ENDIAN_MARK = 'II';
const IFD_OFFSET_AT = 4;
const IFD_COUNT_BYTES = 2;
const IFD_ENTRY_BYTES = 12;
const GPS_IFD_TAG = 0x8825;

const PNG_SIGNATURE_BYTES = 8;
const JPEG_SIGNATURE_BYTES = 3;
const TRUNCATED_SHARE = 0.6;
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>';
const GARBAGE = 'not an image at all, only text after the signature';

const IMAGE_REFUSAL = Object.freeze({ refusal: { operator: FILE_CHECK.IMAGE, operatorValue: null } });

const BYTES_MESSAGE = /^processImage\(bytes, profileName\) requires the bytes of the file in a Buffer$/;
const PROFILE_MESSAGE = /^processImage\(bytes, profileName\) requires the name of a profile of config\.upload\.image: received /;

function createConfig(changes = {}) {
  return createTestConfig({ upload: { image: { ...IMAGE, ...changes } } });
}

const CONFIG = createConfig();

function withProfile(profile) {
  return createConfig({ profiles: { [AVATAR]: profile } });
}

function runImage(bytes, { config = CONFIG, profileName = AVATAR } = {}) {
  return runInContext(createContext({ config, log: LOG }), () => processImage(bytes, profileName));
}

function toPixelRefusal(operatorValue) {
  return { refusal: { operator: FILE_CHECK.MAX_PIXELS, operatorValue } };
}

// The tags of the first IFD of an EXIF block: the pointer to the GPS IFD is one of them.
function readMainTags(exif) {
  const tiff = exif.subarray(EXIF_HEADER_BYTES);
  const isLittleEndian = tiff.toString('latin1', 0, LITTLE_ENDIAN_MARK.length) === LITTLE_ENDIAN_MARK;

  function readShort(offset) {
    return isLittleEndian
      ? tiff.readUInt16LE(offset)
      : tiff.readUInt16BE(offset);
  }

  const ifd = isLittleEndian
    ? tiff.readUInt32LE(IFD_OFFSET_AT)
    : tiff.readUInt32BE(IFD_OFFSET_AT);

  return Array.from({ length: readShort(ifd) }, (unused, index) => readShort(ifd + IFD_COUNT_BYTES + index * IFD_ENTRY_BYTES));
}

// A real progressive JPEG of ten scans, whose EXIF description holds markers of scans that are none.
async function createScannedJpeg() {
  const bytes = await createImage(WIDTH, HEIGHT)
    .jpeg({ progressive: true })
    .withExif({ IFD0: { ImageDescription: DESCRIPTION } })
    .toBuffer();
  const patched = Buffer.from(bytes);

  Buffer.from(Array.from({ length: FAKE_SCANS }, () => FAKE_SOS).flat()).copy(patched, bytes.indexOf(DESCRIPTION));

  return patched;
}

function withScans(jpeg, count) {
  const scans = Buffer.from(Array.from({ length: count }, () => SCAN).flat());

  return Buffer.concat([jpeg.subarray(0, -EOI_BYTES), scans, jpeg.subarray(-EOI_BYTES)]);
}

function countRawScans(bytes) {
  return bytes.filter((byte, index) => byte === MARKER_PREFIX && bytes[index + 1] === SOS_CODE).length;
}

async function readOutputs(results) {
  return Promise.all(results.map(({ image }) => sharp(image.bytes).metadata()));
}

describe('processImage', () => {
  test('turns a PNG, a JPEG and a WebP into the format of the profile, within its longest side', async () => {
    const files = await Promise.all([
      createImage(WIDTH, HEIGHT).png().toBuffer(),
      createImage(WIDTH, HEIGHT).jpeg().toBuffer(),
      createImage(WIDTH, HEIGHT).webp().toBuffer(),
    ]);
    const results = await Promise.all(files.map((bytes) => runImage(bytes)));
    const outputs = await readOutputs(results);
    const expected = {
      mime: 'image/webp',
      extension: 'webp',
      width: AVATAR_SIZE,
      height: AVATAR_SIZE * (HEIGHT / WIDTH),
    };

    results.forEach(({ image }) => {
      assert.deepEqual(omit(image, ['bytes']), expected);
      assert.equal(detectMime(image.bytes), expected.mime);
    });
    outputs.forEach(({ format, width, height }) => assert.deepEqual({ format, width, height }, { format: 'webp', width: expected.width, height: expected.height }));
  });

  test('writes every format a profile can name, with its type and its extension', async () => {
    const bytes = await createImage(WIDTH, HEIGHT).png().toBuffer();
    const formats = Object.keys(IMAGE_OUTPUT_FORMATS);
    const results = await Promise.all(formats.map((format) => runImage(bytes, { config: withProfile({ format, maxSize: PROFILE_SIZE }) })));
    const outputs = await readOutputs(results);

    formats.forEach((format, index) => {
      const { image } = results[index];

      assert.deepEqual(omit(image, ['bytes']), { ...IMAGE_OUTPUT_FORMATS[format], width: PROFILE_SIZE, height: PROFILE_SIZE * (HEIGHT / WIDTH) });
      assert.equal(detectMime(image.bytes), IMAGE_OUTPUT_FORMATS[format].mime);
      assert.equal(outputs[index].format, format);
    });
  });

  test('never enlarges an image smaller than the longest side of the profile', async () => {
    const { image } = await runImage(await createImage(SMALL_WIDTH, SMALL_HEIGHT).png().toBuffer());

    assert.deepEqual([image.width, image.height], [SMALL_WIDTH, SMALL_HEIGHT]);
  });

  test('keeps no metadata of the file in any format: no EXIF, so no GPS', async () => {
    const bytes = await createImage(WIDTH, HEIGHT).jpeg().withExif(EXIF).toBuffer();
    const { exif } = await sharp(bytes).metadata();
    const formats = Object.keys(IMAGE_OUTPUT_FORMATS);
    const results = await Promise.all(formats.map((format) => runImage(bytes, { config: withProfile({ format, maxSize: AVATAR_SIZE }) })));
    const outputs = await readOutputs(results);

    assert.ok(readMainTags(exif).includes(GPS_IFD_TAG));
    outputs.forEach((metadata) => {
      assert.deepEqual([metadata.exif, metadata.xmp, metadata.iptc, metadata.orientation], [undefined, undefined, undefined, undefined]);
    });
  });

  test('turns the image by its EXIF orientation: a 2x1 image of orientation 6 comes out 1x2, with no orientation left', async () => {
    const bytes = await createImage(2, 1).jpeg().withMetadata({ orientation: RIGHT_ANGLE_ORIENTATION }).toBuffer();
    const { image } = await runImage(bytes);
    const output = await sharp(image.bytes).metadata();

    assert.equal((await sharp(bytes).metadata()).orientation, RIGHT_ANGLE_ORIENTATION);
    assert.deepEqual([image.width, image.height], [1, 2]);
    assert.deepEqual([output.width, output.height, output.orientation], [1, 2, undefined]);
  });

  test('lays an image with alpha on white for a JPEG profile, and keeps its alpha for a WebP one', async () => {
    const bytes = await createImage(SIDE, SIDE, { channels: 4, background: CLEAR }).png().toBuffer();
    const [jpeg, webp] = await Promise.all([
      runImage(bytes, { config: withProfile({ format: 'jpeg', maxSize: AVATAR_SIZE }) }),
      runImage(bytes),
    ]);
    const { data, info } = await sharp(jpeg.image.bytes).raw().toBuffer({ resolveWithObject: true });

    assert.equal(info.channels, RGB_BYTES);
    assert.ok(data.every((value) => value >= WHITE_MIN));
    assert.equal((await sharp(webp.image.bytes).metadata()).hasAlpha, true);
  });

  test('refuses a file whose magic bytes name one format while its body is another', async () => {
    const [png, jpeg] = await Promise.all([
      createImage(SIDE, SIDE).png().toBuffer(),
      createImage(SIDE, SIDE).jpeg().toBuffer(),
    ]);
    const webpHeader = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(RGBA_BYTES), Buffer.from('WEBP', 'latin1')]);
    const files = [
      Buffer.concat([jpeg.subarray(0, JPEG_SIGNATURE_BYTES), png.subarray(JPEG_SIGNATURE_BYTES)]),
      Buffer.concat([png.subarray(0, PNG_SIGNATURE_BYTES), jpeg.subarray(PNG_SIGNATURE_BYTES)]),
      Buffer.concat([webpHeader, png]),
    ];

    assert.deepEqual(await Promise.all(files.map((bytes) => runImage(bytes))), files.map(() => IMAGE_REFUSAL));
  });

  test('refuses a GIF, SVG text and an empty buffer by their magic bytes, before they wait for the decoder', async () => {
    const files = [await createImage(SIDE, SIDE).gif().toBuffer(), Buffer.from(SVG_TEXT), Buffer.alloc(0)];
    const pending = files.map((bytes) => runImage(bytes));

    assert.equal(isImageQueueIdle(), true);
    assert.deepEqual(await Promise.all(pending), files.map(() => IMAGE_REFUSAL));
  });

  test('refuses garbage after a PNG signature and a truncated file, which the decoder fails on', async () => {
    const [png, progressive] = await Promise.all([
      createImage(WIDTH, HEIGHT).png().toBuffer(),
      createImage(WIDTH, HEIGHT).jpeg({ progressive: true }).toBuffer(),
    ]);
    const files = [
      Buffer.concat([png.subarray(0, PNG_SIGNATURE_BYTES), Buffer.from(GARBAGE)]),
      png.subarray(0, Math.floor(png.length * TRUNCATED_SHARE)),
      progressive.subarray(0, Math.floor(progressive.length * TRUNCATED_SHARE)),
    ];

    assert.deepEqual(await Promise.all(files.map((bytes) => runImage(bytes))), files.map(() => IMAGE_REFUSAL));
  });

  test('refuses an image of more pixels than maxPixels, naming the cap; one of as many passes', async () => {
    const bytes = await createImage(SIDE, SIDE).png().toBuffer();
    const pixels = SIDE * SIDE;

    assert.deepEqual(await runImage(bytes, { config: createConfig({ maxPixels: pixels - 1 }) }), toPixelRefusal(pixels - 1));
    assert.equal((await runImage(bytes, { config: createConfig({ maxPixels: pixels }) })).image.width, SIDE);
  });

  test('refuses an image a decode holds whole past maxDecodeBytes, naming the pixels that fit; one that streams passes', async () => {
    const config = createConfig({ maxDecodeBytes: DECODE_BUDGET });
    const budget = convertStringToBytes(DECODE_BUDGET);
    const image = createImage(BUDGET_SIDE, BUDGET_SIDE);
    const whole = await Promise.all([
      image.clone().jpeg({ progressive: true }).toBuffer(),
      image.clone().png({ progressive: true }).toBuffer(),
      image.clone().webp({ lossless: true }).toBuffer(),
    ]);
    const streamed = await Promise.all([
      image.clone().jpeg().toBuffer(),
      image.clone().png().toBuffer(),
      image.clone().webp().toBuffer(),
    ]);
    const refusals = await Promise.all(whole.map((bytes) => runImage(bytes, { config })));
    const passes = await Promise.all(streamed.map((bytes) => runImage(bytes, { config })));

    assert.deepEqual(refusals, [COEFFICIENT_BYTES_420, RGB_BYTES, RGBA_BYTES].map((bytes) => toPixelRefusal(Math.floor(budget / bytes))));
    passes.forEach((result) => assert.equal(result.image.width, AVATAR_SIZE));
  });

  test('refuses a JPEG of more scans than maxJpegScans before it waits for the decoder: fill bytes hide no scan, the markers in EXIF are none', async () => {
    const config = createConfig({ maxJpegScans: SCAN_CAP });
    const jpeg = await createScannedJpeg();
    const free = STANDARD_PROGRESSIVE_SCANS + FAKE_SCANS;
    const atCap = withScans(jpeg, SCAN_CAP - STANDARD_PROGRESSIVE_SCANS);
    const pastCap = withScans(jpeg, SCAN_CAP - STANDARD_PROGRESSIVE_SCANS + 1);

    assert.equal(countRawScans(jpeg), free);
    assert.equal((await runImage(jpeg, { config })).image.width, AVATAR_SIZE);

    const refused = runImage(pastCap, { config });

    assert.equal(isImageQueueIdle(), true);
    assert.deepEqual(await refused, IMAGE_REFUSAL);

    const decoded = runImage(atCap, { config });

    assert.equal(isImageQueueIdle(), false);
    assert.deepEqual(await decoded, IMAGE_REFUSAL);
  });

  test('fails with a text of its own on a text of sharp it does not know, with the error of sharp for its cause', async () => {
    const bytes = await createImage(SIDE, SIDE).png().toBuffer();

    await assert.rejects(runImage(bytes, { config: withProfile({ format: 'webp', quality: 0, maxSize: AVATAR_SIZE }) }), (error) => {
      assert.equal(error.message, 'Image processing failed: unexpected error');
      assert.match(error.cause.message, /quality/);

      return true;
    });
    assert.equal(isImageQueueIdle(), true);
    assert.equal((await runImage(bytes)).image.width, SIDE);
  });

  test('decodes one image at a time: a small one waits for a large one that came first, and the queue is busy until both are done', async () => {
    const [large, small] = await Promise.all([
      createImage(LARGE_SIDE, LARGE_SIDE).png().toBuffer(),
      createImage(SIDE, SIDE).png().toBuffer(),
    ]);
    const finished = [];

    async function track(name, bytes) {
      await runImage(bytes);
      finished.push({ name, isIdle: isImageQueueIdle() });
    }

    assert.equal(isImageQueueIdle(), true);

    const both = Promise.all([track('large', large), track('small', small)]);

    assert.equal(isImageQueueIdle(), false);
    await both;
    assert.deepEqual(finished, [{ name: 'large', isIdle: false }, { name: 'small', isIdle: true }]);
  });

  test('refuses bytes that are not a Buffer, and a profile the config does not name', async () => {
    const bytes = await createImage(SIDE, SIDE).png().toBuffer();
    const notBuffers = [undefined, null, 'image', new Uint8Array(bytes), [...bytes.subarray(0, SIDE)]];
    const notProfiles = [undefined, null, 'banner', 'constructor', '__proto__', 'toString'];
    const context = createContext({ config: CONFIG, log: LOG });

    await Promise.all([
      ...notBuffers.map((value) => assert.rejects(runImage(value), { name: 'TypeError', message: BYTES_MESSAGE })),
      ...notProfiles.map((profileName) => assert.rejects(
        runInContext(context, () => processImage(bytes, profileName)),
        { name: 'TypeError', message: PROFILE_MESSAGE },
      )),
    ]);
  });

  test('reads its limits and profiles from the context of the app', async () => {
    await assert.rejects(processImage(Buffer.alloc(0), AVATAR), { message: /^No active context/ });
  });
});

describe('isImageQueueIdle', () => {
  test('is true while nothing waits for the decoder or runs in it', () => {
    assert.equal(isImageQueueIdle(), true);
  });
});
