import { assertCacheTables, invalidateCacheTables } from '#core/cache/index.js';
import { getContext } from '#core/context/index.js';
import { createMariadbDriver } from '#core/db/driver/mariadb.js';
import { findDbError } from '#core/db/error.js';
import {
  findTransaction,
  isInTransaction,
  runInTransaction,
  withTransaction,
} from '#core/db/transaction.js';
import { camelToSnakeKey, rowToCamel } from '#utils/case.js';
import { assertDurations, convertStringToMs } from '#utils/date.js';
import { UUID_LENGTH } from '#utils/id.js';
import { mapKeys } from '#utils/object.js';
import {
  isArray,
  isFunction,
  isNonEmptyArray,
  isNonEmptyObject,
  isNonNegativeInteger,
  isObject,
  isPositiveInteger,
  isString,
} from '#utils/type.js';

const QUERY_MESSAGE = 'Database query';
const SLOW_QUERY_MESSAGE = 'Slow database query';
const QUERY_VALUES_MESSAGE = 'Database query with its values';
const QUERY_FAILED_MESSAGE = 'Database query failed';

const ALL_COLUMNS = '*';
const LIST_SEPARATOR = ', ';
const CONDITION_SEPARATOR = ' AND ';
const SET_PREFIX = 'set_';
const WHERE_PREFIX = 'where_';

const NOW_SQL = 'SELECT CURRENT_TIMESTAMP(3) AS now';

// Checked when the pool is made: a duration that is read only on a rare path, such as the wait for another
// migrator, would otherwise fail on the day that path is taken.
const DURATION_KEYS = Object.freeze([
  'connectTimeout',
  'statementTimeout',
  'slowQueryThreshold',
  'migrationLockTimeout',
  'migrationTableLockTimeout',
  'migrationIdleTimeout',
]);

// A UUID follows the prefix in the name of the database "verify" builds, and a name holds 64 characters.
const DATABASE_NAME_MAX_LENGTH = 64;
const REFERENCE_PREFIX_MAX_LENGTH = DATABASE_NAME_MAX_LENGTH - UUID_LENGTH;
const REFERENCE_PREFIX_REGEXP = new RegExp(`^[A-Za-z_][A-Za-z0-9_]{0,${REFERENCE_PREFIX_MAX_LENGTH - 1}}$`);

function assertConfig(config) {
  if (!isObject(config)) {
    throw new TypeError('createDb(config) requires the db section of createConfig()');
  }

  if (!isString(config.migrationReferencePrefix) || !REFERENCE_PREFIX_REGEXP.test(config.migrationReferencePrefix)) {
    throw new TypeError(`config.db requires migrationReferencePrefix to be 1 to ${REFERENCE_PREFIX_MAX_LENGTH} letters, digits and underscores that do not start with a digit: a UUID follows it in the name of a database`);
  }

  if (!isPositiveInteger(config.connectionLimit) || !isNonNegativeInteger(config.queueLimit)) {
    throw new TypeError('config.db requires connectionLimit to be a positive integer and queueLimit an integer that is not negative');
  }

  assertDurations(config, DURATION_KEYS, 'config.db');
}

// The form of the statement goes to "info", its values to "debug" only: they are personal data,
// and "info" stays in the logs of production for long.
function logQuery(log, state, { statement, result, durationMs }) {
  const summary = { sql: statement.sql, rowsCount: result.affectedRows, durationMs: Math.round(durationMs) };

  if (durationMs >= state.slowQueryMs) {
    log.warn(summary, SLOW_QUERY_MESSAGE);
  } else {
    log.info(summary, QUERY_MESSAGE);
  }

  log.debug({ sql: statement.prepared.text }, QUERY_VALUES_MESSAGE);
}

// Anything but a DbError is a bug of this code and has neither a kind nor a code to write.
// The line names the statement, which the error itself must not carry.
function logFailure(log, { sql, error, durationMs }) {
  const dbError = findDbError(error);

  if (dbError) {
    log.info({
      sql,
      durationMs: Math.round(durationMs),
      kind: dbError.kind,
      code: dbError.code,
    }, QUERY_FAILED_MESSAGE);
  }
}

