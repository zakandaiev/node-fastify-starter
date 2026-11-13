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

function enter(walk, container) {
  if (walk.ancestors.has(container)) {
    throw new TypeError('objectHash(value) cannot serialize a circular structure');
  }

  const isList = isArray(container);

  walk.ancestors.add(container);
  walk.parts.push(isList ? '[' : '{');
  walk.frames.push({
    container,
    entries: toEntries(container),
    index: 0,
    close: isList ? ']' : '}',
  });
}

function write(walk, value) {
  if (isArray(value) || isObject(value)) {
    enter(walk, value);
  } else {
    walk.parts.push(serializeScalar(value));
  }
}

function advance(walk) {
  const frame = walk.frames.at(-1);

  if (frame.index === frame.entries.length) {
    walk.parts.push(frame.close);
    walk.ancestors.delete(frame.container);
    walk.frames.pop();

    return false;
  }

  const [label, value] = frame.entries[frame.index];

  walk.parts.push(frame.index ? `,${label}` : label);
  frame.index += 1;
  write(walk, value);
}

// A loop over an explicit stack, not recursion: JSON.parse() returns a body nested far deeper than the call stack goes.
function serialize(value) {
  const walk = { ancestors: new Set(), frames: [], parts: [] };

  write(walk, value);

  while (walk.frames.length) {
    advance(walk);
  }

  return walk.parts.join('');
}

export function objectHash(value) {
  return sha256(serialize(value));
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
