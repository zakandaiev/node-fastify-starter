import { TABLE } from '#enums/table.js';
import { UNIQUE_INDEX } from '#enums/unique-index.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const INDEX_PREFIX = 'uq_';

describe('UNIQUE_INDEX', () => {
  test('names the unique indexes the code tells a duplicate by', () => {
    assert.deepEqual(UNIQUE_INDEX, {
      USERS_EMAIL: 'uq_users_email',
      USER_IDENTITIES_PROVIDER_USER: 'uq_user_identities_provider_user',
      GROUPS_SLUG: 'uq_groups_slug',
    });
    assert.ok(Object.isFrozen(UNIQUE_INDEX));
  });

  test('every value is uq_<table>_<columns> of a table of TABLE, and every name is its value in upper case without the prefix', () => {
    Object.entries(UNIQUE_INDEX).forEach(([name, index]) => {
      assert.ok(index.startsWith(INDEX_PREFIX), index);
      assert.equal(name, index.slice(INDEX_PREFIX.length).toUpperCase());
      assert.ok(Object.values(TABLE).some((table) => index.startsWith(`${INDEX_PREFIX}${table}_`)), index);
    });
  });
});
