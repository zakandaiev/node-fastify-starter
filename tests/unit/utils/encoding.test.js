import {
  decodeBase64Url,
  decodeFormValue,
  decodeHex,
  decodeUrlComponent,
  encodeBase64Url,
  encodeFormValue,
  encodeHex,
  encodeUrlComponent,
  encodeUrlPath,
  isBase64Url,
  isHex,
} from '#utils/encoding.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const ASTRAL_TEXT = '𝄞 Привіт 😀 你好';
const BASE64URL_ALPHABET = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_');
const EVERY_BYTE = Uint8Array.from({ length: 256 }, (unused, index) => index);
const BYTE_SAMPLES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 256].map((length) => EVERY_BYTE.subarray(0, length));
const NUL = String.fromCharCode(0);

// Characters above U+00FF whose low bytes spell "YQ" and "01": Buffer.from() has read such a text by its low bytes.
const LOW_BYTE_BASE64URL = String.fromCharCode(0x0159, 0x0151);
const LOW_BYTE_HEX = String.fromCharCode(0x0130, 0x0131);
const FULLWIDTH_DIGITS = String.fromCharCode(0xff11, 0xff12);

const RFC_4648_VECTORS = [
  ['', ''],
  ['f', 'Zg'],
  ['fo', 'Zm8'],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg'],
  ['fooba', 'Zm9vYmE'],
  ['foobar', 'Zm9vYmFy'],
];

// Each text with the bytes that Buffer.from(text, 'base64url') returns for it instead of failing, as hex.
const MALFORMED_BASE64URL = [
  ['YQ==', '61'],
  ['YQ=', '61'],
  ['YQ!', '61'],
  ['Y Q', '61'],
  ['YQ\n', '61'],
  ['+/+/', 'fbffbf'],
  ['YR', '61'],
  ['YWJ', '6162'],
  ['Y', ''],
  ['YWJjZ', '616263'],
];

// The same for Buffer.from(text, 'hex').
const MALFORMED_HEX = [
  ['abc', 'ab'],
  ['abzzcd', 'ab'],
  ['ab cd', 'ab'],
  ['ab\n', 'ab'],
  ['zz', ''],
  ['0x12', ''],
  [' ab', ''],
];

const NOT_BASE64URL = [...MALFORMED_BASE64URL.map(([text]) => text), LOW_BYTE_BASE64URL, FULLWIDTH_DIGITS, ASTRAL_TEXT];
const NOT_HEX = [...MALFORMED_HEX.map(([text]) => text), LOW_BYTE_HEX, FULLWIDTH_DIGITS, ASTRAL_TEXT];
const NOT_BYTES = [null, undefined, 0, 255, true, {}, [1, 2], new ArrayBuffer(2), new Uint16Array(2), new DataView(new ArrayBuffer(2))];
const NOT_STRINGS = [null, undefined, 0, 12, true, {}, ['YQ'], ['ab'], Buffer.from('YQ'), Buffer.from('ab')];
const LONE_SURROGATE = String.fromCharCode(0xD800);

describe('encodeBase64Url', () => {
  test('encodes a string as UTF-8 without padding: the test vectors of RFC 4648, padding removed', () => {
    RFC_4648_VECTORS.forEach(([text, encoded]) => {
      assert.equal(encodeBase64Url(text), encoded);
    });
  });

  test('uses the URL-safe alphabet', () => {
    assert.equal(encodeBase64Url(Buffer.from([0xfb, 0xff, 0xbf])), '-_-_');
    assert.match(encodeBase64Url(EVERY_BYTE), /^[A-Za-z0-9_-]{342}$/);
  });

  test('encodes a character outside the basic plane by its UTF-8 bytes', () => {
    assert.equal(encodeBase64Url('😀'), '8J-YgA');
    assert.equal(encodeBase64Url(ASTRAL_TEXT), '8J2EniDQn9GA0LjQstGW0YIg8J-YgCDkvaDlpb0');
  });

  test('encodes a Buffer and a Uint8Array by their bytes, a view by its own window', () => {
    assert.equal(encodeBase64Url(Buffer.from('foobar')), 'Zm9vYmFy');
    assert.equal(encodeBase64Url(new Uint8Array([102, 111, 111])), 'Zm9v');
    assert.equal(encodeBase64Url(new Uint8Array([0, 102, 111, 111, 0]).subarray(1, 4)), 'Zm9v');
    assert.equal(encodeBase64Url(Buffer.from('xfoox').subarray(1, 4)), 'Zm9v');
    assert.equal(encodeBase64Url(new Uint8Array(0)), '');
  });

  test('rejects what is neither a string, a Buffer nor a Uint8Array', () => {
    NOT_BYTES.forEach((value) => {
      assert.throws(() => encodeBase64Url(value), { name: 'TypeError', message: /^encodeBase64Url\(value\) requires/ });
    });
  });
});

