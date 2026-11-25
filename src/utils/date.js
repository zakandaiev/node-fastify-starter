import {
  isNumber,
  isNumberInRange,
  isString,
  toNumber,
} from '#utils/type.js';
import { inspect } from 'node:util';
import { isDate } from 'node:util/types';

const MS_IN_SECOND = 1000;
const MS_IN_MINUTE = 60 * MS_IN_SECOND;
const MS_IN_HOUR = 60 * MS_IN_MINUTE;
const MS_IN_DAY = 24 * MS_IN_HOUR;
const MS_IN_WEEK = 7 * MS_IN_DAY;
const LAST_MS_OF_DAY = MS_IN_DAY - 1;

const MS_IN_UNIT = Object.freeze({
  s: MS_IN_SECOND,
  m: MS_IN_MINUTE,
  h: MS_IN_HOUR,
  d: MS_IN_DAY,
  w: MS_IN_WEEK,
});

const MS_DIGITS = 3;
const ISO_YEAR_MIN = 0;
const ISO_YEAR_MAX = 9999;
const UTC_MIDNIGHT = 'T00:00:00Z';
const UTC_ZONES = Object.freeze(['Z', '+00:00']);

// The longest text DATE_TIME_REGEXP reads: "2026-11-20T10:00:00.123456789+00:00".
export const ISO_DATE_TIME_MAX_LENGTH = 35;
export const ISO_DATE_LENGTH = 10;

const DATE_ONLY_REGEXP = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_REGEXP = /^(?<wallClock>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,9}))?(?:Z|(?<sign>[+-])(?<offsetHours>[01]\d|2[0-3]):(?<offsetMinutes>[0-5]\d))$/;

export function nowUtc() {
  return new Date();
}

