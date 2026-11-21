import { runNode } from '#root/tests/helper/process.js';
import {
  ISO_DATE_LENGTH,
  ISO_DATE_TIME_MAX_LENGTH,
  addToDate,
  convertStringToMs,
  convertStringToSeconds,
  differenceInDays,
  getEndOfDay,
  getStartOfDay,
  isExpired,
  isFuture,
  isIsoDate,
  isPast,
  isUtcDateTime,
  nowUtc,
  parseStrictUtc,
  toDate,
  toTimestamp,
  toUtcIso,
} from '#utils/date.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';
import vm from 'node:vm';

const PRINT_DATES = 'tests/fixture/print-dates.js';

const MOMENT = '2026-01-31T10:20:30.456Z';
const MOMENT_MS = 1769854830456;
const NOW = '2026-01-31T10:00:00.000Z';

const MAX_MS = 8.64e15;
const YEAR_0000_START_MS = -62167219200000;
const YEAR_9999_END_MS = 253402300799999;
const MINUTE_MS = 60000;
const HOUR_MS = 3600000;

const LONG = 200000;
const INSTANT_MS = 1000;

const NO_BREAK_SPACE = String.fromCharCode(0xA0);
const ARABIC_TEN = String.fromCharCode(0x661, 0x660);
const FULLWIDTH_2026 = String.fromCharCode(0xFF12, 0xFF10, 0xFF12, 0xFF16);

const NOT_MOMENTS = [
  null,
  undefined,
  true,
  false,
  Number.NaN,
  Infinity,
  -Infinity,
  MAX_MS + 1,
  10n,
  {},
  [],
  [MOMENT_MS],
  [MOMENT],
  { getTime: () => MOMENT_MS },
  Symbol('moment'),
  () => MOMENT_MS,
  new Date(Number.NaN),
  '',
  'not a date',
  '2026-01-31T10:20:30',
  '2026-02-30T10:20:30Z',
  String(MOMENT_MS),
];

const NOT_DURATIONS = ['', 'm', '10', '10 m', '10min', '1M', 600, null, ['10m']];

const LONGEST_UTC_DATE_TIME = '2026-11-20T10:00:00.123456789+00:00';

const UTC_DATE_TIMES = [
  MOMENT,
  '2026-01-31T10:20:30.456+00:00',
  '2026-01-31T10:20:30Z',
  '2026-01-31T10:20:30+00:00',
  '2026-01-31T10:20:30.4Z',
  '2024-02-29T23:59:59.999Z',
  '0000-01-01T00:00:00Z',
  '9999-12-31T23:59:59.999999999Z',
  LONGEST_UTC_DATE_TIME,
];

const NOT_UTC_DATE_TIMES = Object.freeze({
  otherOffsets: [
    '2026-01-31T12:20:30+02:00',
    '2026-01-31T05:20:30-05:00',
    '2026-01-31T10:50:30+00:30',
    '2026-01-31T10:20:30-00:00',
    '2026-01-31T10:20:30+0000',
    '2026-01-31T10:20:30+00',
    '2026-01-31T10:20:30z',
  ],
  zoneless: ['2026-01-31T10:20:30', '2026-01-31T10:20:30.456', '2026-01-31 10:20:30'],
  dateOnly: ['2026-01-31', '2026-01-31Z', '2026-01-31+00:00', '2026-01-31T10:20Z', '2026-01-31T10Z'],
  impossible: [
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00+00:00',
    '2026-13-01T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-01-15T24:00:00Z',
    '2026-01-15T10:60:00Z',
    '2016-12-31T23:59:60Z',
  ],
  malformed: [
    '',
    ' 2026-01-31T10:20:30Z',
    '2026-01-31T10:20:30Z ',
    '2026-01-31 10:20:30Z',
    '2026-01-31T10:20:30.Z',
    '2026-01-31T10:20:30.1234567890Z',
    'Sat, 31 Jan 2026 10:20:30 GMT',
  ],
});

const NOT_STRING_MOMENTS = [
  new Date(MOMENT_MS),
  MOMENT_MS,
  0,
  10n,
  null,
  undefined,
  true,
  {},
  [MOMENT],
  { toString: () => MOMENT },
  Symbol(MOMENT),
  Object.create(null),
  // eslint-disable-next-line no-new-wrappers -- the wrapper object is the case under test
  new String(MOMENT),
];

// New York is behind UTC and moves its clocks on this night, Kolkata is ahead of UTC by a half-hour offset.
const LOCAL_MIDNIGHTS = Object.freeze({
  'America/New_York': '2026-03-08T05:00:00.000Z',
  'Asia/Kolkata': '2026-03-07T18:30:00.000Z',
});

const ZONE_FREE_RESULTS = Object.freeze({
  dateOnly: '2026-03-08T00:00:00.000Z',
  zoneLess: null,
  freeForm: null,
  offset: '2026-03-07T21:00:00.000Z',
  timestamp: 1772928000000,
  iso: '2026-03-08T06:59:59.999Z',
  strict: '2026-03-08T06:59:59.999Z',
  nextDay: '2026-03-09T00:00:00.000Z',
  startOfDay: '2026-03-08T00:00:00.000Z',
  endOfDay: '2026-03-08T23:59:59.999Z',
  days: 2,
  seconds: 86400,
  isPast: true,
  isFuture: true,
  isExpired: true,
});

function assertReads(read, cases) {
  cases.forEach(([value, expected]) => {
    assert.equal(read(value)?.toISOString(), expected, inspect(value));
  });
}

function assertNull(read, values) {
  values.forEach((value) => {
    assert.equal(read(value), null, inspect(value));
  });
}

function assertThrows(call, values) {
  values.forEach((value) => {
    assert.throws(() => call(value), TypeError, inspect(value));
  });
}

function assertInstant(run) {
  const startedAt = performance.now();

  run();

  assert.ok(performance.now() - startedAt < INSTANT_MS);
}

function assertAnswers(read, values, expected) {
  values.forEach((value) => {
    assert.equal(read(value), expected, inspect(value));
  });
}

function isReadByParseStrictUtc(value) {
  try {
    parseStrictUtc(value);
  } catch {
    return false;
  }

  return true;
}

describe('nowUtc', () => {
  test('returns the current moment as a new Date on every call', () => {
    const before = Date.now();
    const now = nowUtc();
    const after = Date.now();

    assert.ok(now instanceof Date);
    assert.ok(now.getTime() >= before && now.getTime() <= after);
    assert.notEqual(nowUtc(), now);
  });

  test('follows the mocked clock of node:test, and the default now of every predicate follows with it', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: MOMENT_MS });

    assert.equal(nowUtc().getTime(), MOMENT_MS);
    assert.equal(toUtcIso(nowUtc()), MOMENT);
    assert.equal(isPast(MOMENT_MS), false);
    assert.equal(isFuture(MOMENT_MS + 1), true);
    assert.equal(isExpired(MOMENT_MS + 1), false);
    assert.equal(isExpired(MOMENT_MS, '1s'), false);

    t.mock.timers.tick(1000);

    assert.equal(nowUtc().getTime(), MOMENT_MS + 1000);
    assert.equal(isPast(MOMENT_MS), true);
    assert.equal(isFuture(MOMENT_MS + 1), false);
    assert.equal(isExpired(MOMENT_MS + 1), true);
    assert.equal(isExpired(MOMENT_MS, '1s'), true);
    assert.equal(isExpired(MOMENT, '1.001s'), false);
  });
});

