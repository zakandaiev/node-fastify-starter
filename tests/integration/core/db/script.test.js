import { DbError } from '#core/db/error.js';
import { withTransaction } from '#core/db/transaction.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { ISOLATION_LEVEL } from '#enums/isolation-level.js';
import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import {
  ACCOUNT_HOST,
  countSessionsLeft,
  createDatabaseName,
  createGate,
  createTestDb,
  findSessionId,
  killSession,
} from '#root/tests/helper/db.js';
import { listTableNames } from '#root/tests/helper/migration.js';
import { mapSeries } from '#utils/async.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const TIME_LIMIT_SECONDS = 0.1;

// Never finishes in time: the join has ten billion rows, and the server checks the limit while it reads them.
const TIME_LIMITED_STATEMENT = `SET STATEMENT max_statement_time = ${TIME_LIMIT_SECONDS} FOR SELECT COUNT(*) FROM seq_1_to_100000 a JOIN seq_1_to_100000 b`;
const TIME_LIMIT_MESSAGE = `Query was interrupted: execution time limit ${TIME_LIMIT_SECONDS} sec exceeded`;
const TIME_LIMIT_DETAILS = Object.freeze({
  kind: DB_ERROR_KIND.TIMEOUT,
  code: 'ER_STATEMENT_TIMEOUT',
  errno: 1969,
  sqlState: '70100',
});

const AT_ONCE = 0;
const ONE_CONNECTION = 1;
const NO_QUEUE = 0;
const CONNECTION_LIMIT = `MAX_USER_CONNECTIONS ${ONE_CONNECTION}`;
const EMAIL = 'anna@example.com';

const STEPS_SCRIPT = `
  -- The table numbers the steps itself.
  CREATE TABLE steps (id INT AUTO_INCREMENT PRIMARY KEY, note VARCHAR(50) NOT NULL);
  INSERT INTO steps (note) VALUES ('first; with a semicolon');
  CREATE PROCEDURE add_steps()
  BEGIN
    INSERT INTO steps (note) VALUES ('second, by the procedure');
    INSERT INTO steps (note) VALUES ('third, by the procedure');
  END;
  CALL add_steps();
  SELECT note FROM steps;
  /* a block comment; with a semicolon */
  INSERT INTO steps (note) VALUES ('fourth');
  -- the last line is a comment, with no line break after it`;

const COMMENT_SCRIPTS = Object.freeze(['-- nothing to do\n', '/* nothing to do */', '# nothing to do']);
const NOT_A_TEXT = Object.freeze([undefined, null, '', 5]);

const STACKED_STATEMENTS = Object.freeze([
  'SELECT 1 AS one; SELECT 2 AS two',
  'INSERT INTO entries (id) VALUES (1); INSERT INTO entries (id) VALUES (2)',
  'INSERT INTO entries (id) VALUES (3); SELECT 4 AS four',
  'SELECT 5 AS five; INSERT INTO entries (id) VALUES (6)',
]);

// One statement for the server, and each carries a semicolon inside it: the text of "query" is cut at its first one.
const COMPOUND_STATEMENTS = Object.freeze([
  'BEGIN NOT ATOMIC INSERT INTO entries (id) VALUES (7); INSERT INTO entries (id) VALUES (8); END',
  'CREATE PROCEDURE add_entry() BEGIN INSERT INTO entries (id) VALUES (9); END',
]);

// The statement stands after the first semicolon of the text: cut there, nothing of it would be sent.
const LATE_STATEMENTS = Object.freeze([
  '-- a note\n; INSERT INTO entries (id) VALUES (10)',
  '/* a note */; INSERT INTO entries (id) VALUES (11)',
  '; INSERT INTO entries (id) VALUES (12)',
]);
const SEVERAL_STATEMENTS_MESSAGE = 'script.query(sql, binding) takes one statement with no semicolon inside it: a compound statement (BEGIN ... END, IF ... END IF) and a text of several are run with script.run(text)';

const TRAILING_COMMENT = '-- one statement: only a comment follows its semicolon';

// Neither commits what it writes: the first has begun a transaction of its own, the second has turned autocommit off.
const OPEN_ENDED_SCRIPTS = Object.freeze([
  'START TRANSACTION;\nINSERT INTO entries (id) VALUES (1);\n',
  'SET autocommit = 0;\nINSERT INTO entries (id) VALUES (2);\n',
]);

// The two counters a script and another session both write, each by its key.
const START_TOTAL = 1;
const OTHER_TOTAL = 5;
const SCRIPT_STEP = 10;
const OTHER_STEP = 100;
const OTHER_WRITE_SQL = 'UPDATE counters SET total = total + :step WHERE id = :id';

// Of two transactions that wait for each other the server ends the one that has done less: the other session
// writes this many rows before it meets the script, which has written one.
const BALLAST_ROWS = 50;

// The script notes in "entries" what it has read of the first counter: the test waits for that row before
// another session changes the counter. The same note once more is a duplicate, which fails the script after its write.
const READING_STEPS = `
  SET @seen = (SELECT total FROM counters WHERE id = 1);
  INSERT INTO entries (id) VALUES (@seen);
`;
const WRITING_STEP = `UPDATE counters SET total = total + ${SCRIPT_STEP} WHERE id = 1;`;
const REPEATED_STEP = 'INSERT INTO entries (id) VALUES (@seen);';

