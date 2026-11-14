import { AppError } from '#core/error/index.js';
import { createLogger, serializeError } from '#core/logger/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { errorCodes } from 'fastify';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, test } from 'node:test';
import { setImmediate as waitForTick } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const HIDDEN = '[hidden]';

const LEVEL = Object.freeze({
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
});

const DUPLICATE_VALUE = 'john@example.com';
const DUPLICATE_MESSAGE = `Duplicate entry '${DUPLICATE_VALUE}' for key 'uq_users_email'`;
const MASKED_MESSAGE = "Duplicate entry '***' for key 'uq_users_email'";
const STATEMENT_START = 'INSERT INTO';

const QUERY_SECRET = 'query-secret';
const WAIT_TICKS = 50;

function createDriverError(value = DUPLICATE_VALUE) {
  const message = `Duplicate entry '${value}' for key 'uq_users_email'`;

  return Object.assign(new Error(message), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    sqlState: '23000',
    sqlMessage: message,
    sql: `${STATEMENT_START} users (email) VALUES ('${value}')`,
  });
}

function createHostileError() {
  return Object.defineProperty(createDriverError(), 'details', {
    enumerable: true,
    get() {
      throw new Error('The getter failed');
    },
  });
}

function createValidationError() {
  return new AppError(ERROR_CODE.VALIDATION_ERROR, {
    validation: [{
      column: 'password',
      columnValue: 'hunter2',
      operator: 'minLength',
      operatorValue: 8,
    }],
    headers: { 'set-cookie': 'attempt=1f9a; Path=/', 'retry-after': '30' },
  });
}

function snapshotError(error) {
  return {
    keys: Reflect.ownKeys(error),
    message: error.message,
    stack: error.stack,
    properties: { ...error },
  };
}

// createLogSink() parses every line, and JSON.parse keeps the last of two equal keys: the text shows both.
function createTextSink() {
  const { lines, stream: parsed } = createLogSink();
  const texts = [];
  const stream = new Writable({
    write(chunk, encoding, callback) {
      texts.push(chunk.toString());
      parsed.write(chunk, encoding);
      callback();
    },
  });

  return { lines, texts, stream };
}

function createTestLogger(level = 'info') {
  const sink = createTextSink();

  return { ...sink, log: createLogger({ level, stream: sink.stream }) };
}

function buildLoggedApp(sink) {
  return buildTestApp({ logger: { level: 'info', stream: sink.stream } });
}

function hasText(texts, fragment) {
  return texts.some((text) => text.includes(fragment));
}

function findLine(lines, message) {
  return lines.find((line) => line.msg === message);
}

// Fastify writes "request completed" after the onResponse hooks, and they may end later than inject() resolves.
async function waitForLine(lines, message, ticks = WAIT_TICKS) {
  const line = findLine(lines, message);

  if (line || ticks === 0) {
    return line;
  }

  await waitForTick();

  return waitForLine(lines, message, ticks - 1);
}

describe('createLogger', () => {
  test('requires a level', () => {
    assert.throws(() => createLogger(), /requires a log level/);
    assert.throws(() => createLogger({}), /requires a log level/);
  });

  test('rejects a level pino does not know', () => {
    assert.throws(() => createLogger({ level: 'loud' }));
  });

  test('creates a pino logger with the given level', () => {
    const logger = createLogger({ level: 'warn' });

    assert.equal(logger.level, 'warn');
    assert.equal(logger.isLevelEnabled('info'), false);
    assert.equal(logger.isLevelEnabled('error'), true);
    assert.equal(typeof logger.child, 'function');
  });

  test('creates separate instances', () => {
    assert.notEqual(createLogger({ level: 'silent' }), createLogger({ level: 'silent' }));
  });

  test('rejects isPretty together with a stream: pino would drop the stream without a word', () => {
    const { stream } = createLogSink();

    assert.throws(() => createLogger({ level: 'info', isPretty: true, stream }), TypeError);
    assert.doesNotThrow(() => createLogger({ level: 'info', isPretty: false, stream }));
  });

  test('writes every call as one line of JSON', () => {
    const { log, texts } = createTestLogger();

    log.info({ userId: 5 }, 'User created');
    log.error({ err: new Error('Mail provider is down') }, 'Notification failed');

    assert.equal(texts.length, 2);
    texts.forEach((text) => assert.equal(text.indexOf('\n'), text.length - 1));

    const [created, failed] = texts.map((text) => JSON.parse(text));

    assert.equal(created.level, LEVEL.INFO);
    assert.equal(created.userId, 5);
    assert.equal(created.msg, 'User created');
    assert.equal(failed.level, LEVEL.ERROR);
    assert.equal(failed.msg, 'Notification failed');
    assert.equal(failed.err.message, 'Mail provider is down');
  });

  test('writes the lines of its level and above', () => {
    const { log, lines } = createTestLogger('warn');

    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach((level) => log[level](`Written at ${level}`));

    assert.deepEqual(lines.map((line) => [line.level, line.msg]), [
      [LEVEL.WARN, 'Written at warn'],
      [LEVEL.ERROR, 'Written at error'],
      [LEVEL.FATAL, 'Written at fatal'],
    ]);
  });

  test('writes nothing at the level "silent"', () => {
    const { log, lines } = createTestLogger('silent');

    log.error({ err: new Error('Mail provider is down') }, 'Notification failed');
    log.fatal('Out of memory');

    assert.deepEqual(lines, []);
  });
});

