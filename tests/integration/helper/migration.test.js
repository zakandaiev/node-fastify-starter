import { isMissingTable } from '#core/db/error.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import {
  bindMigrator,
  createMigrationDir,
  createMigrationEvents,
  describeDirtyRefusal,
  listReferenceNames,
  listTableNames,
  readAppliedRows,
  readStatementsByHand,
  runMigrateProcess,
} from '#root/tests/helper/migration.js';
import { mapSeries } from '#utils/async.js';
import { sha256 } from '#utils/hash.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const TEAMS = Object.freeze({
  '0001_teams.up.sql': 'CREATE TABLE teams (id INT PRIMARY KEY) COLLATE=utf8mb4_bin;\n',
});
const MEMBERS = Object.freeze({
  '0002_members.up.sql': 'CREATE TABLE members (id INT PRIMARY KEY) COLLATE=utf8mb4_bin;\n',
});
const FIRST_TEAM = Object.freeze({
  'seed/0001_first_team.up.sql': 'INSERT INTO teams (id) VALUES (1);\n',
});

// Fails in its second statement, after the first has made a table: the row of the file stays marked.
const BROKEN = Object.freeze({
  '0003_broken.up.sql': 'CREATE TABLE halves (id INT PRIMARY KEY);\nCREATE TABLE halves (id INT);\n',
});

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

describe('readAppliedRows', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('reads through a pool what the migrator has recorded: the migrations before the seeds, each in the order of the versions', async (t) => {
    const directory = await createMigrationDir(t, { ...TEAMS, ...MEMBERS, ...FIRST_TEAM });

    await up({ directory });
    await up({ directory, type: MIGRATION_TYPE.SEED });

    const rows = await readAppliedRows(testDb.open({}, t));

    assert.deepEqual(Object.keys(rows[0]), ['type', 'version', 'name', 'batch', 'is_dirty']);
    assert.deepEqual(rows.map((row) => Object.values(row)), [
      [MIGRATION_TYPE.MIGRATION, 1, 'teams', 1, false],
      [MIGRATION_TYPE.MIGRATION, 2, 'members', 1, false],
      [MIGRATION_TYPE.SEED, 1, 'first_team', 2, false],
    ]);
  });

  test('tells the row of a file that failed halfway by its mark, a boolean like the rest', async (t) => {
    const directory = await createMigrationDir(t, { ...TEAMS, ...BROKEN });

    await assert.rejects(up({ directory }), /0003_broken\.up\.sql: statement 2 failed/);

    assert.deepEqual((await readAppliedRows(testDb)).map((row) => [row.name, row.is_dirty]), [['teams', false], ['broken', true]]);
  });

  test('rejects with the error of the server while the migrator has recorded nothing: its table is made with the first file, and a test that expects none asks listTableNames()', async () => {
    const error = await rejectionOf(readAppliedRows(testDb));

    assert.equal(isMissingTable(error), true);
    assert.deepEqual(await listTableNames(testDb), []);
  });
});

describe('listTableNames', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('names the tables of the database of a pool, sorted as a test writes a list: an underscore before the letters, whatever order the server gives', async (t) => {
    await testDb.readRows('CREATE TABLE teams (id INT PRIMARY KEY)');
    await testDb.readRows('CREATE TABLE _drafts (id INT PRIMARY KEY)');
    await testDb.readRows('CREATE TABLE members (id INT PRIMARY KEY)');

    assert.deepEqual(await listTableNames(testDb.open({}, t)), ['_drafts', 'members', 'teams']);
  });

  test('names no table of another database, and none at all in a database that is empty', async (t) => {
    const neighbour = await testDb.createNeighbour(t);

    await testDb.readRows(`CREATE TABLE \`${neighbour}\`.plans (id INT PRIMARY KEY)`);

    assert.deepEqual(await listTableNames(testDb), []);
  });
});

describe('listReferenceNames', { skip: testDb.skip }, () => {
  test('names the databases under the prefix "verify" builds by for the pool, sorted, and no other: not the database of the file, not a neighbour of it', async (t) => {
    const prefix = testDb.config.db.migrationReferencePrefix;
    const names = [`${prefix}b`, `${prefix}a`];

    t.after(() => Promise.allSettled(names.map((name) => testDb.runAsAdmin(`DROP DATABASE IF EXISTS \`${name}\``))));
    await testDb.createNeighbour(t);

    assert.deepEqual(await listReferenceNames(testDb), []);

    await mapSeries(names, (name) => testDb.runAsAdmin(`CREATE DATABASE \`${name}\``));

    assert.deepEqual(await listReferenceNames(testDb), names.toSorted());
    assert.deepEqual(await listReferenceNames(testDb.open({ db: { migrationReferencePrefix: 'no_such_prefix_' } }, t)), []);
  });
});

describe('describeDirtyRefusal and readStatementsByHand', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('spell the refusal of a dirty row as the migrator gives it, and read out of it the two statements it tells to run', async (t) => {
    const directory = await createMigrationDir(t, { ...TEAMS, ...BROKEN });
    const checksum = sha256(BROKEN['0003_broken.up.sql']);

    await assert.rejects(up({ directory }), /the migration is left dirty/);

    const refusal = await rejectionOf(up({ directory }));

    assert.equal(refusal.message, describeDirtyRefusal({ id: '0003_broken', version: 3, checksum }));
    assert.deepEqual(readStatementsByHand(refusal.message), [
      "DELETE FROM _migrations WHERE type = 'migration' AND version = 3",
      `UPDATE _migrations SET is_dirty = 0, checksum = '${checksum}' WHERE type = 'migration' AND version = 3`,
    ]);
  });
});

describe('createMigrationEvents', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('records a run of the migrator: every file is started and finished in its turn, with a duration the helper takes', async (t) => {
    const directory = await createMigrationDir(t, { ...TEAMS, ...MEMBERS });
    const { events, hooks } = createMigrationEvents();

    await up({ directory, ...hooks });

    assert.deepEqual(events, [
      'start 0001_teams.up.sql',
      'finish 0001_teams.up.sql',
      'start 0002_members.up.sql',
      'finish 0002_members.up.sql',
    ]);
  });
});

describe('runMigrateProcess', { skip: testDb.skip }, () => {
  test('runs the script on the database of the file with the env createTestDb() gives: the process names it as its target and ends without a failure', async (t) => {
    const { code, stdout } = await runMigrateProcess(t, testDb.env, ['--direction=status']);
    const { APP_DATABASE_USER: user, APP_DATABASE_HOST: host, APP_DATABASE_PORT: port } = testDb.env;

    assert.equal(code, 0);
    assert.equal(stdout.split('\n')[0], `⏳ Migration target: ${user}@${host}:${port}/${testDb.name} (APP_MODE=prod)`);
  });
});