const TYPO_SCRIPT = `INSERT INTO notes (id, title) VALUES (1, 'written before the typo');
INSERT INTO notes (id, title)
  VALUEZ (2, 'the typo stands on the second line of its statement, and the server quotes what follows it up to a limit');
INSERT INTO notes (id, title) VALUES (3, 'never reached');
`;
const TYPO_MESSAGE = "You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near 'VALUEZ (2, 'the typo stands on the second line of its statement, and the serv...' at line 2";

// The last statement is DDL: had the server gone on with the script, no rollback would take its table back.
const LOCAL_FILE_SCRIPT = `
  INSERT INTO entries (id) VALUES (1);
  LOAD DATA LOCAL INFILE 'entries.csv' INTO TABLE entries;
  CREATE TABLE loaded (id INT PRIMARY KEY);
`;
const LOCAL_FILE_MESSAGE = 'The used command is not allowed because the MariaDB server or client has disabled the local infile capability';

// lock_wait_timeout takes whole seconds, and 0 is "do not wait at all": a statement that finds its table held fails at once.
const NO_LOCK_WAIT_SQL = 'SET SESSION lock_wait_timeout = 0';

// Each is one statement that needs the table "entries" to itself. The second creates a table before it gets that far.
const TABLE_CHANGES = Object.freeze([
  'ALTER TABLE entries ADD COLUMN note INT NULL;',
  `BEGIN NOT ATOMIC
    CREATE TABLE first_step (id INT PRIMARY KEY);
    ALTER TABLE entries ADD COLUMN note INT NULL;
  END;`,
]);

// Each resets the status of its session before a statement of it fails: the second one early, so that the
// statements the server has counted since then look like a number of a statement.
const STATEMENTS_AFTER_RESET = 30;
const RESETTING_SCRIPTS = Object.freeze([
  'SELECT 1;\nFLUSH SESSION STATUS;\nSELECT missing FROM nowhere;\n',
  `FLUSH SESSION STATUS;\n${'SELECT 1;\n'.repeat(STATEMENTS_AFTER_RESET)}SELECT missing FROM nowhere;\n`,
]);

const SETTINGS_SQL = `
  SELECT
    @@session.time_zone AS timeZone,
    @@session.character_set_client AS clientCharset,
    @@session.character_set_connection AS connectionCharset,
    @@session.character_set_results AS resultsCharset,
    @@session.collation_connection AS collation,
    @@session.sql_mode AS sqlMode,
    @@session.autocommit AS autocommit,
    @@session.lc_messages AS language,
    @@session.group_concat_max_len = @@session.max_allowed_packet AS isAggregateWhole
`;

// What the session statement of the driver sets, whatever the server gives a new session.
const SET_BY_DRIVER = Object.freeze({
  timeZone: '+00:00',
  clientCharset: 'utf8mb4',
  connectionCharset: 'utf8mb4',
  resultsCharset: 'utf8mb4',
  autocommit: 1,
  language: 'en_US',
  isAggregateWhole: 1,
});

const SAMPLES_SCRIPT = `
  CREATE TABLE samples (
    id INT PRIMARY KEY,
    is_active TINYINT(1) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    profile JSON NOT NULL,
    views BIGINT NOT NULL,
    seen_at DATETIME(3) NOT NULL,
    payload VARBINARY(16) NOT NULL,
    title VARCHAR(50) NOT NULL
  );
  INSERT INTO samples (id, is_active, amount, profile, views, seen_at, payload, title)
  VALUES (1, 1, 12.50, '{"tags": ["a"]}', 9007199254740993, '2026-01-02 03:04:05.678', 'ab', 'Привіт 😀');
`;
const SAMPLES_SQL = 'SELECT is_active, amount, profile, views, seen_at, payload, title FROM samples';
const SAMPLE = Object.freeze({
  is_active: true,
  amount: 12.5,
  profile: { tags: ['a'] },
  views: '9007199254740993',
  seen_at: new Date('2026-01-02T03:04:05.678Z'),
  payload: Buffer.from('ab'),
  title: 'Привіт 😀',
});

const LEAVING_SCRIPT = `
  SET FOREIGN_KEY_CHECKS = 0;
  SET @left_behind = 'by the first script';
  SET SESSION sql_mode = 'PIPES_AS_CONCAT';
`;
const LEFTOVERS_SQL = 'SELECT @@session.foreign_key_checks AS foreignKeyChecks, @left_behind AS variable, @@session.sql_mode AS sqlMode';

const testDb = await createTestDb();

// What the server says of the rows a script trips over and of what a script names, by the text that fails.
const TOLD_BY_SERVER = Object.freeze([
  ['ALTER TABLE members ADD UNIQUE KEY members_email_unique (email);', "Duplicate entry '***' for key 'members_email_unique'"],
  ['ALTER TABLE members MODIFY email INT NOT NULL;', "Truncated incorrect INTEGER value: '***'"],
  ["INSERT INTO members (id, nickname) VALUES (3, 'anna');", "Unknown column 'nickname' in 'INSERT INTO'"],
  ['ALTER TABLE members DROP KEY members_phone_unique;', "Can't DROP INDEX `members_phone_unique`; check that it exists"],
  ['INSERT INTO nowhere (id) VALUES (1);', `Table '${testDb.name}.nowhere' doesn't exist`],
]);

function withScript(fn, { pool = testDb, database = testDb.name } = {}) {
  return pool.db.driver.withScript({ database }, fn);
}

