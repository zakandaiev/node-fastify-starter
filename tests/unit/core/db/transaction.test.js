import { createContext, runInContext } from '#core/context/index.js';
import {
  afterCommit,
  findTransaction,
  isInTransaction,
  withTransaction,
} from '#core/db/transaction.js';
import { createLogger } from '#core/logger/index.js';
import { ISOLATION_LEVEL } from '#enums/isolation-level.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const config = createTestConfig();

function createPlainContext(logger = { level: 'silent' }) {
  return createContext({ config, log: createLogger(logger) });
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

// The driver is a stub here: a ROLLBACK or a START TRANSACTION that fails on a live connection cannot be staged.
describe('withTransaction: a driver that fails', () => {
  function createStubDriver(failures = {}) {
    const calls = [];

    async function step(name) {
      calls.push(name);

      if (failures[name]) {
        throw failures[name];
      }
    }

    return {
      calls,
      async withConnection(fn) {
        try {
          return await fn({});
        } finally {
          calls.push('release');
        }
      },
      begin: () => step('begin'),
      commit: () => step('commit'),
      rollback: () => step('rollback'),
      destroy: () => calls.push('destroy'),
    };
  }

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