// The clock starts when the statement has its connection: the wait in the queue of the pool is not its time.
async function runTimed(state, log, connection, statement, options) {
  const startedAt = performance.now();
  let result;

  try {
    result = await state.driver.execute(connection, statement.prepared, options);
  } catch (error) {
    logFailure(log, { sql: statement.sql, error, durationMs: performance.now() - startedAt });

    throw error;
  }

  logQuery(log, state, { statement, result, durationMs: performance.now() - startedAt });

  return result;
}

// The values are checked and written into the statement first: a wrong binding fails here, before a connection
// is taken or waited for. Inside withTransaction() the statement goes to the connection of the transaction,
// and there it has no time limit: one cut in the middle leaves the rest of the transaction to run on half of the data.
async function query(state, sql, binding = {}, { isTimeLimited = false } = {}) {
  const context = getContext();
  const statement = { sql, prepared: state.driver.prepare(sql, binding) };
  const transaction = findTransaction(context, state.driver);

  if (transaction) {
    return runInTransaction(transaction, (connection) => runTimed(state, context.log, connection, statement));
  }

  return state.driver.withConnection((connection) => runTimed(state, context.log, connection, statement, { isTimeLimited }));
}

export function createDb(config) {
  assertConfig(config);

  const driver = createMariadbDriver(config);
  const state = {
    driver,
    slowQueryMs: convertStringToMs(config.slowQueryThreshold),
  };

  return Object.freeze({
    driver,
    query: query.bind(null, state),
    verify: driver.verify,
    ping: driver.ping,
    close: driver.close,
    getStats: driver.getStats,
  });
}

export function getDb() {
  const { db } = getContext();

  if (!db) {
    throw new Error('The context has no database: build it with createContext({ config, log, db })');
  }

  return db;
}

// Only a transaction that will not commit refuses the bump: one that has ended, or one a lock conflict or a lost
// connection has failed. The write goes back with it, and the caller is told what the write itself failed with.
async function bumpExecuted(tables, error) {
  if (!findDbError(error)?.isExecuted) {
    return false;
  }

  try {
    await invalidateCacheTables(tables);
  } catch {
    return false;
  }

  return true;
}

// A write the server has run and the driver then fails, on a result it cannot read, has changed its rows all the
// same: outside a transaction, or in one that goes on, they stay, so the versions of its tables move too.
export async function invalidateAfterWrite(tables, write) {
  const signature = 'invalidateAfterWrite(tables, write)';

  assertCacheTables(tables, signature);

  if (!isFunction(write)) {
    throw new TypeError(`${signature} requires write to be a function`);
  }

  let result;

  try {
    result = await write();
  } catch (error) {
    await bumpExecuted(tables, error);

    throw error;
  }

  await invalidateCacheTables(tables);

  return result;
}

// Fields are named as the rows of the API name them, in camelCase, and become columns in snake_case.
// "isAdmin" and "is_admin" are one column: named twice, the value written later would win without a sign.
function toColumns(driver, fields, caller) {
  if (!isNonEmptyArray(fields) || !fields.every((field) => isString(field))) {
    throw new TypeError(`${caller} requires at least one field name`);
  }

  const columns = fields.map((field) => ({ field, name: driver.quoteName(camelToSnakeKey(field)) }));

  if (new Set(columns.map((column) => column.name)).size !== columns.length) {
    throw new TypeError(`${caller} names one column twice: a field is given once, in one spelling`);
  }

  return columns;
}

function readFields(row, caller) {
  if (!isNonEmptyObject(row)) {
    throw new TypeError(`${caller} requires a plain object with at least one field`);
  }

  return Object.keys(row);
}

function toReturning(driver, returning, caller) {
  if (returning === undefined) {
    return ALL_COLUMNS;
  }

  if (!isArray(returning)) {
    throw new TypeError(`${caller} requires "returning" to be an array of field names`);
  }

  return toColumns(driver, returning, caller)
    .map((column) => column.name)
    .join(LIST_SEPARATOR);
}

