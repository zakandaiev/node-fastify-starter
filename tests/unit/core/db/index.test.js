import { createContext, runInContext } from '#core/context/index.js';
import { DbError } from '#core/db/error.js';
import {
  createDb,
  insertReturning,
  now,
  updateReturning,
  upsert,
} from '#core/db/index.js';
import { createLogger } from '#core/logger/index.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { db: DB_CONFIG } = createTestConfig();

const DURATION_KEYS = Object.freeze([
  'connectTimeout',
  'statementTimeout',
  'slowQueryThreshold',
  'lockWaitTimeout',
  'transactionTimeout',
  'migrationLockTimeout',
  'migrationTableLockTimeout',
  'migrationIdleTimeout',
]);

describe('createDb', () => {
  test('requires the db section of the config', () => {
    assert.throws(() => createDb(), /createDb\(config\) requires the db section of createConfig\(\)/);
    assert.throws(() => createDb(null), TypeError);
    assert.throws(() => createDb('mariadb://localhost'), TypeError);
  });

  test('refuses a pool without a connection and a queue below zero', () => {
    const sizes = [
      { connectionLimit: 0 },
      { connectionLimit: 1.5 },
      { connectionLimit: '10' },
      { connectionLimit: undefined },
      { queueLimit: -1 },
      { queueLimit: 0.5 },
      { queueLimit: undefined },
    ];

    sizes.forEach((size) => {
      assert.throws(() => createDb({ ...DB_CONFIG, ...size }), /config\.db requires connectionLimit to be a positive integer/);
    });
  });

  test('refuses a duration that is zero, below zero or not a duration, each of them: one read on a rare path only would fail on the day that path is taken', () => {
    const refusal = /config\.db requires connectTimeout, statementTimeout, slowQueryThreshold, lockWaitTimeout, transactionTimeout, migrationLockTimeout, migrationTableLockTimeout, migrationIdleTimeout to be above zero/;

    DURATION_KEYS.forEach((key) => {
      assert.throws(() => createDb({ ...DB_CONFIG, [key]: '0s' }), refusal, key);
      assert.throws(() => createDb({ ...DB_CONFIG, [key]: '-1s' }), refusal, key);
      assert.throws(() => createDb({ ...DB_CONFIG, [key]: 10 }), /convertStringToMs\(value\) requires a number with a unit/, key);
      assert.throws(() => createDb({ ...DB_CONFIG, [key]: '3 seconds' }), /convertStringToMs\(value\) requires a number with a unit/, key);
    });
  });

  test('refuses a deadline of a transaction that is not above the wait for a lock: that wait is what ends a statement left behind at the server', () => {
    const refusal = /config\.db requires transactionTimeout to be above lockWaitTimeout/;

    assert.throws(() => createDb({ ...DB_CONFIG, lockWaitTimeout: '5s', transactionTimeout: '5s' }), refusal);
    assert.throws(() => createDb({ ...DB_CONFIG, lockWaitTimeout: '6s', transactionTimeout: '5s' }), refusal);
  });

  test('refuses a prefix of the databases "verify" builds that is no name, or leaves no room for the UUID after it', () => {
    const refusal = /config\.db requires migrationReferencePrefix to be 1 to 28 letters, digits and underscores that do not start with a digit/;
    const prefixes = ['', '1_verify_', 'migration-verify-', 'verify`_', `${'v'.repeat(28)}_`, undefined, 28];

    prefixes.forEach((migrationReferencePrefix) => {
      assert.throws(() => createDb({ ...DB_CONFIG, migrationReferencePrefix }), refusal, String(migrationReferencePrefix));
    });
    assert.equal(createDb({ ...DB_CONFIG, migrationReferencePrefix: 'v'.repeat(28) }).getStats().activeCount, 0);
    assert.equal(createDb(DB_CONFIG).getStats().activeCount, 0);
  });

  test('returns a frozen handle and opens no connection', async () => {
    const db = createDb(DB_CONFIG);

    assert.ok(Object.isFrozen(db));
    assert.deepEqual(Object.keys(db), ['driver', 'query', 'verify', 'ping', 'close', 'getStats']);
    assert.equal(db.getStats().activeCount, 0);
    assert.equal(await db.close(), true);
  });

  test('accepts a pool without a queue', async () => {
    const db = createDb({ ...DB_CONFIG, queueLimit: 0 });

    assert.equal(db.getStats().queueLimit, 0);
    await db.close();
  });
});

describe('db.query', () => {
  test('requires a context: outside one it rejects', async (t) => {
    const { db } = await createDownDb(t);

    await assert.rejects(db.query('SELECT 1'), /No active context: wrap the call in runInContext/);
  });

  test('rejects a wrong binding before it asks for a connection', async (t) => {
    const { db, run } = await createDownDb(t);

    await assert.rejects(run(() => db.query('SELECT :id', { id: {} })), /Placeholder :id cannot be bound to a value of type object/);
    await assert.rejects(run(() => db.query('SELECT :id')), /Placeholder :id has no value/);
    assert.equal(db.getStats().activeCount, 0);
  });

  test('rejects with the error of the connection when the database is down, and logs no statement', async (t) => {
    const sink = createLogSink();
    const { db, run } = await createDownDb(t, { logger: { level: 'debug', stream: sink.stream } });

    await assert.rejects(run(() => db.query('SELECT 1')), (error) => error instanceof DbError && error.code === 'ECONNREFUSED');
    assert.deepEqual(sink.lines, []);
  });

  test('ping() and verify() need no context and reject the same way', async (t) => {
    const { db } = await createDownDb(t);

    await assert.rejects(db.ping(), (error) => error instanceof DbError && error.isFatal === true);
    await assert.rejects(db.verify(), (error) => error instanceof DbError && error.code === 'ECONNREFUSED');
  });
});

describe('db helpers without a database', () => {
  test('require a context', async () => {
    await assert.rejects(upsert('users', { id: 1 }, { update: ['id'] }), /No active context/);
    await assert.rejects(insertReturning('users', { id: 1 }), /No active context/);
    await assert.rejects(updateReturning('users', { name: 'x' }, { where: { id: 1 } }), /No active context/);
    await assert.rejects(now(), /No active context/);
  });

  test('require a database in the context', async () => {
    const context = createContext({ config: createTestConfig(), log: createLogger({ level: 'silent' }) });

    await assert.rejects(runInContext(context, () => now()), /The context has no database/);
    await assert.rejects(runInContext(context, () => insertReturning('users', { id: 1 })), /The context has no database/);
  });

  test('refuse a wrong name before anything is sent', async (t) => {
    const { run } = await createDownDb(t);

    await assert.rejects(run(() => insertReturning('users; DROP TABLE users', { id: 1 })), TypeError);
    await assert.rejects(run(() => upsert('users', { 'id`': 1 }, { update: ['id`'] })), TypeError);
    await assert.rejects(run(() => updateReturning('users', { name: 'x' }, { where: { 'id = 1 OR 1': 1 } })), TypeError);
  });
});
