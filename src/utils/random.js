import { isArray, isString } from '#utils/type.js';
import { randomBytes, randomInt as cryptoRandomInt } from 'node:crypto';

const BYTE_VALUES = 256;
const RANDOM_INT_MAX_RANGE = 2 ** 48 - 2;
const STRING_LENGTH = 16;
const TOKEN_BYTES = 32;
const TOKEN_MIN_BYTES = 16;

export const ALPHABET = Object.freeze({
  ALPHANUMERIC: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  DIGITS: '0123456789',
});

export function randomInt(min, max) {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max || max - min > RANDOM_INT_MAX_RANGE) {
    throw new RangeError('randomInt(min, max) requires safe integers, min <= max and a range below 2 ** 48');
  }

  return min + cryptoRandomInt(max - min + 1);
}

function toSymbols(alphabet) {
  const symbols = isString(alphabet)
    ? Array.from(alphabet)
    : [];

  if (symbols.length < 2 || symbols.length > BYTE_VALUES || new Set(symbols).size !== symbols.length) {
    throw new TypeError(`randomString(length, alphabet) requires an alphabet of 2 to ${BYTE_VALUES} unique characters`);
  }

  return symbols;
}

// A byte past the last full run of the alphabet is thrown away: "byte % size" alone would favour the first symbols.
function randomIndexes(count, size) {
  const limit = BYTE_VALUES - (BYTE_VALUES % size);
  const indexes = [];

  while (indexes.length < count) {
    const missing = count - indexes.length;

    randomBytes(Math.ceil((missing * BYTE_VALUES) / limit)).forEach((byte) => {
      if (byte < limit && indexes.length < count) {
        indexes.push(byte % size);
      }
    });
  }

  return indexes;
}

export function randomString(length = STRING_LENGTH, alphabet = ALPHABET.ALPHANUMERIC) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError('randomString(length, alphabet) requires a non-negative integer length');
  }

  const symbols = toSymbols(alphabet);

  return randomIndexes(length, symbols.length)
    .map((index) => symbols[index])
    .join('');
}

export function randomToken(byteLength = TOKEN_BYTES) {
  if (!Number.isSafeInteger(byteLength) || byteLength < TOKEN_MIN_BYTES) {
    throw new RangeError(`randomToken(byteLength) requires an integer of at least ${TOKEN_MIN_BYTES} bytes`);
  }

  return randomBytes(byteLength).toString('base64url');
}

export function pick(items) {
  if (!isArray(items)) {
    throw new TypeError('pick(items) requires an array');
  }

  return items.length
    ? items[cryptoRandomInt(items.length)]
    : null;
}
