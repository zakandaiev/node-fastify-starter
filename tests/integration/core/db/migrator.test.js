import { findDbError } from '#core/db/error.js';
import { now } from '#core/db/index.js';
import { assertMigrated, findPendingMigrations, migrateFresh } from '#core/db/migrator.js';
import { withTransaction } from '#core/db/transaction.js';
import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import {
  ACCOUNT_HOST,
  connectAdmin,
  createGate,
  createTestDb,
  waitAtGate,
} from '#root/tests/helper/db.js';
import {
  bindMigrator,
  createMigrationDir,
  createMigrationEvents,
  describeDirtyRefusal,
  describePendingRefusal,
  describeQualifiedName,
  listTableNames,
  MIGRATION_TEXT,
  readAppliedRows,
  readStatementsByHand,
  removeMigrationFiles,
  writeMigrationFiles,
} from '#root/tests/helper/migration.js';
import { mapSeries, withTimeout } from '#utils/async.js';
import { convertStringToMs } from '#utils/date.js';
import { sha256 } from '#utils/hash.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import nodePath from 'node:path';
import { beforeEach, describe, test } from 'node:test';

// The limit of the impatient pool, and the time a statement it has cut must have ended by: below the limit
// every other pool has, so a statement that ran under that one is told apart.
const STATEMENT_TIMEOUT = '0.3s';
const GIVE_UP_WITHIN_MS = 2000;

// How long a file is kept at its gate, by the clock of the server: what is recorded of the file must show it.
const HELD_FOR = '0.2s';
const HELD_FOR_MS = convertStringToMs(HELD_FOR);

// lock_wait_timeout counts whole seconds: a shorter wait for a table the server does not know.
const TABLE_LOCK_TIMEOUT = '1s';

const USERS = Object.freeze({
  '0001_users.up.sql': 'CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(100) NOT NULL);\n',
  '0001_users.down.sql': 'DROP TABLE users;\n',
});
const WIDER_USERS = USERS['0001_users.up.sql'].replace('VARCHAR(100)', 'VARCHAR(200)');
const EMAIL_TYPE_SQL = "SELECT column_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'email'";

const SESSIONS = Object.freeze({
  '0002_sessions.up.sql': 'CREATE TABLE sessions (id INT PRIMARY KEY, user_id INT NOT NULL);\nCREATE INDEX sessions_user ON sessions (user_id);\n',
  '0002_sessions.down.sql': 'DROP TABLE sessions;\n',
});
const TEAMS = Object.freeze({
  '0003_teams.up.sql': 'CREATE TABLE teams (id INT PRIMARY KEY);\n',
  '0003_teams.down.sql': 'DROP TABLE teams;\n',
});

// Another migration under the number of USERS, as a second branch would have made it; USERS under another name,
// as a file renamed after it was applied; and USERS under another number.
const ACCOUNTS = Object.freeze({
  '0001_accounts.up.sql': 'CREATE TABLE accounts (id INT PRIMARY KEY);\n',
  '0001_accounts.down.sql': 'DROP TABLE accounts;\n',
});
const RENAMED_USERS = Object.freeze({
  '0001_members.up.sql': USERS['0001_users.up.sql'],
  '0001_members.down.sql': USERS['0001_users.down.sql'],
});
const RENUMBERED_USERS = Object.freeze({
  '0005_users.up.sql': USERS['0001_users.up.sql'],
  '0005_users.down.sql': USERS['0001_users.down.sql'],
});

// The lower number refers to the higher one and comes to the build after it: the database records it in a later batch.
const ORDERS = Object.freeze({
  '0003_orders.up.sql': 'CREATE TABLE orders (id INT PRIMARY KEY);\n',
  '0003_orders.down.sql': 'DROP TABLE orders;\n',
});
const ORDER_NOTES = Object.freeze({
  '0002_order_notes.up.sql': 'CREATE TABLE order_notes (id INT PRIMARY KEY, order_id INT NOT NULL, CONSTRAINT order_notes_order_fk FOREIGN KEY (order_id) REFERENCES orders (id));\n',
  '0002_order_notes.down.sql': 'DROP TABLE order_notes;\n',
});
const REFERENCED_CODE = 'ER_ROW_IS_REFERENCED_2';

// Fails on its third statement, with a table and a row of its own already in the database.
const BROKEN = Object.freeze({
  '0004_broken.up.sql': 'CREATE TABLE halves (id INT PRIMARY KEY);\nINSERT INTO halves (id) VALUES (1);\nCREATE TABLE halves (id INT);\nCREATE TABLE never (id INT);\n',
  '0004_broken.down.sql': 'DROP TABLE halves;\n',
});
const BROKEN_FAILURE = "0004_broken.up.sql: statement 3 failed: Table 'halves' already exists; the migration is left dirty";
const REPAIRED = 'CREATE TABLE halves (id INT PRIMARY KEY);\nINSERT INTO halves (id) VALUES (1);\nCREATE TABLE never (id INT);\n';

const LATER = Object.freeze({ '0005_later.up.sql': 'CREATE TABLE later (id INT PRIMARY KEY);\n' });

// Two rollbacks that fail on their second statement, after DDL: the first has left every table as it was,
// the second has dropped the index of SESSIONS and not the table.
const IDLE_DOWN = 'DROP TABLE IF EXISTS scraps;\nDROP TABLE scraps;\n';
const HALF_DOWN = 'DROP INDEX sessions_user ON sessions;\nDROP TABLE sesions;\n';
const INDEXES_SQL = "SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'sessions' ORDER BY index_name";

// Letters of two, three and four bytes, and a line break inside a literal.
const NOTES = "CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(100) NOT NULL);\nINSERT INTO notes (id, body) VALUES (1, 'José 日本 🌍'), (2, 'first\nsecond');\n";
const NOTES_BODIES = Object.freeze([{ body: 'José 日本 🌍' }, { body: 'first\nsecond' }]);
const BYTE_ORDER_MARK = String.fromCodePoint(0xFEFF);

// The first file ends with the checks of foreign keys switched off in its session; the second fails only with them on.
const ORPHANS = Object.freeze({
  '0001_parents.up.sql': 'CREATE TABLE parents (id INT PRIMARY KEY);\nCREATE TABLE children (id INT PRIMARY KEY, parent_id INT NOT NULL, FOREIGN KEY (parent_id) REFERENCES parents (id));\nSET FOREIGN_KEY_CHECKS = 0;\nINSERT INTO children (id, parent_id) VALUES (1, 404);\n',
  '0002_orphans.up.sql': 'INSERT INTO children (id, parent_id) VALUES (2, 404);\n',
});

// Of the version and the name of the migration: the folder alone tells the two types apart.
const SEED = Object.freeze({
  'seed/0001_users.up.sql': "INSERT INTO users (id, email) VALUES (1, 'first@example.com');\nINSERT INTO users (id, email) VALUES (2, 'second@example.com');\n",
  'seed/0001_users.down.sql': 'DELETE FROM users WHERE id IN (1, 2);\n',
});
const SEED_FAILURE = "0001_users.up.sql: statement 3 failed: Duplicate entry '***' for key 'PRIMARY'";

// Plain writes that fail on the last statement: the first as one transaction, the second after it has ended that one.
const REPEATING_SEED = Object.freeze({
  'seed/0001_users.up.sql': `${SEED['seed/0001_users.up.sql']}INSERT INTO users (id, email) VALUES (1, 'again@example.com');\n`,
});
const COMMITTING_SEED = Object.freeze({
  'seed/0001_users.up.sql': "COMMIT;\nINSERT INTO users (id, email) VALUES (1, 'first@example.com');\nINSERT INTO users (id, email) VALUES (1, 'again@example.com');\n",
});

// What a data file does to a row of SEED, and what the traffic of an app does to that row meanwhile. The read
// opens the view a transaction of the default level keeps to its end.
const SEED_READ_SQL = 'SELECT email INTO @email FROM users WHERE id = 1';
const SEED_WRITE_SQL = "UPDATE users SET email = 'seed@example.com' WHERE id = 1";
const SEED_ROW_SQL = 'SELECT email FROM users WHERE id = 1';
const TRAFFIC_SQL = "UPDATE users SET email = CONCAT('traffic.', email) WHERE id = 1";
const ROW_CHANGED_CODE = 'ER_CHECKREAD';

// A statement that asks the client for a file, in the middle of plain writes and after DDL. No connection of
// the driver offers that, so the server refuses the statement by itself.
const LOCAL_FILE_ERRNO = 4166;
const LOCAL_FILE_FAILURE = 'The used command is not allowed because the MariaDB server or client has disabled the local infile capability';
const LOADING_SEED = Object.freeze({
  'seed/0001_users.up.sql': "INSERT INTO users (id, email) VALUES (1, 'first@example.com');\nLOAD DATA LOCAL INFILE 'users.csv' INTO TABLE users;\nINSERT INTO users (id, email) VALUES (2, 'second@example.com');\n",
});
const LOADING = Object.freeze({
  '0002_imports.up.sql': "CREATE TABLE imports (id INT PRIMARY KEY);\nLOAD DATA LOCAL INFILE 'imports.csv' INTO TABLE imports;\nCREATE TABLE never (id INT PRIMARY KEY);\n",
});

