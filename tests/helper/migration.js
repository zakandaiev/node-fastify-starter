import {
  getMigrationStatus,
  migrateDown,
  migrateUp,
  verifyMigrations,
} from '#core/db/migrator.js';
import { MIGRATION_DIRECTION } from '#enums/migration-direction.js';
import { waitFor } from '#root/tests/helper/async.js';
import { TEST_ENV } from '#root/tests/helper/config.js';
import { DATABASE_PREFIX, killSession, toLikePattern } from '#root/tests/helper/db.js';
import { createWorkDir, runNode } from '#root/tests/helper/process.js';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { parseArgs } from 'node:util';

const MIGRATE = 'scripts/migrate.js';
const LOCK_PREFIX = 'migrator:';

const BY_HAND_REGEXP = /(?:DELETE FROM|UPDATE) _migrations .*?version = \d+(?: AND is_dirty = TRUE)?/g;
const KILL_REGEXP = /KILL \d+/;

// The files of the repository, in their order, as a test of the script or of an entrypoint on them names them.
export const REPOSITORY_MIGRATIONS = Object.freeze([
  '0001_users',
  '0002_user_identities',
  '0003_groups',
  '0004_group_scopes',
  '0005_user_groups',
  '0006_audit_logs',
  '0007_sessions',
  '0008_user_identities_email_verified',
  '0009_audit_logs_actor',
]);
export const REPOSITORY_SEEDS = Object.freeze(['0001_groups']);

// The tables those files make, in the order of the files that create them.
export const REPOSITORY_TABLES = Object.freeze(['users', 'user_identities', 'groups', 'group_scopes', 'user_groups', 'audit_logs', 'sessions']);

// The words of the migrator that more than one test file compares a message with.
export const MIGRATION_TEXT = Object.freeze({
  NAMES_NO_DATABASE: 'a migration file works in the database it is applied to and never names one',
  TABLE_HELD: 'Lock wait timeout exceeded; try restarting transaction: another session holds what the statement waited for, an open transaction on its table most likely',
  REWRITTEN_NOTE: '. The up file is not the text the row was marked with: the UPDATE records the file as it is now; without "checksum" in it the row keeps the text it has, and the migration reads as changed',
});

// How a refusal names the live database it has found in front of a table; "found" is the name as the file spells it.
export function describeQualifiedName(found) {
  return `the name of the database in front of a table (${found}; a table or an alias of that name reads the same and needs another alias)`;
}

// "files" maps a path inside the directory to the text of the file: { '0001_users.up.sql': 'CREATE TABLE ...',
// 'seed/0001_groups.up.sql': 'INSERT ...' }. A file that exists is overwritten.
export async function writeMigrationFiles(directory, files) {
  await Promise.all(Object.entries(files).map(async ([name, sql]) => {
    const path = nodePath.join(directory, name);

    await mkdir(nodePath.dirname(path), { recursive: true });
    await writeFile(path, sql);
  }));
}

// A build that has lost some of its files: "names" are paths inside the directory, as in writeMigrationFiles().
export async function removeMigrationFiles(directory, names) {
  await Promise.all(names.map((name) => rm(nodePath.join(directory, name))));
}

// A directory of migrations of its own for one test, removed after it.
export async function createMigrationDir(t, files = {}) {
  const directory = await createWorkDir(t);

  await writeMigrationFiles(directory, files);

  return directory;
}

// The commands of the migrator, each run in the context of a pool: the one given here, or another for one call.
export function bindMigrator(defaultPool) {
  function readStatus(options, pool = defaultPool) {
    return pool.run(() => getMigrationStatus(options));
  }

  async function readStates(options, pool = defaultPool) {
    return (await readStatus(options, pool)).map((item) => [item.id, item.state]);
  }

  return {
    up: (options, pool = defaultPool) => pool.run(() => migrateUp(options)),
    down: (options, pool = defaultPool) => pool.run(() => migrateDown(options)),
    verify: (options, pool = defaultPool) => pool.run(() => verifyMigrations(options)),
    readStatus,
    readStates,
  };
}

// What the migrator has recorded, as a test compares it. "pool" is what createTestDb() and its open() return.
export function readAppliedRows(pool) {
  return pool.readRows('SELECT type, version, name, batch, is_dirty FROM _migrations ORDER BY type, version');
}

export async function readDirtyMarks(pool) {
  return (await readAppliedRows(pool)).map((row) => [row.name, row.is_dirty]);
}

// The session a migrator at work on the database of a pool keeps its lock on, null when there is none.
export async function readMigratorLockHolder(pool) {
  const [{ holder }] = await pool.readRows('SELECT IS_USED_LOCK(CONCAT(:prefix, DATABASE())) AS holder', { prefix: LOCK_PREFIX });

  return holder;
}