describe('toDate', () => {
  test('returns a copy of a Date, never the Date itself', () => {
    const date = new Date(MOMENT_MS);
    const copy = toDate(date);

    copy.setTime(0);

    assert.notEqual(copy, date);
    assert.equal(date.getTime(), MOMENT_MS);
    assert.equal(toDate(date).getTime(), MOMENT_MS);
  });

  test('returns null for an invalid Date', () => {
    assert.equal(toDate(new Date(Number.NaN)), null);
  });

  test('tells a Date by what it is, not by its prototype chain', () => {
    const foreign = vm.runInNewContext('new Date(0)');

    assert.equal(foreign instanceof Date, false);
    assert.equal(toDate(foreign).getTime(), 0);
    assert.ok(toDate(foreign) instanceof Date);
    assert.equal(toDate(Object.create(Date.prototype)), null);
  });

  test('reads a finite number as Unix milliseconds and drops a fraction of a millisecond', () => {
    assertReads(toDate, [
      [0, '1970-01-01T00:00:00.000Z'],
      [-1, '1969-12-31T23:59:59.999Z'],
      [MOMENT_MS, MOMENT],
      [MOMENT_MS + 0.9, MOMENT],
    ]);
  });

  test('returns null for a number outside the range a Date can hold', () => {
    assert.equal(toDate(MAX_MS).getTime(), MAX_MS);
    assert.equal(toDate(-MAX_MS).getTime(), -MAX_MS);
    assertNull(toDate, [MAX_MS + 1, -MAX_MS - 1, Number.MAX_VALUE, Number.NaN, Infinity, -Infinity]);
  });

  test('reads an ISO 8601 date-time with "Z" or with an offset and moves it to UTC', () => {
    assertReads(toDate, [
      ['2026-01-31T10:20:30Z', '2026-01-31T10:20:30.000Z'],
      ['2026-01-31T10:20:30.456Z', '2026-01-31T10:20:30.456Z'],
      ['2026-01-31T10:20:30+00:00', '2026-01-31T10:20:30.000Z'],
      ['2026-01-31T10:20:30-00:00', '2026-01-31T10:20:30.000Z'],
      ['2026-01-31T10:20:30+02:00', '2026-01-31T08:20:30.000Z'],
      ['2026-01-31T10:20:30.456-05:30', '2026-01-31T15:50:30.456Z'],
      ['2026-01-31T10:20:30+23:59', '2026-01-30T10:21:30.000Z'],
      ['2026-01-31T10:20:30-23:59', '2026-02-01T10:19:30.000Z'],
    ]);
  });

  test('carries an offset over the end of a month and of a year', () => {
    assertReads(toDate, [
      ['2026-03-01T00:30:00+02:00', '2026-02-28T22:30:00.000Z'],
      ['2024-03-01T00:30:00+02:00', '2024-02-29T22:30:00.000Z'],
      ['2026-01-01T00:30:00+02:00', '2025-12-31T22:30:00.000Z'],
      ['2026-12-31T23:30:00-01:00', '2027-01-01T00:30:00.000Z'],
    ]);
  });

  test('cuts a fraction of one to nine digits down to milliseconds without rounding it', () => {
    assertReads(toDate, [
      ['2026-01-31T10:20:30.4Z', '2026-01-31T10:20:30.400Z'],
      ['2026-01-31T10:20:30.45Z', '2026-01-31T10:20:30.450Z'],
      ['2026-01-31T10:20:30.045Z', '2026-01-31T10:20:30.045Z'],
      ['2026-01-31T10:20:30.456789Z', '2026-01-31T10:20:30.456Z'],
      ['2026-01-31T10:20:30.456789123+02:00', '2026-01-31T08:20:30.456Z'],
      ['2026-01-31T10:20:30.000999Z', '2026-01-31T10:20:30.000Z'],
      ['2026-12-31T23:59:59.999999999Z', '2026-12-31T23:59:59.999Z'],
    ]);
  });

  test('reads the date-only form as UTC midnight', () => {
    assertReads(toDate, [
      ['2026-01-31', '2026-01-31T00:00:00.000Z'],
      ['2026-12-31', '2026-12-31T00:00:00.000Z'],
      ['1970-01-01', '1970-01-01T00:00:00.000Z'],
      ['1969-12-31', '1969-12-31T00:00:00.000Z'],
    ]);
  });

  test('reads a leap day in a leap year only', () => {
    assertReads(toDate, [
      ['2024-02-29', '2024-02-29T00:00:00.000Z'],
      ['2024-02-29T23:59:59.999Z', '2024-02-29T23:59:59.999Z'],
      ['2000-02-29', '2000-02-29T00:00:00.000Z'],
    ]);
    assertNull(toDate, ['2026-02-29', '2025-02-29T12:00:00Z', '1900-02-29', '2100-02-29']);
  });

  test('reads the years 0000 to 0099 as written, not as 1900 to 1999', () => {
    assertReads(toDate, [
      ['0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000Z'],
      ['0099-12-31T23:59:59Z', '0099-12-31T23:59:59.000Z'],
      ['0000-02-29', '0000-02-29T00:00:00.000Z'],
    ]);
    assert.equal(toDate('0000-01-01').getTime(), YEAR_0000_START_MS);
    assert.equal(toDate('9999-12-31T23:59:59.999Z').getTime(), YEAR_9999_END_MS);
  });

  test('returns null for a date-time without a zone: the engine would read it in the local time zone', () => {
    assertNull(toDate, ['2026-01-31T10:20:30', '2026-01-31T10:20:30.456', '2026-01-31T10:20', '2026-01-31 10:20:30']);
  });

  test('returns null for a free form, even one that names its zone', () => {
    assertNull(toDate, [
      'Jan 1 2026',
      'January 31, 2026 10:20:30',
      '01/31/2026',
      '31.01.2026',
      'Sat, 31 Jan 2026 10:20:30 GMT',
      '2026',
      '2026-01',
      'now',
      '',
      ' ',
    ]);
  });

  test('returns null for a numeric string: it is not a number', () => {
    assertNull(toDate, [String(MOMENT_MS), '0', '-1']);
  });

  test('returns null for a calendar date that does not exist instead of rolling it over', () => {
    assertNull(toDate, [
      '2026-02-30T00:00:00Z',
      '2026-02-31',
      '2026-04-31',
      '2026-06-31T00:00:00+02:00',
      '2026-09-31',
      '2026-11-31T23:59:59.999Z',
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
      '2026-01-32',
      '0000-00-00',
      '0000-00-00T00:00:00Z',
    ]);
  });

  test('returns null for hour 24, minute 60 and a leap second instead of carrying them over', () => {
    assertNull(toDate, [
      '2026-01-15T24:00:00Z',
      '2026-01-15T10:60:00Z',
      '2026-01-15T10:20:60Z',
      '2026-01-31T24:00:00Z',
      '2016-12-31T23:59:60Z',
      '9999-12-31T24:00:00Z',
      '2026-01-15T99:99:99Z',
    ]);
  });

  test('returns null for lower-case "t" and "z" and for a space in place of "T"', () => {
    assertNull(toDate, ['2026-01-31t10:20:30z', '2026-01-31T10:20:30z', '2026-01-31t10:20:30Z', '2026-01-31 10:20:30Z']);
  });

  test('returns null for the other forms of ISO 8601: no seconds, basic, week, ordinal, short and expanded', () => {
    assertNull(toDate, [
      '2026-01-31T10:20Z',
      '2026-01-31T10Z',
      '20260131T102030Z',
      '20260131',
      '2026-W05-6',
      '2026-031',
      '2026-1-31',
      '2026-01-31T1:20:30Z',
      '+002026-01-31T10:20:30Z',
      '-000001-01-01T00:00:00Z',
      '12026-01-31',
    ]);
  });

  test('returns null for a fraction that is empty, longer than nine digits or written with a comma', () => {
    assertNull(toDate, ['2026-01-31T10:20:30.Z', '2026-01-31T10:20:30.1234567890Z', '2026-01-31T10:20:30,5Z']);
  });

  test('returns null for a zone written in another way than "Z" or "+HH:MM" within a day', () => {
    assertNull(toDate, [
      '2026-01-31T10:20:30+0200',
      '2026-01-31T10:20:30+02',
      '2026-01-31T10:20:30+2:00',
      '2026-01-31T10:20:30+24:00',
      '2026-01-31T10:20:30+02:60',
      '2026-01-31T10:20:30+02:00:00',
      '2026-01-31T10:20:30UTC',
      '2026-01-31T10:20:30 GMT',
      '2026-01-31T10:20:30Z[UTC]',
      '2026-01-31T10:20:30ZZ',
      '2026-01-31Z',
      '2026-01-31+02:00',
    ]);
  });

  test('returns null for whitespace around the value and for digits outside ASCII', () => {
    assertNull(toDate, [
      ' 2026-01-31T10:20:30Z',
      '2026-01-31T10:20:30Z ',
      '2026-01-31T10:20:30Z\n',
      '2026-01-31\n',
      '\t2026-01-31',
      `${FULLWIDTH_2026}-01-31T10:20:30Z`,
    ]);
  });

  test('returns null for other types', () => {
    assertNull(toDate, NOT_MOMENTS);
    // eslint-disable-next-line no-new-wrappers -- the wrapper objects are the case under test
    assertNull(toDate, [new String(MOMENT), new Number(MOMENT_MS)]);
  });

  test('reads a long hostile string in linear time', () => {
    assertInstant(() => {
      assertNull(toDate, [
        `2026-01-31T10:20:30.${'9'.repeat(LONG)}Z`,
        `2026-01-31T10:20:30${'+00:00'.repeat(LONG)}`,
        '2026-01-31'.repeat(LONG),
        '1'.repeat(LONG),
        ' '.repeat(LONG),
      ]);
    });
  });
});