const REPLACING = Object.freeze({
  '0002_wider_users.up.sql': 'CREATE OR REPLACE TABLE users (id INT PRIMARY KEY, email VARCHAR(200) NOT NULL);\n',
});

const EMPTY_FILE = 'is empty: write its statements, or a comment if there is nothing to do';
const DATABASE_STATEMENT = 'a statement that creates, drops or alters a database';

// The server runs what such a comment holds, and the lexer does not read it.
const EXECUTABLE_COMMENT = '/*!50503 DROP TABLE strays */';
const UNREADABLE = `CREATE TABLE strays (id INT);\n${EXECUTABLE_COMMENT}`;
const UNREADABLE_REFUSAL = `cannot be read as SQL, and what cannot be read is not sent: SQL has an unsupported executable comment at position ${UNREADABLE.indexOf(EXECUTABLE_COMMENT)}: ${EXECUTABLE_COMMENT}`;

// The files that are refused before anything runs: what such a file is, its text, and what the refusal says after
// the name of the file. Every statement names the database of this test file: run by mistake, it would reach nothing else.
const REFUSED_FILES = Object.freeze([
  ['holds a USE statement', (name) => `USE \`${name}\`;\nCREATE TABLE strays (id INT);\n`, () => `holds a USE statement: ${MIGRATION_TEXT.NAMES_NO_DATABASE}`],
  ['holds a CREATE DATABASE statement', (name) => `CREATE DATABASE IF NOT EXISTS \`${name}\`;\n`, () => `holds ${DATABASE_STATEMENT}: ${MIGRATION_TEXT.NAMES_NO_DATABASE}`],
  ['holds a DROP DATABASE statement', (name) => `CREATE TABLE strays (id INT);\nDROP DATABASE \`${name}\`;\n`, () => `holds ${DATABASE_STATEMENT}: ${MIGRATION_TEXT.NAMES_NO_DATABASE}`],
  ['holds an ALTER DATABASE statement', (name) => `ALTER DATABASE \`${name}\` COMMENT = 'named';\n`, () => `holds ${DATABASE_STATEMENT}: ${MIGRATION_TEXT.NAMES_NO_DATABASE}`],
  ['holds the name of the live database in front of a table', (name) => `CREATE TABLE ${name}.strays (id INT);\n`, (name) => describeQualified(`${name}.strays`)],
  ['the lexer cannot read (an executable comment)', () => UNREADABLE, () => UNREADABLE_REFUSAL],
]);

const STATUS_FIELDS = Object.freeze(['id', 'version', 'name', 'state', 'batch', 'appliedAt', 'durationMs', 'checksum', 'fileChecksum']);
const CHECKSUMS = Object.freeze(['checksum', 'fileChecksum']);

const CHECKSUM_PART_REGEXP = /, checksum = '[0-9a-f]{64}'/;

// Windows gives the right to make a link to an administrator or in the developer mode only.
const LINK_REFUSED_CODE = 'EPERM';
const LINK_REFUSED_REASON = 'This account may not create a symbolic link (EPERM): on Windows that takes the developer mode or an administrator';
const FILE_LINK = 'file';

// What a list of tables would not name is here too: a routine and an event, the latter set for a day that never comes.
const LEFTOVERS = Object.freeze([
  'CREATE TABLE leftovers (id INT PRIMARY KEY, user_id INT, FOREIGN KEY (user_id) REFERENCES users (id))',
  'CREATE VIEW leftover_names AS SELECT id FROM leftovers',
  'CREATE PROCEDURE leftover_routine() SELECT 1',
  "CREATE EVENT leftover_event ON SCHEDULE AT '2099-01-01 00:00:00' DO DELETE FROM leftovers",
  "UPDATE _migrations SET is_dirty = TRUE WHERE name = 'users'",
]);
const OBJECTS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = :name) AS routines,
    (SELECT COUNT(*) FROM information_schema.events WHERE event_schema = :name) AS events
`;

// By the name, not by DATABASE(): a session whose database was dropped must not answer for it.
const DEFAULTS_SQL = `
  SELECT default_character_set_name AS charset, default_collation_name AS collation, schema_comment AS comment
  FROM information_schema.schemata
  WHERE schema_name = :name
`;
const NEW_DATABASE_DEFAULTS = Object.freeze({ charset: 'utf8mb4', collation: 'utf8mb4_bin', comment: '' });
const QUOTED_COMMENT = "Kept through 'fresh'";
const PLAIN_COMMENT = 'Lost and put back';

const testDb = await createTestDb();
const { run } = testDb;
const {
  up, down, readStatus, readStates,
} = bindMigrator(testDb);

function fresh(options, pool) {
  return pool.run(() => migrateFresh(options));
}

function findPending(directory, pool = testDb) {
  return pool.run(() => findPendingMigrations({ directory }));
}

// A pool in the only mode "fresh" runs in, closed with the test.
function openDev(t, env = {}) {
  return testDb.open({ env: { ...env, APP_MODE: 'dev' } }, t);
}

function readServerTime() {
  return run(() => now());
}

async function readBatches() {
  return (await readAppliedRows(testDb)).map((row) => [row.type, row.name, row.batch]);
}

async function readDirtyMarks() {
  return (await readAppliedRows(testDb)).map((row) => [row.type, row.name, row.is_dirty]);
}

function readDefaults(name = testDb.name) {
  return testDb.readRows(DEFAULTS_SQL, { name });
}

function countObjects() {
  return testDb.readRows(OBJECTS_SQL, { name: testDb.name });
}

// What a refusal says of the live database named in front of a table, after the name of the file. "name" is
// that name with the table, as the file spells it.
function describeQualified(name) {
  return `holds ${describeQualifiedName(name)}: ${MIGRATION_TEXT.NAMES_NO_DATABASE}`;
}

// The refusal of a build that has a file of another name under the number of USERS, which the database holds.
function describeTaken(id) {
  return `Version 1 is applied to this database as the migration 0001_users, and this build has ${id} under it: two migrations took one number, or the file was renamed after it was applied. Give another number to the one that is not applied, or give the file its name back`;
}

// The refusal of "up" while an applied file is not the text its row holds.
function describeChanged({
  id, version, checksum, fileChecksum,
}) {
  return `The migration ${id} was changed after it was applied: its row holds the checksum ${checksum}, its up file gives ${fileChecksum}. An applied file is not edited, its comments included: restore it. If the database already holds what the file now says, record the new text: UPDATE _migrations SET checksum = '${fileChecksum}' WHERE type = 'migration' AND version = ${version}. A migration that is still being written is rolled back with "down" before its file is changed`;
}

// The owner keeps the right to drop its database and loses the right to create it: the pattern is the one
// createOwner() has granted, where "_" is escaped.
function revokeCreate(account) {
  return testDb.runAsAdmin(
    `REVOKE CREATE ON \`${testDb.name.replaceAll('_', '\\_')}\`.* FROM ?@?`,
    [account.APP_DATABASE_USER, ACCOUNT_HOST],
  );
}

// A migration in every state a database at rest can show: applied, changed, missing, dirty and pending.
async function createEveryState(t) {
  const directory = await createMigrationDir(t, {
    ...USERS, ...SESSIONS, ...TEAMS, ...BROKEN, ...LATER,
  });

  await assert.rejects(up({ directory }), { message: BROKEN_FAILURE });
  await writeMigrationFiles(directory, { '0002_sessions.up.sql': '-- rewritten\n' });
  await removeMigrationFiles(directory, Object.keys(TEAMS));

  return directory;
}

// A build whose files are not the ones the database has applied: "applied" is gone from the folder and
// "replacement" stands there.
async function replaceApplied(t, applied, replacement) {
  const directory = await createMigrationDir(t, applied);

  await up({ directory });
  await removeMigrationFiles(directory, Object.keys(applied));
  await writeMigrationFiles(directory, replacement);

  return directory;
}

// USERS applied, its up file widened afterwards, and a rollback that failed with the table as it was: the row
// is dirty and holds the checksum of the text that was applied, not of the file as it is now.
async function failRollbackOfChanged(t) {
  const directory = await createMigrationDir(t, { ...USERS, '0001_users.down.sql': IDLE_DOWN });

  await up({ directory });
  await writeMigrationFiles(directory, { '0001_users.up.sql': WIDER_USERS });
  await assert.rejects(down({ directory }), {
    message: `0001_users.down.sql: statement 2 failed: Unknown table '${testDb.name}.scraps'; the migration is left dirty`,
  });

  return directory;
}

