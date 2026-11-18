import { TEST_ENV } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import {
  createMigrationDir,
  createMigrationEvents,
  describeDirtyRefusal,
  readKillStatement,
  readStatementsByHand,
  removeMigrationFiles,
  runMigrateProcess,
  writeMigrationFiles,
} from '#root/tests/helper/migration.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { describe, test } from 'node:test';

const WRONG_DURATIONS = Object.freeze([undefined, null, -1, 1.5, '12', Number.NaN, Number.POSITIVE_INFINITY]);

const MISSING_FILE_CODE = 'ENOENT';

const BUILD = Object.freeze({
  '0001_users.up.sql': 'CREATE TABLE users (id INT);\n',
  '0001_users.down.sql': 'DROP TABLE users;\n',
  '0002_sessions.up.sql': 'CREATE TABLE sessions (id INT);\n',
  'seed/0001_groups.up.sql': 'SELECT 1;\n',
  'seed/0002_roles.up.sql': 'SELECT 2;\n',
});

describe('createMigrationDir', () => {
  test('gives a test an empty directory of its own and removes it after the test', async (t) => {
    let directory;

    await t.test('inside the test', async (inner) => {
      directory = await createMigrationDir(inner);

      assert.deepEqual(await readdir(directory), []);
    });

    assert.equal(existsSync(directory), false);
  });

  test('writes the files it is given, those of a nested directory too', async (t) => {
    const directory = await createMigrationDir(t, {
      '0001_users.up.sql': 'CREATE TABLE users (id INT);\n',
      'seed/0001_groups.up.sql': 'SELECT 1;\r\n',
    });

    assert.deepEqual((await readdir(directory)).toSorted(), ['0001_users.up.sql', 'seed']);
    assert.equal(await readFile(nodePath.join(directory, '0001_users.up.sql'), 'utf8'), 'CREATE TABLE users (id INT);\n');
    assert.equal(await readFile(nodePath.join(directory, 'seed', '0001_groups.up.sql'), 'utf8'), 'SELECT 1;\r\n');
  });
});

describe('writeMigrationFiles', () => {
  test('adds files to a directory and overwrites the ones that exist', async (t) => {
    const directory = await createMigrationDir(t, { '0001_users.up.sql': 'first' });

    await writeMigrationFiles(directory, { '0001_users.up.sql': 'second', '0001_users.down.sql': 'DROP TABLE users;' });

    assert.deepEqual((await readdir(directory)).toSorted(), ['0001_users.down.sql', '0001_users.up.sql']);
    assert.equal(await readFile(nodePath.join(directory, '0001_users.up.sql'), 'utf8'), 'second');
  });
});

describe('removeMigrationFiles', () => {
  test('removes exactly the files it is told to, those of a nested directory too, and leaves the rest of the build', async (t) => {
    const directory = await createMigrationDir(t, BUILD);

    await removeMigrationFiles(directory, ['0001_users.down.sql', '0002_sessions.up.sql', 'seed/0001_groups.up.sql']);

    assert.deepEqual((await readdir(directory)).toSorted(), ['0001_users.up.sql', 'seed']);
    assert.deepEqual(await readdir(nodePath.join(directory, 'seed')), ['0002_roles.up.sql']);
    assert.equal(await readFile(nodePath.join(directory, '0001_users.up.sql'), 'utf8'), BUILD['0001_users.up.sql']);
  });

  test('rejects for a file that is not there: a test that misspells a name must not go on with a build that has lost nothing', async (t) => {
    const directory = await createMigrationDir(t, BUILD);

    await assert.rejects(removeMigrationFiles(directory, ['0003_absent.up.sql']), { code: MISSING_FILE_CODE });
    await assert.rejects(removeMigrationFiles(directory, ['seed/0001_users.up.sql']), { code: MISSING_FILE_CODE });
    assert.deepEqual((await readdir(directory)).toSorted(), ['0001_users.down.sql', '0001_users.up.sql', '0002_sessions.up.sql', 'seed']);
    assert.deepEqual((await readdir(nodePath.join(directory, 'seed'))).toSorted(), ['0001_groups.up.sql', '0002_roles.up.sql']);
  });
});

describe('readStatementsByHand and readKillStatement', () => {
  test('read the statements on the table of the migrator out of a message, each as far as it goes, and none where the message holds none', () => {
    const closing = "UPDATE _migrations SET is_dirty = FALSE, duration_ms = 7, applied_at = CURRENT_TIMESTAMP(3) WHERE type = 'migration' AND version = 1 AND is_dirty = TRUE";
    const unmarking = "DELETE FROM _migrations WHERE type = 'seed' AND version = 12 AND is_dirty = TRUE";

    assert.deepEqual(readStatementsByHand(`0001_users.up.sql has run to its end, but that could not be recorded. Record it by hand: ${closing}`), [closing]);
    assert.deepEqual(readStatementsByHand(`should it call the seed dirty, this takes it back: ${unmarking}`), [unmarking]);
    assert.deepEqual(readStatementsByHand(describeDirtyRefusal({ id: '0002_teams', version: 2, checksum: 'abc' })), [
      "DELETE FROM _migrations WHERE type = 'migration' AND version = 2",
      "UPDATE _migrations SET is_dirty = 0, checksum = 'abc' WHERE type = 'migration' AND version = 2",
    ]);
    assert.deepEqual(readStatementsByHand('0001_users.up.sql: statement 2 failed'), []);
  });

  test('read the KILL a message tells to run, and nothing where it tells none', () => {
    assert.equal(readKillStatement('on connection 412: its row tells what it is doing, and KILL 412 frees the lock'), 'KILL 412');
    assert.equal(readKillStatement('The migration is left dirty'), null);
  });
});

