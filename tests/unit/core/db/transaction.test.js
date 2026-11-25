import { createContext, runInContext } from '#core/context/index.js';
import { DbError } from '#core/db/error.js';
import {
  afterCommit,
  findTransaction,
  isInTransaction,
  retryOnLockConflict,
  withTransaction,
} from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { createLogger } from '#core/logger/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { ISOLATION_LEVEL } from '#enums/isolation-level.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownDb } from '#root/tests/helper/db.js';
import { createLogSink, LOG_LEVEL } from '#root/tests/helper/log.js';
import { isTimeoutError } from '#utils/async.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as nextLoop } from 'node:timers/promises';

const HANG_TIMEOUT_MS = 5000;

const config = createTestConfig();

function createPlainContext(logger = { level: 'silent' }) {
  return createContext({ config, log: createLogger(logger) });
}

function countTimers() {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

function createConflict() {
  return new DbError('Deadlock found when trying to get lock', { kind: DB_ERROR_KIND.DEADLOCK, code: 'ER_LOCK_DEADLOCK' });
}

// The driver is a stub here: a ROLLBACK or a START TRANSACTION that fails on a live connection cannot be staged.
// A step waits for its gate, when it has one, and then fails, when it has a failure.
function createStubDriver(failures = {}, gates = {}) {
  const calls = [];
  const aborted = [];
  const connection = {};

  async function step(name) {
    calls.push(name);
    await gates[name]?.promise;

    if (failures[name]) {
      throw failures[name];
    }
  }

  return {
    calls,
    aborted,
    connection,
    async withConnection(fn) {
      try {
        return await fn(connection);
      } finally {
        calls.push('release');
      }
    },
    begin: () => step('begin'),
    commit: () => step('commit'),
    rollback: () => step('rollback'),
    prepare: (sql) => sql,
    execute: (given, sql) => step(sql),
    destroy: () => calls.push('destroy'),
    abort(given) {
      calls.push('abort');
      aborted.push(given);
    },
  };
}

describe('withTransaction without a database', () => {
  test('requires a context', async () => {
    await assert.rejects(withTransaction(() => {}), /No active context/);
  });

  test('requires a function', async () => {
    const context = createPlainContext();

    await assert.rejects(runInContext(context, () => withTransaction()), /withTransaction\(fn, options\) requires a function/);
    await assert.rejects(runInContext(context, () => withTransaction({})), TypeError);
  });

  test('requires a database in the context', async () => {
    await assert.rejects(
      runInContext(createPlainContext(), () => withTransaction(() => {})),
      /withTransaction\(fn, options\) requires a database in the context/,
    );
  });

  test('rejects with the error of the connection and does not call the function when the database is down', async (t) => {
    const { db, run } = await createDownDb(t);
    let isCalled = false;

    await assert.rejects(run(() => withTransaction(() => {
      isCalled = true;
    }, { retry: true, isolation: ISOLATION_LEVEL.READ_COMMITTED })), (error) => error.code === 'ECONNREFUSED');

    assert.equal(isCalled, false);
    assert.equal(db.getStats().activeCount, 0);
  });
});

describe('withTransaction: options', () => {
  test('refuses an isolation level that is not in the list before it asks for a connection', async (t) => {
    const { db, run } = await createDownDb(t);
    const levels = ['READ COMITTED', 'serializable', 'SNAPSHOT', null, 5];
    const results = await Promise.allSettled(levels.map((isolation) => run(() => withTransaction(() => {}, { isolation }))));

    results.forEach((result) => {
      assert.ok(result.reason instanceof TypeError);
      assert.match(
        result.reason.message,
        /withTransaction\(fn, \{ isolation \}\) requires one of: READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ, SERIALIZABLE/,
      );
    });
    assert.equal(db.getStats().activeCount, 0);
  });

  test('refuses a "retry" that is not a boolean before it asks for a connection', async (t) => {
    const { db, run } = await createDownDb(t);
    const results = await Promise.allSettled([1, 'true', null, {}].map((retry) => run(() => withTransaction(() => {}, { retry }))));

    results.forEach((result) => {
      assert.ok(result.reason instanceof TypeError);
      assert.match(result.reason.message, /withTransaction\(fn, \{ retry \}\) requires a boolean/);
    });
    assert.equal(db.getStats().activeCount, 0);
  });
});

describe('withTransaction: a driver that fails', () => {
  function runWith(driver, fn, logger = { level: 'silent' }) {
    return runInContext(createContext({ config, log: createLogger(logger), db: { driver } }), fn);
  }

  test('commits and gives the connection back when nothing fails', async () => {
    const driver = createStubDriver();

    assert.equal(await runWith(driver, () => withTransaction(() => 'done')), 'done');
    assert.deepEqual(driver.calls, ['begin', 'commit', 'release']);
  });

  test('closes the connection when the transaction cannot be started, and does not call the function', async () => {
    const failure = new Error('begin failed');
    const driver = createStubDriver({ begin: failure });
    let isCalled = false;

    await assert.rejects(runWith(driver, () => withTransaction(() => {
      isCalled = true;
    })), (error) => error === failure);

    assert.equal(isCalled, false);
    assert.deepEqual(driver.calls, ['begin', 'destroy', 'release']);
  });

  test('closes the connection and logs an error when the rollback fails: the caller still gets its own error', async () => {
    const sink = createLogSink();
    const failure = new Error('boom');
    const driver = createStubDriver({ rollback: new Error('rollback failed') });

    await assert.rejects(runWith(driver, () => withTransaction(() => {
      throw failure;
    }), { level: 'error', stream: sink.stream }), (error) => error === failure);

    assert.deepEqual(driver.calls, ['begin', 'rollback', 'destroy', 'release']);
    assert.deepEqual(sink.lines.map((line) => [line.msg, line.err.message]), [
      ['Database transaction could not be rolled back: its connection is closed', 'rollback failed'],
    ]);
  });

  test('rejects with the own error of the function, which is not run again, also when that had swallowed a lock conflict', async () => {
    const failure = new Error('boom');
    const driver = createStubDriver({ 'SAVEPOINT sp_1': createConflict() });

    await assert.rejects(runWith(driver, () => withTransaction(async () => {
      await rejectionOf(withTransaction(() => 'never'));

      throw failure;
    }, { retry: true })), (error) => error === failure);

    assert.deepEqual(driver.calls, ['begin', 'SAVEPOINT sp_1', 'rollback', 'release']);
  });

  test('rolls back and rejects with the error of a commit that fails, and runs no callback', async () => {
    const failure = new Error('commit failed');
    const driver = createStubDriver({ commit: failure });
    const calls = [];

    await assert.rejects(runWith(driver, () => withTransaction(async () => {
      await afterCommit(() => calls.push('never'));
    })), (error) => error === failure);

    assert.deepEqual(driver.calls, ['begin', 'commit', 'rollback', 'release']);
    assert.deepEqual(calls, []);
  });
});

// The clock of the timers is a mock: a deadline passes when the test says so, and a call that should have settled and has
// not is a test that never ends, which the limit of the suite turns into a failure.
describe('withTransaction: the deadline', { timeout: HANG_TIMEOUT_MS }, () => {
  const DEADLINE = '25s';
  const DEADLINE_MS = 25_000;

  // The retry waits for no time at all, which is a timer too.
  const RETRY_MS = 1;

  const EXPIRED_CODE = 'TRANSACTION_TIMEOUT';
  const EXPIRED_MESSAGE = 'withTransaction(fn) was closed at its deadline, with nothing committed: fn had not settled, or a statement it had started';
  const NEVER = new Promise(() => {});

  const deadlineConfig = createTestConfig({ db: { transactionTimeout: DEADLINE } });

  function mockTimers(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    return t.mock.timers;
  }

  function transact(driver, fn, options, logger = { level: 'silent' }) {
    const context = createContext({ config: deadlineConfig, log: createLogger(logger), db: { driver } });

    return runInContext(context, () => withTransaction(fn, options));
  }

  // Lets a step that has no deadline take twice as long as one, and then opens its gate.
  async function passDeadline(timers, gate) {
    await nextLoop();
    timers.tick(2 * DEADLINE_MS);
    gate.resolve();
  }

  test('closes the connection once at config.db.transactionTimeout, not a millisecond earlier, and sends no ROLLBACK: the caller gets TRANSACTION_TIMEOUT', async (t) => {
    const timers = mockTimers(t);
    const sink = createLogSink();
    const driver = createStubDriver();
    const started = Promise.withResolvers();
    const running = transact(driver, () => {
      started.resolve();

      return NEVER;
    }, {}, { level: 'trace', stream: sink.stream });

    await started.promise;
    timers.tick(DEADLINE_MS - 1);
    await nextLoop();

    assert.deepEqual(driver.calls, ['begin']);

    timers.tick(1);

    const error = await rejectionOf(running);

    assert.ok(error instanceof DbError);
    assert.deepEqual({ ...error, message: error.message }, { code: EXPIRED_CODE, message: EXPIRED_MESSAGE });
    assert.deepEqual(driver.calls, ['begin', 'abort', 'release']);
    assert.equal(driver.aborted[0], driver.connection);
    assert.deepEqual(sink.lines, []);

    timers.tick(2 * DEADLINE_MS);
    await nextLoop();

    assert.deepEqual(driver.calls, ['begin', 'abort', 'release']);
  });

  test('tells who called it in the cause of the error, also when the function runs again, and the log writes that cause', async (t) => {
    const timers = mockTimers(t);
    const sink = createLogSink();
    const log = createLogger({ level: 'error', stream: sink.stream });
    const conflicts = [createConflict()];

    async function callThatHangs(fn, options) {
      await transact(createStubDriver(), fn, options);
    }

    async function conflictAndHang() {
      if (conflicts.length) {
        throw conflicts.shift();
      }

      await NEVER;
    }

    const running = [callThatHangs(() => NEVER), callThatHangs(conflictAndHang, { retry: true })].map((promise) => rejectionOf(promise));

    await nextLoop();
    timers.tick(RETRY_MS);
    await nextLoop();
    timers.tick(DEADLINE_MS);

    const errors = await Promise.all(running);

    errors.forEach((err) => log.error({ err }, 'Transaction failed'));

    assert.deepEqual(errors.map((error) => [error.code, isTimeoutError(error.cause)]), errors.map(() => [EXPIRED_CODE, true]));
    assert.equal(sink.lines.length, errors.length);
    [...errors, ...sink.lines.map((line) => line.err)].forEach(({ cause }) => assert.match(cause.stack, /callThatHangs/));
  });

  test('holds no process up: the timer of the deadline is not among what a process waits for', async (t) => {
    const driver = createStubDriver();
    const [started, resumed] = [Promise.withResolvers(), Promise.withResolvers()];
    const timers = countTimers();
    const running = transact(driver, () => {
      started.resolve();

      return resumed.promise;
    });

    t.after(() => resumed.resolve());
    await started.promise;

    assert.equal(countTimers(), timers);

    resumed.resolve('done');

    assert.equal(await running, 'done');
  });

  test('closes the connection once when it meets a nested call: that one has no deadline of its own', async (t) => {
    const timers = mockTimers(t);
    const driver = createStubDriver();
    const started = Promise.withResolvers();
    const running = transact(driver, () => withTransaction(() => {
      started.resolve();

      return NEVER;
    }));

    await started.promise;
    timers.tick(2 * DEADLINE_MS);

    assert.equal((await rejectionOf(running)).code, EXPIRED_CODE);
    assert.deepEqual(driver.calls, ['begin', 'SAVEPOINT sp_1', 'abort', 'release']);
  });

  test('ends the wait for a statement that is never answered, also for one the function has not awaited', async (t) => {
    const timers = mockTimers(t);
    const gates = { 'SAVEPOINT sp_1': Promise.withResolvers() };
    const [awaiting, careless] = [createStubDriver({}, gates), createStubDriver({}, gates)];
    const running = [
      transact(awaiting, () => withTransaction(() => 'never')),
      transact(careless, () => {
        withTransaction(() => 'never');

        return 'done';
      }),
    ].map((promise) => rejectionOf(promise));

    await nextLoop();
    timers.tick(DEADLINE_MS);

    const errors = await Promise.all(running);

    assert.deepEqual(errors.map((error) => error.code), [EXPIRED_CODE, EXPIRED_CODE]);
    [awaiting, careless].forEach((driver) => {
      assert.deepEqual(driver.calls, ['begin', 'SAVEPOINT sp_1', 'abort', 'release']);
    });
  });

  test('leaves the connection alone once the function has settled in time: it is back in the pool when the deadline passes', async (t) => {
    const timers = mockTimers(t);
    const failure = new Error('fn failed');
    const committed = createStubDriver();
    const rolledBack = createStubDriver();

    assert.equal(await transact(committed, () => 'done'), 'done');
    assert.equal(await rejectionOf(transact(rolledBack, async () => {
      throw failure;
    })), failure);

    timers.tick(2 * DEADLINE_MS);
    await nextLoop();

    assert.deepEqual(committed.calls, ['begin', 'commit', 'release']);
    assert.deepEqual(rolledBack.calls, ['begin', 'rollback', 'release']);
  });

  test('counts from the moment the transaction has begun: a BEGIN longer than the deadline leaves the function the whole of it', async (t) => {
    const timers = mockTimers(t);
    const begin = Promise.withResolvers();
    const started = Promise.withResolvers();
    const driver = createStubDriver({}, { begin });
    const running = transact(driver, () => {
      started.resolve();

      return NEVER;
    });

    await passDeadline(timers, begin);
    await started.promise;
    timers.tick(DEADLINE_MS - 1);
    await nextLoop();

    assert.deepEqual(driver.calls, ['begin']);

    timers.tick(1);

    assert.equal((await rejectionOf(running)).code, EXPIRED_CODE);
    assert.deepEqual(driver.calls, ['begin', 'abort', 'release']);
  });

  test('does not cover COMMIT and the callbacks after it: a call that has reached COMMIT gives its result, however long the server takes', async (t) => {
    const timers = mockTimers(t);
    const [commit, callback] = [Promise.withResolvers(), Promise.withResolvers()];
    const driver = createStubDriver({}, { commit });
    const steps = [];
    const running = transact(driver, async () => {
      await afterCommit(() => callback.promise);
      await afterCommit(() => steps.push('second callback'));

      return 'done';
    });

    await passDeadline(timers, commit);
    await passDeadline(timers, callback);

    assert.equal(await running, 'done');
    assert.deepEqual(steps, ['second callback']);
    assert.deepEqual(driver.calls, ['begin', 'commit', 'release']);
  });

  test('does not cover ROLLBACK: the caller gets the error of its function, however long the server takes', async (t) => {
    const timers = mockTimers(t);
    const failure = new Error('fn failed');
    const rollback = Promise.withResolvers();
    const driver = createStubDriver({}, { rollback });
    const running = rejectionOf(transact(driver, async () => {
      throw failure;
    }));

    await passDeadline(timers, rollback);

    assert.equal(await running, failure);
    assert.deepEqual(driver.calls, ['begin', 'rollback', 'release']);
  });

  test('refuses what the function does after the deadline with the same error, drops its callbacks and holds its own late failure', async (t) => {
    const timers = mockTimers(t);
    const driver = createStubDriver();
    const [started, resumed, late] = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
    const callbacks = [];
    const running = transact(driver, async () => {
      await afterCommit(() => callbacks.push('early'));
      started.resolve();
      await resumed.promise;
      late.resolve(await Promise.allSettled([
        afterCommit(() => callbacks.push('late')),
        withTransaction(() => callbacks.push('nested')),
      ]));

      throw new Error('late failure of fn');
    });

    await started.promise;
    timers.tick(DEADLINE_MS);

    const error = await rejectionOf(running);

    resumed.resolve();

    const results = await late.promise;

    await nextLoop();

    assert.equal(error.code, EXPIRED_CODE);
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
    results.forEach((result) => assert.equal(result.reason, error));
    assert.deepEqual(callbacks, []);
    assert.deepEqual(driver.calls, ['begin', 'abort', 'release']);
  });

  test('does not run the function again after a lock conflict it has swallowed: the error of the deadline has no kind to retry on', async (t) => {
    const timers = mockTimers(t);
    const conflict = createConflict();
    const driver = createStubDriver({ 'SAVEPOINT sp_1': conflict });
    const started = Promise.withResolvers();
    const swallowed = [];
    const running = transact(driver, async () => {
      swallowed.push(await rejectionOf(withTransaction(() => 'never')));
      started.resolve();

      return NEVER;
    }, { retry: true });

    await started.promise;
    timers.tick(DEADLINE_MS);

    assert.equal((await rejectionOf(running)).code, EXPIRED_CODE);
    assert.deepEqual(swallowed, [conflict]);
    assert.deepEqual(driver.calls, ['begin', 'SAVEPOINT sp_1', 'abort', 'release']);
  });

  test('gives every run of "retry: true" a deadline of its own', async (t) => {
    const timers = mockTimers(t);
    const driver = createStubDriver({ commit: createConflict() });
    const runs = [];
    const running = transact(driver, () => {
      const run = Promise.withResolvers();

      runs.push(run);

      return run.promise;
    }, { retry: true });

    await nextLoop();
    timers.tick(DEADLINE_MS - 1);
    runs[0].resolve('done');
    await nextLoop();

    timers.tick(RETRY_MS);
    await nextLoop();
    timers.tick(DEADLINE_MS - 1);
    await nextLoop();

    assert.equal(runs.length, 2);
    assert.deepEqual(driver.calls, ['begin', 'commit', 'rollback', 'release', 'begin']);

    timers.tick(1);

    assert.equal((await rejectionOf(running)).code, EXPIRED_CODE);
    assert.deepEqual(driver.calls, ['begin', 'commit', 'rollback', 'release', 'begin', 'abort', 'release']);
  });
});

describe('retryOnLockConflict', () => {
  const MESSAGE = 'The work is sent again';

  // Fails with the errors it is given, one a run, and then gives its result.
  function createRun(t, ...errors) {
    const failures = [...errors];

    return t.mock.fn(async () => {
      if (failures.length) {
        throw failures.shift();
      }

      return 'done';
    });
  }

  async function retryLogged(run) {
    const sink = createLogSink();
    const context = createPlainContext({ level: 'trace', stream: sink.stream });
    const [outcome] = await Promise.allSettled([runInContext(context, () => retryOnLockConflict(run, MESSAGE))]);

    return { outcome, lines: sink.lines.map(({ level, msg, err }) => [level, msg, err.code]) };
  }

  test('requires a context', async () => {
    await assert.rejects(async () => retryOnLockConflict(() => 'done', MESSAGE), /No active context/);
  });

  test('runs once when nothing fails and says nothing', async (t) => {
    const run = createRun(t);

    assert.deepEqual(await retryLogged(run), { outcome: { status: 'fulfilled', value: 'done' }, lines: [] });
    assert.equal(run.mock.callCount(), 1);
  });

  test('runs once more after a lock conflict, with one warning of the message it was given, and resolves with that result', async (t) => {
    const run = createRun(t, createConflict());

    assert.deepEqual(await retryLogged(run), {
      outcome: { status: 'fulfilled', value: 'done' },
      lines: [[LOG_LEVEL.WARN, MESSAGE, 'ER_LOCK_DEADLOCK']],
    });
    assert.equal(run.mock.callCount(), 2);
  });

  test('rejects with the second failure, a conflict or not, and does not run a third time', async (t) => {
    const errors = [createConflict(), new Error('another failure')];

    await Promise.all(errors.map(async (error) => {
      const run = createRun(t, createConflict(), error);
      const { outcome, lines } = await retryLogged(run);

      assert.equal(outcome.reason, error);
      assert.equal(run.mock.callCount(), 2);
      assert.equal(lines.length, 1);
    }));
  });

  test('rejects at once with any other error: one run, no warning', async (t) => {
    const errors = [
      new Error('plain'),
      Object.assign(new Error('not of the database'), { kind: DB_ERROR_KIND.DEADLOCK }),
      new DbError('Duplicate entry', { kind: DB_ERROR_KIND.UNIQUE }),
      new DbError('Connection lost', { isFatal: true }),
      new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause: createConflict() }),
    ];

    await Promise.all(errors.map(async (error) => {
      const run = createRun(t, error);

      assert.deepEqual(await retryLogged(run), { outcome: { status: 'rejected', reason: error }, lines: [] });
      assert.equal(run.mock.callCount(), 1);
    }));
  });
});

