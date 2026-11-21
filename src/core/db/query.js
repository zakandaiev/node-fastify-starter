import { assertCacheTables, assertCacheTtl, wrapCache } from '#core/cache/index.js';
import { bindSql } from '#core/db/binding.js';
import { describeColumn } from '#core/db/error.js';
import { buildFilter, readFilterColumns, readFilterPlaceholders } from '#core/db/filter.js';
import { getDb, invalidateAfterWrite } from '#core/db/index.js';
import { buildPagination, readPage } from '#core/db/pagination.js';
import { buildSort, readSortEntries } from '#core/db/sort.js';
import {
  appendToWhere,
  assertCountableSelect,
  assertEditableSelect,
  assertOneStatement,
  assertWrappableSelect,
  buildCountSql,
  isLockingRead,
  isSelect,
  namesResultColumns,
  replaceOrderBy,
  replacePagination,
  requiresDerivedTable,
  wrapSelect,
} from '#core/db/sql.js';
import { TABLE } from '#enums/table.js';
import { rowToCamel, snakeToCamelKey } from '#utils/case.js';
import { objectHash } from '#utils/hash.js';
import { isBoolean, isNonNegativeInteger, isObject } from '#utils/type.js';

const SIGNATURE = 'createQuery(sql, binding, options)';
const CACHE_SIGNATURE = `${SIGNATURE}.cache({ tables, ttl })`;

const STEP = Object.freeze({
  CACHE: 'cache()',
  FILTER: 'filter()',
  SORT: 'sort()',
  PAGINATE: 'paginate()',
});

const PAGE_LIMIT_KEY = 'pagination_limit';
const PAGE_OFFSET_KEY = 'pagination_offset';
const PAGE_SQL = `:${PAGE_LIMIT_KEY} OFFSET :${PAGE_OFFSET_KEY}`;

const TABLE_NAMES = Object.freeze(Object.values(TABLE));

const REJECTED = 'rejected';

function assertTimeLimit(isTimeLimited, isSelectStatement) {
  if (!isBoolean(isTimeLimited)) {
    throw new TypeError(`${SIGNATURE} requires isTimeLimited to be a boolean`);
  }

  if (isTimeLimited && !isSelectStatement) {
    throw new TypeError(`${SIGNATURE} takes isTimeLimited for a SELECT only: a write is never cut in the middle`);
  }

  return true;
}

function createState(sql, binding, isTimeLimited) {
  assertOneStatement(sql, SIGNATURE);

  const isSelectStatement = isSelect(sql);

  if (!isObject(binding)) {
    throw new TypeError(`${SIGNATURE} requires binding to be a plain object`);
  }

  assertTimeLimit(isTimeLimited, isSelectStatement);

  return {
    sql,
    binding: { ...binding },
    isSelect: isSelectStatement,
    isTimeLimited,
    steps: new Set(),
    cache: null,
    filter: null,
    isWrapped: false,
    sort: null,
    page: null,
    isExecuted: false,
    result: null,
  };
}

function takeStep(state, step) {
  if (state.isExecuted) {
    throw new TypeError(`${SIGNATURE}.${step} comes after execute(): every step goes before it`);
  }

  if (state.steps.has(step)) {
    throw new TypeError(`${SIGNATURE}.${step} is given twice`);
  }

  state.steps.add(step);

  return state;
}

// Which rows a locking read locks is the business of its own statement: a filter or a page of a client must not
// decide it, and the count of a page cannot take the lock into a derived table.
function takeReadStep(state, step, { isLockRefused = false } = {}) {
  takeStep(state, step);

  if (!state.isSelect) {
    throw new TypeError(`${SIGNATURE}.${step} takes a SELECT only`);
  }

  if (isLockRefused && isLockingRead(state.sql)) {
    throw new TypeError(`${SIGNATURE}.${step} cannot take a locking read (FOR UPDATE, LOCK IN SHARE MODE): lock the rows by their keys in a statement of its own`);
  }

  return state;
}

// A name TABLE does not know is bumped by no write: what is cached under it would never go stale.
function assertTables(tables) {
  const unknown = tables.find((table) => !TABLE_NAMES.includes(table));

  if (unknown !== undefined) {
    throw new TypeError(`${CACHE_SIGNATURE} names "${unknown}", which is not in TABLE of #enums/table.js: a write would never invalidate what is cached under it`);
  }

  return true;
}

// The ttl is checked here, not left to wrapCache(): with a text filter in effect the cache is skipped, and a wrong
// ttl would fail only the requests without one.
function readCacheOptions(state, { tables, ttl }) {
  assertCacheTables(tables, CACHE_SIGNATURE);
  assertTables(tables);

  if (ttl !== undefined && !state.isSelect) {
    throw new TypeError(`${CACHE_SIGNATURE} takes ttl for a SELECT only: a write bumps the versions of its tables and keeps nothing`);
  }

  if (ttl !== undefined) {
    assertCacheTtl(ttl, CACHE_SIGNATURE);
  }

  return { tables: [...tables], ttl };
}

