import { DbError } from '#core/db/error.js';
import {
  findPendingMigrations,
  getMigrationStatus,
  migrateDown,
  migrateFresh,
  migrateUp,
  verifyMigrations,
} from '#core/db/migrator.js';
import { createDownDb } from '#root/tests/helper/db.js';
import { createMigrationDir } from '#root/tests/helper/migration.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const USERS = Object.freeze({ '0001_users.up.sql': 'CREATE TABLE users (id INT PRIMARY KEY);\n' });

function isRefused(error) {
  return error instanceof DbError && error.code === 'ECONNREFUSED';
}

describe('migrator without a database', () => {
  test('requires options of the right kinds before it asks for a connection', async (t) => {
    const down = await createDownDb(t);
    const directory = await createMigrationDir(t, USERS);
    const cases = [
      [{ type: 'schema' }, /migrateUp\(options\) requires type to be one of: migration, seed/],
      [{ names: 'users' }, /requires names and namesExclude to be lists of names/],
      [{ namesExclude: [5] }, /requires names and namesExclude to be lists of names/],
      [{ isDryRun: 'yes' }, /requires isDryRun to be a boolean and directory a path/],
      [{ directory: '' }, /requires isDryRun to be a boolean and directory a path/],
      [{ onFileStart: 'print' }, /requires onLockWait, onFileStart and onFileFinish to be functions/],
    ];

    await Promise.all(cases.map(([options, message]) => assert.rejects(down.run(() => migrateUp({ directory, ...options })), message)));
    await assert.rejects(down.run(() => migrateDown({ directory, type: 'schema' })), /migrateDown\(options\) requires type to be one of/);
    await assert.rejects(down.run(() => getMigrationStatus({ directory, type: 'schema' })), /getMigrationStatus\(options\) requires type to be one of/);
    await assert.rejects(down.run(() => verifyMigrations({ directory, onLockWait: 1 })), /verifyMigrations\(options\) requires onLockWait/);
    assert.equal(down.db.getStats().activeCount, 0);
  });

  test('requires a context with a database', async (t) => {
    const directory = await createMigrationDir(t, USERS);

    await assert.rejects(migrateUp({ directory }), /No active context/);
    await assert.rejects(findPendingMigrations({ directory }), /No active context/);
  });

  test('fails with the error of the connection when the database is out of reach, a dry run included', async (t) => {
    const down = await createDownDb(t);
    const directory = await createMigrationDir(t, USERS);
    const empty = await createMigrationDir(t);

    await assert.rejects(down.run(() => migrateUp({ directory })), isRefused);
    await assert.rejects(down.run(() => migrateUp({ directory, isDryRun: true })), isRefused);
    await assert.rejects(down.run(() => migrateDown({ directory })), isRefused);
    await assert.rejects(down.run(() => getMigrationStatus({ directory })), isRefused);
    await assert.rejects(down.run(() => verifyMigrations({ directory })), isRefused);
    await assert.rejects(down.run(() => findPendingMigrations({ directory })), isRefused);
    await assert.rejects(down.run(() => findPendingMigrations({ directory: empty })), isRefused);
    assert.equal(down.db.getStats().activeCount, 0);
  });

  test('refuses "fresh" outside dev mode before it looks for the database, a dry run included', async (t) => {
    const down = await createDownDb(t);
    const directory = await createMigrationDir(t, USERS);
    const refusal = /"fresh" drops the database "nfs_test" with everything in it: it runs only when APP_MODE=dev/;

    await assert.rejects(down.run(() => migrateFresh({ directory })), refusal);
    await assert.rejects(down.run(() => migrateFresh({ directory, isDryRun: true })), refusal);
  });

  test('names what a dry run of "fresh" would drop and apply, without the database: every migration, whatever is applied', async (t) => {
    const dev = await createDownDb(t, { env: { APP_MODE: 'dev' } });
    const directory = await createMigrationDir(t, { ...USERS, '0002_sessions.up.sql': 'CREATE TABLE sessions (id INT);\n' });

    assert.deepEqual(await dev.run(() => migrateFresh({ directory, isDryRun: true })), {
      files: ['0001_users.up.sql', '0002_sessions.up.sql'],
      isDryRun: true,
      database: 'nfs_test',
    });
    await assert.rejects(dev.run(() => migrateFresh({ directory })), isRefused);
  });

  test('checks the files of "fresh" before anything is dropped: an empty one, one that names a database', async (t) => {
    const dev = await createDownDb(t, { env: { APP_MODE: 'dev' } });
    const unwritten = await createMigrationDir(t, { ...USERS, '0002_sessions.up.sql': '' });
    const naming = await createMigrationDir(t, { ...USERS, '0002_sessions.up.sql': 'CREATE TABLE nfs_test.sessions (id INT);\n' });

    await assert.rejects(dev.run(() => migrateFresh({ directory: unwritten })), /0002_sessions\.up\.sql is empty/);
    await assert.rejects(dev.run(() => migrateFresh({ directory: naming })), /0002_sessions\.up\.sql holds the name of the database in front of a table \(nfs_test\.sessions; /);
  });
});