function runScript(text, options) {
  return withScript((script) => script.run(text), options);
}

function createEntries() {
  return testDb.readRows('CREATE TABLE entries (id INT PRIMARY KEY) ENGINE=InnoDB');
}

async function createCounters() {
  await testDb.readRows('CREATE TABLE counters (id INT PRIMARY KEY, total INT NOT NULL) ENGINE=InnoDB');
  await testDb.readRows('INSERT INTO counters (id, total) VALUES (1, :total), (2, :total)', { total: START_TOTAL });
}

async function readIds(table = 'entries') {
  const rows = await testDb.readRows(`SELECT id FROM ${table} ORDER BY id`);

  return rows.map((row) => row.id);
}

async function readTotals(ids) {
  const rows = await testDb.readRows('SELECT total FROM counters WHERE id IN (:ids) ORDER BY id', { ids });

  return rows.map((row) => row.total);
}

// What a session sees that reads past the transactions of the others: also the rows nobody has committed yet.
function readUncommittedIds() {
  return testDb.run(() => withTransaction(async () => {
    const { rows } = await testDb.db.query('SELECT id FROM entries ORDER BY id');

    return rows.map((row) => row.id);
  }, { isolation: ISOLATION_LEVEL.READ_UNCOMMITTED }));
}

// Runs fn while a transaction of another session has read "entries": until it ends, a statement that needs
// the table to itself waits.
function withEntriesHeld(fn) {
  return testDb.run(() => withTransaction(async () => {
    await testDb.db.query('SELECT id FROM entries');

    return fn();
  }));
}

// A script that reads a counter, waits at a gate while another session changes that counter and commits, and
// then writes it; "ending" is what the script goes on with. Resolves with how the run has settled.
async function settleOvertaken(t, ending = '') {
  const gate = await createGate(t);
  const running = Promise.allSettled([runScript(`${READING_STEPS}${gate.statement};\n${WRITING_STEP}\n${ending}`)]);

  t.after(() => running);
  await waitFor(async () => (await readUncommittedIds()).length === 1, 'the script to note what it has read');
  await testDb.readRows('UPDATE counters SET total = :total WHERE id = 1', { total: OTHER_TOTAL });
  await gate.open();

  const [outcome] = await running;

  return outcome;
}

// The databases, of those named, that hold a table of this name.
async function findDatabasesOf(table, databases) {
  const rows = await testDb.readRows(
    'SELECT table_schema AS name FROM information_schema.tables WHERE table_name = :table AND table_schema IN (:databases)',
    { table, databases },
  );

  return rows.map((row) => row.name);
}

