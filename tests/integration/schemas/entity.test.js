import { readStructure } from '#core/db/structure.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { properties as groupProperties } from '#schemas/entity/group.js';
import { properties as userProperties } from '#schemas/entity/user.js';
import { snakeToCamelKey } from '#utils/case.js';
import { UUID_REGEXP } from '#utils/id.js';
import { compact, pick } from '#utils/object.js';
import { isNonEmptyString } from '#utils/type.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const NULLABLE = 'YES';
const NULL_TYPE = 'null';

const VARCHAR_REGEXP = /^varchar\((\d+)\)$/;
const LIST_CHECK_REGEXP = /^`\w+`(?: collate \w+)? in \((.+)\)$/;
const QUOTED_VALUE_REGEXP = /'([^']*)'/g;

// What a type of a column says of its property, in the words of JSON Schema.
const TYPES = Object.freeze({
  uuid: { type: 'string', pattern: UUID_REGEXP.source },
  'datetime(3)': { type: 'string', format: 'date-time' },
  'tinyint(1)': { type: 'boolean' },
});

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

function describeType(columnType) {
  const length = VARCHAR_REGEXP.exec(columnType)?.[1];

  if (length) {
    return { type: 'string', maxLength: Number(length) };
  }

  assert.ok(Object.hasOwn(TYPES, columnType), `This test does not know the column type ${columnType} yet`);

  return TYPES[columnType];
}

// A check of a column that lists its values, such as "`status` collate utf8mb4_nopad_bin in ('active','blocked')",
// gives the enum.
function readCheckedValues(check) {
  const list = check && LIST_CHECK_REGEXP.exec(check.clause)?.[1];

  return list
    ? { enum: [...list.matchAll(QUOTED_VALUE_REGEXP)].map(([, value]) => value) }
    : {};
}

// A list of values says more than a length: each of them has to fit the column, the schema names the list alone.
function describeColumn(cells, check) {
  const { maxLength, ...described } = describeType(cells.type);
  const checked = readCheckedValues(check);
  const type = cells.nullable === NULLABLE
    ? [described.type, NULL_TYPE]
    : described.type;

  if (checked.enum) {
    checked.enum.forEach((value) => assert.ok(value.length <= maxLength, `${value} does not fit ${cells.type}`));

    return { ...described, type, ...checked };
  }

  return compact({ ...described, type, maxLength });
}

// The schema may say more than the column, such as the format of an email, never less or something else.
function assertDescribes(properties, table) {
  assert.deepEqual(Object.keys(properties), table.columnOrder.map((column) => snakeToCamelKey(column)));

  table.columnOrder.forEach((column) => {
    const property = properties[snakeToCamelKey(column)];
    const expected = describeColumn(table.columns[column], table.checks[column]);

    assert.deepEqual(pick(property, Object.keys(expected)), expected, column);
    assert.ok(isNonEmptyString(property.description), `${column} has no description`);
  });
}

describe('the entity schemas', { skip: testDb.skip }, () => {
  let tables;

  before(async () => {
    await up();

    ({ tables } = await testDb.run(() => readStructure(testDb.name)));
  });

  test('describe a user as the table users holds one: a property for every column, in its order, with its type, its NULL, its length and the values its check allows', () => {
    assertDescribes(userProperties, tables.users);
  });

  test('describe a group as the table groups holds one', () => {
    assertDescribes(groupProperties, tables.groups);
  });
});
