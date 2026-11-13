import { isArray, isObject, isString } from '#utils/type.js';

// Keys reach here from request bodies too: without a ceiling the caches would grow with every new key.
const KEY_CACHE_LIMIT = 1000;

const SNAKE_BOUNDARY_REGEXP = /(?<=[a-z0-9])_+([a-z0-9])/g;
const CAMEL_BOUNDARY_REGEXP = /[A-Z]/g;

const camelKeys = new Map();
const snakeKeys = new Map();

function toCamelKey(key) {
  return key.replace(SNAKE_BOUNDARY_REGEXP, (match, char) => char.toUpperCase());
}

function toSnakeKey(key) {
  return key.replace(CAMEL_BOUNDARY_REGEXP, (char) => `_${char.toLowerCase()}`);
}

function convertKey(cache, convert, key) {
  if (!isString(key)) {
    throw new TypeError('A key to convert must be a string');
  }

  const cached = cache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  if (cache.size >= KEY_CACHE_LIMIT) {
    cache.clear();
  }

  const converted = convert(key);

  cache.set(key, converted);

  return converted;
}

function convertKeys(value, toKey) {
  if (isArray(value)) {
    return value.map((item) => convertKeys(item, toKey));
  }

  if (!isObject(value)) {
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [toKey(key), item]));
}

export function snakeToCamelKey(key) {
  return convertKey(camelKeys, toCamelKey, key);
}

export function camelToSnakeKey(key) {
  return convertKey(snakeKeys, toSnakeKey, key);
}

export function rowToCamel(row) {
  return convertKeys(row, snakeToCamelKey);
}

export function toSnake(payload) {
  return convertKeys(payload, camelToSnakeKey);
}
