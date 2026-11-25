import {
  assertServer,
  createMariadbDriver,
  initSession,
  SESSION_SQL,
} from '#core/db/driver/mariadb.js';
import { DbError } from '#core/db/error.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { PromisePool } from 'mysql2/promise';
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, test } from 'node:test';

// A lost connectTimeout would leave the test waiting for the default of the driver: the limit fails it instead.
const SILENT_SERVER_TEST_TIMEOUT_MS = 5000;

const SERVER = Object.freeze({
  version: '12.3.3-MariaDB-ubu2404',
  timeZone: '+00:00',
  sqlMode: 'IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION',
});

// The pool opens no connection until it is asked for one: what is tested here never asks.
function createDriver(t, overrides = {}, env = {}) {
  const driver = createMariadbDriver({ ...createTestConfig({ env }).db, ...overrides });

  t.after(() => driver.close());

  return driver;
}

// The shape of a connection the pool hands out: a new wrapper each time around the same connection.
function createConnection(failure = null) {
  const calls = [];

  return {
    calls,
    connection: {},
    query(sql) {
      calls.push(sql);

      return failure
        ? Promise.reject(failure)
        : Promise.resolve([[], []]);
    },
    destroy() {
      calls.push('destroy');
    },
    release() {},
  };
}

describe('assertServer', () => {
  test('accepts MariaDB 12.3 and newer, comparing the numbers and not the text', () => {
    const versions = [
      '12.3.0-MariaDB',
      '12.3.3-MariaDB-ubu2404',
      '12.3.3-MariaDB-1:12.3.3+maria~ubu2404',
      '12.10.1-MariaDB',
      '13.0.0-MariaDB-log',
      '100.0.0-MariaDB',
      '12.3.1-1-MariaDB-enterprise',
      '12.3.2-2-MariaDB-enterprise-log',
      '13.0.1-12-MariaDB-enterprise',
    ];

    versions.forEach((version) => assert.doesNotThrow(() => assertServer({ ...SERVER, version }), version));
  });

  test('refuses an older MariaDB, MySQL and what is not a version at all', () => {
    const versions = [
      '12.2.9-MariaDB',
      '11.8.2-MariaDB-ubu2404',
      '10.11.6-MariaDB',
      '5.5.5-10.6.4-MariaDB',
      '5.5.5-12.3.3-MariaDB',
      '11.8.3-1-MariaDB-enterprise',
      '10.6.14-9-MariaDB-enterprise',
      '8.4.3',
      '9.1.0-mysql',
      '12.3.3',
      'MariaDB',
      '',
      undefined,
      null,
    ];

    versions.forEach((version) => {
      assert.throws(
        () => assertServer({ ...SERVER, version }),
        new RegExp(`MariaDB 12\\.3 or newer is required, the server reports "${version}"`),
      );
    });
  });

  test('refuses a session that is not in UTC', () => {
    ['SYSTEM', '+03:00', 'Europe/Kyiv', 'UTC', undefined].forEach((timeZone) => {
      assert.throws(() => assertServer({ ...SERVER, timeZone }), /The database session must run in UTC, its time_zone is/);
    });
  });

  test('refuses a sql_mode under which the client cannot escape a value or reads a quote differently', () => {
    assert.throws(
      () => assertServer({ ...SERVER, sqlMode: `${SERVER.sqlMode},NO_BACKSLASH_ESCAPES` }),
      /The sql_mode NO_BACKSLASH_ESCAPES is not supported/,
    );
    assert.throws(
      () => assertServer({ ...SERVER, sqlMode: 'REAL_AS_FLOAT,PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ANSI' }),
      /The sql_mode ANSI_QUOTES is not supported/,
    );
    assert.throws(
      () => assertServer({ ...SERVER, sqlMode: `EMPTY_STRING_IS_NULL,${SERVER.sqlMode}` }),
      /The sql_mode EMPTY_STRING_IS_NULL is not supported/,
    );
    assert.doesNotThrow(() => assertServer({ ...SERVER, sqlMode: '' }));
  });

  test('requires what the server reports', () => {
    assert.throws(() => assertServer(), /MariaDB 12\.3 or newer is required/);
  });
});

