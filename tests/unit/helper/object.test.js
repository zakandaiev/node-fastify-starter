import { createHoled, isDeepFrozen } from '#root/tests/helper/object.js';
import { freezeDeep } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('createHoled', () => {
  test('gives a list of the length with the items it names and holes everywhere else', () => {
    const holed = createHoled(3, { 1: 'b' });

    assert.equal(holed.length, 3);
    assert.deepEqual([0 in holed, 1 in holed, 2 in holed], [false, true, false]);
    assert.equal(holed[1], 'b');
    assert.deepEqual(createHoled(2).filter(() => true), []);
  });
});

describe('isDeepFrozen', () => {
  test('accepts a tree that is frozen at every level, arrays included', () => {
    assert.equal(isDeepFrozen(freezeDeep({ a: { b: [{ c: 1 }] }, d: null, e: 'text' })), true);
    assert.equal(isDeepFrozen(Object.freeze({})), true);
  });

  test('rejects a tree with one level left open', () => {
    assert.equal(isDeepFrozen({ a: 1 }), false);
    assert.equal(isDeepFrozen(Object.freeze({ a: { b: 1 } })), false);
    assert.equal(isDeepFrozen(Object.freeze({ a: Object.freeze([{ b: 1 }]) })), false);
  });
});