function assertOwnBinding(state, names, step) {
  const taken = names.find((name) => Object.hasOwn(state.binding, name));

  if (taken !== undefined) {
    throw new TypeError(`${SIGNATURE}.${step} binds :${taken}, which the binding of the query has too: give that key of the binding another name`);
  }

  return true;
}

function toPageBinding({ limit, offset }) {
  return { [PAGE_LIMIT_KEY]: limit, [PAGE_OFFSET_KEY]: offset };
}

function assertFilterColumns(schema) {
  const column = readFilterColumns(schema).find((text) => !namesResultColumns(text));

  if (column !== undefined) {
    throw new TypeError(`${SIGNATURE}.${STEP.FILTER} puts this statement into a derived table, and the filter column "${column}" stands outside it, where only the columns of the result have names: name a column of the result, not an aggregate, a window or a qualified name`);
  }

  return true;
}

function assertSortOrders(entries) {
  const entry = entries.find(({ orderBy }) => !namesResultColumns(orderBy));

  if (entry !== undefined) {
    throw new TypeError(`${SIGNATURE} puts this statement into a derived table for .${STEP.FILTER}, and the sort entry "${entry.value}" orders its rows outside it, where only the columns of the result have names: order by an alias or a position of the result, not by an aggregate, a window or a qualified name`);
  }

  return true;
}

function addCache(state, options) {
  takeStep(state, STEP.CACHE);
  state.cache = readCacheOptions(state, options);

  return true;
}

// Once the step is given the statement goes into a derived table whatever the payload: a value of a client must not
// decide where the filter and every ORDER BY resolve their names.
function addFilter(state, schema, payload, options) {
  takeReadStep(state, STEP.FILTER, { isLockRefused: true });

  const isWrapped = requiresDerivedTable(state.sql);
  const assertStatement = isWrapped
    ? assertWrappableSelect
    : assertEditableSelect;

  assertStatement(state.sql, `${SIGNATURE}.${STEP.FILTER}`);
  assertOwnBinding(state, readFilterPlaceholders(schema), STEP.FILTER);

  if (isWrapped) {
    assertFilterColumns(schema);
    assertSortOrders(state.sort?.entries ?? []);
  }

  state.filter = buildFilter(schema, payload, options);
  state.isWrapped = isWrapped;

  return true;
}

function addSort(state, schema, payload) {
  takeReadStep(state, STEP.SORT);
  assertEditableSelect(state.sql, `${SIGNATURE}.${STEP.SORT}`);

  const sort = buildSort(schema, payload);
  const entries = readSortEntries(schema);

  if (state.isWrapped) {
    assertSortOrders(entries);
  }

  state.sort = { ...sort, entries };

  return true;
}

function addPage(state, payload) {
  takeReadStep(state, STEP.PAGINATE, { isLockRefused: true });
  assertCountableSelect(state.sql, `${SIGNATURE}.${STEP.PAGINATE}`);

  const page = readPage(payload);

  assertOwnBinding(state, Object.keys(toPageBinding(page)), STEP.PAGINATE);
  state.page = page;

  return true;
}

function applyFilter(sql, condition, isWrapped) {
  const target = isWrapped
    ? wrapSelect(sql)
    : sql;

  return condition === null
    ? target
    : appendToWhere(target, condition);
}

function buildSql({
  sql,
  filter,
  isWrapped,
  sort,
  page,
}) {
  const filtered = applyFilter(sql, filter?.condition ?? null, isWrapped);
  const orderBy = sort?.orderBy ?? null;
  const ordered = orderBy === null
    ? filtered
    : replaceOrderBy(filtered, orderBy);

  return page === null
    ? ordered
    : replacePagination(ordered, PAGE_SQL);
}

function buildStatement(state) {
  const sql = buildSql(state);
  const pageBinding = state.page === null
    ? {}
    : toPageBinding(state.page);

  return {
    sql,
    binding: { ...state.binding, ...state.filter?.binding, ...pageBinding },
    countSql: state.page === null
      ? null
      : buildCountSql(sql),
  };
}

// The driver refuses one name twice; two names that differ, such as first_name and firstName, meet in camelCase,
// where a row keeps one value for both.
function readFieldNames(fields) {
  const names = fields.map((field) => field.name);
  const camelNames = names.map((name) => snakeToCamelKey(name));
  const clash = camelNames.findIndex((name, index) => camelNames.indexOf(name) !== index);

  if (clash !== -1) {
    const first = names[camelNames.indexOf(camelNames[clash])];

    throw new TypeError(`${SIGNATURE}: ${describeColumn(first)} and ${describeColumn(names[clash])} are one name in camelCase, and a row keeps one value for a name: give one of them an alias`);
  }

  return camelNames;
}

function toResult(main, count) {
  const fields = readFieldNames(main.fields);

  return {
    rows: main.rows.map((row) => rowToCamel(row)),
    fields,
    affectedRows: main.affectedRows,
    total: count === null
      ? null
      : count.rows[0].total,
  };
}