describe('createLogger: err serializer', () => {
  test('drops the sql of a driver error and keeps what identifies it', () => {
    const { log, lines, texts } = createTestLogger();

    log.error({ err: createDriverError() }, 'Query failed');

    const [{ err }] = lines;

    assert.equal(Object.hasOwn(err, 'sql'), false);
    assert.equal(hasText(texts, STATEMENT_START), false);
    assert.equal(err.type, 'Error');
    assert.equal(err.code, 'ER_DUP_ENTRY');
    assert.equal(err.errno, 1062);
    assert.equal(err.sqlState, '23000');
  });

  test('masks the duplicate value in the message, the stack and sqlMessage', () => {
    const { log, lines, texts } = createTestLogger();

    log.error({ err: createDriverError() }, 'Query failed');

    const [{ err }] = lines;

    assert.equal(err.message, MASKED_MESSAGE);
    assert.equal(err.sqlMessage, MASKED_MESSAGE);
    assert.equal(err.stack.split('\n')[0], `Error: ${MASKED_MESSAGE}`);
    assert.match(err.stack, /\n\s+at /);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
  });

  test('leaves the error it logs untouched', () => {
    const { log } = createTestLogger();
    const error = createDriverError();
    const before = snapshotError(error);

    log.error({ err: error }, 'Query failed');
    log.error({ err: error });
    log.error(error);

    assert.deepEqual(snapshotError(error), before);
  });

  test('logs an AppError without its validation list and with its cookie hidden', () => {
    const { log, lines, texts } = createTestLogger();

    log.warn({ err: createValidationError() }, 'Request failed');

    const [{ err }] = lines;

    assert.equal(err.type, 'AppError');
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.statusCode, 422);
    assert.equal(err.message, 'Validation error');
    assert.equal(Object.hasOwn(err, 'validation'), false);
    assert.deepEqual(err.headers, { 'set-cookie': HIDDEN, 'retry-after': '30' });
    assert.equal(hasText(texts, 'hunter2'), false);
    assert.equal(hasText(texts, 'attempt=1f9a'), false);
  });

  test('keeps the validation and the headers of the AppError itself: the response is built from them', () => {
    const { log } = createTestLogger();
    const error = createValidationError();

    log.warn({ err: error }, 'Request failed');

    assert.deepEqual(error.validation, [{
      column: 'password',
      columnValue: 'hunter2',
      operator: 'minLength',
      operatorValue: 8,
    }]);
    assert.deepEqual(error.headers, { 'set-cookie': 'attempt=1f9a; Path=/', 'retry-after': '30' });
  });

  test('logs the cause as an error of its own: no sql, masked texts', () => {
    const { log, lines, texts } = createTestLogger();

    log.warn({ err: new AppError(ERROR_CODE.VALIDATION_ERROR, { cause: createDriverError() }) }, 'Request failed');

    const [{ err }] = lines;

    assert.equal(err.message, 'Validation error');
    assert.equal(err.cause.type, 'Error');
    assert.equal(err.cause.message, MASKED_MESSAGE);
    assert.equal(err.cause.sqlMessage, MASKED_MESSAGE);
    assert.equal(err.cause.code, 'ER_DUP_ENTRY');
    assert.equal(Object.hasOwn(err.cause, 'sql'), false);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(texts, STATEMENT_START), false);
  });

  test('gives an error without a cause no cause in the log', () => {
    const { log, lines } = createTestLogger();

    log.warn({ err: new AppError(ERROR_CODE.NO_CHANGES) }, 'Request failed');

    assert.deepEqual(Object.keys(lines[0].err), ['type', 'message', 'stack', 'code', 'statusCode']);
    assert.equal(lines[0].err.type, 'AppError');
  });

  test('serializes the members of an AggregateError', () => {
    const { log, lines, texts } = createTestLogger();
    const error = new AggregateError([createDriverError(), new Error('Mail provider is down')], 'Sign-up failed');

    log.error({ err: error }, 'Request failed');

    const [{ err }] = lines;
    const [duplicate, other] = err.aggregateErrors;

    assert.equal(err.type, 'AggregateError');
    assert.equal(err.message, 'Sign-up failed');
    assert.equal(duplicate.type, 'Error');
    assert.equal(duplicate.message, MASKED_MESSAGE);
    assert.equal(duplicate.sqlMessage, MASKED_MESSAGE);
    assert.equal(duplicate.code, 'ER_DUP_ENTRY');
    assert.equal(Object.hasOwn(duplicate, 'sql'), false);
    assert.equal(other.message, 'Mail provider is down');
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(texts, STATEMENT_START), false);
  });

  test('serializes an error held in a property of the error', () => {
    const { log, lines, texts } = createTestLogger();

    log.error({ err: Object.assign(new Error('Sign-up failed'), { original: createDriverError() }) }, 'Request failed');

    const [{ err }] = lines;

    assert.equal(err.message, 'Sign-up failed');
    assert.equal(err.original.type, 'Error');
    assert.equal(err.original.message, MASKED_MESSAGE);
    assert.equal(err.original.sqlMessage, MASKED_MESSAGE);
    assert.equal(err.original.code, 'ER_DUP_ENTRY');
    assert.equal(Object.hasOwn(err.original, 'sql'), false);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(texts, STATEMENT_START), false);
  });

  test('cleans an AppError held by another error the same way', () => {
    const { log, lines, texts } = createTestLogger();
    const error = Object.assign(new AggregateError([createValidationError()], 'Sign-up failed'), { original: createValidationError() });

    log.error({ err: error }, 'Request failed');

    const [{ err }] = lines;

    [err.original, err.aggregateErrors[0]].forEach((nested) => {
      assert.equal(nested.type, 'AppError');
      assert.equal(Object.hasOwn(nested, 'validation'), false);
      assert.deepEqual(nested.headers, { 'set-cookie': HIDDEN, 'retry-after': '30' });
    });
    assert.equal(hasText(texts, 'hunter2'), false);
    assert.equal(hasText(texts, 'attempt=1f9a'), false);
  });

  test('serializes an error inside an array of the error like any other: no sql, masked texts', () => {
    const { log, lines, texts } = createTestLogger();
    const error = Object.assign(new Error('Import failed'), { failures: [createDriverError(), [new TypeError(DUPLICATE_MESSAGE)]] });

    log.error({ err: error }, 'Request failed');

    const [failure, [nested]] = lines[0].err.failures;

    assert.equal(failure.type, 'Error');
    assert.equal(failure.message, MASKED_MESSAGE);
    assert.equal(failure.sqlMessage, MASKED_MESSAGE);
    assert.equal(failure.code, 'ER_DUP_ENTRY');
    assert.equal(failure.stack.split('\n')[0], `Error: ${MASKED_MESSAGE}`);
    assert.equal(Object.hasOwn(failure, 'sql'), false);
    assert.equal(nested.type, 'TypeError');
    assert.equal(nested.message, MASKED_MESSAGE);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(texts, STATEMENT_START), false);
  });

  test('cleans an err that is not an error itself: a list of failures, a plain holder', () => {
    const { log, lines, texts } = createTestLogger();

    log.error({ err: [{ status: 'rejected', reason: createDriverError() }] }, 'Import failed');
    log.error({ err: { statusCode: 409, failure: createDriverError(), sql: STATEMENT_START } }, 'Import failed');

    assert.equal(lines[0].err[0].reason.message, MASKED_MESSAGE);
    assert.equal(lines[1].err.failure.sqlMessage, MASKED_MESSAGE);
    assert.equal(Object.hasOwn(lines[1].err, 'sql'), false);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(texts, STATEMENT_START), false);
  });

  test('masks the text of the driver under any key of what the error holds', () => {
    const { log, lines, texts } = createTestLogger();
    const error = Object.assign(new AggregateError([DUPLICATE_MESSAGE], 'Import failed'), {
      failures: [{ row: 3, error: DUPLICATE_MESSAGE }],
      reason: DUPLICATE_MESSAGE,
    });

    log.error({ err: error }, 'Request failed');

    const [{ err }] = lines;

    assert.deepEqual(err.failures, [{ row: 3, error: MASKED_MESSAGE }]);
    assert.equal(err.reason, MASKED_MESSAGE);
    assert.deepEqual(err.aggregateErrors, [MASKED_MESSAGE]);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
  });

  test('walks a class instance, what toJSON gives and an error of another realm instead of writing them as they are', () => {
    class RowFailure {
      constructor(row, error) {
        this.row = row;
        this.error = error;
        this.password = 'hunter2';
      }
    }

    const { log, lines, texts } = createTestLogger();
    const foreign = runInNewContext('Object.assign(new Error("Foreign"), { sql: "INSERT INTO foreign" })');
    const error = Object.assign(new Error('Import failed'), {
      failures: [new RowFailure(3, createDriverError())],
      details: { toJSON: () => ({ apiKey: 'abc', sql: STATEMENT_START, attempt: 2 }) },
      foreign,
      startedAt: new Date(0),
      source: new URL('https://example.com/import?token=abc'),
      payload: Buffer.from(DUPLICATE_VALUE),
      retry: () => {},
    });

    log.error({ err: error }, 'Request failed');

    const [{ err }] = lines;

    assert.equal(err.failures[0].row, 3);
    assert.equal(err.failures[0].password, HIDDEN);
    assert.equal(err.failures[0].error.message, MASKED_MESSAGE);
    assert.deepEqual(err.details, { apiKey: HIDDEN, attempt: 2 });
    assert.equal(err.foreign.message, 'Foreign');
    assert.equal(Object.hasOwn(err.foreign, 'sql'), false);
    assert.equal(err.startedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(err.source, 'https://example.com/import?token=abc');
    assert.equal(err.payload, '[Buffer of 16 bytes]');
    assert.equal(Object.hasOwn(err, 'retry'), false);
    assert.equal(hasText(texts, STATEMENT_START), false);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(texts, 'hunter2'), false);
  });

  test('reads what toJSON() gives like any other value: itself, another instance, an error, an object with a toJSON() of its own', () => {
    const holderPrototype = {
      toJSON() {
        return this;
      },
    };
    const wrapperPrototype = {
      toJSON() {
        return this.inner;
      },
    };

    function createHolder() {
      return Object.assign(Object.create(holderPrototype), { error: createDriverError(), password: 'hunter2' });
    }

    const { log, lines, texts } = createTestLogger();
    const chained = { toJSON: () => ({ attempt: 2, toJSON: () => ({ sql: STATEMENT_START, password: 'hunter2' }) }) };
    const error = Object.assign(new Error('Import failed'), {
      holder: createHolder(),
      wrapper: Object.assign(Object.create(wrapperPrototype), { inner: createHolder() }),
      asError: { toJSON: () => createDriverError() },
      asText: { toJSON: () => DUPLICATE_MESSAGE },
      chained,
    });

    log.error({ err: error }, 'Request failed');

    const [{ err }] = lines;

    [err.holder, err.wrapper].forEach((holder) => {
      assert.equal(holder.password, HIDDEN);
      assert.equal(holder.error.sqlMessage, MASKED_MESSAGE);
      assert.equal(Object.hasOwn(holder.error, 'sql'), false);
    });
    assert.equal(err.asError.message, MASKED_MESSAGE);
    assert.equal(Object.hasOwn(err.asError, 'sql'), false);
    assert.equal(err.asText, MASKED_MESSAGE);
    assert.deepEqual(err.chained, { attempt: 2 });
    assert.equal(hasText(texts, STATEMENT_START), false);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(texts, 'hunter2'), false);
  });

  test('replaces only the property whose getter throws, in the error and in what it holds', () => {
    const { log, lines } = createTestLogger();
    const details = Object.defineProperty({ attempt: 2 }, 'row', {
      enumerable: true,
      get() {
        throw new Error('The getter failed');
      },
    });

    log.error({ err: createHostileError() }, 'Query failed');
    log.error({ err: Object.assign(new Error('Deadlock'), { code: 'ER_LOCK_DEADLOCK', details }) }, 'Query failed');

    assert.equal(lines[0].err.code, 'ER_DUP_ENTRY');
    assert.equal(lines[0].err.details, '[unreadable]');
    assert.equal(lines[1].err.code, 'ER_LOCK_DEADLOCK');
    assert.equal(lines[1].err.details, '[unreadable]');
  });

  test('logs a frozen error whole', () => {
    const { log, lines, texts } = createTestLogger();
    const error = Object.assign(new Error('Sign-up failed'), { code: 'E_SIGN_UP', original: Object.freeze(createDriverError()) });

    log.error({ err: Object.freeze(error) }, 'Request failed');

    const [{ err }] = lines;

    assert.equal(err.code, 'E_SIGN_UP');
    assert.equal(err.original.errno, 1062);
    assert.equal(err.original.sqlMessage, MASKED_MESSAGE);
    assert.equal(hasText(texts, STATEMENT_START), false);
  });

  test('drops the sql and masks the value of a raw error held by a plain object of the error', () => {
    const { log, lines, texts } = createTestLogger();
    const error = Object.assign(new Error('Import failed'), {
      details: { failure: createDriverError() },
      results: [{ status: 'rejected', reason: createDriverError() }],
    });

    log.error({ err: error }, 'Request failed');

    const [{ err }] = lines;

    assert.equal(Object.hasOwn(err.details.failure, 'sql'), false);
    assert.equal(err.details.failure.message, MASKED_MESSAGE);
    assert.equal(err.details.failure.sqlMessage, MASKED_MESSAGE);
    assert.equal(err.results[0].status, 'rejected');
    assert.equal(err.results[0].reason.message, MASKED_MESSAGE);
    assert.equal(hasText(texts, STATEMENT_START), false);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
  });

  test('drops the sql and masks the text of driver fields copied into a plain object of the error', () => {
    const { log, lines, texts } = createTestLogger();
    const { sql, sqlMessage, code } = createDriverError();

    log.error({ err: Object.assign(new Error('Import failed'), { details: { sql, sqlMessage, code } }) }, 'Request failed');

    assert.deepEqual(lines[0].err.details, { sqlMessage: MASKED_MESSAGE, code: 'ER_DUP_ENTRY' });
    assert.equal(hasText(texts, STATEMENT_START), false);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
  });

  test('walks what an error holds once: a structure that holds itself ends in a placeholder', () => {
    const { log, lines } = createTestLogger();
    const details = { name: 'import', items: [] };

    details.self = details;
    details.items.push(details);

    log.error({ err: Object.assign(new Error('Import failed'), { details }) }, 'Request failed');

    assert.deepEqual(lines[0].err.details, { name: 'import', items: ['[repeated]'], self: '[repeated]' });
  });

  test('cuts what an error holds at the depth ceiling of the masking walk, arrays included', () => {
    const { log, lines } = createTestLogger();
    const deep = Array.from({ length: 20 }).reduce((inner) => ({ inner }), { isBottom: true });
    const deepList = Array.from({ length: 20 }).reduce((inner) => [inner], [createDriverError()]);

    log.error({ err: Object.assign(new Error('Import failed'), { deep, deepList }) }, 'Request failed');

    const [{ err }] = lines;

    assert.equal(JSON.stringify(err.deep), `${'{"inner":'.repeat(11)}"[depth limit]"${'}'.repeat(11)}`);
    assert.equal(JSON.stringify(err.deepList), `${'['.repeat(11)}"[depth limit]"${']'.repeat(11)}`);
  });

  test('cuts the query string out of the errors Fastify builds from the raw URL', () => {
    const { log, lines, texts } = createTestLogger();
    const badUrl = Object.assign(new Error("'/files/%FF?token=query-secret' is not a valid url component"), { code: 'FST_ERR_BAD_URL' });
    const sentTwice = Object.assign(
      new Error('Reply was already sent, did you forget to "return reply" in "/twice?token=query-secret" (GET)?'),
      { code: 'FST_ERR_REP_ALREADY_SENT' },
    );

    log.warn({ err: badUrl }, 'Request failed');
    log.warn({ err: sentTwice }, 'Reply was already sent');

    const [firstLine, ...frames] = lines[0].err.stack.split('\n');

    assert.equal(lines[0].err.message, "'/files/%FF…");
    assert.equal(firstLine, "Error: '/files/%FF…");
    assert.ok(frames.length > 0);
    assert.equal(lines[1].err.message, 'Reply was already sent, did you forget to "return reply" in "/twice…');
    assert.equal(hasText(texts, 'query-secret'), false);
  });

  // @fastify/error assigns the message in its constructor: there it is an own enumerable property.
  test('cuts the query string out of the errors Fastify really builds, whose message is a property of their own', () => {
    const { log, lines, texts } = createTestLogger();

    log.warn({ err: new errorCodes.FST_ERR_BAD_URL('/files/%FF?token=query-secret') }, 'Request failed');
    log.warn({ err: new errorCodes.FST_ERR_REP_ALREADY_SENT('/twice?token=query-secret', 'GET') }, 'Reply was already sent');

    const [{ err: badUrl }, { err: sentTwice }] = lines;
    const [firstLine, ...frames] = badUrl.stack.split('\n');

    assert.equal(badUrl.type, 'FastifyError');
    assert.equal(badUrl.message, "'/files/%FF…");
    assert.match(firstLine, /^FastifyError.*'\/files\/%FF…$/);
    assert.ok(frames.length > 0);
    assert.equal(badUrl.code, 'FST_ERR_BAD_URL');
    assert.equal(badUrl.statusCode, 400);
    assert.equal(sentTwice.message, 'Reply was already sent, did you forget to "return reply" in "/twice…');
    assert.equal(hasText(texts, 'query-secret'), false);
  });

  test('keeps the type, the message and the stack it built when the error has properties of the same names', () => {
    const { log, lines } = createTestLogger();
    const error = Object.assign(new TypeError('Real message'), { type: 'fake', stack: 'fake stack', message: 'Own message' });

    log.error({ err: error }, 'Request failed');

    assert.deepEqual(Object.keys(lines[0].err), ['type', 'message', 'stack']);
    assert.equal(lines[0].err.type, 'TypeError');
    assert.equal(lines[0].err.message, 'Own message');
    assert.equal(lines[0].err.stack, 'fake stack');
  });

  test('cuts only the first line of a stack: a frame of a module imported with a query keeps its position', () => {
    const { log, lines } = createTestLogger();
    const error = Object.assign(new Error("'/a?b=1' is not a valid url component"), { code: 'FST_ERR_BAD_URL' });

    error.stack = "Error: '/a?b=1' is not a valid url component\n    at load (file:///app/src/plugin.js?v=3:10:5)";
    log.warn({ err: error }, 'Request failed');

    assert.equal(lines[0].err.stack, "Error: '/a…\n    at load (file:///app/src/plugin.js?v=3:10:5)");
  });

  test('keeps a message that is not a text as it is, also on an error whose text it would cut', () => {
    const { log, lines } = createTestLogger();
    const error = Object.assign(new Error('placeholder'), { code: 'FST_ERR_BAD_URL', message: { path: '/a' } });

    log.warn({ err: error }, 'Request failed');

    assert.deepEqual(lines[0].err.message, { path: '/a' });
    assert.equal(lines[0].err.code, 'FST_ERR_BAD_URL');
  });

  test('writes the name and the code of a DOMException: they tell a timeout of fetch from an abort', () => {
    const { log, lines } = createTestLogger();

    log.error({ err: new DOMException('The operation was aborted due to timeout', 'TimeoutError') }, 'Upstream failed');
    log.error({ err: new DOMException('This operation was aborted', 'AbortError') }, 'Upstream failed');

    assert.deepEqual(lines.map(({ err }) => [err.type, err.name, err.code]), [
      ['DOMException', 'TimeoutError', 23],
      ['DOMException', 'AbortError', 20],
    ]);
    assert.equal(lines[0].err.message, 'The operation was aborted due to timeout');
  });

  test('adds no second list for an error whose "errors" is an enumerable property', () => {
    const { log, lines } = createTestLogger();

    log.error({ err: Object.assign(new Error('Import failed'), { errors: [1, 2] }) }, 'Request failed');

    assert.deepEqual(Object.keys(lines[0].err), ['type', 'message', 'stack', 'errors']);
  });

  test('masks the text of the driver in the key of an entry too', () => {
    const { log, lines, texts } = createTestLogger();
    const error = Object.assign(new Error('Import failed'), {
      countByReason: { [DUPLICATE_MESSAGE]: 2, 'Unknown column': 1 },
      rows: [{ [`row: ${DUPLICATE_MESSAGE}`]: 3 }],
    });

    log.error({ err: error }, 'Request failed');

    assert.deepEqual(Object.keys(lines[0].err.countByReason), [MASKED_MESSAGE, 'Unknown column']);
    assert.deepEqual(Object.keys(lines[0].err.rows[0]), [`row: ${MASKED_MESSAGE}`]);
    assert.equal(lines[0].err.countByReason['Unknown column'], 1);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
  });

  test('reads a list, a text, nothing, a typed array or a function from toJSON(), and unboxes a text', () => {
    const { log, lines, texts } = createTestLogger();
    const callable = Object.assign(() => {}, { toJSON: () => ({ sql: STATEMENT_START, password: 'hunter2' }) });
    const error = Object.assign(new Error('Import failed'), {
      asList: { toJSON: () => [{ token: 'abc' }, 2] },
      asNothing: new Date(Number.NaN),
      asBytes: { toJSON: () => Buffer.from(DUPLICATE_VALUE) },
      asFunction: { toJSON: () => callable },
      // eslint-disable-next-line no-new-wrappers -- the wrapper object is the case under test
      boxed: new String(DUPLICATE_MESSAGE),
    });

    log.error({ err: error }, 'Request failed');

    const [{ err }] = lines;

    assert.deepEqual(err.asList, [{ token: HIDDEN }, 2]);
    assert.equal(err.asNothing, null);
    assert.equal(err.asBytes, '[Buffer of 16 bytes]');
    assert.equal(Object.hasOwn(err, 'asFunction'), false);
    assert.equal(err.boxed, MASKED_MESSAGE);
    assert.equal(hasText(texts, STATEMENT_START), false);
    assert.equal(hasText(texts, 'hunter2'), false);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
  });

  test('leaves the question mark of any other error alone', () => {
    const { log, lines } = createTestLogger();

    log.error({ err: new Error('Why did GET /items?page=2 fail?') }, 'Request failed');

    assert.equal(lines[0].err.message, 'Why did GET /items?page=2 fail?');
  });

  test('leaves no mark on an error it logged, so the error is logged whole the next time', () => {
    const { log, lines } = createTestLogger();
    const inner = Object.assign(new Error('Inner'), { entry: Object.freeze({ message: 'Server error', statusCode: 500 }) });

    log.error({ err: inner }, 'First');
    log.error({ err: Object.assign(new Error('Outer'), { inner }) }, 'Second');

    assert.deepEqual(Object.getOwnPropertySymbols(inner), []);
    assert.deepEqual(Object.keys(inner), ['entry']);
    assert.equal(lines[0].err.message, 'Inner');
    assert.equal(lines[1].err.message, 'Outer');
    assert.equal(lines[1].err.inner.message, 'Inner');
    assert.deepEqual(lines[1].err.inner.entry, { message: 'Server error', statusCode: 500 });
  });

  test('masks a string under err', () => {
    const { log, lines } = createTestLogger();

    log.error({ err: DUPLICATE_MESSAGE }, 'Query failed');

    assert.equal(lines[0].err, MASKED_MESSAGE);
    assert.equal(lines[0].msg, 'Query failed');
  });

  test('accepts null and a plain object under err', () => {
    const { log, lines } = createTestLogger();

    log.error({ err: null }, 'Nothing was thrown');
    log.error({ err: { reason: 'Timeout', token: 'abc' } }, 'An object was thrown');

    assert.deepEqual(lines.map((line) => line.msg), ['Nothing was thrown', 'An object was thrown']);
    assert.deepEqual(lines[1].err, { reason: 'Timeout', token: HIDDEN });
  });

  test('still writes the line of a frozen error', () => {
    const { log, lines, texts } = createTestLogger();

    log.error({ err: Object.freeze(createDriverError()) }, 'Query failed');

    assert.equal(lines.length, 1);
    assert.equal(lines[0].msg, 'Query failed');
    assert.equal(lines[0].err.message, MASKED_MESSAGE);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(texts, STATEMENT_START), false);
  });

  test('still writes the line of an error with a throwing getter', () => {
    const { log, lines, texts } = createTestLogger();

    log.error({ err: createHostileError() }, 'Query failed');

    assert.equal(lines.length, 1);
    assert.equal(lines[0].msg, 'Query failed');
    assert.equal(lines[0].err.message, MASKED_MESSAGE);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(texts, STATEMENT_START), false);
  });

  test('hides sensitive keys at any depth of the properties of an error', () => {
    const { log, lines } = createTestLogger();
    const error = Object.assign(new Error('Upstream failed'), {
      token: 'abc',
      headers: { authorization: 'Bearer abc', 'content-range': 'bytes */10' },
      details: { apiKey: 'abc', attempts: [{ password: 'qwerty', index: 1 }] },
    });

    log.error({ err: error }, 'Request failed');

    const [{ err }] = lines;

    assert.equal(err.token, HIDDEN);
    assert.deepEqual(err.headers, { authorization: HIDDEN, 'content-range': 'bytes */10' });
    assert.deepEqual(err.details, { apiKey: HIDDEN, attempts: [{ password: HIDDEN, index: 1 }] });
  });

  test('masks a duplicate value that holds the text of the message before a line break', () => {
    const { log, texts } = createTestLogger();

    log.error({ err: createDriverError("o'brien' for key 'x'\nsecond line of the value") });

    assert.equal(hasText(texts, 'second line of the value'), false);
  });
});