describe('toTimestamp', () => {
  test('returns Unix milliseconds of what toDate reads', () => {
    assert.equal(toTimestamp(new Date(MOMENT_MS)), MOMENT_MS);
    assert.equal(toTimestamp(MOMENT_MS), MOMENT_MS);
    assert.equal(toTimestamp(MOMENT), MOMENT_MS);
    assert.equal(toTimestamp('2026-01-31T12:20:30.456+02:00'), MOMENT_MS);
    assert.equal(toTimestamp('2026-01-31'), 1769817600000);
    assert.equal(toTimestamp(-1), -1);
  });

  test('returns 0, not null, for the epoch', () => {
    assert.equal(toTimestamp(0), 0);
    assert.equal(toTimestamp(new Date(0)), 0);
    assert.equal(toTimestamp('1970-01-01T00:00:00Z'), 0);
    assert.equal(toTimestamp('1970-01-01'), 0);
  });

  test('returns null for what toDate does not read', () => {
    assertNull(toTimestamp, NOT_MOMENTS);
  });
});

describe('toUtcIso', () => {
  test('writes a moment as "YYYY-MM-DDTHH:mm:ss.sssZ"', () => {
    assert.equal(toUtcIso(new Date(MOMENT_MS)), MOMENT);
    assert.equal(toUtcIso(MOMENT_MS), MOMENT);
    assert.equal(toUtcIso(MOMENT), MOMENT);
    assert.equal(toUtcIso(0), '1970-01-01T00:00:00.000Z');
  });

  test('moves an offset to UTC and fills in what the value left out', () => {
    assert.equal(toUtcIso('2026-01-31T12:20:30.456+02:00'), MOMENT);
    assert.equal(toUtcIso('2026-01-31T10:20:30+00:00'), '2026-01-31T10:20:30.000Z');
    assert.equal(toUtcIso('2026-01-31T10:20:30.4Z'), '2026-01-31T10:20:30.400Z');
    assert.equal(toUtcIso('2026-01-31'), '2026-01-31T00:00:00.000Z');
  });

  test('writes what toDate and parseStrictUtc read back as the same moment', () => {
    [0, -1, MOMENT_MS, YEAR_0000_START_MS, YEAR_9999_END_MS].forEach((timestamp) => {
      const iso = toUtcIso(timestamp);

      assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(toTimestamp(iso), timestamp);
      assert.equal(parseStrictUtc(iso).getTime(), timestamp);
    });
  });

  test('returns null for a year that does not fit four digits: the engine would write "+010000-01-01T..."', () => {
    assert.equal(toUtcIso(YEAR_9999_END_MS), '9999-12-31T23:59:59.999Z');
    assert.equal(toUtcIso(YEAR_9999_END_MS + 1), null);
    assert.equal(toUtcIso(YEAR_0000_START_MS), '0000-01-01T00:00:00.000Z');
    assert.equal(toUtcIso(YEAR_0000_START_MS - 1), null);
    assert.equal(toUtcIso(MAX_MS), null);
    assert.equal(toUtcIso('9999-12-31T23:59:59-01:00'), null);
  });

  test('returns null for what toDate does not read', () => {
    assertNull(toUtcIso, NOT_MOMENTS);
  });
});

