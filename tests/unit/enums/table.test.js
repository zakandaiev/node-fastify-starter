import { TABLE } from '#enums/table.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SNAKE_CASE_REGEXP = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

describe('TABLE', () => {
  test('names the tables of the database, as the migrations create them', () => {
    assert.deepEqual(TABLE, {
      USERS: 'users',
      USER_IDENTITIES: 'user_identities',
      GROUPS: 'groups',
      GROUP_SCOPES: 'group_scopes',
      USER_GROUPS: 'user_groups',
      AUDIT_LOGS: 'audit_logs',
    });
    assert.ok(Object.isFrozen(TABLE));
  });

  test('every value is a name in snake_case, and every name is its value in upper case', () => {
    Object.entries(TABLE).forEach(([name, table]) => {
      assert.match(table, SNAKE_CASE_REGEXP);
      assert.equal(name, table.toUpperCase());
    });
  });
});
