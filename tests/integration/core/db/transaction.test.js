import { DbError } from '#core/db/error.js';
import { afterCommit, isInTransaction, withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { ISOLATION_LEVEL } from '#enums/isolation-level.js';
import { countSessionsLeft, createTestDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import {
  before,
  beforeEach,
  describe,
  test,
} from 'node:test';
import { setImmediate as nextLoop, setTimeout as sleep } from 'node:timers/promises';

// A call that must settle and does not is a test that never ends: the limit turns it into a failure.
const HANG_TIMEOUT_MS = 5000;

const testDb = await createTestDb();
const { db, run } = testDb;

// A second pool on the same database: what it reads is what is committed.
const observer = testDb.skip
  ? null
  : testDb.open();

function transact(fn, options) {
  return run(() => withTransaction(fn, options));
}

function add(id, amount = 1, target = db) {
  return target.query('UPDATE accounts SET balance = balance + :amount WHERE id = :id', { id, amount });
}

async function readBalances(target = observer) {
  const { rows } = await target.run(() => target.db.query('SELECT id, balance FROM accounts ORDER BY id'));

  return Object.fromEntries(rows.map((row) => [row.id, row.balance]));
}

async function readMarks() {
  const { rows } = await observer.run(() => observer.db.query('SELECT label FROM marks ORDER BY label'));

  return rows.map((row) => row.label);
}

function mark(label, target = db) {
  return target.query('INSERT INTO marks (label) VALUES (:label)', { label });
}

// KILL only marks the session: until the server has dropped it, the next statement may still be answered.
async function killConnection(id) {
  await observer.run(() => observer.db.query('KILL CONNECTION :id', { id }));

  assert.equal(await countSessionsLeft(observer, [id]), 0);
}

function assertAllEnded(results) {
  results.forEach((result) => {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /The transaction has ended/);
  });
}

// Holds the lock of a row inside a transaction of the observer until release() is called.
async function holdRow(id) {
  const locked = Promise.withResolvers();
  const released = Promise.withResolvers();
  const done = observer.run(() => withTransaction(async () => {
    await observer.db.query('SELECT id FROM accounts WHERE id = :id FOR UPDATE', { id });
    locked.resolve();
    await released.promise;
  }));

  await Promise.race([locked.promise, done]);

  return async function release() {
    released.resolve();
    await done;
  };
}

// The tables belong to the file, not to its first suite: a test that is run alone by its name needs them too.
if (!testDb.skip) {
  before(() => run(async () => {
    await db.query('CREATE TABLE accounts (id INT PRIMARY KEY, balance INT NOT NULL)');
    await db.query('CREATE TABLE marks (label VARCHAR(50) PRIMARY KEY)');
  }));
}

describe('withTransaction', { skip: testDb.skip }, () => {
  beforeEach(async () => {
    await run(async () => {
      await db.query('DELETE FROM marks');
      await db.query('DELETE FROM accounts');
      await db.query('INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 100), (3, 100)');
    });
  });

  test('commits what the function wrote and resolves with its value', async () => {
    const result = await transact(async () => {
      await add(1, 5);
      await mark('committed');

      assert.deepEqual(await readBalances(), { 1: 100, 2: 100, 3: 100 });

      return 'done';
    });

    assert.equal(result, 'done');
    assert.deepEqual(await readBalances(), { 1: 105, 2: 100, 3: 100 });
    assert.deepEqual(await readMarks(), ['committed']);
  });

  test('rolls back and rejects with the error the function threw', async () => {
    const failure = new Error('boom');

    await assert.rejects(transact(async () => {
      await add(1, 5);
      await mark('lost');

      throw failure;
    }), (error) => error === failure);

    assert.deepEqual(await readBalances(), { 1: 100, 2: 100, 3: 100 });
    assert.deepEqual(await readMarks(), []);
  });

  test('rolls back when the function throws without a promise, and gives the connection back', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });

    await assert.rejects(single.run(() => withTransaction(() => {
      throw new Error('sync');
    })), /sync/);

    const { rows } = await single.run(() => single.db.query('SELECT @@in_transaction AS isOpen'));

    assert.deepEqual(rows, [{ isOpen: 0 }]);
    assert.equal(single.db.getStats().activeCount, 0);
  });

  test('rejects when the commit itself fails, and runs no callback', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });
    const calls = [];

    await assert.rejects(single.run(() => withTransaction(async () => {
      const { rows } = await single.db.query('SELECT CONNECTION_ID() AS id');

      await mark('lost with the commit', single.db);
      await afterCommit(() => calls.push('never'));
      await killConnection(rows[0].id);
    })), (error) => error instanceof DbError && error.isFatal === true);

    assert.deepEqual(calls, []);
    assert.deepEqual(await readMarks(), []);
    assert.equal(single.db.getStats().activeCount, 0);
  });

  test('runs every statement of the function on one connection, and tells whether a transaction is open', async () => {
    const outside = await run(() => isInTransaction());
    const inside = await transact(async () => {
      const ids = await Promise.all([1, 2, 3].map(() => db.query('SELECT CONNECTION_ID() AS id, @@in_transaction AS isOpen')));

      return { isIn: isInTransaction(), rows: ids.map((result) => result.rows[0]) };
    });

    assert.equal(outside, false);
    assert.equal(inside.isIn, true);
    assert.equal(new Set(inside.rows.map((row) => row.id)).size, 1);
    assert.deepEqual(inside.rows.map((row) => row.isOpen), [1, 1, 1]);
  });

  test('gives the connection back clean after a commit and after a rollback', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });

    async function readState() {
      const { rows } = await single.run(() => single.db.query('SELECT @@in_transaction AS isOpen'));

      return rows[0].isOpen;
    }

    await single.run(() => withTransaction(() => add(1, 1, single.db)));

    const afterCommitState = await readState();
    const failures = await Promise.allSettled(Array.from({ length: 10 }, () => single.run(() => withTransaction(async () => {
      await add(1, 1, single.db);

      throw new Error('boom');
    }))));

    assert.equal(afterCommitState, 0);
    assert.equal(failures.every((result) => result.status === 'rejected'), true);
    assert.equal(await readState(), 0);
    assert.deepEqual(await readBalances(), { 1: 101, 2: 100, 3: 100 });
    assert.equal(single.db.getStats().activeCount, 0);
  });

  test('requires a function', async () => {
    await assert.rejects(run(() => withTransaction()), /requires a function/);
    await assert.rejects(run(() => withTransaction('fn')), TypeError);
  });

  test('keeps a statement of another database out of the transaction', async () => {
    await assert.rejects(transact(async () => {
      await mark('own');
      await mark('foreign', observer.db);

      throw new Error('boom');
    }), /boom/);

    assert.deepEqual(await readMarks(), ['foreign']);
  });

  test('takes up a thenable the function returns inside the transaction', async () => {
    function lazy(sql, binding) {
      return { then: (resolve, reject) => db.query(sql, binding).then(resolve, reject) };
    }

    const { rows } = await transact(() => lazy('SELECT @@in_transaction AS isOpen'));

    await assert.rejects(transact(() => ({
      then(resolve, reject) {
        lazy('INSERT INTO marks (label) VALUES (:label)', { label: 'lazy' }).then(() => reject(new Error('boom')), reject);
      },
    })), /boom/);

    assert.deepEqual(rows, [{ isOpen: 1 }]);
    assert.deepEqual(await readMarks(), []);
  });

  test('runs a statement without the time limit inside a transaction', async () => {
    const limited = testDb.open({ db: { statementTimeout: '0.05s' } });
    const inside = await limited.run(() => withTransaction(async () => {
      const { rows } = await limited.db.query('SELECT SLEEP(0.2) AS waited', {}, { isTimeLimited: true });

      return rows[0].waited;
    }));

    assert.equal(inside, 0);
    await assert.rejects(
      limited.run(() => limited.db.query('SELECT SLEEP(0.2) AS waited', {}, { isTimeLimited: true })),
      (error) => error instanceof AppError && error.cause.kind === DB_ERROR_KIND.TIMEOUT,
    );
  });
});

