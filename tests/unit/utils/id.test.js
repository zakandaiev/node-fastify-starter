import {
  assertUuid,
  UUID_LENGTH,
  UUID_REGEXP,
  isUuid,
  uuidTimestamp,
  uuidVersion,
  uuidv7,
} from '#utils/id.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

const V7_REGEXP = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RFC_V7 = '017f22e2-79b0-7cc3-98c4-dc0c0c07398f';
const RFC_V7_TIMESTAMP = 1645557742000;

const RFC_SAMPLES = Object.freeze({
  1: 'c232ab00-9414-11ec-b3c8-9f6bdeced846',
  3: '5df41881-3aed-3515-88a7-2f4a814cf09e',
  4: '919108f7-52d1-4320-9bac-f847db4148a8',
  5: '2ed6657d-e927-568b-95e1-2665a8aea6a2',
  6: '1ec9414c-232a-6b00-b3c8-9f6bdeced846',
  7: RFC_V7,
  8: '2489e9ad-2ee2-8e00-8ec9-32d5f69181c0',
});

const NIL = '00000000-0000-0000-0000-000000000000';
const MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const NOT_STRINGS = [null, undefined, 0, 7, true, {}, [], Symbol('id'), [RFC_V7], { toString: () => RFC_V7 }, Buffer.from(RFC_V7)];

const TIMESTAMP_MAX = 2 ** 48 - 1;
const TIMESTAMP_END = 13;
const COUNTER_MAX = 4095;
const COUNTER_SEED_MAX = 2047;
const COUNTER_START = 15;
const COUNTER_END = 18;
const RANDOM_START = 19;
const HOUR = 3600000;
const MILLISECOND_FRACTION = 1 / 128;

let mockedNow = Date.now();

// One generator serves the whole process and never follows a clock that went back: every mocked clock starts an hour after the previous one.
function mockClock(t) {
  mockedNow += HOUR;
  t.mock.timers.enable({ apis: ['Date'], now: mockedNow });

  return mockedNow;
}

function generate(count) {
  return Array.from({ length: count }, () => uuidv7());
}

function toBigInt(id) {
  return BigInt(`0x${id.replaceAll('-', '')}`);
}

function counterOf(id) {
  return Number.parseInt(id.slice(COUNTER_START, COUNTER_END), 16);
}

function randomOf(id) {
  return id.slice(RANDOM_START).replace('-', '');
}

function assertAscending(ids) {
  ids.slice(1).forEach((id, index) => {
    assert.ok(id > ids[index], `${id} must sort after ${ids[index]}`);
    assert.ok(toBigInt(id) > toBigInt(ids[index]), `${id} must be greater than ${ids[index]}`);
  });
}

