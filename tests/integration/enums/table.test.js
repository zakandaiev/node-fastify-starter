import { readStructure } from '#core/db/structure.js';
import { TABLE, TABLE_DEPENDENTS } from '#enums/table.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator, listTableNames } from '#root/tests/helper/migration.js';
import { unique } from '#utils/array.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const MIGRATIONS_TABLE = '_migrations';

// The rules by which the server changes the rows of a key itself when the row they reference goes or changes.
const CHANGING_RULES = Object.freeze(['CASCADE', 'SET NULL']);
const REFERENCE_SEPARATOR = ', ';
const NAME_SEPARATOR = '.';

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

function isChanging(foreignKey) {
  return CHANGING_RULES.includes(foreignKey.onDelete) || CHANGING_RULES.includes(foreignKey.onUpdate);
}

// readStructure() spells a reference inside the database as <table>.<column>, one for each column of the key.
function readReferencedTable(foreignKey) {
  const [first] = foreignKey.references.split(REFERENCE_SEPARATOR);

  return first.slice(0, first.lastIndexOf(NAME_SEPARATOR));
}

function readDependents(tables) {
  const pairs = Object.entries(tables).flatMap(([table, { foreignKeys }]) => Object.values(foreignKeys)
    .filter((foreignKey) => isChanging(foreignKey))
    .map((foreignKey) => [readReferencedTable(foreignKey), table]));

  return Object.fromEntries(Object.entries(Object.groupBy(pairs, ([referenced]) => referenced))
    .map(([referenced, grouped]) => [referenced, unique(grouped.map(([, table]) => table)).toSorted()]));
}

describe('TABLE', { skip: testDb.skip }, () => {
  test('names exactly the tables the migrations of the repository create, the table of the migrator aside: .cache() of a query takes no other name', async () => {
    await up();

    const names = (await listTableNames(testDb)).filter((name) => name !== MIGRATIONS_TABLE);

    assert.deepEqual(names, Object.values(TABLE).toSorted());
  });
});

describe('TABLE_DEPENDENTS', { skip: testDb.skip }, () => {
  test('names for each table exactly the tables whose foreign keys reference it with CASCADE or SET NULL, on delete or on update, as the migrations of the repository create them: none missing, none extra', async () => {
    await up();

    const { tables } = await testDb.run(() => readStructure(testDb.name));
    const named = Object.fromEntries(Object.entries(TABLE_DEPENDENTS).map(([table, dependents]) => [table, dependents.toSorted()]));

    assert.deepEqual(named, readDependents(tables));
  });
});