describe('withTransaction: nested', { skip: testDb.skip }, () => {
  beforeEach(async () => {
    await run(async () => {
      await db.query('DELETE FROM marks');
      await db.query('DELETE FROM accounts');
      await db.query('INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 100), (3, 100)');
    });
  });

  test('rolls a failed nested call back to its savepoint and lets the outer one go on', async () => {
    const failure = new Error('inner');

    await transact(async () => {
      await mark('outer before');

      await assert.rejects(withTransaction(async () => {
        await mark('inner');
        await add(1, 50);

        throw failure;
      }), (error) => error === failure);

      await mark('outer after');
    });

    assert.deepEqual(await readMarks(), ['outer after', 'outer before']);
    assert.deepEqual(await readBalances(), { 1: 100, 2: 100, 3: 100 });
  });

  test('commits a nested call with the outer one, and loses it when the outer one fails later', async () => {
    await transact(async () => {
      await withTransaction(() => mark('kept inner'));
      await mark('kept outer');
    });

    await assert.rejects(transact(async () => {
      await withTransaction(() => mark('lost inner'));

      throw new Error('outer');
    }), /outer/);

    assert.deepEqual(await readMarks(), ['kept inner', 'kept outer']);
  });

  test('nests to any depth: each level undoes its own work only', async () => {
    await transact(async () => {
      await mark('level 0');

      await withTransaction(async () => {
        await mark('level 1');

        await assert.rejects(withTransaction(async () => {
          await mark('level 2');

          await withTransaction(() => mark('level 3'));

          throw new Error('level 2 fails');
        }), /level 2 fails/);

        await withTransaction(() => mark('level 2 again'));
      });
    });

    assert.deepEqual(await readMarks(), ['level 0', 'level 1', 'level 2 again']);
  });

  test('runs nested calls started side by side one after the other, each in its own savepoint', async () => {
    await transact(async () => {
      const results = await Promise.allSettled([
        withTransaction(async () => {
          await mark('first');
          await sleep(20);
          await add(1, 1);
        }),
        withTransaction(async () => {
          await mark('second');

          throw new Error('second fails');
        }),
        withTransaction(() => mark('third')),
      ]);

      assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
    });

    assert.deepEqual(await readMarks(), ['first', 'third']);
    assert.deepEqual(await readBalances(), { 1: 101, 2: 100, 3: 100 });
  });

  test('takes no "retry" of its own and refuses to change the isolation level', async () => {
    await transact(async () => {
      await withTransaction(() => mark('nested'), { retry: true });
      await assert.rejects(
        withTransaction(() => mark('never'), { isolation: ISOLATION_LEVEL.SERIALIZABLE }),
        /cannot change the level of the transaction it is nested in/,
      );
    });

    await transact(async () => {
      await withTransaction(() => mark('same level'), { isolation: ISOLATION_LEVEL.READ_COMMITTED });
    }, { isolation: ISOLATION_LEVEL.READ_COMMITTED });

    assert.deepEqual(await readMarks(), ['nested', 'same level']);
  });

  test('rejects when a statement inside a nested call has ended the transaction on the server', async () => {
    await assert.rejects(transact(async () => {
      await mark('before the definition');
      await withTransaction(() => db.query('CREATE TABLE implicit_commit (id INT PRIMARY KEY)'));
      await mark('never written');
    }), (error) => error instanceof DbError && /SAVEPOINT sp_1 does not exist/.test(error.message));

    assert.deepEqual(await readMarks(), ['before the definition']);
  });

  test('closes the transaction when a savepoint is lost, also for a function that goes on', async () => {
    const seen = {};

    await assert.rejects(transact(async () => {
      await mark('before the definition');

      try {
        await withTransaction(() => db.query('CREATE TABLE lost_savepoint (id INT PRIMARY KEY)'));
      } catch (error) {
        seen.nested = error;
      }

      try {
        await mark('after the savepoint was lost');
      } catch (error) {
        seen.next = error;
      }
    }), (error) => error === seen.next);

    assert.match(seen.nested.message, /SAVEPOINT sp_1 does not exist/);
    assert.match(seen.next.message, /SAVEPOINT sp_1 does not exist/);
    assert.deepEqual(await readMarks(), ['before the definition']);
  });

  test('rolls a nested call back when its function settles before a statement it started', async () => {
    let stray = null;

    await transact(async () => {
      await assert.rejects(withTransaction(async () => {
        await mark('nested: awaited');
        stray = mark('nested: not awaited');
      }), /fn settled while a statement it had started was still running/);

      await stray;
      await mark('outer goes on');
    });

    assert.deepEqual(await readMarks(), ['outer goes on']);
  });

  test('waits for a nested call the function did not await, then rolls everything back', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });
    let nested = null;

    await assert.rejects(single.run(() => withTransaction(async () => {
      await mark('outer', single.db);

      nested = withTransaction(async () => {
        await mark('nested: first statement', single.db);
        await sleep(20);
        await mark('nested: second statement', single.db);
      });
    })), /fn settled while a statement it had started was still running/);

    await nested;

    assert.deepEqual(await readMarks(), []);
    assert.equal(single.db.getStats().activeCount, 0);
  });

  test('takes up a thenable a nested function returns inside the nested call', { timeout: HANG_TIMEOUT_MS }, async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });

    await single.run(() => withTransaction(async () => {
      await withTransaction(() => ({ then: (resolve, reject) => mark('nested lazy', single.db).then(resolve, reject) }));
    }));

    assert.deepEqual(await readMarks(), ['nested lazy']);
  });

  // The late work starts from a promise the test resolves once the transaction has settled: its callback keeps
  // the context of the place where then() was called, and nothing is refused before somebody holds it.
  test('refuses a nested call that comes after the transaction has ended', async () => {
    const ended = Promise.withResolvers();
    let late = null;

    await transact(async () => {
      await mark('in time');

      late = ended.promise.then(() => withTransaction(() => mark('late nested call')));
    });

    ended.resolve();
    await assert.rejects(late, /The transaction has ended/);
    assert.deepEqual(await readMarks(), ['in time']);
  });

  test('refuses what comes after a nested call has ended, while the transaction around it goes on', async () => {
    const calls = [];

    function issueLate() {
      return Promise.allSettled([
        mark('late statement'),
        afterCommit(() => calls.push('late')),
        withTransaction(() => mark('late nested call')),
      ]);
    }

    await transact(async () => {
      const ended = Promise.withResolvers();
      const late = {};

      await assert.rejects(withTransaction(async () => {
        await mark('nested: rolled back');
        late.afterFailure = ended.promise.then(issueLate);

        throw new Error('nested fails');
      }), /nested fails/);

      await withTransaction(async () => {
        await mark('nested: held');
        late.afterSuccess = ended.promise.then(issueLate);
      });

      ended.resolve();
      assertAllEnded(await late.afterFailure);
      assertAllEnded(await late.afterSuccess);
      await mark('outer goes on');
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(await readMarks(), ['nested: held', 'outer goes on']);
  });
});

