import { isDeepFrozen } from '#root/tests/helper/object.js';
import { freezeDeep } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

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