function buildInsert(driver, table, row, caller) {
  const columns = toColumns(driver, readFields(row, caller), caller);
  const names = columns.map((column) => column.name).join(LIST_SEPARATOR);
  const placeholders = columns.map((column) => `:${column.field}`).join(LIST_SEPARATOR);

  return `INSERT INTO ${driver.quoteName(table)} (${names}) VALUES (${placeholders})`;
}

// The driver gets a plain object again: mapKeys() gives one without a prototype.
function prefixKeys(row, prefix) {
  return { ...mapKeys(row, (field) => `${prefix}${field}`) };
}

function buildAssignments(columns, prefix, separator) {
  return columns.map((column) => `${column.name} = :${prefix}${column.field}`).join(separator);
}

// "update" names the fields to overwrite when the row already exists. It has no default: overwriting every
// field would also move the id of the existing row to the one generated for the new one.
export async function upsert(table, row, { update } = {}) {
  const { driver, query: run } = getDb();
  const caller = 'upsert(table, row, { update })';
  const insert = buildInsert(driver, table, row, caller);
  const updated = toColumns(driver, update, caller);

  if (!updated.every((column) => Object.hasOwn(row, column.field))) {
    throw new TypeError(`${caller} requires every field of "update" to be a field of the row`);
  }

  const sql = `${insert} ${driver.buildUpsertClause(updated.map((column) => column.name))}`;

  return invalidateAfterWrite([table], () => run(sql, row));
}

export async function insertReturning(table, row, { returning } = {}) {
  const { driver, query: run } = getDb();
  const caller = 'insertReturning(table, row, { returning })';
  const sql = `${buildInsert(driver, table, row, caller)} RETURNING ${toReturning(driver, returning, caller)}`;
  const { rows } = await invalidateAfterWrite([table], () => run(sql, row));

  return rowToCamel(rows[0]);
}

// By the column, not by the spelling of the field: "userId" in the patch and "user_id" in the condition are one.
function assertCondition(changes, conditions, where, caller) {
  if (conditions.some(({ field }) => where[field] === null || isArray(where[field]))) {
    throw new TypeError(`${caller} compares every field of "where" with one value: null and a list need a statement of their own`);
  }

  const changedNames = changes.map((column) => column.name);

  if (conditions.some((column) => changedNames.includes(column.name))) {
    throw new TypeError(`${caller} cannot change a field it finds the rows by: they would not be found again`);
  }
}

// UPDATE has no RETURNING here: the rows are read again by the same condition inside the same transaction,
// under the locks the update has taken. The bump goes right after the UPDATE: an outer transaction that swallows
// a failed read commits the update all the same.
export async function updateReturning(table, patch, { where, returning } = {}) {
  const { driver, query: run } = getDb();
  const caller = 'updateReturning(table, patch, { where, returning })';
  const changes = toColumns(driver, readFields(patch, caller), caller);
  const conditions = toColumns(driver, readFields(where, caller), caller);

  assertCondition(changes, conditions, where, caller);

  const tableName = driver.quoteName(table);
  const condition = buildAssignments(conditions, WHERE_PREFIX, CONDITION_SEPARATOR);
  const columns = toReturning(driver, returning, caller);
  const conditionBinding = prefixKeys(where, WHERE_PREFIX);

  async function updateAndRead() {
    await invalidateAfterWrite([table], () => run(
      `UPDATE ${tableName} SET ${buildAssignments(changes, SET_PREFIX, LIST_SEPARATOR)} WHERE ${condition}`,
      { ...prefixKeys(patch, SET_PREFIX), ...conditionBinding },
    ));

    const { rows } = await run(`SELECT ${columns} FROM ${tableName} WHERE ${condition}`, conditionBinding);

    return rows.map((row) => rowToCamel(row));
  }

  return isInTransaction()
    ? updateAndRead()
    : withTransaction(updateAndRead);
}

// The clock of the database, which every process shares: the clocks of two app instances may differ.
export async function now() {
  const { rows: [row] } = await getDb().query(NOW_SQL);

  return row.now;
}