describe('createLogger: msg serializer', () => {
  test('masks the message pino copies from the error', () => {
    const { log, lines, texts } = createTestLogger();
    const error = createDriverError();

    log.error({ err: error });
    log.error(error);
    log.error({ err: error }, error.message);

    assert.deepEqual(lines.map((line) => line.msg), [MASKED_MESSAGE, MASKED_MESSAGE, MASKED_MESSAGE]);
    assert.deepEqual(texts.map((text) => text.includes(DUPLICATE_VALUE)), [false, false, false]);
  });

  test('masks the copy of a message that is not a text the way the error itself is masked', () => {
    const { log, lines, texts } = createTestLogger();
    const upstream = Object.assign(new Error('placeholder'), { message: { error: 'invalid_grant', refresh_token: 'hunter2', sql: STATEMENT_START } });

    log.error({ err: { status: 422, message: { email: [DUPLICATE_MESSAGE], password: 'hunter2' } } });
    log.error(upstream);
    log.error({ err: { message: [DUPLICATE_MESSAGE] } });

    assert.deepEqual(lines.map((line) => line.msg), [
      { email: [MASKED_MESSAGE], password: HIDDEN },
      { error: 'invalid_grant', refresh_token: HIDDEN },
      [MASKED_MESSAGE],
    ]);
    assert.equal(hasText(texts, 'hunter2'), false);
    assert.equal(hasText(texts, STATEMENT_START), false);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
  });

  test('masks an interpolated message and a msg key of the merge object', () => {
    const { log, lines, texts } = createTestLogger();
    const error = createDriverError();

    log.error('Insert failed: %s', error.message);
    log.error({ err: error, msg: error.message });
    log.error({ err: error, msg: error.message }, 'Insert failed');

    assert.equal(lines[0].msg, `Insert failed: ${MASKED_MESSAGE}`);
    assert.equal(lines[1].msg, MASKED_MESSAGE);
    assert.deepEqual(texts.map((text) => text.includes(DUPLICATE_VALUE)), [false, false, false]);
  });

  test('leaves a message without a database value as it is', () => {
    const { log, lines } = createTestLogger();

    log.info('User 5 created');
    log.error({ err: new Error('Mail provider is down') });

    assert.deepEqual(lines.map((line) => line.msg), ['User 5 created', 'Mail provider is down']);
  });
});