describe('script: statements', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('runs every statement in order, a compound one with semicolons inside and a comment after the last one included, and resolves with nothing', async () => {
    const result = await runScript(STEPS_SCRIPT);
    const steps = await testDb.readRows('SELECT note FROM steps ORDER BY id');

    assert.equal(result, undefined);
    assert.deepEqual(steps.map((step) => step.note), [
      'first; with a semicolon',
      'second, by the procedure',
      'third, by the procedure',
      'fourth',
    ]);
  });

  test('sends the text as it is: a question mark and a name after a colon are no placeholders in a script', async () => {
    await runScript("CREATE TABLE marks (note VARCHAR(50) NOT NULL);\nINSERT INTO marks (note) VALUES ('why? :because ??');\n");

    assert.deepEqual(await testDb.readRows('SELECT note FROM marks'), [{ note: 'why? :because ??' }]);
  });

  test('accepts a script of comments only: a file with nothing to do says so in a comment', async () => {
    const results = await mapSeries(COMMENT_SCRIPTS, (text) => runScript(text));

    assert.deepEqual(results, COMMENT_SCRIPTS.map(() => undefined));
  });

  test('requires the text of a script: a call without one is a TypeError, and it does not use up the one run of the connection', async () => {
    await createEntries();

    const errors = await withScript(async (script) => {
      const refused = await mapSeries(NOT_A_TEXT, (text) => rejectionOf(script.run(text)));

      await script.run('INSERT INTO entries (id) VALUES (1);');

      return refused;
    });

    errors.forEach((error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'script.run(text) requires the text of the script');
    });
    assert.deepEqual(await readIds(), [1]);
  });

  test('runs one script on its connection: a second one is a TypeError that says why, whether the first has passed or failed', async () => {
    await createEntries();

    const afterPassed = await withScript(async (script) => {
      await script.run('INSERT INTO entries (id) VALUES (1);');

      return rejectionOf(script.run('INSERT INTO entries (id) VALUES (2);'));
    });
    const afterFailed = await withScript(async (script) => {
      await rejectionOf(script.run('INSERT INTO nowhere (id) VALUES (3);'));

      return rejectionOf(script.run('INSERT INTO entries (id) VALUES (4);'));
    });

    [afterPassed, afterFailed].forEach((error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'script.run(text) runs one script on its connection: the next one needs a connection of its own');
    });
    assert.deepEqual(await readIds(), [1]);
  });

  test('gives fn a frozen object of two functions: query for one statement, run for the script', async () => {
    const script = await withScript((given) => given);

    assert.ok(Object.isFrozen(script));
    assert.deepEqual(Object.keys(script), ['query', 'run']);
  });

  test('query() binds named values into a statement and resolves with its rows, the number of affected rows and the names of its columns; with no script run before it, what it writes is committed at once', async () => {
    const [created, written, read, seenByPool] = await withScript(async (script) => [
      await script.query('CREATE TABLE notes (id INT PRIMARY KEY, title VARCHAR(50) NOT NULL)'),
      await script.query('INSERT INTO notes (id, title) VALUES (:id, :title), (:nextId, :title)', { id: 1, nextId: 2, title: "it's a note" }),
      await script.query('SELECT id, title FROM notes WHERE id IN (:ids) ORDER BY id', { ids: [2, 1, 9] }),
      await readIds('notes'),
    ]);

    assert.deepEqual(created, { rows: [], affectedRows: 0, fields: [] });
    assert.deepEqual(written, { rows: [], affectedRows: 2, fields: [] });
    assert.deepEqual(read, {
      rows: [{ id: 1, title: "it's a note" }, { id: 2, title: "it's a note" }],
      affectedRows: 2,
      fields: [{ name: 'id' }, { name: 'title' }],
    });
    assert.deepEqual(seenByPool, [1, 2]);
  });

  test('query() is async: a binding that does not fit rejects the promise it returns, with the error of the binding, and nothing is sent', async () => {
    await createEntries();

    const error = await withScript((script) => rejectionOf(script.query('INSERT INTO entries (id) VALUES (:id)', {})));

    assert.ok(error instanceof TypeError);
    assert.equal(error.message, 'Placeholder :id has no value in the binding');
    assert.deepEqual(await readIds(), []);
  });

  test('query() takes one statement: a text of several is refused before it is sent, whatever they are, with a DbError of the code SEVERAL_STATEMENTS that tells where such a text goes', async () => {
    await createEntries();

    const errors = await withScript((script) => mapSeries(STACKED_STATEMENTS, (text) => rejectionOf(script.query(text))));

    errors.forEach((error) => {
      assert.ok(error instanceof DbError);
      assert.equal(error.message, SEVERAL_STATEMENTS_MESSAGE);
      assert.deepEqual({ ...error }, { code: 'SEVERAL_STATEMENTS' });
    });
    assert.deepEqual(await readIds(), []);
  });

  test('query() refuses a compound statement and a statement that stands after a semicolon the same way, and sends nothing: cut at the first semicolon, the one would run in part and the other not at all, with a result that says it did', async () => {
    await createEntries();

    const errors = await withScript((script) => mapSeries([...COMPOUND_STATEMENTS, ...LATE_STATEMENTS], (text) => rejectionOf(script.query(text))));

    errors.forEach((error) => {
      assert.ok(error instanceof DbError);
      assert.equal(error.message, SEVERAL_STATEMENTS_MESSAGE);
      assert.equal(error.code, 'SEVERAL_STATEMENTS');
    });
    assert.deepEqual(await readIds(), []);
    assert.deepEqual(await testDb.readRows('SELECT routine_name FROM information_schema.routines WHERE routine_schema = DATABASE()'), []);
  });

  test('query() takes a statement with a comment after its semicolon for the one statement it is: a write resolves with its result, as it does through the pool', async () => {
    await createEntries();

    const written = await withScript((script) => script.query(`INSERT INTO entries (id) VALUES (1); ${TRAILING_COMMENT}`));
    const pooled = await testDb.run(() => testDb.db.query(`INSERT INTO entries (id) VALUES (2); ${TRAILING_COMMENT}`));

    assert.deepEqual(written, { rows: [], affectedRows: 1, fields: [] });
    assert.deepEqual(written, pooled);
    assert.deepEqual(await readIds(), [1, 2]);
  });
});