describe('withTransaction: statements side by side', { skip: testDb.skip }, () => {
  beforeEach(async () => {
    await run(async () => {
      await db.query('DELETE FROM marks');
      await db.query('DELETE FROM accounts');
      await db.query('INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 100), (3, 100)');
    });
  });

  test('commits all the statements started together', async () => {
    await transact(() => Promise.all([add(1), add(2), add(3), mark('a'), mark('b')]));

    assert.deepEqual(await readBalances(), { 1: 101, 2: 101, 3: 101 });
    assert.deepEqual(await readMarks(), ['a', 'b']);
  });

  test('commits none of them when one fails: what was started runs before the rollback, nothing after it', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });
    let statements = null;

    await assert.rejects(single.run(() => withTransaction(() => {
      statements = [
        mark('first', single.db),
        single.db.query('INSERT INTO accounts (id, balance) VALUES (1, 0)'),
        mark('second', single.db),
        add(2, 1, single.db),
      ];

      return Promise.all(statements);
    })), (error) => error.kind === DB_ERROR_KIND.UNIQUE);

    const results = await Promise.allSettled(statements);

    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    assert.deepEqual(await readMarks(), []);
    assert.deepEqual(await readBalances(), { 1: 100, 2: 100, 3: 100 });
    assert.equal(single.db.getStats().activeCount, 0);
  });

  // The turn right behind the failed statement begins before the function is seen to fail: one more in between.
  test('runs a nested call started before the failure before the rollback', async () => {
    const ran = [];
    let started = null;

    await assert.rejects(transact(() => {
      started = [
        db.query('INSERT INTO accounts (id, balance) VALUES (1, 0)'),
        mark('between'),
        withTransaction(async () => {
          ran.push('nested');
          await mark('nested');
        }),
      ];

      return Promise.all(started);
    }), (error) => error.kind === DB_ERROR_KIND.UNIQUE);

    const results = await Promise.allSettled(started);

    assert.deepEqual(results.map((result) => result.status), ['rejected', 'fulfilled', 'fulfilled']);
    assert.deepEqual(ran, ['nested']);
    assert.deepEqual(await readMarks(), []);
  });

  test('rolls back and rejects when the function settles before a statement it started', async () => {
    let stray = null;

    await assert.rejects(transact(async () => {
      await mark('awaited');
      stray = mark('not awaited');
    }), /fn settled while a statement it had started was still running/);

    await stray;

    assert.deepEqual(await readMarks(), []);
  });

  test('refuses a statement and a callback that come after the transaction has ended', async () => {
    const ended = Promise.withResolvers();
    let late = null;

    await transact(async () => {
      await mark('in time');

      late = ended.promise.then(() => Promise.allSettled([mark('too late'), afterCommit(() => {})]));
    });

    ended.resolve();
    assertAllEnded(await late);
    assert.deepEqual(await readMarks(), ['in time']);
  });

  test('refuses a statement, a callback and a nested call that come after a rollback', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });
    const ended = Promise.withResolvers();
    let late = null;

    await assert.rejects(single.run(() => withTransaction(async () => {
      await mark('rolled back', single.db);

      late = ended.promise.then(() => Promise.allSettled([
        mark('too late', single.db),
        afterCommit(() => {}),
        withTransaction(() => mark('too late, nested', single.db)),
      ]));

      throw new Error('boom');
    })), /boom/);

    ended.resolve();
    assertAllEnded(await late);
    assert.deepEqual(await readMarks(), []);
  });

  // Several of them: under a scope that closes only after its drain the first one would still run inside
  // the transaction, the rest after the rollback.
  test('refuses statements that come while the started ones are still running', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });
    let slow = null;
    let during = null;

    await assert.rejects(single.run(() => withTransaction(async () => {
      slow = single.db.query('SELECT SLEEP(0.2) AS waited');
      during = nextLoop().then(() => Promise.allSettled([
        mark('while the slow one runs: first', single.db),
        mark('while the slow one runs: second', single.db),
      ]));

      throw new Error('boom');
    })), /boom/);

    assert.deepEqual((await slow).rows, [{ waited: 0 }]);
    assertAllEnded(await during);
    assert.deepEqual(await readMarks(), []);
  });
});

