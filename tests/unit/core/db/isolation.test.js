import { assertIsolation } from '#core/db/isolation.js';
import { ISOLATION_LEVEL } from '#enums/isolation-level.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('assertIsolation', () => {
  test('accepts every level of the list, and a call that names no level', () => {
    Object.values(ISOLATION_LEVEL).forEach((isolation) => {
      assert.doesNotThrow(() => assertIsolation(isolation, 'run(fn, { isolation })'));
    });
    assert.doesNotThrow(() => assertIsolation(undefined, 'run(fn, { isolation })'));
  });

  test('refuses anything else, naming the function it is called for and the levels there are', () => {
    ['READ COMITTED', 'serializable', 'SNAPSHOT', 'READ COMMITTED; DROP TABLE users', '', null, 5].forEach((isolation) => {
      assert.throws(() => assertIsolation(isolation, 'run(fn, { isolation })'), {
        name: 'TypeError',
        message: 'run(fn, { isolation }) requires one of: READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ, SERIALIZABLE',
      });
    });
  });
});
