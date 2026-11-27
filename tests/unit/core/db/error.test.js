import {
  createOverloadError,
  createTransactionTimeoutError,
  DbError,
  describeColumn,
  findDbError,
  isDatabaseAccessDenied,
  isIdentifier,
  isLockConflict,
  isMissingTable,
  isOutcomeUnknown,
  isTransactionTimeout,
  maskDbErrorValues,
  toDbError,
} from '#core/db/error.js';
import { AppError } from '#core/error/index.js';
import { createLogger } from '#core/logger/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const EMAIL = 'john@example.com';

// The shape mysql2 gives an error of the server: the statement with its values is in "sql".
function createServerError(errno, message, { code, sqlState = 'HY000', sql = `INSERT INTO users (email) VALUES ('${EMAIL}')` } = {}) {
  return Object.assign(new Error(message), {
    code,
    errno,
    sqlState,
    sqlMessage: message,
    sql,
  });
}

describe('maskDbErrorValues', () => {
  test('hides the duplicate value and keeps the name of the index', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry 'john@example.com' for key 'uq_users_email'"),
      "Duplicate entry '***' for key 'uq_users_email'",
    );
  });

  test('hides a value that holds quotes or the text of the message itself', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry 'o'brien' for key 'x' for key 'uq_users_name'"),
      "Duplicate entry '***' for key 'uq_users_name'",
    );
  });

  test('hides the value on every line of a stack', () => {
    const stack = [
      "Error: Duplicate entry '380501234567' for key 'uq_users_phone'",
      '    at PromisePool.query (node_modules/mysql2/promise.js:1:1)',
      "  cause: Duplicate entry 'second@example.com' for key 'uq_users_email'",
    ].join('\n');

    assert.equal(maskDbErrorValues(stack), [
      "Error: Duplicate entry '***' for key 'uq_users_phone'",
      '    at PromisePool.query (node_modules/mysql2/promise.js:1:1)',
      "  cause: Duplicate entry '***' for key 'uq_users_email'",
    ].join('\n'));
  });

  test('leaves a text without a duplicate entry as it is', () => {
    const text = "Unknown column 'nickname' in 'field list'";

    assert.equal(maskDbErrorValues(text), text);
    assert.equal(maskDbErrorValues(''), '');
  });

  test('hides the rest of a message that is cut before the name of the index', () => {
    assert.equal(maskDbErrorValues("Duplicate entry 'john@example.com"), "Duplicate entry '***");
    assert.equal(maskDbErrorValues("Error: Duplicate entry 'john@exa…"), "Error: Duplicate entry '***");
  });

  test('hides an entry that is cut after a complete one: on a later line, on the same line, inside the suffix', () => {
    assert.equal(
      maskDbErrorValues("Error: Duplicate entry 'a@b.c' for key 'uq_users_email'\ncaused by: Error: Duplicate entry 'john@exa…"),
      "Error: Duplicate entry '***' for key 'uq_users_email'\ncaused by: Error: Duplicate entry '***",
    );
    assert.equal(
      maskDbErrorValues("Sign-up failed: Duplicate entry 'a@b.c' for key 'uq_users_email': Duplicate entry 'john@exa…"),
      "Sign-up failed: Duplicate entry '***' for key 'uq_users_email': Duplicate entry '***",
    );
    assert.equal(
      maskDbErrorValues("Duplicate entry 'a' for key 'uq_a'\n    at query (pool.js:1:1)\nDuplicate entry 'john@example.com' for k…"),
      "Duplicate entry '***' for key 'uq_a'\n    at query (pool.js:1:1)\nDuplicate entry '***",
    );
  });

  test('hides the lines of a value whose entry does not start its line: cut after a complete entry, or between two entries', () => {
    assert.equal(
      maskDbErrorValues("Sign-up failed: Duplicate entry 'a@b.c' for key 'uq_users_email': Duplicate entry 'first line\nsecond line of the val…"),
      "Sign-up failed: Duplicate entry '***' for key 'uq_users_email': Duplicate entry '***",
    );
    assert.equal(
      maskDbErrorValues("Import failed: Duplicate entry 'a@b.c' for key 'uq_users_email'; Duplicate entry 'first line\nsecond line' for key 'uq_notes_text'; Duplicate entry '380501234567' for key 'uq_users_phone'"),
      "Import failed: Duplicate entry '***' for key 'uq_users_phone'",
    );
  });

  test('hides the lines of a value that is cut before the name of the index', () => {
    assert.equal(maskDbErrorValues("Duplicate entry 'first line\nsecond line of the val…"), "Duplicate entry '***");
  });

  test('keeps the name of the index of an empty value', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry '' for key 'uq_users_nickname'"),
      "Duplicate entry '***' for key 'uq_users_nickname'",
    );
  });

  test('hides a value that holds a line break', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry 'first line\nsecond line' for key 'uq_notes_text'"),
      "Duplicate entry '***' for key 'uq_notes_text'",
    );
  });

  test('hides the whole of a value whose first line ends like the message itself', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry 'o'brien' for key 'x'\nsecond line of the value' for key 'uq_users_email'"),
      "Duplicate entry '***' for key 'uq_users_email'",
    );
  });

  test('keeps a text that is already masked as it is', () => {
    const text = "Duplicate entry '***' for key 'uq_users_email'";

    assert.equal(maskDbErrorValues(text), text);
  });

  test('returns what is not a string untouched', () => {
    const error = new Error("Duplicate entry 'a' for key 'b'");

    assert.equal(maskDbErrorValues(error), error);
    assert.equal(maskDbErrorValues(null), null);
    assert.equal(maskDbErrorValues(undefined), undefined);
    assert.equal(maskDbErrorValues(42), 42);
  });

  test('answers instantly on a long hostile input', () => {
    const startedAt = performance.now();

    maskDbErrorValues("Duplicate entry '".repeat(50000));
    maskDbErrorValues("Duplicate entry 'a' for key 'b' ".repeat(50000));
    maskDbErrorValues("Duplicate entry 'a' for key 'b'\n".repeat(50000));
    maskDbErrorValues(" value: '".repeat(50000));
    maskDbErrorValues("Incorrect integer value: 'a' for column `t`.`c` at row 1\n".repeat(50000));
    maskDbErrorValues(`syntax to use near '${"'".repeat(100000)}`);

    assert.ok(performance.now() - startedAt < 500);
  });
});