describe('describeDirtyRefusal', () => {
  test('names the type and the id, both statements with the key of the row, and ends with the note it is given', () => {
    const refusal = describeDirtyRefusal({
      type: 'seed', id: '0003_groups', version: 3, checksum: 'abc', note: '. The up file has changed',
    });

    assert.match(refusal, /^The seed 0003_groups is dirty: a run of its up or its down file failed or was cut short/);
    assert.match(refusal, /what 0003_groups\.up\.sql makes is not known/);
    assert.match(refusal, /DELETE FROM _migrations WHERE type = 'seed' AND version = 3\. /);
    assert.match(refusal, /UPDATE _migrations SET is_dirty = 0, checksum = 'abc' WHERE type = 'seed' AND version = 3\. The up file has changed$/);
  });
});

describe('createMigrationEvents', () => {
  test('records what the callbacks of a migrator command were called with, in the order of the calls', () => {
    const { events, hooks } = createMigrationEvents();

    hooks.onLockWait();
    hooks.onFileStart('0001_users.up.sql');
    hooks.onFileFinish('0001_users.up.sql', 12);
    hooks.onFileStart('0002_sessions.up.sql');
    hooks.onFileFinish('0002_sessions.up.sql', 0);

    assert.deepEqual(Object.keys(hooks).toSorted(), ['onFileFinish', 'onFileStart', 'onLockWait']);
    assert.deepEqual(events, [
      'wait',
      'start 0001_users.up.sql',
      'finish 0001_users.up.sql',
      'start 0002_sessions.up.sql',
      'finish 0002_sessions.up.sql',
    ]);
  });

  test('keeps the events of every call apart', () => {
    const first = createMigrationEvents();
    const second = createMigrationEvents();

    first.hooks.onLockWait();

    assert.deepEqual([first.events, second.events], [['wait'], []]);
  });

  test('throws when a file is finished with a duration that is not an integer of zero or more, and records nothing of it', () => {
    const { events, hooks } = createMigrationEvents();

    WRONG_DURATIONS.forEach((durationMs) => {
      assert.throws(
        () => hooks.onFileFinish('0001_users.up.sql', durationMs),
        { message: `onFileFinish(fileName, durationMs) was given the duration ${durationMs}` },
      );
    });
    assert.deepEqual(events, []);
  });
});

describe('runMigrateProcess', () => {
  test('refuses a database that is not one of the tests, and a "make" that would write into the repository, with a system environment or without one', async (t) => {
    const systemEnv = { APP_MODE: 'dev' };

    await assert.rejects(runMigrateProcess(t, { APP_DATABASE_NAME: 'nfs_dev' }, ['--direction=status']), /works on a database of the tests only/);
    await assert.rejects(runMigrateProcess(t, { APP_DATABASE_NAME: 'nfs_dev' }, ['--direction=status'], systemEnv), /works on a database of the tests only/);
    await assert.rejects(runMigrateProcess(t, {}, ['--direction=status']), /works on a database of the tests only/);
    await assert.rejects(
      runMigrateProcess(t, { APP_DATABASE_NAME: 'nfs_test_x' }, ['--direction=make', '--names=users']),
      /runs --direction=make with --dry-run only/,
    );
    await assert.rejects(
      runMigrateProcess(t, { APP_DATABASE_NAME: 'nfs_test_x' }, ['--direction=make', '--names=users'], systemEnv),
      /runs --direction=make with --dry-run only/,
    );
  });

  test('refuses a "make" in every spelling the script takes: the direction as a word of its own, and after another direction', async (t) => {
    const env = { APP_DATABASE_NAME: 'nfs_test_x' };
    const spellings = [
      ['--direction', 'make', '--names', 'users'],
      ['--names=users', '--direction', 'make'],
      ['--direction=status', '--direction=make', '--names=users'],
    ];

    await Promise.all(spellings.map((args) => assert.rejects(
      runMigrateProcess(t, env, args),
      /runs --direction=make with --dry-run only/,
      args.join(' '),
    )));
  });

  test('runs the script in a working directory of its own, with the env it is given', async (t) => {
    const { code, stdout } = await runMigrateProcess(t, { APP_DATABASE_NAME: 'nfs_test_x' }, ['--direction=make', '--names=never_made_by_this_test', '--dry-run']);

    assert.equal(code, 0);
    assert.match(stdout, /^✅ Migration would create: migrations\/mariadb\/\d{4}_never_made_by_this_test\.up\.sql$/m);
  });

  test('sets the fourth argument in the environment of the process, where a variable wins over the same one of the file', async (t) => {
    const down = await createDownEnv();
    const { code, stdout } = await runMigrateProcess(
      t,
      { ...down, APP_DATABASE_NAME: 'nfs_test_of_the_file' },
      ['--direction=status'],
      { APP_DATABASE_NAME: 'nfs_test_of_the_shell' },
    );

    assert.equal(code, 1);
    assert.equal(
      stdout.split('\n')[0],
      `⏳ Migration target: ${TEST_ENV.APP_DATABASE_USER}@${down.APP_DATABASE_HOST}:${down.APP_DATABASE_PORT}/nfs_test_of_the_shell (APP_MODE=prod)`,
    );
  });

  test('refuses a database that is not one of the tests when the system environment names it: there the name wins over the one of the file', async (t) => {
    const down = await createDownEnv();

    await assert.rejects(
      runMigrateProcess(t, { ...down, APP_DATABASE_NAME: 'nfs_test_x' }, ['--direction=status'], { APP_DATABASE_NAME: 'nfs_dev' }),
      /works on a database of the tests only/,
    );
  });
});
