import {
  connectAdmin,
  createDatabaseName,
  createTestDb,
  dropStaleDatabases,
} from '#root/tests/helper/db.js';
import { createWorkDir, runNode } from '#root/tests/helper/process.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const LEAVE_APP_OPEN = 'tests/fixture/leave-app-open.js';
const MS_IN_MINUTE = 60000;

const testDb = await createTestDb();

async function connect(t) {
  const connection = await connectAdmin();

  t.after(() => connection.end());

  return connection;
}

async function listDatabases(connection, names) {
  const [rows] = await connection.query('SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name IN (?)', [names]);

  return rows.map((row) => row.name).toSorted();
}

describe('createTestDb', { skip: testDb.skip }, () => {
  test('gives the file a database of its own, with a pool, a context and the env of a process that needs it', async (t) => {
    const connection = await connect(t);
    const { rows } = await testDb.run(() => testDb.db.query('SELECT DATABASE() AS name'));

    assert.equal(testDb.skip, false);
    assert.match(testDb.name, /^nfs_test_/);
    assert.deepEqual(rows, [{ name: testDb.name }]);
    assert.deepEqual(await listDatabases(connection, [testDb.name]), [testDb.name]);
    assert.equal(testDb.config.db.database, testDb.name);
    assert.equal(testDb.context.db, testDb.db);
    assert.equal(testDb.env.APP_DATABASE_NAME, testDb.name);
    assert.deepEqual(Object.keys(testDb.env).toSorted(), [
      'APP_DATABASE_HOST',
      'APP_DATABASE_NAME',
      'APP_DATABASE_PASSWORD',
      'APP_DATABASE_PORT',
      'APP_DATABASE_USER',
    ]);
  });

  test('creates the database in utf8mb4 with the binary collation by default', async () => {
    const { rows } = await testDb.run(() => testDb.db.query(
      'SELECT default_character_set_name AS charset, default_collation_name AS collation FROM information_schema.schemata WHERE schema_name = :name',
      { name: testDb.name },
    ));

    assert.deepEqual(rows, [{ charset: 'utf8mb4', collation: 'utf8mb4_bin' }]);
  });

  test('opens more pools on the same database, each with its own settings', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 }, logger: { level: 'warn' } });
    const { rows } = await single.run(() => single.db.query('SELECT DATABASE() AS name'));

    assert.deepEqual(rows, [{ name: testDb.name }]);
    assert.equal(single.config.db.connectionLimit, 1);
    assert.equal(single.config.logger.level, 'warn');
    assert.notEqual(single.db, testDb.db);
  });

  test('builds an app that works on the same database', async (t) => {
    const fastify = await testDb.buildApp();
    t.after(() => fastify.close());

    assert.equal(fastify.config.db.database, testDb.name);
    assert.match(await fastify.db.verify(), /MariaDB/);
  });

  // In a process of its own: a pool that is left open does not fail a test, it keeps the file from exiting,
  // and runNode() turns that into an error.
  test('ends the pool of an app a test has left open: the test file still exits by itself', async (t) => {
    const { code, stdout } = await runNode(LEAVE_APP_OPEN, { cwd: await createWorkDir(t), env: testDb.env });

    assert.equal(code, 0);
    assert.match(stdout, /^ℹ pass 1$/m);
  });
});

describe('dropStaleDatabases', { skip: testDb.skip }, () => {
  // A name of this run only, with the moment of so many minutes ago in it.
  function createAgedName(minutes) {
    const moment = (Date.now() - minutes * MS_IN_MINUTE).toString(16).padStart(12, '0');

    return createDatabaseName(`${moment.slice(0, 8)}-${moment.slice(8)}${uuidv7().slice(13)}`);
  }

  // Every other test file drops stale databases too, so what is asserted is the end state, not who dropped what.
  test('drops a database of the tests whose name is older than an hour, and keeps a younger one and a foreign one', async (t) => {
    const connection = await connect(t);
    const staleName = createAgedName(61);
    const youngName = createAgedName(59);
    const foreignName = `nfs_test_manual_copy_${uuidv7().slice(-12)}`;
    const names = [staleName, youngName, foreignName];

    await Promise.all(names.map((name) => connection.query(`CREATE DATABASE \`${name}\``)));

    try {
      const dropped = await dropStaleDatabases(connection);

      assert.equal(dropped.includes(youngName), false);
      assert.equal(dropped.includes(foreignName), false);
      assert.equal(dropped.includes(testDb.name), false);
      assert.deepEqual(
        await listDatabases(connection, [...names, testDb.name]),
        [testDb.name, youngName, foreignName].toSorted(),
      );
    } finally {
      await Promise.all(names.map((name) => connection.query(`DROP DATABASE IF EXISTS \`${name}\``)));
    }
  });
});