describe('maskDbErrorValues: other texts of the server that repeat a value', () => {
  test('hides a value the server refused to store and keeps the column', () => {
    const texts = {
      "Incorrect datetime value: 'not-a-date john@example.com' for column `app`.`users`.`born_at` at row 1":
        "Incorrect datetime value: '***' for column `app`.`users`.`born_at` at row 1",
      "Incorrect integer value: 'abc' for column `app`.`users`.`age` at row 1":
        "Incorrect integer value: '***' for column `app`.`users`.`age` at row 1",
      "Incorrect uuid value: 'nope' for column `app`.`users`.`id` at row 1":
        "Incorrect uuid value: '***' for column `app`.`users`.`id` at row 1",
      "Incorrect string value: '\\xF0(\\x8C(' for column `app`.`users`.`email` at row 1":
        "Incorrect string value: '***' for column `app`.`users`.`email` at row 1",
      "Truncated incorrect DECIMAL value: 'john@example.com'": "Truncated incorrect DECIMAL value: '***'",
      "Truncated incorrect INTEGER value: 'it's'": "Truncated incorrect INTEGER value: '***'",
    };

    Object.entries(texts).forEach(([text, masked]) => assert.equal(maskDbErrorValues(text), masked));
  });

  test('hides the tail of the statement in a syntax error: the values are written into it', () => {
    const prefix = 'You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near ';

    assert.equal(
      maskDbErrorValues(`${prefix}'FORM users WHERE email = 'john@example.com' AND age = 5' at line 1`),
      `${prefix}'***' at line 1`,
    );
    assert.equal(maskDbErrorValues(`${prefix}''10' OFFSET 3' at line 2`), `${prefix}'***' at line 2`);
  });

  test('hides a time zone and an expression that is out of range', () => {
    assert.equal(maskDbErrorValues("Unknown or incorrect time zone: 'Mars/Base'"), "Unknown or incorrect time zone: '***'");
    assert.equal(
      maskDbErrorValues("BIGINT UNSIGNED value is out of range in '`app`.`accounts`.`balance` - 500'"),
      "BIGINT UNSIGNED value is out of range in '***'",
    );
  });

  test('hides the value on every line of a stack and keeps the frames', () => {
    const stack = [
      "Error: Incorrect integer value: 'abc' for column `app`.`users`.`age` at row 1",
      '    at PromisePool.query (node_modules/mysql2/promise.js:1:1)',
      "  cause: Truncated incorrect DOUBLE value: 'john@example.com'",
    ].join('\n');

    assert.equal(maskDbErrorValues(stack), [
      "Error: Incorrect integer value: '***' for column `app`.`users`.`age` at row 1",
      '    at PromisePool.query (node_modules/mysql2/promise.js:1:1)',
      "  cause: Truncated incorrect DOUBLE value: '***'",
    ].join('\n'));
  });

  test('takes the rest of the text for a value that is cut or holds a line break', () => {
    assert.equal(maskDbErrorValues("Incorrect integer value: 'john@exa…"), "Incorrect integer value: '***");
    assert.equal(
      maskDbErrorValues("Incorrect string value: 'first line\nsecond line' for column `app`.`notes`.`text` at row 1"),
      "Incorrect string value: '***",
    );
  });

  test('takes the rest of the text when a quote of the value itself stands in its first line or ends it', () => {
    const prefix = 'You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near ';

    assert.equal(
      maskDbErrorValues("Incorrect integer value: 'it's\nsecond line john@example.com' for column `app`.`notes`.`n` at row 1"),
      "Incorrect integer value: '***",
    );
    assert.equal(
      maskDbErrorValues(`${prefix}'FORM users WHERE name = 'x'\nAND email = 'john@example.com'' at line 1`),
      `${prefix}'***`,
    );
    assert.equal(
      maskDbErrorValues("Truncated incorrect DOUBLE value: 'first line'\nsecond line john@example.com'"),
      "Truncated incorrect DOUBLE value: '***",
    );
    assert.equal(
      maskDbErrorValues("BIGINT UNSIGNED value is out of range in '`app`.`wallets`.`balance` - octet_length('Refund to john@example.com, card 4111"),
      "BIGINT UNSIGNED value is out of range in '***",
    );
  });

  test('keeps what the server itself writes after a value', () => {
    const texts = {
      "Incorrect datetime value: 'nonsense' for function str_to_date": "Incorrect datetime value: '***' for function str_to_date",
      "Variable 'sql_mode' can't be set to the value of 'john@example.com'": "Variable 'sql_mode' can't be set to the value of '***'",
      "Invalid utf8mb4 character string: '\\xF0\\x9F'": "Invalid utf8mb4 character string: '***'",
      "Truncated incorrect DOUBLE value: 'john@example.com'\n    at query (pool.js:1:1)": "Truncated incorrect DOUBLE value: '***'\n    at query (pool.js:1:1)",
    };

    Object.entries(texts).forEach(([text, masked]) => assert.equal(maskDbErrorValues(text), masked));
  });

  test('hides everything after a record the server repeats: names in quotes follow it on the same line', () => {
    assert.equal(
      maskDbErrorValues("Foreign key constraint for table 'users', record 'john@example.com-7' would lead to a duplicate entry in table 'profiles', key 'uq_profiles_email'"),
      "Foreign key constraint for table 'users', record '***",
    );
  });

  test('hides a value without quotes to the end of its line, and keeps the frames of the stack', () => {
    const stack = [
      'Error: Table has no partition for value 380501234567',
      '    at PromisePool.query (node_modules/mysql2/promise.js:1:1)',
      '  cause: Table has no partition for value -7',
    ].join('\n');

    assert.equal(maskDbErrorValues(stack), [
      'Error: Table has no partition for value ***',
      '    at PromisePool.query (node_modules/mysql2/promise.js:1:1)',
      '  cause: Table has no partition for value ***',
    ].join('\n'));
  });

  test('hides a duplicate entry and another value in one text', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry 'a@b.c' for key 'uq_users_email'; Truncated incorrect DOUBLE value: 'secret'"),
      "Duplicate entry '***' for key 'uq_users_email'; Truncated incorrect DOUBLE value: '***'",
    );
  });

  test('keeps a text that is already masked, and a text of the server that names things only', () => {
    const texts = [
      "Incorrect integer value: '***' for column `app`.`users`.`age` at row 1",
      "Unknown column 'nickname' in 'SELECT'",
      "Table 'app.nowhere' doesn't exist",
      "Column 'email' cannot be null",
      "Data too long for column 'code' at row 1",
      'CONSTRAINT `chk_users_status` failed for `app`.`users`',
      'Deadlock found when trying to get lock; try restarting transaction',
    ];

    texts.forEach((text) => assert.equal(maskDbErrorValues(text), text));
  });
});