// A seed that reads a row of SEED, is held at a gate while the traffic changes that row and commits, and then
// writes the row. "toStatements" makes the seed from the statement that waits at the gate. Resolves with
// what the run of the seed gives.
async function applyBesideTraffic(t, toStatements) {
  const gate = await createGate(t);
  const directory = await createMigrationDir(t, { ...USERS, ...SEED });

  await up({ directory });
  await up({ directory, type: 'seed' });
  await writeMigrationFiles(directory, { 'seed/0002_renamed.up.sql': `${toStatements(gate.statement).join(';\n')};\n` });

  const running = up({ directory, type: 'seed' });

  await waitAtGate(t, testDb, { gate, running });
  await testDb.readRows(TRAFFIC_SQL);
  await gate.open();

  return running;
}

// What a file would meet at the default level of the server: the same read and write in one transaction, with
// the same traffic in between. readRows() starts from the context of the pool, so the traffic is another session.
function readThenWriteBesideTraffic() {
  return run(() => withTransaction(async () => {
    await testDb.db.query(SEED_READ_SQL);
    await testDb.readRows(TRAFFIC_SQL);
    await testDb.db.query(SEED_WRITE_SQL);
  }));
}

// Resolves with false where the system refuses a link to this account.
async function linkFiles(store, directory, names) {
  try {
    await Promise.all(names.map((name) => symlink(nodePath.join(store, name), nodePath.join(directory, name), FILE_LINK)));

    return true;
  } catch (error) {
    if (error.code !== LINK_REFUSED_CODE) {
      throw error;
    }

    return false;
  }
}

