import { unique } from '#utils/array.js';
import {
  isArray,
  isFunction,
  isNumber,
  isObject,
  isString,
} from '#utils/type.js';
import { isDeepStrictEqual } from 'node:util';

const PATH_SEPARATOR = '.';
const ARRAY_INDEX_REGEXP = /^(?:0|[1-9]\d*)$/;

// Far deeper than any real document: hostile nesting ends in an error, not in a stack overflow.
const MERGE_MAX_DEPTH = 100;

// Sources may be parsed JSON: a result that carried these keys would reach the prototype chain on its next assignment.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isKey(value) {
  return isString(value) || isNumber(value);
}

// A key that is undefined is a typo in a constant: omit() would silently keep the field it was meant to drop.
function assertSelection(object, keys, name) {
  if (!isObject(object) || !isArray(keys) || !keys.every((key) => isKey(key))) {
    throw new TypeError(`${name}(object, keys) requires a plain object and an array of string or number keys`);
  }
}

// Not object[key] alone: "constructor" or "__proto__" would answer with an inherited value.
function readOwn(object, key) {
  return Object.hasOwn(object, key)
    ? object[key]
    : undefined;
}

// Every result here is built by Object.fromEntries, not by assignment: it defines own properties,
// so "__proto__" stays a plain key and "toString" can be written even when Object.prototype is frozen.
export function pick(object, keys) {
  assertSelection(object, keys, 'pick');

  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(object, key))
      .map((key) => [key, object[key]]),
  );
}

export function omit(object, keys) {
  assertSelection(object, keys, 'omit');

  const omitted = new Set(keys.map(String));

  return Object.fromEntries(Object.entries(object).filter(([key]) => !omitted.has(key)));
}

// Without a prototype, like what groupBy() and keyBy() give: when the keys come from the data, a key that only
// one object has must not be answered by an inherited property of the other.
export function mapValues(object, toValue) {
  if (!isObject(object) || !isFunction(toValue)) {
    throw new TypeError('mapValues(object, toValue) requires a plain object and a function');
  }

  return Object.entries(object).reduce((result, [key, value]) => {
    result[key] = toValue(value, key);

    return result;
  }, Object.create(null));
}

// Without a prototype, as mapValues() gives it. Two keys that map to one take the value of the later.
export function mapKeys(object, toKey) {
  if (!isObject(object) || !isFunction(toKey)) {
    throw new TypeError('mapKeys(object, toKey) requires a plain object and a function');
  }

  return Object.entries(object).reduce((result, [key, value]) => {
    result[toKey(key, value)] = value;

    return result;
  }, Object.create(null));
}

// The set holds the branch being walked, not everything visited: a value shared by two keys is not a cycle.
function enterBranch(ancestors, container) {
  if (ancestors.has(container)) {
    throw new TypeError('deepMerge(target, ...sources) cannot merge a circular structure');
  }

  if (ancestors.size >= MERGE_MAX_DEPTH) {
    throw new RangeError(`deepMerge(target, ...sources) supports at most ${MERGE_MAX_DEPTH} levels of nesting`);
  }

  ancestors.add(container);
}

function cloneArray(items, ancestors) {
  enterBranch(ancestors, items);

  const clone = items.map((item) => mergeValue(undefined, item, ancestors));

  ancestors.delete(items);

  return clone;
}

function mergeValue(current, value, ancestors) {
  if (isArray(value)) {
    return cloneArray(value, ancestors);
  }

  if (!isObject(value)) {
    return value;
  }

  const base = isObject(current)
    ? current
    : {};

  return mergeObjects(base, value, ancestors);
}

function mergeObjects(base, source, ancestors) {
  enterBranch(ancestors, source);

  const merged = Object.entries(source)
    .filter(([key, value]) => value !== undefined && !UNSAFE_KEYS.has(key))
    .map(([key, value]) => [key, mergeValue(readOwn(base, key), value, ancestors)]);

  ancestors.delete(source);

  return Object.fromEntries([...Object.entries(base), ...merged]);
}

export function deepMerge(target, ...sources) {
  const objects = [target, ...sources];

  if (!objects.every((object) => isObject(object))) {
    throw new TypeError('deepMerge(target, ...sources) requires plain objects');
  }

  const ancestors = new Set();

  return objects.reduce((result, source) => mergeObjects(result, source, ancestors), {});
}

export function compact(value) {
  if (isArray(value)) {
    return value.filter((item) => item !== null && item !== undefined);
  }

  if (!isObject(value)) {
    throw new TypeError('compact(value) requires a plain object or an array');
  }

  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function toPathKeys(path) {
  if (isArray(path) && path.every((key) => isKey(key))) {
    return path;
  }

  if (!isString(path)) {
    throw new TypeError('getPath(object, path, defaultValue) requires a dotted string or an array of string or number keys');
  }

  return path === ''
    ? []
    : path.split(PATH_SEPARATOR);
}

function isArrayIndex(key) {
  return isString(key)
    ? ARRAY_INDEX_REGEXP.test(key)
    : Number.isInteger(key) && key >= 0;
}

// Own keys and existing items only: "constructor", "__proto__" and "length" are not data.
function hasStep(container, key) {
  if (isArray(container)) {
    return isArrayIndex(key) && Object.hasOwn(container, key);
  }

  return isObject(container) && Object.hasOwn(container, key);
}

export function getPath(object, path, defaultValue) {
  let current = object;

  const isFound = toPathKeys(path).every((key) => {
    if (!hasStep(current, key)) {
      return false;
    }

    current = current[key];

    return true;
  });

  return isFound && current !== undefined
    ? current
    : defaultValue;
}

// Plain objects and arrays only: freezing a Buffer throws, and a Date or a Map stays mutable anyway.
// Object.isFrozen() cannot replace the set: an object frozen at the top still has children to freeze.
export function freezeDeep(value) {
  const pending = [value];
  const seen = new WeakSet();

  while (pending.length) {
    const item = pending.pop();

    if ((isArray(item) || isObject(item)) && !seen.has(item)) {
      seen.add(item);
      Object.freeze(item);

      Reflect.ownKeys(item).forEach((key) => {
        pending.push(item[key]);
      });
    }
  }

  return value;
}

export function diff(before, after) {
  if (!isObject(before) || !isObject(after)) {
    throw new TypeError('diff(before, after) requires two plain objects');
  }

  return Object.fromEntries(
    unique([...Object.keys(before), ...Object.keys(after)])
      .map((key) => [key, { from: readOwn(before, key), to: readOwn(after, key) }])
      .filter(([, change]) => !isDeepStrictEqual(change.from, change.to)),
  );
}