describe('isIdentifier', () => {
  test('is true for 1 to 64 letters, digits and underscores that do not start with a digit', () => {
    ['id', 'first_name', 'firstName', '_x9', 'A', 'a'.repeat(64)].forEach((name) => assert.equal(isIdentifier(name), true, name));
  });

  test('is false for any other name, and for what is not a string even when its text would be one', () => {
    ['', 'a'.repeat(65), '9lives', 'u.id', 'first name', 'users`', 'імя', 'LOWER(:email)', null, undefined, 5, ['id']].forEach((name) => {
      assert.equal(isIdentifier(name), false, String(name));
    });
  });
});

describe('describeColumn', () => {
  test('names a column whose name is an identifier, in lower case: the words stand inside a sentence', () => {
    assert.equal(describeColumn('first_name'), 'the column "first_name"');
    assert.equal(describeColumn('groupCount'), 'the column "groupCount"');
  });

  test('does not name a column an expression names: that name repeats the values written into the statement', () => {
    [`LOWER('${EMAIL}')`, `JSON_ARRAY('${EMAIL}', profile)`, '1', 'u.id', '', null].forEach((name) => {
      assert.equal(describeColumn(name), 'a column named by its expression', String(name));
    });
  });
});

describe('DbError', () => {
  test('is an Error with the name "DbError" and the details it is given', () => {
    const error = new DbError('Database error', { kind: 'unique', constraint: 'uq_users_email', errno: 1062 });

    assert.ok(error instanceof Error);
    assert.equal(error.name, 'DbError');
    assert.equal(error.message, 'Database error');
    assert.deepEqual({ ...error }, { kind: 'unique', constraint: 'uq_users_email', errno: 1062 });
    assert.match(error.stack, /^DbError: Database error\n/);
  });

  test('has no property for a detail that is missing: nothing empty goes to the log', () => {
    const error = new DbError('Database error', { kind: null, constraint: undefined, code: 'ECONNREFUSED' });

    assert.deepEqual(Object.keys(error), ['code']);
    assert.deepEqual(Object.keys(new DbError('Database error')), []);
  });

  test('keeps its cause as any other error does, not among its details, and the log writes it', () => {
    const sink = createLogSink();
    const cause = new TypeError('The reason');
    const error = new DbError('Database error', { code: 'SOME_CODE', cause });

    createLogger({ level: 'info', stream: sink.stream }).error({ err: error }, 'Statement failed');

    assert.equal(error.cause, cause);
    assert.deepEqual({ ...error }, { code: 'SOME_CODE' });
    assert.deepEqual(pick(sink.lines[0].err.cause, ['type', 'message']), { type: 'TypeError', message: 'The reason' });
  });

  test('has no cause when it is given none', () => {
    [new DbError('Database error'), new DbError('Database error', { code: 'SOME_CODE' }), new DbError('Database error', { cause: undefined })].forEach((error) => {
      assert.equal(Object.hasOwn(error, 'cause'), false);
    });
  });
});