describe('migrateUp', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('applies the files that are not applied, in the order of the versions and as one batch, and tells of every file', async (t) => {
    const directory = await createMigrationDir(t, { ...SESSIONS, ...USERS });
    const { events, hooks } = createMigrationEvents();

    assert.deepEqual(await up({ directory, ...hooks }), { files: ['0001_users.up.sql', '0002_sessions.up.sql'], isDryRun: false, ahead: [] });
    assert.deepEqual(events, [
      'start 0001_users.up.sql',
      'finish 0001_users.up.sql',
      'start 0002_sessions.up.sql',
      'finish 0002_sessions.up.sql',
    ]);
    assert.deepEqual(await readAppliedRows(testDb), [
      {
        type: 'migration', version: 1, name: 'users', batch: 1, is_dirty: false,
      },
      {
        type: 'migration', version: 2, name: 'sessions', batch: 1, is_dirty: false,
      },
    ]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'sessions', 'users']);
  });

  test('records the checksum of the text of a file, the moment it ended and the time it took', async (t) => {
    const gate = await createGate(t);
    const text = `CREATE TABLE held (id INT PRIMARY KEY);\n${gate.statement};\n`;
    const directory = await createMigrationDir(t, { '0001_held.up.sql': text });
    const durations = [];
    const startedAt = performance.now();
    const running = up({ directory, onFileFinish: (fileName, durationMs) => durations.push(durationMs) });

    await waitAtGate(t, testDb, { gate, running });

    const heldAt = performance.now();
    const heldSince = await readServerTime();

    await waitFor(async () => (await readServerTime()) - heldSince >= HELD_FOR_MS, `the clock of the server to pass ${HELD_FOR}`);

    const heldMs = performance.now() - heldAt;

    await gate.open();
    await running;

    const [row] = await testDb.readRows('SELECT checksum, duration_ms, applied_at FROM _migrations');

    assert.equal(row.checksum, sha256(text));
    assert.deepEqual(durations, [row.duration_ms]);
    assert.ok(
      row.duration_ms >= Math.floor(heldMs) && row.duration_ms <= Math.ceil(performance.now() - startedAt),
      `the file was held for ${heldMs} ms, and ${row.duration_ms} ms are recorded`,
    );
    assert.ok(row.applied_at - heldSince >= HELD_FOR_MS, 'applied_at is not the moment the file ended');
  });

  test('has nothing to do once everything is applied, and gives a file that came later the next batch', async (t) => {
    const directory = await createMigrationDir(t, USERS);

    await up({ directory });

    assert.deepEqual(await up({ directory }), { files: [], isDryRun: false, ahead: [] });

    await writeMigrationFiles(directory, { ...SESSIONS, ...TEAMS });

    assert.deepEqual((await up({ directory })).files, ['0002_sessions.up.sql', '0003_teams.up.sql']);
    assert.deepEqual(await readBatches(), [['migration', 'users', 1], ['migration', 'sessions', 2], ['migration', 'teams', 2]]);
  });

  test('creates the table of the migrator with the first file it records: a run with nothing to do leaves the database as it was', async (t) => {
    const directory = await createMigrationDir(t, USERS);

    assert.deepEqual(await up({ directory, type: 'seed' }), { files: [], isDryRun: false, ahead: [] });
    assert.deepEqual(await up({ directory, namesExclude: ['users'] }), { files: [], isDryRun: false, ahead: [] });
    assert.deepEqual(await listTableNames(testDb), []);

    await up({ directory });

    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);
  });

  test('applies only the named ones, leaves out the excluded ones, and runs a lower version after a higher one', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS, ...TEAMS });

    assert.deepEqual((await up({ directory, names: ['teams', 'sessions'] })).files, ['0002_sessions.up.sql', '0003_teams.up.sql']);
    assert.deepEqual((await up({ directory, names: ['teams'] })).files, []);
    assert.deepEqual((await up({ directory, namesExclude: ['users'] })).files, []);
    assert.deepEqual((await up({ directory })).files, ['0001_users.up.sql']);
    assert.deepEqual(await readBatches(), [['migration', 'users', 2], ['migration', 'sessions', 1], ['migration', 'teams', 1]]);
  });

  test('refuses a name no migration has before it applies anything, and writes nothing: not even the table of the migrator', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });
    const hint = 'a name is given without its version, as it stands after the number in the name of the file';

    await assert.rejects(up({ directory, names: ['users', 'usres'] }), { message: `No migration is named "usres": ${hint}` });
    await assert.rejects(up({ directory, namesExclude: ['0002_sessions'] }), { message: `No migration is named "0002_sessions": ${hint}` });
    assert.deepEqual(await listTableNames(testDb), []);
  });

  test('names the files of a dry run and writes nothing, not even the table of the migrator', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });
    const { events, hooks } = createMigrationEvents();

    assert.deepEqual(await up({
      directory, isDryRun: true, names: ['sessions'], ...hooks,
    }), { files: ['0002_sessions.up.sql'], isDryRun: true, ahead: [] });
    assert.deepEqual(await listTableNames(testDb), []);

    await up({ directory, names: ['users'] });

    assert.deepEqual((await up({ directory, isDryRun: true, ...hooks })).files, ['0002_sessions.up.sql']);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);
    assert.deepEqual(events, []);
  });

  test('refuses to run when an applied file was changed, with both checksums and the statement that records the new text', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const refusal = {
      message: describeChanged({
        id: '0001_users', version: 1, checksum: sha256(USERS['0001_users.up.sql']), fileChecksum: sha256(WIDER_USERS),
      }),
    };

    await up({ directory });
    await writeMigrationFiles(directory, { '0001_users.up.sql': WIDER_USERS, ...SESSIONS });

    await assert.rejects(up({ directory }), refusal);
    await assert.rejects(up({ directory, isDryRun: true }), refusal);
    await assert.rejects(up({ directory, names: ['sessions'] }), refusal);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);

    const [recordNewText] = readStatementsByHand((await rejectionOf(up({ directory }))).message);

    await testDb.readRows(recordNewText);

    assert.deepEqual(await up({ directory }), { files: ['0002_sessions.up.sql'], isDryRun: false, ahead: [] });
    assert.deepEqual(await readStates({ directory }), [['0001_users', 'applied'], ['0002_sessions', 'applied']]);
  });

  test('does not take other line breaks for a change: a checkout with CRLF is the file that was applied', async (t) => {
    const directory = await createMigrationDir(t, USERS);

    await up({ directory });
    await writeMigrationFiles(directory, {
      '0001_users.up.sql': USERS['0001_users.up.sql'].replaceAll('\n', '\r\n'),
      ...SESSIONS,
    });

    assert.deepEqual(await readStates({ directory }), [['0001_users', 'applied'], ['0002_sessions', 'pending']]);
    assert.deepEqual((await up({ directory })).files, ['0002_sessions.up.sql']);
  });

  test('runs the text its checksum is taken of: a checkout with CRLF and a byte order mark writes the same letters and line breaks', async (t) => {
    const directory = await createMigrationDir(t, { '0001_notes.up.sql': `${BYTE_ORDER_MARK}${NOTES.replaceAll('\n', '\r\n')}` });

    await up({ directory });

    assert.deepEqual(await testDb.readRows('SELECT body FROM notes ORDER BY id'), NOTES_BODIES);
    assert.deepEqual(await testDb.readRows('SELECT checksum FROM _migrations'), [{ checksum: sha256(NOTES) }]);
  });

  test('leaves a file that failed after DDL dirty, and refuses every run until a person has said what the database holds', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...BROKEN, ...LATER });
    const { events, hooks } = createMigrationEvents();
    const refusal = {
      message: describeDirtyRefusal({ id: '0004_broken', version: 4, checksum: sha256(BROKEN['0004_broken.up.sql']) }),
    };

    await assert.rejects(up({ directory, ...hooks }), { message: BROKEN_FAILURE });

    assert.deepEqual(events, ['start 0001_users.up.sql', 'finish 0001_users.up.sql', 'start 0004_broken.up.sql']);
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false], ['migration', 'broken', true]]);
    assert.deepEqual(await testDb.readRows('SELECT id FROM halves'), [{ id: 1 }]);

    await assert.rejects(up({ directory }), refusal);
    await assert.rejects(up({ directory, isDryRun: true }), refusal);
    await assert.rejects(down({ directory }), refusal);
    await assert.rejects(up({ directory, type: 'seed' }), refusal);
    await assert.rejects(down({ directory, type: 'seed', isDryRun: true }), refusal);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'halves', 'users']);
  });

  test('runs a dirty file again once its row is deleted with the statement the refusal prints for a file that left nothing', async (t) => {
    const directory = await createMigrationDir(t, { ...BROKEN, ...LATER });

    await assert.rejects(up({ directory }), { message: BROKEN_FAILURE });

    const [forgetRow] = readStatementsByHand((await rejectionOf(up({ directory }))).message);

    await testDb.readRows('DROP TABLE halves');
    await writeMigrationFiles(directory, { '0004_broken.up.sql': REPAIRED });
    await testDb.readRows(forgetRow);

    assert.deepEqual(await readStates({ directory }), [['0004_broken', 'pending'], ['0005_later', 'pending']]);
    assert.deepEqual(await up({ directory }), { files: ['0004_broken.up.sql', '0005_later.up.sql'], isDryRun: false, ahead: [] });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'halves', 'later', 'never']);
  });

  test('reads a dirty file as applied, not as changed, once it was corrected and its row updated with the statement the refusal prints', async (t) => {
    const directory = await createMigrationDir(t, { ...BROKEN, ...LATER });

    await assert.rejects(up({ directory }), { message: BROKEN_FAILURE });
    await testDb.readRows('CREATE TABLE never (id INT)');
    await writeMigrationFiles(directory, { '0004_broken.up.sql': REPAIRED });

    const refusal = await rejectionOf(up({ directory }));
    const [, recordWhole] = readStatementsByHand(refusal.message);

    assert.equal(refusal.message, `${describeDirtyRefusal({ id: '0004_broken', version: 4, checksum: sha256(REPAIRED) })}${MIGRATION_TEXT.REWRITTEN_NOTE}`);
    await testDb.readRows(recordWhole);

    assert.deepEqual(await readStates({ directory }), [['0004_broken', 'applied'], ['0005_later', 'pending']]);
    assert.deepEqual(await up({ directory }), { files: ['0005_later.up.sql'], isDryRun: false, ahead: [] });
    assert.deepEqual(await readBatches(), [['migration', 'broken', 1], ['migration', 'later', 2]]);
  });

  test('leaves nothing behind when the first statement of a file is a syntax error: no row, no mark, and the next run is free', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, '0002_typo.up.sql': 'CREATE TABLEE typo (id INT);\n', ...TEAMS });

    await assert.rejects(up({ directory }), {
      message: "0002_typo.up.sql: statement 1 failed: You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near 'TABLEE typo (id INT)' at line 1; nothing of the file was applied",
    });

    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false]]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);

    await writeMigrationFiles(directory, { '0002_typo.up.sql': 'CREATE TABLE typo (id INT);\n' });

    assert.deepEqual((await up({ directory })).files, ['0002_typo.up.sql', '0003_teams.up.sql']);
  });

  test('applies a file of plain writes whole or not at all: a seed that fails on its last statement leaves no row of its own and no mark', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...REPEATING_SEED });

    await up({ directory });
    await assert.rejects(up({ directory, type: 'seed' }), { message: `${SEED_FAILURE}; nothing of the file was applied` });

    assert.deepEqual(await testDb.readRows('SELECT id FROM users'), []);
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false]]);
    assert.deepEqual(await up({ directory }), { files: [], isDryRun: false, ahead: [] });

    await writeMigrationFiles(directory, SEED);

    assert.deepEqual((await up({ directory, type: 'seed' })).files, ['0001_users.up.sql']);
    assert.deepEqual(await testDb.readRows('SELECT id FROM users ORDER BY id'), [{ id: 1 }, { id: 2 }]);
  });

  test('leaves a file of plain writes dirty when it has ended the transaction it ran in: after its own COMMIT its writes stay', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...COMMITTING_SEED });

    await up({ directory });
    await assert.rejects(up({ directory, type: 'seed' }), { message: `${SEED_FAILURE}; the seed is left dirty` });

    assert.deepEqual(await testDb.readRows('SELECT id FROM users'), [{ id: 1 }]);
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false], ['seed', 'users', true]]);
  });

  test('tells a dirty seed from the migration of its version and name: the statement of the refusal deletes the row of the seed alone', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...COMMITTING_SEED });

    await up({ directory });
    await assert.rejects(up({ directory, type: 'seed' }), { message: `${SEED_FAILURE}; the seed is left dirty` });

    const refusal = await rejectionOf(up({ directory }));
    const [forgetRow] = readStatementsByHand(refusal.message);

    assert.equal(refusal.message, describeDirtyRefusal({
      type: 'seed', id: '0001_users', version: 1, checksum: sha256(COMMITTING_SEED['seed/0001_users.up.sql']),
    }));
    await testDb.readRows(forgetRow);

    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false]]);
    assert.deepEqual(await up({ directory }), { files: [], isDryRun: false, ahead: [] });
  });

  test('applies a data file beside traffic: a seed writes a row another session has changed and committed since the seed read it, where a transaction of the default level is refused that write', async (t) => {
    const result = await applyBesideTraffic(t, (held) => [SEED_READ_SQL, held, SEED_WRITE_SQL]);

    assert.deepEqual(result.files, ['0002_renamed.up.sql']);
    assert.deepEqual(await testDb.readRows(SEED_ROW_SQL), [{ email: 'seed@example.com' }]);
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false], ['seed', 'users', false], ['seed', 'renamed', false]]);
    await assert.rejects(readThenWriteBesideTraffic(), { code: ROW_CHANGED_CODE });
  });

  test('applies a data file that keeps its writes in a transaction of its own beside the same traffic: the level is the one of the session of a file, not of the one transaction the driver opens', async (t) => {
    const result = await applyBesideTraffic(t, (held) => ['START TRANSACTION', SEED_READ_SQL, held, SEED_WRITE_SQL, 'COMMIT']);

    assert.deepEqual(result.files, ['0002_renamed.up.sql']);
    assert.deepEqual(await testDb.readRows(SEED_ROW_SQL), [{ email: 'seed@example.com' }]);
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false], ['seed', 'users', false], ['seed', 'renamed', false]]);
  });

  test('fails a file of plain writes at its LOAD DATA LOCAL INFILE and leaves nothing of it: the server refuses the statement, the write before it is undone and the one after it never runs', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...LOADING_SEED });

    await up({ directory });

    const error = await rejectionOf(up({ directory, type: 'seed' }));

    assert.equal(error.message, `0001_users.up.sql: statement 2 failed: ${LOCAL_FILE_FAILURE}; nothing of the file was applied`);
    assert.equal(findDbError(error.cause).errno, LOCAL_FILE_ERRNO);
    assert.deepEqual(await testDb.readRows('SELECT id FROM users'), []);
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false]]);
  });

  test('leaves a file dirty when its LOAD DATA LOCAL INFILE comes after DDL: the table made before it has stayed, and nothing after it runs', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...LOADING });
    const error = await rejectionOf(up({ directory }));

    assert.equal(error.message, `0002_imports.up.sql: statement 2 failed: ${LOCAL_FILE_FAILURE}; the migration is left dirty`);
    assert.equal(findDbError(error.cause).errno, LOCAL_FILE_ERRNO);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'imports', 'users']);
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false], ['migration', 'imports', true]]);
  });

  test('leaves a file dirty when its first statement is CREATE OR REPLACE TABLE and gave up on a table another session holds, though the table is as it was: such a statement drops before it creates, and its wait is no proof that nothing was done', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const hasty = testDb.open({ db: { migrationTableLockTimeout: TABLE_LOCK_TIMEOUT } }, t);

    await up({ directory });
    await writeMigrationFiles(directory, REPLACING);
    await testDb.holdTable(t, 'users');

    await assert.rejects(up({ directory }, hasty), {
      message: `0002_wider_users.up.sql: statement 1 failed: ${MIGRATION_TEXT.TABLE_HELD}; the migration is left dirty`,
    });
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false], ['migration', 'wider_users', true]]);
    assert.deepEqual(await testDb.readRows(EMAIL_TYPE_SQL), [{ type: 'varchar(100)' }]);
  });

  test('refuses an empty file before it applies anything: a migration that was made and never written', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, '0002_sessions.up.sql': ' \r\n\n' });

    await assert.rejects(up({ directory }), { message: `0002_sessions.up.sql ${EMPTY_FILE}` });
    assert.deepEqual(await listTableNames(testDb), []);

    await writeMigrationFiles(directory, { '0002_sessions.up.sql': '-- Nothing to do here\n' });

    assert.deepEqual((await up({ directory })).files, ['0001_users.up.sql', '0002_sessions.up.sql']);
  });

  REFUSED_FILES.forEach(([what, toSql, toRefusal]) => {
    test(`refuses a file that ${what} before it applies anything, and writes nothing`, async (t) => {
      const directory = await createMigrationDir(t, { ...USERS, '0002_strays.up.sql': toSql(testDb.name) });
      const refusal = { message: `0002_strays.up.sql ${toRefusal(testDb.name)}` };

      await assert.rejects(up({ directory }), refusal);
      await assert.rejects(up({ directory, isDryRun: true }), refusal);
      assert.deepEqual(await listTableNames(testDb), []);
    });
  });

  test('refuses a file whose block begins with DROP DATABASE of another database before it applies anything: that database is still there', async (t) => {
    const neighbour = await testDb.createNeighbour(t);
    const directory = await createMigrationDir(t, {
      ...USERS,
      '0002_strays.up.sql': `BEGIN NOT ATOMIC\n  IF 1 = 1 THEN\n    DROP DATABASE \`${neighbour}\`;\n  END IF;\nEND;\n`,
    });
    const refusal = { message: `0002_strays.up.sql holds ${DATABASE_STATEMENT}: ${MIGRATION_TEXT.NAMES_NO_DATABASE}` };

    await assert.rejects(up({ directory }), refusal);
    await assert.rejects(up({ directory, isDryRun: true }), refusal);
    assert.deepEqual(await listTableNames(testDb), []);
    assert.deepEqual(await readDefaults(neighbour), [NEW_DATABASE_DEFAULTS]);
  });

  test('passes over a database that is ahead of the build, and names what the build does not know', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });

    await up({ directory });
    await removeMigrationFiles(directory, Object.keys(SESSIONS));
    await writeMigrationFiles(directory, TEAMS);

    assert.deepEqual(await up({ directory, isDryRun: true }), { files: ['0003_teams.up.sql'], isDryRun: true, ahead: ['0002_sessions'] });
    assert.deepEqual(await up({ directory }), { files: ['0003_teams.up.sql'], isDryRun: false, ahead: ['0002_sessions'] });
    assert.deepEqual(await up({ directory }), { files: [], isDryRun: false, ahead: ['0002_sessions'] });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'sessions', 'teams', 'users']);
  });

  test('refuses a build that has lost its migrations: no file at all while the database holds applied ones', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });
    const lost = await createMigrationDir(t);
    const refusal = { message: `This build has no migration file in ${lost}, and the database holds 2 applied: the build has lost its migrations` };

    await up({ directory });

    await assert.rejects(up({ directory: lost }), refusal);
    await assert.rejects(up({ directory: lost, isDryRun: true }), refusal);
    assert.deepEqual(await up({ directory: lost, type: 'seed' }), { files: [], isDryRun: false, ahead: [] });
  });

  test('refuses a file that stands under an applied version with another name, until the one that is not applied has another number: two migrations took one number', async (t) => {
    const directory = await replaceApplied(t, USERS, ACCOUNTS);
    const refusal = { message: describeTaken('0001_accounts') };

    await assert.rejects(up({ directory }), refusal);
    await assert.rejects(up({ directory, isDryRun: true }), refusal);
    await assert.rejects(down({ directory }), refusal);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);

    await removeMigrationFiles(directory, Object.keys(ACCOUNTS));
    await writeMigrationFiles(directory, { '0002_accounts.up.sql': ACCOUNTS['0001_accounts.up.sql'] });

    assert.deepEqual(await up({ directory }), { files: ['0002_accounts.up.sql'], isDryRun: false, ahead: ['0001_users'] });
  });

  test('refuses a file that was renamed after it was applied, until it has its name back: under the new name it would be applied a second time', async (t) => {
    const directory = await replaceApplied(t, USERS, RENAMED_USERS);
    const refusal = { message: describeTaken('0001_members') };

    await assert.rejects(up({ directory }), refusal);
    await assert.rejects(down({ directory }), refusal);
    assert.deepEqual(await readBatches(), [['migration', 'users', 1]]);

    await removeMigrationFiles(directory, Object.keys(RENAMED_USERS));
    await writeMigrationFiles(directory, USERS);

    assert.deepEqual(await up({ directory }), { files: [], isDryRun: false, ahead: [] });
    assert.deepEqual((await down({ directory })).files, ['0001_users.down.sql']);
  });

  test('refuses a file that got another number after it was applied: it would be applied a second time', async (t) => {
    const directory = await replaceApplied(t, USERS, RENUMBERED_USERS);
    const refusal = {
      message: 'The migration users is applied to this database as version 1, and this build numbers it 5: it got another number after this database took it. Give it its number back, or roll it back with the build that applied it',
    };

    await assert.rejects(up({ directory }), refusal);
    await assert.rejects(down({ directory }), refusal);
    assert.deepEqual(await readBatches(), [['migration', 'users', 1]]);

    await removeMigrationFiles(directory, Object.keys(RENUMBERED_USERS));
    await writeMigrationFiles(directory, USERS);

    assert.deepEqual(await up({ directory }), { files: [], isDryRun: false, ahead: [] });
  });

  test('keeps seeds apart from migrations, in a folder and with versions of their own, and counts the batches across both', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SEED });

    assert.deepEqual(await up({ directory, type: 'seed', isDryRun: true }), { files: ['0001_users.up.sql'], isDryRun: true, ahead: [] });

    await up({ directory });
    await up({ directory, type: 'seed' });
    await writeMigrationFiles(directory, SESSIONS);
    await up({ directory });

    assert.deepEqual(await up({ directory, type: 'seed' }), { files: [], isDryRun: false, ahead: [] });
    assert.deepEqual(await readBatches(), [['migration', 'users', 1], ['migration', 'sessions', 3], ['seed', 'users', 2]]);
    assert.deepEqual(await testDb.readRows('SELECT id FROM users ORDER BY id'), [{ id: 1 }, { id: 2 }]);
  });

  test('lists and applies a symbolic link to a migration file like a file: a volume of a container gives every file as a link', async (t) => {
    const store = await createMigrationDir(t, USERS);
    const directory = await createMigrationDir(t);

    if (!await linkFiles(store, directory, Object.keys(USERS))) {
      t.skip(LINK_REFUSED_REASON);

      return false;
    }

    assert.deepEqual(await findPending(directory), ['0001_users']);
    assert.deepEqual(await up({ directory }), { files: ['0001_users.up.sql'], isDryRun: false, ahead: [] });
    assert.deepEqual(await readStates({ directory }), [['0001_users', 'applied']]);
    assert.deepEqual((await down({ directory })).files, ['0001_users.down.sql']);

    return true;
  });

  test('gives every file a session of its own: what one file has switched off is on again for the next', async (t) => {
    const directory = await createMigrationDir(t, ORPHANS);

    await assert.rejects(
      up({ directory }),
      /^Error: 0002_orphans\.up\.sql: statement 1 failed: Cannot add or update a child row: a foreign key constraint fails .*; nothing of the file was applied$/,
    );
    assert.deepEqual(await testDb.readRows('SELECT id FROM children'), [{ id: 1 }]);
  });

  test('works on a pool of one connection and leaves that connection free, after a run that passed and after one that failed', async (t) => {
    const single = testDb.open({ db: { connectionLimit: 1 } }, t);
    const directory = await createMigrationDir(t, USERS);

    assert.deepEqual((await up({ directory }, single)).files, ['0001_users.up.sql']);
    assert.equal(single.db.getStats().activeCount, 0);
    assert.deepEqual((await down({ directory }, single)).files, ['0001_users.down.sql']);
    assert.equal(single.db.getStats().activeCount, 0);

    await writeMigrationFiles(directory, BROKEN);
    await assert.rejects(up({ directory }, single), { message: BROKEN_FAILURE });
    assert.equal(single.db.getStats().activeCount, 0);
    await assert.rejects(down({ directory }, single), /The migration 0004_broken is dirty/);
    assert.equal(single.db.getStats().activeCount, 0);
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false], ['migration', 'broken', true]]);
  });
});