describe('createLogger: merge object', () => {
  test('hides sensitive keys of what is not a plain object: an instance at the top, in a key, inside another instance', () => {
    const { log, lines, texts } = createTestLogger();
    const createInstance = (fields) => Object.assign(Object.create({ describe: () => 'instance' }), fields);
    const config = createInstance({ host: '127.0.0.1', password: 'hunter2' });

    log.info({ db: config }, 'Connected');
    log.info({ pool: createInstance({ config: createInstance({ host: '127.0.0.1', password: 'hunter2' }), size: 10 }) }, 'Connected');
    log.info(config, 'Connected');

    assert.deepEqual(lines[0].db, { host: '127.0.0.1', password: HIDDEN });
    assert.deepEqual(lines[1].pool, { config: { host: '127.0.0.1', password: HIDDEN }, size: 10 });
    assert.equal(lines[2].host, '127.0.0.1');
    assert.equal(lines[2].password, HIDDEN);
    assert.equal(hasText(texts, 'hunter2'), false);
  });

  test('writes a date, a URL and a buffer of the merge object in their text form', () => {
    const { log, lines } = createTestLogger();

    log.info({ startedAt: new Date(0), source: new URL('https://example.com/import'), payload: Buffer.from('abc') }, 'Import started');

    assert.equal(lines[0].startedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(lines[0].source, 'https://example.com/import');
    assert.equal(lines[0].payload, '[Buffer of 3 bytes]');
  });

  test('writes a merge object that cannot be read as one placeholder, not as its letters', () => {
    const { log, lines } = createTestLogger();
    const unreadable = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('The getter failed');
      },
    });

    log.info(unreadable, 'Import started');

    assert.equal(lines[0].msg, 'Import started');
    assert.equal(lines[0].mergingObject, '[unreadable]');
    assert.equal(Object.hasOwn(lines[0], '0'), false);
  });

  test('hides sensitive keys at any depth, inside arrays too', () => {
    const { log, lines } = createTestLogger();

    log.info({
      userId: 5,
      body: { email: 'anna@example.com', password: 'qwerty', profile: { apiKey: 'abc', name: 'Anna' } },
      items: [{ accessToken: 'abc', title: 'First' }, 'text', 5],
    }, 'Request body');

    const [line] = lines;

    assert.equal(line.userId, 5);
    assert.deepEqual(line.body, { email: 'anna@example.com', password: HIDDEN, profile: { apiKey: HIDDEN, name: 'Anna' } });
    assert.deepEqual(line.items, [{ accessToken: HIDDEN, title: 'First' }, 'text', 5]);
  });

  test('hides sensitive keys of a dictionary built on a prototype without a prototype, as request.query is', () => {
    const { log, lines } = createTestLogger();
    const query = Object.assign(Object.create(Object.create(null)), { page: '2', token: 'abc' });

    log.info({ query }, 'Request query');

    assert.deepEqual(lines[0].query, { page: '2', token: HIDDEN });
  });

  test('keeps null as null, under a sensitive key too', () => {
    const { log, lines } = createTestLogger();

    log.info({ deletedAt: null, token: null, items: [null, { secret: null }] }, 'User loaded');

    const [line] = lines;

    assert.equal(line.deletedAt, null);
    assert.equal(line.token, null);
    assert.deepEqual(line.items, [null, { secret: null }]);
  });

  test('hands the error over to the err serializer as it is', () => {
    const { log, lines } = createTestLogger();

    log.error({ err: createDriverError(), body: { password: 'qwerty' } }, 'Query failed');

    const [line] = lines;

    assert.equal(line.err.type, 'Error');
    assert.equal(line.err.message, MASKED_MESSAGE);
    assert.equal(line.err.code, 'ER_DUP_ENTRY');
    assert.deepEqual(line.body, { password: HIDDEN });
  });

  test('cleans an error under any other key the way it is cleaned under err: no sql, masked texts', () => {
    const { log, lines, texts } = createTestLogger();

    log.error({
      failure: createDriverError(),
      failures: [createDriverError()],
      context: { err: createDriverError(), req: Object.assign(Object.create({ kind: 'job' }), { token: 'abc', attempt: 2 }) },
    }, 'Import failed');

    const [line] = lines;

    [line.failure, line.failures[0], line.context.err].forEach((failure) => {
      assert.equal(failure.type, 'Error');
      assert.equal(failure.message, MASKED_MESSAGE);
      assert.equal(failure.code, 'ER_DUP_ENTRY');
      assert.equal(Object.hasOwn(failure, 'sql'), false);
    });
    assert.deepEqual(line.context.req, { token: HIDDEN, attempt: 2 });
    assert.equal(hasText(texts, STATEMENT_START), false);
    assert.equal(hasText(texts, DUPLICATE_VALUE), false);
  });
});

