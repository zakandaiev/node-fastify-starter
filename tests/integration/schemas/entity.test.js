import { readStructure } from '#core/db/structure.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { properties as groupProperties, unique as groupUnique } from '#schemas/entity/group.js';
import { properties as sessionProperties } from '#schemas/entity/session.js';
import { properties as userProperties, unique as userUnique } from '#schemas/entity/user.js';
import { camelToSnakeKey, snakeToCamelKey } from '#utils/case.js';
import { UUID_REGEXP } from '#utils/id.js';
import { compact, omit, pick } from '#utils/object.js';
import { isNonEmptyString } from '#utils/type.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const NULLABLE = 'YES';
const UNIQUE = 'YES';
const NULL_TYPE = 'null';

const INDEX_PART_SEPARATOR = ', ';
const INDEX_COLUMN_REGEXP = /^\w+/;

const VARCHAR_REGEXP = /^varchar\((\d+)\)$/;
const LIST_CHECK_REGEXP = /^`\w+`(?: collate \w+)? in \((.+)\)$/;
const QUOTED_VALUE_REGEXP = /'([^']*)'/g;

const SESSION_COMPUTED_FIELDS = Object.freeze(['isCurrent']);
const SESSION_UNTOLD_COLUMNS = Object.freeze(['user_id', 'refresh_token_hash', 'revoked_at', 'created_at', 'updated_at']);

// The rows of group_scopes, gathered by the repository: no column of groups holds them.
const GROUP_COMPUTED_FIELDS = Object.freeze(['scopes']);

// What a type of a column says of its property, in the words of JSON Schema.
const TYPES = Object.freeze({
  uuid: { type: 'string', pattern: UUID_REGEXP.source },
  'datetime(3)': { type: 'string', format: 'date-time-utc' },
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

// The database names the index a duplicate broke, and unique turns that name into the field of the API.
function assertUniqueIndexes(unique, table) {
  Object.entries(unique).forEach(([name, field]) => {
    const index = table.indexes[name];

    assert.ok(index, `The table has no index ${name}`);
    assert.equal(index.unique, UNIQUE, name);

    const columns = index.columns.split(INDEX_PART_SEPARATOR).map((part) => INDEX_COLUMN_REGEXP.exec(part)[0]);

    assert.ok(columns.includes(camelToSnakeKey(field)), `${name} is not on the column of ${field}`);
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

  test('describe a group as the table groups holds one, but for its scopes, which no column of it holds', () => {
    assertDescribes(omit(groupProperties, GROUP_COMPUTED_FIELDS), tables.groups);
  });

  test('describe a scope of a group as the column scope of group_scopes holds one: a text that is never NULL, each code of the catalog within its length', () => {
    const { group_scopes: groupScopes } = tables;
    const column = describeColumn(groupScopes.columns.scope, groupScopes.checks.scope);
    const { items } = groupProperties.scopes;

    assert.deepEqual(pick(items, ['type']), pick(column, ['type']));
    assert.deepEqual(items.enum.filter((code) => code.length > column.maxLength), []);
  });

  test('describe a session by the columns of the table sessions the API tells of: all but the user, the hash of the refresh token, the end and the timestamps', () => {
    const { sessions } = tables;
    const described = omit(sessionProperties, SESSION_COMPUTED_FIELDS);
    const columnOrder = Object.keys(described).map((key) => camelToSnakeKey(key));

    assert.deepEqual([...columnOrder, ...SESSION_UNTOLD_COLUMNS].toSorted(), sessions.columnOrder.toSorted());
    assertDescribes(described, { ...sessions, columnOrder });
  });

  test('name in unique the unique indexes of their tables, each on the column of the field a duplicate is reported on', () => {
    assertUniqueIndexes(userUnique, tables.users);
    assertUniqueIndexes(groupUnique, tables.groups);
  });
});
