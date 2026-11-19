import { USER_STATUS } from '#enums/user-status.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('USER_STATUS', () => {
  test('names the two states of a user, as the check of users.status takes them', () => {
    assert.deepEqual(USER_STATUS, { ACTIVE: 'active', BLOCKED: 'blocked' });
    assert.ok(Object.isFrozen(USER_STATUS));
  });
});