// Only a number reaches the constructor: new Date(null) is the epoch, new Date(string) reads the local time zone.
function fromTimestamp(timestamp) {
  if (!isNumber(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

// The engine reads "02-30" as March 2 and "24:00:00" as the next midnight:
// a moment is real only when it is written back exactly as it was read.
function parseWallClock(wallClock, fraction = '') {
  const iso = `${wallClock}.${fraction.slice(0, MS_DIGITS).padEnd(MS_DIGITS, '0')}Z`;
  const date = fromTimestamp(Date.parse(iso));

  return date?.toISOString() === iso
    ? date.getTime()
    : null;
}

function toOffsetMs({ sign, offsetHours, offsetMinutes }) {
  if (sign === undefined) {
    return 0;
  }

  const offset = Number(offsetHours) * MS_IN_HOUR + Number(offsetMinutes) * MS_IN_MINUTE;

  return sign === '-'
    ? -offset
    : offset;
}

function parseIso(value) {
  const dateTime = DATE_ONLY_REGEXP.test(value)
    ? `${value}${UTC_MIDNIGHT}`
    : value;
  const parts = DATE_TIME_REGEXP.exec(dateTime)?.groups;

  if (!parts) {
    return null;
  }

  const timestamp = parseWallClock(parts.wallClock, parts.fraction);

  return timestamp === null
    ? null
    : timestamp - toOffsetMs(parts);
}

export function toDate(value) {
  if (isDate(value)) {
    return fromTimestamp(value.getTime());
  }

  if (isString(value)) {
    return fromTimestamp(parseIso(value));
  }

  return fromTimestamp(value);
}

export function toTimestamp(value) {
  return toDate(value)?.getTime() ?? null;
}

// Rounded down, as a JWT counts its times.
export function toUnixSeconds(value) {
  const timestamp = toTimestamp(value);

  return timestamp === null
    ? null
    : Math.floor(timestamp / MS_IN_SECOND);
}

export function fromUnixSeconds(seconds) {
  return isNumber(seconds)
    ? fromTimestamp(seconds * MS_IN_SECOND)
    : null;
}

// Outside these years toISOString() switches to the expanded form "+010000-01-01T...", which toDate() does not read.
export function toUtcIso(value) {
  const date = toDate(value);

  return date && isNumberInRange(date.getUTCFullYear(), ISO_YEAR_MIN, ISO_YEAR_MAX)
    ? date.toISOString()
    : null;
}

function readStrictUtc(value) {
  return isString(value) && UTC_ZONES.some((zone) => value.endsWith(zone))
    ? toDate(value)
    : null;
}

export function isUtcDateTime(value) {
  return readStrictUtc(value) !== null;
}

export function isIsoDate(value) {
  return isString(value) && DATE_ONLY_REGEXP.test(value) && toDate(value) !== null;
}

export function parseStrictUtc(value) {
  const date = readStrictUtc(value);

  if (!date) {
    throw new TypeError('parseStrictUtc(value) requires an ISO 8601 date-time string that ends with "Z" or "+00:00"');
  }

  return date;
}

const WHOLE_SECONDS_MIN = 1;

const SECONDS_SIGNATURE = 'convertStringToSeconds(value)';
const WHOLE_SECONDS_SIGNATURE = 'convertStringToWholeSeconds(value)';
const MS_SIGNATURE = 'convertStringToMs(value)';

function readDurationMs(value) {
  if (!isString(value)) {
    return null;
  }

  const amount = toNumber(value.slice(0, -1));
  const unitMs = MS_IN_UNIT[value.slice(-1)];

  return amount === null || unitMs === undefined
    ? null
    : Math.round(amount * unitMs);
}

function toDurationMs(value, signature) {
  const milliseconds = readDurationMs(value);

  if (!isNumber(milliseconds)) {
    throw new TypeError(`${signature} requires a number with a unit s, m, h, d or w, such as "10m" or "1.5h": received ${inspect(value)}`);
  }

  // Math.round() gives -0 for "-0s" and for a negative fraction of a millisecond.
  return milliseconds || 0;
}

export function convertStringToMs(value) {
  return toDurationMs(value, MS_SIGNATURE);
}

export function convertStringToSeconds(value) {
  return toDurationMs(value, SECONDS_SIGNATURE) / MS_IN_SECOND;
}

// For a server that counts a wait in whole seconds and takes 0 for no wait at all.
export function convertStringToWholeSeconds(value) {
  return Math.max(WHOLE_SECONDS_MIN, Math.ceil(toDurationMs(value, WHOLE_SECONDS_SIGNATURE) / MS_IN_SECOND));
}

// For a section of the config, when its owner is made: a duration nobody can read would otherwise fail on the day it
// is read.
export function assertDurations(section, keys, name) {
  if (!keys.every((key) => convertStringToMs(section[key]) > 0)) {
    throw new TypeError(`${name} requires ${keys.join(', ')} to be above zero`);
  }

  return true;
}

function moveDate(value, move) {
  const timestamp = toTimestamp(value);

  return timestamp === null
    ? null
    : fromTimestamp(move(timestamp));
}

export function addToDate(value, duration) {
  const milliseconds = toDurationMs(duration, SECONDS_SIGNATURE);

  return moveDate(value, (timestamp) => timestamp + milliseconds);
}

function toDayStart(timestamp) {
  return Math.floor(timestamp / MS_IN_DAY) * MS_IN_DAY;
}

export function getStartOfDay(value) {
  return moveDate(value, toDayStart);
}

export function getEndOfDay(value) {
  return moveDate(value, (timestamp) => toDayStart(timestamp) + LAST_MS_OF_DAY);
}

function differenceInMs(left, right) {
  const leftTimestamp = toTimestamp(left);
  const rightTimestamp = toTimestamp(right);

  return leftTimestamp === null || rightTimestamp === null
    ? null
    : leftTimestamp - rightTimestamp;
}

// Rounded down, so the seconds left until a moment are never more than there are.
export function differenceInSeconds(left, right) {
  const difference = differenceInMs(left, right);

  return difference === null
    ? null
    : Math.floor(difference / MS_IN_SECOND);
}

export function differenceInDays(left, right) {
  const difference = differenceInMs(getStartOfDay(left), getStartOfDay(right));

  return difference === null
    ? null
    : difference / MS_IN_DAY;
}

export function isPast(value, now = nowUtc()) {
  const difference = differenceInMs(value, now);

  return difference !== null && difference < 0;
}

export function isFuture(value, now = nowUtc()) {
  const difference = differenceInMs(value, now);

  return difference !== null && difference > 0;
}

export function isExpired(value, ttl, now = nowUtc()) {
  const ttlMs = ttl === undefined
    ? 0
    : toDurationMs(ttl, SECONDS_SIGNATURE);
  const msLeft = differenceInMs(value, now);

  return msLeft === null || msLeft + ttlMs <= 0;
}