// Both settle before execute() does: inside a transaction the count waits behind the statement, and a caller that
// catches the failure of the statement would end its transaction while the count still runs.
async function runStatements(db, { sql, binding, countSql }, options) {
  const outcomes = await Promise.allSettled([
    db.query(sql, binding, options),
    countSql === null
      ? null
      : db.query(countSql, binding, options),
  ]);
  const failed = outcomes.find((outcome) => outcome.status === REJECTED);

  if (failed !== undefined) {
    throw failed.reason;
  }

  const [main, count] = outcomes.map((outcome) => outcome.value);

  return { main, count };
}

async function runRead(db, statement, options) {
  const { main, count } = await runStatements(db, statement, options);

  return toResult(main, count);
}

// The marks and the values in their order, not the binding: a key the statement does not use does not split
// the key, and a value the binder refuses fails before Redis is asked.
function toCacheKey({ sql, binding, countSql }) {
  const { sql: marked, values } = bindSql(sql, binding);

  return objectHash({ sql: marked, values, isPaginated: countSql !== null });
}

// The values of a text filter are an unbounded space: a read with one in effect is not cached.
function runSelect(db, state, statement, options) {
  if (state.cache === null || state.filter?.hasText) {
    return runRead(db, statement, options);
  }

  return wrapCache(toCacheKey(statement), () => runRead(db, statement, options), state.cache);
}

// The versions move before the rows are read: a write whose columns meet in camelCase has run all the same.
async function runWrite(db, state, statement, options) {
  const { main, count } = state.cache === null
    ? await runStatements(db, statement, options)
    : await invalidateAfterWrite(state.cache.tables, () => runStatements(db, statement, options));

  return toResult(main, count);
}

async function runQuery(state) {
  if (state.isExecuted) {
    throw new TypeError(`${SIGNATURE}.execute() runs once: build another query to run the statement again`);
  }

  state.isExecuted = true;

  const db = getDb();
  const statement = buildStatement(state);
  const options = { isTimeLimited: state.isTimeLimited || (state.isSelect && state.cache !== null) };

  state.result = state.isSelect
    ? await runSelect(db, state, statement, options)
    : await runWrite(db, state, statement, options);

  return true;
}

function readResult(state, method) {
  if (state.result === null) {
    throw new TypeError(`${SIGNATURE}.${method} reads the result of execute(): await query.execute() first`);
  }

  return state.result;
}

function fetchRow(state) {
  const [row] = readResult(state, 'fetch()').rows;

  return row === undefined
    ? null
    : { ...row };
}

function fetchRows(state) {
  return readResult(state, 'fetchAll()').rows.map((row) => ({ ...row }));
}

// By the list of fields, not by Object.values() of the row: a column named by an integer, such as "1", comes
// first among the keys of an object whatever its place in the result.
function fetchColumn(state, index = 0) {
  const { rows, fields } = readResult(state, 'fetchColumn()');

  if (!isNonNegativeInteger(index) || index >= fields.length) {
    throw new TypeError(`${SIGNATURE}.fetchColumn(index) requires an integer index below ${fields.length}, the number of columns of the result`);
  }

  return rows.length
    ? rows[0][fields[index]]
    : null;
}

function readAffectedRows(state) {
  return readResult(state, 'affectedRows()').affectedRows;
}

function readFilters(state) {
  readResult(state, 'getFilters()');

  return structuredClone(state.filter?.filters ?? []);
}

function readSort(state) {
  readResult(state, 'getSort()');

  return structuredClone(state.sort?.sort ?? []);
}

function readPagination(state) {
  const { total } = readResult(state, 'getPagination()');

  return state.page === null
    ? null
    : buildPagination({ ...state.page, total });
}

function readAll(state) {
  readResult(state, 'getAll()');

  return {
    data: fetchRows(state),
    filters: readFilters(state),
    sort: readSort(state),
    pagination: readPagination(state),
  };
}

function createReaders(state) {
  return {
    fetch: fetchRow.bind(null, state),
    fetchAll: fetchRows.bind(null, state),
    fetchColumn: fetchColumn.bind(null, state),
    affectedRows: readAffectedRows.bind(null, state),
    getFilters: readFilters.bind(null, state),
    getSort: readSort.bind(null, state),
    getPagination: readPagination.bind(null, state),
    getAll: readAll.bind(null, state),
  };
}

// Every step is optional, comes in any order and at most once, and only before execute(): the SQL is built
// from all of them when the query runs.
export function createQuery(sql, binding = {}, { isTimeLimited = false } = {}) {
  const state = createState(sql, binding, isTimeLimited);
  const query = {
    cache({ tables, ttl } = {}) {
      addCache(state, { tables, ttl });

      return query;
    },
    filter(schema, payload, { options, disabled } = {}) {
      addFilter(state, schema, payload, { options, disabled });

      return query;
    },
    sort(schema, payload) {
      addSort(state, schema, payload);

      return query;
    },
    paginate(payload) {
      addPage(state, payload);

      return query;
    },
    async execute() {
      await runQuery(state);

      return query;
    },
    ...createReaders(state),
  };

  return Object.freeze(query);
}
