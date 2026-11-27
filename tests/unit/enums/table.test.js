import { TABLE, TABLE_DEPENDENTS } from '#enums/table.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
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
      SESSIONS: 'sessions',
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

describe('TABLE_DEPENDENTS', () => {
  test('names for users and for groups, and for no other table, the tables whose rows a delete of theirs changes through a foreign key: audit_logs is not one, its record keeps the actor of a deleted user', () => {
    const sorted = Object.fromEntries(Object.entries(TABLE_DEPENDENTS).map(([table, dependents]) => [table, dependents.toSorted()]));

    assert.deepEqual(sorted, {
      [TABLE.USERS]: [TABLE.SESSIONS, TABLE.USER_GROUPS, TABLE.USER_IDENTITIES],
      [TABLE.GROUPS]: [TABLE.GROUP_SCOPES, TABLE.USER_GROUPS],
    });
  });

  test('is frozen, and so is each list of it: a write elsewhere must not change what every later write bumps', () => {
    assert.ok(isDeepFrozen(TABLE_DEPENDENTS));
  });

  test('names only tables of TABLE, as a key and in a list, and each list holds a table once and at least one', () => {
    const tables = Object.values(TABLE);

    Object.entries(TABLE_DEPENDENTS).forEach(([table, dependents]) => {
      assert.ok(tables.includes(table), table);
      assert.ok(dependents.length > 0, table);
      assert.ok(dependents.every((dependent) => tables.includes(dependent)), table);
      assert.equal(new Set(dependents).size, dependents.length, table);
    });
  });
});
