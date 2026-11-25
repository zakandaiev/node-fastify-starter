import { createUnavailableError, isDatabaseAway, readInTime } from '#core/auth/read.js';
import { createContext, findContext, runInContext } from '#core/context/index.js';
import { createOverloadError, DbError } from '#core/db/error.js';
import { createQuery } from '#core/db/query.js';
import { AppError } from '#core/error/index.js';
import { createLogger } from '#core/logger/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownDb } from '#root/tests/helper/db.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

const READ_TIMEOUT = '7s';
const READ_TIMEOUT_MS = 7000;

const PENDING = Symbol('pending');

// A read that a regression never gives up fails its test at this, instead of holding the run for ever.
const HANG_TIMEOUT_MS = 5000;

const UNAVAILABLE = Object.freeze({
  name: 'AppError',
  code: 'SERVICE_UNAVAILABLE_ERROR',
  statusCode: 503,
  message: 'Service unavailable',
});

const SILENT = Object.freeze({ kind: DB_ERROR_KIND.TIMEOUT, code: 'READ_TIMEOUT' });
const CONNECT_FAILURE = Object.freeze({ code: 'ECONNREFUSED', isConnectFailure: true });
const LOST_CONNECTION = Object.freeze({ code: 'PROTOCOL_CONNECTION_LOST', isFatal: true });
const MISSING_COLUMN = Object.freeze({ code: 'ER_BAD_FIELD_ERROR', errno: 1054, sqlState: '42S22' });
const LOCK_CONFLICT = Object.freeze({ kind: DB_ERROR_KIND.DEADLOCK, code: 'ER_LOCK_DEADLOCK', errno: 1213 });

const config = createTestConfig({ auth: { readTimeout: READ_TIMEOUT } });
const context = createContext({ config, log: createLogger(config.logger) });

function run(fn) {
  return runInContext(context, fn);
}

function peek(promise) {
  return Promise.race([promise, nextTurn(PENDING)]);
}

function mockTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  return t.mock.timers;
}

function failWith(error) {
  return async () => {
    throw error;
  };
}

function rejectionOfRead(read) {
  return rejectionOf(run(() => readInTime(read)));
}

function describeError({
  name,
  code,
  statusCode,
  message,
}) {
  return {
    name,
    code,
    statusCode,
    message,
  };
}

