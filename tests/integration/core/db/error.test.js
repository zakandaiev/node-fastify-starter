import { DbError } from '#core/db/error.js';
import { createDb } from '#core/db/index.js';
import { withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { readRequestId } from '#root/tests/helper/app.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const EMAIL = 'john@example.com';
const PHONE = '+380501234567';

// Never finishes in time: the join has ten billion rows, and the server checks the limit while it reads them.
const HEAVY_SQL = 'SELECT COUNT(*) AS total FROM seq_1_to_100000 a JOIN seq_1_to_100000 b';

const testDb = await createTestDb();
const { db, run } = testDb;

function query(sql, binding, options) {
  return run(() => db.query(sql, binding, options));
}

async function catchError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  return assert.fail('The statement was expected to fail');
}

function insertPerson(binding, target = db) {
  return target.query('INSERT INTO people (id, email, phone, country) VALUES (:id, :email, :phone, :country)', {
    phone: null,
    country: null,
    ...binding,
  });
}

// The table and its first row belong to the file, not to its first suite: the suite over HTTP needs them too.
if (!testDb.skip) {
  before(async () => {
    await query(`
      CREATE TABLE people (
        id INT PRIMARY KEY,
        email VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
        phone VARCHAR(20) COLLATE utf8mb4_bin NULL,
        country VARCHAR(2) COLLATE utf8mb4_bin NULL,
        UNIQUE KEY uq_people_email (email),
        UNIQUE KEY uq_people_phone_country (phone, country)
      ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin
    `);
    await run(() => insertPerson({
      id: 1,
      email: EMAIL,
      phone: PHONE,
      country: 'UA',
    }));
  });
}

describe('db errors: unique', { skip: testDb.skip }, () => {
  test('is a DbError with the kind "unique" and the name of the index', async () => {
    const error = await catchError(run(() => insertPerson({ id: 2, email: EMAIL })));

    assert.ok(error instanceof DbError);
    assert.equal(error.name, 'DbError');
    assert.deepEqual({ ...error }, {
      kind: DB_ERROR_KIND.UNIQUE,
      constraint: 'uq_people_email',
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
    });
  });

  test('names the index of a key of several columns and of the primary key', async () => {
    const composite = await catchError(run(() => insertPerson({
      id: 3,
      email: 'other@example.com',
      phone: PHONE,
      country: 'UA',
    })));
    const primary = await catchError(run(() => insertPerson({ id: 1, email: 'third@example.com' })));

    await run(() => insertPerson({ id: 7, email: 'seventh@example.com' }));

    const updated = await catchError(query('UPDATE people SET email = :email WHERE id = 7', { email: EMAIL }));

    assert.equal(composite.constraint, 'uq_people_phone_country');
    assert.equal(primary.constraint, 'PRIMARY');
    assert.equal(updated.constraint, 'uq_people_email');
    assert.equal(updated.kind, DB_ERROR_KIND.UNIQUE);
  });

  test('carries neither the value nor the statement: not in the message, the stack or any property', async () => {
    const error = await catchError(run(() => insertPerson({
      id: 4,
      email: EMAIL,
      phone: PHONE,
      country: 'UA',
    })));
    const dump = JSON.stringify([error.message, error.stack, { ...error }, Object.getOwnPropertyNames(error)]);

    assert.equal(error.message, "Duplicate entry '***' for key 'uq_people_email'");
    assert.equal(dump.includes(EMAIL), false);
    assert.equal(dump.includes(PHONE), false);
    assert.equal(Object.hasOwn(error, 'sql'), false);
    assert.equal(Object.hasOwn(error, 'sqlMessage'), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
  });

  test('hides a value that holds a quote, the words of the message, a line break or all of them', async () => {
    const values = [
      "o'brien' for key 'x",
      "first line\nsecond' for key 'uq",
      "Duplicate entry 'a' for key 'b'",
      "x' for key 'fake'\nCRAFTED\nDuplicate entry 'y",
    ];

    await Promise.all(values.map((email, index) => run(() => insertPerson({ id: 10 + index, email }))));

    const errors = await Promise.all(values.map((email, index) => catchError(run(() => insertPerson({ id: 20 + index, email })))));

    assert.deepEqual(errors.map((error) => error.message), values.map(() => "Duplicate entry '***' for key 'uq_people_email'"));
    assert.deepEqual(errors.map((error) => error.constraint), values.map(() => 'uq_people_email'));
    assert.equal(errors.some((error) => error.stack.includes('CRAFTED')), false);
  });

  test('leaves no value in the log, whoever writes the error there', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'info', stream: sink.stream } });

    await logged.run(async () => {
      try {
        await insertPerson({ id: 5, email: EMAIL, phone: PHONE }, logged.db);
      } catch (err) {
        logged.context.log.error({ err }, 'Sign-up failed');
        logged.context.log.warn({ failure: err, list: [err] }, err.message);
      }
    });

    const [failed, reported] = sink.lines;

    assert.equal(sink.lines.length, 3);
    assert.deepEqual([failed.msg, failed.kind, failed.code], ['Database query failed', 'unique', 'ER_DUP_ENTRY']);
    assert.equal(failed.sql, 'INSERT INTO people (id, email, phone, country) VALUES (:id, :email, :phone, :country)');
    assert.equal(reported.err.type, 'DbError');
    assert.equal(reported.err.constraint, 'uq_people_email');
    assert.equal(JSON.stringify(sink.lines).includes(EMAIL), false);
    assert.equal(JSON.stringify(sink.lines).includes(PHONE), false);
  });

  test('leaves the transaction open: a duplicate that is caught does not stop the rest', async () => {
    await run(() => withTransaction(async () => {
      await assert.rejects(insertPerson({ id: 6, email: EMAIL }), (error) => error.kind === DB_ERROR_KIND.UNIQUE);
      await insertPerson({ id: 6, email: 'sixth@example.com' });
    }));

    const { rows } = await query('SELECT email FROM people WHERE id = 6');

    assert.deepEqual(rows, [{ email: 'sixth@example.com' }]);
  });
});