describe('isInTransaction and findTransaction', () => {
  test('find no transaction in a context without one, with or without a database', async (t) => {
    const { db, run } = await createDownDb(t);

    assert.equal(runInContext(createPlainContext(), () => isInTransaction()), false);
    assert.equal(run(() => isInTransaction()), false);
    assert.equal(findTransaction(createPlainContext(), db.driver), null);
    assert.throws(() => isInTransaction(), /No active context/);
  });

  test('find the transaction of the context only for the driver it belongs to', async (t) => {
    const { db } = await createDownDb(t);
    const transaction = { root: { driver: db.driver } };
    const context = createContext({
      config,
      log: createLogger({ level: 'silent' }),
      db,
      transaction,
    });

    assert.equal(findTransaction(context, db.driver), transaction);
    assert.equal(findTransaction(context, {}), null);
    assert.equal(runInContext(context, () => isInTransaction()), true);
  });
});

describe('afterCommit without a transaction', () => {
  test('requires a context and a function', async () => {
    await assert.rejects(afterCommit(() => {}), /No active context/);
    await assert.rejects(runInContext(createPlainContext(), () => afterCommit()), /afterCommit\(fn\) requires a function/);
  });

  test('runs the function at once and waits for it, also in a context without a database', async () => {
    const calls = [];
    const isDeferred = await runInContext(createPlainContext(), () => afterCommit(async () => {
      await Promise.resolve();
      calls.push('ran');
    }));

    assert.equal(isDeferred, false);
    assert.deepEqual(calls, ['ran']);
  });

  test('logs a function that fails and does not reject', async () => {
    const sink = createLogSink();
    const context = createPlainContext({ level: 'error', stream: sink.stream });

    await runInContext(context, () => afterCommit(() => {
      throw new Error('bump failed');
    }));

    assert.equal(sink.lines.length, 1);
    assert.equal(sink.lines[0].err.message, 'bump failed');
    assert.equal(sink.lines[0].msg, 'An afterCommit() callback failed: the transaction itself is committed');
  });
});