describe('afterCommit', { skip: testDb.skip }, () => {
  beforeEach(async () => {
    await run(async () => {
      await db.query('DELETE FROM marks');
    });
  });

  test('runs after the commit, in the order of registration, and is awaited', async () => {
    const calls = [];

    await transact(async () => {
      await mark('visible');
      await afterCommit(async () => {
        await sleep(10);
        calls.push({ name: 'first', marks: await readMarks(), isIn: isInTransaction() });
      });
      assert.equal(await afterCommit(() => calls.push({ name: 'second' })), true);

      assert.deepEqual(calls, []);
    });

    assert.deepEqual(calls, [{ name: 'first', marks: ['visible'], isIn: false }, { name: 'second' }]);
  });

  test('does not run after a rollback', async () => {
    const calls = [];

    await assert.rejects(transact(async () => {
      await afterCommit(() => calls.push('never'));

      throw new Error('boom');
    }), /boom/);

    assert.deepEqual(calls, []);
  });

  test('keeps a callback of the outer scope that is registered while a nested call beside it fails', async () => {
    const calls = [];
    const started = Promise.withResolvers();
    const registered = Promise.withResolvers();

    await transact(async () => {
      const nested = withTransaction(async () => {
        await afterCommit(() => calls.push('dropped'));
        started.resolve();
        await registered.promise;

        throw new Error('nested fails');
      });

      await started.promise;
      await afterCommit(() => calls.push('kept'));
      registered.resolve();
      await assert.rejects(nested, /nested fails/);
    });

    assert.deepEqual(calls, ['kept']);
  });

  test('keeps the callback of a write that runs side by side with a nested call that fails', async () => {
    const calls = [];

    async function writeAndBump(label) {
      await mark(label);
      await afterCommit(() => calls.push(label));
    }

    await transact(async () => {
      const results = await Promise.allSettled([
        writeAndBump('first write'),
        withTransaction(async () => {
          await mark('optional step');

          throw new Error('optional step fails');
        }),
        writeAndBump('second write'),
      ]);

      assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
    });

    assert.deepEqual(calls, ['first write', 'second write']);
    assert.deepEqual(await readMarks(), ['first write', 'second write']);
  });

  test('runs the callbacks of every scope in the order they were registered', async () => {
    const calls = [];
    const first = Promise.withResolvers();
    const between = Promise.withResolvers();

    await transact(async () => {
      const nested = withTransaction(async () => {
        await afterCommit(() => calls.push('nested first'));
        first.resolve();
        await between.promise;
        await afterCommit(() => calls.push('nested last'));
      });

      await first.promise;
      await afterCommit(() => calls.push('outer between'));
      between.resolve();
      await nested;
    });

    assert.deepEqual(calls, ['nested first', 'outer between', 'nested last']);
  });

  test('is dropped with the savepoint it was registered under, and kept from one that held', async () => {
    const calls = [];

    await transact(async () => {
      await afterCommit(() => calls.push('outer'));
      await withTransaction(() => afterCommit(() => calls.push('kept')));

      await assert.rejects(withTransaction(async () => {
        await afterCommit(() => calls.push('dropped'));
        await withTransaction(async () => {
          await afterCommit(() => calls.push('dropped too'));
          await withTransaction(() => afterCommit(() => calls.push('dropped two levels below')));
        });

        throw new Error('inner');
      }), /inner/);

      await afterCommit(() => calls.push('last'));

      assert.deepEqual(calls, []);
    });

    assert.deepEqual(calls, ['outer', 'kept', 'last']);
  });

  test('logs a callback that fails, runs the rest and still resolves', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'error', stream: sink.stream } });
    const calls = [];

    const result = await logged.run(() => withTransaction(async () => {
      await mark('committed anyway', logged.db);
      await afterCommit(() => {
        throw new Error('callback failed');
      });
      await afterCommit(async () => {
        throw new Error('async callback failed');
      });
      await afterCommit(() => calls.push('still runs'));

      return 'result';
    }));

    assert.equal(result, 'result');
    assert.deepEqual(calls, ['still runs']);
    assert.deepEqual(await readMarks(), ['committed anyway']);
    assert.deepEqual(sink.lines.map((line) => line.err.message), ['callback failed', 'async callback failed']);
    assert.equal(sink.lines[0].msg, 'An afterCommit() callback failed: the transaction itself is committed');
  });

  test('can use the database: the connection of the transaction is back in the pool by then', async () => {
    const single = testDb.open({ db: { connectionLimit: 1, queueLimit: 0 } });

    await single.run(() => withTransaction(async () => {
      await mark('first', single.db);
      await afterCommit(() => mark('from the callback', single.db));
    }));

    assert.deepEqual(await readMarks(), ['first', 'from the callback']);
  });

  test('runs at once outside a transaction, and logs a failure there as well', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'error', stream: sink.stream } });
    const calls = [];

    const isDeferred = await logged.run(() => afterCommit(() => calls.push('now')));

    await logged.run(() => afterCommit(() => {
      throw new Error('outside');
    }));

    assert.equal(isDeferred, false);
    assert.deepEqual(calls, ['now']);
    assert.deepEqual(sink.lines.map((line) => line.err.message), ['outside']);
  });

  test('requires a function', async () => {
    await assert.rejects(run(() => afterCommit()), /afterCommit\(fn\) requires a function/);
    await assert.rejects(transact(() => afterCommit('fn')), TypeError);
  });
});

