import {
  MIME_SIGNATURE_BYTES,
  MIME_WHITELIST,
  detectMime,
  extFromMime,
  toMimeEssence,
} from '#utils/mime.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const HUGE_BUFFER_BYTES = 32 * 1024 * 1024;
const DETECTIONS = 2000;
const LONG_STRING_LENGTH = 100000;
const INSTANT_MS = 1000;
const VIEW_OFFSET = 16;
const BYTE_ORDER_MARK = String.fromCharCode(0xFEFF);

function latin1(text) {
  return Buffer.from(text, 'latin1');
}

const JPEG_JFIF = latin1('\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00');
const JPEG_EXIF = latin1('\xFF\xD8\xFF\xE1\x00\x18Exif\x00\x00II*\x00\x08\x00\x00\x00');
const JPEG_BARE = latin1('\xFF\xD8\xFF\xDB\x00\x43\x00');
const PNG = latin1('\x89PNG\r\n\x1A\n\x00\x00\x00\x0DIHDR\x00\x00\x00\x01\x00\x00\x00\x01');
const WEBP_LOSSY = latin1('RIFF\x24\x00\x00\x00WEBPVP8 ');
const WEBP_LOSSLESS = latin1('RIFF\x1A\x00\x00\x00WEBPVP8L');
const WEBP_EXTENDED = latin1('RIFF\xF0\xFF\xFF\xFFWEBPVP8X');
const GIF_87A = latin1('GIF87a\x01\x00\x01\x00\x80\x00\x00');
const GIF_89A = latin1('GIF89a\x01\x00\x01\x00\x80\x00\x00');
const PDF = latin1('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

const EXECUTABLE = latin1('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xFF\xFF\x00\x00');
const WAVE = latin1('RIFF\x24\x08\x00\x00WAVEfmt ');
const AVI = latin1('RIFF\x00\x00\x00\x00AVI LIST');
const SVG = latin1('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
const SVG_WITH_PROLOG = latin1('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
const TEXT = latin1('Hello, world!\n');

const FORMATS = Object.freeze([
  {
    type: 'image/jpeg',
    extension: 'jpg',
    signatureBytes: 3,
    headers: [JPEG_JFIF, JPEG_EXIF, JPEG_BARE],
  },
  {
    type: 'image/png',
    extension: 'png',
    signatureBytes: 8,
    headers: [PNG],
  },
  {
    type: 'image/webp',
    extension: 'webp',
    signatureBytes: 12,
    headers: [WEBP_LOSSY, WEBP_LOSSLESS, WEBP_EXTENDED],
  },
  {
    type: 'image/gif',
    extension: 'gif',
    signatureBytes: 6,
    headers: [GIF_87A, GIF_89A],
  },
  {
    type: 'application/pdf',
    extension: 'pdf',
    signatureBytes: 5,
    headers: [PDF],
  },
]);

function eachHeader(check) {
  FORMATS.forEach((format) => {
    format.headers.forEach((header) => check(header, format));
  });
}

describe('MIME_WHITELIST', () => {
  test('lists the accepted types: JPEG, PNG, WebP, GIF and PDF', () => {
    assert.deepEqual(MIME_WHITELIST, ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
    assert.deepEqual(MIME_WHITELIST, FORMATS.map(({ type }) => type));
  });

  test('leaves out the formats that have no signature', () => {
    ['image/svg+xml', 'text/plain', 'text/html', 'application/octet-stream'].forEach((type) => {
      assert.equal(MIME_WHITELIST.includes(type), false);
    });
  });

  test('holds the one spelling detectMime returns, so includes() is an exact check', () => {
    MIME_WHITELIST.forEach((type) => {
      assert.match(type, /^[a-z]+\/[a-z]+$/);
    });

    assert.equal(MIME_WHITELIST.includes(detectMime(JPEG_JFIF)), true);
    assert.equal(MIME_WHITELIST.includes('IMAGE/JPEG'), false);
    assert.equal(MIME_WHITELIST.includes('image/jpeg; charset=binary'), false);
    assert.equal(MIME_WHITELIST.includes(null), false);
  });

  test('is frozen like the registry behind it: a consumer cannot widen what is accepted', () => {
    assert.ok(Object.isFrozen(MIME_WHITELIST));
    assert.throws(() => MIME_WHITELIST.push('image/svg+xml'), TypeError);
    assert.throws(() => {
      MIME_WHITELIST[0] = 'image/svg+xml';
    }, TypeError);
    assert.throws(() => {
      MIME_WHITELIST.length = 0;
    }, TypeError);

    assert.equal(MIME_WHITELIST.length, FORMATS.length);
    assert.equal(extFromMime('image/svg+xml'), null);
    assert.equal(detectMime(SVG), null);
  });
});

describe('MIME_SIGNATURE_BYTES', () => {
  test('is the length of the longest signature: a WebP is told by "WEBP" in bytes 8 to 11', () => {
    assert.equal(MIME_SIGNATURE_BYTES, 12);
    assert.equal(MIME_SIGNATURE_BYTES, Math.max(...FORMATS.map(({ signatureBytes }) => signatureBytes)));
  });

  test('is enough to detect every format from the head of a stream', () => {
    eachHeader((header, { type }) => {
      const file = Buffer.concat([header, Buffer.alloc(64, 0xAB)]);

      assert.equal(detectMime(file.subarray(0, MIME_SIGNATURE_BYTES)), type);
    });
  });

  test('is not more than detection needs: one byte fewer loses a WebP', () => {
    assert.equal(detectMime(WEBP_LOSSLESS.subarray(0, MIME_SIGNATURE_BYTES - 1)), null);
  });
});

describe('detectMime', () => {
  test('detects a JPEG by its start-of-image marker, whatever segment follows', () => {
    assert.equal(detectMime(JPEG_JFIF), 'image/jpeg');
    assert.equal(detectMime(JPEG_EXIF), 'image/jpeg');
    assert.equal(detectMime(JPEG_BARE), 'image/jpeg');
  });

  test('detects a PNG by its eight-byte signature', () => {
    assert.equal(detectMime(PNG), 'image/png');
  });

  test('detects both versions of GIF', () => {
    assert.equal(detectMime(GIF_87A), 'image/gif');
    assert.equal(detectMime(GIF_89A), 'image/gif');
  });

  test('detects a PDF of any version by "%PDF-"', () => {
    assert.equal(detectMime(PDF), 'application/pdf');
    assert.equal(detectMime(latin1('%PDF-1.4\n')), 'application/pdf');
    assert.equal(detectMime(latin1('%PDF-2.0\n')), 'application/pdf');
  });

  test('detects a WebP by "RIFF" at 0 and "WEBP" at 8, whatever the size field and the codec', () => {
    assert.equal(detectMime(WEBP_LOSSY), 'image/webp');
    assert.equal(detectMime(WEBP_LOSSLESS), 'image/webp');
    assert.equal(detectMime(WEBP_EXTENDED), 'image/webp');
  });

  test('returns the type exactly as the whitelist spells it', () => {
    eachHeader((header, { type }) => {
      assert.equal(detectMime(header), type);
      assert.ok(MIME_WHITELIST.includes(detectMime(header)));
    });
  });

  test('needs no more than the signature itself', () => {
    eachHeader((header, { type, signatureBytes }) => {
      assert.equal(detectMime(header.subarray(0, signatureBytes)), type);
    });
  });

  test('returns null for an empty buffer and for one that ends before the signature does', () => {
    assert.equal(detectMime(Buffer.alloc(0)), null);
    assert.equal(detectMime(new Uint8Array(0)), null);
    assert.equal(detectMime(latin1('\xFF\xD8')), null);

    eachHeader((header, { signatureBytes }) => {
      Array.from({ length: signatureBytes }, (unused, length) => header.subarray(0, length)).forEach((head) => {
        assert.equal(detectMime(head), null, head.toString('hex'));
      });
    });
  });

  test('returns null for an executable, whatever name it was uploaded under', () => {
    assert.equal(detectMime(EXECUTABLE), null);
    assert.equal(detectMime(latin1('\x7FELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00')), null);
  });

  test('returns null for the formats without a signature: SVG, HTML and plain text', () => {
    assert.equal(detectMime(SVG), null);
    assert.equal(detectMime(SVG_WITH_PROLOG), null);
    assert.equal(detectMime(latin1('<!DOCTYPE html><html><body></body></html>')), null);
    assert.equal(detectMime(TEXT), null);
    assert.equal(detectMime(latin1('\xEF\xBB\xBFHello, world!\n')), null);
  });

  test('returns null for a RIFF container that is not a WebP: WAVE and AVI', () => {
    assert.equal(detectMime(WAVE), null);
    assert.equal(detectMime(AVI), null);
  });

  test('returns null for a binary format outside the whitelist: ZIP, BMP, TIFF, ICO, HEIC, AVIF, MP4, JPEG 2000', () => {
    [
      'PK\x03\x04\x14\x00\x00\x00\x08\x00\x00\x00',
      'BM\x36\x00\x0C\x00\x00\x00\x00\x00\x36\x00',
      'II*\x00\x08\x00\x00\x00\x0A\x00\x00\x01',
      '\x00\x00\x01\x00\x01\x00\x10\x10\x00\x00\x01\x00',
      '\x00\x00\x00\x18ftypheic\x00\x00\x00\x00',
      '\x00\x00\x00\x1Cftypavif\x00\x00\x00\x00',
      '\x00\x00\x00\x20ftypisom\x00\x00\x02\x00',
      '\x00\x00\x00\x0CjP  \r\n\x87\n',
    ].map(latin1).forEach((header) => {
      assert.equal(detectMime(header), null, header.toString('hex'));
    });
  });

  test('returns null for a near miss of every signature', () => {
    [
      '\xFF\xD8\x00\xE0\x00\x10JFIF',
      '\xFF\xD9\xFF\xE0\x00\x10JFIF',
      '\xFF\x0A\xFF\xD8\xFF\xE0',
      '\x89PNG\n\x1A\n\x00\x00\x00\x0DIHDR',
      '\x89png\r\n\x1A\n\x00\x00\x00\x0DIHDR',
      'PNG\r\n\x1A\n\x00\x00\x00\x0DIHDR',
      'RIFF\x1A\x00\x00\x00webpVP8L',
      'RIFX\x00\x00\x00\x1AWEBPVP8L',
      'RIFFWEBPVP8L\x1A\x00\x00\x00',
      'GIF88a\x01\x00\x01\x00\x80\x00\x00',
      'GIF89b\x01\x00\x01\x00\x80\x00\x00',
      'gif89a\x01\x00\x01\x00\x80\x00\x00',
      '%pdf-1.7\n',
      '%PDF 1.7\n',
      '%!PS-Adobe-3.0\n',
    ].map(latin1).forEach((header) => {
      assert.equal(detectMime(header), null, header.toString('hex'));
    });
  });

  test('returns null when the signature is not at the very first byte', () => {
    eachHeader((header) => {
      assert.equal(detectMime(Buffer.concat([latin1(' '), header])), null);
      assert.equal(detectMime(Buffer.concat([latin1('\xEF\xBB\xBF'), header])), null);
      assert.equal(detectMime(Buffer.concat([TEXT, header])), null);
    });
  });

  test('matches the leading bytes only: a script behind a GIF header is still image/gif, the decoder judges the rest', () => {
    assert.equal(detectMime(latin1('GIF89a<script>alert(1)</script>')), 'image/gif');
    assert.equal(detectMime(Buffer.concat([JPEG_JFIF, EXECUTABLE])), 'image/jpeg');
    assert.equal(detectMime(Buffer.concat([PDF, SVG])), 'application/pdf');
  });

  test('accepts a Uint8Array as well as a Buffer', () => {
    eachHeader((header, { type }) => {
      const bytes = new Uint8Array(header);

      assert.equal(Buffer.isBuffer(bytes), false);
      assert.equal(detectMime(bytes), type);
    });
  });

  test('reads a view from its own offset inside a larger ArrayBuffer', () => {
    eachHeader((header, { type }) => {
      const memory = new ArrayBuffer(VIEW_OFFSET + header.length + VIEW_OFFSET);

      new Uint8Array(memory).set(header, VIEW_OFFSET);

      const bytes = new Uint8Array(memory, VIEW_OFFSET, header.length);
      const buffer = Buffer.from(memory, VIEW_OFFSET, header.length);

      assert.equal(bytes.byteOffset, VIEW_OFFSET);
      assert.equal(buffer.byteOffset, VIEW_OFFSET);
      assert.equal(detectMime(bytes), type);
      assert.equal(detectMime(buffer), type);
      assert.equal(detectMime(Buffer.concat([TEXT, header]).subarray(TEXT.length)), type);
    });
  });

  test('does not see the bytes of the ArrayBuffer that lie before the view', () => {
    const memory = new ArrayBuffer(VIEW_OFFSET * 3);
    const whole = new Uint8Array(memory);

    whole.set(PNG.subarray(0, VIEW_OFFSET));
    whole.set(GIF_89A, VIEW_OFFSET);

    assert.equal(detectMime(whole), 'image/png');
    assert.equal(detectMime(new Uint8Array(memory, VIEW_OFFSET, VIEW_OFFSET)), 'image/gif');
    assert.equal(detectMime(Buffer.from(memory, VIEW_OFFSET, VIEW_OFFSET)), 'image/gif');
    assert.equal(detectMime(new Uint8Array(memory, VIEW_OFFSET * 2, VIEW_OFFSET)), null);
    assert.equal(detectMime(Buffer.from(memory, VIEW_OFFSET * 2, VIEW_OFFSET)), null);
  });

  test('returns null for what is not binary data, even when it spells a signature', () => {
    const arrayLike = { length: GIF_89A.length, ...[...GIF_89A] };

    [
      null,
      undefined,
      0,
      12,
      true,
      'GIF89a',
      GIF_89A.toString('latin1'),
      GIF_89A.toString('hex'),
      GIF_89A.toString('base64'),
      [...GIF_89A],
      arrayLike,
      {},
      () => GIF_89A,
    ].forEach((value) => {
      assert.equal(detectMime(value), null);
    });
  });

  test('returns null for a binary container other than a Uint8Array: wrap it first', () => {
    const { buffer } = Uint8Array.from(GIF_89A);

    [
      buffer,
      new DataView(buffer),
      new Uint8ClampedArray(GIF_89A),
      new Int8Array(GIF_89A),
      new Uint16Array(GIF_89A),
      Object.create(Uint8Array.prototype),
    ].forEach((value) => {
      assert.equal(detectMime(value), null);
    });

    assert.equal(detectMime(new Uint8Array(buffer)), 'image/gif');
  });

  test('does not change the bytes it reads', () => {
    eachHeader((header) => {
      const copy = Buffer.from(header);

      detectMime(header);

      assert.deepEqual(header, copy);
    });
  });

  test('reads only the leading bytes: thousands of detections on a 32 MB buffer are instant', () => {
    const huge = Buffer.alloc(HUGE_BUFFER_BYTES);
    const startedAt = performance.now();

    Array.from({ length: DETECTIONS }).forEach(() => {
      assert.equal(detectMime(huge), null);
    });

    huge.set(WEBP_LOSSLESS);

    Array.from({ length: DETECTIONS }).forEach(() => {
      assert.equal(detectMime(huge), 'image/webp');
    });

    assert.ok(performance.now() - startedAt < INSTANT_MS);
  });
});

describe('toMimeEssence', () => {
  test('lower-cases the type and the subtype', () => {
    assert.equal(toMimeEssence('IMAGE/JPEG'), 'image/jpeg');
    assert.equal(toMimeEssence('Application/JSON'), 'application/json');
    assert.equal(toMimeEssence('Multipart/Form-Data'), 'multipart/form-data');
  });

  test('drops the parameters and the whitespace around the type', () => {
    assert.equal(toMimeEssence('application/json; charset=utf-8'), 'application/json');
    assert.equal(toMimeEssence('APPLICATION/JSON; CHARSET=UTF-8'), 'application/json');
    assert.equal(toMimeEssence('multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxk'), 'multipart/form-data');
    assert.equal(toMimeEssence(' application/x-www-form-urlencoded '), 'application/x-www-form-urlencoded');
    assert.equal(toMimeEssence('\tapplication/pdf ; name="report.pdf"\r\n'), 'application/pdf');
    assert.equal(toMimeEssence('text/plain;'), 'text/plain');
  });

  test('names the essence of any type, not only of a whitelisted one', () => {
    ['text/html', 'image/svg+xml', 'application/vnd.api+json', 'application/octet-stream', 'image/*', '*/*'].forEach((mime) => {
      assert.equal(toMimeEssence(mime), mime);
    });
  });

  test('gives back every whitelisted type from any spelling of it: extFromMime finds the extension by it', () => {
    MIME_WHITELIST.forEach((type) => {
      assert.equal(toMimeEssence(` ${type.toUpperCase()}; q=0.8 `), type);
    });
  });

  test('returns null for a string that is not one MIME type', () => {
    [
      '',
      ' ',
      'image',
      'image/',
      '/jpeg',
      'jpeg',
      'image/jpeg, image/png',
      'image/jpeg/extra',
      'image /jpeg',
      'image/ jpeg',
      'image/jpeg\0',
      `${BYTE_ORDER_MARK}image/jpeg`,
      '__proto__',
      'constructor',
    ].forEach((mime) => {
      assert.equal(toMimeEssence(mime), null, JSON.stringify(mime));
    });
  });

  test('returns null for what is not a string', () => {
    [null, undefined, 0, 1, true, {}, [], ['application/json'], Buffer.from('application/json'), { toString: () => 'application/json' }].forEach((mime) => {
      assert.equal(toMimeEssence(mime), null);
    });
  });

  test('reads a long hostile string in linear time', () => {
    const startedAt = performance.now();

    assert.equal(toMimeEssence('a'.repeat(LONG_STRING_LENGTH)), null);
    assert.equal(toMimeEssence(`image/${' '.repeat(LONG_STRING_LENGTH)}x`), null);
    assert.equal(toMimeEssence(`${' '.repeat(LONG_STRING_LENGTH)}application/json`), 'application/json');
    assert.equal(toMimeEssence(`application/json${';a="b"'.repeat(LONG_STRING_LENGTH / 10)}`), 'application/json');
    assert.ok(performance.now() - startedAt < INSTANT_MS);
  });
});

describe('extFromMime', () => {
  test('returns the extension without a dot for every whitelisted type', () => {
    assert.equal(extFromMime('image/jpeg'), 'jpg');
    assert.equal(extFromMime('image/png'), 'png');
    assert.equal(extFromMime('image/webp'), 'webp');
    assert.equal(extFromMime('image/gif'), 'gif');
    assert.equal(extFromMime('application/pdf'), 'pdf');

    MIME_WHITELIST.forEach((type) => {
      assert.match(extFromMime(type), /^[a-z0-9]+$/);
    });
  });

  test('gives every type its own extension', () => {
    assert.equal(new Set(MIME_WHITELIST.map((type) => extFromMime(type))).size, MIME_WHITELIST.length);
  });

  test('names a file after what detectMime found, and nothing after what it did not', () => {
    eachHeader((header, { extension }) => {
      assert.equal(extFromMime(detectMime(header)), extension);
    });

    assert.equal(extFromMime(detectMime(EXECUTABLE)), null);
    assert.equal(extFromMime(detectMime(SVG)), null);
  });

  test('ignores letter case: the names of a type and a subtype are case-insensitive', () => {
    assert.equal(extFromMime('IMAGE/JPEG'), 'jpg');
    assert.equal(extFromMime('Image/Png'), 'png');
    assert.equal(extFromMime('image/WebP'), 'webp');
    assert.equal(extFromMime('Application/PDF'), 'pdf');
  });

  test('ignores parameters and the whitespace around the type', () => {
    assert.equal(extFromMime('image/jpeg; charset=binary'), 'jpg');
    assert.equal(extFromMime('image/png;q=0.8'), 'png');
    assert.equal(extFromMime('image/gif;'), 'gif');
    assert.equal(extFromMime(' image/webp '), 'webp');
    assert.equal(extFromMime('\tapplication/pdf ; name="report.pdf"\r\n'), 'pdf');
  });

  test('takes nothing from a parameter: the extension comes from the whitelist only', () => {
    assert.equal(extFromMime('image/jpeg; name="../../shell.php"'), 'jpg');
    assert.equal(extFromMime('image/png; ext=exe'), 'png');
    assert.equal(extFromMime('text/html; type=image/png'), null);
  });

  test('returns null for a type outside the whitelist, a common alias included', () => {
    [
      'image/jpg',
      'image/pjpeg',
      'image/x-png',
      'image/svg+xml',
      'image/bmp',
      'image/heic',
      'image/avif',
      'text/plain',
      'text/html',
      'application/octet-stream',
      'application/x-msdownload',
      'application/zip',
      'image/*',
      '*/*',
    ].forEach((mime) => {
      assert.equal(extFromMime(mime), null, mime);
    });
  });

  test('returns null for a type that only starts or ends like a whitelisted one', () => {
    [
      'image/jpeg2000',
      'image/pngx',
      'image/gif+xml',
      'application/pdfx',
      'x-image/png',
      'application/x-pdf',
      'image/x-webp',
    ].forEach((mime) => {
      assert.equal(extFromMime(mime), null, mime);
    });
  });

  test('returns null for a string that is not one MIME type', () => {
    [
      '',
      ' ',
      'image',
      'image/',
      '/jpeg',
      'jpeg',
      'jpg',
      '.jpg',
      'photo.jpg',
      'image/jpeg, image/png',
      'image/jpeg/extra',
      'image /jpeg',
      'image/ jpeg',
      'image/jpeg\0',
      `${BYTE_ORDER_MARK}image/jpeg`,
      '__proto__',
      'constructor',
    ].forEach((mime) => {
      assert.equal(extFromMime(mime), null, JSON.stringify(mime));
    });
  });

  test('returns null for what is not a string', () => {
    [null, undefined, 0, 1, true, {}, [], ['image/png'], Buffer.from('image/png'), { toString: () => 'image/png' }].forEach((mime) => {
      assert.equal(extFromMime(mime), null);
    });
  });

  test('reads a long hostile string in linear time', () => {
    const startedAt = performance.now();

    assert.equal(extFromMime('a'.repeat(LONG_STRING_LENGTH)), null);
    assert.equal(extFromMime(`image/${' '.repeat(LONG_STRING_LENGTH)}x`), null);
    assert.equal(extFromMime(`${' '.repeat(LONG_STRING_LENGTH)}image/jpeg`), 'jpg');
    assert.equal(extFromMime(`image/jpeg${' '.repeat(LONG_STRING_LENGTH)}`), 'jpg');
    assert.equal(extFromMime(`image/jpeg${';a="b"'.repeat(LONG_STRING_LENGTH / 10)}`), 'jpg');
    assert.ok(performance.now() - startedAt < INSTANT_MS);
  });
});