describe('createLogger: req and res serializers', () => {
  test('logs the method, the path, the host and the address of a request, and nothing else', () => {
    const { log, lines, texts } = createTestLogger();
    const request = {
      method: 'GET',
      url: `/api/v1/auth/callback?code=${QUERY_SECRET}&state=xyz`,
      host: 'app.test',
      ip: '203.0.113.7',
      headers: { cookie: 'sid=1f9a' },
      body: { password: 'qwerty' },
    };

    log.info({ req: request }, 'incoming request');

    assert.deepEqual(lines[0].req, {
      method: 'GET',
      url: '/api/v1/auth/callback',
      host: 'app.test',
      remoteAddress: '203.0.113.7',
    });
    assert.equal(hasText(texts, QUERY_SECRET), false);
  });

  test('cuts the url at the first question mark', () => {
    const { log, lines } = createTestLogger();

    ['/users?token=abc', '/users?next=/a?b=1', '/users?', '/users', '?token=abc'].forEach((url) => log.info({ req: { url } }, 'incoming request'));

    assert.deepEqual(lines.map((line) => line.req.url), ['/users', '/users', '/users', '/users', '']);
  });

  test('does not throw on a value that is not a request', () => {
    const { log, lines } = createTestLogger();

    log.info({ req: null }, 'No request');
    log.info({ req: 'GET /users' }, 'A string');
    log.info({ req: {} }, 'An empty object');

    assert.deepEqual(lines.map((line) => line.msg), ['No request', 'A string', 'An empty object']);
  });

  test('logs the status code of a reply and nothing else', () => {
    const { log, lines } = createTestLogger();
    const reply = { statusCode: 201, headers: { 'set-cookie': 'sid=1f9a' }, raw: { body: 'text' } };

    log.info({ res: reply }, 'request completed');

    assert.deepEqual(lines[0].res, { statusCode: 201 });
  });

  test('does not throw on a value that is not a reply', () => {
    const { log, lines } = createTestLogger();

    log.info({ res: null }, 'No reply');
    log.info({ res: 'text' }, 'A string');
    log.info({ res: {} }, 'An empty object');

    assert.deepEqual(lines.map((line) => line.msg), ['No reply', 'A string', 'An empty object']);
  });
});

