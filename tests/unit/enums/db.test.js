import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ISOLATION_LEVEL } from '#enums/isolation-level.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('DB_ERROR_KIND', () => {
  test('names the four kinds of a failure the database core tells apart', () => {
    assert.deepEqual(DB_ERROR_KIND, {
      UNIQUE: 'unique',
      DEADLOCK: 'deadlock',
      TIMEOUT: 'timeout',
      OVERLOAD: 'overload',
    });
    assert.ok(Object.isFrozen(DB_ERROR_KIND));
  });
});

describe('ISOLATION_LEVEL', () => {
  test('names the four levels in the words the statement takes', () => {
    assert.deepEqual(Object.values(ISOLATION_LEVEL), ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);
    assert.ok(Object.isFrozen(ISOLATION_LEVEL));
  });

  test('every name is its value with underscores for spaces', () => {
    Object.entries(ISOLATION_LEVEL).forEach(([name, level]) => assert.equal(name, level.replaceAll(' ', '_')));
  });
});
