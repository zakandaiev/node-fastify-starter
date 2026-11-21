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
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const CONDITION = 'x = :x';
const ORDER_BY = 'created_at DESC, id DESC';
const PAGE = ':pagination_limit OFFSET :pagination_offset';
const CALLER = 'createQuery(sql, binding, options).filter()';

const WITH_QUERY_SQL = 'WITH g AS (SELECT slug, name FROM groups) (SELECT name FROM g ORDER BY name LIMIT 1) UNION ALL (SELECT name FROM g ORDER BY name DESC LIMIT 1)';

const SELECT_REQUIRED = /requires a SELECT statement/;
const SEMICOLON_REFUSED = /takes one statement without a semicolon/;
const FETCH_REFUSED = /cannot take OFFSET \.\.\. ROWS or FETCH: write the page with LIMIT/;
const WRAP_REFUSED = /cannot put .+ into a derived table/;
const QUERY_EXPRESSION_REFUSED = /takes a single query: wrap .+ in a derived table first \(wrapSelect\)/;
const OUTER_ORDER_MESSAGE = 'moves the ORDER BY of the statement out of the derived table, where only the columns of the result have names: order by an alias or a position of the result, not by an aggregate, a window or a qualified name, or use .sort()';
const INNER_ORDER_MESSAGE = 'cannot keep the ORDER BY inside the parentheses of the statement: inside a derived table the server drops an ORDER BY without LIMIT, so drop the outer parentheses';
const INNER_OFFSET_MESSAGE = 'cannot take an OFFSET ... ROWS without FETCH inside the parentheses of the statement: once the statement goes into a derived table or gets an ORDER BY or a LIMIT after the parentheses, the server drops that offset or filters the rows before it skips them, so skip the rows with LIMIT ... OFFSET';