describe('serializeError', () => {
  test('gives an error of Fastify its type and its stack: it is an Error by its prototype only', () => {
    const serialized = serializeError(new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE('text/x-custom'));

    assert.equal(serialized.type, 'FastifyError');
    assert.equal(serialized.message, 'Unsupported Media Type text/x-custom');
    assert.ok(serialized.stack.split('\n').length > 1);
    assert.equal(serialized.code, 'FST_ERR_CTP_INVALID_MEDIA_TYPE');
    assert.equal(serialized.statusCode, 415);
  });

  test('calls an error without a constructor an Error and still writes what it says', () => {
    const serialized = serializeError(Object.setPrototypeOf(new Error('No prototype'), null));

    assert.equal(serialized.type, 'Error');
    assert.equal(serialized.message, 'No prototype');
    assert.match(serialized.stack, /^Error: No prototype\n/);
  });

  test('returns plain objects without sql, for the nested errors too', () => {
    const error = Object.assign(new AggregateError([createDriverError()], 'Import failed'), { original: createDriverError() });
    const serialized = serializeError(error);

    assert.equal(serialized.type, 'AggregateError');
    assert.equal(serialized.message, 'Import failed');

    [serialized, serialized.original, serialized.aggregateErrors[0]].forEach((item) => {
      assert.equal(Object.getPrototypeOf(item), Object.prototype);
      assert.equal(Object.hasOwn(item, 'sql'), false);
    });
    assert.equal(serialized.original.message, MASKED_MESSAGE);
    assert.equal(serialized.aggregateErrors[0].message, MASKED_MESSAGE);
  });

  test('masks a string and returns what is not an error as it is', () => {
    assert.equal(serializeError(DUPLICATE_MESSAGE), MASKED_MESSAGE);
    assert.equal(serializeError('Timeout'), 'Timeout');
    assert.equal(serializeError(null), null);
    assert.equal(serializeError(undefined), undefined);
    assert.equal(serializeError(42), 42);
    assert.deepEqual(serializeError({ reason: 'Timeout' }), { reason: 'Timeout' });
  });

  test('never throws: a frozen error and an error with a throwing getter keep their type, message and stack', () => {
    [Object.freeze(createDriverError()), createHostileError()].forEach((error) => {
      const serialized = serializeError(error);

      assert.equal(serialized.type, 'Error');
      assert.equal(serialized.message, MASKED_MESSAGE);
      assert.equal(serialized.stack.split('\n')[0], `Error: ${MASKED_MESSAGE}`);
      assert.equal(Object.hasOwn(serialized, 'sql'), false);
    });
  });

  test('never throws on an error that cannot be read or walked', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    const circular = [];

    revoke();
    circular.push(circular);

    [
      proxy,
      Object.seal(createDriverError()),
      Object.assign(new Error('Import failed'), { failures: circular }),
    ].forEach((error) => {
      assert.doesNotThrow(() => serializeError(error));
    });
  });
});

