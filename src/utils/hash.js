import { writeValueText } from '#utils/serialize.js';
import {
  isArray,
  isBoolean,
  isObject,
  isString,
} from '#utils/type.js';
import { createHash, createHmac, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { isDate, isTypedArray } from 'node:util/types';

const BUFFER = 'buffer';
const HEX = 'hex';
const SHA256 = 'sha256';
const UTF8 = 'utf8';

const DIGEST_ENCODINGS = Object.freeze([HEX, 'base64url', 'base64', BUFFER]);

function isByteSource(value) {
  return isString(value) || isTypedArray(value);
}

function assertInput(value, encoding, signature) {
  if (!isByteSource(value)) {
    throw new TypeError(`${signature} requires a string, a Buffer or a typed array as the value`);
  }

  if (!DIGEST_ENCODINGS.includes(encoding)) {
    throw new TypeError(`${signature} requires one of the encodings: ${DIGEST_ENCODINGS.join(', ')}`);
  }
}

function digest(hasher, encoding) {
  return encoding === BUFFER
    ? hasher.digest()
    : hasher.digest(encoding);
}

export function sha256(value, encoding = HEX) {
  assertInput(value, encoding, 'sha256(value, encoding)');

  return digest(createHash(SHA256).update(value), encoding);
}

export function hmac(value, secret, { algorithm = SHA256, encoding = HEX } = {}) {
  assertInput(value, encoding, 'hmac(value, secret, options)');

  if (!isByteSource(secret) || !secret.length) {
    throw new TypeError('hmac(value, secret, options) requires a non-empty string, Buffer or typed array as the secret');
  }

  try {
    return digest(createHmac(algorithm, secret).update(value), encoding);
  } catch (cause) {
    throw new TypeError('hmac(value, secret, options) requires an algorithm that node:crypto supports for HMAC', { cause });
  }
}

// JSON.stringify() would merge what a cache key must tell apart: NaN and null, -0 and 0, a Date and its ISO string.
function serializeScalar(value) {
  if (isString(value)) {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    return Object.is(value, -0)
      ? '-0'
      : String(value);
  }

  if (typeof value === 'bigint') {
    return `${value}n`;
  }

  if (value === null || value === undefined || isBoolean(value)) {
    return String(value);
  }

  if (isDate(value)) {
    return `Date(${value.getTime()})`;
  }

  if (Buffer.isBuffer(value)) {
    return `Buffer(${value.toString(HEX)})`;
  }

  throw new TypeError(`objectHash(value) cannot serialize ${Object.prototype.toString.call(value)}: only plain objects, arrays, dates, buffers and primitives except symbols`);
}

// Sorted keys: the hash of an object does not depend on the order it was built in. A hole of an array reads as undefined.
function toEntries(container) {
  if (isArray(container)) {
    return Array.from(container, (item) => ['', item]);
  }

  if (Object.getOwnPropertySymbols(container).length) {
    throw new TypeError('objectHash(value) cannot serialize a property keyed by a symbol');
  }

  return Object.keys(container)
    .sort()
    .map((key) => [`${JSON.stringify(key)}:`, container[key]]);
}

function isContainer(value) {
  return isArray(value) || isObject(value);
}

const HASH_FORMAT = Object.freeze({
  isContainer,
  toEntries,
  writeScalar: serializeScalar,
  circularMessage: 'objectHash(value) cannot serialize a circular structure',
});

export function objectHash(value) {
  return sha256(writeValueText(value, HASH_FORMAT));
}

function toBytes(value) {
  return isString(value)
    ? Buffer.from(value, UTF8)
    : value;
}

// crypto.timingSafeEqual() throws on a different byte length, and the length of a string says nothing
// about it: a character outside ASCII takes two to four bytes.
export function timingSafeEqual(left, right) {
  if (!isByteSource(left) || !isByteSource(right)) {
    return false;
  }

  const leftBytes = toBytes(left);
  const rightBytes = toBytes(right);

  return leftBytes.byteLength === rightBytes.byteLength && cryptoTimingSafeEqual(leftBytes, rightBytes);
}
