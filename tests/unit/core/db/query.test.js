import { createContext, runInContext } from '#core/context/index.js';
import { createQuery } from '#core/db/query.js';
import { createLogger } from '#core/logger/index.js';
import { createSchema } from '#core/schema/create-schema.js';
import { FILTER_TYPE } from '#enums/filter-type.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { TABLE } from '#enums/table.js';
import { buildTestApp, readRequestId } from '#root/tests/helper/app.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import * as paginationSchema from '#schemas/common/pagination.js';
import * as userSchema from '#schemas/entity/user.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

const CONFIG = createTestConfig();
const LOG = createLogger(CONFIG.logger);
const PUBLIC = Object.freeze({ auth: false });
const SIGNATURE = 'createQuery(sql, binding, options)';

const LIST_SQL = 'SELECT id, first_name, status, created_at FROM users';
const UPDATE_SQL = 'UPDATE users SET status = :status WHERE id = :id';
const GROUPED_BODY = 'SELECT status, COUNT(*) AS user_count FROM users GROUP BY status';
const GROUPED_SQL = `${GROUPED_BODY} ORDER BY user_count DESC LIMIT 5`;
const WRAPPED_GROUPED = `SELECT * FROM (${GROUPED_BODY}) q`;
const FETCH_SQL = 'SELECT id, first_name FROM users ORDER BY id OFFSET 0 ROWS FETCH FIRST 5 ROWS ONLY';
const COUNT_HEAD = 'SELECT COUNT(*) AS total FROM (';

const WHERE = 'WHERE status = :filter_status';
const ORDER = 'ORDER BY first_name ASC, id ASC';
const PAGE = 'LIMIT :pagination_limit OFFSET :pagination_offset';

const USER_ID = userSchema.example.id;
const CREATED_AT = '2026-11-19T10:00:00.000Z';
const ROW = Object.freeze({
  id: USER_ID,
  first_name: 'Anna',
  status: 'active',
  created_at: new Date(CREATED_AT),
});
const FIELDS = Object.freeze(Object.keys(ROW).map((name) => ({ name })));
const CAMEL_ROW = Object.freeze({
  id: USER_ID,
  firstName: 'Anna',
  status: 'active',
  createdAt: new Date(CREATED_AT),
});

const READERS = Object.freeze(['fetch', 'fetchAll', 'fetchColumn', 'affectedRows', 'getFilters', 'getSort', 'getPagination', 'getAll']);
const NOT_EXECUTED = /reads the result of execute\(\): await query\.execute\(\) first/;

const LOCKING_READS = Object.freeze([
  'SELECT id FROM users FOR UPDATE',
  'SELECT id FROM users WHERE id = :id FOR UPDATE SKIP LOCKED',
  'SELECT id FROM users LOCK IN SHARE MODE',
]);

const OUTSIDE_NAMES = 'where only the columns of the result have names';
const OWN_ORDER_REFUSAL = `${SIGNATURE}.filter() moves the ORDER BY of the statement out of the derived table, ${OUTSIDE_NAMES}: order by an alias or a position of the result, not by an aggregate, a window or a qualified name, or use .sort()`;

const BUSIEST_SORT = Object.freeze({
  sort: [
    {
      value: 'count',
      label: 'Count',
      orderBy: 'user_count DESC',
      isDefault: true,
    },
    { value: 'busiest', label: 'Busiest', orderBy: 'COUNT(*) DESC' },
  ],
});

const PENDING = Symbol('pending');

// A database of the test: it records every statement it is asked, gives a count to the COUNT of a page and the rows
// to anything else. "hold" keeps every answer back until the test lets it go, and "failure" fails every statement;
// the COUNT of a page waits for "countHold" and fails with "countFailure", the same two by default.
function createFakeDb({
  rows = [ROW],
  fields = FIELDS,
  total = rows.length,
  affectedRows = rows.length,
  hold = null,
  failure = null,
  countHold = hold,
  countFailure = failure,
} = {}) {
  const calls = [];

  async function query(sql, binding, options) {
    const isCount = sql.startsWith(COUNT_HEAD);

    calls.push({ sql, binding, options });
    await (isCount
      ? countHold
      : hold);

    const error = isCount
      ? countFailure
      : failure;

    if (error) {
      throw error;
    }

    return isCount
      ? { rows: [{ total }], fields: [{ name: 'total' }], affectedRows: 1 }
      : { rows: rows.map((row) => ({ ...row })), fields, affectedRows };
  }

  return { calls, query };
}

function execute(query, db = createFakeDb()) {
  return runInContext(createContext({ config: CONFIG, log: LOG, db }), () => query.execute());
}

function readStatements(db) {
  return db.calls.map((call) => call.sql);
}

function addCache(query) {
  return query.cache({ tables: [TABLE.USERS] });
}