// Ends that session, as a server or a proxy that drops an idle connection does: the lock goes with it, the
// migrator stays alive, and the server goes on with the file it was sent.
export async function loseMigratorLock(pool) {
  const holder = await readMigratorLockHolder(pool);

  assert.ok(Number.isInteger(holder), 'No migrator holds the lock of the database');
  await killSession(pool, holder);
  await waitFor(async () => (await readMigratorLockHolder(pool)) === null, 'the lock of the database to be free');
}

// Sorted here, as a test writes a list: the server puts an underscore after the letters.
export async function listTableNames(pool) {
  const rows = await pool.readRows('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()');

  return rows.map((row) => row.name).toSorted();
}

// The first line of every run of the script that goes to a database: where it is going, by the config it was given.
export function describeTarget(label, config) {
  const {
    user, host, port, database,
  } = config.db;

  return `⏳ ${label} target: ${user}@${host}:${port}/${database} (APP_MODE=${config.app.mode})`;
}

// The databases "verify" has built through the pools of a test file and has not dropped.
export async function listReferenceNames(pool) {
  const rows = await pool.readRows(
    'SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name LIKE :pattern',
    { pattern: toLikePattern(pool.config.db.migrationReferencePrefix) },
  );

  return rows.map((row) => row.name).toSorted();
}

// The statements a message of the migrator tells its reader to run by hand, as the message spells them:
// a test runs them and proves they do what the message says.
export function readStatementsByHand(message) {
  return message.match(BY_HAND_REGEXP) ?? [];
}

export function readKillStatement(message) {
  return message.match(KILL_REGEXP)?.[0] ?? null;
}

// What an entrypoint is refused with while migrations of its build are not applied or dirty; "ids" as 0001_users.
export function describePendingRefusal(ids) {
  return `The database is behind this build, not applied or dirty: ${ids.join(', ')}. Migrate it before the app starts (npm run migrate:up)`;
}

// What every command is refused with while a row is dirty. "checksum" is the one of the up file as it is at
// that moment; "note" is what follows when the file is no longer the text the row was marked with.
export function describeDirtyRefusal({
  type = 'migration', id, version, checksum, note = '',
}) {
  const key = `type = '${type}' AND version = ${version}`;

  return `The ${type} ${id} is dirty: a run of its up or its down file failed or was cut short after its row was marked, and how much the database holds of what ${id}.up.sql makes is not known. Look at the database, then say which it is. It holds nothing of that (the up file left nothing, or the rollback is complete): DELETE FROM _migrations WHERE ${key}. It holds all of it (the up file is complete, or the rollback changed nothing): UPDATE _migrations SET is_dirty = 0, checksum = '${checksum}' WHERE ${key}${note}`;
}

// The callbacks of a migrator command and what they were called with, in order: "wait", "start <file>",
// "finish <file>". The duration a file took is checked here, since no test can name it.
export function createMigrationEvents() {
  const events = [];

  function onFileFinish(fileName, durationMs) {
    if (!Number.isInteger(durationMs) || durationMs < 0) {
      throw new Error(`onFileFinish(fileName, durationMs) was given the duration ${durationMs}`);
    }

    events.push(`finish ${fileName}`);
  }

  return {
    events,
    hooks: {
      onLockWait: () => events.push('wait'),
      onFileStart: (fileName) => events.push(`start ${fileName}`),
      onFileFinish,
    },
  };
}

// In every spelling the script takes: "--direction=make" and "--direction make".
function isMakeForReal(args) {
  const { values } = parseArgs({
    args,
    strict: false,
    options: { direction: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' } },
  });

  return (values.direction ?? []).includes(MIGRATION_DIRECTION.MAKE) && !values['dry-run'];
}

// The script as npm runs it. Started in the root of the project it would work on the database of the developer,
// and "make" would write into the repository: so the database must be one of the tests, in the .env and in
// "systemEnv" (a variable of the shell wins over the file), and "make" is let through as a dry run only.
export async function runMigrateProcess(t, env, args, systemEnv = {}) {
  const names = [env.APP_DATABASE_NAME, systemEnv.APP_DATABASE_NAME ?? env.APP_DATABASE_NAME];

  if (!names.every((name) => String(name).startsWith(DATABASE_PREFIX))) {
    throw new Error(`runMigrateProcess(t, env, args) works on a database of the tests only: APP_DATABASE_NAME must start with ${DATABASE_PREFIX}`);
  }

  if (isMakeForReal(args)) {
    throw new Error('runMigrateProcess(t, env, args) runs --direction=make with --dry-run only: the files would be written into the repository');
  }

  return runNode(MIGRATE, { args, cwd: await createWorkDir(t, { ...TEST_ENV, ...env }), env: systemEnv });
}