describe('migrateDown', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('rolls back what the last batch applied, the highest version first, and nothing of the batches before', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const { events, hooks } = createMigrationEvents();

    await up({ directory });
    await writeMigrationFiles(directory, { ...SESSIONS, ...TEAMS });
    await up({ directory });

    assert.deepEqual(await down({ directory, ...hooks }), { files: ['0003_teams.down.sql', '0002_sessions.down.sql'], isDryRun: false });
    assert.deepEqual(events, [
      'start 0003_teams.down.sql',
      'finish 0003_teams.down.sql',
      'start 0002_sessions.down.sql',
      'finish 0002_sessions.down.sql',
    ]);
    assert.deepEqual(await readBatches(), [['migration', 'users', 1]]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);

    assert.deepEqual((await down({ directory })).files, ['0001_users.down.sql']);
    assert.deepEqual(await down({ directory }), { files: [], isDryRun: false });
    assert.deepEqual(await listTableNames(testDb), ['_migrations']);
  });

  test('rolls back the named ones whatever batch applied them, leaves the excluded ones, and only names the files on a dry run', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const { events, hooks } = createMigrationEvents();

    await up({ directory });
    await writeMigrationFiles(directory, { ...SESSIONS, ...TEAMS });
    await up({ directory });

    assert.deepEqual(await down({
      directory, names: ['users', 'teams'], isDryRun: true, ...hooks,
    }), { files: ['0003_teams.down.sql', '0001_users.down.sql'], isDryRun: true });
    assert.deepEqual(events, []);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'sessions', 'teams', 'users']);

    assert.deepEqual((await down({ directory, namesExclude: ['teams'] })).files, ['0002_sessions.down.sql']);
    assert.deepEqual((await down({ directory, names: ['users'] })).files, ['0001_users.down.sql']);
    assert.deepEqual((await down({ directory, names: ['users', 'sessions'] })).files, []);
    assert.deepEqual(await readBatches(), [['migration', 'teams', 2]]);
    await assert.rejects(down({ directory, names: ['nobody'] }), /^Error: No migration is named "nobody": /);
  });

  test('rolls back the named ones in the reverse of the order the database recorded, not of their versions: a lower version that was applied in a later batch goes first', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...ORDERS });
    const { events, hooks } = createMigrationEvents();
    const names = ['orders', 'order_notes'];
    const files = ['0002_order_notes.down.sql', '0003_orders.down.sql'];

    await up({ directory });
    await writeMigrationFiles(directory, ORDER_NOTES);
    await up({ directory });

    assert.deepEqual(await readBatches(), [['migration', 'users', 1], ['migration', 'order_notes', 2], ['migration', 'orders', 1]]);
    await assert.rejects(testDb.readRows(ORDERS['0003_orders.down.sql']), { code: REFERENCED_CODE });

    assert.deepEqual(await down({ directory, names, isDryRun: true }), { files, isDryRun: true });
    assert.deepEqual(await down({ directory, names, ...hooks }), { files, isDryRun: false });
    assert.deepEqual(events, files.flatMap((file) => [`start ${file}`, `finish ${file}`]));
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);
  });

  test('refuses before it rolls anything back when a migration of the batch has no down file, an empty one or no file at all', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, '0002_sessions.up.sql': SESSIONS['0002_sessions.up.sql'], ...TEAMS });
    const newerBuild = {
      message: 'The migration 0002_sessions cannot be rolled back here: a newer build applied it and this one has no file of it. Roll it back with that build',
    };

    await up({ directory });
    await assert.rejects(down({ directory }), { message: 'The migration 0002_sessions has no down file' });

    await writeMigrationFiles(directory, { '0002_sessions.down.sql': '\n' });
    await assert.rejects(down({ directory }), { message: `0002_sessions.down.sql ${EMPTY_FILE}` });

    await removeMigrationFiles(directory, ['0002_sessions.up.sql', '0002_sessions.down.sql']);
    await assert.rejects(down({ directory }), newerBuild);
    await assert.rejects(down({ directory, isDryRun: true }), newerBuild);

    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'sessions', 'teams', 'users']);
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false], ['migration', 'sessions', false], ['migration', 'teams', false]]);
    assert.deepEqual((await down({ directory, namesExclude: ['sessions'] })).files, ['0003_teams.down.sql', '0001_users.down.sql']);
  });

  test('refuses a down file that names a database before it rolls anything back', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });

    await up({ directory });
    await writeMigrationFiles(directory, { '0001_users.down.sql': `DROP TABLE ${testDb.name}.users;\n` });

    await assert.rejects(down({ directory }), { message: `0001_users.down.sql ${describeQualified(`${testDb.name}.users`)}` });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'sessions', 'users']);
    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false], ['migration', 'sessions', false]]);
  });

  test('rolls back a migration whose file was changed after it was applied: that is how it gets changed', async (t) => {
    const directory = await createMigrationDir(t, USERS);

    await up({ directory });
    await writeMigrationFiles(directory, { '0001_users.up.sql': WIDER_USERS });

    assert.deepEqual(await readStates({ directory }), [['0001_users', 'changed']]);
    assert.deepEqual((await down({ directory })).files, ['0001_users.down.sql']);
    assert.deepEqual((await up({ directory })).files, ['0001_users.up.sql']);
    assert.deepEqual(await testDb.readRows(EMAIL_TYPE_SQL), [{ type: 'varchar(200)' }]);
  });

  test('leaves a down file that failed after DDL dirty, with its row still there, until a person has said what the database holds', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, '0001_users.down.sql': 'DROP TABLE users;\nDROP TABLE users;\n' });

    await up({ directory });
    await assert.rejects(down({ directory }), {
      message: `0001_users.down.sql: statement 2 failed: Unknown table '${testDb.name}.users'; the migration is left dirty`,
    });

    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', true]]);

    const [forgetRow] = readStatementsByHand((await rejectionOf(up({ directory }))).message);

    assert.equal(forgetRow, "DELETE FROM _migrations WHERE type = 'migration' AND version = 1");
    await testDb.readRows(forgetRow);

    assert.deepEqual((await up({ directory })).files, ['0001_users.up.sql']);
  });

  test('applies a migration again after its rollback failed halfway and was finished by hand: the refusal speaks of both directions, and its DELETE leaves the migration pending', async (t) => {
    const directory = await createMigrationDir(t, { ...SESSIONS, '0002_sessions.down.sql': HALF_DOWN });

    await up({ directory });
    await assert.rejects(down({ directory }), {
      message: `0002_sessions.down.sql: statement 2 failed: Unknown table '${testDb.name}.sesions'; the migration is left dirty`,
    });

    const refusal = await rejectionOf(down({ directory }));
    const [forgetRow] = readStatementsByHand(refusal.message);

    assert.equal(refusal.message, describeDirtyRefusal({ id: '0002_sessions', version: 2, checksum: sha256(SESSIONS['0002_sessions.up.sql']) }));
    assert.deepEqual(await testDb.readRows(INDEXES_SQL), [{ name: 'PRIMARY' }]);

    await testDb.readRows('DROP TABLE sessions');
    await testDb.readRows(forgetRow);

    assert.deepEqual(await readStates({ directory }), [['0002_sessions', 'pending']]);
    assert.deepEqual((await up({ directory })).files, ['0002_sessions.up.sql']);
    assert.deepEqual(await testDb.readRows(INDEXES_SQL), [{ name: 'PRIMARY' }, { name: 'sessions_user' }]);
  });

  test('says that the up file is not the text the row was marked with when a rollback has failed on a file changed since it was applied, and keeps that text when the UPDATE it prints is run without "checksum": the migration reads as changed', async (t) => {
    const directory = await failRollbackOfChanged(t);
    const checksums = { checksum: sha256(USERS['0001_users.up.sql']), fileChecksum: sha256(WIDER_USERS) };
    const refusal = await rejectionOf(down({ directory }));
    const [, recordWhole] = readStatementsByHand(refusal.message);
    const keepText = recordWhole.replace(CHECKSUM_PART_REGEXP, '');

    assert.equal(refusal.message, `${describeDirtyRefusal({ id: '0001_users', version: 1, checksum: checksums.fileChecksum })}${MIGRATION_TEXT.REWRITTEN_NOTE}`);
    assert.equal(keepText, "UPDATE _migrations SET is_dirty = 0 WHERE type = 'migration' AND version = 1");
    await testDb.readRows(keepText);

    assert.deepEqual(await readStates({ directory }), [['0001_users', 'changed']]);
    await assert.rejects(up({ directory }), { message: describeChanged({ id: '0001_users', version: 1, ...checksums }) });
  });

  test('records a changed up file as applied when the UPDATE of the dirty refusal is run as it is printed after a failed rollback: the row takes the checksum of the file as it is now, whatever the database holds', async (t) => {
    const directory = await failRollbackOfChanged(t);
    const [, recordWhole] = readStatementsByHand((await rejectionOf(down({ directory }))).message);

    await testDb.readRows(recordWhole);

    assert.deepEqual(await readStates({ directory }), [['0001_users', 'applied']]);
    assert.deepEqual(await up({ directory }), { files: [], isDryRun: false, ahead: [] });
    assert.deepEqual(await testDb.readRows(EMAIL_TYPE_SQL), [{ type: 'varchar(100)' }]);
  });

  test('leaves a migration applied, not dirty, when its down file failed with nothing of it done', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, '0001_users.down.sql': 'DROP TABLEE users;\n' });

    await up({ directory });
    await assert.rejects(down({ directory }), /^Error: 0001_users\.down\.sql: statement 1 failed: You have an error in your SQL syntax.*; nothing of the file was applied$/);

    assert.deepEqual(await readDirtyMarks(), [['migration', 'users', false]]);
    assert.deepEqual(await readStates({ directory }), [['0001_users', 'applied']]);

    await writeMigrationFiles(directory, USERS);

    assert.deepEqual((await down({ directory })).files, ['0001_users.down.sql']);
  });

  test('does not roll migrations back while a seed applied after them is still applied', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SEED });
    const refusal = { message: 'The seed 0001_users was applied after the migrations to roll back: roll the seeds back first ("down" of the type seed)' };

    await up({ directory });
    await up({ directory, type: 'seed' });

    await assert.rejects(down({ directory }), refusal);
    await assert.rejects(down({ directory, isDryRun: true }), refusal);
    await assert.rejects(down({ directory, names: ['users'] }), refusal);
    assert.deepEqual(await testDb.readRows('SELECT id FROM users ORDER BY id'), [{ id: 1 }, { id: 2 }]);

    assert.deepEqual(await down({ directory, type: 'seed' }), { files: ['0001_users.down.sql'], isDryRun: false });
    assert.deepEqual(await testDb.readRows('SELECT id FROM users'), []);
    assert.deepEqual(await down({ directory }), { files: ['0001_users.down.sql'], isDryRun: false });
    assert.deepEqual(await listTableNames(testDb), ['_migrations']);
  });

  test('rolls back a migration that was applied after a seed, and the last batch of seeds whatever migrations came later', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SEED });

    await up({ directory });
    await up({ directory, type: 'seed' });
    await writeMigrationFiles(directory, SESSIONS);
    await up({ directory });

    assert.deepEqual((await down({ directory })).files, ['0002_sessions.down.sql']);
    assert.deepEqual(await readBatches(), [['migration', 'users', 1], ['seed', 'users', 2]]);

    await up({ directory });

    assert.deepEqual((await down({ directory, type: 'seed' })).files, ['0001_users.down.sql']);
    assert.deepEqual(await readBatches(), [['migration', 'users', 1], ['migration', 'sessions', 3]]);
  });

  test('has nothing to do on a database no migrator has touched, and creates nothing there', async (t) => {
    const directory = await createMigrationDir(t, USERS);

    assert.deepEqual(await down({ directory }), { files: [], isDryRun: false });
    assert.deepEqual(await down({ directory, type: 'seed', isDryRun: true }), { files: [], isDryRun: true });
    assert.deepEqual(await listTableNames(testDb), []);
  });
});

