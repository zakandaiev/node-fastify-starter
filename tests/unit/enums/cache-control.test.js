import { CACHE_CONTROL } from '#enums/cache-control.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('CACHE_CONTROL', () => {
  test('names the policy of an answer nobody may store, in the words of the header', () => {
    assert.deepEqual(CACHE_CONTROL, { NO_STORE: 'no-store' });
    assert.ok(Object.isFrozen(CACHE_CONTROL));
  });
});