describe('parseStrictUtc', () => {
  test('reads a date-time with "Z" or "+00:00" as the same moment', () => {
    assertReads(parseStrictUtc, [
      [MOMENT, MOMENT],
      ['2026-01-31T10:20:30.456+00:00', MOMENT],
      ['2026-01-31T10:20:30Z', '2026-01-31T10:20:30.000Z'],
      ['2026-01-31T10:20:30+00:00', '2026-01-31T10:20:30.000Z'],
      ['2024-02-29T23:59:59.999Z', '2024-02-29T23:59:59.999Z'],
      ['0000-01-01T00:00:00Z', '0000-01-01T00:00:00.000Z'],
      ['9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'],
    ]);
    assert.ok(parseStrictUtc(MOMENT) instanceof Date);
  });

  test('accepts no fraction or one of one to nine digits, cut down to milliseconds without rounding', () => {
    assertReads(parseStrictUtc, [
      ['2026-01-31T10:20:30.4Z', '2026-01-31T10:20:30.400Z'],
      ['2026-01-31T10:20:30.456789Z', MOMENT],
      ['2026-01-31T10:20:30.456789123+00:00', MOMENT],
      ['2026-12-31T23:59:59.999999999Z', '2026-12-31T23:59:59.999Z'],
    ]);
    assertThrows(parseStrictUtc, ['2026-01-31T10:20:30.Z', '2026-01-31T10:20:30.1234567890Z', '2026-01-31T10:20:30,5Z']);
  });

  test('throws on a non-string, a Date and a timestamp included', () => {
    assertThrows(parseStrictUtc, [new Date(MOMENT_MS), MOMENT_MS, 0, null, undefined, true, {}, [MOMENT]]);
    // eslint-disable-next-line no-new-wrappers -- the wrapper object is the case under test
    assertThrows(parseStrictUtc, [new String(MOMENT)]);
  });

  test('throws on a date-time without a zone', () => {
    assertThrows(parseStrictUtc, ['2026-01-31T10:20:30', '2026-01-31T10:20:30.456', '2026-01-31 10:20:30']);
  });

  test('throws on another offset, however close to UTC', () => {
    assertThrows(parseStrictUtc, [
      '2026-01-31T12:20:30+02:00',
      '2026-01-31T05:20:30-05:00',
      '2026-01-31T10:50:30+00:30',
      '2026-01-31T10:20:30+0000',
      '2026-01-31T10:20:30+00',
    ]);
  });

  test('throws on "-00:00": ISO 8601 has no negative zero offset, and the format knows two spellings of UTC only', () => {
    assertThrows(parseStrictUtc, ['2026-01-31T10:20:30-00:00', '2026-01-31T10:20:30.456-00:00']);
    assert.equal(toUtcIso('2026-01-31T10:20:30.456-00:00'), MOMENT);
  });

  test('throws on lower-case "t" and "z" and on a space in place of "T"', () => {
    assertThrows(parseStrictUtc, ['2026-01-31t10:20:30z', '2026-01-31T10:20:30z', '2026-01-31t10:20:30Z', '2026-01-31 10:20:30Z']);
  });

  test('throws on the date-only form and on a time without seconds', () => {
    assertThrows(parseStrictUtc, ['2026-01-31', '2026-01-31Z', '2026-01-31T10:20Z', '2026-01-31T10Z']);
  });

  test('throws on a calendar date that does not exist', () => {
    assertThrows(parseStrictUtc, [
      '2026-02-30T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '2026-04-31T00:00:00+00:00',
      '2026-13-01T00:00:00Z',
      '2026-01-00T00:00:00Z',
      '1900-02-29T00:00:00Z',
    ]);
  });

  test('throws on hour 24, minute 60, a leap second, whitespace around the value and a free form', () => {
    assertThrows(parseStrictUtc, [
      '2026-01-15T24:00:00Z',
      '2026-01-15T10:60:00Z',
      '2026-01-15T10:20:60+00:00',
      '2016-12-31T23:59:60Z',
      ' 2026-01-31T10:20:30Z',
      '2026-01-31T10:20:30Z ',
      '2026-01-31T10:20:30Z\n',
      'Sat, 31 Jan 2026 10:20:30 GMT',
      '',
    ]);
  });

  test('names itself in the error, whatever the value is, and keeps the value out of it', () => {
    ['2026-01-31T10:20:30+02:00', '2026-02-30T10:20:30Z', MOMENT_MS, null, Symbol(MOMENT), Object.create(null)].forEach((value) => {
      assert.throws(() => parseStrictUtc(value), {
        name: 'TypeError',
        message: 'parseStrictUtc(value) requires an ISO 8601 date-time string that ends with "Z" or "+00:00"',
      });
    });
  });

  test('reads a long hostile string in linear time', () => {
    assertInstant(() => {
      assertThrows(parseStrictUtc, [
        `2026-01-31T10:20:30.${'9'.repeat(LONG)}Z`,
        `2026-01-31T10:20:30${'+00:00'.repeat(LONG)}`,
        `${'1'.repeat(LONG)}Z`,
      ]);
    });
  });
});

describe('isUtcDateTime', () => {
  test('accepts a date-time that ends with "Z" or "+00:00", with a fraction of one to nine digits or none', () => {
    assertAnswers(isUtcDateTime, UTC_DATE_TIMES, true);
  });

  test('refuses another offset, however close to UTC, "-00:00" and a lower-case "z" included', () => {
    assertAnswers(isUtcDateTime, NOT_UTC_DATE_TIMES.otherOffsets, false);
  });

  test('refuses a date-time without a zone', () => {
    assertAnswers(isUtcDateTime, NOT_UTC_DATE_TIMES.zoneless, false);
  });

  test('refuses a date alone and a time without seconds, with a zone or without one', () => {
    assertAnswers(isUtcDateTime, NOT_UTC_DATE_TIMES.dateOnly, false);
  });

  test('refuses a calendar date or a time of day that does not exist', () => {
    assertAnswers(isUtcDateTime, NOT_UTC_DATE_TIMES.impossible, false);
  });

  test('refuses whitespace around the value, an empty or an overlong fraction and a free form', () => {
    assertAnswers(isUtcDateTime, NOT_UTC_DATE_TIMES.malformed, false);
  });

  test('refuses what is not a string, a Date and a timestamp included, and never throws', () => {
    assertAnswers(isUtcDateTime, [...NOT_STRING_MOMENTS, ...NOT_MOMENTS], false);
  });

  test('answers true exactly where parseStrictUtc returns a Date and false where it throws', () => {
    [...UTC_DATE_TIMES, ...Object.values(NOT_UTC_DATE_TIMES).flat(), ...NOT_STRING_MOMENTS, ...NOT_MOMENTS].forEach((value) => {
      assert.equal(isUtcDateTime(value), isReadByParseStrictUtc(value), inspect(value));
    });
  });

  test('answers a long hostile string in linear time', () => {
    assertInstant(() => {
      assertAnswers(isUtcDateTime, [
        `2026-01-31T10:20:30.${'9'.repeat(LONG)}Z`,
        `2026-01-31T10:20:30${'+00:00'.repeat(LONG)}`,
        `${'1'.repeat(LONG)}Z`,
        `${'2026-01-31T10:20:30'.repeat(LONG)}+00:00`,
      ], false);
    });
  });
});

describe('isIsoDate', () => {
  test('accepts a calendar date written as YYYY-MM-DD, a leap day of a leap year among them', () => {
    assertAnswers(isIsoDate, ['2026-01-31', '2026-12-31', '2024-02-29', '2000-02-29', '1970-01-01', '0000-01-01', '9999-12-31'], true);
  });

  test('refuses a day the calendar does not have instead of rolling it over', () => {
    assertAnswers(isIsoDate, ['2026-02-30', '2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-01-32', '0000-00-00'], false);
  });

  test('refuses a date-time, with a zone or without one, and a date with a zone', () => {
    assertAnswers(isIsoDate, [MOMENT, '2026-01-31T00:00:00Z', '2026-01-31T00:00:00.000+00:00', '2026-01-31T10:20:30', '2026-01-31Z', '2026-01-31+00:00'], false);
  });

  test('refuses another way to write a day and whitespace around it', () => {
    assertAnswers(isIsoDate, ['2026-1-31', '20260131', '31.01.2026', '02026-01-31', ' 2026-01-31', '2026-01-31 ', '2026-01-31\n', `${FULLWIDTH_2026}-01-31`, ''], false);
  });

  test('refuses what is not a string, a Date and a timestamp included, and never throws', () => {
    assertAnswers(isIsoDate, [...NOT_STRING_MOMENTS, ...NOT_MOMENTS], false);
  });

  test('answers a long hostile string in linear time', () => {
    assertInstant(() => {
      assertAnswers(isIsoDate, ['2026-01-31'.repeat(LONG), '1'.repeat(LONG), `2026-01-31${' '.repeat(LONG)}`], false);
    });
  });
});