describe('withTransaction: isolation', { skip: testDb.skip }, () => {
  beforeEach(async () => {
    await run(async () => {
      await db.query('DELETE FROM accounts');
      await db.query('INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 100), (3, 100)');
    });
  });

  // The same two reads around a commit of another connection: what the second one sees tells the level.
  function readAroundCommit(target, options) {
    return target.run(() => withTransaction(async () => {
      const first = await target.db.query('SELECT balance FROM accounts WHERE id = 1');

      await observer.run(() => add(1, 7, observer.db));

      const second = await target.db.query('SELECT balance FROM accounts WHERE id = 1');

      return second.rows[0].balance - first.rows[0].balance;
    }, options));
  }

  test('sets the level for one transaction: the next one on the same connection has the default again', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });

    const readCommitted = await readAroundCommit(single, { isolation: ISOLATION_LEVEL.READ_COMMITTED });
    const byDefault = await readAroundCommit(single);
    const repeatableRead = await readAroundCommit(single, { isolation: ISOLATION_LEVEL.REPEATABLE_READ });

    assert.deepEqual([readCommitted, byDefault, repeatableRead], [7, 0, 0]);
  });

  test('refuses a level that is not in the list before it takes a connection, also when the pool is busy', async () => {
    const single = testDb.open({ db: { connectionLimit: 1, queueLimit: 0 } });
    const held = Promise.withResolvers();
    const released = Promise.withResolvers();

    async function readConnectionId() {
      const { rows } = await single.run(() => single.db.query('SELECT CONNECTION_ID() AS id'));

      return rows[0].id;
    }

    function begin(isolation) {
      return single.run(() => withTransaction(() => {}, { isolation }));
    }

    const connectionId = await readConnectionId();

    await assert.rejects(
      begin('READ COMMITTED; DROP TABLE accounts'),
      /withTransaction\(fn, \{ isolation \}\) requires one of: READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ, SERIALIZABLE/,
    );

    const holder = single.run(() => withTransaction(async () => {
      held.resolve();
      await released.promise;
      await assert.rejects(withTransaction(() => {}, { isolation: 'SNAPSHOT' }), /requires one of/);
    }));

    await held.promise;
    await assert.rejects(begin('read committed'), TypeError);
    released.resolve();
    await holder;

    assert.equal(await readConnectionId(), connectionId);
    assert.deepEqual(await readBalances(single), { 1: 100, 2: 100, 3: 100 });
  });
});