describe('uuidv7', () => {
  // The real clock goes first: a mocked one leaves the generator hours ahead of it.
  test('stores the time of the call', () => {
    const before = Date.now();
    const timestamp = uuidTimestamp(uuidv7());
    const after = Date.now();

    assert.ok(timestamp >= before && timestamp <= after, `${timestamp} is outside ${before}..${after}`);
  });

  test('returns a lowercase UUID of version 7 with the variant bits 10', () => {
    generate(1000).forEach((id) => {
      assert.match(id, V7_REGEXP);
      assert.equal(isUuid(id), true);
      assert.equal(uuidVersion(id), 7);
    });
  });

  test('is strictly ascending, as a string and as a number, and unique over 10000 consecutive calls', () => {
    const ids = generate(10000);

    assertAscending(ids);
    assert.deepEqual(ids.toSorted(), ids);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('takes no arguments, so it can be passed as a callback', () => {
    assert.equal(uuidv7.length, 0);
    [{ url: '/' }, true, 16].map(uuidv7).forEach((id) => {
      assert.match(id, V7_REGEXP);
    });
  });

  test('reads Date.now() at every call and writes it into the first 48 bits, the most significant byte first', (t) => {
    const start = mockClock(t);
    const id = uuidv7();

    assert.equal(id.slice(0, TIMESTAMP_END).replace('-', ''), start.toString(16).padStart(12, '0'));
    assert.equal(uuidTimestamp(id), start);

    t.mock.timers.tick(1);

    assert.equal(uuidTimestamp(uuidv7()), start + 1);
  });

  test('seeds the counter at every new millisecond with a random value whose top bit is zero', (t) => {
    mockClock(t);

    const seeds = Array.from({ length: 300 }, () => {
      t.mock.timers.tick(1);

      return counterOf(uuidv7());
    });

    // 300 draws out of 2048 values give about 279 different ones.
    assert.ok(new Set(seeds).size > 200, `only ${new Set(seeds).size} different seeds out of 300`);
    assert.ok(seeds.every((seed) => seed <= COUNTER_SEED_MAX));
    assert.ok(seeds.some((seed) => seed > COUNTER_SEED_MAX / 2));
  });

  test('counts up by one inside a millisecond, which holds at least 2049 ids', (t) => {
    const start = mockClock(t);
    const ids = generate(COUNTER_MAX - COUNTER_SEED_MAX + 1);
    const seed = counterOf(ids[0]);

    ids.forEach((id, index) => {
      assert.equal(uuidTimestamp(id), start);
      assert.equal(counterOf(id), seed + index);
    });
  });

  test('draws the 62 bits after the variant anew for every id, inside one millisecond too', (t) => {
    const start = mockClock(t);
    const ids = generate(2000);
    const randoms = ids.map(randomOf);
    const [variantDigits, ...randomDigits] = Array.from(
      { length: randoms[0].length },
      (unused, index) => new Set(randoms.map((random) => random[index])),
    );

    assert.equal(uuidTimestamp(ids.at(-1)), start);
    assert.equal(new Set(randoms).size, randoms.length);
    assert.deepEqual([...variantDigits].sort(), ['8', '9', 'a', 'b']);
    assert.equal(randomDigits.length, 15);
    randomDigits.forEach((digits) => {
      assert.equal(digits.size, 16);
    });
  });

  test('moves the timestamp one millisecond ahead and reseeds the counter when it overflows under a clock that stands still', (t) => {
    const start = mockClock(t);
    const ids = generate(20000);
    const ahead = uuidTimestamp(ids.at(-1)) - start;
    const reseeds = ids.slice(1).filter((id, index) => uuidTimestamp(id) !== uuidTimestamp(ids[index])).map(counterOf);

    assertAscending(ids);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(uuidTimestamp(ids[0]), start);
    // A millisecond holds 2049 to 4096 ids, so 20000 of them take 5 to 10 milliseconds.
    assert.ok(ahead >= 4 && ahead <= 9, `20000 ids took ${ahead + 1} milliseconds`);
    assert.equal(reseeds.length, ahead);
    assert.ok(new Set(reseeds).size > 1, `every overflow restarted the counter from ${reseeds[0]}`);

    ids.slice(1).forEach((id, index) => {
      const previous = ids[index];

      if (uuidTimestamp(id) === uuidTimestamp(previous)) {
        assert.equal(counterOf(id), counterOf(previous) + 1);
      } else {
        assert.equal(uuidTimestamp(id), uuidTimestamp(previous) + 1);
        assert.equal(counterOf(previous), COUNTER_MAX);
        assert.ok(counterOf(id) <= COUNTER_SEED_MAX);
      }
    });
  });

  test('keeps counting at a timestamp that ran ahead until the clock passes it', (t) => {
    const start = mockClock(t);
    // One id more than a millisecond can hold, and too few to fill the next one as well.
    const last = generate(COUNTER_MAX + 2).at(-1);

    assert.equal(uuidTimestamp(last), start + 1);

    t.mock.timers.tick(1);

    const caughtUp = uuidv7();

    assert.equal(uuidTimestamp(caughtUp), start + 1);
    assert.equal(counterOf(caughtUp), counterOf(last) + 1);

    t.mock.timers.tick(1);

    assert.equal(uuidTimestamp(uuidv7()), start + 2);
  });

  test('keeps the last timestamp while the clock is behind it and follows the clock again afterwards', (t) => {
    const start = mockClock(t);
    const before = generate(3);

    t.mock.timers.setTime(start - 1);

    const behind = generate(3);

    t.mock.timers.setTime(0);

    const atEpoch = generate(3);

    t.mock.timers.setTime(start + 5);

    const after = uuidv7();

    assertAscending([...before, ...behind, ...atEpoch, after]);
    [...behind, ...atEpoch].forEach((id, index) => {
      assert.equal(uuidTimestamp(id), start);
      assert.equal(counterOf(id), counterOf(before.at(-1)) + index + 1);
    });
    assert.equal(uuidTimestamp(after), start + 5);
  });

  test('drops the fraction of a millisecond that a mocked clock may show', (t) => {
    const start = mockClock(t);
    const ids = Array.from({ length: 100 }, () => {
      t.mock.timers.tick(MILLISECOND_FRACTION);

      return uuidv7();
    });
    const seed = counterOf(ids[0]);

    ids.forEach((id, index) => {
      assert.equal(uuidTimestamp(id), start);
      assert.equal(counterOf(id), seed + index);
    });
  });

  test('throws a RangeError for a clock wider than 48 bits and goes on once the clock fits again', (t) => {
    const start = mockClock(t);
    const before = uuidv7();

    t.mock.timers.setTime(TIMESTAMP_MAX + 1);

    assert.throws(() => uuidv7(), { name: 'RangeError', message: /^uuidv7\(\) / });

    t.mock.timers.setTime(start + 1);

    const after = uuidv7();

    assertAscending([before, after]);
    assert.equal(uuidTimestamp(after), start + 1);
  });
});

describe('UUID_REGEXP', () => {
  test('matches lowercase hex digits in the 8-4-4-4-12 form, whatever the version', () => {
    [...Object.values(RFC_SAMPLES), NIL, MAX, uuidv7(), randomUUID()].forEach((value) => {
      assert.match(value, UUID_REGEXP);
    });
  });

  test('has no flags: "i" would let upper case in, "g" would make test() remember the last match', () => {
    assert.equal(UUID_REGEXP.flags, '');
    assert.equal(UUID_REGEXP.test(RFC_V7), true);
    assert.equal(UUID_REGEXP.test(RFC_V7), true);
    assert.equal(UUID_REGEXP.lastIndex, 0);
  });

  test('is anchored at both ends, so its source serves as a pattern of a JSON schema', () => {
    const pattern = new RegExp(UUID_REGEXP.source, 'u');

    assert.equal(pattern.test(RFC_V7), true);
    assert.equal(pattern.test(`x${RFC_V7}`), false);
    assert.equal(pattern.test(`${RFC_V7}x`), false);
    assert.equal(pattern.test(`${RFC_V7}\n`), false);
  });
});

describe('isUuid', () => {
  test('accepts a canonical UUID of any version', () => {
    [...Object.values(RFC_SAMPLES), NIL, MAX, uuidv7(), randomUUID()].forEach((value) => {
      assert.equal(isUuid(value), true, value);
    });
  });

  test('rejects upper case', () => {
    [RFC_V7.toUpperCase(), '017F22e2-79b0-7cc3-98c4-dc0c0c07398f', '017f22e2-79b0-7cc3-98c4-dc0c0c07398F', MAX.toUpperCase()].forEach((value) => {
      assert.equal(isUuid(value), false, value);
    });
  });

  test('rejects the form without hyphens, in braces and as a URN', () => {
    [RFC_V7.replaceAll('-', ''), `{${RFC_V7}}`, `urn:uuid:${RFC_V7}`, `0x${RFC_V7.replaceAll('-', '')}`].forEach((value) => {
      assert.equal(isUuid(value), false, value);
    });
  });

  test('rejects whitespace around the value, a trailing newline included', () => {
    [` ${RFC_V7}`, `${RFC_V7} `, `${RFC_V7}\n`, `${RFC_V7}\r\n`, `\n${RFC_V7}`, `\t${RFC_V7}`, `${RFC_V7}\u0000`].forEach((value) => {
      assert.equal(isUuid(value), false, JSON.stringify(value));
    });
  });

  test('rejects a wrong length, misplaced hyphens and characters that are not ASCII hex digits', () => {
    [
      '',
      RFC_V7.slice(1),
      RFC_V7.slice(0, -1),
      `${RFC_V7}0`,
      `${RFC_V7}-${RFC_V7}`,
      '017f22e27-9b0-7cc3-98c4-dc0c0c07398f',
      '017f22e2-79b07cc3-98c4-dc0c0c07398f-',
      '017f22e2_79b0_7cc3_98c4_dc0c0c07398f',
      '017f22e2-79b0-7cc3-98c4-dc0c0c07398g',
      '017f22e2-79b0-7cc3-98c4-dc0c0c07398а',
      '０17f22e2-79b0-7cc3-98c4-dc0c0c07398f',
      '-'.repeat(RFC_V7.length),
    ].forEach((value) => {
      assert.equal(isUuid(value), false, JSON.stringify(value));
    });
  });

  test('rejects what is not a string, even when it converts to a UUID', () => {
    NOT_STRINGS.forEach((value) => {
      assert.equal(isUuid(value), false);
    });
  });

  test('rejects a long hostile string in no time', () => {
    const startedAt = performance.now();

    assert.equal(isUuid('a'.repeat(1000000)), false);
    assert.equal(isUuid(`${RFC_V7}${'-0'.repeat(500000)}`), false);
    assert.equal(isUuid(`${'0'.repeat(1000000)}${RFC_V7}`), false);
    assert.ok(performance.now() - startedAt < 1000);
  });
});

describe('assertUuid', () => {
  test('passes a UUID and gives true', () => {
    assert.equal(assertUuid(RFC_V7, 'readUser(userId)', 'a user'), true);
    assert.equal(assertUuid(uuidv7(), 'readUser(userId)', 'a user'), true);
  });

  test('refuses what isUuid refuses with a TypeError that names the caller and the row', () => {
    ['', RFC_V7.toUpperCase(), `{${RFC_V7}}`, ...NOT_STRINGS].forEach((value) => {
      assert.throws(() => assertUuid(value, 'readUser(userId)', 'a user'), {
        name: 'TypeError',
        message: 'readUser(userId) requires the UUID of a user',
      }, String(value));
    });
  });

  test('refuses a call without the signature of the caller or the name of the row before it looks at the value', () => {
    [[undefined, 'a user'], ['readUser(userId)', undefined], [42, 'a user'], ['readUser(userId)', null]].forEach(([signature, what]) => {
      assert.throws(() => assertUuid(RFC_V7, signature, what), {
        name: 'TypeError',
        message: 'assertUuid(value, signature, what) requires the signature of the caller and the name of the row',
      });
    });
  });
});

describe('UUID_LENGTH', () => {
  test('equals the length of every id uuidv7() makes', () => {
    generate(1000).forEach((id) => assert.equal(id.length, UUID_LENGTH, id));
  });

  test('equals the length of every text isUuid accepts, and one character less or more is refused', () => {
    [...Object.values(RFC_SAMPLES), NIL, MAX, randomUUID()].forEach((value) => {
      assert.equal(value.length, UUID_LENGTH, value);
      assert.equal(isUuid(value), true, value);
      assert.equal(isUuid(value.slice(1)), false, value);
      assert.equal(isUuid(`${value}0`), false, value);
    });
  });
});

describe('uuidVersion', () => {
  test('returns the version nibble as a number', () => {
    Object.entries(RFC_SAMPLES).forEach(([version, value]) => {
      assert.equal(uuidVersion(value), Number(version));
    });

    assert.equal(uuidVersion(uuidv7()), 7);
    assert.equal(uuidVersion(randomUUID()), 4);
  });

  test('returns 0 for the nil UUID and 15 for the max UUID', () => {
    assert.equal(uuidVersion(NIL), 0);
    assert.equal(uuidVersion(MAX), 15);
  });

  test('returns null for what is not a UUID', () => {
    [RFC_V7.toUpperCase(), RFC_V7.replaceAll('-', ''), `${RFC_V7}\n`, '', '7', ...NOT_STRINGS].forEach((value) => {
      assert.equal(uuidVersion(value), null);
    });
  });
});

describe('uuidTimestamp', () => {
  test('returns the Unix milliseconds stored in a UUID of version 7', () => {
    assert.equal(uuidTimestamp(RFC_V7), RFC_V7_TIMESTAMP);
    assert.equal(new Date(uuidTimestamp(RFC_V7)).toISOString(), '2022-02-22T19:22:22.000Z');
  });

  test('reads both ends of the 48 bits, and a zero timestamp is not null', () => {
    assert.equal(uuidTimestamp('00000000-0000-7000-8000-000000000000'), 0);
    assert.equal(uuidTimestamp('ffffffff-ffff-7fff-bfff-ffffffffffff'), TIMESTAMP_MAX);
  });

  test('returns null for a UUID of any other version', () => {
    const others = Object.values(RFC_SAMPLES).filter((value) => value !== RFC_V7);

    [...others, NIL, MAX, randomUUID()].forEach((value) => {
      assert.equal(uuidTimestamp(value), null, value);
    });
  });

  test('returns null for what is not a UUID', () => {
    [RFC_V7.toUpperCase(), RFC_V7.replaceAll('-', ''), `${RFC_V7}\n`, '', '1645557742000', ...NOT_STRINGS].forEach((value) => {
      assert.equal(uuidTimestamp(value), null);
    });
  });
});
