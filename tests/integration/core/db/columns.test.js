import { DbError } from '#core/db/error.js';
import { withTransaction } from '#core/db/transaction.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const DUPLICATE_CODE = 'DUPLICATE_COLUMN';
const ID_COLUMN = 'the column "id"';
const EXPRESSION_COLUMN = 'a column named by its expression';
const FAILED_MESSAGE = 'Database query failed';
const SECRET = 'john@example.com';

const testDb = await createTestDb();
const { db, run } = testDb;

function query(sql, binding) {
  return run(() => db.query(sql, binding));
}

function assertDuplicate(error, subject) {
  assert.ok(error instanceof DbError, String(error));
  assert.equal(error.message, `A row keeps one value for a name, and ${subject} comes twice in the result: give each column a name of its own with an alias`);
  assert.deepEqual({ ...error }, { code: DUPLICATE_CODE, isExecuted: true });
}

async function readConnectionId(target) {
  const [{ id }] = await target.readRows('SELECT CONNECTION_ID() AS id');

  return id;
}

describe('db: two columns of one name in a result', { skip: testDb.skip }, () => {
  before(async () => {
    await query('CREATE TABLE authors (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL)');
    await query('CREATE TABLE books (id INT PRIMARY KEY, author_id INT NOT NULL, name VARCHAR(100) NOT NULL)');
    await query("INSERT INTO authors (id, name) VALUES (1, 'Lesya')");
    await query("INSERT INTO books (id, author_id, name) VALUES (10, 1, 'Forest Song')");
    await query('CREATE PROCEDURE read_doubled() BEGIN SELECT id, id FROM authors; END');
  });

  test('fail the statement with a DbError that names the column: the row would keep one value of the two', async () => {
    const errors = await Promise.all([
      'SELECT id, id FROM authors',
      'SELECT a.id, b.id FROM authors a JOIN books b ON b.author_id = a.id',
      'SELECT * FROM authors a JOIN books b ON b.author_id = a.id',
      'SELECT 1 AS id, name AS id FROM authors',
    ].map((sql) => rejectionOf(query(sql))));

    errors.forEach((error) => assertDuplicate(error, ID_COLUMN));
  });

  test('come back whole once each has an alias of its own, and names that differ in case only are two keys of a row', async () => {
    const aliased = await query('SELECT a.id AS author_id, b.id AS book_id FROM authors a JOIN books b ON b.author_id = a.id');
    const cased = await query('SELECT 1 AS a, 2 AS A');

    assert.deepEqual(aliased.rows, [{ author_id: 1, book_id: 10 }]);
    assert.deepEqual(cased, { rows: [{ a: 1, A: 2 }], affectedRows: 1, fields: [{ name: 'a' }, { name: 'A' }] });
  });

  test('do not name a column that an expression without an alias names: its name repeats the values written into the statement', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'debug', stream: sink.stream } });
    const error = await rejectionOf(logged.run(() => logged.db.query('SELECT LOWER(:email), LOWER(:email)', { email: SECRET })));

    assertDuplicate(error, EXPRESSION_COLUMN);
    assert.equal(error.stack.includes(SECRET), false);
    assert.deepEqual(findLogLines(sink, FAILED_MESSAGE).map((line) => line.code), [DUPLICATE_CODE]);
    assert.equal(JSON.stringify(sink.lines).includes(SECRET), false);
  });

  test('are refused in what a procedure selects and in RETURNING too, by an error that tells the statement has run: a write outside a transaction stays', async () => {
    assertDuplicate(await rejectionOf(query('CALL read_doubled()')), ID_COLUMN);
    assertDuplicate(await rejectionOf(query("INSERT INTO authors (id, name) VALUES (2, 'Ivan') RETURNING id, id")), ID_COLUMN);
    assert.deepEqual(await testDb.readRows('SELECT name FROM authors WHERE id = 2'), [{ name: 'Ivan' }]);
  });

  test('leave the connection to answer the next statement, and a transaction goes on to its commit', async (t) => {
    const single = testDb.open({ db: { connectionLimit: 1 } }, t);
    const first = await readConnectionId(single);

    assertDuplicate(await rejectionOf(single.readRows('SELECT id, id FROM authors')), ID_COLUMN);
    assert.equal(await readConnectionId(single), first);
    assert.equal(single.db.getStats().activeCount, 0);

    await run(() => withTransaction(async () => {
      await db.query("INSERT INTO authors (id, name) VALUES (3, 'Taras')");
      assertDuplicate(await rejectionOf(db.query('SELECT name, name FROM authors')), 'the column "name"');
      await db.query("INSERT INTO authors (id, name) VALUES (4, 'Mykhailo')");
    }));

    assert.deepEqual(await testDb.readRows('SELECT id FROM authors WHERE id IN (3, 4) ORDER BY id'), [{ id: 3 }, { id: 4 }]);
  });
});