describe('createTransactionTimeoutError', () => {
  test('is a DbError without a kind, so nothing takes it for a reason to run the transaction again or for an overload', () => {
    const error = createTransactionTimeoutError();

    assert.ok(error instanceof DbError);
    assert.deepEqual({ ...error }, { code: 'TRANSACTION_TIMEOUT' });
    assert.match(error.message, /nothing committed/);
    assert.equal(isLockConflict(error), false);
  });

  test('has the cause it is given, and the same details with it', () => {
    const cause = new DOMException('The operation timed out', 'TimeoutError');
    const error = createTransactionTimeoutError(cause);

    assert.equal(error.cause, cause);
    assert.deepEqual({ ...error }, { code: 'TRANSACTION_TIMEOUT' });
    assert.equal(Object.hasOwn(createTransactionTimeoutError(), 'cause'), false);
  });

  test('is told by isTransactionTimeout(), also behind a 503, and nothing else is', () => {
    const error = createTransactionTimeoutError();

    assert.equal(isTransactionTimeout(error), true);
    assert.equal(isTransactionTimeout(new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause: error })), true);
    [new DbError('other', { code: 'ER_LOCK_DEADLOCK' }), new Error('plain'), Object.assign(new Error('plain'), { code: 'TRANSACTION_TIMEOUT' }), null].forEach((other) => {
      assert.equal(isTransactionTimeout(other), false);
    });
  });
});

