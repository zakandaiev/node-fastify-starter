import { DbError } from '#core/db/error.js';
import { withTransaction } from '#core/db/transaction.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const EMAIL = 'john@example.com';
const UNREADABLE_CODE = 'UNREADABLE_JSON';
const PROFILE_COLUMN = 'the column "profile"';
const SECRET_TEXT = `{"email": "${EMAIL}", "score": 1.}`;

// What this server keeps in a JSON column and JSON.parse refuses: a number cut after its point or its exponent,
// and an escape JSON does not know.
const UNREADABLE_TEXTS = Object.freeze([
  '1.',
  '[1.]',
  '1.e5',
  '[1e]',
  '[1e+]',
  '"\\d"',
  '"\\x"',
  '"\\0"',
  SECRET_TEXT,
  `{"email": "${EMAIL}", "note": "\\d"}`,
]);
const REFUSED_TEXTS = Object.freeze(['1e', '.5', '[1,]', '{"a": 1,}']);

const VALID_ID = 1;
const NULL_ID = 2;
const BIG_NUMBER_ID = 3;
const FIRST_UNREADABLE_ID = 10;
const SECRET_ID = FIRST_UNREADABLE_ID + UNREADABLE_TEXTS.indexOf(SECRET_TEXT);
const FIRST_REFUSED_ID = FIRST_UNREADABLE_ID + UNREADABLE_TEXTS.length;
const TRANSACTION_ID = FIRST_REFUSED_ID + REFUSED_TEXTS.length;

const VALID_PROFILE = Object.freeze({ email: EMAIL, tags: ['a', 'b'], nested: { is_new: true } });

const BALLAST_ROWS = 3000;
const BALLAST_UNREADABLE_ID = 10;

const testDb = await createTestDb();
const { db, run } = testDb;

function query(sql, binding, options) {
  return run(() => db.query(sql, binding, options));
}

function assertUnreadable(error, subject) {
  assert.ok(error instanceof DbError, String(error));
  assert.equal(error.message, `A row of the result cannot be read: ${subject} holds a text the server takes for JSON and JSON.parse refuses`);
  assert.deepEqual({ ...error }, { code: UNREADABLE_CODE, isExecuted: true });
  assert.equal(error.cause, undefined);
}

function selectProfile(id, target = db) {
  return target.query('SELECT id, profile, is_public FROM documents WHERE id = :id', { id });
}

async function readConnectionId(target) {
  const [{ id }] = await target.readRows('SELECT CONNECTION_ID() AS id');

  return id;
}

if (!testDb.skip) {
  before(async () => {
    await query('CREATE TABLE documents (id INT PRIMARY KEY, profile JSON NULL, is_public TINYINT(1) NULL)');
    await query('CREATE TABLE marks (label VARCHAR(50) PRIMARY KEY)');
    await query('INSERT INTO documents (id, profile, is_public) VALUES (:validId, :valid, 1), (:nullId, NULL, NULL), (:bigId, :big, 0)', {
      validId: VALID_ID,
      valid: JSON.stringify(VALID_PROFILE),
      nullId: NULL_ID,
      bigId: BIG_NUMBER_ID,
      big: '{"views": 9007199254740993}',
    });
    await Promise.all(UNREADABLE_TEXTS.map((text, index) => query(
      'INSERT INTO documents (id, profile, is_public) VALUES (:id, :text, 1)',
      { id: FIRST_UNREADABLE_ID + index, text },
    )));
  });
}