describe('script: transaction', { skip: testDb.skip }, () => {
  beforeEach(async () => {
    await testDb.reset();
    await createEntries();
  });

  test('applies a script of plain writes as a whole: no other session sees a row of it before its last statement has run', async (t) => {
    const gate = await createGate(t);
    const running = runScript(`INSERT INTO entries (id) VALUES (1);\n${gate.statement};\nINSERT INTO entries (id) VALUES (2);\n`);

    t.after(() => Promise.allSettled([running]));
    await waitFor(async () => (await readUncommittedIds()).length === 1, 'the first row of the script');

    assert.deepEqual(await readIds(), []);

    await gate.open();
    await running;

    assert.deepEqual(await readIds(), [1, 2]);
  });

  test('undoes a failed script of plain writes as a whole and says so: isRolledBack is true, and the rows are as they were', async () => {
    await testDb.readRows('INSERT INTO entries (id) VALUES (10), (20)');

    const error = await rejectionOf(runScript(`
      INSERT INTO entries (id) VALUES (1);
      UPDATE entries SET id = 11 WHERE id = 10;
      DELETE FROM entries WHERE id = 20;
      INSERT INTO entries (id) VALUES (1);
    `));

    assert.deepEqual(pick({ ...error }, ['statementNumber', 'isRolledBack']), { statementNumber: 4, isRolledBack: true });
    assert.deepEqual(await readIds(), [10, 20]);
  });

  test('runs at READ COMMITTED: a script that has read a row, and writes it after another session has changed it and committed, passes with its write in place; under the default level the server fails the whole script with ER_CHECKREAD', async (t) => {
    await createCounters();

    const outcome = await settleOvertaken(t);

    assert.deepEqual(outcome, { status: 'fulfilled', value: undefined });
    assert.deepEqual(await readIds(), [START_TOTAL]);
    assert.deepEqual(await readTotals([1]), [OTHER_TOTAL + SCRIPT_STEP]);
  });

  test('undoes such a script as a whole all the same when a later statement of it fails: isRolledBack is true, and the row is as the other session left it', async (t) => {
    await createCounters();

    const outcome = await settleOvertaken(t, REPEATED_STEP);

    assert.equal(outcome.status, 'rejected');
    assert.deepEqual(pick({ ...outcome.reason }, ['kind', 'statementNumber', 'isRolledBack']), {
      kind: DB_ERROR_KIND.UNIQUE,
      statementNumber: 5,
      isRolledBack: true,
    });
    assert.deepEqual(await readIds(), []);
    assert.deepEqual(await readTotals([1]), [OTHER_TOTAL]);
  });

  test('commits a transaction the script has left open: its rows are there once run() resolves', async () => {
    const seen = await mapSeries(OPEN_ENDED_SCRIPTS, (text) => withScript(async (script) => {
      await script.run(text);

      return readIds();
    }));

    assert.deepEqual(seen, [[1], [1, 2]]);
  });

  test('claims no rollback when the script has committed on its own before it failed, by DDL or by a COMMIT in the middle: what it wrote stays', async () => {
    const afterDdl = await rejectionOf(runScript(`
      INSERT INTO entries (id) VALUES (1);
      CREATE TABLE extras (id INT PRIMARY KEY);
      INSERT INTO entries (id) VALUES (2);
      INSERT INTO entries (id) VALUES (1);
    `));
    const afterCommit = await rejectionOf(runScript(`
      INSERT INTO entries (id) VALUES (3);
      COMMIT;
      INSERT INTO entries (id) VALUES (4);
      INSERT INTO entries (id) VALUES (3);
    `));

    [afterDdl, afterCommit].forEach((error) => {
      assert.equal(error.statementNumber, 4);
      assert.equal(Object.hasOwn(error, 'isRolledBack'), false);
    });
    assert.deepEqual(await readIds(), [1, 2, 3, 4]);
  });

  test('claims no rollback when a table that takes no part in transactions has kept its row, MyISAM or Aria: only the rows of the others are gone', async () => {
    await testDb.readRows('CREATE TABLE logbook (id INT PRIMARY KEY) ENGINE=MyISAM');
    await testDb.readRows('CREATE TABLE pages (id INT PRIMARY KEY) ENGINE=Aria');

    const errors = await mapSeries(['logbook', 'pages'], (table) => rejectionOf(runScript(`
      INSERT INTO entries (id) VALUES (1);
      INSERT INTO ${table} (id) VALUES (1);
      INSERT INTO entries (id) VALUES (1);
    `)));

    errors.forEach((error) => {
      assert.equal(error.statementNumber, 3);
      assert.equal(Object.hasOwn(error, 'isRolledBack'), false);
    });
    assert.deepEqual([await readIds(), await readIds('logbook'), await readIds('pages')], [[], [1], [1]]);
  });

  test('a known limit: a script of plain writes that has lost a deadlock claims no rollback, although the server has undone all of it - the savepoint that proves a rollback is gone with the transaction', async (t) => {
    const gate = await createGate(t);

    await createCounters();

    const running = rejectionOf(runScript(`
      UPDATE counters SET total = total + ${SCRIPT_STEP} WHERE id = 1;
      ${gate.statement};
      UPDATE counters SET total = total + ${SCRIPT_STEP} WHERE id = 2;
    `));

    t.after(() => Promise.allSettled([running]));
    await findSessionId(testDb, gate.name);
    await testDb.run(() => withTransaction(async () => {
      await testDb.db.query(`INSERT INTO entries (id) SELECT seq FROM seq_1_to_${BALLAST_ROWS}`);
      await testDb.db.query(OTHER_WRITE_SQL, { step: OTHER_STEP, id: 2 });
      await gate.open();
      await testDb.db.query(OTHER_WRITE_SQL, { step: OTHER_STEP, id: 1 });
    }));

    const error = await running;

    assert.equal(error.message, 'Deadlock found when trying to get lock; try restarting transaction');
    assert.deepEqual({ ...error }, {
      kind: DB_ERROR_KIND.DEADLOCK,
      code: 'ER_LOCK_DEADLOCK',
      errno: 1213,
      sqlState: '40001',
      statementNumber: 3,
    });
    assert.deepEqual(await readTotals([1, 2]), [START_TOTAL + OTHER_STEP, START_TOTAL + OTHER_STEP]);
  });

  test('"COMMIT;" as the first statement takes the script out of its transaction: every statement after it is committed as it runs, and stays after a later failure', async (t) => {
    const gate = await createGate(t);
    const running = rejectionOf(runScript(`
      COMMIT;
      INSERT INTO entries (id) VALUES (1);
      ${gate.statement};
      INSERT INTO entries (id) VALUES (2);
      INSERT INTO entries (id) VALUES (1);
    `));

    t.after(() => Promise.allSettled([running]));
    await waitFor(async () => (await readIds()).length === 1, 'the first row of the script to be committed');
    await gate.open();

    const error = await running;

    assert.equal(error.statementNumber, 5);
    assert.equal(Object.hasOwn(error, 'isRolledBack'), false);
    assert.deepEqual(await readIds(), [1, 2]);
  });
});