describe('buildApp: logger', () => {
  test('logs an incoming request without its query string, under the id of the request', async (t) => {
    const sink = createTextSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const response = await fastify.inject({
      url: `/api/v1/system/ping?token=${QUERY_SECRET}`,
      remoteAddress: '198.51.100.9',
      headers: { host: 'app.test' },
    });
    const incoming = findLine(sink.lines, 'incoming request');

    await waitForLine(sink.lines, 'request completed');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(incoming.req, {
      method: 'GET',
      url: '/api/v1/system/ping',
      host: 'app.test',
      remoteAddress: '198.51.100.9',
    });
    assert.equal(incoming.requestId, response.headers['x-request-id']);
    assert.equal(incoming.requestId, response.json().meta.requestId);
    assert.equal(Object.hasOwn(incoming, 'reqId'), false);
    assert.equal(hasText(sink.texts, QUERY_SECRET), false);
  });

  test('logs the incoming request of a bad URL without its query string, where no hook runs', async (t) => {
    const sink = createTextSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const response = await fastify.inject({ url: `/%FF?token=${QUERY_SECRET}` });
    const incoming = findLine(sink.lines, 'incoming request');

    assert.equal(response.statusCode, 400);
    assert.equal(incoming.req.url, '/%FF');
    assert.equal(incoming.requestId, response.headers['x-request-id']);
    assert.equal(findLine(sink.lines, 'Request failed').err.message, "'/%FF…");
    assert.equal(hasText(sink.texts, QUERY_SECRET), false);
  });

  test('logs the status code of the response when the request completes', async (t) => {
    const sink = createTextSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const response = await fastify.inject({ url: '/api/v1/system/ping' });
    const completed = await waitForLine(sink.lines, 'request completed');

    assert.deepEqual(completed?.res, { statusCode: 200 });
    assert.equal(completed.requestId, response.headers['x-request-id']);
  });

  test('logs the status code of an error response too', async (t) => {
    const sink = createTextSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const response = await fastify.inject({ url: '/api/v1/system/missing' });
    const completed = await waitForLine(sink.lines, 'request completed');

    assert.equal(response.statusCode, 404);
    assert.deepEqual(completed?.res, { statusCode: 404 });
  });

  test('logs the address of the client behind a private proxy', async (t) => {
    const sink = createTextSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    await fastify.inject({
      url: '/api/v1/system/ping',
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    assert.equal(findLine(sink.lines, 'incoming request').req.remoteAddress, '203.0.113.7');
  });

  test('hides sensitive keys of request.query and request.params in a line of a handler', async (t) => {
    const sink = createTextSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    fastify.get('/sessions/:sessionId', (request) => {
      request.log.info({ query: request.query, params: request.params }, 'Request parts');

      return { isLogged: true };
    });

    const response = await fastify.inject({ url: `/sessions/5f2b-session?page=2&token=${QUERY_SECRET}` });
    const parts = findLine(sink.lines, 'Request parts');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(parts.query, { page: '2', token: HIDDEN });
    assert.deepEqual(parts.params, { sessionId: HIDDEN });
    assert.equal(parts.requestId, response.headers['x-request-id']);
  });

  test('masks a driver error thrown by a handler in every line of the request', async (t) => {
    const sink = createTextSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    fastify.post('/users', async () => {
      throw createDriverError();
    });

    const response = await fastify.inject({ method: 'POST', url: '/users' });
    const completed = await waitForLine(sink.lines, 'request completed');
    const failed = findLine(sink.lines, 'Request failed');

    assert.equal(response.statusCode, 500);
    assert.equal(failed.err.message, MASKED_MESSAGE);
    assert.equal(failed.err.sqlMessage, MASKED_MESSAGE);
    assert.equal(failed.err.code, 'ER_DUP_ENTRY');
    assert.equal(Object.hasOwn(failed.err, 'sql'), false);
    assert.equal(failed.requestId, response.headers['x-request-id']);
    assert.equal(completed?.requestId, response.headers['x-request-id']);
    assert.equal(hasText(sink.texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(sink.texts, STATEMENT_START), false);
  });

  test('serializes through fastify.log outside a request as well', async (t) => {
    const sink = createTextSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    fastify.log.error({ err: createDriverError(), credentials: { password: 'qwerty' } });

    const line = sink.lines.find((item) => item.err);

    assert.equal(line.msg, MASKED_MESSAGE);
    assert.equal(line.err.message, MASKED_MESSAGE);
    assert.equal(Object.hasOwn(line.err, 'sql'), false);
    assert.equal(line.credentials, HIDDEN);
    assert.equal(hasText(sink.texts, DUPLICATE_VALUE), false);
    assert.equal(hasText(sink.texts, STATEMENT_START), false);
  });
});