describe('db errors: time limit', { skip: testDb.skip }, () => {
  test('a statement that runs over its limit is refused with 503, and the cause tells why', async () => {
    const limited = testDb.open({ db: { statementTimeout: '0.1s' } });
    const error = await catchError(limited.run(() => limited.db.query(HEAVY_SQL, {}, { isTimeLimited: true })));

    assert.ok(error instanceof AppError);
    assert.equal(error.code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
    assert.equal(error.statusCode, 503);
    assert.ok(error.cause instanceof DbError);
    assert.deepEqual({ ...error.cause }, {
      kind: DB_ERROR_KIND.TIMEOUT,
      code: 'ER_STATEMENT_TIMEOUT',
      errno: 1969,
      sqlState: '70100',
    });
    assert.equal(limited.db.getStats().timeoutCount, 1);
  });

  test('the limit is on only when the statement asks for it, and the connection serves the next statement', async () => {
    const limited = testDb.open({ db: { connectionLimit: 1, statementTimeout: '0.05s' } });

    await assert.rejects(limited.run(() => limited.db.query('SELECT SLEEP(0.3) AS waited', {}, { isTimeLimited: true })), AppError);

    const { rows } = await limited.run(() => limited.db.query('SELECT SLEEP(0.1) AS waited'));

    assert.deepEqual(rows, [{ waited: 0 }]);
    assert.deepEqual(limited.db.getStats().timeoutCount, 1);
  });

  test('the limit covers a statement that starts with a comment, a CTE or a parenthesis', async () => {
    // One connection: several SLEEP() cut at the same moment stall on the server for seconds, and now and then
    // one is not cut at all.
    const limited = testDb.open({ db: { connectionLimit: 1, statementTimeout: '0.05s' } });
    const statements = [
      '/* list */ SELECT SLEEP(:seconds) AS waited',
      '-- list\nSELECT SLEEP(:seconds) AS waited',
      'WITH source AS (SELECT SLEEP(:seconds) AS waited) SELECT waited FROM source',
      '(SELECT SLEEP(:seconds) AS waited) UNION (SELECT 1)',
      '  \n SELECT SLEEP(:seconds) AS waited',
    ];
    const errors = await Promise.all(statements.map((sql) => catchError(
      limited.run(() => limited.db.query(sql, { seconds: 0.4 }, { isTimeLimited: true })),
    )));

    assert.deepEqual(errors.map((error) => error.cause?.kind), statements.map(() => DB_ERROR_KIND.TIMEOUT));
  });
});

describe('db errors: other failures', { skip: testDb.skip }, () => {
  test('a mistake in the statement is a DbError without a kind', async () => {
    const error = await catchError(query('SELECT missing_column FROM nowhere'));

    assert.ok(error instanceof DbError);
    assert.equal(error.kind, undefined);
    assert.equal(error.code, 'ER_NO_SUCH_TABLE');
    assert.equal(error.errno, 1146);
  });

  test('a text of the server with an apostrophe in a word is kept whole', async () => {
    const error = await catchError(query('INSERT INTO people (id, email) VALUES (50)'));

    assert.equal(error.errno, 1136);
    assert.equal(error.message, "Column count doesn't match value count at row 1");
  });

  test('a message the server has cut inside a value keeps nothing of that value', async () => {
    await query('CREATE TABLE wallets (id INT PRIMARY KEY, balance BIGINT UNSIGNED NOT NULL)');
    await query('INSERT INTO wallets (id, balance) VALUES (1, 5)');

    const sql = 'SELECT balance - LENGTH(:note) AS rest FROM wallets WHERE id = 1';
    const long = await catchError(query(sql, { note: `Refund to ${EMAIL}', card 4111 1111 1111 1111. ${'Please process. '.repeat(30)}` }));
    const short = await catchError(query(sql, { note: `Refund to ${EMAIL}'s card` }));

    assert.deepEqual([long.errno, short.errno], [1690, 1690]);
    assert.equal(long.message, "BIGINT UNSIGNED value is out of range in '***");
    assert.equal(short.message, "BIGINT UNSIGNED value is out of range in '***'");
    assert.equal(`${long.stack}${short.stack}`.includes(EMAIL), false);
  });

  test('a value the server repeats without quotes is hidden: a row that no partition takes', async () => {
    await query('CREATE TABLE regions (id INT NOT NULL, PRIMARY KEY (id)) PARTITION BY LIST (id) (PARTITION known VALUES IN (1, 2))');

    const error = await catchError(query('INSERT INTO regions (id) VALUES (:id)', { id: 380501234 }));

    assert.equal(error.errno, 1526);
    assert.equal(error.message, 'Table has no partition for value ***');
    assert.equal(error.stack.includes('380501234'), false);
  });

  test('a database that does not exist is a DbError with the code of the server', async (t) => {
    const missing = createDb({ ...testDb.config.db, database: 'nfs_test_missing' });

    t.after(() => missing.close());

    const error = await catchError(missing.ping());

    assert.ok(error instanceof DbError);
    assert.equal(error.code, 'ER_BAD_DB_ERROR');
    assert.equal(error.kind, undefined);
    assert.equal(missing.getStats().activeCount, 0);
  });
});

describe('db errors: over HTTP', { skip: testDb.skip }, () => {
  test('a statement over its time limit answers 503 with Retry-After, logged as a warning', async (t) => {
    const sink = createLogSink();
    const fastify = await testDb.buildApp({ db: { statementTimeout: '0.1s' }, logger: { level: 'info', stream: sink.stream } });
    t.after(() => fastify.close());

    fastify.get('/report', async (request) => {
      const { rows } = await request.server.db.query(HEAVY_SQL, {}, { isTimeLimited: true });

      return rows;
    });

    const response = await fastify.inject('/report');
    const requestId = readRequestId(response);
    const failed = sink.lines.find((line) => line.msg === 'Request failed');

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '60');
    assert.deepEqual(response.json(), {
      status: 'error',
      code: 'SERVICE_UNAVAILABLE_ERROR',
      message: 'Service unavailable',
      meta: { requestId },
    });
    assert.equal(failed.level, 40);
    assert.equal(failed.requestId, requestId);
    assert.equal(failed.err.cause.kind, 'timeout');
  });

  test('a full queue of the pool answers 503 with Retry-After, and the requests in the queue are served', async (t) => {
    const fastify = await testDb.buildApp({ db: { connectionLimit: 1, queueLimit: 1 } });
    t.after(() => fastify.close());

    fastify.get('/slow', async (request) => {
      const { rows } = await request.server.db.query('SELECT SLEEP(0.2) AS waited');

      return rows[0];
    });

    const responses = await Promise.all([fastify.inject('/slow'), fastify.inject('/slow'), fastify.inject('/slow')]);
    const statuses = responses.map((response) => response.statusCode);
    const refused = responses.find((response) => response.statusCode === 503);

    assert.deepEqual(statuses.toSorted(), [200, 200, 503]);
    assert.equal(refused.headers['retry-after'], '60');
    assert.equal(refused.json().code, 'SERVICE_UNAVAILABLE_ERROR');
    assert.equal(fastify.db.getStats().rejectedCount, 1);
  });

  test('a duplicate that nobody handles answers 422 and shows the value neither to the client nor to the log', async (t) => {
    const sink = createLogSink();
    const fastify = await testDb.buildApp({ env: { APP_MODE: 'dev' }, logger: { level: 'info', stream: sink.stream } });
    t.after(() => fastify.close());

    fastify.post('/people', async (request) => insertPerson({ id: 1, email: request.body.email }, request.server.db));

    const response = await fastify.inject({ method: 'POST', url: '/people', payload: { email: EMAIL } });
    const body = response.json();

    assert.equal(response.statusCode, 422);
    assert.equal(body.code, ERROR_CODE.VALIDATION_ERROR);
    assert.equal(body.message, "Duplicate entry '***' for key 'PRIMARY'");
    assert.deepEqual(body.validation, [{
      column: null,
      columnValue: null,
      operator: 'unique',
      operatorValue: null,
    }]);
    assert.equal(response.payload.includes(EMAIL), false);
    assert.equal(JSON.stringify(sink.lines).includes(EMAIL), false);
  });
});