describe('getMigrationStatus', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('shows every migration of the build and of the database with its state, and throws for none of them', async (t) => {
    const directory = await createEveryState(t);
    const status = await readStatus({ directory });

    assert.deepEqual(status.map((item) => pick(item, ['id', 'version', 'name', 'state', 'batch'])), [
      {
        id: '0001_users', version: 1, name: 'users', state: 'applied', batch: 1,
      },
      {
        id: '0002_sessions', version: 2, name: 'sessions', state: 'changed', batch: 1,
      },
      {
        id: '0003_teams', version: 3, name: 'teams', state: 'missing', batch: 1,
      },
      {
        id: '0004_broken', version: 4, name: 'broken', state: 'dirty', batch: 1,
      },
      {
        id: '0005_later', version: 5, name: 'later', state: 'pending', batch: null,
      },
    ]);
  });

  test('gives every migration what its row holds and what its up file gives now', async (t) => {
    const directory = await createEveryState(t);
    const status = await readStatus({ directory });
    const [applied, changed, missing, dirty, pending] = status;
    const checksums = {
      users: sha256(USERS['0001_users.up.sql']),
      broken: sha256(BROKEN['0004_broken.up.sql']),
    };

    assert.deepEqual(status.map((item) => Object.keys(item)), status.map(() => STATUS_FIELDS));
    assert.ok(applied.appliedAt instanceof Date && Number.isInteger(applied.durationMs));
    assert.deepEqual(pick(applied, CHECKSUMS), { checksum: checksums.users, fileChecksum: checksums.users });
    assert.deepEqual(pick(changed, CHECKSUMS), { checksum: sha256(SESSIONS['0002_sessions.up.sql']), fileChecksum: sha256('-- rewritten\n') });
    assert.deepEqual(pick(missing, CHECKSUMS), { checksum: sha256(TEAMS['0003_teams.up.sql']), fileChecksum: null });
    assert.ok(dirty.appliedAt instanceof Date);
    assert.deepEqual(pick(dirty, ['durationMs', ...CHECKSUMS]), { durationMs: null, checksum: checksums.broken, fileChecksum: checksums.broken });
    assert.deepEqual(pick(pending, ['batch', 'appliedAt', 'durationMs', ...CHECKSUMS]), {
      batch: null, appliedAt: null, durationMs: null, checksum: null, fileChecksum: sha256(LATER['0005_later.up.sql']),
    });
  });

  test('puts the mark of a half-applied file before everything else that is true of a migration', async (t) => {
    const directory = await createEveryState(t);

    await testDb.readRows("UPDATE _migrations SET is_dirty = TRUE WHERE name IN ('sessions', 'teams')");

    assert.deepEqual(await readStates({ directory }), [
      ['0001_users', 'applied'],
      ['0002_sessions', 'dirty'],
      ['0003_teams', 'dirty'],
      ['0004_broken', 'dirty'],
      ['0005_later', 'pending'],
    ]);
  });

  test('shows a row and a file of one number and two names as two migrations: the file as pending, the row as missing', async (t) => {
    const directory = await replaceApplied(t, USERS, ACCOUNTS);
    const status = await readStatus({ directory });

    // By the id: the two stand under one version, and which of them comes first is not told.
    assert.deepEqual(Object.fromEntries(status.map((item) => [item.id, pick(item, ['state', 'batch', ...CHECKSUMS])])), {
      '0001_accounts': {
        state: 'pending', batch: null, checksum: null, fileChecksum: sha256(ACCOUNTS['0001_accounts.up.sql']),
      },
      '0001_users': {
        state: 'missing', batch: 1, checksum: sha256(USERS['0001_users.up.sql']), fileChecksum: null,
      },
    });
  });

  test('shows the seeds when asked for them, apart from the migrations of their versions and names', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SEED });

    assert.deepEqual(await readStates({ directory, type: 'seed' }), [['0001_users', 'pending']]);

    await up({ directory });

    assert.deepEqual(await readStates({ directory, type: 'seed' }), [['0001_users', 'pending']]);
    assert.deepEqual(await readStates({ directory }), [['0001_users', 'applied']]);

    await up({ directory, type: 'seed' });

    assert.deepEqual(await readStates({ directory, type: 'seed' }), [['0001_users', 'applied']]);
  });

  test('shows what the database holds as missing to a build that has lost its files, where "up" refuses', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });
    const lost = await createMigrationDir(t);

    await up({ directory });

    assert.deepEqual(await readStates({ directory: lost }), [['0001_users', 'missing'], ['0002_sessions', 'missing']]);
  });

  test('reads a database no migrator has touched as nothing applied, and creates nothing there', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });

    assert.deepEqual(await readStates({ directory }), [['0001_users', 'pending'], ['0002_sessions', 'pending']]);
    assert.deepEqual(await readStatus({ directory: nodePath.join(directory, 'missing') }), []);
    assert.deepEqual(await listTableNames(testDb), []);
  });
});

