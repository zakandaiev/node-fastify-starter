import { getDb } from '#core/db/index.js';
import { COLLATION } from '#enums/collation.js';
import {
  groupBy,
  keyBy,
  sortBy,
  unique,
} from '#utils/array.js';
import { mapSeries } from '#utils/async.js';
import { camelToSnakeKey, rowToCamel } from '#utils/case.js';
import { diff, mapValues, pick } from '#utils/object.js';
import { isArray, isFunction, isNonEmptyString } from '#utils/type.js';

const DEFAULTS_SQL = `
  SELECT default_character_set_name AS charset, default_collation_name AS collation, schema_comment AS comment
  FROM information_schema.schemata
  WHERE schema_name = :database
`;

// Each view is filtered by the one column it looks a database up by: any other filter makes the server open
// the tables of every database it has. The names are spelled in lower case because a row is keyed as they are spelled.
// A temporary table or sequence of the session that reads would stand beside the real one of its name.
const SOURCES = Object.freeze({
  tables: `
    SELECT table_name, table_type, engine, row_format, table_collation, create_options, table_comment
    FROM information_schema.tables
    WHERE table_schema = :database AND table_type NOT IN ('TEMPORARY', 'TEMPORARY SEQUENCE')
  `,
  columns: `
    SELECT table_name, column_name, ordinal_position, column_type, is_nullable, column_default, extra,
      collation_name, generation_expression, column_comment
    FROM information_schema.columns
    WHERE table_schema = :database
  `,
  indexParts: `
    SELECT table_name, index_name, seq_in_index, non_unique, column_name, collation, sub_part, index_type,
      index_comment, ignored
    FROM information_schema.statistics
    WHERE table_schema = :database
  `,
  checks: `
    SELECT table_name, constraint_name, level, check_clause
    FROM information_schema.check_constraints
    WHERE constraint_schema = :database
  `,
  foreignKeys: `
    SELECT table_name, constraint_name, referenced_table_name, update_rule, delete_rule
    FROM information_schema.referential_constraints
    WHERE constraint_schema = :database
  `,
  foreignKeyParts: `
    SELECT table_name, constraint_name, ordinal_position, column_name, referenced_table_schema,
      referenced_table_name, referenced_column_name
    FROM information_schema.key_column_usage
    WHERE table_schema = :database AND referenced_table_name IS NOT NULL
  `,
});

const DESCENDING = 'D';
const YES = 'YES';
const NO = 'NO';
const LIST_SEPARATOR = ', ';
const WORD_SEPARATOR = ' ';
const KEY_SEPARATOR = '_';

// A view and a sequence are rows of information_schema.tables too. Of a view only the kind is compared: its
// other cells are empty, and its comment is the word VIEW or, for a broken one, an error that names the database.
const VIEW_TYPE = 'VIEW';
const TABLE_TYPES = Object.freeze(['BASE TABLE', 'SYSTEM VERSIONED']);
const ALLOWED_COLLATIONS = Object.freeze(Object.values(COLLATION));

const SERVER_CHECK_NAME_REGEXP = /^CONSTRAINT_\d+$/;
const SERVER_KEY_NAME_REGEXP = /^\d+$/;

const LIVE = 'the live database';
const REFERENCE = 'the migrations';

function toTableCells(row) {
  if (row.tableType === VIEW_TYPE) {
    return { type: row.tableType };
  }

  return {
    type: row.tableType,
    engine: row.engine,
    rowFormat: row.rowFormat,
    defaultCollation: row.tableCollation,
    options: row.createOptions,
    comment: row.tableComment,
  };
}

// The default is compared as the server prints it: null is "no default", the text NULL is DEFAULT NULL.
// Only the name of the database itself is taken out of it, which a default on a sequence carries.
function toColumnCells(row, ownPrefix) {
  return {
    type: row.columnType,
    nullable: row.isNullable,
    default: row.columnDefault?.replaceAll(ownPrefix, '') ?? null,
    extra: row.extra,
    collation: row.collationName,
    generationExpression: row.generationExpression,
    comment: row.columnComment,
  };
}

function describeIndexPart(part) {
  const prefix = part.subPart === null
    ? ''
    : `(${part.subPart})`;
  const direction = part.collation === DESCENDING
    ? ' DESC'
    : '';

  return `${part.columnName}${prefix}${direction}`;
}

function toIndexCells(parts) {
  const [first] = parts;

  return {
    columns: sortBy(parts, 'seqInIndex').map((part) => describeIndexPart(part)).join(LIST_SEPARATOR),
    unique: first.nonUnique === 0
      ? YES
      : NO,
    type: first.indexType,
    ignored: first.ignored,
    comment: first.indexComment,
  };
}

