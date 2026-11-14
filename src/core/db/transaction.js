import { createContext, getContext, runInContext } from '#core/context/index.js';
import { isLockConflict } from '#core/db/error.js';
import { assertIsolation } from '#core/db/isolation.js';
import { pLimit, retry as runWithRetry } from '#utils/async.js';
import { isBoolean, isFunction } from '#utils/type.js';

const SAVEPOINT_PREFIX = 'sp_';
const LOCK_CONFLICT_RETRIES = 1;
const NO_DELAY_MS = 0;

const RETRY_MESSAGE = 'Database transaction is run again after a lock conflict';
const ROLLBACK_FAILED_MESSAGE = 'Database transaction could not be rolled back: its connection is closed';
const CALLBACK_FAILED_MESSAGE = 'An afterCommit() callback failed: the transaction itself is committed';

const ENDED_MESSAGE = 'The transaction has ended: a statement or afterCommit() ran after the function given to withTransaction() had settled';
const UNAWAITED_MESSAGE = 'withTransaction(fn) rolled back: fn settled while a statement it had started was still running, await every statement';

// One statement at a time: mysql2 sends what it is given in order, so a statement queued behind one that
// ended the transaction would still run, on its own and committed at once.
function createScope(root, outer = null) {
  return {
    root,
    outer,
    level: outer
      ? outer.level + 1
      : 0,
    gate: pLimit(1),
    isOpen: true,
  };
}

// The transaction of the context when it belongs to this driver: a statement of another database goes to
// the pool of its own. The context holds one transaction: one of another database opened inside hides this one.
export function findTransaction(context, driver) {
  return context.transaction?.root.driver === driver
    ? context.transaction
    : null;
}

function assertOpen(scope) {
  if (!scope.isOpen) {
    throw new Error(ENDED_MESSAGE);
  }
}

// After a lock conflict or a lost connection every statement still waiting is refused with that error. The caller
// must hold them all (Promise.all, not one await after another): a rejection nobody holds ends the process.
function assertAlive(root) {
  if (root.failure) {
    throw root.failure;
  }
}

// After a lock conflict the server has rolled the transaction back, and after a fatal error the connection
// is gone: a statement sent now would run outside any transaction. So the first such error closes the
// transaction for everything that follows, also when the caller has swallowed it.
async function send(root, run) {
  try {
    return await run(root.connection);
  } catch (error) {
    if (isLockConflict(error) || error?.isFatal === true) {
      root.failure ??= error;
    }

    throw error;
  }
}

function sendControl(root, sql) {
  return send(root, (connection) => root.driver.execute(connection, root.driver.prepare(sql)));
}

// Accepted or refused when it is issued, not when its turn comes: what a closing scope has accepted still runs
// before COMMIT or ROLLBACK, and a refusal at the turn would reject a promise its caller may no longer hold.
export async function runInTransaction(scope, run) {
  assertOpen(scope);

  return scope.gate(() => {
    assertAlive(scope.root);

    return send(scope.root, run);
  });
}

// Resolves once everything the scope has accepted is done: the statement in flight, those waiting behind it,
// a nested call with all its statements. Tells whether there was nothing left to wait for.
async function endScope(scope) {
  const isIdle = scope.gate.activeCount + scope.gate.pendingCount === 0;

  scope.isOpen = false;
  await scope.gate(() => true);

  return isIdle;
}

// fn is called inside an async function, so a thenable it returns is taken up within the context of the transaction.
// Awaited out here, one that starts its work only in then() would send its statements outside the transaction.
async function runScope(context, scope, fn) {
  let result;

  try {
    result = await runInContext(createContext({ ...context, transaction: scope }), async () => fn());
  } catch (error) {
    await endScope(scope);

    throw error;
  }

  if (!(await endScope(scope))) {
    throw new Error(UNAWAITED_MESSAGE);
  }

  return result;
}

// What a savepoint cannot undo closes the whole transaction: the outer scope must not commit half of the work.
async function rollbackToSavepoint(root, name) {
  if (root.failure) {
    return false;
  }

  try {
    await sendControl(root, `ROLLBACK TO SAVEPOINT ${name}`);
  } catch (error) {
    root.failure ??= error;
  }

  return true;
}

// A callback goes with the savepoint of its own scope and of every scope around it, and with no other:
// the scope outside may register one while a nested call is running beside it.
function isWithin(scope, ancestor) {
  return scope === ancestor || (scope.outer !== null && isWithin(scope.outer, ancestor));
}

