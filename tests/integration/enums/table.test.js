import { TABLE } from '#enums/table.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator, listTableNames } from '#root/tests/helper/migration.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const MIGRATIONS_TABLE = '_migrations';

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

describe('TABLE', { skip: testDb.skip }, () => {
  test('names exactly the tables the migrations of the repository create, the table of the migrator aside: .cache() of a query takes no other name', async () => {
    await up();

    const names = (await listTableNames(testDb)).filter((name) => name !== MIGRATIONS_TABLE);

    assert.deepEqual(names, Object.values(TABLE).toSorted());
  });
});