describe('toDbError', () => {
  test('tells a unique violation and reads the name of its index after the last "for key"', () => {
    const cases = {
      "Duplicate entry 'john@example.com' for key 'uq_users_email'": 'uq_users_email',
      "Duplicate entry '1' for key 'PRIMARY'": 'PRIMARY',
      "Duplicate entry 'o'brien' for key 'x' for key 'uq_users_name'": 'uq_users_name',
      "Duplicate entry 'a-b' for key 'users.uq_users_pair'": 'users.uq_users_pair',
      "Duplicate entry 'cut": undefined,
    };

    Object.entries(cases).forEach(([message, constraint]) => {
      const error = toDbError(createServerError(1062, message, { code: 'ER_DUP_ENTRY', sqlState: '23000' }));

      assert.ok(error instanceof DbError);
      assert.equal(error.kind, DB_ERROR_KIND.UNIQUE);
      assert.equal(error.constraint, constraint);
    });

    assert.equal(toDbError(createServerError(1586, "Duplicate entry 'a' for key 'uq_a'")).kind, DB_ERROR_KIND.UNIQUE);
  });

  test('tells a lock conflict: a deadlock, a lock wait that timed out and a row changed since it was read', () => {
    const errors = [
      createServerError(1213, 'Deadlock found when trying to get lock; try restarting transaction', { code: 'ER_LOCK_DEADLOCK', sqlState: '40001' }),
      createServerError(1205, 'Lock wait timeout exceeded; try restarting transaction', { code: 'ER_LOCK_WAIT_TIMEOUT' }),
      createServerError(1020, "Record has changed since last read in table 'users'; try restarting transaction", { code: 'ER_CHECKREAD' }),
    ].map((error) => toDbError(error));

    assert.deepEqual(errors.map((error) => error.kind), ['deadlock', 'deadlock', 'deadlock']);
    assert.deepEqual(errors.map((error) => isLockConflict(error)), [true, true, true]);
    assert.equal(errors[2].message, "Record has changed since last read in table 'users'; try restarting transaction");
  });

  test('turns a statement over its time limit into a 503 that keeps the cause, and names the error itself', () => {
    const raw = createServerError(1969, 'Query was interrupted: execution time limit 3.0 sec exceeded', { sqlState: '70100' });
    const error = toDbError(raw);

    assert.ok(error instanceof AppError);
    assert.equal(error.code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
    assert.equal(error.statusCode, 503);
    assert.deepEqual({ ...error.cause }, {
      kind: 'timeout',
      code: 'ER_STATEMENT_TIMEOUT',
      errno: 1969,
      sqlState: '70100',
    });
  });

  test('turns a server that is out of connections into a 503 as well', () => {
    const errors = [
      createServerError(1040, 'Too many connections', { code: 'ER_CON_COUNT_ERROR', sqlState: '08004' }),
      createServerError(1203, "User app already has more than 'max_user_connections' active connections", { code: 'ER_TOO_MANY_USER_CONNECTIONS', sqlState: '42000' }),
    ].map((error) => toDbError(error));

    errors.forEach((error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.cause.kind, DB_ERROR_KIND.OVERLOAD);
    });
  });

  test('takes a limit of connections of an account for an overload, and its hourly quota for an error', () => {
    const limit = "User 'app' has exceeded the 'max_user_connections' resource (current value: 1)";
    const quota = "User 'app' has exceeded the 'max_queries_per_hour' resource (current value: 2)";
    const refused = toDbError(createServerError(1226, limit, { code: 'ER_USER_LIMIT_REACHED', sqlState: '42000' }));
    const locked = toDbError(createServerError(1226, quota, { code: 'ER_USER_LIMIT_REACHED', sqlState: '42000' }));

    assert.ok(refused instanceof AppError);
    assert.equal(refused.cause.kind, DB_ERROR_KIND.OVERLOAD);
    assert.equal(refused.cause.message, limit);
    assert.ok(locked instanceof DbError);
    assert.equal(Object.hasOwn(locked, 'kind'), false);
    assert.equal(locked.message, quota);
  });

  test('reads the resource of that limit from its own place: the name of the account may spell it too', () => {
    const quota = "User 'app_'max_user_connections'' has exceeded the 'max_queries_per_hour' resource (current value: 1)";
    const error = toDbError(createServerError(1226, quota, { code: 'ER_USER_LIMIT_REACHED', sqlState: '42000' }));

    assert.ok(error instanceof DbError);
    assert.equal(Object.hasOwn(error, 'kind'), false);
  });

  test('leaves any other error without a kind: it stays a 500', () => {
    const error = toDbError(createServerError(1146, "Table 'app.nowhere' doesn't exist", { code: 'ER_NO_SUCH_TABLE', sqlState: '42S02' }));

    assert.ok(error instanceof DbError);
    assert.deepEqual({ ...error }, { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlState: '42S02' });
    assert.equal(error.message, "Table 'app.nowhere' doesn't exist");
    assert.equal(isLockConflict(error), false);
  });

  test('never copies the statement, the raw text or the error of the driver', () => {
    const raw = createServerError(1062, `Duplicate entry '${EMAIL}' for key 'uq_users_email'`, { code: 'ER_DUP_ENTRY', sqlState: '23000' });
    const error = toDbError(raw);
    const dump = JSON.stringify([error.message, error.stack, { ...error }, Object.getOwnPropertyNames(error)]);

    assert.equal(dump.includes(EMAIL), false);
    assert.deepEqual(Object.getOwnPropertyNames(error).toSorted(), ['code', 'constraint', 'errno', 'kind', 'message', 'sqlState', 'stack']);
  });

  test('reads the error of a script of the repository: a name it quotes and the place of a syntax error stay', () => {
    const messages = {
      1050: "Table 'users' already exists",
      1051: "Unknown table 'app.users'",
      1060: "Duplicate column name 'email'",
      1061: "Duplicate key name 'users_email'",
      1064: "You have an error in your SQL syntax; check the manual for the right syntax to use near 'TABLEE users (id INT)' at line 2",
      4161: "Unknown data type: 'INTT'",
    };

    Object.entries(messages).forEach(([errno, message]) => {
      const raw = createServerError(Number(errno), message, { sql: 'CREATE TABLE users (id INT); CREATE TABLEE users (id INT)' });
      const error = toDbError(raw, { isScript: true });

      assert.equal(error.message, message);
      assert.notEqual(toDbError(raw).message, message);
      assert.notEqual(toDbError(raw, {}).message, message);
      assert.equal(JSON.stringify([error.stack, { ...error }, Object.getOwnPropertyNames(error)]).includes('CREATE TABLE users (id INT); CREATE'), false);
    });
  });

  test('still hides in the error of a script what the server repeats of the rows it has met', () => {
    const cases = {
      1062: [`Duplicate entry '${EMAIL}' for key 'users_email_unique'`, "Duplicate entry '***' for key 'users_email_unique'"],
      1292: ["Truncated incorrect INTEGER value: 'token sk_live_51Hxyz'", "Truncated incorrect INTEGER value: '***'"],
      1366: ["Incorrect integer value: 'abc' for column `app`.`users`.`age` at row 1", "Incorrect integer value: '***' for column `app`.`users`.`age` at row 1"],
    };

    Object.entries(cases).forEach(([errno, [message, masked]]) => {
      assert.equal(toDbError(createServerError(Number(errno), message), { isScript: true }).message, masked);
    });
  });

  test('keeps the kind and the 503 of the error of a script', () => {
    const duplicate = toDbError(createServerError(1062, "Duplicate entry 'admin' for key 'groups_slug_unique'"), { isScript: true });
    const timeout = toDbError(createServerError(1969, 'Query execution was interrupted (max_statement_time exceeded)'), { isScript: true });

    assert.deepEqual([duplicate.kind, duplicate.constraint], [DB_ERROR_KIND.UNIQUE, 'groups_slug_unique']);
    assert.ok(timeout instanceof AppError);
    assert.equal(timeout.cause.kind, DB_ERROR_KIND.TIMEOUT);
  });

  test('takes everything in quotes for a value when the server does not say which kind of error it is', () => {
    const cases = {
      "Incorrect integer value: 'abc' for column `app`.`users`.`age` at row 1": "Incorrect integer value: '***' for column `app`.`users`.`age` at row 1",
      "Something new about 'john@example.com' and 'another value' happened": "Something new about '***' happened",
      "A value 'cut": "A value '***",
      'CONSTRAINT `chk_users_status` failed for `app`.`users`': 'CONSTRAINT `chk_users_status` failed for `app`.`users`',
    };

    Object.entries(cases).forEach(([message, masked]) => {
      assert.equal(toDbError(createServerError(1999, message)).message, masked);
    });
  });

  test('keeps the names in the text of an error that quotes names only', () => {
    const cases = {
      1054: "Unknown column 'nickname' in 'SELECT'",
      1048: "Column 'email' cannot be null",
      1406: "Data too long for column 'code' at row 1",
      1264: "Out of range value for column 'age' at row 1",
      1045: "Access denied for user 'app'@'172.18.0.1' (using password: YES)",
      1049: "Unknown database 'app_missing'",
      1044: "Access denied for user 'app'@'%' to database 'other'",
      1052: "Column 'id' in SELECT is ambiguous",
      1142: "SELECT command denied to user 'app'@'172.18.0.1' for table `other`.`users`",
      1265: "Data truncated for column 'status' at row 1",
      1267: "Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT) for operation '='",
      1364: "Field 'email' doesn't have a default value",
    };

    Object.entries(cases).forEach(([errno, message]) => {
      assert.equal(toDbError(createServerError(Number(errno), message)).message, message);
    });
  });

  test('does not take the apostrophe of "doesn\'t" or "can\'t" for an opening quote', () => {
    const cases = {
      "Column count doesn't match value count at row 1": "Column count doesn't match value count at row 1",
      "This version of MariaDB doesn't yet support 'LIMIT & IN/ALL/ANY/SOME subquery'": "This version of MariaDB doesn't yet support '***'",
      'Can\'t create table `app`.`child` (errno: 150 "Foreign key constraint is incorrectly formed")':
        'Can\'t create table `app`.`child` (errno: 150 "Foreign key constraint is incorrectly formed")',
      "Can't DROP COLUMN `nickname`; check that it exists": "Can't DROP COLUMN `nickname`; check that it exists",
      "Can't find record in 'john@example.com'": "Can't find record in '***'",
      "'john@example.com' is not a valid value": "'***' is not a valid value",
    };

    Object.entries(cases).forEach(([message, masked]) => {
      assert.equal(toDbError(createServerError(1999, message)).message, masked);
    });
  });

  test('takes the rest of a message the server has cut for the value: 511 bytes, counted in bytes', () => {
    const start = "BIGINT UNSIGNED value is out of range in '(`app`.`wallets`.`balance` - octet_length('Refund to ";
    const cutAscii = `${start}${EMAIL}', card 4111 1111 1111 1111. ${'Please process. '.repeat(40)}`.slice(0, 511);
    const cyrillic = `${start}Іван', картка 4111 1111 1111 1111. `;
    const missingBytes = 511 - Buffer.byteLength(cyrillic);
    const cutCyrillic = `${cyrillic}${'я'.repeat(Math.floor(missingBytes / 2))}${'.'.repeat(missingBytes % 2)}`;
    const complete = `${start}${EMAIL}')'`;

    assert.equal(Buffer.byteLength(cutCyrillic), 511);
    assert.ok(cutCyrillic.length < 511);
    [cutAscii, cutCyrillic].forEach((message) => {
      assert.equal(
        toDbError(createServerError(1690, message, { sqlState: '22003' })).message,
        "BIGINT UNSIGNED value is out of range in '***",
      );
    });
    assert.equal(
      toDbError(createServerError(1690, complete, { sqlState: '22003' })).message,
      "BIGINT UNSIGNED value is out of range in '***'",
    );
  });

  test('masks a duplicate as one entry whatever its value holds: line breaks, "for key", another entry', () => {
    const crafted = "x' for key 'fake'\nCRAFTED\nDuplicate entry 'y";
    const error = toDbError(createServerError(1062, `Duplicate entry '${crafted}' for key 'uq_notes_text'`, { code: 'ER_DUP_ENTRY', sqlState: '23000' }));

    assert.equal(error.message, "Duplicate entry '***' for key 'uq_notes_text'");
    assert.equal(error.constraint, 'uq_notes_text');
    assert.equal(error.stack.includes('CRAFTED'), false);
  });

  test('takes everything in quotes for a value in a duplicate that is worded in another way', () => {
    const error = toDbError(createServerError(1062, `Account '${EMAIL}' is taken`, { code: 'ER_DUP_ENTRY', sqlState: '45000' }));

    assert.equal(error.message, "Account '***' is taken");
    assert.equal(error.kind, DB_ERROR_KIND.UNIQUE);
    assert.equal(Object.hasOwn(error, 'constraint'), false);
  });

  test('reads the text of an error without one out of its members: a host with several addresses', () => {
    const members = [new Error('connect ECONNREFUSED 127.0.0.1:3307'), new Error('connect ECONNREFUSED ::1:3307')];
    const error = toDbError(Object.assign(new AggregateError(members, ''), { code: 'ECONNREFUSED', fatal: true }));

    assert.equal(error.message, 'connect ECONNREFUSED 127.0.0.1:3307; connect ECONNREFUSED ::1:3307');
    assert.deepEqual({ ...error }, { code: 'ECONNREFUSED', isFatal: true });
    assert.equal(toDbError(new AggregateError([null, {}, new Error('')], '')).message, 'Database error');
  });

  test('hides a value the server repeats without quotes: the value of a row no partition takes', () => {
    const error = toDbError(createServerError(1526, 'Table has no partition for value 380501234567', { code: 'ER_NO_PARTITION_FOR_GIVEN_VALUE' }));

    assert.equal(error.message, 'Table has no partition for value ***');
    assert.match(error.stack, /^DbError: Table has no partition for value \*\*\*\n {4}at /);
    assert.equal(error.stack.includes('380501234567'), false);
  });

  test('does not trust the name mysql2 gives an error that only MariaDB has', () => {
    const check = toDbError(createServerError(4025, 'CONSTRAINT `chk_users_status` failed for `app`.`users`', {
      code: 'ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE',
      sqlState: '23000',
    }));
    const unknown = toDbError(createServerError(1939, 'Engine SEQUENCE failed to discover table', { code: 'ER_SOMETHING_OF_MYSQL' }));
    const shared = toDbError(createServerError(1792, 'Cannot execute statement in a READ ONLY transaction', {
      code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
      sqlState: '25006',
    }));

    assert.equal(check.code, 'ER_CONSTRAINT_FAILED');
    assert.equal(Object.hasOwn(unknown, 'code'), false);
    assert.equal(shared.code, 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION');
  });

  test('keeps the code of an error that never reached the server and marks a lost connection', () => {
    const refused = toDbError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3307'), { code: 'ECONNREFUSED', errno: -4078, fatal: true }));
    const closed = toDbError(Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true }));
    const ended = toDbError(new Error('Pool is closed.'));

    assert.deepEqual({ ...refused }, { code: 'ECONNREFUSED', errno: -4078, isFatal: true });
    assert.equal(refused.message, 'connect ECONNREFUSED 127.0.0.1:3307');
    assert.deepEqual({ ...closed }, { isFatal: true });
    assert.deepEqual({ ...ended }, {});
    assert.equal(ended.message, 'Pool is closed.');
  });

  test('returns an error it has made already as it is', () => {
    const dbError = new DbError('Database error');
    const appError = new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);

    assert.equal(toDbError(dbError), dbError);
    assert.equal(toDbError(appError), appError);
  });

  test('makes an error out of anything that was thrown', () => {
    [null, undefined, 'text', 42, {}, { message: '' }, { message: 7 }].forEach((thrown) => {
      const error = toDbError(thrown);

      assert.ok(error instanceof DbError);
      assert.equal(error.message, 'Database error');
    });
  });

  test('is written to the log with its kind and without the statement', () => {
    const sink = createLogSink();
    const log = createLogger({ level: 'info', stream: sink.stream });
    const raw = createServerError(1062, `Duplicate entry '${EMAIL}' for key 'uq_users_email'`, { code: 'ER_DUP_ENTRY', sqlState: '23000' });

    log.error({ err: toDbError(raw) }, 'Sign-up failed');
    log.error({ err: toDbError(createServerError(1969, 'Query was interrupted: execution time limit 3.0 sec exceeded', { sqlState: '70100' })) }, 'Report failed');

    const [unique, timeout] = sink.lines;

    assert.equal(unique.err.type, 'DbError');
    assert.equal(unique.err.kind, 'unique');
    assert.equal(unique.err.constraint, 'uq_users_email');
    assert.equal(timeout.err.type, 'AppError');
    assert.equal(timeout.err.cause.kind, 'timeout');
    assert.equal(JSON.stringify(sink.lines).includes(EMAIL), false);
  });
});