describe('findPendingMigrations', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('names the migrations of the build that are not applied, the half-applied one among them', async (t) => {
    const directory = await createEveryState(t);

    assert.deepEqual(await findPending(directory), ['0004_broken', '0005_later']);

    const [forgetRow] = readStatementsByHand((await rejectionOf(up({ directory }))).message);

    await testDb.readRows(forgetRow);
    await writeMigrationFiles(directory, { '0004_broken.up.sql': '-- repaired\n' });

    assert.deepEqual(await findPending(directory), ['0004_broken', '0005_later']);
  });

  test('names nothing once every migration of the build is applied, whatever the database holds beyond them', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });

    await up({ directory });
    await removeMigrationFiles(directory, Object.keys(SESSIONS));

    assert.deepEqual(await findPending(directory), []);
  });

  test('names a file that stands under an applied version with another name: the database holds the migration of another branch, not this one', async (t) => {
    const directory = await replaceApplied(t, USERS, ACCOUNTS);

    assert.deepEqual(await findPending(directory), ['0001_accounts']);
  });

  test('names a file that got another number after it was applied: under the new number the database does not hold it', async (t) => {
    const directory = await replaceApplied(t, USERS, RENUMBERED_USERS);

    assert.deepEqual(await findPending(directory), ['0005_users']);
  });

  test('does not count seeds, on either side', async (t) => {
    const directory = await createMigrationDir(t, {
      ...USERS,
      'seed/0001_users.up.sql': '-- a seed of the version and the name of the migration\n',
      'seed/0002_more.up.sql': '-- another seed\n',
    });

    await up({ directory, type: 'seed', names: ['users'] });

    assert.deepEqual(await findPending(directory), ['0001_users']);

    await up({ directory });

    assert.deepEqual(await findPending(directory), []);
  });

  test('counts every migration as pending in a database no migrator has touched, and creates nothing there', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });

    assert.deepEqual(await findPending(directory), ['0001_users', '0002_sessions']);
    assert.deepEqual(await findPending(nodePath.join(directory, 'missing')), []);
    assert.deepEqual(await listTableNames(testDb), []);
  });

  test('throws for a build that has lost its migrations: no file while the database holds applied ones, seeds not counted', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, 'seed/0001_notes.up.sql': '-- a seed with nothing to do\n' });
    const lost = await createMigrationDir(t);

    await up({ directory, type: 'seed' });

    assert.deepEqual(await findPending(lost), []);

    await up({ directory });

    await assert.rejects(findPending(lost), {
      message: `This build has no migration file in ${lost}, and the database holds 1 applied: the build has lost its migrations`,
    });
  });

  test('gives up within the time limit of a statement of its pool, instead of hanging, when the table is locked', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const impatient = testDb.open({ db: { statementTimeout: STATEMENT_TIMEOUT } }, t);
    const holder = await connectAdmin();

    t.after(() => holder.end());
    await up({ directory });

    assert.deepEqual(await findPending(directory, impatient), []);

    await holder.query(`LOCK TABLES \`${testDb.name}\`._migrations WRITE`);

    const waiting = findPending(directory, impatient);

    t.after(() => Promise.allSettled([waiting]));

    const error = await rejectionOf(withTimeout(() => waiting, GIVE_UP_WITHIN_MS));
    const { kind, code } = findDbError(error) ?? error;

    assert.deepEqual({ kind, code }, { kind: 'timeout', code: 'ER_STATEMENT_TIMEOUT' });

    await holder.query('UNLOCK TABLES');

    assert.deepEqual(await findPending(directory, impatient), []);
  });
});

