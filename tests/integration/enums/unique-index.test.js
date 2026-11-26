import { readStructure } from '#core/db/structure.js';
import { UNIQUE_INDEX } from '#enums/unique-index.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const UNIQUE = 'YES';
const INDEX_PREFIX = 'uq_';

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

// By the convention uq_<table>_<columns>, the name of an index tells its table.
function findIndexTable(tables, index) {
  return Object.keys(tables).find((table) => index.startsWith(`${INDEX_PREFIX}${table}_`) && Object.hasOwn(tables[table].indexes, index));
}

describe('UNIQUE_INDEX', { skip: testDb.skip }, () => {
  test('names only unique indexes the migrations of the repository create, each on the table its name tells: a duplicate told by another name is never found', async () => {
    await up();

    const { tables } = await testDb.run(() => readStructure(testDb.name));

    Object.values(UNIQUE_INDEX).forEach((index) => {
      const table = findIndexTable(tables, index);

      assert.ok(table, `The migrations create no index ${index} on the table its name tells`);
      assert.equal(tables[table].indexes[index].unique, UNIQUE, index);
    });
  });
});