describe('createOverloadError', () => {
  test('is a 503 whose cause tells that the queue of the pool is full', () => {
    const error = createOverloadError();

    assert.ok(error instanceof AppError);
    assert.equal(error.code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
    assert.ok(error.cause instanceof DbError);
    assert.deepEqual({ ...error.cause }, { kind: 'overload', code: 'POOL_QUEUE_FULL' });
    assert.equal(error.cause.message, 'The queue of the database pool is full');
  });
});

describe('findDbError', () => {
  test('finds the error of the database itself and the one behind a 503', () => {
    const dbError = new DbError('Database error', { kind: 'unique' });
    const overload = createOverloadError();

    assert.equal(findDbError(dbError), dbError);
    assert.equal(findDbError(overload), overload.cause);
  });

  test('finds nothing in any other error', () => {
    const wrapped = new Error('wrapped', { cause: new DbError('Database error') });

    [wrapped, new Error('boom'), new AppError(ERROR_CODE.NOT_FOUND_ERROR), null, undefined, 'text', {}].forEach((error) => {
      assert.equal(findDbError(error), null);
    });
  });
});

describe('isLockConflict', () => {
  test('is true only for an error of the database with the kind "deadlock"', () => {
    assert.equal(isLockConflict(new DbError('x', { kind: DB_ERROR_KIND.DEADLOCK })), true);
    assert.equal(isLockConflict(new DbError('x', { kind: DB_ERROR_KIND.UNIQUE })), false);
    assert.equal(isLockConflict(new DbError('x')), false);
    assert.equal(isLockConflict(Object.assign(new Error('x'), { kind: DB_ERROR_KIND.DEADLOCK })), false);
    assert.equal(isLockConflict(createOverloadError()), false);
    assert.equal(isLockConflict(null), false);
  });
});

describe('isOutcomeUnknown', () => {
  test('is true for a lost connection, also behind a 503, and false for one that took its open transaction with it and for a failure the server answered', () => {
    const lost = toDbError(Object.assign(new Error('Connection lost: The server closed the connection.'), { fatal: true, code: 'PROTOCOL_CONNECTION_LOST' }));
    const closed = toDbError(createServerError(1153, 'Got a packet bigger than max_allowed_packet bytes', { code: 'ER_NET_PACKET_TOO_LARGE', sqlState: '08S01' }));
    const deadlock = toDbError(createServerError(1213, 'Deadlock found when trying to get lock', { code: 'ER_LOCK_DEADLOCK', sqlState: '40001' }));
    const refused = toDbError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3307'), { fatal: true, code: 'ECONNREFUSED' }), { isConnectFailure: true });
    const rolledBack = Object.assign(toDbError(Object.assign(new Error('Connection lost: The server closed the connection.'), { fatal: true, code: 'PROTOCOL_CONNECTION_LOST' })), { isRolledBack: true });

    assert.deepEqual([isOutcomeUnknown(lost), isOutcomeUnknown(closed)], [true, true]);
    assert.equal(isOutcomeUnknown(new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause: lost })), true);
    assert.deepEqual([refused.isFatal, rolledBack.isFatal], [true, true]);

    [deadlock, refused, rolledBack, createTransactionTimeoutError(), createOverloadError(), Object.assign(new Error('lost'), { fatal: true, isFatal: true }), null].forEach((error) => {
      assert.equal(isOutcomeUnknown(error), false);
    });
  });
});

describe('isMissingTable and isDatabaseAccessDenied', () => {
  test('tell an error by the number of the server, also behind a 503, and are false for anything else', () => {
    const missing = toDbError(createServerError(1146, "Table 'app._migrations' doesn't exist", { code: 'ER_NO_SUCH_TABLE', sqlState: '42S02' }));
    const denied = toDbError(createServerError(1044, "Access denied for user 'app'@'%' to database 'migration_verify_x'", { code: 'ER_DBACCESS_DENIED_ERROR', sqlState: '42000' }));

    assert.deepEqual([isMissingTable(missing), isMissingTable(denied)], [true, false]);
    assert.deepEqual([isDatabaseAccessDenied(denied), isDatabaseAccessDenied(missing)], [true, false]);
    assert.equal(isMissingTable(new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause: missing })), true);

    [null, undefined, new Error('boom'), { errno: 1146 }, createOverloadError()].forEach((error) => {
      assert.equal(isMissingTable(error), false);
      assert.equal(isDatabaseAccessDenied(error), false);
    });
  });
});