describe('assertMigrated', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('refuses a database that lacks migrations of the build, naming them, and passes once they are applied', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });

    function check() {
      return run(() => assertMigrated({ directory }));
    }

    await assert.rejects(check(), { message: describePendingRefusal(['0001_users', '0002_sessions']) });

    await up({ directory, names: ['users'] });

    await assert.rejects(check(), { message: describePendingRefusal(['0002_sessions']) });

    await up({ directory });

    assert.equal(await check(), undefined);
  });

  test('refuses a database that holds a migration of the build half applied, though its row is there', async (t) => {
    const directory = await createEveryState(t);

    await assert.rejects(run(() => assertMigrated({ directory })), { message: describePendingRefusal(['0004_broken', '0005_later']) });
  });
});

describe('migrateFresh', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('refuses outside dev mode, before it touches anything', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const refusal = { message: `"fresh" drops the database "${testDb.name}" with everything in it: it runs only when APP_MODE=dev` };

    await up({ directory });
    await testDb.readRows('CREATE TABLE precious (id INT PRIMARY KEY)');

    await assert.rejects(fresh({ directory }, testDb), refusal);
    await assert.rejects(fresh({ directory, isDryRun: true }, testDb), refusal);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'precious', 'users']);
  });

  test('drops everything the database holds and applies every migration as the first batch, keeping the defaults of the database', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });

    await up({ directory, names: ['users'] });
    await mapSeries(LEFTOVERS, (sql) => testDb.readRows(sql));
    await testDb.alterDatabase('COLLATE utf8mb4_uca1400_as_cs COMMENT ?', [QUOTED_COMMENT]);

    assert.deepEqual(await countObjects(), [{ routines: 1, events: 1 }]);
    assert.deepEqual(await fresh({ directory }, openDev(t)), {
      files: ['0001_users.up.sql', '0002_sessions.up.sql'],
      isDryRun: false,
      database: testDb.name,
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'sessions', 'users']);
    assert.deepEqual(await readAppliedRows(testDb), [
      {
        type: 'migration', version: 1, name: 'users', batch: 1, is_dirty: false,
      },
      {
        type: 'migration', version: 2, name: 'sessions', batch: 1, is_dirty: false,
      },
    ]);
    assert.deepEqual(await countObjects(), [{ routines: 0, events: 0 }]);
    assert.deepEqual(await readDefaults(), [{ charset: 'utf8mb4', collation: 'utf8mb4_uca1400_as_cs', comment: QUOTED_COMMENT }]);
  });

  test('leaves the pools that were open at work: their sessions find the new database under the name they had', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const app = testDb.open({ db: { connectionLimit: 1 } }, t);
    const [session] = await app.readRows('SELECT CONNECTION_ID() AS id');

    await fresh({ directory }, openDev(t));
    await app.readRows("INSERT INTO users (id, email) VALUES (1, 'first@example.com')");

    assert.deepEqual(await app.readRows('SELECT CONNECTION_ID() AS id, DATABASE() AS name, (SELECT COUNT(*) FROM users) AS total'), [
      { id: session.id, name: testDb.name, total: 1 },
    ]);
  });

  test('tells of the drop and of every file it runs', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });
    const { events, hooks } = createMigrationEvents();

    await fresh({ directory, ...hooks }, openDev(t));

    assert.deepEqual(events, [
      `start DROP DATABASE \`${testDb.name}\``,
      `finish DROP DATABASE \`${testDb.name}\``,
      'start 0001_users.up.sql',
      'finish 0001_users.up.sql',
      'start 0002_sessions.up.sql',
      'finish 0002_sessions.up.sql',
    ]);
  });

  test('names every migration on a dry run, the applied ones too, and drops nothing', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });
    const { events, hooks } = createMigrationEvents();

    await up({ directory, names: ['users'] });
    await testDb.readRows('CREATE TABLE precious (id INT PRIMARY KEY)');

    assert.deepEqual(await fresh({ directory, isDryRun: true, ...hooks }, openDev(t)), {
      files: ['0001_users.up.sql', '0002_sessions.up.sql'],
      isDryRun: true,
      database: testDb.name,
    });
    assert.deepEqual(events, []);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'precious', 'users']);
  });

  test('applies migrations only: the seeds of the folder are left for "up"', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SEED });

    assert.deepEqual((await fresh({ directory }, openDev(t))).files, ['0001_users.up.sql']);
    assert.deepEqual(await testDb.readRows('SELECT id FROM users'), []);
    assert.deepEqual(await readBatches(), [['migration', 'users', 1]]);
  });

  test('checks the files before anything is dropped: an empty one or one that names a database stops it with every table still there', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const dev = openDev(t);

    await up({ directory });
    await testDb.readRows('CREATE TABLE precious (id INT PRIMARY KEY)');

    await writeMigrationFiles(directory, { '0002_sessions.up.sql': '' });
    await assert.rejects(fresh({ directory }, dev), { message: `0002_sessions.up.sql ${EMPTY_FILE}` });

    await writeMigrationFiles(directory, { '0002_sessions.up.sql': `CREATE TABLE ${testDb.name}.sessions (id INT);\n` });
    await assert.rejects(fresh({ directory }, dev), { message: `0002_sessions.up.sql ${describeQualified(`${testDb.name}.sessions`)}` });

    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'precious', 'users']);
  });

  test('works for an account that owns nothing but this database', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const owner = openDev(t, await testDb.createOwner(t));

    await testDb.readRows('CREATE TABLE leftovers (id INT PRIMARY KEY)');

    assert.deepEqual(await fresh({ directory }, owner), {
      files: ['0001_users.up.sql'],
      isDryRun: false,
      database: testDb.name,
    });
    assert.deepEqual(await listTableNames(owner), ['_migrations', 'users']);
  });

  test('tells how to put the database back when the server has dropped it and refuses to create it, and the statement does that', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const account = await testDb.createOwner(t);
    const putBack = `CREATE DATABASE \`${testDb.name}\` CHARACTER SET 'utf8mb4' COLLATE 'utf8mb4_bin' COMMENT '${PLAIN_COMMENT}'`;

    await revokeCreate(account);
    await testDb.alterDatabase('COMMENT ?', [PLAIN_COMMENT]);
    await up({ directory });

    await assert.rejects(fresh({ directory }, openDev(t, account)), {
      message: `DROP DATABASE \`${testDb.name}\`: statement 3 failed: Access denied for user '${account.APP_DATABASE_USER}'@'${ACCOUNT_HOST}' to database '${testDb.name}'. If the database is gone, put it back: ${putBack}`,
    });
    assert.deepEqual(await readDefaults(), []);

    await testDb.readRows(putBack);

    assert.deepEqual(await readDefaults(), [{ charset: 'utf8mb4', collation: 'utf8mb4_bin', comment: PLAIN_COMMENT }]);
    assert.deepEqual((await up({ directory })).files, ['0001_users.up.sql']);
  });
});