describe('withTransaction: lock conflicts', { skip: testDb.skip }, () => {
  beforeEach(async () => {
    await run(async () => {
      await db.query('DELETE FROM marks');
      await db.query('DELETE FROM accounts');
      await db.query('INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 100), (3, 100)');
    });
  });

  // Two transactions that take the same two rows in opposite orders. Each one waits until the other holds
  // its first row, so the deadlock is certain; on a second run both barriers are down already.
  function crossTransfer(options, onAttempt = () => {}) {
    const barriers = [Promise.withResolvers(), Promise.withResolvers()];

    function transfer(index, ownId, otherId) {
      return transact(async () => {
        await onAttempt(index);
        await add(ownId);
        barriers[index].resolve();
        await barriers[1 - index].promise;
        await add(otherId);
      }, options);
    }

    return Promise.allSettled([transfer(0, 1, 2), transfer(1, 2, 1)]);
  }

  test('a deadlock of two transactions is run again once and passes', async () => {
    const attempts = [];
    const callbacks = [];
    const results = await crossTransfer({ retry: true }, async (index) => {
      attempts.push(index);
      await afterCommit(() => callbacks.push(index));
    });

    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
    assert.equal(attempts.length, 3);
    assert.deepEqual(callbacks.toSorted(), [0, 1]);
    assert.deepEqual(await readBalances(), { 1: 102, 2: 102, 3: 100 });
  });

  test('without "retry" the deadlock rejects one of them with the kind "deadlock" and commits the other', async () => {
    const results = await crossTransfer();
    const rejected = results.filter((result) => result.status === 'rejected');

    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DbError);
    assert.equal(rejected[0].reason.kind, DB_ERROR_KIND.DEADLOCK);
    assert.equal(rejected[0].reason.code, 'ER_LOCK_DEADLOCK');
    assert.deepEqual(await readBalances(), { 1: 101, 2: 101, 3: 100 });
  });

  // innodb_snapshot_isolation: a row that another transaction changed after this one had read it cannot be
  // written, and the server ends the whole transaction. The second run reads the new value and passes.
  test('a row changed since it was read is run again once and passes, with a warning in the log', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'warn', stream: sink.stream } });
    const seen = [];

    await logged.run(() => withTransaction(async () => {
      const { rows } = await logged.db.query('SELECT balance FROM accounts WHERE id = 1');

      seen.push(rows[0].balance);

      if (seen.length === 1) {
        await observer.run(() => add(1, 10, observer.db));
      }

      await logged.db.query('UPDATE accounts SET balance = :balance WHERE id = 1', { balance: rows[0].balance + 1 });
    }, { retry: true }));

    assert.deepEqual(seen, [100, 110]);
    assert.deepEqual(await readBalances(), { 1: 111, 2: 100, 3: 100 });
    assert.deepEqual(sink.lines.map((line) => [line.level, line.msg, line.err.kind]), [
      [40, 'Database transaction is run again after a lock conflict', DB_ERROR_KIND.DEADLOCK],
    ]);
  });

  test('runs again after a lock conflict that a nested call has swallowed', async () => {
    const seen = [];

    await transact(async () => {
      const { rows } = await db.query('SELECT balance FROM accounts WHERE id = 1');

      seen.push(rows[0].balance);

      if (seen.length === 1) {
        await observer.run(() => add(1, 10, observer.db));
      }

      await withTransaction(async () => {
        try {
          await db.query('UPDATE accounts SET balance = :balance WHERE id = 1', { balance: rows[0].balance + 1 });
        } catch (error) {
          assert.equal(error.kind, DB_ERROR_KIND.DEADLOCK);
        }
      });
    }, { retry: true });

    assert.deepEqual(seen, [100, 110]);
    assert.deepEqual(await readBalances(), { 1: 111, 2: 100, 3: 100 });
  });

  test('refuses a statement that waits behind a lock conflict, with the error of the conflict', async () => {
    let results = null;

    await assert.rejects(transact(async () => {
      const { rows } = await db.query('SELECT balance FROM accounts WHERE id = 1');

      await observer.run(() => add(1, 10, observer.db));

      results = await Promise.allSettled([
        db.query('UPDATE accounts SET balance = :balance WHERE id = 1', { balance: rows[0].balance + 1 }),
        mark('queued behind the conflict'),
      ]);
    }), (error) => error === results[0].reason);

    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
    assert.equal(results[0].reason.kind, DB_ERROR_KIND.DEADLOCK);
    assert.equal(results[1].reason, results[0].reason);
    assert.deepEqual(await readMarks(), []);
    assert.deepEqual(await readBalances(), { 1: 110, 2: 100, 3: 100 });
  });

  test('runs the function twice at most', async () => {
    const release = await holdRow(1);
    let attempts = 0;

    try {
      await assert.rejects(transact(async () => {
        attempts += 1;
        await mark(`attempt ${attempts}`);
        await db.query('SELECT id FROM accounts WHERE id = 1 FOR UPDATE NOWAIT');
      }, { retry: true }), (error) => error instanceof DbError && error.kind === DB_ERROR_KIND.DEADLOCK);
    } finally {
      await release();
    }

    assert.equal(attempts, 2);
    assert.deepEqual(await readMarks(), []);
  });

  test('does not run the function again for another kind of error', async () => {
    let attempts = 0;

    await assert.rejects(transact(async () => {
      attempts += 1;
      await db.query('INSERT INTO accounts (id, balance) VALUES (1, 0)');
    }, { retry: true }), (error) => error.kind === DB_ERROR_KIND.UNIQUE);

    assert.equal(attempts, 1);
  });

  test('closes the transaction for a function that swallows a lock conflict: nothing it writes later is committed', async () => {
    const release = await holdRow(1);
    const seen = { isCalled: false };

    try {
      await assert.rejects(transact(async () => {
        await mark('before the conflict');

        try {
          await db.query('SELECT id FROM accounts WHERE id = 1 FOR UPDATE NOWAIT');
        } catch (error) {
          seen.conflict = error;
        }

        try {
          await mark('after the conflict');
        } catch (error) {
          seen.next = error;
        }

        [seen.nested, seen.callback] = await Promise.allSettled([
          withTransaction(() => {
            seen.isCalled = true;
          }),
          afterCommit(() => {}),
        ]);
      }), (error) => error === seen.conflict);
    } finally {
      await release();
    }

    assert.equal(seen.conflict.kind, DB_ERROR_KIND.DEADLOCK);
    assert.equal(seen.next, seen.conflict);
    assert.equal(seen.nested.reason, seen.conflict);
    assert.equal(seen.isCalled, false);
    assert.equal(seen.callback.reason, seen.conflict);
    assert.deepEqual(await readMarks(), []);
  });

  test('a nested call rejects with the lost connection its function has swallowed', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });
    const seen = {};

    await assert.rejects(single.run(() => withTransaction(async () => {
      try {
        await withTransaction(async () => {
          const { rows } = await single.db.query('SELECT CONNECTION_ID() AS id');

          await killConnection(rows[0].id);

          try {
            await single.db.query('SELECT 1');
          } catch (error) {
            seen.lost = error;
          }
        });
      } catch (error) {
        seen.nested = error;
      }
    })), (error) => error === seen.lost);

    assert.equal(seen.lost.isFatal, true);
    assert.equal(seen.nested, seen.lost);
    assert.equal(single.db.getStats().activeCount, 0);
  });

  test('a transaction whose connection is killed is closed for good, and the pool goes on with a new one', async () => {
    const sink = createLogSink();
    const single = testDb.open({ db: { connectionLimit: 1 }, logger: { level: 'error', stream: sink.stream } });
    const seen = {};

    await assert.rejects(single.run(() => withTransaction(async () => {
      const { rows } = await single.db.query('SELECT CONNECTION_ID() AS id');

      await mark('lost with the connection', single.db);
      await killConnection(rows[0].id);

      try {
        await single.db.query('SELECT 1');
      } catch (error) {
        seen.lost = error;
      }

      try {
        await single.db.query('SELECT 2');
      } catch (error) {
        seen.next = error;
      }
    })), (error) => error === seen.lost);

    const { rows } = await single.run(() => single.db.query('SELECT 1 AS alive'));

    assert.ok(seen.lost instanceof DbError);
    assert.equal(seen.lost.isFatal, true);
    assert.equal(seen.next, seen.lost);
    assert.deepEqual(sink.lines.map((line) => line.msg), ['Database transaction could not be rolled back: its connection is closed']);
    assert.deepEqual(rows, [{ alive: 1 }]);
    assert.deepEqual(await readMarks(), []);
    assert.equal(single.db.getStats().activeCount, 0);
  });
});