function addFilter(query) {
  return query.filter(userSchema, { status: 'active' });
}

function addSort(query) {
  return query.sort(userSchema, { sort: 'name' });
}

function addPage(query) {
  return query.paginate({ limit: 10, offset: 20 });
}

function addEmptyFilter(query) {
  return query.filter(userSchema, {});
}

function addEmptySort(query) {
  return query.sort(userSchema, {});
}

function addEmptyPage(query) {
  return query.paginate({});
}

const STEPS = Object.freeze({
  cache: addCache,
  filter: addFilter,
  sort: addSort,
  paginate: addPage,
});

const EMPTY_STEPS = Object.freeze({
  filter: addEmptyFilter,
  sort: addEmptySort,
  paginate: addEmptyPage,
});

function applySteps(query, names) {
  return names.reduce((built, name) => STEPS[name](built), query);
}

function permute(items) {
  if (items.length <= 1) {
    return [items];
  }

  return items.flatMap((item, index) => permute([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

describe('createQuery: the statement and its options', () => {
  test('requires the text of one statement that the lexer reads, and reads it at once', () => {
    ['', null, undefined, 1, ['SELECT 1']].forEach((sql) => {
      assert.throws(() => createQuery(sql), { name: 'TypeError', message: `${SIGNATURE} requires sql to be a non-empty string` }, String(sql));
    });
    ['SELECT 1;', 'SELECT 1; SELECT 2', 'SELECT (SELECT 1;)'].forEach((sql) => {
      assert.throws(() => createQuery(sql), { name: 'SyntaxError', message: `${SIGNATURE} takes one statement without a semicolon` }, sql);
    });
    assert.throws(() => createQuery("SELECT 'open"), { name: 'SyntaxError', message: /an unclosed ' at position 7/ });
    assert.throws(() => createQuery('SELECT (1'), /an unclosed parenthesis/);
  });

  test('requires the binding to be a plain object, request.query among them', () => {
    [null, [], 'id', 1].forEach((binding) => {
      assert.throws(() => createQuery(LIST_SQL, binding), { name: 'TypeError', message: `${SIGNATURE} requires binding to be a plain object` }, String(binding));
    });
    assert.doesNotThrow(() => createQuery(LIST_SQL, Object.create(null)));
  });

  test('requires isTimeLimited to be a boolean, and takes it on a SELECT only: a write is never cut', () => {
    ['true', 1, null].forEach((isTimeLimited) => {
      assert.throws(() => createQuery(LIST_SQL, {}, { isTimeLimited }), { name: 'TypeError', message: `${SIGNATURE} requires isTimeLimited to be a boolean` });
    });
    assert.throws(() => createQuery(UPDATE_SQL, {}, { isTimeLimited: true }), {
      name: 'TypeError',
      message: `${SIGNATURE} takes isTimeLimited for a SELECT only: a write is never cut in the middle`,
    });
    assert.doesNotThrow(() => createQuery(UPDATE_SQL, {}, { isTimeLimited: false }));
    assert.doesNotThrow(() => createQuery('(SELECT 1) UNION (SELECT 2)', {}, { isTimeLimited: true }));
  });
});

describe('createQuery: the steps', () => {
  test('takes each step once: a second call names the step', () => {
    Object.entries(STEPS).forEach(([name, step]) => {
      assert.throws(() => step(step(createQuery(LIST_SQL))), { name: 'TypeError', message: `${SIGNATURE}.${name}() is given twice` });
    });
  });

  test('takes no step after execute(), also while it runs', async () => {
    const executed = createQuery(LIST_SQL);

    await execute(executed);

    Object.entries(STEPS).forEach(([name, step]) => {
      assert.throws(() => step(executed), { name: 'TypeError', message: `${SIGNATURE}.${name}() comes after execute(): every step goes before it` });
    });

    const held = Promise.withResolvers();
    const running = createQuery(LIST_SQL);
    const execution = execute(running, createFakeDb({ hold: held.promise }));

    Object.values(STEPS).forEach((step) => assert.throws(() => step(running), /comes after execute\(\)/));
    held.resolve();
    await execution;
  });

  test('takes filter(), sort() and paginate() on a SELECT only, whatever leads it, and a ttl on a read only', () => {
    [UPDATE_SQL, 'WITH old AS (SELECT id FROM users) DELETE FROM users WHERE id IN (SELECT id FROM old)', 'INSERT INTO users (id) VALUES (:id)'].forEach((sql) => {
      ['filter', 'sort', 'paginate'].forEach((name) => {
        assert.throws(() => STEPS[name](createQuery(sql)), { name: 'TypeError', message: `${SIGNATURE}.${name}() takes a SELECT only` }, sql);
      });
      assert.throws(() => createQuery(sql).cache({ tables: [TABLE.USERS], ttl: '1m' }), {
        name: 'TypeError',
        message: `${SIGNATURE}.cache({ tables, ttl }) takes ttl for a SELECT only: a write bumps the versions of its tables and keeps nothing`,
      });
      assert.doesNotThrow(() => addCache(createQuery(sql)));
    });

    ['(SELECT id FROM users)', 'WITH active AS (SELECT id FROM users) SELECT id FROM active', '  /* list */ SELECT id FROM users'].forEach((sql) => {
      assert.doesNotThrow(() => applySteps(createQuery(sql), ['filter', 'sort', 'paginate']), sql);
    });
  });

  test('refuses filter() and paginate() on a locking read, and takes sort() on one', async () => {
    LOCKING_READS.forEach((sql) => {
      assert.throws(() => addFilter(createQuery(sql)), {
        name: 'TypeError',
        message: `${SIGNATURE}.filter() cannot take a locking read (FOR UPDATE, LOCK IN SHARE MODE): lock the rows by their keys in a statement of its own`,
      }, sql);
      assert.throws(() => addPage(createQuery(sql)), /\.paginate\(\) cannot take a locking read/, sql);
    });

    const db = createFakeDb();

    await execute(addSort(createQuery(LOCKING_READS[0])), db);

    assert.deepEqual(readStatements(db), [`SELECT id FROM users ${ORDER} FOR UPDATE`]);
  });

  test('cache() takes tables of TABLE only and a ttl above zero, by the rules of the cache', () => {
    const tablesRequired = { name: 'TypeError', message: `${SIGNATURE}.cache({ tables, ttl }) requires tables to be a non-empty array of table names` };
    const refusals = [
      [undefined, tablesRequired],
      [{}, tablesRequired],
      [{ tables: [] }, tablesRequired],
      [{ tables: TABLE.USERS }, tablesRequired],
      [{ tables: [TABLE.USERS, 1] }, tablesRequired],
      [{ tables: [TABLE.USERS, ''] }, tablesRequired],
      [{ tables: [TABLE.USERS, 'usres'] }, /names "usres", which is not in TABLE of #enums\/table\.js: a write would never invalidate what is cached under it/],
      [{ tables: [TABLE.USERS], ttl: '0s' }, { name: 'TypeError', message: `${SIGNATURE}.cache({ tables, ttl }) requires a ttl above zero, such as "5m": a cache key is never written without one` }],
      [{ tables: [TABLE.USERS], ttl: '0.0001s' }, /requires a ttl above zero/],
      [{ tables: [TABLE.USERS], ttl: '5 min' }, /convertStringToMs\(value\) requires a number with a unit/],
    ];

    refusals.forEach(([options, reason]) => {
      assert.throws(() => createQuery(LIST_SQL).cache(options), reason, JSON.stringify(options));
    });
    assert.doesNotThrow(() => createQuery(LIST_SQL).cache({ tables: [TABLE.USERS, TABLE.GROUPS], ttl: '5m' }));
  });

  test('refuses a key of the binding that a step can bind, whatever the payload', () => {
    [{ status: 'active' }, { status: '' }, {}].forEach((payload) => {
      assert.throws(() => createQuery(LIST_SQL, { filter_status: 'blocked' }).filter(userSchema, payload), {
        name: 'TypeError',
        message: `${SIGNATURE}.filter() binds :filter_status, which the binding of the query has too: give that key of the binding another name`,
      }, JSON.stringify(payload));
    });
    assert.throws(() => createQuery(LIST_SQL, { filter_createdAtTo: new Date() }).filter(userSchema, { status: 'active' }), /\.filter\(\) binds :filter_createdAtTo, which the binding of the query has too/);
    assert.throws(() => createQuery(LIST_SQL, { pagination_limit: 5 }).paginate(), /\.paginate\(\) binds :pagination_limit, which the binding of the query has too/);
    assert.throws(() => createQuery(LIST_SQL, { pagination_offset: 5 }).paginate(), /\.paginate\(\) binds :pagination_offset/);
  });

  test('refuses at its step, whatever the payload, a statement the step can never apply', () => {
    Object.entries(EMPTY_STEPS).forEach(([name, step]) => {
      assert.throws(() => step(createQuery(FETCH_SQL)), {
        name: 'SyntaxError',
        message: `${SIGNATURE}.${name}() cannot take OFFSET ... ROWS or FETCH: write the page with LIMIT`,
      }, name);
    });
    assert.throws(() => addEmptyPage(createQuery('SELECT SQL_NO_CACHE id FROM users')), {
      name: 'TypeError',
      message: `${SIGNATURE}.paginate() cannot put SQL_NO_CACHE into a derived table: the server refuses that option there, so leave it out of the statement`,
    });
    assert.throws(() => addEmptyFilter(createQuery('SELECT SQL_BUFFER_RESULT status, COUNT(*) AS user_count FROM users GROUP BY status')), /\.filter\(\) cannot put SQL_BUFFER_RESULT into a derived table/);
    assert.throws(() => addEmptyPage(createQuery('SELECT id INTO @id FROM users LIMIT 1')), /\.paginate\(\) cannot put INTO into a derived table/);
    assert.throws(() => addEmptyFilter(createQuery('SELECT status INTO @status FROM users GROUP BY status LIMIT 1')), /\.filter\(\) cannot put INTO into a derived table/);
    assert.throws(() => addEmptyFilter(createQuery('(SELECT first_name, status FROM users ORDER BY created_at DESC) LIMIT 2')), {
      name: 'TypeError',
      message: `${SIGNATURE}.filter() cannot keep the ORDER BY inside the parentheses of the statement: inside a derived table the server drops an ORDER BY without LIMIT, so drop the outer parentheses`,
    });
    assert.doesNotThrow(() => addEmptyFilter(addEmptySort(createQuery('SELECT SQL_NO_CACHE id FROM users'))));
    assert.doesNotThrow(() => addEmptySort(addEmptyPage(createQuery('(SELECT first_name, status FROM users ORDER BY created_at DESC) LIMIT 2'))));
  });

  test('refuses at sort(), whatever the payload, an OFFSET ... ROWS that an ORDER BY after the parentheses drops, and takes one in a branch of a set operation', () => {
    const refused = ['(SELECT a FROM t ORDER BY a OFFSET 1 ROWS)', '(((SELECT a FROM t) UNION ALL (SELECT b FROM u) LIMIT 9) OFFSET 1 ROWS)'];
    const kept = '(SELECT a FROM t ORDER BY a OFFSET 1 ROWS) UNION ALL (SELECT b FROM u)';

    [addEmptySort, addSort].forEach((step) => {
      refused.forEach((sql) => {
        assert.throws(() => step(createQuery(sql)), {
          name: 'TypeError',
          message: `${SIGNATURE}.sort() cannot take an OFFSET ... ROWS without FETCH inside the parentheses of the statement: once the statement goes into a derived table or gets an ORDER BY or a LIMIT after the parentheses, the server drops that offset or filters the rows before it skips them, so skip the rows with LIMIT ... OFFSET`,
        }, sql);
      });
      assert.doesNotThrow(() => step(createQuery(kept)), kept);
    });
  });

  test('refuses filter() on a statement that needs a derived table when its own ORDER BY names more than the columns of the result, whatever the payload', () => {
    const refused = [
      `${GROUPED_BODY} ORDER BY COUNT(*) DESC`,
      'SELECT DISTINCT u.status FROM users u ORDER BY u.status',
      'WITH a AS (SELECT first_name, status FROM users) SELECT a.first_name, a.status FROM a ORDER BY a.first_name',
      'SELECT first_name, RANK() OVER (ORDER BY created_at) AS place FROM users ORDER BY RANK() OVER (ORDER BY created_at)',
    ];

    refused.forEach((sql) => {
      assert.throws(() => addEmptyFilter(createQuery(sql)), { name: 'TypeError', message: OWN_ORDER_REFUSAL }, sql);
      assert.doesNotThrow(() => addEmptySort(addEmptyPage(createQuery(sql))), sql);
    });
    [`${GROUPED_BODY} ORDER BY user_count DESC, 1`, `${GROUPED_BODY} ORDER BY FIELD(status, 'blocked', 'active')`].forEach((sql) => {
      assert.doesNotThrow(() => addEmptyFilter(createQuery(sql)), sql);
    });
  });

  test('refuses filter() on a statement that needs a derived table when a column of its filters names more than a column of the result, whatever the payload', () => {
    const joinedSql = 'SELECT u.id, u.status, COUNT(ug.group_id) AS group_count FROM users u LEFT JOIN user_groups ug ON ug.user_id = u.id GROUP BY u.id';
    const qualified = { filters: { status: { type: FILTER_TYPE.TEXT, column: 'u.status' } } };
    const aggregate = { filters: { groupCount: { type: FILTER_TYPE.NUMBER, column: 'COUNT(*)' } } };

    [[qualified, 'u.status'], [aggregate, 'COUNT(*)']].forEach(([schema, column]) => {
      assert.throws(() => createQuery(joinedSql).filter(schema, {}), {
        name: 'TypeError',
        message: `${SIGNATURE}.filter() puts this statement into a derived table, and the filter column "${column}" stands outside it, ${OUTSIDE_NAMES}: name a column of the result, not an aggregate, a window or a qualified name`,
      }, column);
    });
    assert.doesNotThrow(() => createQuery('SELECT u.id, u.status FROM users u').filter(qualified, {}));
  });

  test('refuses every sort entry that names more than the columns of the result once filter() puts the statement into a derived table, at the second of the two steps, whatever the payload', async () => {
    const refusal = {
      name: 'TypeError',
      message: `${SIGNATURE} puts this statement into a derived table for .filter(), and the sort entry "busiest" orders its rows outside it, ${OUTSIDE_NAMES}: order by an alias or a position of the result, not by an aggregate, a window or a qualified name`,
    };
    const db = createFakeDb();

    assert.throws(() => addEmptyFilter(createQuery(GROUPED_SQL)).sort(BUSIEST_SORT, {}), refusal);
    assert.throws(() => addEmptyFilter(createQuery(GROUPED_SQL).sort(BUSIEST_SORT, {})), refusal);

    await execute(createQuery(GROUPED_SQL).sort(BUSIEST_SORT, { sort: 'busiest' }), db);
    await execute(addEmptyFilter(createQuery(LIST_SQL)).sort({ sort: [{ value: 'newest', orderBy: 'users.created_at DESC' }] }, { sort: 'newest' }), db);

    assert.deepEqual(readStatements(db), [`${GROUPED_BODY} ORDER BY COUNT(*) DESC LIMIT 5`, `${LIST_SQL} ORDER BY users.created_at DESC`]);
  });

  test('checks the sort entries the ORDER BY is built from, not a sort put into the schema after its first read', async () => {
    const schema = { sort: [BUSIEST_SORT.sort[1]] };
    const db = createFakeDb();

    createQuery(GROUPED_SQL).sort(schema, {});
    schema.sort = [BUSIEST_SORT.sort[0]];

    assert.throws(() => addEmptyFilter(createQuery(GROUPED_SQL)).sort(schema, {}), /the sort entry "busiest" orders its rows outside it/);
    assert.throws(() => addEmptyFilter(createQuery(GROUPED_SQL).sort(schema, {})), /the sort entry "busiest" orders its rows outside it/);

    await execute(createQuery(GROUPED_SQL).sort(schema, { sort: 'busiest' }), db);

    assert.deepEqual(readStatements(db), [`${GROUPED_BODY} ORDER BY COUNT(*) DESC LIMIT 5`]);
  });

  test('fails at the step on a payload of the wrong type, before anything runs', () => {
    assert.throws(() => createQuery(LIST_SQL).filter(userSchema, { firstName: 5 }), /"firstName" of the filter "firstName" must be a string/);
    assert.throws(() => createQuery(LIST_SQL).filter(userSchema, {}, { disabled: ['missing'] }), /disabled names "missing", which is not a filter of the schema/);
    assert.throws(() => createQuery(LIST_SQL).sort(userSchema, { sort: 1 }), /requires "sort" of the payload to be the code of an entry/);
    assert.throws(() => createQuery(LIST_SQL).paginate({ limit: 0 }), /requires limit to be an integer from 1 to 100/);
  });
});

describe('createQuery: the statements it runs', () => {
  test('writes each combination of filter, sort and page into the statement, and counts a page without its ORDER BY and LIMIT', async () => {
    const combinations = [
      { steps: [], statements: [LIST_SQL] },
      { steps: ['filter'], statements: [`${LIST_SQL} ${WHERE}`] },
      { steps: ['sort'], statements: [`${LIST_SQL} ${ORDER}`] },
      { steps: ['paginate'], statements: [`${LIST_SQL} ${PAGE}`, `${COUNT_HEAD}${LIST_SQL}) q`] },
      { steps: ['filter', 'sort'], statements: [`${LIST_SQL} ${WHERE} ${ORDER}`] },
      { steps: ['filter', 'paginate'], statements: [`${LIST_SQL} ${WHERE} ${PAGE}`, `${COUNT_HEAD}${LIST_SQL} ${WHERE}) q`] },
      { steps: ['sort', 'paginate'], statements: [`${LIST_SQL} ${ORDER} ${PAGE}`, `${COUNT_HEAD}${LIST_SQL}) q`] },
      { steps: ['filter', 'sort', 'paginate'], statements: [`${LIST_SQL} ${WHERE} ${ORDER} ${PAGE}`, `${COUNT_HEAD}${LIST_SQL} ${WHERE}) q`] },
    ];

    await Promise.all(combinations.map(async ({ steps, statements }) => {
      const db = createFakeDb();

      await execute(applySteps(createQuery(LIST_SQL), steps), db);

      assert.deepEqual(readStatements(db), statements, steps.join(', '));
    }));
  });

  test('builds the same statements in whatever order the steps come', async () => {
    const orders = permute(Object.keys(STEPS));
    const runs = await Promise.all(orders.map(async (order) => {
      const db = createFakeDb();

      await execute(applySteps(createQuery(LIST_SQL), order), db);

      return db.calls;
    }));

    assert.equal(orders.length, 24);
    runs.forEach((calls, index) => assert.deepEqual(calls, runs[0], orders[index].join(', ')));
    assert.deepEqual(readStatements({ calls: runs[0] }), [`${LIST_SQL} ${WHERE} ${ORDER} ${PAGE}`, `${COUNT_HEAD}${LIST_SQL} ${WHERE}) q`]);
  });

  test('binds the binding of the query with the values of the filter and of the page, the same for the count', async () => {
    const before = new Date('2026-11-20T00:00:00.000Z');
    const sql = `${LIST_SQL} WHERE created_at < :before`;
    const db = createFakeDb();
    const binding = {
      before,
      unused: 1,
      filter_status: ['active', 'blocked'],
      pagination_limit: 5,
      pagination_offset: 0,
    };

    await execute(createQuery(sql, { before, unused: 1 }).filter(userSchema, { status: 'active,blocked' }).paginate({ limit: 5 }), db);

    assert.deepEqual(db.calls.map((call) => call.binding), [binding, binding]);
    assert.deepEqual(readStatements(db), [
      `${LIST_SQL} WHERE (created_at < :before) AND (status IN (:filter_status)) ${PAGE}`,
      `${COUNT_HEAD}${LIST_SQL} WHERE (created_at < :before) AND (status IN (:filter_status))) q`,
    ]);
  });

  test('puts a grouping, a set operation or a CTE into a derived table once filter() is given, with a value in effect or without one, and the own ORDER BY and LIMIT after it', async () => {
    const cases = [
      [addFilter(createQuery(GROUPED_SQL)), [`${WRAPPED_GROUPED} ${WHERE} ORDER BY user_count DESC LIMIT 5`]],
      [addPage(addFilter(createQuery(GROUPED_SQL))), [`${WRAPPED_GROUPED} ${WHERE} ORDER BY user_count DESC ${PAGE}`, `${COUNT_HEAD}${WRAPPED_GROUPED} ${WHERE}) q`]],
      [createQuery(GROUPED_SQL).filter(userSchema, { status: '' }), [`${WRAPPED_GROUPED} ORDER BY user_count DESC LIMIT 5`]],
      [addEmptyPage(addEmptyFilter(createQuery(GROUPED_SQL))), [`${WRAPPED_GROUPED} ORDER BY user_count DESC ${PAGE}`, `${COUNT_HEAD}${WRAPPED_GROUPED}) q`]],
      [addFilter(createQuery('SELECT status FROM users UNION SELECT status FROM users')), [`SELECT * FROM (SELECT status FROM users UNION SELECT status FROM users) q ${WHERE}`]],
      [addFilter(createQuery('WITH active AS (SELECT id, status FROM users) SELECT id, status FROM active')), [`SELECT * FROM (WITH active AS (SELECT id, status FROM users) SELECT id, status FROM active) q ${WHERE}`]],
    ];

    await Promise.all(cases.map(async ([query, statements]) => {
      const db = createFakeDb();

      await execute(query, db);

      assert.deepEqual(readStatements(db), statements);
    }));
  });

  test('leaves the ORDER BY of the statement when the sort has no default and the payload names no entry', async () => {
    const schema = { sort: [{ value: 'name', label: 'Name', orderBy: 'first_name ASC, id ASC' }] };
    const db = createFakeDb();
    const query = createQuery(`${LIST_SQL} ORDER BY id`).sort(schema, {});

    await execute(query, db);

    assert.deepEqual(readStatements(db), [`${LIST_SQL} ORDER BY id`]);
    assert.deepEqual(query.getSort(), [{
      label: 'Name',
      value: 'name',
      isChecked: false,
      isDefault: false,
    }]);
  });

  test('runs the count beside the statement, not after it', async () => {
    const held = Promise.withResolvers();
    const db = createFakeDb({ hold: held.promise, total: 7 });
    const query = createQuery(LIST_SQL).paginate({});
    const execution = execute(query, db);

    assert.equal(db.calls.length, 2);
    held.resolve();
    await execution;
    assert.equal(query.getPagination().total, 7);
  });

  test('settles once the statement and its count both have, and fails with the error of the statement before that of the count', async () => {
    const held = Promise.withResolvers();
    const failure = new Error('statement failed');
    const countFailure = new Error('count failed');
    const failed = rejectionOf(execute(createQuery(LIST_SQL).paginate({}), createFakeDb({ failure, countHold: held.promise, countFailure: null })));

    assert.equal(await Promise.race([failed, nextTurn(PENDING)]), PENDING);
    held.resolve();
    assert.equal(await failed, failure);

    const [countOnly, both] = await Promise.all([
      rejectionOf(execute(createQuery(LIST_SQL).paginate({}), createFakeDb({ countFailure }))),
      rejectionOf(execute(createQuery(LIST_SQL).paginate({}), createFakeDb({ failure, countFailure }))),
    ]);

    assert.equal(countOnly, countFailure);
    assert.equal(both, failure);
  });

  test('runs every statement under the time limit when the option asks for it or the read is cached, and a write without it', async () => {
    const cases = [
      [createQuery(LIST_SQL).paginate({}), [false, false]],
      [createQuery(LIST_SQL, {}, { isTimeLimited: true }).paginate({}), [true, true]],
      [addCache(createQuery(LIST_SQL)).paginate({}), [true, true]],
      [addCache(createQuery(LIST_SQL)).filter(userSchema, { firstName: 'an' }).paginate({}), [true, true]],
      [addCache(createQuery(UPDATE_SQL, { status: 'blocked', id: USER_ID })), [false]],
    ];
    const limits = await Promise.all(cases.map(async ([query]) => {
      const db = createFakeDb();

      await execute(query, db);

      return db.calls.map((call) => call.options.isTimeLimited);
    }));

    assert.deepEqual(limits, cases.map(([, expected]) => expected));
  });

  test('a cached read checks its values first: one the binder refuses fails before the database is asked', async () => {
    const db = createFakeDb();
    const query = addCache(createQuery(`${LIST_SQL} WHERE created_at < :before`, { before: { at: 1 } }));

    await assert.rejects(execute(query, db), /Placeholder :before cannot be bound to a value of type object/);
    assert.deepEqual(db.calls, []);
  });
});

describe('createQuery: the result', () => {
  test('execute() resolves with the query, runs once, and fails with the error of the statement', async () => {
    const query = createQuery(LIST_SQL);

    assert.equal(await execute(query), query);
    await assert.rejects(execute(query), { name: 'TypeError', message: `${SIGNATURE}.execute() runs once: build another query to run the statement again` });

    const failure = new Error('database failed');

    await assert.rejects(execute(createQuery(LIST_SQL).paginate({}), createFakeDb({ failure })), (error) => error === failure);
  });

  test('reads nothing before execute() has finished, nor after it failed', async () => {
    const query = createQuery(LIST_SQL);

    READERS.forEach((name) => assert.throws(() => query[name](), { name: 'TypeError', message: NOT_EXECUTED }, name));

    const held = Promise.withResolvers();
    const execution = execute(query, createFakeDb({ hold: held.promise }));

    READERS.forEach((name) => assert.throws(() => query[name](), NOT_EXECUTED, name));
    held.resolve();
    await execution;

    const failed = createQuery(LIST_SQL);

    await assert.rejects(execute(failed, createFakeDb({ failure: new Error('database failed') })), /database failed/);
    READERS.forEach((name) => assert.throws(() => failed[name](), NOT_EXECUTED, name));
  });

  test('gives the rows in camelCase, shallow: the keys inside a JSON column are data, and the fields keep their order', async () => {
    const rows = [{ user_id: 1, profile_data: { first_name: 'Anna', tags: ['a_b'] } }];
    const query = createQuery('SELECT user_id, profile_data FROM profiles');

    await execute(query, createFakeDb({ rows, fields: [{ name: 'user_id' }, { name: 'profile_data' }] }));

    assert.deepEqual(query.fetchAll(), [{ userId: 1, profileData: { first_name: 'Anna', tags: ['a_b'] } }]);
    assert.equal(query.fetchColumn(1).first_name, 'Anna');
  });

  test('refuses two columns that are one name in camelCase, and quotes a column only by its name', async () => {
    const named = createFakeDb({ rows: [{ first_name: 'Anna', firstName: 'Olha' }], fields: [{ name: 'first_name' }, { name: 'firstName' }] });

    await assert.rejects(execute(createQuery('SELECT first_name, last_name AS firstName FROM users'), named), {
      name: 'TypeError',
      message: `${SIGNATURE}: the column "first_name" and the column "firstName" are one name in camelCase, and a row keeps one value for a name: give one of them an alias`,
    });

    const expressions = createFakeDb({ rows: [{}], fields: [{ name: "LOWER('anna_secret')" }, { name: "LOWER('annaSecret')" }] });
    const error = await rejectionOf(execute(createQuery("SELECT LOWER('anna_secret'), LOWER('annaSecret')"), expressions));

    assert.match(error.message, /a column named by its expression and a column named by its expression are one name in camelCase/);
    assert.equal(error.message.includes('anna'), false);
  });

  test('fetch() and fetchAll() give the right rows in any order, each a copy that changes nothing kept', async () => {
    const rows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
    const query = createQuery('SELECT id, name FROM items');

    await execute(query, createFakeDb({ rows, fields: [{ name: 'id' }, { name: 'name' }] }));

    const first = query.fetch();
    const all = query.fetchAll();

    first.name = 'changed';
    all[1].name = 'changed';
    all.push({ id: 3 });

    assert.deepEqual(query.fetchAll(), rows);
    assert.deepEqual(query.fetch(), rows[0]);
    assert.notEqual(query.fetch(), query.fetch());
    assert.deepEqual(query.getAll().data, rows);
  });

  test('without rows fetch() and fetchColumn() give null and fetchAll() an empty list', async () => {
    const query = createQuery('SELECT id FROM items');

    await execute(query, createFakeDb({ rows: [], fields: [{ name: 'id' }] }));

    assert.deepEqual([query.fetch(), query.fetchColumn(), query.fetchAll()], [null, null, []]);
  });

  test('fetchColumn() reads a column by its place in the result, also one named by an integer that an object puts first', async () => {
    const query = createQuery('SELECT name, 1, id FROM items');

    await execute(query, createFakeDb({ rows: [{ name: 'a', 1: 'one', id: 7 }], fields: [{ name: 'name' }, { name: '1' }, { name: 'id' }] }));

    assert.deepEqual(Object.values(query.fetch()), ['one', 'a', 7]);
    assert.deepEqual([query.fetchColumn(), query.fetchColumn(0), query.fetchColumn(1), query.fetchColumn(2)], ['a', 'a', 'one', 7]);
    [-1, 3, 1.5, '1', null].forEach((index) => {
      assert.throws(() => query.fetchColumn(index), {
        name: 'TypeError',
        message: `${SIGNATURE}.fetchColumn(index) requires an integer index below 3, the number of columns of the result`,
      }, String(index));
    });
  });

  test('affectedRows() gives the count of a write, which has no rows and no columns', async () => {
    const query = createQuery(UPDATE_SQL, { status: 'blocked', id: USER_ID });

    await execute(query, createFakeDb({ rows: [], fields: [], affectedRows: 3 }));

    assert.equal(query.affectedRows(), 3);
    assert.deepEqual([query.fetch(), query.fetchAll()], [null, []]);
    assert.throws(() => query.fetchColumn(), /requires an integer index below 0/);
  });

  test('the getters give copies of filters[] and sort[] and the pagination of the page; without their step [] and null', async () => {
    const query = createQuery(LIST_SQL).filter(userSchema, { status: 'active' }).sort(userSchema, {}).paginate({ limit: 2, offset: 2 });

    await execute(query, createFakeDb({ total: 5 }));

    const filters = query.getFilters();

    filters[1].options[0].label = 'changed';
    filters.pop();

    assert.equal(query.getFilters().length, 3);
    assert.equal(query.getFilters()[1].options[0].label, 'Active');
    assert.deepEqual(query.getSort().map((entry) => [entry.value, entry.isChecked]), [['newest', true], ['name', false]]);
    assert.deepEqual(query.getPagination(), {
      total: 5,
      limit: 2,
      offset: 2,
      totalPages: 3,
      currentPage: 2,
      canLoadMore: true,
    });

    const bare = createQuery(LIST_SQL);

    await execute(bare);

    assert.deepEqual([bare.getFilters(), bare.getSort(), bare.getPagination()], [[], [], null]);
    assert.deepEqual(bare.getAll(), {
      data: [CAMEL_ROW],
      filters: [],
      sort: [],
      pagination: null,
    });
  });
});

describe('createQuery: getAll() and reply.list()', () => {
  test('getAll() is what reply.list() takes: the data, the pagination, the sort and the filters of the envelope', async (t) => {
    const fastify = await buildTestApp();
    const query = createQuery(LIST_SQL).filter(userSchema, { status: 'active' }).sort(userSchema, { sort: 'name' }).paginate({ limit: 1 });
    const schema = createSchema(userSchema, paginationSchema)
      .query(['limit', 'offset', 'sort', 'firstName', 'status', 'createdAt'])
      .response(HTTP_STATUS.OK, { data: ['id', 'firstName', 'status', 'createdAt'], format: 'array' })
      .build();

    t.after(() => fastify.close());
    await execute(query, createFakeDb({ total: 2 }));
    fastify.get('/api/v1/query-probe/users', { schema, security: PUBLIC }, (request, reply) => reply.list(query.getAll()));

    const response = await fastify.inject('/api/v1/query-probe/users');

    assert.equal(response.statusCode, HTTP_STATUS.OK, response.body);
    assert.deepEqual(response.json(), {
      status: 'success',
      data: [{
        id: USER_ID,
        firstName: 'Anna',
        status: 'active',
        createdAt: CREATED_AT,
      }],
      pagination: {
        total: 2,
        limit: 1,
        offset: 0,
        totalPages: 2,
        currentPage: 1,
        canLoadMore: true,
      },
      sort: query.getSort(),
      filters: query.getFilters(),
      meta: { requestId: readRequestId(response) },
    });
  });
});