// RELEASE also proves that the transaction is still there: after an implicit commit (DDL) it fails.
// A lock conflict the function has swallowed is thrown before it, so that the outermost call can run again.
async function runSavepoint(context, outer, fn) {
  const { root } = outer;

  assertAlive(root);

  const scope = createScope(root, outer);
  const name = `${SAVEPOINT_PREFIX}${scope.level}`;

  await sendControl(root, `SAVEPOINT ${name}`);

  try {
    const result = await runScope(context, scope, fn);

    assertAlive(root);
    await sendControl(root, `RELEASE SAVEPOINT ${name}`);

    return result;
  } catch (error) {
    root.callbacks = root.callbacks.filter((callback) => !isWithin(callback.scope, scope));
    await rollbackToSavepoint(root, name);

    throw error;
  }
}

// The whole nested call is one turn of the scope it is called in: two of them started side by side run one after
// the other, each inside its own savepoint. So a nested call must not await work the scope around it has started
// and not finished: that work gets its turn only when the nested call ends, and both would wait forever.
function runNested(context, outer, fn, { isolation }) {
  if (isolation !== undefined && isolation !== outer.root.isolation) {
    throw new TypeError('withTransaction(fn, { isolation }) cannot change the level of the transaction it is nested in');
  }

  assertOpen(outer);

  return outer.gate(() => runSavepoint(context, outer, fn));
}

async function begin(driver, connection, options) {
  try {
    await driver.begin(connection, options);
  } catch (error) {
    driver.destroy(connection);

    throw error;
  }
}

async function rollback(driver, connection, log) {
  try {
    await driver.rollback(connection);
  } catch (err) {
    driver.destroy(connection);
    log.error({ err }, ROLLBACK_FAILED_MESSAGE);
  }
}

async function commit(driver, root) {
  assertAlive(root);

  await driver.commit(root.connection);
}

function runAttempt(context, fn, { isolation }) {
  const { driver } = context.db;

  return driver.withConnection(async (connection) => {
    const root = {
      driver,
      connection,
      isolation,
      failure: null,
      callbacks: [],
    };

    await begin(driver, connection, { isolation });

    try {
      const result = await runScope(context, createScope(root), fn);

      await commit(driver, root);

      return { result, callbacks: root.callbacks.map((callback) => callback.fn) };
    } catch (error) {
      await rollback(driver, connection, context.log);

      throw error;
    }
  });
}

// In the order they were registered, each one awaited. The data is committed by now: a callback that fails
// is logged and the rest still run, so the caller does not take a finished transaction for a failed one.
async function runCallbacks(callbacks, log) {
  await callbacks.reduce(async (previous, callback) => {
    await previous;

    try {
      await callback();
    } catch (err) {
      log.error({ err }, CALLBACK_FAILED_MESSAGE);
    }
  }, Promise.resolve());
}

// One more run on a lock conflict, and only when the caller asked for it: the function runs twice then,
// so it must hold nothing but statements of this database.
function runAttempts(context, fn, { isolation, retry }) {
  function shouldRetry(error) {
    if (!isLockConflict(error)) {
      return false;
    }

    context.log.warn({ err: error }, RETRY_MESSAGE);

    return true;
  }

  return runWithRetry(() => runAttempt(context, fn, { isolation }), {
    retries: retry
      ? LOCK_CONFLICT_RETRIES
      : 0,
    minDelayMs: NO_DELAY_MS,
    maxDelayMs: NO_DELAY_MS,
    shouldRetry,
  });
}

// A nested call is a savepoint of the transaction it finds in the context: its "retry" is not used,
// a lock conflict ends the outer transaction, and only the outermost call can run it again.
// The callbacks run after the connection is back in the pool: one that reads the database needs its own.
export async function withTransaction(fn, { isolation, retry = false } = {}) {
  if (!isFunction(fn)) {
    throw new TypeError('withTransaction(fn, options) requires a function');
  }

  assertIsolation(isolation, 'withTransaction(fn, { isolation })');

  if (!isBoolean(retry)) {
    throw new TypeError('withTransaction(fn, { retry }) requires a boolean');
  }

  const context = getContext();

  if (!context.db) {
    throw new Error('withTransaction(fn, options) requires a database in the context');
  }

  const outer = findTransaction(context, context.db.driver);

  if (outer) {
    return runNested(context, outer, fn, { isolation });
  }

  const { result, callbacks } = await runAttempts(context, fn, { isolation, retry });

  await runCallbacks(callbacks, context.log);

  return result;
}

export function isInTransaction() {
  const context = getContext();

  return Boolean(context.db && findTransaction(context, context.db.driver));
}

// Inside a transaction the function waits for the commit and never runs after a rollback, also the rollback
// of the savepoint it was registered under. Outside a transaction every statement is committed already,
// so it runs at once, and its failure is logged the same way.
export async function afterCommit(fn) {
  if (!isFunction(fn)) {
    throw new TypeError('afterCommit(fn) requires a function');
  }

  const { transaction, log } = getContext();

  if (!transaction) {
    await runCallbacks([fn], log);

    return false;
  }

  assertOpen(transaction);
  assertAlive(transaction.root);
  transaction.root.callbacks.push({ fn, scope: transaction });

  return true;
}
