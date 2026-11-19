import { isArray, isBoolean, isString } from '#utils/type.js';
import { isDate } from 'node:util/types';

// No key of a plain object starts with this character on its own: an object whose only key it is holds a value
// JSON has no type for, and an own key that starts with it is written with one more in front.
const TAG = String.fromCharCode(0);
const ESCAPED_TAG = `${TAG}${TAG}`;

const BASE64 = 'base64';

// Goes into the names of what is stored in this format: text written by another format is never read as this one.
export const SERIALIZED_FORMAT = 1;

const TYPE = Object.freeze({
  UNDEFINED: 'undefined',
  NUMBER: 'number',
  BIGINT: 'bigint',
  DATE: 'date',
  BUFFER: 'buffer',
  OBJECT: 'object',
});

const LIST_BRACKETS = Object.freeze(['[', ']']);
const OBJECT_BRACKETS = Object.freeze(['{', '}']);

// An object without a prototype goes inside a tag of its own and comes back without one: keyBy() and groupBy()
// build their maps so, and a key no entry has must not be answered by an inherited property.
const BARE_OBJECT_BRACKETS = Object.freeze([`{${JSON.stringify(TAG)}:[${JSON.stringify(TYPE.OBJECT)},{`, '}]}']);

const SPECIAL_NUMBERS = Object.freeze({
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
  '-0': -0,
});

const NEGATIVE_ZERO = '-0';
const BIGINT_REGEXP = /^-?(?:0|[1-9][0-9]*)$/;

const SIGNATURE = 'serializeValue(value)';
const UNSUPPORTED_MESSAGE = 'only plain objects, arrays without holes or keys of their own, dates, buffers and primitives except symbols';
const MALFORMED_MESSAGE = 'deserializeValue(text) received a text that serializeValue() does not write';

function enter(walk, container) {
  if (walk.ancestors.has(container)) {
    throw new TypeError(walk.format.circularMessage);
  }

  const [open, close] = walk.format.toBrackets?.(container) ?? (isArray(container)
    ? LIST_BRACKETS
    : OBJECT_BRACKETS);

  walk.ancestors.add(container);
  walk.parts.push(open);
  walk.frames.push({
    container,
    entries: walk.format.toEntries(container),
    index: 0,
    close,
  });
}

