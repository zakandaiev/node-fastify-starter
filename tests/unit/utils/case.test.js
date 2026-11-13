import {
  camelToSnakeKey,
  rowToCamel,
  snakeToCamelKey,
  toSnake,
} from '#utils/case.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('snakeToCamelKey', () => {
  test('converts snake_case to camelCase', () => {
    assert.equal(snakeToCamelKey('id'), 'id');
    assert.equal(snakeToCamelKey('user_id'), 'userId');
    assert.equal(snakeToCamelKey('created_at'), 'createdAt');
    assert.equal(snakeToCamelKey('is_email_verified'), 'isEmailVerified');
    assert.equal(snakeToCamelKey('address_line_1'), 'addressLine1');
    assert.equal(snakeToCamelKey('user__id'), 'userId');
  });

  test('keeps a key that is already camelCase', () => {
    assert.equal(snakeToCamelKey('createdAt'), 'createdAt');
  });

  test('keeps underscores at the edges and keys that are not snake_case', () => {
    assert.equal(snakeToCamelKey('_id'), '_id');
    assert.equal(snakeToCamelKey('id_'), 'id_');
    assert.equal(snakeToCamelKey('__proto__'), '__proto__');
    assert.equal(snakeToCamelKey('CREATED_AT'), 'CREATED_AT');
    assert.equal(snakeToCamelKey(''), '');
  });

  test('returns the same result for a repeated key', () => {
    assert.equal(snakeToCamelKey('refresh_token_hash'), 'refreshTokenHash');
    assert.equal(snakeToCamelKey('refresh_token_hash'), 'refreshTokenHash');
  });

  test('stays correct after more keys than the cache holds', () => {
    Array.from({ length: 1500 }, (unused, index) => `column_${index}_name`).forEach((key, index) => {
      assert.equal(snakeToCamelKey(key), `column${index}Name`);
    });

    assert.equal(snakeToCamelKey('column_0_name'), 'column0Name');
    assert.equal(snakeToCamelKey('user_id'), 'userId');
  });

  test('rejects a key that is not a string', () => {
    [null, undefined, 1, {}, ['user_id']].forEach((key) => {
      assert.throws(() => snakeToCamelKey(key), { name: 'TypeError', message: /must be a string/ });
    });
  });
});

describe('camelToSnakeKey', () => {
  test('converts camelCase to snake_case', () => {
    assert.equal(camelToSnakeKey('id'), 'id');
    assert.equal(camelToSnakeKey('userId'), 'user_id');
    assert.equal(camelToSnakeKey('createdAt'), 'created_at');
    assert.equal(camelToSnakeKey('isEmailVerified'), 'is_email_verified');
  });

  test('keeps a key that is already snake_case', () => {
    assert.equal(camelToSnakeKey('created_at'), 'created_at');
    assert.equal(camelToSnakeKey(''), '');
  });

  test('does not treat a digit as a word boundary: such a column needs an explicit name', () => {
    assert.equal(camelToSnakeKey('addressLine1'), 'address_line1');
    assert.equal(camelToSnakeKey('sha256Hash'), 'sha256_hash');
  });

  test('splits every capital letter, so an acronym is written as a word', () => {
    assert.equal(camelToSnakeKey('userID'), 'user_i_d');
    assert.equal(camelToSnakeKey('userId'), 'user_id');
  });

  test('stays correct after more keys than the cache holds', () => {
    Array.from({ length: 1500 }, (unused, index) => `column${index}Name`).forEach((key, index) => {
      assert.equal(camelToSnakeKey(key), `column${index}_name`);
    });

    assert.equal(camelToSnakeKey('createdAt'), 'created_at');
  });

  test('rejects a key that is not a string', () => {
    [null, undefined, 1, {}].forEach((key) => {
      assert.throws(() => camelToSnakeKey(key), { name: 'TypeError', message: /must be a string/ });
    });
  });
});

describe('rowToCamel', () => {
  test('converts the keys of a row', () => {
    assert.deepEqual(
      rowToCamel({ id: 1, user_id: 2, created_at: null }),
      { id: 1, userId: 2, createdAt: null },
    );
  });

  test('converts every row of a list', () => {
    assert.deepEqual(
      rowToCamel([{ user_id: 1 }, { user_id: 2 }]),
      [{ userId: 1 }, { userId: 2 }],
    );
    assert.deepEqual(rowToCamel([]), []);
  });

  test('is shallow: a nested value keeps its keys and its identity', () => {
    const settings = { dark_mode: true };
    const createdAt = new Date(0);
    const row = rowToCamel({ user_settings: settings, created_at: createdAt });

    assert.equal(row.userSettings, settings);
    assert.equal(row.createdAt, createdAt);
    assert.deepEqual(row.userSettings, { dark_mode: true });
  });

  test('does not mutate the row', () => {
    const row = Object.freeze({ user_id: 1 });

    assert.deepEqual(rowToCamel(row), { userId: 1 });
    assert.deepEqual(row, { user_id: 1 });
  });

  test('accepts a row without a prototype', () => {
    assert.deepEqual(rowToCamel(Object.assign(Object.create(null), { user_id: 1 })), { userId: 1 });
  });

  test('returns what is not a row as is', () => {
    const date = new Date(0);

    assert.equal(rowToCamel(null), null);
    assert.equal(rowToCamel(undefined), undefined);
    assert.equal(rowToCamel('user_id'), 'user_id');
    assert.equal(rowToCamel(5), 5);
    assert.equal(rowToCamel(date), date);
  });
});

describe('toSnake', () => {
  test('converts the keys of a payload', () => {
    assert.deepEqual(
      toSnake({ id: 1, userId: 2, createdAt: null }),
      { id: 1, user_id: 2, created_at: null },
    );
  });

  test('converts every payload of a list', () => {
    assert.deepEqual(toSnake([{ userId: 1 }, { userId: 2 }]), [{ user_id: 1 }, { user_id: 2 }]);
  });

  test('is shallow and does not mutate the payload', () => {
    const profile = { firstName: 'Anna' };
    const payload = Object.freeze({ userProfile: profile });
    const result = toSnake(payload);

    assert.equal(result.user_profile, profile);
    assert.deepEqual(payload, { userProfile: { firstName: 'Anna' } });
  });

  test('keeps a key "__proto__" as an own key and leaves the prototype alone', () => {
    const result = toSnake(JSON.parse('{"__proto__":{"isAdmin":true},"firstName":"Anna"}'));

    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.isAdmin, undefined);
    assert.deepEqual(Object.keys(result).sort(), ['__proto__', 'first_name']);
  });

  test('returns what is not a payload as is', () => {
    assert.equal(toSnake(null), null);
    assert.equal(toSnake('userId'), 'userId');
    assert.equal(toSnake(5), 5);
  });
});