describe('ISO_DATE_TIME_MAX_LENGTH', () => {
  test('is the length of the longest text isUtcDateTime accepts: nine digits of a fraction and the offset "+00:00"', () => {
    assert.equal(LONGEST_UTC_DATE_TIME.length, ISO_DATE_TIME_MAX_LENGTH);
    assert.equal(isUtcDateTime(LONGEST_UTC_DATE_TIME), true);
    UTC_DATE_TIMES.forEach((value) => assert.ok(value.length <= ISO_DATE_TIME_MAX_LENGTH, value));
  });

  test('leaves no room for a longer text: one more digit of the fraction or of the year, an expanded year or a trailing character is refused', () => {
    [
      '2026-11-20T10:00:00.1234567890+00:00',
      '12026-11-20T10:00:00.123456789+00:00',
      '+012026-11-20T10:00:00.123456789+00:00',
      `${LONGEST_UTC_DATE_TIME} `,
      `${LONGEST_UTC_DATE_TIME}Z`,
    ].forEach((value) => {
      assert.ok(value.length > ISO_DATE_TIME_MAX_LENGTH, value);
      assert.equal(isUtcDateTime(value), false, value);
    });
  });
});

describe('ISO_DATE_LENGTH', () => {
  test('is the length of a calendar date "YYYY-MM-DD": the date alone toDate reads and the date part of toUtcIso', () => {
    assert.equal('2026-01-31'.length, ISO_DATE_LENGTH);
    assert.equal(toUtcIso('2026-01-31'), '2026-01-31T00:00:00.000Z');
    assert.equal(toUtcIso(MOMENT).indexOf('T'), ISO_DATE_LENGTH);
    assert.equal(toUtcIso(YEAR_9999_END_MS).indexOf('T'), ISO_DATE_LENGTH);
  });

  test('is the only length of a date alone toDate reads: one digit less or more is not a date', () => {
    ['2026-1-31', '2026-01-1', '02026-01-31', '2026-001-31'].forEach((value) => {
      assert.equal(toDate(value), null, value);
    });
  });
});

describe('convertStringToSeconds', () => {
  test('converts a number with a unit s, m, h, d or w', () => {
    [['30s', 30], ['10m', 600], ['1h', 3600], ['30d', 2592000], ['1w', 604800], ['0s', 0], ['007s', 7]].forEach(([value, seconds]) => {
      assert.equal(convertStringToSeconds(value), seconds, value);
    });
  });

  test('counts every unit as a fixed number of seconds', () => {
    assert.equal(convertStringToSeconds('1m'), convertStringToSeconds('60s'));
    assert.equal(convertStringToSeconds('1h'), convertStringToSeconds('60m'));
    assert.equal(convertStringToSeconds('1d'), convertStringToSeconds('24h'));
    assert.equal(convertStringToSeconds('1w'), convertStringToSeconds('7d'));
    assert.equal(convertStringToSeconds('52w'), 31449600);
  });

  test('accepts a decimal number: "1.5h" is 5400', () => {
    [['1.5h', 5400], ['0.5m', 30], ['0.25d', 21600], ['1.5w', 907200], ['0.5s', 0.5], ['0.001s', 0.001]].forEach(([value, seconds]) => {
      assert.equal(convertStringToSeconds(value), seconds, value);
    });
  });

  test('accepts a leading minus', () => {
    [['-1d', -86400], ['-30s', -30], ['-1.5h', -5400], ['-0.5s', -0.5]].forEach(([value, seconds]) => {
      assert.equal(convertStringToSeconds(value), seconds, value);
    });
  });

  test('leaves no floating-point dust: 1.1 * 3600 is 3960.0000000000005', () => {
    [['1.1h', 3960], ['0.7d', 60480], ['0.57m', 34.2], ['0.1s', 0.1], ['0.3s', 0.3], ['1.001s', 1.001], ['-1.1h', -3960]].forEach(([value, seconds]) => {
      assert.equal(convertStringToSeconds(value), seconds, value);
    });
  });

  test('rounds to a millisecond', () => {
    [['0.0004s', 0], ['0.0006s', 0.001], ['1.0004s', 1], ['1.0006s', 1.001], ['-1.0006s', -1.001]].forEach(([value, seconds]) => {
      assert.equal(convertStringToSeconds(value), seconds, value);
    });
  });

  test('returns 0, never -0, for a negative duration that rounds to nothing', () => {
    ['-0s', '-0.0s', '-0.0001s', '-0.0004s'].forEach((value) => {
      assert.equal(convertStringToSeconds(value), 0, value);
    });
  });

  test('throws on another unit', () => {
    assertThrows(convertStringToSeconds, ['1mo', '1y', '100ms', '5min', '1sec', '2hr', '1q', '10mm']);
  });

  test('throws on upper case', () => {
    assertThrows(convertStringToSeconds, ['30S', '10M', '1H', '30D', '1W']);
  });

  test('throws on whitespace, inside or outside', () => {
    assertThrows(convertStringToSeconds, [' 10m', '10m ', '10 m', '1 0m', '10m\n', '\t10m', `10${NO_BREAK_SPACE}m`]);
  });

  test('throws on an empty string, a number without a unit and a unit without a number', () => {
    assertThrows(convertStringToSeconds, ['', '10', '1.5', '-1', 'm', '-m', '-']);
  });

  test('throws on another notation of the number', () => {
    assertThrows(convertStringToSeconds, ['+5m', '.5h', '5.h', '1e3s', '0x10s', '1,5h', '1_000s', '--1d', '1.2.3h', 'Infinitys', 'NaNs', `${ARABIC_TEN}m`]);
  });

  test('throws on several durations in one string', () => {
    assertThrows(convertStringToSeconds, ['1h30m', '1d1h', 'm10']);
  });

  test('throws on a number too large to stay finite', () => {
    assertThrows(convertStringToSeconds, [`${'9'.repeat(400)}s`, `${'9'.repeat(308)}w`]);
  });

  test('throws on a non-string, a number of seconds included', () => {
    assertThrows(convertStringToSeconds, [600, 0, 1.5, null, undefined, true, 10n, ['10m'], { value: '10m' }, Symbol('10m')]);
    // eslint-disable-next-line no-new-wrappers -- the wrapper object is the case under test
    assertThrows(convertStringToSeconds, [new String('10m')]);
  });

  test('names itself and the value in the error', () => {
    [['10 min', "'10 min'"], [600, '600'], [null, 'null'], [undefined, 'undefined'], ['', "''"]].forEach(([value, shown]) => {
      assert.throws(() => convertStringToSeconds(value), {
        name: 'TypeError',
        message: `convertStringToSeconds(value) requires a number with a unit s, m, h, d or w, such as "10m" or "1.5h": received ${shown}`,
      });
    });
  });

  test('reads a long hostile string in linear time', () => {
    assertInstant(() => {
      assertThrows(convertStringToSeconds, [
        `${'1'.repeat(LONG)}x`,
        `${'1.'.repeat(LONG)}s`,
        `${'-'.repeat(LONG)}1s`,
        `${' '.repeat(LONG)}1s`,
      ]);
    });
  });
});