function write(walk, value) {
  if (walk.format.isContainer(value)) {
    enter(walk, value);
  } else {
    walk.parts.push(walk.format.writeScalar(value));
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

  return true;
}

// An explicit stack, not recursion: JSON.parse() returns a tree nested far deeper than the call stack goes, and
// JSON.stringify() with a replacer recurses. An entry is [label, value]: "" for an array item, '"key":' for a property.
export function writeValueText(value, format) {
  const walk = {
    format,
    ancestors: new Set(),
    frames: [],
    parts: [],
  };

  write(walk, value);

  while (walk.frames.length) {
    advance(walk);
  }

  return walk.parts.join('');
}

function toTagText(type, ...payload) {
  return JSON.stringify({ [TAG]: [type, ...payload] });
}

function isPlainNumber(value) {
  return Number.isFinite(value) && !Object.is(value, -0);
}

function nameNumber(value) {
  return Object.is(value, -0)
    ? NEGATIVE_ZERO
    : String(value);
}

// An invalid date has no time to write: null stands for it.
function toTime(date) {
  const time = date.getTime();

  return Number.isNaN(time)
    ? null
    : time;
}

// Stricter than isObject(): an object on a prototype of its own would come back without what it inherits.
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function isJsonContainer(value) {
  return isArray(value) || isPlainObject(value);
}

function toJsonBrackets(container) {
  return !isArray(container) && Object.getPrototypeOf(container) === null
    ? BARE_OBJECT_BRACKETS
    : null;
}

function escapeKey(key) {
  return key.startsWith(TAG)
    ? `${TAG}${key}`
    : key;
}

// A hole or a key of its own would not come back: [1, , 3] would return with undefined in the hole,
// and the "total" of a list of rows would be lost.
function isDenseArray(array) {
  const keys = Object.keys(array);

  return keys.length === array.length && keys.every((key, index) => key === String(index));
}

function toJsonEntries(container) {
  if (isArray(container)) {
    if (!isDenseArray(container)) {
      throw new TypeError(`${SIGNATURE} cannot keep an array with holes or with keys of its own`);
    }

    return container.map((item) => ['', item]);
  }

  if (Object.getOwnPropertySymbols(container).length) {
    throw new TypeError(`${SIGNATURE} cannot keep a property keyed by a symbol`);
  }

  return Object.keys(container).map((key) => [`${JSON.stringify(escapeKey(key))}:`, container[key]]);
}

function writeJsonScalar(value) {
  if (value === null || isBoolean(value) || isString(value)) {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    return isPlainNumber(value)
      ? JSON.stringify(value)
      : toTagText(TYPE.NUMBER, nameNumber(value));
  }

  if (value === undefined) {
    return toTagText(TYPE.UNDEFINED);
  }

  if (typeof value === 'bigint') {
    return toTagText(TYPE.BIGINT, String(value));
  }

  if (isDate(value)) {
    return toTagText(TYPE.DATE, toTime(value));
  }

  if (Buffer.isBuffer(value)) {
    return toTagText(TYPE.BUFFER, value.toString(BASE64));
  }

  throw new TypeError(`${SIGNATURE} cannot keep ${Object.prototype.toString.call(value)}: ${UNSUPPORTED_MESSAGE}`);
}

const JSON_FORMAT = Object.freeze({
  isContainer: isJsonContainer,
  toBrackets: toJsonBrackets,
  toEntries: toJsonEntries,
  writeScalar: writeJsonScalar,
  circularMessage: `${SIGNATURE} cannot keep a circular structure`,
});

// JSON text that gives back what it was made of: a Date stays a Date, a Buffer a Buffer, and undefined, a BigInt,
// NaN, Infinity and -0 keep their type. A class instance, a Map or a typed array other than Buffer is refused,
// not flattened into a plain object.
export function serializeValue(value) {
  return writeValueText(value, JSON_FORMAT);
}

function fail() {
  throw new TypeError(MALFORMED_MESSAGE);
}

function readNumber(name) {
  return isString(name) && Object.hasOwn(SPECIAL_NUMBERS, name)
    ? SPECIAL_NUMBERS[name]
    : fail();
}

function readBigint(text) {
  return isString(text) && BIGINT_REGEXP.test(text)
    ? BigInt(text)
    : fail();
}

function readDate(time) {
  if (time === null) {
    return new Date(Number.NaN);
  }

  const date = Number.isInteger(time)
    ? new Date(time)
    : fail();

  return toTime(date) === null
    ? fail()
    : date;
}

// Buffer.from() skips what is not base64 without a word: only a text that it writes back the same is taken.
function readBuffer(text) {
  const buffer = isString(text)
    ? Buffer.from(text, BASE64)
    : null;

  return buffer?.toString(BASE64) === text
    ? buffer
    : fail();
}

const TAG_READERS = Object.freeze({
  [TYPE.NUMBER]: readNumber,
  [TYPE.BIGINT]: readBigint,
  [TYPE.DATE]: readDate,
  [TYPE.BUFFER]: readBuffer,
});

function readTag(payload) {
  if (!isArray(payload) || !isString(payload[0])) {
    return fail();
  }

  const [type, ...rest] = payload;

  if (type === TYPE.UNDEFINED && rest.length === 0) {
    return undefined;
  }

  return Object.hasOwn(TAG_READERS, type) && rest.length === 1
    ? TAG_READERS[type](rest[0])
    : fail();
}

function unescapeKey(key) {
  if (!key.startsWith(TAG)) {
    return key;
  }

  return key.startsWith(ESCAPED_TAG)
    ? key.slice(TAG.length)
    : fail();
}

// defineProperty(), not an assignment: a parsed object may own a "__proto__" key, and assigning to it would set
// the prototype of the object instead.
function setOwn(container, key, value) {
  Object.defineProperty(container, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function isTag(keys) {
  return keys.length === 1 && keys[0] === TAG;
}

// Object.fromEntries() defines every key as an own property, "__proto__" included.
function restoreObject(object, keys) {
  return keys.some((key) => key.startsWith(TAG))
    ? Object.fromEntries(keys.map((key) => [unescapeKey(key), object[key]]))
    : object;
}

function restoreBareObject(payload) {
  const [, entries] = payload;

  if (payload.length !== 2 || entries === null || typeof entries !== 'object' || isArray(entries)) {
    return fail();
  }

  const object = Object.create(null);

  Object.keys(entries).forEach((name) => setOwn(object, unescapeKey(name), entries[name]));

  return object;
}

function isBareObjectTag(payload) {
  return isArray(payload) && payload[0] === TYPE.OBJECT;
}

function restoreSlot(container, key, pending) {
  const value = container[key];

  if (value === null || typeof value !== 'object') {
    return false;
  }

  if (isArray(value)) {
    value.forEach((item, index) => pending.push([value, index]));

    return true;
  }

  const keys = Object.keys(value);
  const isTagged = isTag(keys);

  if (isTagged && !isBareObjectTag(value[TAG])) {
    setOwn(container, key, readTag(value[TAG]));

    return true;
  }

  const restored = isTagged
    ? restoreBareObject(value[TAG])
    : restoreObject(value, keys);

  if (restored !== value) {
    setOwn(container, key, restored);
  }

  Object.keys(restored).forEach((name) => pending.push([restored, name]));

  return true;
}

// The parsed tree is rewritten in place over an explicit stack. Anything serializeValue() would not have written
// is refused, not guessed at.
export function deserializeValue(text) {
  if (!isString(text)) {
    throw new TypeError('deserializeValue(text) requires a string');
  }

  const holder = { value: JSON.parse(text) };
  const pending = [[holder, 'value']];

  while (pending.length) {
    const [container, key] = pending.pop();

    restoreSlot(container, key, pending);
  }

  return holder.value;
}