const DERIVED_TABLE_OPTIONS = Object.freeze(['HIGH_PRIORITY', 'SQL_BUFFER_RESULT', 'SQL_CACHE', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS']);

function where(sql) {
  return appendToWhere(sql, CONDITION);
}

function order(sql) {
  return replaceOrderBy(sql, ORDER_BY);
}

function page(sql) {
  return replacePagination(sql, PAGE);
}

function checkOneStatement(sql) {
  return assertOneStatement(sql, CALLER);
}

function checkEditable(sql) {
  return assertEditableSelect(sql, CALLER);
}

function checkCountable(sql) {
  return assertCountableSelect(sql, CALLER);
}

function checkWrappable(sql) {
  return assertWrappableSelect(sql, CALLER);
}

const FUNCTIONS = Object.freeze({
  isSelect,
  requiresDerivedTable,
  isLockingRead,
  appendToWhere: where,
  replaceOrderBy: order,
  replacePagination: page,
  wrapSelect,
  buildCountSql,
  assertOneStatement: checkOneStatement,
  assertEditableSelect: checkEditable,
  assertCountableSelect: checkCountable,
  assertWrappableSelect: checkWrappable,
});

const SELECT_CHECKS = Object.freeze(['assertEditableSelect', 'assertCountableSelect', 'assertWrappableSelect']);
const SELECT_ONLY = Object.freeze(['requiresDerivedTable', 'appendToWhere', 'replaceOrderBy', 'replacePagination', 'wrapSelect', 'buildCountSql', ...SELECT_CHECKS]);
const PAGE_EDITORS = Object.freeze(['appendToWhere', 'replaceOrderBy', 'replacePagination', 'wrapSelect', 'buildCountSql', ...SELECT_CHECKS]);
const EDITOR_SIGNATURES = Object.freeze({
  appendToWhere: 'appendToWhere(sql, condition)',
  replaceOrderBy: 'replaceOrderBy(sql, orderBy)',
  replacePagination: 'replacePagination(sql, limit)',
  wrapSelect: 'wrapSelect(sql)',
  buildCountSql: 'buildCountSql(sql)',
  assertEditableSelect: CALLER,
  assertCountableSelect: CALLER,
  assertWrappableSelect: CALLER,
});

describe('sql: the checks of every function', () => {
  test('requires the text of a statement', () => {
    Object.entries(FUNCTIONS).forEach(([name, fn]) => {
      assert.throws(() => fn(''), /requires sql to be a non-empty string/, name);
      assert.throws(() => fn(null), TypeError, name);
      assert.throws(() => fn(['SELECT 1']), TypeError, name);
    });
  });

  test('refuses a semicolon at any depth, also at the end', () => {
    Object.entries(FUNCTIONS).forEach(([name, fn]) => {
      assert.throws(() => fn('SELECT 1;'), SEMICOLON_REFUSED, name);
      assert.throws(() => fn('SELECT 1; SELECT 2'), SyntaxError, name);
      assert.throws(() => fn('SELECT id FROM t WHERE id IN (SELECT 1;)'), SEMICOLON_REFUSED, name);
      assert.doesNotThrow(() => fn("SELECT ';' AS `;` FROM t -- ;\n/* ; */"), name);
    });
  });

  test('passes on what the lexer cannot read', () => {
    Object.entries(FUNCTIONS).forEach(([name, fn]) => {
      assert.throws(() => fn("SELECT 'abc"), /an unclosed '/, name);
      assert.throws(() => fn('SELECT (1'), /an unclosed parenthesis/, name);
      assert.throws(() => fn('SELECT 1 /*! 2 */'), /an unsupported executable comment/, name);
    });
  });

  test('requires a SELECT everywhere but in isSelect, isLockingRead and assertOneStatement', () => {
    SELECT_ONLY.forEach((name) => {
      assert.throws(() => FUNCTIONS[name]('UPDATE users SET name = :name'), SELECT_REQUIRED, name);
      assert.throws(() => FUNCTIONS[name]('INSERT INTO t SELECT * FROM u'), TypeError, name);
      assert.throws(() => FUNCTIONS[name]('  -- nothing\n'), SELECT_REQUIRED, name);
    });
    assert.equal(isLockingRead('UPDATE users SET name = :name'), false);
    assert.equal(checkOneStatement('UPDATE users SET name = :name'), undefined);
  });

  test('refuses OFFSET ... ROWS and FETCH wherever it writes into the statement, and in the checks of a SELECT', () => {
    const statements = [
      'SELECT id FROM t ORDER BY id FETCH FIRST 5 ROWS ONLY',
      'SELECT id FROM t ORDER BY id OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY',
      'SELECT id FROM t ORDER BY id OFFSET 5 ROWS',
      'SELECT id FROM t OFFSET :offset ROW',
      'SELECT a FROM t UNION SELECT a FROM u ORDER BY a FETCH FIRST 1 ROWS WITH TIES',
    ];

    statements.forEach((sql) => {
      PAGE_EDITORS.forEach((name) => assert.throws(() => FUNCTIONS[name](sql), FETCH_REFUSED, `${name}: ${sql}`));
      assert.equal(isSelect(sql), true);
      assert.equal(isLockingRead(sql), false);
      assert.doesNotThrow(() => requiresDerivedTable(sql));
    });
  });

  test('takes an OFFSET inside LIMIT, a dotted and a quoted offset, and a FETCH inside parentheses for no standard offset', () => {
    assert.equal(page('SELECT id FROM t LIMIT 5 OFFSET 10'), `SELECT id FROM t LIMIT ${PAGE}`);
    assert.equal(page('SELECT id FROM t LIMIT 5 OFFSET 10 ROWS EXAMINED 100'), `SELECT id FROM t LIMIT ${PAGE}`);
    assert.equal(order('SELECT t.offset FROM t ORDER BY t.offset'), `SELECT t.offset FROM t ORDER BY ${ORDER_BY}`);
    assert.equal(order('SELECT `offset` FROM t'), `SELECT \`offset\` FROM t ORDER BY ${ORDER_BY}`);
    assert.equal(
      buildCountSql('SELECT * FROM (SELECT id FROM t ORDER BY id OFFSET 5 ROWS FETCH FIRST 5 ROWS ONLY) d'),
      'SELECT COUNT(*) AS total FROM (SELECT * FROM (SELECT id FROM t ORDER BY id OFFSET 5 ROWS FETCH FIRST 5 ROWS ONLY) d) q',
    );
  });

  test('refuses an OFFSET ... ROWS without FETCH inside the parentheses of a single query and around a set operation, wherever it writes into the statement, and in the checks of a SELECT', () => {
    [
      '(SELECT a FROM t OFFSET 1 ROWS)',
      '(SELECT a FROM t ORDER BY a OFFSET 1 ROWS)',
      '((SELECT a FROM t OFFSET 1 ROWS)) LIMIT 2',
      '((SELECT a FROM t ORDER BY a) OFFSET 1 ROWS)',
      'WITH g AS (SELECT a FROM t) (SELECT a FROM g OFFSET 2 ROWS)',
      '((SELECT a FROM t) UNION ALL (SELECT b FROM u) OFFSET 1 ROWS)',
      '(((SELECT a FROM t) UNION ALL (SELECT b FROM u) LIMIT 9) OFFSET 1 ROWS)',
      '(((SELECT a FROM t) UNION ALL (SELECT b FROM u) ORDER BY a LIMIT 9) OFFSET 1 ROWS)',
    ].forEach((sql) => {
      PAGE_EDITORS.forEach((name) => assert.throws(
        () => FUNCTIONS[name](sql),
        { name: 'TypeError', message: `${EDITOR_SIGNATURES[name]} ${INNER_OFFSET_MESSAGE}` },
        `${name}: ${sql}`,
      ));
      assert.equal(isSelect(sql), true, sql);
      assert.equal(isLockingRead(sql), false, sql);
      assert.equal(requiresDerivedTable(sql), true, sql);
    });
  });

  test('takes an OFFSET ... ROWS without FETCH in a branch of a set operation, and one with a FETCH, inside a LIMIT or in a subquery', () => {
    [
      '(SELECT a FROM t ORDER BY a OFFSET 1 ROWS) UNION ALL (SELECT b FROM u)',
      '(SELECT a FROM t OFFSET 1 ROWS) EXCEPT (SELECT 3)',
      '(SELECT a FROM t OFFSET 1 ROWS) INTERSECT (SELECT a FROM u)',
      'WITH c AS (SELECT 1) (SELECT a FROM t OFFSET 1 ROWS) UNION ALL (SELECT 10)',
      '((SELECT a FROM t OFFSET 1 ROWS) UNION ALL (SELECT b FROM u))',
      '(SELECT a FROM t ORDER BY a OFFSET 1 ROWS FETCH FIRST 2 ROWS ONLY)',
      '(SELECT a FROM t LIMIT 2 OFFSET 1)',
      '(SELECT a FROM t WHERE a IN (SELECT b FROM u ORDER BY b OFFSET 1 ROWS))',
    ].forEach((sql) => {
      assert.equal(order(sql), `${sql} ORDER BY ${ORDER_BY}`, sql);
      assert.equal(page(sql), `${sql} LIMIT ${PAGE}`, sql);
      assert.equal(wrapSelect(sql), `SELECT * FROM (${sql}) q`, sql);
      assert.equal(buildCountSql(sql), `SELECT COUNT(*) AS total FROM (${sql}) q`, sql);
      SELECT_CHECKS.forEach((name) => assert.equal(FUNCTIONS[name](sql), undefined, `${name}: ${sql}`));
    });
  });
});

describe('isSelect', () => {
  test('tells a SELECT by its first word, in any case, past comments and the parentheses of a query expression', () => {
    [
      'SELECT 1',
      'select id from users',
      '\n  SELECT 1',
      '-- report\nSELECT 1',
      '/* report */ SELECT 1',
      '# report\nSELECT 1',
      '(SELECT 1)',
      '((SELECT 1)) UNION (SELECT 2)',
      'SELECT 1 FOR UPDATE',
    ].forEach((sql) => assert.equal(isSelect(sql), true, sql));
  });

  test('takes WITH for a SELECT when the first statement keyword on its level is SELECT', () => {
    [
      'WITH c AS (SELECT 1 AS a) SELECT a FROM c',
      'with c as (select 1 as a) select a from c',
      'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT n FROM c',
      'WITH a AS (DELETE FROM t RETURNING id), b AS (SELECT 2) SELECT * FROM a, b',
      '(WITH c AS (SELECT 1 AS a) SELECT a FROM c) UNION (SELECT 2)',
    ].forEach((sql) => assert.equal(isSelect(sql), true, sql));
  });

  test('takes WITH before any other statement keyword, or before none, for no SELECT', () => {
    [
      'WITH c AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM c)',
      'WITH c AS (SELECT 1) UPDATE t SET a = 1',
      'WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c',
      'WITH c AS (SELECT 1) REPLACE INTO t SELECT * FROM c',
      'WITH c AS (SELECT 1) VALUES (1)',
      'WITH c AS (SELECT 1) TABLE c',
      'WITH c AS (SELECT 1)',
    ].forEach((sql) => assert.equal(isSelect(sql), false, sql));
  });

  test('takes WITH for a SELECT when its query stands in parentheses after the last body or RESTRICT and starts with SELECT', () => {
    [
      WITH_QUERY_SQL,
      'WITH g AS (SELECT slug FROM groups) (SELECT slug FROM g)',
      'with g as (select slug from groups) (select slug from g)',
      'WITH g AS (SELECT slug FROM groups) ((SELECT slug FROM g))',
      'WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS x) (SELECT x FROM a) UNION (SELECT x FROM b)',
      'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) CYCLE n RESTRICT (SELECT n FROM c)',
      'WITH c (a, b) AS (SELECT 1, 2), d AS (SELECT 3 AS x) (SELECT a, b FROM c) UNION (SELECT x, x FROM d)',
      'WITH g AS (SELECT slug FROM groups) /* query */ (SELECT slug FROM g)',
    ].forEach((sql) => assert.equal(isSelect(sql), true, sql));
  });

  test('takes neither the column list nor the body of a common table expression for its query, and no WITH inside the parentheses of the query', () => {
    [
      'WITH c (a) AS (SELECT 1) UPDATE t SET a = 1',
      'WITH c (a) AS (SELECT 1) DELETE FROM t WHERE a IN (SELECT a FROM c)',
      'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) CYCLE n RESTRICT DELETE FROM t',
      'WITH c AS (SELECT 1) (VALUES (1))',
      'WITH a AS (SELECT 1 AS x) (WITH b AS (SELECT 2 AS y) SELECT y FROM b)',
    ].forEach((sql) => assert.equal(isSelect(sql), false, sql));
  });

  test('takes every other statement for no SELECT, whatever it holds', () => {
    [
      'INSERT INTO t SELECT * FROM u',
      'UPDATE t SET a = (SELECT 1)',
      'DELETE FROM t WHERE id IN (SELECT id FROM u)',
      'REPLACE INTO t VALUES (1)',
      'VALUES (1), (2)',
      'TABLE t',
      'EXPLAIN SELECT 1',
      'CALL report()',
      "'SELECT'",
      '`select` FROM t',
      'select.id',
      'SELECTED',
      ' ',
      '-- SELECT 1\n',
      '/* SELECT 1 */',
    ].forEach((sql) => assert.equal(isSelect(sql), false, sql));
  });
});

describe('requiresDerivedTable', () => {
  test('is false for a single query with a FROM: a condition goes into its WHERE', () => {
    [
      'SELECT id FROM users WHERE is_active = 1 ORDER BY id LIMIT 5',
      'SELECT COUNT(*) FROM users',
      'SELECT u.id FROM users u JOIN groups g ON g.id = u.group_id',
      'SELECT * FROM t FOR UPDATE',
      'SELECT 1 FROM DUAL',
      'SELECT id INTO @id FROM users LIMIT 1',
    ].forEach((sql) => assert.equal(requiresDerivedTable(sql), false, sql));
  });

  test('is true for a query expression, a grouping, a window and a query without FROM', () => {
    [
      '(SELECT id FROM t)',
      '(SELECT id FROM t) ORDER BY id',
      'WITH c AS (SELECT id FROM t) SELECT id FROM c',
      'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT n FROM c',
      WITH_QUERY_SQL,
      'WITH g AS (SELECT slug FROM groups) (SELECT slug FROM g)',
      'SELECT a FROM t UNION SELECT a FROM u',
      'SELECT a FROM t UNION ALL SELECT a FROM u',
      'SELECT a FROM t EXCEPT SELECT a FROM u',
      'SELECT a FROM t INTERSECT SELECT a FROM u',
      'SELECT status, COUNT(*) FROM users GROUP BY status',
      'SELECT status FROM users GROUP BY status WITH ROLLUP',
      'SELECT a FROM t HAVING a > 1',
      'SELECT id FROM t WINDOW w AS (ORDER BY id)',
      'SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n FROM t',
      'SELECT id, SUM(a) OVER w AS s FROM t WINDOW w AS (PARTITION BY b)',
      'SELECT DISTINCT status FROM users',
      'SELECT DISTINCTROW status FROM users',
      'SELECT 1',
      'SELECT 1 WHERE 1 = 1',
      'SELECT EXTRACT(YEAR FROM d) AS y',
    ].forEach((sql) => assert.equal(requiresDerivedTable(sql), true, sql));
  });

  test('looks past what parentheses, quotes and dotted names hold', () => {
    [
      'SELECT id FROM t WHERE id IN (SELECT user_id FROM u GROUP BY user_id HAVING COUNT(*) > 1)',
      'SELECT id FROM t WHERE EXISTS (SELECT 1 FROM u UNION SELECT 2)',
      'SELECT COUNT(DISTINCT a) FROM t',
      'SELECT GROUP_CONCAT(DISTINCT a ORDER BY a SEPARATOR \',\') FROM t',
      'SELECT (SELECT MAX(n) OVER () FROM u LIMIT 1) AS m FROM t',
      "SELECT * FROM t WHERE a = 'UNION' AND b = 'GROUP BY'",
      'SELECT `group`, `distinct` FROM `union`',
      'SELECT r.group, r.window FROM rules r',
      'SELECT * FROM t USE INDEX FOR GROUP BY (i)',
      'SELECT * FROM t FORCE INDEX FOR ORDER BY (i) ORDER BY a',
      'SELECT * FROM t FOR SYSTEM_TIME FROM \'2026-01-01\' TO \'2026-02-01\'',
    ].forEach((sql) => assert.equal(requiresDerivedTable(sql), false, sql));
  });

  test('takes a column named window for a column: the word is not reserved', () => {
    assert.equal(requiresDerivedTable('SELECT window FROM t WHERE window > 1 ORDER BY window'), false);
    assert.equal(requiresDerivedTable('SELECT window FROM t WINDOW w AS (ORDER BY window)'), true);
    assert.equal(requiresDerivedTable('SELECT id FROM t WINDOW `w` AS (ORDER BY id)'), true);
  });
});

describe('isLockingRead', () => {
  test('finds FOR UPDATE and LOCK IN SHARE MODE of the statement', () => {
    [
      'SELECT * FROM t WHERE id = 1 FOR UPDATE',
      'SELECT * FROM t WHERE id = 1 for update',
      'SELECT * FROM t WHERE id = 1 FOR UPDATE NOWAIT',
      'SELECT * FROM t WHERE id = 1 FOR UPDATE SKIP LOCKED',
      'SELECT * FROM t ORDER BY id LIMIT 1 FOR UPDATE WAIT 5',
      'SELECT * FROM t WHERE id = 1 LOCK IN SHARE MODE',
      'SELECT id FROM t LIMIT 1 FOR UPDATE INTO @id',
      'SELECT id FROM t LIMIT 1 INTO @id FOR UPDATE',
      'SELECT a FROM t UNION SELECT a FROM u FOR UPDATE',
      'SELECT * FROM t /* lock */ FOR -- row\n UPDATE',
    ].forEach((sql) => assert.equal(isLockingRead(sql), true, sql));
  });

  test('takes a hint, FOR SYSTEM_TIME, a literal and a lock of a subquery for no locking read of the statement', () => {
    [
      'SELECT * FROM t',
      'SELECT * FROM t FOR SYSTEM_TIME AS OF TIMESTAMP \'2026-01-01 00:00:00\'',
      'SELECT * FROM t FOR SYSTEM_TIME ALL WHERE id > 0',
      'SELECT * FROM t USE INDEX FOR ORDER BY (i) ORDER BY a',
      'SELECT * FROM t IGNORE INDEX FOR JOIN (i) JOIN u USING (id)',
      "SELECT 'FOR UPDATE', `lock in share mode`",
      'SELECT * FROM t WHERE id IN (SELECT id FROM u FOR UPDATE)',
      'SELECT SUBSTRING(s FROM 1 FOR 2), GET_LOCK(\'a\', 1) FROM t',
      'SELECT NEXT VALUE FOR sequence_id',
      'SELECT r.lock, r.for FROM rules r',
    ].forEach((sql) => assert.equal(isLockingRead(sql), false, sql));
  });
});

describe('appendToWhere', () => {
  test('adds a WHERE to a statement that has none', () => {
    assert.equal(where('SELECT id FROM users'), 'SELECT id FROM users WHERE x = :x');
    assert.equal(where('SELECT u.id FROM users u JOIN groups g ON g.id = u.group_id'), 'SELECT u.id FROM users u JOIN groups g ON g.id = u.group_id WHERE x = :x');
  });

  test('puts the WHERE that is there into parentheses whole: "a OR b" keeps both branches filtered', () => {
    assert.equal(where('SELECT id FROM users WHERE a = 1 OR b = 2'), 'SELECT id FROM users WHERE (a = 1 OR b = 2) AND (x = :x)');
    assert.equal(
      appendToWhere('SELECT id FROM users WHERE a = :a OR b = :b', 'c = :c OR d = :d'),
      'SELECT id FROM users WHERE (a = :a OR b = :b) AND (c = :c OR d = :d)',
    );
  });

  test('ends the WHERE that is there with its last character, also a number or an operator the lexer passes over', () => {
    assert.equal(where('SELECT id FROM users WHERE age > 18'), 'SELECT id FROM users WHERE (age > 18) AND (x = :x)');
    assert.equal(where('SELECT id FROM users WHERE age > 18 ORDER BY id'), 'SELECT id FROM users WHERE (age > 18) AND (x = :x) ORDER BY id');
    assert.equal(where('SELECT id FROM users WHERE id = @last'), 'SELECT id FROM users WHERE (id = @last) AND (x = :x)');
    assert.equal(where('SELECT id FROM users WHERE a = .5'), 'SELECT id FROM users WHERE (a = .5) AND (x = :x)');
  });

  test('inserts a WHERE before the first clause after FROM, and ends one that is there at that clause', () => {
    [
      ['GROUP BY a', 'GROUP BY a'],
      ['HAVING a > 1', 'HAVING a > 1'],
      ['WINDOW w AS (ORDER BY a)', 'WINDOW w AS (ORDER BY a)'],
      ['ORDER BY a', 'ORDER BY a'],
      ['LIMIT 1', 'LIMIT 1'],
      ['PROCEDURE ANALYSE()', 'PROCEDURE ANALYSE()'],
      ['INTO @a', 'INTO @a'],
      ['FOR UPDATE', 'FOR UPDATE'],
      ['LOCK IN SHARE MODE', 'LOCK IN SHARE MODE'],
      ['GROUP BY a HAVING a > 1 ORDER BY a LIMIT 1 FOR UPDATE', 'GROUP BY a HAVING a > 1 ORDER BY a LIMIT 1 FOR UPDATE'],
    ].forEach(([clause]) => {
      assert.equal(where(`SELECT a FROM t ${clause}`), `SELECT a FROM t WHERE x = :x ${clause}`, clause);
      assert.equal(where(`SELECT a FROM t WHERE b = 2 ${clause}`), `SELECT a FROM t WHERE (b = 2) AND (x = :x) ${clause}`, clause);
    });
  });

  test('keeps the case and the blanks of the statement', () => {
    assert.equal(where('select a\n  from t\n  where b = 2\n  order by a\n'), 'select a\n  from t\n  where (b = 2) AND (x = :x)\n  order by a\n');
    assert.equal(where('SELECT a FROM t WHERE\n    b = 2\n    AND c = 3\n'), 'SELECT a FROM t WHERE\n    (b = 2\n    AND c = 3) AND (x = :x)\n');
    assert.equal(where('SELECT a FROM t  \n'), 'SELECT a FROM t WHERE x = :x  \n');
  });

  test('reads the clauses of a query without FROM after its SELECT', () => {
    assert.equal(where('SELECT 1'), 'SELECT 1 WHERE x = :x');
    assert.equal(where('SELECT 1 WHERE 1 = 1'), 'SELECT 1 WHERE (1 = 1) AND (x = :x)');
    assert.equal(where('SELECT 1 LIMIT 1'), 'SELECT 1 WHERE x = :x LIMIT 1');
    assert.equal(where('SELECT 1 INTO @a'), 'SELECT 1 WHERE x = :x INTO @a');
  });

  test('passes over an INTO that stands before FROM', () => {
    assert.equal(where('SELECT id INTO @id FROM users LIMIT 1'), 'SELECT id INTO @id FROM users WHERE x = :x LIMIT 1');
    assert.equal(where('SELECT id INTO @id FROM users WHERE a = 1 LIMIT 1'), 'SELECT id INTO @id FROM users WHERE (a = 1) AND (x = :x) LIMIT 1');
  });

  test('looks past the clauses of subqueries, derived tables, OVER and the arguments of functions', () => {
    assert.equal(
      where('SELECT id, (SELECT COUNT(*) FROM g WHERE g.user_id = u.id GROUP BY g.kind ORDER BY 1 LIMIT 1) AS n FROM users u'),
      'SELECT id, (SELECT COUNT(*) FROM g WHERE g.user_id = u.id GROUP BY g.kind ORDER BY 1 LIMIT 1) AS n FROM users u WHERE x = :x',
    );
    assert.equal(
      where('SELECT * FROM (SELECT id FROM t WHERE a = 1 ORDER BY id LIMIT 5) d ORDER BY id'),
      'SELECT * FROM (SELECT id FROM t WHERE a = 1 ORDER BY id LIMIT 5) d WHERE x = :x ORDER BY id',
    );
    assert.equal(
      where('SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE b = 1 UNION SELECT id FROM v) ORDER BY id'),
      'SELECT * FROM t WHERE (id IN (SELECT id FROM u WHERE b = 1 UNION SELECT id FROM v)) AND (x = :x) ORDER BY id',
    );
    assert.equal(
      where('SELECT EXTRACT(YEAR FROM d) AS y, SUBSTRING(s FROM 1 FOR 2) AS p, TRIM(LEADING \'0\' FROM c) AS c FROM t'),
      'SELECT EXTRACT(YEAR FROM d) AS y, SUBSTRING(s FROM 1 FOR 2) AS p, TRIM(LEADING \'0\' FROM c) AS c FROM t WHERE x = :x',
    );
    assert.equal(
      where('SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS n, GROUP_CONCAT(c ORDER BY c LIMIT 3) AS cs FROM t'),
      'SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS n, GROUP_CONCAT(c ORDER BY c LIMIT 3) AS cs FROM t WHERE x = :x',
    );
    assert.equal(
      where('SELECT * FROM (WITH c AS (SELECT 1 AS a) SELECT a FROM c UNION SELECT 2) d'),
      'SELECT * FROM (WITH c AS (SELECT 1 AS a) SELECT a FROM c UNION SELECT 2) d WHERE x = :x',
    );
  });

  test('passes over index hints and FOR SYSTEM_TIME inside FROM', () => {
    assert.equal(where('SELECT * FROM t USE INDEX FOR ORDER BY (i) ORDER BY a'), 'SELECT * FROM t USE INDEX FOR ORDER BY (i) WHERE x = :x ORDER BY a');
    assert.equal(where('SELECT a FROM t FORCE INDEX FOR GROUP BY (i) GROUP BY a'), 'SELECT a FROM t FORCE INDEX FOR GROUP BY (i) WHERE x = :x GROUP BY a');
    assert.equal(where('SELECT * FROM t IGNORE INDEX FOR JOIN (i) JOIN u USING (id)'), 'SELECT * FROM t IGNORE INDEX FOR JOIN (i) JOIN u USING (id) WHERE x = :x');
    assert.equal(
      where("SELECT * FROM t FOR SYSTEM_TIME AS OF TIMESTAMP '2026-01-01 00:00:00' ORDER BY id"),
      "SELECT * FROM t FOR SYSTEM_TIME AS OF TIMESTAMP '2026-01-01 00:00:00' WHERE x = :x ORDER BY id",
    );
    assert.equal(
      where("SELECT * FROM t FOR SYSTEM_TIME FROM '2026-01-01' TO '2026-02-01'"),
      "SELECT * FROM t FOR SYSTEM_TIME FROM '2026-01-01' TO '2026-02-01' WHERE x = :x",
    );
    assert.equal(where('SELECT * FROM t FOR SYSTEM_TIME ALL WHERE id > 0 FOR UPDATE'), 'SELECT * FROM t FOR SYSTEM_TIME ALL WHERE (id > 0) AND (x = :x) FOR UPDATE');
  });

  test('takes a dotted name, a quoted name and a literal for no keyword', () => {
    assert.equal(
      where('SELECT r.limit, r.order FROM rules r WHERE r.group = 1 ORDER BY r.order'),
      'SELECT r.limit, r.order FROM rules r WHERE (r.group = 1) AND (x = :x) ORDER BY r.order',
    );
    assert.equal(where('SELECT order.id FROM `order` ORDER BY order.id'), 'SELECT order.id FROM `order` WHERE x = :x ORDER BY order.id');
    assert.equal(
      where("SELECT `limit` FROM `order` WHERE `where` = 'ORDER BY' AND note <> \"LIMIT 1\" ORDER BY `limit`"),
      "SELECT `limit` FROM `order` WHERE (`where` = 'ORDER BY' AND note <> \"LIMIT 1\") AND (x = :x) ORDER BY `limit`",
    );
  });

  test('takes a column named window for a column and WINDOW <name> AS (...) for the clause', () => {
    assert.equal(where('SELECT window FROM t WHERE window > 1 ORDER BY window'), 'SELECT window FROM t WHERE (window > 1) AND (x = :x) ORDER BY window');
    assert.equal(
      where('SELECT window, ROW_NUMBER() OVER w AS n FROM t WHERE window > 1 WINDOW w AS (ORDER BY window)'),
      'SELECT window, ROW_NUMBER() OVER w AS n FROM t WHERE (window > 1) AND (x = :x) WINDOW w AS (ORDER BY window)',
    );
    assert.equal(where('SELECT id FROM t WINDOW `w` AS (ORDER BY id)'), 'SELECT id FROM t WHERE x = :x WINDOW `w` AS (ORDER BY id)');
  });

  test('keeps a literal that ends with a backslash whole', () => {
    assert.equal(
      where("SELECT * FROM t WHERE note = 'abc\\\\' ORDER BY id"),
      "SELECT * FROM t WHERE (note = 'abc\\\\') AND (x = :x) ORDER BY id",
    );
    assert.equal(
      where("SELECT * FROM t WHERE note = 'abc\\\\'"),
      "SELECT * FROM t WHERE (note = 'abc\\\\') AND (x = :x)",
    );
    assert.equal(
      where("SELECT * FROM t WHERE note = 'it\\'s ORDER BY' LIMIT 1"),
      "SELECT * FROM t WHERE (note = 'it\\'s ORDER BY') AND (x = :x) LIMIT 1",
    );
  });

  test('puts the condition ahead of a comment at the end of the statement', () => {
    assert.equal(where('SELECT id FROM users -- all of them'), 'SELECT id FROM users WHERE x = :x -- all of them');
    assert.equal(where('SELECT id FROM users # all of them'), 'SELECT id FROM users WHERE x = :x # all of them');
    assert.equal(where('SELECT id FROM users /* all */'), 'SELECT id FROM users WHERE x = :x /* all */');
    assert.equal(where('SELECT id FROM users -- one\n# two  \n/* three */\n'), 'SELECT id FROM users WHERE x = :x -- one\n# two  \n/* three */\n');
    assert.equal(where('SELECT id FROM users WHERE a = 1 -- active'), 'SELECT id FROM users WHERE (a = 1) AND (x = :x) -- active');
    assert.equal(where('SELECT id FROM users WHERE a = 1-- active'), 'SELECT id FROM users WHERE (a = 1) AND (x = :x) -- active');
  });

  test('keeps what it writes apart from the text it meets where the statement has no blank', () => {
    assert.equal(where('SELECT a FROM t USE INDEX (i)ORDER BY a'), 'SELECT a FROM t USE INDEX (i) WHERE x = :x ORDER BY a');
    assert.equal(where('SELECT a FROM t WHERE b > 0.5ORDER BY a'), 'SELECT a FROM t WHERE (b > 0.5) AND (x = :x) ORDER BY a');
    assert.equal(where('SELECT a FROM `t`/* all */LIMIT 1'), 'SELECT a FROM `t`/* all */ WHERE x = :x LIMIT 1');
    assert.equal(where('SELECT a FROM t WHERE(b = 1)'), 'SELECT a FROM t WHERE ((b = 1)) AND (x = :x)');
  });

  test('puts the condition ahead of a comment before the next clause, and keeps the comments inside it', () => {
    assert.equal(where('SELECT id FROM users -- all\nORDER BY id'), 'SELECT id FROM users -- all\nWHERE x = :x ORDER BY id');
    assert.equal(where('SELECT id FROM users WHERE a = 1 -- active\nORDER BY id'), 'SELECT id FROM users WHERE (a = 1) AND (x = :x) -- active\nORDER BY id');
    assert.equal(where('SELECT id FROM users WHERE a = 1 /* active */ORDER BY id'), 'SELECT id FROM users WHERE (a = 1) AND (x = :x) /* active */ORDER BY id');
    assert.equal(where('SELECT id FROM users WHERE /* c */ a = 1 -- first\n OR b = 2 # second\nLIMIT 1'), 'SELECT id FROM users WHERE (/* c */ a = 1 -- first\n OR b = 2) AND (x = :x) # second\nLIMIT 1');
    assert.equal(where('SELECT id FROM users WHERE -- why\n a = 1'), 'SELECT id FROM users WHERE (-- why\n a = 1) AND (x = :x)');
  });

  test('takes the condition as one piece: it ends with its code and reads as SQL on its own', () => {
    assert.equal(appendToWhere('SELECT id FROM t ORDER BY id', 'a = 1 -- note'), 'SELECT id FROM t WHERE a = 1 ORDER BY id');
    assert.equal(appendToWhere('SELECT id FROM t WHERE b = 2', '  a = 1 /* note */\n'), 'SELECT id FROM t WHERE (b = 2) AND (a = 1)');
    assert.equal(appendToWhere('SELECT id FROM t', 'TRUE'), 'SELECT id FROM t WHERE TRUE');
    assert.equal(appendToWhere('SELECT id FROM t', '1'), 'SELECT id FROM t WHERE 1');
    assert.throws(() => appendToWhere('SELECT id FROM t', ''), /requires condition to be a non-empty string/);
    assert.throws(() => appendToWhere('SELECT id FROM t'), TypeError);
    assert.throws(() => appendToWhere('SELECT id FROM t', { status: 'active' }), TypeError);
    assert.throws(() => appendToWhere('SELECT id FROM t', '   '), /requires condition to hold SQL, not only blanks and comments/);
    assert.throws(() => appendToWhere('SELECT id FROM t', '-- nothing'), TypeError);
    assert.throws(() => appendToWhere('SELECT id FROM t', 'a = 1; DROP TABLE t'), /takes condition without a semicolon/);
    assert.throws(() => appendToWhere('SELECT id FROM t WHERE b = 2', 'a = 1) OR (1 = 1'), /a closing parenthesis without an opening one/);
    assert.throws(() => appendToWhere('SELECT id FROM t', "a = 'x"), SyntaxError);
  });

  test('refuses a query expression: its rows are filtered from outside, in a derived table', () => {
    [
      '(SELECT id FROM t)',
      '(SELECT id FROM t) UNION (SELECT id FROM u)',
      'WITH c AS (SELECT id FROM t) SELECT id FROM c',
      WITH_QUERY_SQL,
      'SELECT a FROM t UNION SELECT a FROM u',
      'SELECT a FROM t UNION ALL SELECT a FROM u WHERE b = 1',
      'SELECT a FROM t EXCEPT SELECT a FROM u',
      'SELECT a FROM t INTERSECT SELECT a FROM u',
    ].forEach((sql) => assert.throws(() => where(sql), QUERY_EXPRESSION_REFUSED, sql));
  });

  test('filters a wrapped statement by the columns of its rows', () => {
    assert.equal(
      where(wrapSelect('SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY n DESC LIMIT 5')),
      'SELECT * FROM (SELECT status, COUNT(*) AS n FROM users GROUP BY status) q WHERE x = :x ORDER BY n DESC LIMIT 5',
    );
  });
});

describe('replaceOrderBy', () => {
  test('adds an ORDER BY to a statement that has none', () => {
    assert.equal(order('SELECT id FROM users WHERE a = 1'), `SELECT id FROM users WHERE a = 1 ORDER BY ${ORDER_BY}`);
    assert.equal(order('SELECT status FROM users GROUP BY status HAVING COUNT(*) > 1'), `SELECT status FROM users GROUP BY status HAVING COUNT(*) > 1 ORDER BY ${ORDER_BY}`);
    assert.equal(order('SELECT id FROM t WINDOW w AS (ORDER BY id)'), `SELECT id FROM t WINDOW w AS (ORDER BY id) ORDER BY ${ORDER_BY}`);
  });

  test('replaces the ORDER BY that is there, up to the clause after it', () => {
    [
      ['', ''],
      [' LIMIT 10', ' LIMIT 10'],
      [' LIMIT 10 OFFSET 20 FOR UPDATE', ' LIMIT 10 OFFSET 20 FOR UPDATE'],
      [' PROCEDURE ANALYSE()', ' PROCEDURE ANALYSE()'],
      [' INTO @a', ' INTO @a'],
      [' FOR UPDATE SKIP LOCKED', ' FOR UPDATE SKIP LOCKED'],
      [' LOCK IN SHARE MODE', ' LOCK IN SHARE MODE'],
    ].forEach(([rest]) => {
      assert.equal(order(`SELECT id FROM t ORDER BY name, id${rest}`), `SELECT id FROM t ORDER BY ${ORDER_BY}${rest}`, rest);
      assert.equal(order(`SELECT id FROM t ORDER BY 2 DESC, 1${rest}`), `SELECT id FROM t ORDER BY ${ORDER_BY}${rest}`, rest);
    });
  });

  test('inserts an ORDER BY before LIMIT, PROCEDURE, INTO and a locking clause', () => {
    [
      'LIMIT 10',
      'LIMIT 10, 20 FOR UPDATE',
      'PROCEDURE ANALYSE()',
      'INTO @a',
      'FOR UPDATE NOWAIT',
      'LOCK IN SHARE MODE',
    ].forEach((clause) => {
      assert.equal(order(`SELECT id FROM t WHERE a = 1 ${clause}`), `SELECT id FROM t WHERE a = 1 ORDER BY ${ORDER_BY} ${clause}`, clause);
    });
  });

  test('keeps the case and the blanks of the statement', () => {
    assert.equal(order('select id\n  from t\n  order by name\n  limit 5\n'), `select id\n  from t\n  ORDER BY ${ORDER_BY}\n  limit 5\n`);
  });

  test('orders the whole of a set operation after its last query', () => {
    assert.equal(order('SELECT a FROM t UNION SELECT a FROM u'), `SELECT a FROM t UNION SELECT a FROM u ORDER BY ${ORDER_BY}`);
    assert.equal(order('SELECT a FROM t UNION ALL SELECT a FROM u ORDER BY a LIMIT 5'), `SELECT a FROM t UNION ALL SELECT a FROM u ORDER BY ${ORDER_BY} LIMIT 5`);
    assert.equal(order('SELECT a FROM t EXCEPT SELECT a FROM u WHERE b = 1 LIMIT 5'), `SELECT a FROM t EXCEPT SELECT a FROM u WHERE b = 1 ORDER BY ${ORDER_BY} LIMIT 5`);
    assert.equal(
      order('(SELECT a FROM t ORDER BY a LIMIT 3) UNION (SELECT a FROM u ORDER BY a LIMIT 3)'),
      `(SELECT a FROM t ORDER BY a LIMIT 3) UNION (SELECT a FROM u ORDER BY a LIMIT 3) ORDER BY ${ORDER_BY}`,
    );
    assert.equal(
      order('(SELECT a FROM t ORDER BY a LIMIT 3) UNION (SELECT a FROM u) ORDER BY a LIMIT 5'),
      `(SELECT a FROM t ORDER BY a LIMIT 3) UNION (SELECT a FROM u) ORDER BY ${ORDER_BY} LIMIT 5`,
    );
    assert.equal(order('SELECT a FROM t UNION (SELECT a FROM u ORDER BY a LIMIT 3)'), `SELECT a FROM t UNION (SELECT a FROM u ORDER BY a LIMIT 3) ORDER BY ${ORDER_BY}`);
  });

  test('orders a query in parentheses and one led by WITH from outside their parentheses', () => {
    assert.equal(order('(SELECT a FROM t ORDER BY a LIMIT 5)'), `(SELECT a FROM t ORDER BY a LIMIT 5) ORDER BY ${ORDER_BY}`);
    assert.equal(
      order('WITH c AS (SELECT a FROM t ORDER BY a LIMIT 5) SELECT a FROM c ORDER BY a'),
      `WITH c AS (SELECT a FROM t ORDER BY a LIMIT 5) SELECT a FROM c ORDER BY ${ORDER_BY}`,
    );
    assert.equal(
      order('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3 ORDER BY n) SELECT n FROM c LIMIT 2'),
      `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3 ORDER BY n) SELECT n FROM c ORDER BY ${ORDER_BY} LIMIT 2`,
    );
    assert.equal(order(WITH_QUERY_SQL), `${WITH_QUERY_SQL} ORDER BY ${ORDER_BY}`);
    assert.equal(
      order('WITH g AS (SELECT slug FROM groups) (SELECT slug FROM g ORDER BY slug LIMIT 3) ORDER BY slug LIMIT 2'),
      `WITH g AS (SELECT slug FROM groups) (SELECT slug FROM g ORDER BY slug LIMIT 3) ORDER BY ${ORDER_BY} LIMIT 2`,
    );
  });

  test('looks past ORDER BY inside OVER, GROUP_CONCAT, a window, a subquery and an index hint', () => {
    assert.equal(
      order('SELECT ROW_NUMBER() OVER (ORDER BY id) AS n, GROUP_CONCAT(name ORDER BY name) AS names FROM t GROUP BY kind'),
      `SELECT ROW_NUMBER() OVER (ORDER BY id) AS n, GROUP_CONCAT(name ORDER BY name) AS names FROM t GROUP BY kind ORDER BY ${ORDER_BY}`,
    );
    assert.equal(order('SELECT * FROM (SELECT id FROM t ORDER BY id LIMIT 5) d'), `SELECT * FROM (SELECT id FROM t ORDER BY id LIMIT 5) d ORDER BY ${ORDER_BY}`);
    assert.equal(order('SELECT id FROM t USE INDEX FOR ORDER BY (i)'), `SELECT id FROM t USE INDEX FOR ORDER BY (i) ORDER BY ${ORDER_BY}`);
    assert.equal(order('SELECT id FROM t USE INDEX FOR ORDER BY (i) ORDER BY id'), `SELECT id FROM t USE INDEX FOR ORDER BY (i) ORDER BY ${ORDER_BY}`);
  });

  test('takes a dotted name, a quoted name and a literal for no keyword', () => {
    assert.equal(order('SELECT r.order FROM rules r ORDER BY r.order'), `SELECT r.order FROM rules r ORDER BY ${ORDER_BY}`);
    assert.equal(order('SELECT order.id FROM `order` ORDER BY order.id LIMIT 1'), `SELECT order.id FROM \`order\` ORDER BY ${ORDER_BY} LIMIT 1`);
    assert.equal(order("SELECT 'ORDER BY a LIMIT 1' AS `order by`"), `SELECT 'ORDER BY a LIMIT 1' AS \`order by\` ORDER BY ${ORDER_BY}`);
    assert.equal(order("SELECT id FROM t WHERE note = 'abc\\\\'"), `SELECT id FROM t WHERE note = 'abc\\\\' ORDER BY ${ORDER_BY}`);
  });

  test('reads the clauses of a query without FROM after its SELECT, and passes over an INTO before FROM', () => {
    assert.equal(order('SELECT 1 AS a'), `SELECT 1 AS a ORDER BY ${ORDER_BY}`);
    assert.equal(order('SELECT 1 AS a INTO @a'), `SELECT 1 AS a ORDER BY ${ORDER_BY} INTO @a`);
    assert.equal(order('SELECT id INTO @id FROM users WHERE a = 1 LIMIT 1'), `SELECT id INTO @id FROM users WHERE a = 1 ORDER BY ${ORDER_BY} LIMIT 1`);
  });

  test('keeps the comments at the cut points outside the clause', () => {
    assert.equal(order('SELECT id FROM t -- note'), `SELECT id FROM t ORDER BY ${ORDER_BY} -- note`);
    assert.equal(order('SELECT id FROM t ORDER BY name -- by name'), `SELECT id FROM t ORDER BY ${ORDER_BY} -- by name`);
    assert.equal(order('SELECT id FROM t ORDER BY name # by name\nLIMIT 5'), `SELECT id FROM t ORDER BY ${ORDER_BY} # by name\nLIMIT 5`);
    assert.equal(order('SELECT id FROM t ORDER BY name, -- first\n id /* then */ LIMIT 5'), `SELECT id FROM t ORDER BY ${ORDER_BY} /* then */ LIMIT 5`);
    assert.equal(order('SELECT id FROM t /* all */ LIMIT 5'), `SELECT id FROM t /* all */ ORDER BY ${ORDER_BY} LIMIT 5`);
    assert.equal(order('SELECT id FROM t -- all\nLIMIT 5 -- five'), `SELECT id FROM t -- all\nORDER BY ${ORDER_BY} LIMIT 5 -- five`);
  });

  test('keeps the list apart from the clause after it where the statement has no blank', () => {
    assert.equal(order('SELECT id FROM t ORDER BY (a)LIMIT 1'), `SELECT id FROM t ORDER BY ${ORDER_BY} LIMIT 1`);
    assert.equal(order("SELECT id FROM t ORDER BY 'a'/* by a */FOR UPDATE"), `SELECT id FROM t ORDER BY ${ORDER_BY} /* by a */FOR UPDATE`);
    assert.equal(order('SELECT id FROM t USE INDEX (i)LIMIT 1'), `SELECT id FROM t USE INDEX (i) ORDER BY ${ORDER_BY} LIMIT 1`);
  });

  test('takes the list as one piece', () => {
    assert.equal(replaceOrderBy('SELECT id FROM t LIMIT 5', 'name -- by name'), 'SELECT id FROM t ORDER BY name LIMIT 5');
    assert.equal(replaceOrderBy('SELECT id FROM t', '1'), 'SELECT id FROM t ORDER BY 1');
    assert.throws(() => replaceOrderBy('SELECT id FROM t', ''), /requires orderBy to be a non-empty string/);
    assert.throws(() => replaceOrderBy('SELECT id FROM t', ['id']), TypeError);
    assert.throws(() => replaceOrderBy('SELECT id FROM t', 'id; DROP TABLE t'), /takes orderBy without a semicolon/);
    assert.throws(() => replaceOrderBy('SELECT id FROM t', '/* none */'), /requires orderBy to hold SQL/);
  });
});

describe('replacePagination', () => {
  test('adds a LIMIT to a statement that has none', () => {
    assert.equal(page('SELECT id FROM users'), `SELECT id FROM users LIMIT ${PAGE}`);
    assert.equal(page('SELECT id FROM users ORDER BY id'), `SELECT id FROM users ORDER BY id LIMIT ${PAGE}`);
    assert.equal(page('SELECT 1 AS a'), `SELECT 1 AS a LIMIT ${PAGE}`);
  });

  test('replaces a LIMIT in every form', () => {
    [
      'LIMIT 10',
      'LIMIT 10, 20',
      'LIMIT 10 OFFSET 20',
      'LIMIT :limit OFFSET :offset',
      'LIMIT 10 ROWS EXAMINED 1000',
      'LIMIT ROWS EXAMINED 1000',
      'LIMIT 10 OFFSET 20 ROWS EXAMINED 1000',
      'limit 10',
    ].forEach((limit) => {
      assert.equal(page(`SELECT id FROM t ORDER BY id ${limit}`), `SELECT id FROM t ORDER BY id LIMIT ${PAGE}`, limit);
    });
  });

  test('replaces a LIMIT up to, and inserts one before, PROCEDURE, INTO and a locking clause', () => {
    ['PROCEDURE ANALYSE()', 'INTO @a', 'FOR UPDATE', 'LOCK IN SHARE MODE', 'FOR UPDATE INTO @a', 'INTO @a FOR UPDATE'].forEach((clause) => {
      assert.equal(page(`SELECT id FROM t ORDER BY id LIMIT 1 ${clause}`), `SELECT id FROM t ORDER BY id LIMIT ${PAGE} ${clause}`, clause);
      assert.equal(page(`SELECT id FROM t ORDER BY id ${clause}`), `SELECT id FROM t ORDER BY id LIMIT ${PAGE} ${clause}`, clause);
    });
  });

  test('cuts the whole of a set operation after its last query', () => {
    assert.equal(page('SELECT a FROM t UNION SELECT a FROM u LIMIT 5'), `SELECT a FROM t UNION SELECT a FROM u LIMIT ${PAGE}`);
    assert.equal(page('SELECT a FROM t UNION SELECT a FROM u ORDER BY a'), `SELECT a FROM t UNION SELECT a FROM u ORDER BY a LIMIT ${PAGE}`);
    assert.equal(
      page('(SELECT a FROM t LIMIT 1) UNION ALL (SELECT a FROM u LIMIT 1)'),
      `(SELECT a FROM t LIMIT 1) UNION ALL (SELECT a FROM u LIMIT 1) LIMIT ${PAGE}`,
    );
    assert.equal(page('(SELECT a FROM t LIMIT 1) UNION (SELECT a FROM u) LIMIT 5'), `(SELECT a FROM t LIMIT 1) UNION (SELECT a FROM u) LIMIT ${PAGE}`);
    assert.equal(page('WITH c AS (SELECT a FROM t LIMIT 5) SELECT a FROM c LIMIT 2'), `WITH c AS (SELECT a FROM t LIMIT 5) SELECT a FROM c LIMIT ${PAGE}`);
    assert.equal(page(WITH_QUERY_SQL), `${WITH_QUERY_SQL} LIMIT ${PAGE}`);
  });

  test('looks past a LIMIT inside parentheses and a dotted, quoted or literal limit', () => {
    assert.equal(page('SELECT GROUP_CONCAT(a ORDER BY a LIMIT 2) AS l FROM t'), `SELECT GROUP_CONCAT(a ORDER BY a LIMIT 2) AS l FROM t LIMIT ${PAGE}`);
    assert.equal(page('SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 3)'), `SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 3) LIMIT ${PAGE}`);
    assert.equal(page("SELECT r.limit, `limit`, 'LIMIT 1' FROM rules r"), `SELECT r.limit, \`limit\`, 'LIMIT 1' FROM rules r LIMIT ${PAGE}`);
  });

  test('reads the clauses of a query without FROM after its SELECT, and passes over an INTO before FROM', () => {
    assert.equal(page('SELECT 1 INTO @a'), `SELECT 1 LIMIT ${PAGE} INTO @a`);
    assert.equal(page('SELECT id INTO @id FROM users'), `SELECT id INTO @id FROM users LIMIT ${PAGE}`);
  });

  test('keeps the comments at the cut points outside the clause', () => {
    assert.equal(page('SELECT id FROM t ORDER BY id # sorted'), `SELECT id FROM t ORDER BY id LIMIT ${PAGE} # sorted`);
    assert.equal(page('SELECT id FROM t LIMIT 10 -- ten'), `SELECT id FROM t LIMIT ${PAGE} -- ten`);
    assert.equal(page('SELECT id FROM t LIMIT 10 /* ten */ FOR UPDATE'), `SELECT id FROM t LIMIT ${PAGE} /* ten */ FOR UPDATE`);
    assert.equal(page('SELECT id FROM t -- all\nFOR UPDATE'), `SELECT id FROM t -- all\nLIMIT ${PAGE} FOR UPDATE`);
    assert.equal(page('SELECT id FROM t LIMIT 1/* one */FOR UPDATE'), `SELECT id FROM t LIMIT ${PAGE} /* one */FOR UPDATE`);
  });

  test('takes the text after LIMIT as one piece', () => {
    assert.equal(replacePagination('SELECT id FROM t', '10'), 'SELECT id FROM t LIMIT 10');
    assert.equal(replacePagination('SELECT id FROM t FOR UPDATE', ':limit -- page'), 'SELECT id FROM t LIMIT :limit FOR UPDATE');
    assert.throws(() => replacePagination('SELECT id FROM t', ''), /requires limit to be a non-empty string/);
    assert.throws(() => replacePagination('SELECT id FROM t', 10), TypeError);
    assert.throws(() => replacePagination('SELECT id FROM t', '10;'), /takes limit without a semicolon/);
  });
});

describe('wrapSelect', () => {
  test('puts the statement into a derived table', () => {
    assert.equal(
      wrapSelect('SELECT status, COUNT(*) AS n FROM users GROUP BY status'),
      'SELECT * FROM (SELECT status, COUNT(*) AS n FROM users GROUP BY status) q',
    );
    assert.equal(wrapSelect('SELECT 1 AS a'), 'SELECT * FROM (SELECT 1 AS a) q');
    assert.equal(wrapSelect('\n  SELECT DISTINCT status\n  FROM users\n'), 'SELECT * FROM (SELECT DISTINCT status\n  FROM users) q\n');
  });

  test('moves the ORDER BY and LIMIT of the statement out of the derived table, as they are written', () => {
    assert.equal(
      wrapSelect('SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY n DESC LIMIT 5'),
      'SELECT * FROM (SELECT status, COUNT(*) AS n FROM users GROUP BY status) q ORDER BY n DESC LIMIT 5',
    );
    assert.equal(wrapSelect('SELECT DISTINCT a FROM t ORDER BY a'), 'SELECT * FROM (SELECT DISTINCT a FROM t) q ORDER BY a');
    assert.equal(wrapSelect('SELECT DISTINCT a FROM t LIMIT 5, 10'), 'SELECT * FROM (SELECT DISTINCT a FROM t) q LIMIT 5, 10');
    assert.equal(wrapSelect('select distinct a from t order  by a desc\nlimit 5'), 'SELECT * FROM (select distinct a from t) q order  by a desc\nlimit 5');
  });

  test('moves out the ORDER BY and LIMIT of a set operation and keeps those of its branches inside', () => {
    assert.equal(
      wrapSelect('SELECT a FROM t UNION SELECT a FROM u ORDER BY a LIMIT 5'),
      'SELECT * FROM (SELECT a FROM t UNION SELECT a FROM u) q ORDER BY a LIMIT 5',
    );
    assert.equal(
      wrapSelect('(SELECT a FROM t ORDER BY a LIMIT 3) UNION (SELECT a FROM u ORDER BY a LIMIT 3) ORDER BY a'),
      'SELECT * FROM ((SELECT a FROM t ORDER BY a LIMIT 3) UNION (SELECT a FROM u ORDER BY a LIMIT 3)) q ORDER BY a',
    );
    assert.equal(wrapSelect('(SELECT a FROM t ORDER BY a LIMIT 3)'), 'SELECT * FROM ((SELECT a FROM t ORDER BY a LIMIT 3)) q');
  });

  test('wraps a statement led by WITH whole, its own ORDER BY and LIMIT apart', () => {
    assert.equal(
      wrapSelect('WITH c AS (SELECT a FROM t ORDER BY a LIMIT 5) SELECT a FROM c ORDER BY a'),
      'SELECT * FROM (WITH c AS (SELECT a FROM t ORDER BY a LIMIT 5) SELECT a FROM c) q ORDER BY a',
    );
    assert.equal(
      wrapSelect('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT n FROM c'),
      'SELECT * FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT n FROM c) q',
    );
    assert.equal(wrapSelect(WITH_QUERY_SQL), `SELECT * FROM (${WITH_QUERY_SQL}) q`);
    assert.equal(
      wrapSelect('WITH g AS (SELECT slug FROM groups) (SELECT slug FROM g) ORDER BY slug LIMIT 1'),
      'SELECT * FROM (WITH g AS (SELECT slug FROM groups) (SELECT slug FROM g)) q ORDER BY slug LIMIT 1',
    );
  });

  test('looks past ORDER BY and LIMIT inside parentheses', () => {
    assert.equal(
      wrapSelect('SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n, GROUP_CONCAT(a ORDER BY a LIMIT 2) AS l FROM t GROUP BY id'),
      'SELECT * FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n, GROUP_CONCAT(a ORDER BY a LIMIT 2) AS l FROM t GROUP BY id) q',
    );
  });

  test('closes the derived table ahead of the comments at the cut points', () => {
    assert.equal(wrapSelect('SELECT a FROM t GROUP BY a -- note'), 'SELECT * FROM (SELECT a FROM t GROUP BY a) q -- note');
    assert.equal(wrapSelect('SELECT a FROM t GROUP BY a /* note */'), 'SELECT * FROM (SELECT a FROM t GROUP BY a) q /* note */');
    assert.equal(
      wrapSelect('SELECT a FROM t GROUP BY a -- note\nORDER BY a # by a\nLIMIT 5 -- five'),
      'SELECT * FROM (SELECT a FROM t GROUP BY a) q -- note\nORDER BY a # by a\nLIMIT 5 -- five',
    );
    assert.equal(wrapSelect('-- report\nSELECT DISTINCT a FROM t'), 'SELECT * FROM (-- report\nSELECT DISTINCT a FROM t) q');
    assert.equal(wrapSelect("SELECT DISTINCT a FROM t WHERE note = 'abc\\\\' -- tail"), "SELECT * FROM (SELECT DISTINCT a FROM t WHERE note = 'abc\\\\') q -- tail");
    assert.equal(wrapSelect('SELECT DISTINCT a FROM `t`ORDER BY a'), 'SELECT * FROM (SELECT DISTINCT a FROM `t`) q ORDER BY a');
    assert.equal(wrapSelect('SELECT DISTINCT a FROM t-- note'), 'SELECT * FROM (SELECT DISTINCT a FROM t) q -- note');
  });

  test('refuses what cannot stand inside a derived table', () => {
    [
      'SELECT * FROM t WHERE id = 1 FOR UPDATE',
      'SELECT * FROM t ORDER BY id LIMIT 1 LOCK IN SHARE MODE',
      'SELECT id INTO @id FROM t LIMIT 1',
      'SELECT id FROM t LIMIT 1 INTO @id',
      'SELECT id FROM t PROCEDURE ANALYSE()',
    ].forEach((sql) => {
      assert.throws(() => wrapSelect(sql), WRAP_REFUSED, sql);
      assert.throws(() => buildCountSql(sql), WRAP_REFUSED, sql);
    });
  });

  test('refuses an option the server takes in the query of a statement only, wherever that query starts', () => {
    DERIVED_TABLE_OPTIONS.forEach((option) => {
      [
        `SELECT ${option} id FROM t`,
        `SELECT ${option.toLowerCase()} id FROM t`,
        `SELECT DISTINCT STRAIGHT_JOIN ${option} id FROM t`,
        `SELECT /* hint */ ${option} id FROM t`,
        `(SELECT ${option} id FROM t) LIMIT 2`,
        `((SELECT ${option} id FROM t)) UNION (SELECT id FROM u)`,
        `WITH c AS (SELECT id FROM t) SELECT ${option} id FROM c`,
        `WITH c AS (SELECT id FROM t) (SELECT ${option} id FROM c)`,
      ].forEach((sql) => {
        const message = new RegExp(`cannot put ${option} into a derived table: the server refuses that option there, so leave it out of the statement$`);

        assert.throws(() => wrapSelect(sql), message, sql);
        assert.throws(() => buildCountSql(sql), message, sql);
      });
    });
  });

  test('takes the options the server keeps inside a derived table, and looks for the others in the query of the statement only', () => {
    [
      'SELECT ALL STRAIGHT_JOIN SQL_SMALL_RESULT SQL_BIG_RESULT id FROM t',
      'SELECT DISTINCTROW SQL_BIG_RESULT id FROM t',
      'SELECT sql_cache_hits, high_priority_count FROM t',
      'SELECT a FROM t UNION SELECT SQL_NO_CACHE a FROM u',
      'WITH c AS (SELECT SQL_NO_CACHE id FROM t) SELECT id FROM c',
      'SELECT id FROM t WHERE id IN (SELECT HIGH_PRIORITY id FROM u)',
    ].forEach((sql) => {
      assert.equal(wrapSelect(sql), `SELECT * FROM (${sql}) q`, sql);
      assert.equal(buildCountSql(sql), `SELECT COUNT(*) AS total FROM (${sql}) q`, sql);
    });
  });

  test('refuses an ORDER BY of the statement that names more than the columns of the result: it is moved out of the derived table', () => {
    [
      'SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY COUNT(*) DESC',
      'SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY count (*) DESC LIMIT 5',
      'SELECT status FROM users GROUP BY status ORDER BY MAX(created_at) DESC, status',
      'SELECT status FROM users GROUP BY status ORDER BY COALESCE(MIN(created_at), 0)',
      'SELECT status, n FROM s GROUP BY status ORDER BY ROW_NUMBER() OVER (ORDER BY n)',
      'SELECT DISTINCT u.id FROM users u ORDER BY u.created_at DESC',
      'SELECT DISTINCT u.id FROM users u ORDER BY `u`.`created_at` DESC',
      'SELECT DISTINCT u.id FROM users u ORDER BY `u`.created_at DESC',
      'SELECT DISTINCT u.id FROM users u ORDER BY u.`created_at` DESC',
      'WITH a AS (SELECT first_name, status FROM users) SELECT a.first_name, a.status FROM a ORDER BY a.first_name',
      'SELECT a FROM t UNION SELECT a FROM u ORDER BY q.a',
    ].forEach((sql) => {
      assert.throws(() => wrapSelect(sql), { name: 'TypeError', message: `wrapSelect(sql) ${OUTER_ORDER_MESSAGE}` }, sql);
      assert.doesNotThrow(() => buildCountSql(sql), sql);
    });
  });

  test('takes an ORDER BY of the statement by aliases, positions and expressions on them', () => {
    assert.equal(
      wrapSelect('SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY n DESC, 1 LIMIT 5'),
      'SELECT * FROM (SELECT status, COUNT(*) AS n FROM users GROUP BY status) q ORDER BY n DESC, 1 LIMIT 5',
    );
    assert.equal(
      wrapSelect("SELECT status, COUNT(*) AS count FROM users GROUP BY status ORDER BY FIELD(status, 'active', 'blocked'), `count` DESC, count"),
      "SELECT * FROM (SELECT status, COUNT(*) AS count FROM users GROUP BY status) q ORDER BY FIELD(status, 'active', 'blocked'), `count` DESC, count",
    );
    assert.equal(
      wrapSelect('SELECT DISTINCT status, last_at FROM users ORDER BY COALESCE(last_at, 0) DESC -- newest\n'),
      'SELECT * FROM (SELECT DISTINCT status, last_at FROM users) q ORDER BY COALESCE(last_at, 0) DESC -- newest\n',
    );
  });

  test('refuses a query in parentheses whose ORDER BY no LIMIT keeps, also one around a set operation: the server drops it inside a derived table', () => {
    [
      '(SELECT first_name, status FROM users ORDER BY created_at DESC) LIMIT 2',
      '(SELECT a FROM t ORDER BY a)',
      '((SELECT a FROM t ORDER BY a)) LIMIT 2',
      '((SELECT a FROM t ORDER BY a LIMIT 4) ORDER BY a DESC)',
      '(((SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a) ORDER BY a DESC)',
      '(((SELECT a FROM t) UNION (SELECT a FROM u) LIMIT 5) ORDER BY a)',
      '(SELECT status FROM users GROUP BY status ORDER BY COUNT(*) DESC)',
      'WITH g AS (SELECT a FROM t) (SELECT a FROM g ORDER BY a)',
      'WITH g AS (SELECT a FROM t) ((SELECT a FROM g ORDER BY a)) LIMIT 2',
      'WITH RECURSIVE c AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM c WHERE n < 3) CYCLE n RESTRICT (SELECT n FROM c ORDER BY n DESC)',
    ].forEach((sql) => {
      assert.throws(() => wrapSelect(sql), { name: 'TypeError', message: `wrapSelect(sql) ${INNER_ORDER_MESSAGE}` }, sql);
      assert.doesNotThrow(() => buildCountSql(sql), sql);
    });
  });

  test('takes a query in parentheses whose order a LIMIT or a FETCH keeps, a set operation gives itself, the statement gives again, or the server drops anyway', () => {
    [
      '(SELECT a FROM t ORDER BY a LIMIT 3)',
      '((SELECT a FROM t ORDER BY a) LIMIT 3)',
      '((SELECT a FROM t ORDER BY a LIMIT 3) ORDER BY a DESC LIMIT 2)',
      '(SELECT a FROM t ORDER BY a FETCH FIRST 3 ROWS ONLY)',
      '(SELECT a FROM t WHERE a IN (SELECT b FROM u ORDER BY b))',
      '(SELECT a, (SELECT MAX(b) FROM u ORDER BY b) AS m FROM t)',
      '(SELECT a FROM t ORDER BY a LIMIT 3) UNION (SELECT a FROM u ORDER BY a)',
      '((SELECT a FROM t ORDER BY a) UNION (SELECT a FROM u ORDER BY a))',
      '(((SELECT a FROM t) UNION ALL (SELECT a FROM u) ORDER BY a))',
      '(((SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a) LIMIT 2)',
      'WITH g AS (SELECT a FROM t ORDER BY a) (SELECT a FROM g ORDER BY a LIMIT 2)',
    ].forEach((sql) => assert.equal(wrapSelect(sql), `SELECT * FROM (${sql}) q`, sql));
    assert.equal(wrapSelect('(SELECT a FROM t ORDER BY a) ORDER BY a DESC'), 'SELECT * FROM ((SELECT a FROM t ORDER BY a)) q ORDER BY a DESC');
    assert.equal(
      wrapSelect('((SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a) LIMIT 2'),
      'SELECT * FROM (((SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a)) q LIMIT 2',
    );
    assert.equal(
      wrapSelect('WITH g AS (SELECT a FROM t) (SELECT a FROM g ORDER BY a) ORDER BY a DESC LIMIT 2'),
      'SELECT * FROM (WITH g AS (SELECT a FROM t) (SELECT a FROM g ORDER BY a)) q ORDER BY a DESC LIMIT 2',
    );
  });
});

describe('buildCountSql', () => {
  test('counts the rows of a statement without its ORDER BY and LIMIT', () => {
    assert.equal(
      buildCountSql('SELECT id, name FROM users WHERE a = 1 ORDER BY name LIMIT 20 OFFSET 40'),
      'SELECT COUNT(*) AS total FROM (SELECT id, name FROM users WHERE a = 1) q',
    );
    assert.equal(buildCountSql('SELECT id FROM users'), 'SELECT COUNT(*) AS total FROM (SELECT id FROM users) q');
    assert.equal(buildCountSql('SELECT id FROM t LIMIT 5 ROWS EXAMINED 100'), 'SELECT COUNT(*) AS total FROM (SELECT id FROM t) q');
  });

  test('counts the rows of a grouping, DISTINCT and an aggregate without GROUP BY over a derived table', () => {
    assert.equal(
      buildCountSql('SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY n DESC'),
      'SELECT COUNT(*) AS total FROM (SELECT status, COUNT(*) AS n FROM users GROUP BY status) q',
    );
    assert.equal(buildCountSql('SELECT DISTINCT status FROM users ORDER BY status'), 'SELECT COUNT(*) AS total FROM (SELECT DISTINCT status FROM users) q');
    assert.equal(
      buildCountSql('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM users'),
      'SELECT COUNT(*) AS total FROM (SELECT COUNT(*) AS n, MAX(created_at) AS last FROM users) q',
    );
  });

  test('counts the rows of a set operation and of a statement led by WITH', () => {
    assert.equal(
      buildCountSql('SELECT a FROM t UNION SELECT a FROM u ORDER BY a LIMIT 5'),
      'SELECT COUNT(*) AS total FROM (SELECT a FROM t UNION SELECT a FROM u) q',
    );
    assert.equal(
      buildCountSql('SELECT a FROM t UNION ALL (SELECT a FROM u ORDER BY a LIMIT 3)'),
      'SELECT COUNT(*) AS total FROM (SELECT a FROM t UNION ALL (SELECT a FROM u ORDER BY a LIMIT 3)) q',
    );
    assert.equal(
      buildCountSql('WITH c AS (SELECT a FROM t ORDER BY a LIMIT 5) SELECT a FROM c ORDER BY a LIMIT 2'),
      'SELECT COUNT(*) AS total FROM (WITH c AS (SELECT a FROM t ORDER BY a LIMIT 5) SELECT a FROM c) q',
    );
    assert.equal(
      buildCountSql('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT n FROM c ORDER BY n'),
      'SELECT COUNT(*) AS total FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT n FROM c) q',
    );
    assert.equal(buildCountSql(WITH_QUERY_SQL), `SELECT COUNT(*) AS total FROM (${WITH_QUERY_SQL}) q`);
    assert.equal(
      buildCountSql('WITH g AS (SELECT slug FROM groups) (SELECT slug FROM g) ORDER BY slug LIMIT 1'),
      'SELECT COUNT(*) AS total FROM (WITH g AS (SELECT slug FROM groups) (SELECT slug FROM g)) q',
    );
  });

  test('counts whatever the order of the statement names: the count keeps no order', () => {
    assert.equal(
      buildCountSql('SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY COUNT(*) DESC, u.status'),
      'SELECT COUNT(*) AS total FROM (SELECT status, COUNT(*) AS n FROM users GROUP BY status) q',
    );
    assert.equal(
      buildCountSql('(SELECT first_name FROM users ORDER BY created_at DESC) LIMIT 2'),
      'SELECT COUNT(*) AS total FROM ((SELECT first_name FROM users ORDER BY created_at DESC)) q',
    );
  });

  test('closes the derived table ahead of the comments at the cut points', () => {
    assert.equal(buildCountSql('SELECT id FROM t -- note'), 'SELECT COUNT(*) AS total FROM (SELECT id FROM t) q');
    assert.equal(buildCountSql('SELECT id FROM t WHERE a = 1 # active\nORDER BY id -- sorted'), 'SELECT COUNT(*) AS total FROM (SELECT id FROM t WHERE a = 1) q');
    assert.equal(buildCountSql('SELECT id FROM t /* all */ LIMIT 5'), 'SELECT COUNT(*) AS total FROM (SELECT id FROM t) q');
  });

  test('counts the statement createQuery builds: filter, sort and page apart', () => {
    const sql = 'SELECT id, name FROM users WHERE is_active = 1 OR is_admin = 1 ORDER BY name -- default\n';
    const built = replacePagination(replaceOrderBy(appendToWhere(sql, CONDITION), ORDER_BY), PAGE);

    assert.equal(built, `SELECT id, name FROM users WHERE (is_active = 1 OR is_admin = 1) AND (x = :x) ORDER BY ${ORDER_BY} LIMIT ${PAGE} -- default\n`);
    assert.equal(buildCountSql(built), 'SELECT COUNT(*) AS total FROM (SELECT id, name FROM users WHERE (is_active = 1 OR is_admin = 1) AND (x = :x)) q');
  });

  test('counts a wrapped and filtered statement', () => {
    const built = page(where(wrapSelect('SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY n DESC')));

    assert.equal(built, `SELECT * FROM (SELECT status, COUNT(*) AS n FROM users GROUP BY status) q WHERE x = :x ORDER BY n DESC LIMIT ${PAGE}`);
    assert.equal(buildCountSql(built), 'SELECT COUNT(*) AS total FROM (SELECT * FROM (SELECT status, COUNT(*) AS n FROM users GROUP BY status) q WHERE x = :x) q');
  });
});

describe('namesResultColumns', () => {
  test('takes aliases, positions, quoted names and expressions on them', () => {
    [
      'user_count DESC, status ASC',
      '2 DESC, 1',
      "FIELD(status, 'active', 'blocked')",
      'COALESCE(last_login_at, created_at) DESC',
      'count DESC, `count`, `sum`',
      'CASE WHEN status = :status THEN .5 ELSE 1 END',
      "JSON_VALUE(profile, '$.name'), DATE_FORMAT(created_at, '%Y.%m')",
      'status -- by status\n',
      '/* nothing */',
    ].forEach((text) => assert.equal(namesResultColumns(text), true, text));
  });

  test('refuses an aggregate call at any depth, in any case and with blanks or a comment before its parenthesis', () => {
    [
      'COUNT',
      'SUM',
      'AVG',
      'MIN',
      'MAX',
      'GROUP_CONCAT',
      'JSON_ARRAYAGG',
      'JSON_OBJECTAGG',
      'BIT_AND',
      'BIT_OR',
      'BIT_XOR',
      'STD',
      'STDDEV',
      'STDDEV_POP',
      'STDDEV_SAMP',
      'VARIANCE',
      'VAR_POP',
      'VAR_SAMP',
    ].forEach((name) => {
      assert.equal(namesResultColumns(`${name}(x) DESC`), false, name);
      assert.equal(namesResultColumns(`a, ${name.toLowerCase()} (x)`), false, name);
    });
    assert.equal(namesResultColumns('MAX /* last */ (created_at)'), false);
    assert.equal(namesResultColumns('COALESCE(MAX(created_at), 0)'), false);
    assert.equal(namesResultColumns('(SELECT COUNT(*) FROM groups)'), false);
  });

  test('refuses a window and a qualified name', () => {
    [
      'ROW_NUMBER() OVER (ORDER BY n)',
      'RANK() over w',
      'u.created_at DESC',
      'q.status',
      '`u`.`created_at`',
      '`u`.created_at',
      'u.`created_at`',
      'COALESCE(u.last_login_at, 0)',
    ].forEach((text) => assert.equal(namesResultColumns(text), false, text));
  });

  test('requires a text of one piece', () => {
    assert.throws(() => namesResultColumns(''), { name: 'TypeError', message: 'namesResultColumns(text) requires text to be a non-empty string' });
    assert.throws(() => namesResultColumns(null), TypeError);
    assert.throws(() => namesResultColumns(['a']), TypeError);
    assert.throws(() => namesResultColumns('a; b'), { name: 'SyntaxError', message: 'namesResultColumns(text) takes text without a semicolon' });
    assert.throws(() => namesResultColumns("'abc"), /an unclosed '/);
  });
});

describe('the checks of a statement for a caller', () => {
  test('assertOneStatement names the caller and takes any one statement', () => {
    assert.throws(() => checkOneStatement(''), { name: 'TypeError', message: `${CALLER} requires sql to be a non-empty string` });
    assert.throws(() => checkOneStatement(42), { name: 'TypeError', message: `${CALLER} requires sql to be a non-empty string` });
    assert.throws(() => checkOneStatement('SELECT 1; SELECT 2'), { name: 'SyntaxError', message: `${CALLER} takes one statement without a semicolon` });
    assert.throws(() => checkOneStatement('SELECT (1'), /an unclosed parenthesis/);
    ['SELECT 1', 'DELETE FROM t WHERE id = :id', 'CALL report()'].forEach((sql) => assert.equal(checkOneStatement(sql), undefined, sql));
  });

  test('assertEditableSelect names the caller and takes a locking read, INTO and any ORDER BY', () => {
    assert.throws(() => checkEditable('UPDATE t SET a = 1'), { name: 'TypeError', message: `${CALLER} requires a SELECT statement` });
    assert.throws(
      () => checkEditable('SELECT id FROM t ORDER BY id FETCH FIRST 5 ROWS ONLY'),
      { name: 'SyntaxError', message: `${CALLER} cannot take OFFSET ... ROWS or FETCH: write the page with LIMIT` },
    );
    [
      'SELECT * FROM t FOR UPDATE',
      'SELECT id INTO @id FROM t LIMIT 1',
      'SELECT SQL_NO_CACHE status FROM users GROUP BY status ORDER BY COUNT(*)',
      WITH_QUERY_SQL,
    ].forEach((sql) => assert.equal(checkEditable(sql), undefined, sql));
  });

  test('assertCountableSelect names the caller and takes any ORDER BY', () => {
    assert.throws(
      () => checkCountable('SELECT * FROM t FOR UPDATE'),
      { name: 'TypeError', message: `${CALLER} cannot put FOR UPDATE into a derived table: the server refuses INTO and PROCEDURE there, and a lock taken there covers every row the inner statement reads` },
    );
    assert.throws(
      () => checkCountable('SELECT SQL_CALC_FOUND_ROWS id FROM t'),
      { name: 'TypeError', message: `${CALLER} cannot put SQL_CALC_FOUND_ROWS into a derived table: the server refuses that option there, so leave it out of the statement` },
    );
    assert.throws(() => checkCountable('SELECT id FROM t OFFSET 5 ROWS'), FETCH_REFUSED);
    [
      'SELECT status FROM users GROUP BY status ORDER BY COUNT(*) DESC',
      '(SELECT a FROM t ORDER BY a) LIMIT 2',
      WITH_QUERY_SQL,
    ].forEach((sql) => assert.equal(checkCountable(sql), undefined, sql));
  });

  test('assertWrappableSelect names the caller and refuses what wrapSelect refuses', () => {
    assert.throws(() => checkWrappable('SELECT DISTINCT u.id FROM users u ORDER BY u.id'), { name: 'TypeError', message: `${CALLER} ${OUTER_ORDER_MESSAGE}` });
    assert.throws(() => checkWrappable('(SELECT a FROM t ORDER BY a) LIMIT 2'), { name: 'TypeError', message: `${CALLER} ${INNER_ORDER_MESSAGE}` });
    assert.throws(() => checkWrappable('SELECT HIGH_PRIORITY a FROM t'), WRAP_REFUSED);
    assert.throws(() => checkWrappable('SELECT a FROM t LIMIT 1 INTO @a'), WRAP_REFUSED);
    [
      'SELECT status, COUNT(*) AS n FROM users GROUP BY status ORDER BY n DESC LIMIT 5',
      '(SELECT a FROM t ORDER BY a LIMIT 3)',
      WITH_QUERY_SQL,
    ].forEach((sql) => assert.equal(checkWrappable(sql), undefined, sql));
  });
});

const COST_BUDGET_MS = 1000;
const HOSTILE_STATEMENTS = Object.freeze([
  `SELECT ${'a, '.repeat(20000)}1 FROM t ${'-- x\n'.repeat(20000)}`,
  `SELECT 1 FROM t WHERE ${'a OR '.repeat(20000)}b${' '.repeat(50000)}`,
  `SELECT ${'window '.repeat(20000)}FROM t`,
  `SELECT * FROM t WHERE ${'('.repeat(5000)}1${')'.repeat(5000)} ${'/* x */ '.repeat(20000)}`,
  `WITH ${'c AS (SELECT 1), '.repeat(5000)}d AS (SELECT 1) SELECT 1 FROM d`,
  `SELECT 1 FROM t ${'UNION SELECT 1 FROM t '.repeat(5000)}ORDER BY 1`,
  `${'('.repeat(20000)}SELECT 1 FROM t ORDER BY 1 LIMIT 1${')'.repeat(20000)}`,
  `WITH ${'c AS (SELECT 1), '.repeat(5000)}d AS (SELECT 1) ${'('.repeat(20000)}SELECT 1 FROM d ORDER BY 1 LIMIT 1${')'.repeat(20000)}`,
]);
const HOSTILE_ORDER_LISTS = Object.freeze([
  `${'n DESC, '.repeat(20000)}1`,
  `${'COALESCE(a, '.repeat(5000)}b${')'.repeat(5000)} ${'/* x */ '.repeat(20000)}`,
  `${'`a`, '.repeat(20000)}'b'`,
]);

function assertQuick(run) {
  const startedAt = performance.now();

  run();

  assert.ok(performance.now() - startedAt < COST_BUDGET_MS);
}

describe('sql: cost on a long hostile input', () => {
  Object.entries({
    isSelect,
    isLockingRead,
    requiresDerivedTable,
    replaceOrderBy: order,
    replacePagination: page,
    wrapSelect,
    buildCountSql,
  }).forEach(([name, fn]) => {
    test(`${name} answers instantly`, () => assertQuick(() => HOSTILE_STATEMENTS.forEach((sql) => fn(sql))));
  });

  test('appendToWhere answers instantly', () => assertQuick(() => HOSTILE_STATEMENTS.slice(0, 2).forEach((sql) => where(sql))));

  test('namesResultColumns answers instantly', () => assertQuick(() => HOSTILE_ORDER_LISTS.forEach((text) => namesResultColumns(text))));
});