describe('readInTime', () => {
  test('gives what the read gives, and reads once, in the context of its caller', async () => {
    const row = { expiresAt: new Date(0) };
    const contexts = [];

    const result = await run(() => readInTime(async () => {
      contexts.push(findContext());

      return row;
    }));

    assert.equal(result, row);
    assert.deepEqual(contexts.map((seen) => seen === context), [true]);
  });

  test('gives null and false as the read gave them: no row is not a failure', async () => {
    assert.deepEqual(await Promise.all([null, false, []].map((result) => run(() => readInTime(() => result)))), [null, false, []]);
  });

  test('answers a read that has not settled by readTimeout with 503, a timeout of the database as its cause, which has an alert, and not a millisecond earlier', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const timers = mockTimers(t);
    const reading = rejectionOfRead(() => new Promise(() => {}));

    timers.tick(READ_TIMEOUT_MS - 1);

    assert.equal(await peek(reading), PENDING);

    timers.tick(1);

    const error = await reading;

    assert.ok(error instanceof AppError);
    assert.deepEqual(describeError(error), UNAVAILABLE);
    assert.ok(error.cause instanceof DbError);
    assert.deepEqual({ ...error.cause }, SILENT);
  });

  test('does not leave a read that fails after its deadline unhandled: that would end the process', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const onUnhandledRejection = t.mock.fn();
    const timers = mockTimers(t);
    const late = Promise.withResolvers();

    process.on('unhandledRejection', onUnhandledRejection);
    t.after(() => process.off('unhandledRejection', onUnhandledRejection));

    const reading = rejectionOfRead(() => late.promise);

    timers.tick(READ_TIMEOUT_MS);

    const error = await reading;

    late.reject(new DbError('late', LOST_CONNECTION));
    await nextTurn();

    assert.equal(error.cause.code, SILENT.code);
    assert.equal(onUnhandledRejection.mock.callCount(), 0);
  });

  test('answers a database whose connection does not open with 503 and the error of the database as its cause', async (t) => {
    const down = await createDownDb(t);
    const error = await rejectionOf(down.run(() => readInTime(() => createQuery('SELECT 1 AS one').execute())));

    assert.ok(error instanceof AppError);
    assert.deepEqual(describeError(error), UNAVAILABLE);
    assert.ok(error.cause instanceof DbError);
    assert.deepEqual({ code: error.cause.code, isConnectFailure: error.cause.isConnectFailure }, CONNECT_FAILURE);
  });

  test('answers a connection that did not open and one that was lost with 503, each with that very error as its cause', async () => {
    const causes = [CONNECT_FAILURE, LOST_CONNECTION].map((details) => new DbError('away', details));
    const errors = await Promise.all(causes.map((cause) => rejectionOfRead(failWith(cause))));

    assert.deepEqual(errors.map((error) => describeError(error)), [UNAVAILABLE, UNAVAILABLE]);
    assert.deepEqual(errors.map((error, index) => error.cause === causes[index]), [true, true]);
  });

  test('passes an AppError on as it is: the 503 of an overload keeps its own cause, and no other code becomes a 503', async () => {
    const overload = createOverloadError();
    const refusal = new AppError(ERROR_CODE.SESSION_REVOKED);
    const errors = await Promise.all([overload, refusal].map((error) => rejectionOfRead(failWith(error))));

    assert.equal(errors[0], overload);
    assert.equal(errors[0].cause.kind, DB_ERROR_KIND.OVERLOAD);
    assert.equal(errors[1], refusal);
  });

  test('rethrows what a database that is there refuses, and a bug of the read, as they are: they stay a 500', async () => {
    const errors = [
      new DbError('Unknown column', MISSING_COLUMN),
      new DbError('Deadlock found', LOCK_CONFLICT),
      new TypeError('a bug of the read'),
    ];
    const thrown = await Promise.all(errors.map((error) => rejectionOfRead(failWith(error))));

    assert.deepEqual(thrown.map((error, index) => error === errors[index]), [true, true, true]);
  });

  test('treats a read that throws at once as one that rejects', async () => {
    const bug = new TypeError('thrown before the first await');
    const lost = new DbError('lost', LOST_CONNECTION);

    assert.equal(await rejectionOfRead(() => {
      throw bug;
    }), bug);
    assert.equal((await rejectionOfRead(() => {
      throw lost;
    })).cause, lost);
  });

  test('requires a context, whose config names the deadline', async () => {
    await assert.rejects(readInTime(async () => null), /No active context/);
  });
});

describe('isDatabaseAway', () => {
  test('is true for an error of the database that says its connection did not open or was lost', () => {
    [CONNECT_FAILURE, LOST_CONNECTION, { ...CONNECT_FAILURE, isFatal: true }].forEach((details) => {
      assert.equal(isDatabaseAway(new DbError('away', details)), true, JSON.stringify(details));
    });
  });

  test('is false for what a database that is there has refused', () => {
    [{}, MISSING_COLUMN, LOCK_CONFLICT, { isFatal: null, isConnectFailure: null }].forEach((details) => {
      assert.equal(isDatabaseAway(new DbError('refused', details)), false, JSON.stringify(details));
    });
  });

  test('is false for an AppError, whatever stands behind it, and for what is no error of the database', () => {
    const others = [
      createOverloadError(),
      createUnavailableError(new DbError('lost', LOST_CONNECTION)),
      Object.assign(new Error('not of the database'), LOST_CONNECTION),
      { ...CONNECT_FAILURE },
      undefined,
      null,
    ];

    assert.deepEqual(others.map((error) => isDatabaseAway(error)), others.map(() => false));
  });
});

describe('createUnavailableError', () => {
  test('makes a 503 that keeps its cause for the alert', () => {
    const cause = new DbError('away', CONNECT_FAILURE);
    const error = createUnavailableError(cause);

    assert.ok(error instanceof AppError);
    assert.deepEqual(describeError(error), UNAVAILABLE);
    assert.equal(error.cause, cause);
  });
});