describe('withTransaction: a full pool', { skip: testDb.skip }, () => {
  test('is refused with 503 before the function runs, and nothing is sent', async () => {
    const tight = testDb.open({ db: { connectionLimit: 1, queueLimit: 1 } });
    const held = Promise.withResolvers();
    const released = Promise.withResolvers();
    let isCalled = false;

    const holder = tight.run(() => withTransaction(async () => {
      held.resolve();
      await released.promise;
    }));

    await held.promise;

    const waiting = tight.run(() => tight.db.query('SELECT 1 AS queued'));
    const refused = tight.run(() => withTransaction(async () => {
      isCalled = true;
    }));

    await assert.rejects(refused, (error) => error instanceof AppError
      && error.code === ERROR_CODE.SERVICE_UNAVAILABLE_ERROR
      && error.cause instanceof DbError
      && error.cause.kind === DB_ERROR_KIND.OVERLOAD);

    const stats = tight.db.getStats();

    released.resolve();
    await holder;

    assert.equal(isCalled, false);
    assert.deepEqual([stats.activeCount, stats.queueLength, stats.rejectedCount], [1, 1, 1]);
    assert.deepEqual((await waiting).rows, [{ queued: 1 }]);
    assert.equal(tight.db.getStats().queueLength, 0);
  });
});
