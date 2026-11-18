import {
  isArray,
  isFunction,
  isPositiveInteger,
  isString,
} from '#utils/type.js';

function assertArray(items, name) {
  if (!isArray(items)) {
    throw new TypeError(`${name}() requires an array`);
  }
}

function toKeyGetter(key) {
  return isFunction(key)
    ? key
    : (item) => item[key];
}

export function chunk(items, size) {
  assertArray(items, 'chunk');

  if (!isPositiveInteger(size)) {
    throw new RangeError('chunk(items, size) requires a positive integer size');
  }

  return Array.from(
    { length: Math.ceil(items.length / size) },
    (unused, index) => items.slice(index * size, (index + 1) * size),
  );
}

export function unique(items, key) {
  assertArray(items, 'unique');

  if (key === undefined) {
    return [...new Set(items)];
  }

  const getKey = toKeyGetter(key);
  const seen = new Set();

  return items.filter((item, index) => {
    const itemKey = getKey(item, index);

    if (seen.has(itemKey)) {
      return false;
    }

    seen.add(itemKey);

    return true;
  });
}

function compareKeys(left, right) {
  if (left < right) {
    return -1;
  }

  return left > right
    ? 1
    : 0;
}

// A sorted copy, ascending: numbers by their value, texts by their code units, equal keys in the order they came.
export function sortBy(items, key) {
  assertArray(items, 'sortBy');

  if (!isFunction(key) && !isString(key)) {
    throw new TypeError('sortBy(items, key) requires the name of a property or a function as the key');
  }

  const getKey = toKeyGetter(key);

  return items.toSorted((left, right) => compareKeys(getKey(left), getKey(right)));
}

export function groupBy(items, key) {
  assertArray(items, 'groupBy');

  return Object.groupBy(items, toKeyGetter(key));
}

// Without a prototype, like the result of Object.groupBy: a key "__proto__" from the data stays a plain key.
export function keyBy(items, key) {
  assertArray(items, 'keyBy');

  const getKey = toKeyGetter(key);

  return items.reduce((result, item, index) => {
    result[getKey(item, index)] = item;

    return result;
  }, Object.create(null));
}