describe('script: errors', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('rejects with a DbError that carries the number of the failed statement, counted from 1, and the words of the server; what DDL before it did stays, so no rollback is claimed', async () => {
    const error = await rejectionOf(runScript(`
      CREATE TABLE halves (id INT PRIMARY KEY);
      INSERT INTO halves (id) VALUES (1);
      CREATE TABLE halves (id INT PRIMARY KEY);
      INSERT INTO halves (id) VALUES (2);
    `));
    const first = await rejectionOf(runScript('CREATE TABLE halves (id INT PRIMARY KEY);'));

    assert.ok(error instanceof DbError);
    assert.equal(error.message, "Table 'halves' already exists");
    assert.deepEqual({ ...error }, {
      code: 'ER_TABLE_EXISTS_ERROR',
      errno: 1050,
      sqlState: '42S01',
      statementNumber: 3,
    });
    assert.equal(first.statementNumber, 1);
    assert.deepEqual(await readIds('halves'), [1]);
  });

  test('numbers the statements of the script: not the comments, the result sets or the statements a procedure runs', async () => {
    const error = await rejectionOf(runScript(`
      CREATE TABLE counted (id INT PRIMARY KEY);
      CREATE PROCEDURE select_twice()
      BEGIN
        SELECT 1;
        SELECT 2;
        INSERT INTO counted (id) VALUES (1);
      END;
      CALL select_twice();
      -- a comment; it is no statement
      SELECT id FROM counted;
      INSERT INTO counted (id) VALUES (1);
    `));

    assert.equal(error.statementNumber, 5);
  });

  test('tells no number of a statement that fails after the script has reset the status of its session: counted from what the script has zeroed, it would point at another statement', async () => {
    const errors = await mapSeries(RESETTING_SCRIPTS, (text) => rejectionOf(runScript(text)));

    errors.forEach((error) => {
      assert.equal(error.code, 'ER_NO_SUCH_TABLE');
      assert.equal(Object.hasOwn(error, 'statementNumber'), false);
    });
  });

  test('a statement the server cuts for its time limit fails the script with the DbError of the server, not with the 503 a request is answered with', async () => {
    await createEntries();

    const error = await rejectionOf(runScript(`INSERT INTO entries (id) VALUES (1);\n${TIME_LIMITED_STATEMENT};\n`));

    assert.ok(error instanceof DbError);
    assert.equal(error.message, TIME_LIMIT_MESSAGE);
    assert.deepEqual({ ...error }, { ...TIME_LIMIT_DETAILS, statementNumber: 2, isRolledBack: true });
    assert.deepEqual(await readIds(), []);
  });

  test('query() tells a statement the server cuts for its time limit the same way: it rejects with the DbError itself, never with the 503', async () => {
    const error = await rejectionOf(withScript((script) => script.query(TIME_LIMITED_STATEMENT)));

    assert.ok(error instanceof DbError);
    assert.equal(error.message, TIME_LIMIT_MESSAGE);
    assert.deepEqual({ ...error }, TIME_LIMIT_DETAILS);
  });

  test('LOAD DATA LOCAL INFILE is refused by the server itself, and the script ends there: the error names the statement, the writes before it are undone, what stands after it has not run, and the connection answers its next statement', async () => {
    await createEntries();

    const { error, answer } = await withScript(async (script) => ({
      error: await rejectionOf(script.run(LOCAL_FILE_SCRIPT)),
      answer: await script.query('SELECT :asked AS asked', { asked: 'after the refusal' }),
    }));

    assert.ok(error instanceof DbError);
    assert.equal(error.message, LOCAL_FILE_MESSAGE);
    assert.deepEqual({ ...error }, {
      errno: 4166,
      sqlState: 'HY000',
      statementNumber: 2,
      isRolledBack: true,
    });
    assert.deepEqual(answer.rows, [{ asked: 'after the refusal' }]);
    assert.deepEqual(await readIds(), []);
    assert.deepEqual(await listTableNames(testDb), ['entries']);
  });

  test('fails a statement that found its table held as a lock conflict with its number, and claims no rollback: a compound first statement has run in part by then, and what it did stays', async () => {
    await createEntries();

    const errors = await withEntriesHeld(() => mapSeries(TABLE_CHANGES, (text) => withScript(async (script) => {
      await script.query(NO_LOCK_WAIT_SQL);

      return rejectionOf(script.run(text));
    })));

    errors.forEach((error) => {
      assert.equal(error.message, 'Lock wait timeout exceeded; try restarting transaction');
      assert.deepEqual({ ...error }, {
        kind: DB_ERROR_KIND.DEADLOCK,
        code: 'ER_LOCK_WAIT_TIMEOUT',
        errno: 1205,
        sqlState: 'HY000',
        statementNumber: 1,
      });
    });
    assert.deepEqual(await readIds('first_step'), []);
  });

  test('a syntax error tells its place in the words of the server, the line counted inside the statement, and nothing else of the script goes with the error', async () => {
    await testDb.readRows('CREATE TABLE notes (id INT PRIMARY KEY, title VARCHAR(200) NOT NULL)');

    const error = await rejectionOf(runScript(TYPO_SCRIPT));
    const carried = JSON.stringify(Object.getOwnPropertyNames(error).map((name) => [name, error[name]]));

    assert.equal(error.message, TYPO_MESSAGE);
    assert.deepEqual({ ...error }, {
      code: 'ER_PARSE_ERROR',
      errno: 1064,
      sqlState: '42000',
      statementNumber: 2,
      isRolledBack: true,
    });
    assert.equal(Object.hasOwn(error, 'sql'), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(carried.includes('written before the typo'), false);
    assert.equal(carried.includes('never reached'), false);
  });

  test('keeps the names the server tells, of a table, a column and a key, and masks the values of rows: a duplicate does not show its value', async () => {
    await testDb.readRows('CREATE TABLE members (id INT PRIMARY KEY, email VARCHAR(100) NOT NULL)');
    await testDb.readRows('INSERT INTO members (id, email) VALUES (1, :email), (2, :email)', { email: EMAIL });

    const errors = await mapSeries(TOLD_BY_SERVER, ([text]) => rejectionOf(runScript(text)));
    const carried = JSON.stringify(errors.map((error) => [error.stack, { ...error }]));

    assert.deepEqual(errors.map((error) => error.message), TOLD_BY_SERVER.map(([, message]) => message));
    assert.deepEqual(pick({ ...errors[0] }, ['kind', 'constraint']), { kind: DB_ERROR_KIND.UNIQUE, constraint: 'members_email_unique' });
    assert.equal(carried.includes(EMAIL), false);
  });
});

