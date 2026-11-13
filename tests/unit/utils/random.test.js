import {
  ALPHABET,
  pick,
  randomInt,
  randomString,
  randomToken,
} from '#utils/random.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const DRAWS = 2000;

function draw(count, fn) {
  return Array.from({ length: count }, () => fn());
}

describe('ALPHABET', () => {
  test('is frozen and holds unique characters', () => {
    assert.ok(Object.isFrozen(ALPHABET));
    assert.equal(ALPHABET.ALPHANUMERIC.length, 62);
    assert.equal(new Set(ALPHABET.ALPHANUMERIC).size, 62);
    assert.equal(ALPHABET.DIGITS, '0123456789');
  });
});

describe('randomInt', () => {
  test('returns integers from the whole range, both bounds included', () => {
    const values = draw(DRAWS, () => randomInt(1, 3));

    assert.deepEqual([...new Set(values)].sort(), [1, 2, 3]);
  });

  test('supports negative bounds and a range of one value', () => {
    const values = draw(DRAWS, () => randomInt(-2, 0));

    assert.deepEqual([...new Set(values)].sort((a, b) => a - b), [-2, -1, 0]);
    assert.equal(randomInt(5, 5), 5);
    assert.equal(randomInt(-7, -7), -7);
  });

  test('works at the edges of the safe integers and of the widest range', () => {
    const top = randomInt(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER);
    const wide = randomInt(0, 2 ** 48 - 2);

    assert.ok(top === Number.MAX_SAFE_INTEGER - 1 || top === Number.MAX_SAFE_INTEGER);
    assert.ok(Number.isSafeInteger(wide) && wide >= 0 && wide <= 2 ** 48 - 2);
  });

  test('rejects bounds that are not safe integers, reversed bounds and a range that is too wide', () => {
    [[1.5, 3], [1, '3'], [Number.NaN, 3], [0, Infinity], [0, 2 ** 53], [undefined, 3], [3, 1], [0, 2 ** 48 - 1]].forEach(([min, max]) => {
      assert.throws(() => randomInt(min, max), { name: 'RangeError', message: /^randomInt\(/ });
    });
  });
});

describe('randomString', () => {
  test('returns 16 alphanumeric characters by default', () => {
    assert.match(randomString(), /^[0-9a-zA-Z]{16}$/);
  });

  test('returns the requested length from the given alphabet', () => {
    assert.equal(randomString(0), '');
    assert.match(randomString(1), /^[0-9a-zA-Z]$/);
    assert.match(randomString(6, ALPHABET.DIGITS), /^[0-9]{6}$/);
    assert.match(randomString(500, 'ab'), /^[ab]{500}$/);
  });

  test('does not repeat itself', () => {
    assert.equal(new Set(draw(DRAWS, () => randomString())).size, DRAWS);
  });

  test('uses every character of the alphabet', () => {
    assert.equal(new Set(randomString(5000, ALPHABET.ALPHANUMERIC)).size, 62);
  });

  test('treats a character outside the basic plane as one symbol', () => {
    const symbols = Array.from(randomString(200, '😀😎🤖'));

    assert.equal(symbols.length, 200);
    assert.deepEqual([...new Set(symbols)].sort(), ['😀', '😎', '🤖'].sort());
  });

  // With "byte % 200" the bytes 200..255 land on the first 56 symbols again: their share would be 44 %, not 28 %.
  test('has no modulo bias on an alphabet that does not divide 256', () => {
    const size = 200;
    const length = 200000;
    const alphabet = Array.from({ length: size }, (unused, index) => String.fromCodePoint(0x100 + index));
    const firstSymbols = new Set(alphabet.slice(0, 256 - size));
    const hits = Array.from(randomString(length, alphabet.join(''))).filter((symbol) => firstSymbols.has(symbol)).length;
    const share = hits / length;

    assert.ok(share > 0.26 && share < 0.30, `the share of the first symbols is ${share}`);
  });

  test('rejects an invalid length', () => {
    [-1, 1.5, Number.NaN, Infinity, '16', null].forEach((length) => {
      assert.throws(() => randomString(length), { name: 'RangeError', message: /^randomString\(/ });
    });
  });

  test('rejects an alphabet that is too short, too long, repeats a character or is not a string', () => {
    const tooLong = Array.from({ length: 257 }, (unused, index) => String.fromCodePoint(0x100 + index)).join('');

    ['', 'a', 'aa', 'abca', tooLong, null, 123, ['a', 'b']].forEach((alphabet) => {
      assert.throws(() => randomString(8, alphabet), { name: 'TypeError', message: /^randomString\(/ });
    });
  });
});

describe('randomToken', () => {
  test('returns 32 random bytes as base64url by default', () => {
    assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
  });

  test('returns the requested number of bytes', () => {
    assert.match(randomToken(16), /^[A-Za-z0-9_-]{22}$/);
    assert.match(randomToken(48), /^[A-Za-z0-9_-]{64}$/);
  });

  test('does not repeat itself', () => {
    assert.equal(new Set(draw(DRAWS, () => randomToken())).size, DRAWS);
  });

  test('rejects a length that is not an integer or is too short to be a secret', () => {
    [0, 1, 15, -32, 16.5, Number.NaN, Infinity, '32', null].forEach((byteLength) => {
      assert.throws(() => randomToken(byteLength), { name: 'RangeError', message: /^randomToken\(/ });
    });
  });
});

describe('pick', () => {
  test('returns an item of the array, and every item sooner or later', () => {
    const items = ['a', 'b', 'c'];
    const picked = draw(DRAWS, () => pick(items));

    assert.deepEqual([...new Set(picked)].sort(), items);
  });

  test('returns the only item of a one-item array and null for an empty one', () => {
    assert.equal(pick(['only']), 'only');
    assert.equal(pick([]), null);
  });

  test('rejects what is not an array', () => {
    ['abc', null, undefined, { length: 1 }, new Set([1])].forEach((items) => {
      assert.throws(() => pick(items), { name: 'TypeError', message: /^pick\(/ });
    });
  });
});