function toCheckCells(row) {
  return { level: row.level, clause: row.checkClause };
}

// A key into another database keeps the name of that database, a key inside this one does not carry its own.
function describeReference(part, database) {
  const schema = part.referencedTableSchema === database
    ? ''
    : `${part.referencedTableSchema}.`;

  return `${schema}${part.referencedTableName}.${part.referencedColumnName}`;
}

function toForeignKeyCells(row, parts, database) {
  const ordered = sortBy(parts, 'ordinalPosition');

  return {
    columns: ordered.map((part) => part.columnName).join(LIST_SEPARATOR),
    references: ordered.map((part) => describeReference(part, database)).join(LIST_SEPARATOR),
    onUpdate: row.updateRule,
    onDelete: row.deleteRule,
  };
}

// The name of a foreign key is unique within its table only: two tables may both have a key named "1".
// An account that may only read sees the columns of the keys and not the keys: both sides of a comparison
// would then lose them, or one side only, without an error.
function toForeignKeys(rows, parts, database) {
  const partsByName = groupBy(parts, 'constraintName');
  const keys = keyBy(rows, 'constraintName');

  if (Object.keys(partsByName).some((name) => !keys[name])) {
    throw new Error(`The foreign keys of the database "${database}" cannot be read: information_schema shows this account their columns and not the keys themselves`);
  }

  return mapValues(keys, (row) => toForeignKeyCells(row, partsByName[row.constraintName] ?? [], database));
}

function toTable(row, rows, { database, ownPrefix }) {
  const columns = sortBy(rows.columns ?? [], 'ordinalPosition');

  return {
    cells: toTableCells(row),
    columnOrder: columns.map((column) => column.columnName),
    columns: mapValues(keyBy(columns, 'columnName'), (column) => toColumnCells(column, ownPrefix)),
    indexes: mapValues(groupBy(rows.indexParts ?? [], 'indexName'), (parts) => toIndexCells(parts)),
    checks: mapValues(keyBy(rows.checks ?? [], 'constraintName'), (check) => toCheckCells(check)),
    foreignKeys: toForeignKeys(rows.foreignKeys ?? [], rows.foreignKeyParts ?? [], database),
  };
}

// Everything is keyed by name, in objects without a prototype: the views give their rows in no order that
// could be relied on, and a table named "constructor" must not be found on a side that has no such table.
function buildStructure(database, ownPrefix, rows) {
  const byTable = mapValues(rows, (sourceRows) => groupBy(sourceRows, 'tableName'));
  const tables = mapValues(
    keyBy(rows.tables, 'tableName'),
    (row) => toTable(row, mapValues(byTable, (grouped) => grouped[row.tableName]), { database, ownPrefix }),
  );

  return { database, tables };
}

function assertReader(database, query, signature) {
  if (!isNonEmptyString(database) || !isFunction(query)) {
    throw new TypeError(`${signature} requires the name of a database, and a function when "query" is given`);
  }
}

// What a database is created with. A name that is not there is an error: information_schema answers an unknown
// database with no rows at all, which would read as an empty one.
export async function readDatabaseDefaults(database, { query = getDb().query } = {}) {
  assertReader(database, query, 'readDatabaseDefaults(database, { query })');

  const { rows: [defaults] } = await query(DEFAULTS_SQL, { database });

  if (!defaults) {
    throw new Error(`Database "${database}" does not exist`);
  }

  return defaults;
}

// "query" is for a caller that holds a connection of its own: what it reads must come through that one.
export async function readStructure(database, { query = getDb().query, except = [] } = {}) {
  assertReader(database, query, 'readStructure(database, { query, except })');

  if (!isArray(except)) {
    throw new TypeError('readStructure(database, { query, except }) requires "except" to be a list of table names');
  }

  await readDatabaseDefaults(database, { query });

  const names = Object.keys(SOURCES);
  const results = await mapSeries(names, (name) => query(SOURCES[name], { database }));
  const rows = Object.fromEntries(names.map((name, index) => [
    name,
    results[index].rows.map((row) => rowToCamel(row)).filter((row) => !except.includes(row.tableName)),
  ]));

  return buildStructure(database, `${getDb().driver.escapeName(database)}.`, rows);
}

function listNames(left, right) {
  return unique([...Object.keys(left), ...Object.keys(right)]).toSorted();
}

function toLabel(cell) {
  return camelToSnakeKey(cell).replaceAll(KEY_SEPARATOR, WORD_SEPARATOR);
}