describe('script: session', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('has the settings of a session of the pool: the time zone, the charset and the collation of the connection, the sql_mode', async () => {
    const [scripted] = await withScript(async (script) => (await script.query(SETTINGS_SQL)).rows);
    const [pooled] = await testDb.readRows(SETTINGS_SQL);

    assert.deepEqual(scripted, pooled);
    assert.deepEqual(pick(scripted, Object.keys(SET_BY_DRIVER)), SET_BY_DRIVER);
  });

  test('gives values back in the types the pool gives them: a boolean, a number, parsed JSON, a whole number too large as text, a Date, a Buffer, text in utf8mb4', async () => {
    await runScript(SAMPLES_SCRIPT);

    const scripted = await withScript(async (script) => (await script.query(SAMPLES_SQL)).rows);

    assert.deepEqual(scripted, await testDb.readRows(SAMPLES_SQL));
    assert.deepEqual(scripted, [SAMPLE]);
  });

  test('is one session for query() and run(): what a statement has set before the script, the script finds', async () => {
    await withScript(async (script) => {
      await script.query('SET @prepared = :value', { value: 'set before the script' });
      await script.run('CREATE TABLE findings (note VARCHAR(50) NOT NULL);\nINSERT INTO findings (note) VALUES (@prepared);\n');
    });

    assert.deepEqual(await testDb.readRows('SELECT note FROM findings'), [{ note: 'set before the script' }]);
  });

  test('is a session of its own for every script: what one has set, the checks of foreign keys, a variable, the sql_mode, the next does not find', async () => {
    const first = await withScript(async (script) => {
      await script.run(LEAVING_SCRIPT);

      return (await script.query(LEFTOVERS_SQL)).rows;
    });
    const second = await withScript(async (script) => (await script.query(LEFTOVERS_SQL)).rows);

    assert.deepEqual(first, [{ foreignKeyChecks: 0, variable: 'by the first script', sqlMode: 'PIPES_AS_CONCAT' }]);
    assert.deepEqual(second, await testDb.readRows(LEFTOVERS_SQL));
    assert.deepEqual(pick(second[0], ['foreignKeyChecks', 'variable']), { foreignKeyChecks: 1, variable: null });
  });

  test('runs in the database it names, not in the one of the pool', async (t) => {
    const neighbour = await testDb.createNeighbour(t);
    const database = await withScript(async (script) => {
      await script.run('CREATE TABLE placed (id INT PRIMARY KEY);');

      return (await script.query('SELECT DATABASE() AS name')).rows[0].name;
    }, { database: neighbour });

    assert.equal(database, neighbour);
    assert.deepEqual(await findDatabasesOf('placed', [testDb.name, neighbour]), [neighbour]);
  });

  test('refuses a script that has left its database, once it has run: what followed USE was written elsewhere', async (t) => {
    const neighbour = await testDb.createNeighbour(t);
    const error = await rejectionOf(runScript(`USE \`${neighbour}\`;\nCREATE TABLE strayed (id INT PRIMARY KEY);\n`));

    assert.ok(error instanceof DbError);
    assert.equal(error.message, 'The script changed the database of its session: USE has no place in a script, and what followed it was written elsewhere');
    assert.deepEqual({ ...error }, { code: 'SCRIPT_LEFT_DATABASE' });
    assert.deepEqual(await findDatabasesOf('strayed', [testDb.name, neighbour]), [neighbour]);
  });

  test('lets a script through that has left its database and come back before its end', async (t) => {
    const neighbour = await testDb.createNeighbour(t);

    await runScript(`
      USE \`${neighbour}\`;
      CREATE TABLE visited (id INT PRIMARY KEY);
      USE \`${testDb.name}\`;
      CREATE TABLE returned (id INT PRIMARY KEY);
    `);

    assert.deepEqual(await findDatabasesOf('visited', [testDb.name, neighbour]), [neighbour]);
    assert.deepEqual(await findDatabasesOf('returned', [testDb.name, neighbour]), [testDb.name]);
  });
});