describe('decodeBase64Url', () => {
  test('decodes a text into a Buffer: the test vectors of RFC 4648, padding removed', () => {
    RFC_4648_VECTORS.forEach(([text, encoded]) => {
      const decoded = decodeBase64Url(encoded);

      assert.ok(Buffer.isBuffer(decoded));
      assert.equal(decoded.toString('utf8'), text);
    });
  });

  test('decodes an empty string into an empty Buffer', () => {
    assert.deepEqual(decodeBase64Url(''), Buffer.alloc(0));
  });

  test('reads the URL-safe alphabet', () => {
    assert.deepEqual(decodeBase64Url('-_-_'), Buffer.from([0xfb, 0xff, 0xbf]));
  });

  test('restores what encodeBase64Url() wrote: every byte value and every size of the last group', () => {
    BYTE_SAMPLES.forEach((bytes) => {
      assert.deepEqual(decodeBase64Url(encodeBase64Url(bytes)), Buffer.from(bytes));
    });
  });

  test('restores a text with characters outside the basic plane', () => {
    assert.equal(decodeBase64Url(encodeBase64Url(ASTRAL_TEXT)).toString('utf8'), ASTRAL_TEXT);
  });

  test('returns null for padding, a character outside the alphabet and the standard base64 alphabet', () => {
    ['YQ==', 'YQ=', '=', 'YQ!', 'Y Q', ' YQ', 'YQ\n', `YQ${NUL}`, 'Y.Q', '+/+/', 'Zm9v+w', 'Zm9v/w'].forEach((text) => {
      assert.equal(decodeBase64Url(text), null, JSON.stringify(text));
    });
  });

  test('returns null for characters above U+00FF, whatever their low bytes spell', () => {
    [LOW_BYTE_BASE64URL, `Zm9v${LOW_BYTE_BASE64URL}`, FULLWIDTH_DIGITS, ASTRAL_TEXT].forEach((text) => {
      assert.equal(decodeBase64Url(text), null, JSON.stringify(text));
    });
  });

  test('returns null for a length that no byte sequence encodes to', () => {
    ['Y', 'YWJjZ', 'A'.repeat(9)].forEach((text) => {
      assert.equal(decodeBase64Url(text), null, text);
    });
  });

  test('returns null when the last character carries bits that no encoder writes', () => {
    assert.deepEqual(decodeBase64Url('YQ'), Buffer.from('a'));
    assert.equal(decodeBase64Url('YR'), null);
    assert.deepEqual(decodeBase64Url('YWI'), Buffer.from('ab'));
    assert.equal(decodeBase64Url('YWJ'), null);
  });

  test('accepts exactly one two-character text for every byte value', () => {
    const decoded = BASE64URL_ALPHABET
      .flatMap((first) => BASE64URL_ALPHABET.map((second) => decodeBase64Url(`${first}${second}`)))
      .filter((bytes) => bytes !== null);

    assert.equal(decoded.length, 256);
    assert.equal(new Set(decoded.map((bytes) => bytes[0])).size, 256);
  });

  test('returns null for every text that Buffer.from() silently turns into bytes', () => {
    MALFORMED_BASE64URL.forEach(([text, garbage]) => {
      assert.equal(Buffer.from(text, 'base64url').toString('hex'), garbage, JSON.stringify(text));
      assert.equal(decodeBase64Url(text), null, JSON.stringify(text));
    });
  });

  test('returns null for what is not a string', () => {
    NOT_STRINGS.forEach((value) => {
      assert.equal(decodeBase64Url(value), null);
    });
  });

  test('rejects a long malformed text in linear time', () => {
    const startedAt = performance.now();

    assert.equal(decodeBase64Url(`${'A'.repeat(1000000)}=`), null);
    assert.equal(decodeBase64Url(`${'-'.repeat(1000000)}!`), null);
    assert.ok(performance.now() - startedAt < 1000);
  });
});