describe('convertStringToMs', () => {
  test('converts a number with a unit into whole milliseconds', () => {
    [['30s', 30000], ['10m', 600000], ['1h', 3600000], ['1d', 86400000], ['1w', 604800000], ['0s', 0]].forEach(([value, milliseconds]) => {
      assert.equal(convertStringToMs(value), milliseconds, value);
    });
  });

  test('gives a whole number where the way through seconds leaves dust: 1.001 * 1000 is 1000.9999999999999', () => {
    [['1.001s', 1001], ['0.05s', 50], ['1.1h', 3960000], ['-0.5s', -500], ['0.0006s', 1]].forEach(([value, milliseconds]) => {
      assert.equal(convertStringToMs(value), milliseconds, value);
    });
    assert.notEqual(convertStringToSeconds('1.001s') * 1000, 1001);
  });

  test('returns 0, never -0, for a negative duration that rounds to nothing', () => {
    ['-0s', '-0.0001s', '-0.0004s'].forEach((value) => {
      assert.equal(Object.is(convertStringToMs(value), 0), true, value);
    });
  });

  test('throws on what convertStringToSeconds() refuses', () => {
    assertThrows(convertStringToMs, ['', '10', '100ms', '1h30m', ' 10m', '10M', 600, null, undefined]);
  });

  test('names itself and the value in the error', () => {
    [['10 min', "'10 min'"], [600, '600'], [undefined, 'undefined']].forEach(([value, shown]) => {
      assert.throws(() => convertStringToMs(value), {
        name: 'TypeError',
        message: `convertStringToMs(value) requires a number with a unit s, m, h, d or w, such as "10m" or "1.5h": received ${shown}`,
      });
    });
  });
});

describe('addToDate', () => {
  test('moves a moment by every unit', () => {
    assert.equal(addToDate(MOMENT, '30s').toISOString(), '2026-01-31T10:21:00.456Z');
    assert.equal(addToDate(MOMENT, '10m').toISOString(), '2026-01-31T10:30:30.456Z');
    assert.equal(addToDate(MOMENT, '1.5h').toISOString(), '2026-01-31T11:50:30.456Z');
    assert.equal(addToDate(MOMENT, '1d').toISOString(), '2026-02-01T10:20:30.456Z');
    assert.equal(addToDate(MOMENT, '1w').toISOString(), '2026-02-07T10:20:30.456Z');
    assert.equal(addToDate(MOMENT, '0.001s').toISOString(), '2026-01-31T10:20:30.457Z');
  });

  test('moves a moment back by a negative duration', () => {
    assert.equal(addToDate(MOMENT, '-1d').toISOString(), '2026-01-30T10:20:30.456Z');
    assert.equal(addToDate('2026-03-01T00:00:00Z', '-1s').toISOString(), '2026-02-28T23:59:59.000Z');
    assert.equal(addToDate('2026-01-01T00:00:00Z', '-0.001s').toISOString(), '2025-12-31T23:59:59.999Z');
    assert.equal(addToDate(0, '-1w').toISOString(), '1969-12-25T00:00:00.000Z');
  });

  test('crosses the end of a month, of a year and a leap day', () => {
    assert.equal(addToDate('2026-01-31T23:59:59.999Z', '0.001s').toISOString(), '2026-02-01T00:00:00.000Z');
    assert.equal(addToDate('2026-12-31T23:59:59Z', '1s').toISOString(), '2027-01-01T00:00:00.000Z');
    assert.equal(addToDate('2024-02-28T12:00:00Z', '1d').toISOString(), '2024-02-29T12:00:00.000Z');
    assert.equal(addToDate('2025-02-28T12:00:00Z', '1d').toISOString(), '2025-03-01T12:00:00.000Z');
    assert.equal(addToDate('2024-02-29', '52w').toISOString(), '2025-02-27T00:00:00.000Z');
  });

  test('adds exactly 24 hours for a day, whatever the calendar says', () => {
    assert.equal(addToDate('2026-03-08T00:00:00Z', '1d').getTime() - toTimestamp('2026-03-08T00:00:00Z'), 24 * HOUR_MS);
    assert.equal(addToDate('2026-11-01T00:00:00Z', '1d').getTime() - toTimestamp('2026-11-01T00:00:00Z'), 24 * HOUR_MS);
  });

  test('accepts a Date, a timestamp and an ISO string', () => {
    assert.equal(addToDate(new Date(MOMENT_MS), '1h').getTime(), MOMENT_MS + HOUR_MS);
    assert.equal(addToDate(MOMENT_MS, '1h').getTime(), MOMENT_MS + HOUR_MS);
    assert.equal(addToDate('2026-01-31T12:20:30.456+02:00', '1h').getTime(), MOMENT_MS + HOUR_MS);
  });

  test('returns a new Date and leaves its argument alone, even for a zero duration', () => {
    const date = new Date(MOMENT_MS);
    const moved = addToDate(date, '1d');
    const same = addToDate(date, '0s');

    assert.equal(date.getTime(), MOMENT_MS);
    assert.notEqual(moved, date);
    assert.notEqual(same, date);
    assert.equal(same.getTime(), MOMENT_MS);
  });

  test('returns null for an invalid date', () => {
    assertNull((value) => addToDate(value, '1d'), NOT_MOMENTS);
  });

  test('returns null when the result leaves the range a Date can hold', () => {
    assert.equal(addToDate(MAX_MS, '-1s').getTime(), MAX_MS - 1000);
    assert.equal(addToDate(MAX_MS, '0.001s'), null);
    assert.equal(addToDate(-MAX_MS, '-0.001s'), null);
    assert.equal(addToDate(0, '100000001d'), null);
  });

  test('throws on an invalid duration like convertStringToSeconds', () => {
    assertThrows((duration) => addToDate(MOMENT, duration), [...NOT_DURATIONS, undefined]);
    assert.throws(() => addToDate(MOMENT, '1 d'), { name: 'TypeError', message: /^convertStringToSeconds\(value\) requires .+ received '1 d'$/ });
  });

  test('throws on an invalid duration even when the date is invalid', () => {
    assertThrows((duration) => addToDate(null, duration), [...NOT_DURATIONS, undefined]);
  });
});

