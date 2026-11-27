import {
  STORAGE_KEY_MAX_LENGTH,
  STORAGE_KEY_REGEXP,
  isStorageKey,
  toStorageKey,
} from '#core/storage/key.js';
import { UUID_LENGTH, uuidVersion } from '#utils/id.js';
import { MIME_EXTENSIONS } from '#utils/mime.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const UUID = '019a0000-0000-7000-8000-000000000000';
const UUID_V4 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const KEYS = MIME_EXTENSIONS.map((extension) => `${UUID}.${extension}`);
const LONGEST_EXTENSION = 'webp';
const KEY_COUNT = 1000;
const HUGE_LENGTH = 1_000_000;
const INSTANT_MS = 1000;
const UUIDV7_VERSION = 7;

const PATH_KEYS = [
  '../x.png',
  `../${UUID}.png`,
  `${UUID}/../x.png`,
  'a/b.png',
  `a/${UUID}.png`,
  `/${UUID}.png`,
  `${UUID}.png/`,
  `a\\${UUID}.png`,
  `..\\${UUID}.png`,
  `C:\\${UUID}.png`,
  `${UUID}.png\\`,
  `.${UUID}.png`,
  `./${UUID}.png`,
];

const MALFORMED_KEYS = [
  '',
  UUID,
  `${UUID}.`,
  `${UUID}png`,
  `${UUID}..png`,
  `${UUID.toUpperCase()}.png`,
  `${UUID}.PNG`,
  `${UUID}.Png`,
  `${UUID}.exe`,
  `${UUID}.jpeg`,
  `${UUID}.svg`,
  `${UUID}.html`,
  `${UUID}.png.exe`,
  `${UUID}.exe.png`,
  `${UUID.replaceAll('-', '')}.png`,
  `${UUID.replaceAll('-', '_')}.png`,
  `{${UUID}}.png`,
  `${UUID.slice(1)}.png`,
  `${UUID}0.png`,
  `${UUID.slice(0, -1)}g.png`,
  ` ${UUID}.png`,
  `${UUID}.png `,
  `${UUID}.png\n`,
  `\n${UUID}.png`,
  `${UUID}.png\0`,
  `${UUID}\0.png`,
  `${UUID}.png:stream`,
  `${UUID}.${LONGEST_EXTENSION}${'p'.repeat(UUID_LENGTH)}`,
];

const NON_STRINGS = [
  null,
  undefined,
  0,
  1,
  true,
  {},
  [`${UUID}.png`],
  Buffer.from(`${UUID}.png`),
  { toString: () => `${UUID}.png` },
  Symbol(`${UUID}.png`),
];

describe('STORAGE_KEY_REGEXP', () => {
  test('matches a lower-case UUID, a dot and an extension of the whitelist, with nothing before or after them', () => {
    KEYS.forEach((key) => {
      assert.match(key, STORAGE_KEY_REGEXP);
      assert.doesNotMatch(`x${key}`, STORAGE_KEY_REGEXP);
      assert.doesNotMatch(`${key}x`, STORAGE_KEY_REGEXP);
    });

    [...PATH_KEYS, ...MALFORMED_KEYS].forEach((key) => {
      assert.doesNotMatch(key, STORAGE_KEY_REGEXP, JSON.stringify(key));
    });
  });

  test('has no flags: its source is the pattern of a JSON schema, and AJV compiles a pattern with "u"', () => {
    const pattern = new RegExp(STORAGE_KEY_REGEXP.source, 'u');

    assert.equal(STORAGE_KEY_REGEXP.flags, '');

    [...KEYS, ...PATH_KEYS, ...MALFORMED_KEYS].forEach((key) => {
      assert.equal(pattern.test(key), STORAGE_KEY_REGEXP.test(key), JSON.stringify(key));
    });
  });
});

describe('STORAGE_KEY_MAX_LENGTH', () => {
  test('is the length of a key with the longest extension: a UUID, a dot and "webp"', () => {
    assert.equal(STORAGE_KEY_MAX_LENGTH, 41);
    assert.equal(STORAGE_KEY_MAX_LENGTH, `${UUID}.${LONGEST_EXTENSION}`.length);
    assert.equal(STORAGE_KEY_MAX_LENGTH, Math.max(...KEYS.map((key) => key.length)));
  });

  test('holds every key toStorageKey makes', () => {
    MIME_EXTENSIONS.forEach((extension) => {
      assert.ok(toStorageKey(extension).length <= STORAGE_KEY_MAX_LENGTH);
    });

    assert.equal(toStorageKey(LONGEST_EXTENSION).length, STORAGE_KEY_MAX_LENGTH);
  });
});

describe('isStorageKey', () => {
  test('takes a key of every extension of the whitelist', () => {
    KEYS.forEach((key) => {
      assert.equal(isStorageKey(key), true, key);
    });
  });

  test('takes the form of any UUID, not only of a UUIDv7: the form keeps a key one file name, the version adds nothing', () => {
    assert.equal(isStorageKey(`${UUID_V4}.png`), true);
    assert.equal(isStorageKey('00000000-0000-0000-0000-000000000000.pdf'), true);
  });

  test('refuses a path: a separator of either system, a dot segment, a drive', () => {
    PATH_KEYS.forEach((key) => {
      assert.equal(isStorageKey(key), false, JSON.stringify(key));
    });
  });

  test('refuses an upper-case UUID or extension, an extension outside the whitelist and a key without one', () => {
    MALFORMED_KEYS.forEach((key) => {
      assert.equal(isStorageKey(key), false, JSON.stringify(key));
    });
  });

  test('refuses what is not a string, even when it reads as a key', () => {
    NON_STRINGS.forEach((key) => {
      assert.equal(isStorageKey(key), false);
    });
  });

  test('refuses a key past STORAGE_KEY_MAX_LENGTH, and a huge string at once', () => {
    const startedAt = performance.now();

    assert.equal(isStorageKey(`${UUID}.${LONGEST_EXTENSION}p`), false);
    assert.equal(isStorageKey(`${UUID}${UUID}.png`), false);
    assert.equal(isStorageKey('x'.repeat(HUGE_LENGTH)), false);
    assert.equal(isStorageKey(`${UUID}.png${' '.repeat(HUGE_LENGTH)}`), false);
    assert.ok(performance.now() - startedAt < INSTANT_MS);
  });
});

describe('toStorageKey', () => {
  test('names a file by a fresh UUIDv7 and the extension it is given', () => {
    MIME_EXTENSIONS.forEach((extension) => {
      const key = toStorageKey(extension);

      assert.equal(isStorageKey(key), true, key);
      assert.equal(key.endsWith(`.${extension}`), true);
      assert.equal(uuidVersion(key.slice(0, UUID_LENGTH)), UUIDV7_VERSION);
    });
  });

  test('gives a new key on every call, and the keys sort in the order they were made', () => {
    const keys = Array.from({ length: KEY_COUNT }, () => toStorageKey('png'));

    assert.equal(new Set(keys).size, KEY_COUNT);
    assert.deepEqual(keys.toSorted(), keys);
  });

  test('refuses an extension outside the whitelist: nothing else names a stored file', () => {
    ['exe', 'svg', 'html', 'jpeg', 'JPG', 'Png', '.png', 'png ', ' png', 'png/..', '../png', 'png\0', '', ...NON_STRINGS].forEach((extension) => {
      assert.throws(() => toStorageKey(extension), {
        name: 'TypeError',
        message: 'toStorageKey(extension) requires one of the extensions jpg, png, webp, gif, pdf',
      });
    });
  });
});