describe('isBase64Url', () => {
  test('accepts a non-empty text that decodeBase64Url() decodes', () => {
    ['YQ', 'YWI', 'Zm9v', '-_-_', '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU', encodeBase64Url(ASTRAL_TEXT)].forEach((text) => {
      assert.equal(isBase64Url(text), true, text);
    });
  });

  test('rejects an empty string', () => {
    assert.equal(isBase64Url(''), false);
  });

  test('rejects every text that decodeBase64Url() does not decode', () => {
    NOT_BASE64URL.forEach((text) => {
      assert.equal(isBase64Url(text), false, JSON.stringify(text));
    });
  });

  test('rejects what is not a string', () => {
    NOT_STRINGS.forEach((value) => {
      assert.equal(isBase64Url(value), false);
    });
  });
});

describe('encodeHex', () => {
  test('encodes bytes as lowercase hex, two characters for a byte', () => {
    assert.equal(encodeHex(Buffer.from([0x00, 0x0f, 0xa0, 0xff])), '000fa0ff');
    assert.equal(encodeHex(EVERY_BYTE).length, 512);
    assert.match(encodeHex(EVERY_BYTE), /^[0-9a-f]+$/);
  });

  test('encodes a string by its UTF-8 bytes', () => {
    assert.equal(encodeHex(''), '');
    assert.equal(encodeHex('abc'), '616263');
    assert.equal(encodeHex('😀'), 'f09f9880');
  });

  test('encodes a Buffer and a Uint8Array by their bytes, a view by its own window', () => {
    assert.equal(encodeHex(new Uint8Array([1, 2, 3])), '010203');
    assert.equal(encodeHex(new Uint8Array([0, 1, 2, 3, 0]).subarray(1, 4)), '010203');
    assert.equal(encodeHex(Buffer.from([0, 1, 2, 3, 0]).subarray(1, 4)), '010203');
    assert.equal(encodeHex(new Uint8Array(0)), '');
  });

  test('rejects what is neither a string, a Buffer nor a Uint8Array', () => {
    NOT_BYTES.forEach((value) => {
      assert.throws(() => encodeHex(value), { name: 'TypeError', message: /^encodeHex\(value\) requires/ });
    });
  });
});

describe('decodeHex', () => {
  test('decodes a text into a Buffer', () => {
    const decoded = decodeHex('000fa0ff');

    assert.ok(Buffer.isBuffer(decoded));
    assert.deepEqual(decoded, Buffer.from([0x00, 0x0f, 0xa0, 0xff]));
  });

  test('decodes an empty string into an empty Buffer', () => {
    assert.deepEqual(decodeHex(''), Buffer.alloc(0));
  });

  test('accepts both letter cases', () => {
    ['c0ffee', 'C0FFEE', 'c0FfEe'].forEach((text) => {
      assert.deepEqual(decodeHex(text), Buffer.from([0xc0, 0xff, 0xee]));
    });
  });

  test('restores what encodeHex() wrote: every byte value and a text outside the basic plane', () => {
    BYTE_SAMPLES.forEach((bytes) => {
      assert.deepEqual(decodeHex(encodeHex(bytes)), Buffer.from(bytes));
    });

    assert.equal(decodeHex(encodeHex(ASTRAL_TEXT)).toString('utf8'), ASTRAL_TEXT);
  });

  test('returns null for an odd length and for a character that is not a hex digit', () => {
    ['a', 'abc', 'zz', 'ag', 'ab cd', ' ab', 'ab ', 'ab\n', `ab${NUL}`, '0x12', 'ab-cd', 'ab:cd'].forEach((text) => {
      assert.equal(decodeHex(text), null, JSON.stringify(text));
    });
  });

  test('returns null for characters above U+00FF, whatever their low bytes spell', () => {
    [LOW_BYTE_HEX, `ab${LOW_BYTE_HEX}`, FULLWIDTH_DIGITS, ASTRAL_TEXT].forEach((text) => {
      assert.equal(decodeHex(text), null, JSON.stringify(text));
    });
  });

  test('returns null for every text that Buffer.from() silently turns into bytes', () => {
    MALFORMED_HEX.forEach(([text, garbage]) => {
      assert.equal(Buffer.from(text, 'hex').toString('hex'), garbage, JSON.stringify(text));
      assert.equal(decodeHex(text), null, JSON.stringify(text));
    });
  });

  test('returns null for what is not a string', () => {
    NOT_STRINGS.forEach((value) => {
      assert.equal(decodeHex(value), null);
    });
  });

  test('rejects a long malformed text in linear time', () => {
    const startedAt = performance.now();

    assert.equal(decodeHex(`${'ab'.repeat(500000)}z`), null);
    assert.equal(decodeHex(`${'ab'.repeat(500000)}zz`), null);
    assert.ok(performance.now() - startedAt < 1000);
  });
});