// JSON keeps apart what would print alike: null and the text "NULL", an empty text and no text.
function compareCells(label, live, reference) {
  return Object.entries(diff(live, reference))
    .map(([cell, { from, to }]) => `${label}: ${toLabel(cell)} is ${JSON.stringify(from)} in ${LIVE}, ${JSON.stringify(to)} by ${REFERENCE}`);
}

function compareObject(label, live, reference) {
  if (!live) {
    return [`${label}: missing in ${LIVE}, ${REFERENCE} create it`];
  }

  if (!reference) {
    return [`${label}: exists in ${LIVE}, ${REFERENCE} do not create it`];
  }

  return compareCells(label, live, reference);
}

function compareObjects(kind, table, live, reference) {
  return listNames(live, reference).flatMap((name) => compareObject(`${kind} ${table}.${name}`, live[name], reference[name]));
}

// Of the columns both sides have: a column that one side lacks is told by its own line, and it must not
// make every column after it look moved.
function compareColumnOrder(table, live, reference) {
  const liveOrder = live.filter((name) => reference.includes(name)).join(LIST_SEPARATOR);
  const referenceOrder = reference.filter((name) => live.includes(name)).join(LIST_SEPARATOR);

  return liveOrder === referenceOrder
    ? []
    : [`table ${table}: the columns stand as ${liveOrder} in ${LIVE}, as ${referenceOrder} by ${REFERENCE}`];
}

// A table that became a view, or the reverse, is told by that alone: every other line would only repeat it.
function compareTable(name, live, reference) {
  if (!live || !reference) {
    return compareObject(`table ${name}`, live, reference);
  }

  if (live.cells.type !== reference.cells.type) {
    return compareCells(`table ${name}`, pick(live.cells, ['type']), pick(reference.cells, ['type']));
  }

  return [
    ...compareCells(`table ${name}`, live.cells, reference.cells),
    ...compareObjects('column', name, live.columns, reference.columns),
    ...compareColumnOrder(name, live.columnOrder, reference.columnOrder),
    ...compareObjects('index', name, live.indexes, reference.indexes),
    ...compareObjects('check', name, live.checks, reference.checks),
    ...compareObjects('foreign key', name, live.foreignKeys, reference.foreignKeys),
  ];
}

// One line for every difference between a database and the one its migrations build. Not compared: the text
// of views, triggers, routines and events, how a table is partitioned, the next AUTO_INCREMENT value and the rows.
export function compareStructures(live, reference) {
  return listNames(live.tables, reference.tables)
    .flatMap((name) => compareTable(name, live.tables[name], reference.tables[name]));
}

// The default of a table is the machine collation alone: a column that names none takes it, and a forgotten
// collation must give the stricter comparison, not the looser one.
function findTableCollations(name, table) {
  const columns = Object.entries(table.columns)
    .filter(([, cells]) => cells.collation !== null && !ALLOWED_COLLATIONS.includes(cells.collation))
    .map(([column, cells]) => `column ${name}.${column}: the collation ${cells.collation} is not allowed, only ${ALLOWED_COLLATIONS.join(' and ')} are`);

  return table.cells.defaultCollation === COLLATION.MACHINE
    ? columns
    : [`table ${name}: the default collation is ${table.cells.defaultCollation}, it must be ${COLLATION.MACHINE}`, ...columns];
}

// A column with any other collation compares its text by other rules than the code expects: a machine string
// that ignores case, or a name that tells apart what a person reads as one. Views and sequences are passed over:
// no migration has chosen the collations of their columns.
export function findDisallowedCollations(structure) {
  return Object.keys(structure.tables)
    .toSorted()
    .filter((name) => TABLE_TYPES.includes(structure.tables[name].cells.type))
    .flatMap((name) => findTableCollations(name, structure.tables[name]));
}

function findServerNames(kind, table, names, nameRegexp) {
  return Object.keys(names)
    .filter((name) => nameRegexp.test(name))
    .toSorted()
    .map((name) => `${kind} ${table}.${name}: the server has named it, give it a name in the migration (CONSTRAINT <name> ...)`);
}

// A table check and a foreign key that a migration leaves unnamed get a number from what the table holds
// at that moment. A database that was rolled back in part and migrated again holds other numbers than one
// migrated in a row, and the two would never compare as equal. A check of a column is named after the column.
export function findServerNamedConstraints(structure) {
  return Object.keys(structure.tables).toSorted().flatMap((name) => [
    ...findServerNames('check', name, structure.tables[name].checks, SERVER_CHECK_NAME_REGEXP),
    ...findServerNames('foreign key', name, structure.tables[name].foreignKeys, SERVER_KEY_NAME_REGEXP),
  ]);
}