describe('differenceInDays', () => {
  test('counts by the UTC day each moment falls in, not by 24-hour spans', () => {
    assert.equal(differenceInDays('2026-01-02T00:01:00Z', '2026-01-01T23:59:00Z'), 1);
    assert.equal(differenceInDays('2026-01-02T00:00:00.000Z', '2026-01-01T23:59:59.999Z'), 1);
    assert.equal(differenceInDays('2026-01-02T23:59:59.999Z', '2026-01-01T00:00:00.000Z'), 1);
    assert.equal(differenceInDays('2026-01-03T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), 2);
  });

  test('returns 0 for two moments of the same UTC day', () => {
    assert.equal(differenceInDays('2026-01-01T23:59:59.999Z', '2026-01-01T00:00:00.000Z'), 0);
    assert.equal(differenceInDays('2026-01-01T00:00:00.000Z', '2026-01-01T23:59:59.999Z'), 0);
    assert.equal(differenceInDays(MOMENT, MOMENT), 0);
  });

  test('is negative when the left moment is earlier', () => {
    assert.equal(differenceInDays('2026-01-01T23:59:00Z', '2026-01-02T00:01:00Z'), -1);
    assert.equal(differenceInDays('2026-01-01', '2026-01-31'), -30);
  });

  test('takes the UTC day of a moment given with an offset', () => {
    assert.equal(differenceInDays('2026-01-02T01:00:00+02:00', '2026-01-01T12:00:00Z'), 0);
    assert.equal(differenceInDays('2026-01-01T23:00:00-02:00', '2026-01-01T12:00:00Z'), 1);
  });

  test('counts a leap day and the length of a year', () => {
    assert.equal(differenceInDays('2024-03-01', '2024-02-28'), 2);
    assert.equal(differenceInDays('2025-03-01', '2025-02-28'), 1);
    assert.equal(differenceInDays('2025-01-01', '2024-01-01'), 366);
    assert.equal(differenceInDays('2027-01-01', '2026-01-01'), 365);
    assert.equal(differenceInDays('2026-01-01T00:00:00Z', '2025-12-31T23:59:59.999Z'), 1);
  });

  test('counts across the epoch and across the whole range of a Date', () => {
    assert.equal(differenceInDays(0, -1), 1);
    assert.equal(differenceInDays(-1, 0), -1);
    assert.equal(differenceInDays(-1, -2), 0);
    assert.equal(differenceInDays('1969-12-31T00:00:00Z', '1970-01-01T23:59:59Z'), -1);
    assert.equal(differenceInDays(MAX_MS, -MAX_MS), 200000000);
  });

  test('accepts a Date, a timestamp and an ISO string on either side', () => {
    assert.equal(differenceInDays(new Date(MOMENT_MS), '2026-01-01'), 30);
    assert.equal(differenceInDays(MOMENT_MS, new Date(0)), 20484);
  });

  test('returns null when either moment is invalid', () => {
    assertNull((value) => differenceInDays(value, MOMENT), NOT_MOMENTS);
    assertNull((value) => differenceInDays(MOMENT, value), NOT_MOMENTS);
    assert.equal(differenceInDays(null, null), null);
  });
});

describe('getStartOfDay', () => {
  test('returns 00:00:00.000 of the UTC day of the moment', () => {
    assert.equal(getStartOfDay(MOMENT).toISOString(), '2026-01-31T00:00:00.000Z');
    assert.equal(getStartOfDay(new Date(MOMENT_MS)).toISOString(), '2026-01-31T00:00:00.000Z');
    assert.equal(getStartOfDay(MOMENT_MS).toISOString(), '2026-01-31T00:00:00.000Z');
  });

  test('keeps the first and the last millisecond of a day in that day', () => {
    assert.equal(getStartOfDay('2026-01-31T00:00:00.000Z').toISOString(), '2026-01-31T00:00:00.000Z');
    assert.equal(getStartOfDay('2026-01-31T23:59:59.999Z').toISOString(), '2026-01-31T00:00:00.000Z');
    assert.equal(getStartOfDay('2026-12-31T23:59:59.999Z').toISOString(), '2026-12-31T00:00:00.000Z');
    assert.equal(getStartOfDay('2024-02-29T23:59:59.999Z').toISOString(), '2024-02-29T00:00:00.000Z');
  });

  test('takes the UTC day of a moment given with an offset', () => {
    assert.equal(getStartOfDay('2026-01-31T00:30:00+02:00').toISOString(), '2026-01-30T00:00:00.000Z');
    assert.equal(getStartOfDay('2026-01-31T23:30:00-02:00').toISOString(), '2026-02-01T00:00:00.000Z');
  });

  test('works before the epoch and at both ends of the range of a Date', () => {
    assert.equal(getStartOfDay(-1).toISOString(), '1969-12-31T00:00:00.000Z');
    assert.equal(getStartOfDay(0).getTime(), 0);
    assert.equal(getStartOfDay(MAX_MS).getTime(), MAX_MS);
    assert.equal(getStartOfDay(-MAX_MS).getTime(), -MAX_MS);
  });

  test('returns a new Date and leaves its argument alone, even at the start of a day', () => {
    const midnight = new Date(0);
    const date = new Date(MOMENT_MS);

    assert.notEqual(getStartOfDay(midnight), midnight);
    assert.notEqual(getStartOfDay(date), date);
    assert.equal(midnight.getTime(), 0);
    assert.equal(date.getTime(), MOMENT_MS);
  });

  test('returns null for an invalid moment', () => {
    assertNull(getStartOfDay, NOT_MOMENTS);
  });
});

describe('getEndOfDay', () => {
  test('returns 23:59:59.999 of the UTC day of the moment', () => {
    assert.equal(getEndOfDay(MOMENT).toISOString(), '2026-01-31T23:59:59.999Z');
    assert.equal(getEndOfDay(new Date(MOMENT_MS)).toISOString(), '2026-01-31T23:59:59.999Z');
    assert.equal(getEndOfDay(MOMENT_MS).toISOString(), '2026-01-31T23:59:59.999Z');
  });

  test('keeps the first and the last millisecond of a day in that day', () => {
    assert.equal(getEndOfDay('2026-01-31T00:00:00.000Z').toISOString(), '2026-01-31T23:59:59.999Z');
    assert.equal(getEndOfDay('2026-01-31T23:59:59.999Z').toISOString(), '2026-01-31T23:59:59.999Z');
    assert.equal(getEndOfDay('2026-12-31T00:00:00.000Z').toISOString(), '2026-12-31T23:59:59.999Z');
    assert.equal(getEndOfDay('2024-02-29T00:00:00.000Z').toISOString(), '2024-02-29T23:59:59.999Z');
  });

  test('is one millisecond before the start of the next day', () => {
    assert.equal(getEndOfDay(MOMENT).getTime() + 1, getStartOfDay(addToDate(MOMENT, '1d')).getTime());
    assert.equal(getEndOfDay(-1).getTime(), -1);
  });

  test('takes the UTC day of a moment given with an offset', () => {
    assert.equal(getEndOfDay('2026-01-31T00:30:00+02:00').toISOString(), '2026-01-30T23:59:59.999Z');
    assert.equal(getEndOfDay('2026-01-31T23:30:00-02:00').toISOString(), '2026-02-01T23:59:59.999Z');
  });

  test('returns null when the end of the day is past the range a Date can hold', () => {
    assert.equal(getEndOfDay(MAX_MS - 1).getTime(), MAX_MS - 1);
    assert.equal(getEndOfDay(MAX_MS), null);
    assert.equal(getEndOfDay(-MAX_MS).toISOString(), '-271821-04-20T23:59:59.999Z');
  });

  test('returns a new Date and leaves its argument alone, even at the end of a day', () => {
    const lastMoment = new Date(-1);
    const date = new Date(MOMENT_MS);

    assert.notEqual(getEndOfDay(lastMoment), lastMoment);
    assert.notEqual(getEndOfDay(date), date);
    assert.equal(lastMoment.getTime(), -1);
    assert.equal(date.getTime(), MOMENT_MS);
  });

  test('returns null for an invalid moment', () => {
    assertNull(getEndOfDay, NOT_MOMENTS);
  });
});

describe('isPast', () => {
  test('is true strictly before now: the same moment is not past', () => {
    assert.equal(isPast('2026-01-31T09:59:59.999Z', NOW), true);
    assert.equal(isPast(NOW, NOW), false);
    assert.equal(isPast('2026-01-31T10:00:00.001Z', NOW), false);
  });

  test('accepts a Date, a timestamp and an ISO string on either side', () => {
    assert.equal(isPast(new Date(MOMENT_MS - 1), new Date(MOMENT_MS)), true);
    assert.equal(isPast(MOMENT_MS - 1, MOMENT), true);
    assert.equal(isPast('2026-01-31T12:20:30.455+02:00', MOMENT_MS), true);
    assert.equal(isPast(-1, 0), true);
  });

  test('compares with the current moment by default', () => {
    assert.equal(isPast(Date.now() - MINUTE_MS), true);
    assert.equal(isPast(Date.now() + MINUTE_MS), false);
    assert.equal(isPast(0), true);
  });

  test('returns false for an invalid value, however now compares with zero', () => {
    NOT_MOMENTS.forEach((value) => {
      assert.equal(isPast(value, NOW), false, inspect(value));
      assert.equal(isPast(value, -1), false, inspect(value));
      assert.equal(isPast(value), false, inspect(value));
    });
  });

  test('returns false for an invalid now', () => {
    assert.equal(isPast(-1, null), false);
    assert.equal(isPast(MOMENT, 'not a date'), false);
    assert.equal(isPast(MOMENT, new Date(Number.NaN)), false);
  });
});

describe('isFuture', () => {
  test('is true strictly after now: the same moment is not future', () => {
    assert.equal(isFuture('2026-01-31T10:00:00.001Z', NOW), true);
    assert.equal(isFuture(NOW, NOW), false);
    assert.equal(isFuture('2026-01-31T09:59:59.999Z', NOW), false);
  });

  test('accepts a Date, a timestamp and an ISO string on either side', () => {
    assert.equal(isFuture(new Date(MOMENT_MS + 1), new Date(MOMENT_MS)), true);
    assert.equal(isFuture(MOMENT_MS + 1, MOMENT), true);
    assert.equal(isFuture('2026-01-31T12:20:30.457+02:00', MOMENT_MS), true);
    assert.equal(isFuture(0, -1), true);
  });

  test('compares with the current moment by default', () => {
    assert.equal(isFuture(Date.now() + MINUTE_MS), true);
    assert.equal(isFuture(Date.now() - MINUTE_MS), false);
    assert.equal(isFuture(MAX_MS), true);
  });

  test('returns false for an invalid value, however now compares with zero', () => {
    NOT_MOMENTS.forEach((value) => {
      assert.equal(isFuture(value, NOW), false, inspect(value));
      assert.equal(isFuture(value, -1), false, inspect(value));
      assert.equal(isFuture(value), false, inspect(value));
    });
  });

  test('returns false for an invalid now', () => {
    assert.equal(isFuture(1, null), false);
    assert.equal(isFuture(MOMENT, 'not a date'), false);
    assert.equal(isFuture(MOMENT, new Date(Number.NaN)), false);
  });
});

describe('isExpired', () => {
  test('without a ttl takes the value for the moment of expiry: expired at that exact moment, fresh a millisecond before', () => {
    assert.equal(isExpired('2026-01-31T10:00:00.001Z', undefined, NOW), false);
    assert.equal(isExpired(NOW, undefined, NOW), true);
    assert.equal(isExpired('2026-01-31T09:59:59.999Z', undefined, NOW), true);
  });

  test('with a ttl expires at the value plus the ttl: at that exact moment, not a millisecond before', () => {
    assert.equal(isExpired('2026-01-31T09:50:00.001Z', '10m', NOW), false);
    assert.equal(isExpired('2026-01-31T09:50:00.000Z', '10m', NOW), true);
    assert.equal(isExpired('2026-01-30T10:00:00.001Z', '1d', NOW), false);
    assert.equal(isExpired('2026-01-30T10:00:00.000Z', '1d', NOW), true);
    assert.equal(isExpired('2026-01-31T09:59:59.500Z', '0.5s', NOW), true);
    assert.equal(isExpired('2026-01-31T09:59:59.501Z', '0.5s', NOW), false);
  });

  test('accepts a zero and a negative ttl', () => {
    assert.equal(isExpired(NOW, '0s', NOW), true);
    assert.equal(isExpired('2026-01-31T10:00:00.001Z', '0s', NOW), false);
    assert.equal(isExpired('2026-01-31T10:10:00.000Z', '-10m', NOW), true);
    assert.equal(isExpired('2026-01-31T10:10:00.001Z', '-10m', NOW), false);
  });

  test('accepts a Date, a timestamp and an ISO string for the value and for now', () => {
    assert.equal(isExpired(new Date(MOMENT_MS), '1h', new Date(MOMENT_MS + HOUR_MS)), true);
    assert.equal(isExpired(MOMENT_MS, '1h', MOMENT_MS + HOUR_MS - 1), false);
    assert.equal(isExpired('2026-01-31T12:20:30.456+02:00', '1h', '2026-01-31T11:20:30.456Z'), true);
  });

  test('compares with the current moment by default', () => {
    assert.equal(isExpired(Date.now() + MINUTE_MS), false);
    assert.equal(isExpired(Date.now() - MINUTE_MS), true);
    assert.equal(isExpired(Date.now() - MINUTE_MS, '1h'), false);
    assert.equal(isExpired(Date.now() - 2 * HOUR_MS, '1h'), true);
  });

  test('takes an invalid or missing value for expired: what cannot prove it is fresh is expired', () => {
    NOT_MOMENTS.forEach((value) => {
      assert.equal(isExpired(value), true, inspect(value));
      assert.equal(isExpired(value, '1d'), true, inspect(value));
      assert.equal(isExpired(value, undefined, 0), true, inspect(value));
      assert.equal(isExpired(value, '1w', -MAX_MS), true, inspect(value));
    });
    assert.equal(isExpired(), true);
  });

  test('takes an invalid now for expired', () => {
    assert.equal(isExpired(MAX_MS, undefined, null), true);
    assert.equal(isExpired(MAX_MS, '1d', 'not a date'), true);
    assert.equal(isExpired(MAX_MS, '1d', new Date(Number.NaN)), true);
  });

  test('keeps a value fresh when its ttl reaches past the range a Date can hold', () => {
    assert.equal(isExpired(MAX_MS, '1d', MAX_MS), false);
    assert.equal(isExpired(0, '100000001d', MAX_MS), false);
    assert.equal(isExpired(0, '100000000d', MAX_MS), true);
  });

  test('throws on an invalid ttl like convertStringToSeconds, null included: only undefined means no ttl', () => {
    assertThrows((ttl) => isExpired(MOMENT, ttl, NOW), NOT_DURATIONS);
    assert.throws(() => isExpired(MOMENT, '10 m', NOW), { name: 'TypeError', message: /^convertStringToSeconds\(value\) requires .+ received '10 m'$/ });
  });

  test('throws on an invalid ttl even when the value is invalid', () => {
    assertThrows((ttl) => isExpired(null, ttl, NOW), NOT_DURATIONS);
    assertThrows((ttl) => isExpired(undefined, ttl), NOT_DURATIONS);
  });
});

describe('date.js', () => {
  test('never mutates a Date it was given and never returns it', () => {
    const value = new Date(MOMENT_MS);
    const other = new Date(MOMENT_MS + MINUTE_MS);
    const results = [
      toDate(value),
      toTimestamp(value),
      toUtcIso(value),
      addToDate(value, '1d'),
      addToDate(value, '-1.5h'),
      addToDate(value, '0s'),
      getStartOfDay(value),
      getEndOfDay(value),
      differenceInDays(value, other),
      differenceInDays(other, value),
      isPast(value, other),
      isFuture(value, other),
      isExpired(value, undefined, other),
      isExpired(value, '1d', other),
    ];

    assert.equal(value.getTime(), MOMENT_MS);
    assert.equal(other.getTime(), MOMENT_MS + MINUTE_MS);
    assert.equal(results.includes(value), false);
    assert.equal(results.includes(other), false);
  });

  test('gives the same results in a process of any time zone', async () => {
    const zones = Object.keys(LOCAL_MIDNIGHTS);
    const outputs = await Promise.all(zones.map((TZ) => runNode(PRINT_DATES, { env: { TZ } })));

    outputs.forEach(({ code, stdout, stderr }, index) => {
      assert.equal(code, 0, stderr);

      const { localMidnight, results } = JSON.parse(stdout);

      assert.equal(localMidnight, LOCAL_MIDNIGHTS[zones[index]]);
      assert.deepEqual(results, ZONE_FREE_RESULTS);
    });
  });
});
