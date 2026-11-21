import { loadUniqueFields } from '#core/schema/unique.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { camelToSnakeKey } from '#utils/case.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PRIMARY_INDEX = 'PRIMARY';

const UNIQUE_INDEXES_SQL = `
  SELECT table_name, index_name, column_name
  FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND non_unique = 0 AND index_name <> :primary
`;

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

// The name of an index is unique within its table only, and a duplicate names the index without its table:
// a name two tables share cannot tell the field.
function describeIndex(rows, name) {
  const own = rows.filter((row) => row.index_name === name);

  return {
    tables: [...new Set(own.map((row) => row.table_name))],
    columns: own.map((row) => row.column_name),
  };
}

describe('loadUniqueFields', { skip: testDb.skip }, () => {
  test('names only unique indexes the migrations of the repository create, each of one table and holding the column of its field: a duplicate of any other answers with a null column', async () => {
    await up();

    const [fields, rows] = await Promise.all([loadUniqueFields(), testDb.readRows(UNIQUE_INDEXES_SQL, { primary: PRIMARY_INDEX })]);
    const entries = Object.entries(fields);

    assert.notEqual(entries.length, 0, 'no entity schema maps a unique index');
    entries.forEach(([name, field]) => {
      const { tables, columns } = describeIndex(rows, name);

      assert.equal(tables.length, 1, `"${name}" must name a unique index of exactly one table, not the primary key; the tables that have it: ${tables.join(', ') || 'none'}`);
      assert.ok(columns.includes(camelToSnakeKey(field)), `"${name}" holds ${columns.join(', ')}, not the column of the field "${field}"`);
    });
  });
});
