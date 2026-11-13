import {
  chunk,
  groupBy,
  keyBy,
  unique,
} from '#utils/array.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const USERS = Object.freeze([
  { id: 1, status: 'active' },
  { id: 2, status: 'blocked' },
  { id: 3, status: 'active' },
]);

const NOT_ARRAYS = [null, undefined, 'abc', { length: 2 }, new Set([1])];

describe('chunk', () => {
  test('splits an array into parts of the given size', () => {
    assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]]);
  });

  test('returns one part when the size covers the array, and nothing for an empty array', () => {
    assert.deepEqual(chunk([1, 2], 2), [[1, 2]]);
    assert.deepEqual(chunk([1, 2], 10), [[1, 2]]);
    assert.deepEqual(chunk([], 3), []);
  });

  test('does not mutate the array', () => {
    const items = Object.freeze([1, 2, 3]);

    assert.deepEqual(chunk(items, 2), [[1, 2], [3]]);
  });

  test('rejects a size that is not a positive integer', () => {
    [0, -1, 1.5, Number.NaN, Infinity, '2', null, undefined].forEach((size) => {
      assert.throws(() => chunk([1, 2], size), { name: 'RangeError', message: /^chunk\(/ });
    });
  });

  test('rejects what is not an array', () => {
    NOT_ARRAYS.forEach((items) => {
      assert.throws(() => chunk(items, 2), { name: 'TypeError', message: /^chunk\(/ });
    });
  });
});

describe('unique', () => {
  test('drops repeated values and keeps the first order', () => {
    assert.deepEqual(unique([3, 1, 3, 2, 1]), [3, 1, 2]);
    assert.deepEqual(unique(['b', 'a', 'b']), ['b', 'a']);
    assert.deepEqual(unique([]), []);
  });

  test('compares by identity: NaN equals NaN, and equal objects stay apart', () => {
    assert.deepEqual(unique([Number.NaN, Number.NaN, 0, '0']), [Number.NaN, 0, '0']);
    assert.equal(unique([{ id: 1 }, { id: 1 }]).length, 2);
  });

  test('compares by a property name, the first item wins', () => {
    assert.deepEqual(unique(USERS, 'status'), [USERS[0], USERS[1]]);
  });

  test('compares by the result of a function that receives the item and its index', () => {
    assert.deepEqual(unique(USERS, (user) => user.id % 2), [USERS[0], USERS[1]]);
    assert.deepEqual(unique(['a', 'b', 'c', 'd'], (item, index) => index % 2), ['a', 'b']);
  });

  test('does not mutate the array', () => {
    const items = Object.freeze([1, 1, 2]);

    assert.deepEqual(unique(items), [1, 2]);
  });

  test('rejects what is not an array', () => {
    NOT_ARRAYS.forEach((items) => {
      assert.throws(() => unique(items), { name: 'TypeError', message: /^unique\(/ });
    });
  });
});

describe('groupBy', () => {
  test('groups items by a property name', () => {
    assert.deepEqual({ ...groupBy(USERS, 'status') }, {
      active: [USERS[0], USERS[2]],
      blocked: [USERS[1]],
    });
  });

  test('groups items by the result of a function that receives the item and its index', () => {
    assert.deepEqual({ ...groupBy(USERS, (user) => (user.id > 1 ? 'rest' : 'first')) }, {
      first: [USERS[0]],
      rest: [USERS[1], USERS[2]],
    });
    assert.deepEqual({ ...groupBy(['a', 'b', 'c'], (item, index) => index % 2) }, { 0: ['a', 'c'], 1: ['b'] });
  });

  test('returns an empty object for an empty array', () => {
    assert.deepEqual(Object.keys(groupBy([], 'status')), []);
  });

  test('returns an object without a prototype, so a key from the data cannot reach it', () => {
    const groups = groupBy([{ name: '__proto__' }, { name: 'constructor' }], 'name');

    assert.equal(Object.getPrototypeOf(groups), null);
    assert.deepEqual(Object.keys(groups).sort(), ['__proto__', 'constructor']);
    assert.equal({}.name, undefined);
  });

  test('rejects what is not an array', () => {
    NOT_ARRAYS.forEach((items) => {
      assert.throws(() => groupBy(items, 'status'), { name: 'TypeError', message: /^groupBy\(/ });
    });
  });
});

describe('keyBy', () => {
  test('indexes items by a property name', () => {
    assert.deepEqual({ ...keyBy(USERS, 'id') }, { 1: USERS[0], 2: USERS[1], 3: USERS[2] });
  });

  test('indexes items by the result of a function that receives the item and its index', () => {
    assert.deepEqual({ ...keyBy(USERS, (user) => `user:${user.id}`) }, {
      'user:1': USERS[0],
      'user:2': USERS[1],
      'user:3': USERS[2],
    });
    assert.deepEqual({ ...keyBy(['a', 'b'], (item, index) => index) }, { 0: 'a', 1: 'b' });
  });

  test('keeps the last item of a repeated key', () => {
    assert.deepEqual({ ...keyBy(USERS, 'status') }, { active: USERS[2], blocked: USERS[1] });
  });

  test('returns an empty object for an empty array', () => {
    assert.deepEqual(Object.keys(keyBy([], 'id')), []);
  });

  test('returns an object without a prototype, so a key from the data cannot reach it', () => {
    const polluted = { name: '__proto__', isAdmin: true };
    const index = keyBy([polluted, { name: 'constructor' }], 'name');

    assert.equal(Object.getPrototypeOf(index), null);
    assert.equal(index.__proto__, polluted); // eslint-disable-line no-proto -- an own key of the result, read on purpose
    assert.deepEqual(Object.keys(index).sort(), ['__proto__', 'constructor']);
    assert.equal({}.isAdmin, undefined);
  });

  test('rejects what is not an array', () => {
    NOT_ARRAYS.forEach((items) => {
      assert.throws(() => keyBy(items, 'id'), { name: 'TypeError', message: /^keyBy\(/ });
    });
  });
});