describe('isHex', () => {
  test('accepts a non-empty text that decodeHex() decodes', () => {
    ['00', 'c0ffee', 'C0FFEE', 'c0FfEe', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'].forEach((text) => {
      assert.equal(isHex(text), true, text);
    });
  });

  test('rejects an empty string', () => {
    assert.equal(isHex(''), false);
  });

  test('rejects every text that decodeHex() does not decode', () => {
    NOT_HEX.forEach((text) => {
      assert.equal(isHex(text), false, JSON.stringify(text));
    });
  });

  test('rejects what is not a string', () => {
    NOT_STRINGS.forEach((value) => {
      assert.equal(isHex(value), false);
    });
  });
});

describe('encodeUrlComponent and decodeUrlComponent', () => {
  test('encode and decode a component as encodeURIComponent() and decodeURIComponent() do', () => {
    assert.equal(encodeUrlComponent('a b/c?d'), 'a%20b%2Fc%3Fd');
    assert.equal(decodeUrlComponent('a%20b%2Fc%3Fd'), 'a b/c?d');
  });

  test('encodeUrlComponent writes a lone surrogate as U+FFFD, as URL and URLSearchParams do, where encodeURIComponent() throws', () => {
    const text = `a${LONE_SURROGATE}b`;

    assert.throws(() => encodeURIComponent(text), URIError);
    assert.equal(encodeUrlComponent(text), 'a%EF%BF%BDb');
    assert.equal(encodeUrlPath(text), 'a%EF%BF%BDb');
    assert.equal(encodeFormValue(text), 'a%EF%BF%BDb');
  });

  test('decodeUrlComponent gives null for a broken escape and for what is not a string', () => {
    assert.equal(decodeUrlComponent('%E0%A4%A'), null);
    NOT_STRINGS.forEach((value) => {
      assert.equal(decodeUrlComponent(value), null);
    });
  });

  test('encodeUrlComponent requires a string', () => {
    NOT_STRINGS.forEach((value) => {
      assert.throws(() => encodeUrlComponent(value), { name: 'TypeError', message: 'encodeUrlComponent(text) requires a string' });
    });
  });
});

describe('encodeUrlPath', () => {
  test('writes a text as the URL serializer writes it into a path: a space as %20, ? and # escaped, the rest as it is', () => {
    assert.equal(encodeUrlPath("ab:cd ef@!'()~"), "ab:cd%20ef@!'()~");
    assert.equal(encodeUrlPath('a?b#c'), 'a%3Fb%23c');
    assert.equal(encodeUrlPath('a%2Fb/c'), 'a%2Fb/c');
  });

  test('requires a string', () => {
    NOT_STRINGS.forEach((value) => {
      assert.throws(() => encodeUrlPath(value), { name: 'TypeError', message: 'encodeUrlPath(text) requires a string' });
    });
  });
});

describe('encodeFormValue and decodeFormValue', () => {
  test("write a value as URLSearchParams does, a space as + and ~ ! ' ( ) escaped, and read it back", () => {
    assert.equal(encodeFormValue("a b~!'()*"), 'a+b%7E%21%27%28%29*');
    assert.equal(decodeFormValue('a+b%7E%21%27%28%29*'), "a b~!'()*");
  });

  test('decodeFormValue gives null for a broken escape and for what is not a string', () => {
    assert.equal(decodeFormValue('%E0%A4%A'), null);
    NOT_STRINGS.forEach((value) => {
      assert.equal(decodeFormValue(value), null);
    });
  });

  test('encodeFormValue requires a string', () => {
    NOT_STRINGS.forEach((value) => {
      assert.throws(() => encodeFormValue(value), { name: 'TypeError', message: 'encodeFormValue(text) requires a string' });
    });
  });
});
