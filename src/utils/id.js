import { randomInt } from '#utils/random.js';
import { isString } from '#utils/type.js';

const HEX_RADIX = 16;

const VERSION = 7;
const TIMESTAMP_MAX = 2 ** 48 - 1;
const COUNTER_MAX = 2 ** 12 - 1;
// The top bit of a fresh counter stays zero: a millisecond always has room for 2048 more ids before the timestamp has to run ahead of the clock.
const COUNTER_SEED_MAX = 2 ** 11 - 1;

const VERSION_BITS = VERSION * (COUNTER_MAX + 1);
const VARIANT_WORD_MIN = 0x80000000;
const VARIANT_WORD_MAX = 0xbfffffff;
const RANDOM_WORD_MAX = 0xffffffff;

const UUID_BYTES = 16;
const TIMESTAMP_BYTES = 6;
const COUNTER_OFFSET = 6;
const VARIANT_OFFSET = 8;
const RANDOM_OFFSET = 12;

const HEX_TIME_HIGH_END = 8;
const HEX_TIME_END = 12;
const HEX_COUNTER_END = 16;
const HEX_VARIANT_END = 20;

const TEXT_TIMESTAMP_END = 13;
const TEXT_VERSION_INDEX = 14;

export const UUID_REGEXP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const UUID_LENGTH = 36;

// One buffer for all calls: every call overwrites it whole, so it must never leave the module.
const bytes = Buffer.alloc(UUID_BYTES);

let lastTimestamp = 0;
let counter = 0;

function startMillisecond(timestamp) {
  if (timestamp > TIMESTAMP_MAX) {
    throw new RangeError('uuidv7() requires a clock that fits the 48 bits of the timestamp');
  }

  lastTimestamp = timestamp;
  counter = randomInt(0, COUNTER_SEED_MAX);
}

function advance() {
  const now = Math.floor(Date.now());

  if (now > lastTimestamp) {
    startMillisecond(now);
  } else if (counter < COUNTER_MAX) {
    counter += 1;
  } else {
    startMillisecond(lastTimestamp + 1);
  }
}

function hyphenate(hex) {
  return `${hex.slice(0, HEX_TIME_HIGH_END)}-${hex.slice(HEX_TIME_HIGH_END, HEX_TIME_END)}-${hex.slice(HEX_TIME_END, HEX_COUNTER_END)}-${hex.slice(HEX_COUNTER_END, HEX_VARIANT_END)}-${hex.slice(HEX_VARIANT_END)}`;
}

export function uuidv7() {
  advance();

  bytes.writeUIntBE(lastTimestamp, 0, TIMESTAMP_BYTES);
  bytes.writeUInt16BE(VERSION_BITS + counter, COUNTER_OFFSET);
  bytes.writeUInt32BE(randomInt(VARIANT_WORD_MIN, VARIANT_WORD_MAX), VARIANT_OFFSET);
  bytes.writeUInt32BE(randomInt(0, RANDOM_WORD_MAX), RANDOM_OFFSET);

  return hyphenate(bytes.toHex());
}

export function isUuid(value) {
  return isString(value) && UUID_REGEXP.test(value);
}

export function uuidVersion(value) {
  return isUuid(value)
    ? Number.parseInt(value[TEXT_VERSION_INDEX], HEX_RADIX)
    : null;
}

export function uuidTimestamp(value) {
  return uuidVersion(value) === VERSION
    ? Number.parseInt(value.slice(0, TEXT_TIMESTAMP_END).replace('-', ''), HEX_RADIX)
    : null;
}