describe('db: JSON the server accepts and JSON.parse refuses', { skip: testDb.skip }, () => {
  test('is kept by the JSON check of the server, while a text both refuse is not: the texts of these tests are what they claim to be', async () => {
    const results = await Promise.allSettled(REFUSED_TEXTS.map((text, index) => query(
      'INSERT INTO documents (id, profile) VALUES (:id, :text)',
      { id: FIRST_REFUSED_ID + index, text },
    )));

    [...UNREADABLE_TEXTS, ...REFUSED_TEXTS].forEach((text) => assert.throws(() => JSON.parse(text), SyntaxError, text));
    results.forEach((result) => assert.equal(result.reason?.code, 'ER_CONSTRAINT_FAILED'));
  });

  test('fails the statement with a DbError that names the column, tells the statement has run and carries no value of the row, whichever such text the row holds', async () => {
    const errors = await Promise.all(UNREADABLE_TEXTS.map((text, index) => rejectionOf(run(() => selectProfile(FIRST_UNREADABLE_ID + index)))));

    errors.forEach((error) => assertUnreadable(error, PROFILE_COLUMN));
  });

  test('logs the failure as a failed statement with its code, and the value of the row goes neither to the log nor into the error', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'debug', stream: sink.stream } });
    const error = await rejectionOf(logged.run(() => selectProfile(SECRET_ID, logged.db)));

    assertUnreadable(error, PROFILE_COLUMN);
    assert.deepEqual(sink.lines.filter((line) => line.msg === 'Database query failed').map((line) => line.code), [UNREADABLE_CODE]);
    assert.equal(JSON.stringify(sink.lines).includes(EMAIL), false);
    assert.equal(error.stack.includes(EMAIL), false);
  });

  test('reads the whole result set first: the connection goes back to the pool and answers the next statement, also one that waited behind the failed one', async (t) => {
    await query('CREATE TABLE ballast (id INT PRIMARY KEY, doc JSON NULL)');
    await query(`INSERT INTO ballast (id, doc) SELECT seq, JSON_OBJECT('text', REPEAT('y', 200)) FROM seq_1_to_${BALLAST_ROWS}`);
    await query("UPDATE ballast SET doc = '[1.]' WHERE id = :id", { id: BALLAST_UNREADABLE_ID });

    const single = testDb.open({ db: { connectionLimit: 1 } }, t);
    const first = await readConnectionId(single);
    const [failed, waited, counted] = await Promise.allSettled([
      single.readRows('SELECT id, doc FROM ballast ORDER BY id'),
      readConnectionId(single),
      single.readRows('SELECT COUNT(*) AS total, MAX(id) AS last FROM ballast'),
    ]);

    assertUnreadable(failed.reason, 'the column "doc"');
    assert.deepEqual([waited.value, counted.value], [first, [{ total: BALLAST_ROWS, last: BALLAST_ROWS }]]);
    assert.equal(await readConnectionId(single), first);
    assert.equal(single.db.getStats().activeCount, 0);
  });

  test('leaves valid JSON parsed, NULL null and TINYINT(1) a boolean; a whole number inside JSON too large for a number stays text', async () => {
    const { rows } = await query('SELECT id, profile, is_public FROM documents WHERE id IN (:ids) ORDER BY id', { ids: [VALID_ID, NULL_ID, BIG_NUMBER_ID] });

    assert.deepEqual(rows, [
      { id: VALID_ID, profile: VALID_PROFILE, is_public: true },
      { id: NULL_ID, profile: null, is_public: null },
      { id: BIG_NUMBER_ID, profile: { views: '9007199254740993' }, is_public: false },
    ]);
  });

  test('fails on a row that comes after valid ones, and names by its alias the first column it cannot read: JSON a function returns is read the same way', async () => {
    const error = await rejectionOf(query(
      'SELECT JSON_EXTRACT(profile, :path) AS extracted, profile FROM documents WHERE id IN (:ids) ORDER BY id',
      { path: '$', ids: [VALID_ID, NULL_ID, SECRET_ID] },
    ));

    assertUnreadable(error, 'the column "extracted"');
  });

  test('does not name a column that an expression without an alias names: its name repeats the values written into the statement', async () => {
    const error = await rejectionOf(query('SELECT JSON_ARRAY(:email, profile) FROM documents WHERE id = :id', { email: EMAIL, id: SECRET_ID }));

    assertUnreadable(error, 'a column named by its expression');
  });

  test('fails the same way inside a transaction, on the connection of the transaction, and the transaction goes on to its commit', async () => {
    async function readSessionId() {
      const { rows: [{ id }] } = await db.query('SELECT CONNECTION_ID() AS id');

      return id;
    }

    const seen = await run(() => withTransaction(async () => {
      const sessionId = await readSessionId();

      await db.query('INSERT INTO documents (id, profile) VALUES (:id, :text)', { id: TRANSACTION_ID, text: '[1e]' });
      assertUnreadable(await rejectionOf(selectProfile(TRANSACTION_ID)), PROFILE_COLUMN);
      await db.query("INSERT INTO marks (label) VALUES ('after the failed read')");

      const { rows: [valid] } = await selectProfile(VALID_ID);

      return { profile: valid.profile, isSameSession: (await readSessionId()) === sessionId };
    }));

    assert.deepEqual(seen, { profile: VALID_PROFILE, isSameSession: true });
    assert.deepEqual(await testDb.readRows('SELECT id FROM documents WHERE id = :id', { id: TRANSACTION_ID }), [{ id: TRANSACTION_ID }]);
    assert.deepEqual(await testDb.readRows("SELECT label FROM marks WHERE label = 'after the failed read'"), [{ label: 'after the failed read' }]);
  });

  test('lets a script that selects such a value run to its end, while query() of the script fails with the DbError that names the column', async () => {
    const labels = await db.driver.withScript({ database: testDb.name }, async (script) => {
      await script.run("SELECT profile FROM documents ORDER BY id;\nINSERT INTO marks (label) VALUES ('after the script select');\n");
      assertUnreadable(await rejectionOf(script.query('SELECT profile FROM documents WHERE id = :id', { id: SECRET_ID })), PROFILE_COLUMN);

      const { rows } = await script.query("SELECT label FROM marks WHERE label = 'after the script select'");

      return rows.map((row) => row.label);
    });

    assert.deepEqual(labels, ['after the script select']);
  });
});