describe('script: connection', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('resolves with what fn returns, rejects with what it throws, and ends its connection either way: no session is left on the server', async () => {
    const failure = new Error('fn has failed');
    const ids = [];
    const listed = [];

    async function noteSession(script) {
      const { rows: [{ id }] } = await script.query('SELECT CONNECTION_ID() AS id');

      ids.push(id);
      listed.push(await countSessionsLeft(testDb, [id], AT_ONCE));
    }

    const result = await withScript(async (script) => {
      await noteSession(script);

      return 'what fn returns';
    });
    const error = await rejectionOf(withScript(async (script) => {
      await noteSession(script);

      throw failure;
    }));

    assert.equal(result, 'what fn returns');
    assert.equal(error, failure);
    assert.deepEqual(listed, [1, 1]);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(await countSessionsLeft(testDb, ids), 0);
  });

  test('is not taken from the pool: a script opens and runs while the only connection of the pool is busy and its queue is full', async (t) => {
    const single = testDb.open({ db: { connectionLimit: ONE_CONNECTION, queueLimit: NO_QUEUE } }, t);

    await createEntries();

    const refusal = await single.db.driver.withConnection(async () => {
      await runScript('INSERT INTO entries (id) VALUES (1);', { pool: single });

      return rejectionOf(single.db.ping());
    });

    assert.deepEqual(await readIds(), [1]);
    assert.equal(refusal.code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
    assert.equal(single.db.getStats().rejectedCount, 1);
  });

  test('fails to open in a database that does not exist with the error of the server, and never calls fn', async (t) => {
    const missing = createDatabaseName();
    const fn = t.mock.fn();
    const error = await rejectionOf(withScript(fn, { database: missing }));

    assert.ok(error instanceof DbError);
    assert.equal(error.message, `Unknown database '${missing}'`);
    assert.deepEqual({ ...error }, { code: 'ER_BAD_DB_ERROR', errno: 1049, sqlState: '42000' });
    assert.equal(fn.mock.callCount(), 0);
  });

  test('fails to open with the error of the server when its account has no connection left: a DbError, not the 503 a request is answered with', async (t) => {
    const account = await testDb.createOwner(t, [], { limit: CONNECTION_LIMIT });
    const owner = testDb.open({ env: account, db: { connectionLimit: ONE_CONNECTION } }, t);
    const error = await owner.db.driver.withConnection(() => rejectionOf(runScript('SELECT 1;', { pool: owner })));

    assert.ok(error instanceof DbError);
    assert.equal(error.message, `User '${account.APP_DATABASE_USER}' has exceeded the 'max_user_connections' resource (current value: ${ONE_CONNECTION})`);
    assert.deepEqual({ ...error }, {
      kind: DB_ERROR_KIND.OVERLOAD,
      code: 'ER_USER_LIMIT_REACHED',
      errno: 1226,
      sqlState: '42000',
    });
  });

  test('rejects with a fatal DbError that names no statement when the server drops the session in the middle of a script, and ends all the same', async (t) => {
    const gate = await createGate(t);

    await createEntries();

    const running = rejectionOf(runScript(`
      INSERT INTO entries (id) VALUES (1);
      ${gate.statement};
      INSERT INTO entries (id) VALUES (2);
    `));

    t.after(() => Promise.allSettled([running]));

    const sessionId = await findSessionId(testDb, gate.name);

    await killSession(testDb, sessionId);

    const error = await running;

    assert.ok(error instanceof DbError);
    assert.equal(error.isFatal, true);
    assert.equal(Object.hasOwn(error, 'statementNumber'), false);
    assert.equal(Object.hasOwn(error, 'isRolledBack'), false);
    assert.equal(await countSessionsLeft(testDb, [sessionId]), 0);
    assert.deepEqual(await readIds(), []);
  });

  test('outlives a session the server drops while its connection stands idle inside fn: the statement and the script that come next each reject with a fatal DbError that names no statement, the process goes on, and a script on a new connection runs', async () => {
    const errors = await withScript(async (script) => {
      const { rows: [{ id }] } = await script.query('SELECT CONNECTION_ID() AS id');

      await killSession(testDb, id);

      assert.equal(await countSessionsLeft(testDb, [id]), 0);

      return [await rejectionOf(script.query('SELECT 1')), await rejectionOf(script.run('SELECT 1;'))];
    });

    errors.forEach((error) => {
      assert.ok(error instanceof DbError);
      assert.equal(error.isFatal, true);
      assert.equal(Object.hasOwn(error, 'statementNumber'), false);
    });
    assert.equal(await runScript('SELECT 1;'), undefined);
  });

  test('opens for an account that owns only its database, and is refused in another one with the error of the server', async (t) => {
    const neighbour = await testDb.createNeighbour(t);
    const account = await testDb.createOwner(t);
    const owner = testDb.open({ env: account }, t);
    const fn = t.mock.fn();

    await runScript('CREATE TABLE owned (id INT PRIMARY KEY);\nINSERT INTO owned (id) VALUES (1);\n', { pool: owner });

    const error = await rejectionOf(withScript(fn, { pool: owner, database: neighbour }));

    assert.deepEqual(await readIds('owned'), [1]);
    assert.ok(error instanceof DbError);
    assert.equal(error.message, `Access denied for user '${account.APP_DATABASE_USER}'@'${ACCOUNT_HOST}' to database '${neighbour}'`);
    assert.deepEqual({ ...error }, { code: 'ER_DBACCESS_DENIED_ERROR', errno: 1044, sqlState: '42000' });
    assert.equal(fn.mock.callCount(), 0);
  });
});