describe('SESSION_SQL', () => {
  test('sets the charset, the time zone, the escaping, autocommit, the language of errors and the size of an aggregate', () => {
    assert.equal(
      SESSION_SQL,
      "SET NAMES utf8mb4, time_zone = '+00:00', sql_mode = REPLACE(REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', ','), 'EMPTY_STRING_IS_NULL', ','), autocommit = 1, lc_messages = 'en_US', group_concat_max_len = @@max_allowed_packet",
    );
  });

  test('holds no backslash, double quote, semicolon or empty literal: it reads the same under any sql_mode', () => {
    assert.equal(/[\\";]|''/.test(SESSION_SQL), false);
  });
});

describe('initSession', () => {
  test('sends the session statement to a connection once, however many times it is handed out', async () => {
    const connection = createConnection();
    const again = { ...connection };

    assert.equal(await initSession(connection), true);
    assert.equal(await initSession(again), false);
    assert.deepEqual(connection.calls, [SESSION_SQL]);
  });

  test('sends the statement it is given in place of the plain one', async () => {
    const connection = createConnection();
    const sql = `${SESSION_SQL}, innodb_lock_wait_timeout = 5, lock_wait_timeout = 5`;

    assert.equal(await initSession(connection, sql), true);
    assert.deepEqual(connection.calls, [sql]);
  });

  test('closes a connection that refused the session statement and rejects with what the server answered', async () => {
    const refusal = Object.assign(new Error("Unknown system variable 'lc_messages'"), { errno: 1193, sqlState: 'HY000', code: 'ER_UNKNOWN_SYSTEM_VARIABLE' });
    const connection = createConnection(refusal);

    await assert.rejects(
      initSession(connection),
      (error) => error instanceof DbError && error.errno === 1193 && error.code === 'ER_UNKNOWN_SYSTEM_VARIABLE' && error.isConnectFailure === true,
    );
    await assert.rejects(initSession(connection), DbError);

    assert.deepEqual(connection.calls, [SESSION_SQL, 'destroy', SESSION_SQL, 'destroy']);
  });
});

describe('createMariadbDriver', () => {
  test('opens no connection by itself and reports an empty pool', (t) => {
    const driver = createDriver(t, { connectionLimit: 3, queueLimit: 7 });

    assert.ok(Object.isFrozen(driver));
    assert.deepEqual(driver.getStats(), {
      connectionLimit: 3,
      queueLimit: 7,
      activeCount: 0,
      queueLength: 0,
      rejectedCount: 0,
      timeoutCount: 0,
    });
  });

  test('limits both waits for a lock in the session of a connection of the pool, by db.lockWaitTimeout in whole seconds of at least one', async (t) => {
    const cases = [['0s', 1], ['0.05s', 1], ['1s', 1], ['1.2s', 2], ['5s', 5], ['1m', 60]];

    t.mock.method(PromisePool.prototype, 'getConnection', async () => createConnection());

    const sent = await Promise.all(cases.map(([lockWaitTimeout]) => createDriver(t, { lockWaitTimeout }).withConnection(({ calls }) => [...calls])));

    assert.deepEqual(sent, cases.map(([, seconds]) => [`${SESSION_SQL}, innodb_lock_wait_timeout = ${seconds}, lock_wait_timeout = ${seconds}`]));
  });

  test('hands out no connection whose session the server has refused to set: it is closed, and the caller gets the answer', async (t) => {
    const refusal = Object.assign(new Error("Unknown system variable 'lc_messages'"), { errno: 1193, sqlState: 'HY000', code: 'ER_UNKNOWN_SYSTEM_VARIABLE' });
    const connection = createConnection(refusal);
    const fn = t.mock.fn();

    t.mock.method(PromisePool.prototype, 'getConnection', async () => connection);

    await assert.rejects(
      createDriver(t, { lockWaitTimeout: '1s' }).withConnection(fn),
      (error) => error instanceof DbError && error.code === 'ER_UNKNOWN_SYSTEM_VARIABLE' && error.isConnectFailure === true,
    );

    assert.equal(fn.mock.callCount(), 0);
    assert.deepEqual(connection.calls, [`${SESSION_SQL}, innodb_lock_wait_timeout = 1, lock_wait_timeout = 1`, 'destroy']);
  });

  test('writes the values of a statement into it the way the text protocol sends them', (t) => {
    const driver = createDriver(t);
    const { text } = driver.prepare(
      "SELECT ':skip' AS note, :text, :number, :big, :yes, :nothing, :at, :bytes FROM t WHERE id IN (:ids) -- :skip",
      {
        text: "it's a\\b",
        number: -1.5,
        big: 12345678901234567890n,
        yes: true,
        nothing: null,
        at: new Date('2026-01-02T03:04:05.678Z'),
        bytes: Buffer.from('ab'),
        ids: [1, 'two'],
      },
    );

    assert.equal(
      text,
      "SELECT ':skip' AS note, 'it\\'s a\\\\b', -1.5, 12345678901234567890, true, NULL, '2026-01-02 03:04:05.678', X'6162' FROM t WHERE id IN (1, 'two') -- :skip",
    );
  });

  test('writes a date as the text of its moment in UTC, with the milliseconds', (t) => {
    const driver = createDriver(t);

    assert.equal(driver.prepare('SELECT :at', { at: new Date(Date.UTC(2026, 5, 30, 21, 0, 0, 5)) }).text, "SELECT '2026-06-30 21:00:00.005'");
  });

  test('quotes a name of letters, digits and underscores, and refuses any other', (t) => {
    const driver = createDriver(t);

    assert.equal(driver.quoteName('user_groups'), '`user_groups`');
    assert.equal(driver.quoteName('_x9'), '`_x9`');
    assert.equal(driver.quoteName('a'.repeat(64)), `\`${'a'.repeat(64)}\``);

    ['', 'a'.repeat(65), '9lives', 'user groups', 'users`', 'users; DROP TABLE users', 'u.id', 'імя', null, undefined, 5, ['users']].forEach((name) => {
      assert.throws(() => driver.quoteName(name), /A name of a table or a column must be 1 to 64 letters, digits and underscores/);
    });
  });

  test('escapes a name the server or the config gave, whatever it holds, by doubling its quote', (t) => {
    const driver = createDriver(t);

    assert.equal(driver.escapeName('nfs_dev'), '`nfs_dev`');
    assert.equal(driver.escapeName('my-app.2026'), '`my-app.2026`');
    assert.equal(driver.escapeName('a`b``c'), '`a``b````c`');
    assert.equal(driver.escapeName('x`; DROP DATABASE y; --'), '`x``; DROP DATABASE y; --`');

    ['', null, undefined, 5, ['users']].forEach((name) => {
      assert.throws(() => driver.escapeName(name), /escapeName\(name\) requires a name/);
    });
  });

  test('builds the clause that overwrites the named columns of a row that exists', (t) => {
    const driver = createDriver(t);

    assert.equal(
      driver.buildUpsertClause(['`name`', '`updated_at`']),
      'ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `updated_at` = VALUES(`updated_at`)',
    );
  });

  test('requires a function to run on a connection, and one of the known isolation levels', async (t) => {
    const driver = createDriver(t);

    await assert.rejects(driver.withConnection(), /withConnection\(fn\) requires a function/);
    await assert.rejects(driver.begin({}, { isolation: 'SNAPSHOT' }), /requires one of: READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ, SERIALIZABLE/);
  });

  test('gives up on a server that takes the connection and stays silent, after connectTimeout', { timeout: SILENT_SERVER_TEST_TIMEOUT_MS }, async (t) => {
    const sockets = new Set();
    const server = net.createServer((socket) => sockets.add(socket));

    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise((resolve) => {
      sockets.forEach((socket) => socket.destroy());
      server.close(resolve);
    }));

    const driver = createDriver(t, { host: '127.0.0.1', port: server.address().port, connectTimeout: '0.2s' });

    await assert.rejects(driver.ping(), (error) => error instanceof DbError && error.code === 'ETIMEDOUT' && error.isFatal === true);
    assert.equal(driver.getStats().activeCount, 0);
  });

  test('ends a pool that never connected, once', async () => {
    const driver = createMariadbDriver(createTestConfig().db);

    assert.equal(await driver.close(), true);
    assert.equal(await driver.close(), false);
    await assert.rejects(
      driver.ping(),
      (error) => error instanceof DbError && error.message === 'Pool is closed.' && !Object.hasOwn(error, 'isConnectFailure'),
    );
  });

  test('fails with the error of the connection when the database is down, and takes no slot of the pool for it', async (t) => {
    const driver = createDriver(t, {}, await createDownEnv());
    const results = await Promise.allSettled([driver.ping(), driver.verify(), driver.withConnection(() => 'never')]);

    results.forEach((result) => {
      assert.equal(result.status, 'rejected');
      assert.ok(result.reason instanceof DbError);
      assert.equal(result.reason.code, 'ECONNREFUSED');
      assert.equal(result.reason.isFatal, true);
      assert.equal(result.reason.isConnectFailure, true);
      assert.equal(result.reason.kind, undefined);
    });
    assert.equal(driver.getStats().activeCount, 0);
  });

  test('fails to open a script the same way when the database is down, and leaves nothing that keeps the process', async (t) => {
    const driver = createDriver(t, {}, await createDownEnv());

    const fn = t.mock.fn();

    await assert.rejects(driver.withScript({ database: 'app' }, fn), (error) => error instanceof DbError && error.code === 'ECONNREFUSED' && error.isFatal === true);
    assert.equal(fn.mock.callCount(), 0);
    assert.equal(driver.getStats().activeCount, 0);
  });

  test('requires the database of a script to be named, and a function to run with it: a script never lands in a database by default', async (t) => {
    const driver = createDriver(t, {}, await createDownEnv());
    const refusal = /withScript\(\{ database \}, fn\) requires the name of a database and a function/;

    await assert.rejects(driver.withScript({}, () => true), refusal);
    await assert.rejects(driver.withScript(undefined, () => true), refusal);
    await assert.rejects(driver.withScript({ database: '' }, () => true), refusal);
    await assert.rejects(driver.withScript({ database: 'app' }), refusal);
    assert.equal(driver.database, createTestConfig().db.database);
  });

  test('keeps the text of a connection that failed on a host with several addresses', async (t) => {
    const driver = createDriver(t, { host: 'localhost' }, await createDownEnv());

    await assert.rejects(driver.ping(), (error) => error instanceof DbError
      && error.code === 'ECONNREFUSED'
      && /connect ECONNREFUSED (127\.0\.0\.1|::1):\d+/.test(error.message));
  });

  test('refuses a caller when every connection is taken and the queue is full, before it asks the pool', async (t) => {
    const driver = createDriver(t, { connectionLimit: 1, queueLimit: 1 }, await createDownEnv());
    const first = driver.ping();
    const second = driver.ping();
    const third = await Promise.allSettled([driver.ping()]);
    const stats = driver.getStats();

    await Promise.allSettled([first, second]);

    assert.equal(third[0].reason.cause.kind, 'overload');
    assert.deepEqual([stats.activeCount, stats.queueLength, stats.rejectedCount], [1, 1, 1]);
    assert.deepEqual(driver.getStats().rejectedCount, 1);
  });
});
