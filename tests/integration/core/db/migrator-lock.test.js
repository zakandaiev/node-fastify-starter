import { findDbError } from '#core/db/error.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import {
  connectAdmin,
  createGate,
  createTestDb,
  findSessionId,
  killSession,
  waitAtGate,
} from '#root/tests/helper/db.js';
import {
  bindMigrator,
  createMigrationDir,
  createMigrationEvents,
  listTableNames,
  loseMigratorLock,
  MIGRATION_TEXT,
  readDirtyMarks,
  readKillStatement,
  readStatementsByHand,
  writeMigrationFiles,
} from '#root/tests/helper/migration.js';
import { mapSeries } from '#utils/async.js';
import { convertStringToMs, convertStringToSeconds } from '#utils/date.js';
import { sha256 } from '#utils/hash.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const { SEED } = MIGRATION_TYPE;

const LOCK_PREFIX = 'migrator:';
const FILE_LOCK_PREFIX = 'migrator-file:';
const LOCK_GRANTED = 1;

// What the list of sessions shows of a rival that asks for the lock of a running file, of a migrator that waits
// for the lock of the database and of a file that waits for the table of ADD_NAME.
const RIVAL_MARK = 'asked_by_a_rival';
const LOCK_WAIT_MARK = 'GET_LOCK';
const TABLE_WAIT_MARK = 'ADD COLUMN name';

// And of any session: a statement at work, or none.
const BUSY = 'Query';
const IDLE = 'Sleep';

// The longest a rival waits on the server for a lock: a test that broke on its way ends in seconds.
const WAIT_SECONDS_MAX = 10;

const SHORT_LOCK_TIMEOUT = '0.2s';

// A limit the server keeps on every statement of an account, far above what a migrator takes for a statement
// of its own, and the value that stands for no limit.
const STATEMENT_LIMIT_SECONDS = 5;
const NO_LIMIT = 0;

// The same limit below a lock timeout, for a run that does nothing but wait for the lock.
const SHORT_STATEMENT_LIMIT_SECONDS = 1;
const LONGER_LOCK_TIMEOUT = '2s';

// The share of a wait of the server that must show on the clock of the host, which runs a little slower.
const CLOCK_TOLERANCE = 0.8;

// lock_wait_timeout counts whole seconds: a shorter wait for a table the server does not know.
const TABLE_LOCK_TIMEOUT = '1s';

// What the config may give for that wait and what the session of a file must hold then: whole seconds, rounded
// up, since 0 would tell the server not to wait at all.
const TABLE_LOCK_WAITS = Object.freeze([
  { timeout: '7s', seconds: 7 },
  { timeout: '0.2s', seconds: 1 },
]);

// An idle limit a file held at a gate outlasts, and one no server gives its sessions by itself.
const SHORT_IDLE_TIMEOUT = '1s';
const RUN_IDLE_TIMEOUT = '90m';

// What a migrator holds at once: the connection with the lock of the database and the one of a file.
const MIGRATOR_CONNECTIONS = 2;

const USERS = Object.freeze({
  '0001_users.up.sql': 'CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(100) NOT NULL);\n',
  '0001_users.down.sql': 'DROP TABLE users;\n',
});
const LATER = Object.freeze({
  '0003_later.up.sql': 'CREATE TABLE later (id INT PRIMARY KEY);\n',
  '0003_later.down.sql': 'DROP TABLE later;\n',
});
const BROKEN = Object.freeze({
  '0004_broken.up.sql': 'CREATE TABLE halves (id INT PRIMARY KEY);\nCREATE TABLE halves (id INT);\n',
});
const BROKEN_FAILURE = "0004_broken.up.sql: statement 2 failed: Table 'halves' already exists; the migration is left dirty";

const HELD_KILLED_REGEXP = /^Error: 0002_held\.up\.sql: failed: .*; the migration is left dirty$/;
const RECORDED_ALONE = 'has run to its end and is recorded, but the connection that held the lock was lost while it ran: nothing after it was run. Run the command again';
const UNRECORDED = 'has run to its end, but that could not be recorded: the connection that held the lock was lost while it ran, and the row is left dirty. Record it by hand:';
const UNRECORDED_BY_SERVER = 'has run to its end, but that could not be recorded: Query execution was interrupted; the row is left dirty. Record it by hand:';
const HELD_ROW_CHANGED = 'The row of 0002_held in _migrations is not what the migrator left: it was changed while the migrator worked';

// What the list of sessions shows of the write that closes the row of an up file and of a down file.
const CLOSE_UP_MARK = 'SET is_dirty = FALSE, duration_ms';
const CLOSE_DOWN_MARK = 'DELETE FROM _migrations';

// The statement that records an up file by hand carries the time the file took.
const HELD_APPLIED_REGEXP = /^UPDATE _migrations SET is_dirty = FALSE, duration_ms = \d+, applied_at = CURRENT_TIMESTAMP\(3\) WHERE type = 'migration' AND version = 2 AND is_dirty = TRUE$/;

const LOCK_LOST_REGEXP = /^The connection the migrator keeps its lock on was lost \(.+\): run the command again$/;
const NOT_SENT = 'was not run: the connection the migrator keeps its lock on was lost before the file was sent. Run the command again; should it call the migration dirty, the mark is all that was written, and this takes it back:';

// What the migrator writes into its table, written by hand where a test stands for a write that reached the table
// while its answer was lost with the connection: the mark of an up file and of a down file, and the row of a held
// file closed after its up and after its down file.
const LATER_MARKED_SQL = `INSERT INTO _migrations (version, name, type, checksum, batch, is_dirty) VALUES (3, 'later', 'migration', '${sha256(LATER['0003_later.up.sql'])}', 1, TRUE)`;
const USERS_MARKED_SQL = "UPDATE _migrations SET is_dirty = TRUE WHERE type = 'migration' AND version = 1 AND is_dirty = FALSE";
const HELD_APPLIED_SQL = "UPDATE _migrations SET is_dirty = FALSE, duration_ms = 0, applied_at = CURRENT_TIMESTAMP(3) WHERE type = 'migration' AND version = 2 AND is_dirty = TRUE";
const HELD_ROLLED_BACK_SQL = "DELETE FROM _migrations WHERE type = 'migration' AND version = 2 AND is_dirty = TRUE";

// What takes those two marks back, as a refusal prints it.
const LATER_UNMARK_SQL = "DELETE FROM _migrations WHERE type = 'migration' AND version = 3 AND is_dirty = TRUE";
const USERS_UNMARK_SQL = "UPDATE _migrations SET is_dirty = FALSE WHERE type = 'migration' AND version = 1 AND is_dirty = TRUE";
const HELD_UNMARK_SQL = "UPDATE _migrations SET is_dirty = FALSE WHERE type = 'migration' AND version = 2 AND is_dirty = TRUE";

const FIRST_ROW = "INSERT INTO users (id, email) VALUES (1, 'first@example.com');\n";
const SECOND_ROW = "INSERT INTO users (id, email) VALUES (2, 'second@example.com');\n";
const SECOND_ROW_MARK = 'second@example.com';
const SEED_FAILURE = "0001_people.up.sql: statement 3 failed: Duplicate entry '***' for key 'PRIMARY'";
const SEED_KILLED_REGEXP = /^Error: 0001_people\.up\.sql: failed: .*; the seed is left dirty$/;
const SEED_UNMARK_SQL = "DELETE FROM _migrations WHERE type = 'seed' AND version = 1 AND is_dirty = TRUE";

// What a rival writes before it runs into the held seed: of two transactions that wait for each other the server
// ends the one that has written less, and that must be the seed.
const RIVAL_IDS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9]);
const RIVAL_ROWS_SQL = `INSERT INTO users (id, email) VALUES ${RIVAL_IDS.map((id) => `(${id}, 'rival@example.com')`).join(', ')}`;
const RIVAL_FIRST_ROW_SQL = "INSERT INTO users (id, email) VALUES (1, 'rival@example.com')";
const SEED_DEADLOCK_REGEXP = /^Error: 0001_people\.up\.sql: statement 3 failed: Deadlock found when trying to get lock; try restarting transaction; /;

const ADD_NAME = 'ALTER TABLE users ADD COLUMN name VARCHAR(100) NULL;\n';

// What a file may begin with that is not one definition, and the tables the database holds once such a statement
// has given up on the table "users": the first two had made a table of their own before they waited.
const NAMES_THEN_ADD_NAME = `CREATE TABLE names (id INT PRIMARY KEY);\n  ${ADD_NAME}`;
const ROUTINE = Object.freeze({
  '0002_routine.up.sql': `CREATE PROCEDURE add_names()\nBEGIN\n  ${NAMES_THEN_ADD_NAME}END;\n`,
});
const UNPROVEN_OPENINGS = Object.freeze([
  { opening: 'a block', sql: `BEGIN NOT ATOMIC\n  ${NAMES_THEN_ADD_NAME}END;\n`, tables: ['_migrations', 'names', 'users'] },
  { opening: 'a call of a procedure', sql: 'CALL add_names();\n', tables: ['_migrations', 'names', 'users'] },
  { opening: 'CREATE OR REPLACE', sql: 'CREATE OR REPLACE TABLE users (id INT PRIMARY KEY);\n', tables: ['_migrations', 'users'] },
]);

const PROBE = Object.freeze({
  '0001_probe.up.sql': 'CREATE TABLE probe AS SELECT @@lock_wait_timeout AS lock_wait, @@max_statement_time AS statement_limit;\n',
  '0001_probe.down.sql': 'DROP TABLE probe;\n',
});

// Each file writes down the session it runs in and the sessions that hold the two locks while it runs.
const WITNESS_SQL = `INSERT INTO witnesses (session_id, file_lock, database_lock) SELECT CONNECTION_ID(), IS_USED_LOCK(CONCAT('${FILE_LOCK_PREFIX}', DATABASE())), IS_USED_LOCK(CONCAT('${LOCK_PREFIX}', DATABASE()));\n`;
const WITNESSES = Object.freeze({
  '0001_witnesses.up.sql': `CREATE TABLE witnesses (id INT AUTO_INCREMENT PRIMARY KEY, session_id BIGINT NOT NULL, file_lock BIGINT NULL, database_lock BIGINT NULL);\n${WITNESS_SQL}`,
  '0002_more_witnesses.up.sql': WITNESS_SQL,
});

const LOCKS_SQL = 'SELECT CONNECTION_ID() AS sessionId, IS_USED_LOCK(:databaseLock) AS databaseLock, IS_USED_LOCK(:fileLock) AS fileLock';
const IDLE_LIMITS_SQL = 'SELECT CONNECTION_ID() AS sessionId, @@session.wait_timeout AS sessionLimit, @@global.wait_timeout AS serverLimit';
const COMMAND_SQL = 'SELECT command FROM information_schema.processlist WHERE id = :id';

const testDb = await createTestDb();

// A second database of this file, for the migrator nobody here must wait for.
const otherDb = await createTestDb();

const {
  up, down, verify, readStates,
} = bindMigrator(testDb);

// The files below stop at the gate of their test (createGate) until the test opens it: a run caught in the middle
// of a file, with no sleep to wait out. The up file has made its table by then, and its row is marked.
function heldUp(gate) {
  return {
    '0002_held.up.sql': `CREATE TABLE held (id INT PRIMARY KEY);\n${gate.statement};\nINSERT INTO held (id) VALUES (1);\n`,
    '0002_held.down.sql': 'DROP TABLE held;\n',
  };
}

function heldDown(gate) {
  return {
    '0002_held.up.sql': 'CREATE TABLE held (id INT PRIMARY KEY);\n',
    '0002_held.down.sql': `${gate.statement};\nDROP TABLE held;\n`,
  };
}

// A seed of plain writes, stopped after its first row: one transaction with nothing committed. With the first
// row as its last statement too, it fails there on the key.
function heldSeed(gate, lastRow = SECOND_ROW) {
  return { 'seed/0001_people.up.sql': `${FIRST_ROW}${gate.statement};\n${lastRow}` };
}

// The sessions that hold the lock of the database and the lock of a running file, null for a lock that is free,
// and the session that answers: the only one a pool of one connection has.
async function readLocks(pool = testDb) {
  const { database } = pool.config.db;
  const [locks] = await pool.readRows(LOCKS_SQL, {
    databaseLock: `${LOCK_PREFIX}${database}`,
    fileLock: `${FILE_LOCK_PREFIX}${database}`,
  });

  return locks;
}

function waitForFreeLock(name) {
  return waitFor(async () => (await readLocks())[name] === null, `the ${name} to be free`);
}

// The idle limit of the only session of a pool of one connection, beside the one the server gives a new session.
async function readIdleLimits(pool) {
  const [limits] = await pool.readRows(IDLE_LIMITS_SQL);

  return limits;
}

async function readCommand(id) {
  const [session] = await testDb.readRows(COMMAND_SQL, { id });

  return session?.command;
}

// The error a run gives up with, and how long it took to.
async function timeRejection(running) {
  const startedAt = performance.now();
  const error = await rejectionOf(running);

  return { error, waitedMs: Math.round(performance.now() - startedAt) };
}

function assertWaited(waitedMs, timeout) {
  assert.ok(waitedMs >= convertStringToMs(timeout) * CLOCK_TOLERANCE, `The run gave up after ${waitedMs} ms, before ${timeout} had passed`);
}

// How a refusal names the session that holds the lock of the database.
function describeHolder(id) {
  return `on connection ${id}: its row in information_schema.processlist tells what it is doing, and KILL ${id} frees the lock if that migrator is gone`;
}

// The refusal of every command while a session holds the lock of a running file and no migrator the lock of the database.
function describeOrphan(id) {
  return `A file of another migrator holds the database, on connection ${id}: that migrator no longer holds the lock (it is gone, or has lost its connection), and the server goes on with the file it was sent. The row of connection ${id} in information_schema.processlist tells whether the file still runs (Query) or only its session is left (Sleep). Run the command again when the session has ended; KILL ${id} ends it at once, undoes what the file has not committed and leaves its row dirty`;
}

// Resolves once the server is in the middle of the file that waits at the gate: the run has the lock of the
// database, its file the lock of a running file, and the row of the file is marked.
async function catchAtGate(t, gate, running, database = testDb.name) {
  return { running, fileSessionId: await waitAtGate(t, testDb, { gate, running, database }) };
}

// The connection that holds the lock of the database is lost, as when the server or the network drops it:
// the migrator is alive, and the server goes on with the file it was sent.
function loseDatabaseLock() {
  return loseMigratorLock(testDb);
}

async function orphanAtGate(t, gate, running) {
  const held = await catchAtGate(t, gate, running);

  await loseDatabaseLock();

  return held;
}

// For onFileStart: the connection with the lock is lost right before the given file is marked.
function loseLockBefore(fileName) {
  return async (startedFileName) => {
    if (startedFileName === fileName) {
      await loseDatabaseLock();
    }
  };
}

// A session that holds a lock of the migrator with nothing at work behind it: the lock of the database, as
// a migrator that hangs leaves it, or the lock of a running file, as a file whose client is gone leaves it.
// Resolves with the id of the session and with what ends it.
async function holdLock(t, prefix) {
  const holder = await connectAdmin();

  t.after(() => holder.end());

  const [[{ id, taken }]] = await holder.query('SELECT CONNECTION_ID() AS id, GET_LOCK(?, 0) AS taken', [`${prefix}${testDb.name}`]);

  assert.equal(taken, LOCK_GRANTED);

  return { id, end: () => holder.end() };
}

// A session of the test database that is no migrator, for what a file of another migrator would do there.
async function connectRival(t) {
  const rival = await connectAdmin();

  t.after(() => rival.end());
  await rival.query(`USE \`${testDb.name}\``);

  return rival;
}

// Asks for the lock of a running file while a file holds it, and resolves once the server has the request:
// the lock is the rival's the moment that file lets it go.
async function askForFileLock(t, rival) {
  const asking = rival.query(`SELECT GET_LOCK(?, ?) AS ${RIVAL_MARK}`, [`${FILE_LOCK_PREFIX}${testDb.name}`, WAIT_SECONDS_MAX]);

  t.after(() => Promise.allSettled([asking]));
  await findSessionId(testDb, RIVAL_MARK);
}

// A pool of one connection under an account that may hold two: the one with the lock and the one of a file.
// "leaveNone" takes the place of the first once it is lost: the account is at its limit again, and the migrator
// gets no connection of its own.
async function openLimited(t) {
  const account = await testDb.createOwner(t, [], { limit: `MAX_USER_CONNECTIONS ${MIGRATOR_CONNECTIONS}` });
  const pool = testDb.open({ env: account, db: { connectionLimit: 1 } }, t);

  async function leaveNone() {
    const squatter = await connectAdmin({ ...testDb.env, ...account });

    t.after(() => squatter.end());
  }

  return { pool, leaveNone };
}

// What the session of a file holds, as the file PROBE has written it down.
async function probeFileSession(directory, pool) {
  await up({ directory }, pool);

  const [session] = await testDb.readRows('SELECT lock_wait, statement_limit FROM probe');

  await down({ directory }, pool);

  return session;
}

describe('migrator: the lock of a database', { skip: testDb.skip }, () => {
  beforeEach(() => Promise.all([testDb.reset(), otherDb.reset()]));

  test('makes a second "up" wait for the first, tells of the wait once, and leaves it nothing to do', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...heldUp(gate), ...LATER });
    const { events, hooks } = createMigrationEvents();
    const first = await catchAtGate(t, gate, up({ directory }));
    const second = up({ directory, ...hooks });

    t.after(() => Promise.allSettled([second]));
    await waitFor(() => events.includes('wait'), 'the second run to tell of its wait');
    await gate.open();

    assert.deepEqual(await second, { files: [], isDryRun: false, ahead: [] });
    assert.deepEqual(events, ['wait']);
    assert.deepEqual((await first.running).files, ['0002_held.up.sql', '0003_later.up.sql']);
    assert.deepEqual(await readDirtyMarks(testDb), [['held', false], ['later', false]]);
  });

  test('gives up after the lock timeout of the config, and names the database, the limit and the session to look at or to kill', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const impatient = testDb.open({ db: { migrationLockTimeout: SHORT_LOCK_TIMEOUT } }, t);
    const { events, hooks } = createMigrationEvents();
    const { id: holder } = await holdLock(t, LOCK_PREFIX);
    const { error, waitedMs } = await timeRejection(up({ directory, ...hooks }, impatient));

    assert.equal(error.message, `Another migrator has held the lock of the database "${testDb.name}" for longer than ${SHORT_LOCK_TIMEOUT}, ${describeHolder(holder)}`);
    assertWaited(waitedMs, SHORT_LOCK_TIMEOUT);
    assert.equal((await readLocks()).databaseLock, holder);
    assert.deepEqual(events, ['wait']);
    assert.deepEqual(await listTableNames(testDb), []);

    await testDb.runAsAdmin(readKillStatement(error.message));
    await waitForFreeLock('databaseLock');

    assert.deepEqual((await up({ directory, ...hooks }, impatient)).files, ['0001_users.up.sql']);
    assert.deepEqual(events, ['wait', 'start 0001_users.up.sql', 'finish 0001_users.up.sql']);
  });

  test('waits for the whole lock timeout of the config, whatever limit the server keeps for a statement of its account', async (t) => {
    const account = await testDb.createOwner(t, [], { limit: `MAX_STATEMENT_TIME ${SHORT_STATEMENT_LIMIT_SECONDS}` });
    const limited = testDb.open({ env: account, db: { migrationLockTimeout: LONGER_LOCK_TIMEOUT } }, t);
    const directory = await createMigrationDir(t, USERS);
    const { id: holder } = await holdLock(t, LOCK_PREFIX);
    const { error, waitedMs } = await timeRejection(up({ directory }, limited));

    assert.equal(error.message, `Another migrator has held the lock of the database "${testDb.name}" for longer than ${LONGER_LOCK_TIMEOUT}, ${describeHolder(holder)}`);
    assertWaited(waitedMs, LONGER_LOCK_TIMEOUT);
  });

  test('reads under the lock on a dry run too: it waits for the migrator at work, then names what that one has left', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...heldUp(gate), ...LATER });
    const { events, hooks } = createMigrationEvents();

    await catchAtGate(t, gate, up({ directory, names: ['held'] }));

    const dryRun = up({ directory, isDryRun: true, ...hooks });

    t.after(() => Promise.allSettled([dryRun]));
    await waitFor(() => events.includes('wait'), 'the dry run to tell of its wait');
    await gate.open();

    assert.deepEqual(await dryRun, { files: ['0003_later.up.sql'], isDryRun: true, ahead: [] });
    assert.deepEqual(events, ['wait']);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'held']);
  });

  test('does not make "down" wait: it refuses at once while another migrator is at work, since what there is to roll back changes with what that one does', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, USERS);
    const { events, hooks } = createMigrationEvents();

    await up({ directory });
    await writeMigrationFiles(directory, heldUp(gate));

    const other = await catchAtGate(t, gate, up({ directory }));
    const { databaseLock: holder } = await readLocks();
    const { error, waitedMs } = await timeRejection(down({ directory, ...hooks }));

    assert.equal(error.message, `Another migrator is at work on the database "${testDb.name}", ${describeHolder(holder)}. A rollback does not wait for it: what there is to roll back changes with what that one does. Look at the status when it has finished, then run the rollback again`);
    assert.ok(waitedMs < convertStringToMs(testDb.config.db.migrationLockTimeout));
    assert.deepEqual(events, []);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'held', 'users']);

    await gate.open();
    await other.running;

    assert.deepEqual(await readStates({ directory }), [['0001_users', 'applied'], ['0002_held', 'applied']]);
    assert.deepEqual((await down({ directory })).files, ['0002_held.down.sql']);
  });

  test('lets the status be read without a wait: the file a migrator is running reads as running, not as dirty, and as applied once it has ended', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...heldUp(gate), ...LATER });
    const run = await catchAtGate(t, gate, up({ directory }));

    assert.deepEqual(await readDirtyMarks(testDb), [['held', true]]);
    assert.deepEqual(await readStates({ directory }), [['0002_held', 'running'], ['0003_later', 'pending']]);

    await gate.open();
    await run.running;

    assert.deepEqual(await readStates({ directory }), [['0002_held', 'applied'], ['0003_later', 'applied']]);
  });

  test('lets both locks go after a run that passed and after one that failed, and gives its connection back to the pool without them', async (t) => {
    const single = testDb.open({ db: { connectionLimit: 1, migrationLockTimeout: SHORT_LOCK_TIMEOUT } }, t);
    const directory = await createMigrationDir(t, USERS);
    const { events, hooks } = createMigrationEvents();
    const { sessionId } = await readLocks(single);
    const free = { sessionId, databaseLock: null, fileLock: null };

    await up({ directory }, single);

    assert.deepEqual(await readLocks(single), free);

    await writeMigrationFiles(directory, BROKEN);
    await assert.rejects(up({ directory }, single), { message: BROKEN_FAILURE });

    assert.deepEqual(await readLocks(single), free);
    await assert.rejects(up({ directory, ...hooks }, single), /^Error: The migration 0004_broken is dirty: /);
    assert.deepEqual(events, []);
  });

  test('gives its connection back to the pool with the idle limit the server gives a session, after a run that passed and after one that was refused: the limit of the config is for the run alone', async (t) => {
    const single = testDb.open({ db: { connectionLimit: 1, migrationIdleTimeout: RUN_IDLE_TIMEOUT } }, t);
    const directory = await createMigrationDir(t, USERS);
    const before = await readIdleLimits(single);

    await up({ directory }, single);

    assert.equal(before.sessionLimit, before.serverLimit);
    assert.notEqual(before.serverLimit, convertStringToSeconds(RUN_IDLE_TIMEOUT), 'The server gives its sessions the limit of this run: the test would prove nothing');
    assert.deepEqual(await readIdleLimits(single), before);

    await assert.rejects(up({ directory, names: ['nobody'] }, single), /^Error: No migration is named "nobody": /);

    assert.deepEqual(await readIdleLimits(single), before);
  });

  test('keeps the connection with the lock open for the idle limit of the config while a file runs: past a short one the server closes it in the middle of the file, under the default it does not', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, heldUp(gate));
    const brief = testDb.open({ db: { migrationIdleTimeout: SHORT_IDLE_TIMEOUT } }, t);
    const patient = await catchAtGate(t, gate, up({ directory }, otherDb), otherDb.name);
    const { databaseLock: patientSessionId } = await readLocks(otherDb);
    const cut = await catchAtGate(t, gate, up({ directory }, brief));

    await waitForFreeLock('databaseLock');

    assert.equal((await readLocks()).fileLock, cut.fileSessionId);
    assert.equal((await readLocks(otherDb)).databaseLock, patientSessionId);
    assert.equal(await readCommand(patientSessionId), IDLE);

    await gate.open();

    assert.deepEqual((await cut.running).files, ['0002_held.up.sql']);
    assert.deepEqual((await patient.running).files, ['0002_held.up.sql']);
  });

  test('does not wait for a migrator that works on another database: the lock is named after the database', async (t) => {
    const gate = await createGate(t);
    const heldDirectory = await createMigrationDir(t, heldUp(gate));
    const directory = await createMigrationDir(t, { ...USERS, ...LATER });
    const { events, hooks } = createMigrationEvents();
    const elsewhere = await catchAtGate(t, gate, up({ directory: heldDirectory }, otherDb), otherDb.name);

    assert.deepEqual((await up({ directory, ...hooks })).files, ['0001_users.up.sql', '0003_later.up.sql']);
    assert.deepEqual(events, [
      'start 0001_users.up.sql',
      'finish 0001_users.up.sql',
      'start 0003_later.up.sql',
      'finish 0003_later.up.sql',
    ]);
    assert.equal((await readLocks(otherDb)).fileLock, elsewhere.fileSessionId);

    await gate.open();

    assert.deepEqual((await elsewhere.running).files, ['0002_held.up.sql']);
  });

  test('tells a wait for the lock that KILL QUERY has cut as a cut wait, not as a migrator that held on for too long: the run applies nothing', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const { events, hooks } = createMigrationEvents();
    const { id: holder } = await holdLock(t, LOCK_PREFIX);
    const waiting = timeRejection(up({ directory, ...hooks }));

    t.after(() => Promise.allSettled([waiting]));
    await waitFor(() => events.includes('wait'), 'the run to tell of its wait');
    await killSession(testDb, await findSessionId(testDb, LOCK_WAIT_MARK), { isQueryOnly: true });

    const { error, waitedMs } = await waiting;
    const { migrationLockTimeout } = testDb.config.db;

    assert.equal(error.message, `The wait for the lock of the database "${testDb.name}" was cut short before ${migrationLockTimeout} had passed, by KILL QUERY most likely: run the command again`);
    assert.ok(waitedMs < convertStringToMs(migrationLockTimeout));
    assert.deepEqual(events, ['wait']);
    assert.equal((await readLocks()).databaseLock, holder);
    assert.deepEqual(await listTableNames(testDb), []);
  });
});

describe('migrator: a lost connection', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('records a file that ran to its end after the connection that held the lock was lost, and runs nothing after it', async (t) => {
    const single = testDb.open({ db: { connectionLimit: 1 } }, t);
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...heldUp(gate), ...LATER });
    const orphan = await orphanAtGate(t, gate, up({ directory }, single));

    assert.equal((await readLocks()).fileLock, orphan.fileSessionId);

    await gate.open();

    await assert.rejects(orphan.running, { message: `0002_held.up.sql ${RECORDED_ALONE}` });
    assert.deepEqual(await testDb.readRows('SELECT id FROM held'), [{ id: 1 }]);
    assert.deepEqual(await readDirtyMarks(testDb), [['held', false]]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'held']);
    assert.deepEqual((await up({ directory }, single)).files, ['0003_later.up.sql']);
  });

  test('ends the run as done when the connection that held the lock was lost during its last file: nothing was left to stop, and the pool is as good as before', async (t) => {
    const single = testDb.open({ db: { connectionLimit: 1 } }, t);
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...USERS, ...heldUp(gate) });
    const { events, hooks } = createMigrationEvents();
    const orphan = await orphanAtGate(t, gate, up({ directory, ...hooks }, single));

    await gate.open();

    assert.deepEqual(await orphan.running, { files: ['0001_users.up.sql', '0002_held.up.sql'], isDryRun: false, ahead: [] });
    assert.deepEqual(events, [
      'start 0001_users.up.sql',
      'finish 0001_users.up.sql',
      'start 0002_held.up.sql',
      'finish 0002_held.up.sql',
    ]);
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false], ['held', false]]);
    assert.deepEqual(await testDb.readRows('SELECT id FROM held'), [{ id: 1 }]);
    assert.deepEqual(await up({ directory }, single), { files: [], isDryRun: false, ahead: [] });
  });

  test('ends a rollback as done too when the connection that held the lock was lost during its last file: the row of the file is gone, and what an earlier batch applied stays applied', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, USERS);
    const { events, hooks } = createMigrationEvents();

    await up({ directory });
    await writeMigrationFiles(directory, heldDown(gate));
    await up({ directory });

    const orphan = await orphanAtGate(t, gate, down({ directory, ...hooks }));

    await gate.open();

    assert.deepEqual(await orphan.running, { files: ['0002_held.down.sql'], isDryRun: false });
    assert.deepEqual(events, ['start 0002_held.down.sql', 'finish 0002_held.down.sql']);
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);
    assert.deepEqual(await readStates({ directory }), [['0001_users', 'applied'], ['0002_held', 'pending']]);
  });

  test('stops a rollback after a file that ran to its end without the connection that held the lock: its row is gone, and the next "down" rolls back the rest of the batch', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...USERS, ...heldDown(gate) });

    await up({ directory });

    const orphan = await orphanAtGate(t, gate, down({ directory }));

    await gate.open();

    await assert.rejects(orphan.running, { message: `0002_held.down.sql ${RECORDED_ALONE}` });
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);
    assert.deepEqual((await down({ directory })).files, ['0001_users.down.sql']);
  });

  test('takes a file for recorded by the row as it stands, not by the answer to the write: a close that reached the table before the connection was lost ends the run as done (simulated: the row is closed by hand while the file is held)', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, heldUp(gate));
    const { events, hooks } = createMigrationEvents();
    const orphan = await orphanAtGate(t, gate, up({ directory, ...hooks }));

    await testDb.readRows(HELD_APPLIED_SQL);

    assert.deepEqual(await readDirtyMarks(testDb), [['held', false]]);

    await gate.open();

    assert.deepEqual((await orphan.running).files, ['0002_held.up.sql']);
    assert.deepEqual(events, ['start 0002_held.up.sql', 'finish 0002_held.up.sql']);
    assert.deepEqual(await readDirtyMarks(testDb), [['held', false]]);
  });

  test('takes a rollback for recorded by the row as it stands too: a row that was gone before the connection was lost is not told as one that could not be recorded (simulated: the row is deleted by hand while the down file is held)', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, heldDown(gate));

    await up({ directory });

    const orphan = await orphanAtGate(t, gate, down({ directory }));

    await testDb.readRows(HELD_ROLLED_BACK_SQL);

    assert.deepEqual(await readDirtyMarks(testDb), []);

    await gate.open();

    assert.deepEqual((await orphan.running).files, ['0002_held.down.sql']);
    assert.deepEqual(await listTableNames(testDb), ['_migrations']);
  });

  test('refuses to take a file for recorded when its row was deleted by hand while it ran, with the lock held and with the lock lost: the close finds no row, and nothing after the file runs', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...heldUp(gate), ...LATER });
    const held = await catchAtGate(t, gate, up({ directory }));

    await testDb.readRows(HELD_ROLLED_BACK_SQL);
    await gate.open();

    await assert.rejects(held.running, { message: HELD_ROW_CHANGED });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'held']);

    await testDb.reset();

    const lostGate = await createGate(t);
    const lostDirectory = await createMigrationDir(t, { ...heldUp(lostGate), ...LATER });
    const orphan = await orphanAtGate(t, lostGate, up({ directory: lostDirectory }));

    await testDb.readRows(HELD_ROLLED_BACK_SQL);
    await lostGate.open();

    await assert.rejects(orphan.running, { message: HELD_ROW_CHANGED });
    assert.deepEqual(await readDirtyMarks(testDb), []);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'held']);
  });

  test('refuses to take a rollback for recorded when its mark was cleared by hand while the down file ran, with the lock held and with the lock lost: the row says applied over a table that is gone', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, heldDown(gate));

    await up({ directory });

    const held = await catchAtGate(t, gate, down({ directory }));

    await testDb.readRows(HELD_UNMARK_SQL);
    await gate.open();

    await assert.rejects(held.running, { message: HELD_ROW_CHANGED });
    assert.deepEqual(await readDirtyMarks(testDb), [['held', false]]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations']);

    await testDb.reset();

    const lostGate = await createGate(t);
    const lostDirectory = await createMigrationDir(t, heldDown(lostGate));

    await up({ directory: lostDirectory });

    const orphan = await orphanAtGate(t, lostGate, down({ directory: lostDirectory }));

    await testDb.readRows(HELD_UNMARK_SQL);
    await lostGate.open();

    await assert.rejects(orphan.running, { message: HELD_ROW_CHANGED });
    assert.deepEqual(await readDirtyMarks(testDb), [['held', false]]);
  });

  test('tells that a file ran to its end when the write that records it fails on a connection that is alive, and prints the statement that records it by hand: the refusal of the next run would call the file not known', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...heldUp(gate), ...LATER });
    const held = await catchAtGate(t, gate, up({ directory }));
    const rival = await connectRival(t);

    await rival.query('BEGIN');
    await rival.query('SELECT * FROM _migrations FOR UPDATE');
    await gate.open();
    await killSession(testDb, await findSessionId(testDb, CLOSE_UP_MARK), { isQueryOnly: true });

    const { message } = await rejectionOf(held.running);
    const [statement] = readStatementsByHand(message);

    assert.equal(message, `0002_held.up.sql ${UNRECORDED_BY_SERVER} ${statement}`);
    assert.match(statement, HELD_APPLIED_REGEXP);
    assert.deepEqual(await readDirtyMarks(testDb), [['held', true]]);

    await rival.query('ROLLBACK');
    await testDb.readRows(statement);

    assert.deepEqual(await readDirtyMarks(testDb), [['held', false]]);
    assert.deepEqual((await up({ directory })).files, ['0003_later.up.sql']);
  });

  test('tells the same of a rollback whose down file ran to its end: the statement it prints deletes the row', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...USERS, ...heldDown(gate) });

    await up({ directory });

    const held = await catchAtGate(t, gate, down({ directory }));
    const rival = await connectRival(t);

    await rival.query('BEGIN');
    await rival.query('SELECT * FROM _migrations FOR UPDATE');
    await gate.open();
    await killSession(testDb, await findSessionId(testDb, CLOSE_DOWN_MARK), { isQueryOnly: true });

    const { message } = await rejectionOf(held.running);

    assert.equal(message, `0002_held.down.sql ${UNRECORDED_BY_SERVER} ${HELD_ROLLED_BACK_SQL}`);
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false], ['held', true]]);

    await rival.query('ROLLBACK');
    await testDb.readRows(readStatementsByHand(message)[0]);

    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);
    assert.deepEqual((await down({ directory })).files, ['0001_users.down.sql']);
  });

  test('prints the statement that records a file by hand when it ran to its end and no connection was left to record it', async (t) => {
    const limited = await openLimited(t);
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...heldUp(gate), ...LATER });
    const orphan = await orphanAtGate(t, gate, up({ directory }, limited.pool));

    await limited.leaveNone();
    await gate.open();

    const { message } = await rejectionOf(orphan.running);
    const statement = readStatementsByHand(message)[0];

    assert.equal(message, `0002_held.up.sql ${UNRECORDED} ${statement}`);
    assert.match(statement, HELD_APPLIED_REGEXP);
    assert.deepEqual(await readDirtyMarks(testDb), [['held', true]]);

    await testDb.readRows(statement);

    assert.deepEqual(await readDirtyMarks(testDb), [['held', false]]);
    assert.deepEqual((await up({ directory })).files, ['0003_later.up.sql']);
  });

  test('prints the statement that records a rollback by hand when its down file ran to its end and no connection was left to record it: the statement deletes the row', async (t) => {
    const limited = await openLimited(t);
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...USERS, ...heldDown(gate) });

    await up({ directory });

    const orphan = await orphanAtGate(t, gate, down({ directory }, limited.pool));

    await limited.leaveNone();
    await gate.open();

    const { message } = await rejectionOf(orphan.running);

    assert.equal(message, `0002_held.down.sql ${UNRECORDED} ${HELD_ROLLED_BACK_SQL}`);
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false], ['held', true]]);

    await testDb.readRows(readStatementsByHand(message)[0]);

    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);
    assert.deepEqual((await down({ directory })).files, ['0001_users.down.sql']);
  });

  test('takes the mark of a seed back through a connection of its own when the seed failed and was undone whole after the connection that held the lock was lost', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...USERS, ...heldSeed(gate, FIRST_ROW) });

    await up({ directory });

    const orphan = await orphanAtGate(t, gate, up({ directory, type: SEED }));

    await gate.open();

    await assert.rejects(orphan.running, { message: `${SEED_FAILURE}; nothing of the file was applied` });
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);
    assert.deepEqual(await testDb.readRows('SELECT id FROM users'), []);

    await writeMigrationFiles(directory, heldSeed(gate));

    assert.deepEqual((await up({ directory, type: SEED })).files, ['0001_people.up.sql']);
  });

  test('takes the mark of a migration back through a connection of its own when its first statement, one definition, gave up on a table after the connection that held the lock was lost', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const hasty = testDb.open({ db: { migrationTableLockTimeout: TABLE_LOCK_TIMEOUT } }, t);

    await up({ directory });
    await writeMigrationFiles(directory, { '0002_user_names.up.sql': ADD_NAME });

    const reader = await testDb.holdTable(t, 'users');
    const running = up({ directory }, hasty);

    t.after(() => Promise.allSettled([running]));

    const fileSessionId = await findSessionId(testDb, TABLE_WAIT_MARK);

    await loseDatabaseLock();

    assert.equal((await readLocks()).fileLock, fileSessionId, 'The file gave up on the table before the lock was lost: the test was too slow');
    await assert.rejects(running, {
      message: `0002_user_names.up.sql: statement 1 failed: ${MIGRATION_TEXT.TABLE_HELD}; nothing of the file was applied`,
    });
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);

    await reader.query('ROLLBACK');

    assert.deepEqual((await up({ directory }, hasty)).files, ['0002_user_names.up.sql']);
  });

  test('prints the statement that takes the mark back by hand when the file left nothing and no connection was left to take it back', async (t) => {
    const limited = await openLimited(t);
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...USERS, ...heldSeed(gate, FIRST_ROW) });

    await up({ directory });

    const orphan = await orphanAtGate(t, gate, up({ directory, type: SEED }, limited.pool));

    await limited.leaveNone();
    await gate.open();

    const { message } = await rejectionOf(orphan.running);

    assert.equal(message, `${SEED_FAILURE}; nothing of the file was applied, but its mark could not be taken back. Take it back by hand: ${SEED_UNMARK_SQL}`);
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false], ['people', true]]);
    await assert.rejects(up({ directory }), /^Error: The seed 0001_people is dirty: /);

    await testDb.readRows(readStatementsByHand(message)[0]);
    await writeMigrationFiles(directory, heldSeed(gate));

    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);
    assert.deepEqual((await up({ directory, type: SEED })).files, ['0001_people.up.sql']);
  });

  test('refuses every command beside a file an earlier migrator has left running, and names its session: to look at, to wait for, or to kill, which undoes what the file has not committed', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...USERS, ...heldSeed(gate) });
    const { events, hooks } = createMigrationEvents();

    await up({ directory });

    const orphan = await orphanAtGate(t, gate, up({ directory, type: SEED }));
    const refusal = describeOrphan(orphan.fileSessionId);
    const errors = await mapSeries([up, down, verify], (command) => rejectionOf(command({ directory, ...hooks })));

    assert.deepEqual(errors.map((error) => error.message), [refusal, refusal, refusal]);
    assert.deepEqual(events, []);
    assert.equal(await readCommand(orphan.fileSessionId), BUSY);

    await testDb.runAsAdmin(readKillStatement(refusal));
    await assert.rejects(orphan.running, SEED_KILLED_REGEXP);
    await waitForFreeLock('fileLock');

    assert.deepEqual(await testDb.readRows('SELECT id FROM users'), []);
    assert.deepEqual(await readStates({ directory, type: SEED }), [['0001_people', 'dirty']]);
    await assert.rejects(up({ directory }), /^Error: The seed 0001_people is dirty: /);
  });

  test('refuses in the same words beside a session that only holds the lock of a running file, with no statement at work, and runs once that session has ended', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const idler = await holdLock(t, FILE_LOCK_PREFIX);

    await assert.rejects(up({ directory }), { message: describeOrphan(idler.id) });
    assert.equal(await readCommand(idler.id), IDLE);
    assert.deepEqual(await listTableNames(testDb), []);

    await idler.end();
    await waitForFreeLock('fileLock');

    assert.deepEqual((await up({ directory })).files, ['0001_users.up.sql']);
  });

  test('runs no file after the connection that holds the lock was lost between two files: the next one is not sent, and the next run goes on with it', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...LATER });
    const { message } = await rejectionOf(up({ directory, onFileStart: loseLockBefore('0003_later.up.sql') }));

    assert.equal(message, `0003_later.up.sql ${NOT_SENT} ${LATER_UNMARK_SQL}`);
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);
    assert.deepEqual((await up({ directory })).files, ['0003_later.up.sql']);
  });

  test('prints with the refusal of an unsent file the statement that takes its mark back, should the mark have reached the table before the connection was lost (simulated: the mark is written by hand after the run)', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...LATER });
    const { message } = await rejectionOf(up({ directory, onFileStart: loseLockBefore('0003_later.up.sql') }));

    await testDb.readRows(LATER_MARKED_SQL);
    await assert.rejects(up({ directory }), /^Error: The migration 0003_later is dirty: /);
    await testDb.readRows(readStatementsByHand(message)[0]);

    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);
    assert.deepEqual((await up({ directory })).files, ['0003_later.up.sql']);
  });

  test('prints the same for an unsent down file: its statement makes the row read as applied again (simulated: the mark is written by hand after the run)', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...LATER });

    await up({ directory });

    const { message } = await rejectionOf(down({ directory, onFileStart: loseLockBefore('0001_users.down.sql') }));

    assert.equal(message, `0001_users.down.sql ${NOT_SENT} ${USERS_UNMARK_SQL}`);

    await testDb.readRows(USERS_MARKED_SQL);
    await assert.rejects(down({ directory }), /^Error: The migration 0001_users is dirty: /);
    await testDb.readRows(readStatementsByHand(message)[0]);

    assert.deepEqual(await readStates({ directory }), [['0001_users', 'applied'], ['0003_later', 'pending']]);
    assert.deepEqual((await down({ directory })).files, ['0001_users.down.sql']);
  });

  test('tells a connection lost at any other moment as the connection with the lock, in the words of the driver, and not as an error of the database: here it is lost while it waits for the lock', async (t) => {
    const single = testDb.open({ db: { connectionLimit: 1 } }, t);
    const directory = await createMigrationDir(t, USERS);
    const { sessionId } = await readLocks(single);

    await holdLock(t, LOCK_PREFIX);

    const error = await rejectionOf(up({ directory, onLockWait: () => killSession(testDb, sessionId) }, single));

    assert.match(error.message, LOCK_LOST_REGEXP);
    assert.equal(findDbError(error), null);
    assert.equal(findDbError(error.cause)?.isFatal, true);
    assert.deepEqual(await listTableNames(testDb), []);
    assert.notEqual((await readLocks(single)).sessionId, sessionId);
  });

  test('leaves a file dirty when the session that runs it is lost, and lets the lock of the database go', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...heldUp(gate), ...LATER });
    const run = await catchAtGate(t, gate, up({ directory }));

    await killSession(testDb, run.fileSessionId);

    await assert.rejects(run.running, HELD_KILLED_REGEXP);
    await waitForFreeLock('fileLock');

    assert.equal((await readLocks()).databaseLock, null);
    assert.deepEqual(await readDirtyMarks(testDb), [['held', true]]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'held']);
  });
});

describe('migrator: the session of a file', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('gives up on a table another session holds: a first statement that only waited leaves nothing, and the file runs once the table is free', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const hasty = testDb.open({ db: { migrationTableLockTimeout: TABLE_LOCK_TIMEOUT } }, t);

    await up({ directory });
    await writeMigrationFiles(directory, { '0002_user_names.up.sql': ADD_NAME });

    const reader = await testDb.holdTable(t, 'users');

    await assert.rejects(up({ directory }, hasty), {
      message: `0002_user_names.up.sql: statement 1 failed: ${MIGRATION_TEXT.TABLE_HELD}; nothing of the file was applied`,
    });
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);

    await reader.query('ROLLBACK');

    assert.deepEqual((await up({ directory }, hasty)).files, ['0002_user_names.up.sql']);
  });

  test('tells a deadlock in the words of the server alone: the word about a session that holds a table is for a wait that ran out, and here the server has ended the wait itself', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...USERS, ...heldSeed(gate) });
    const rival = await connectRival(t);

    await up({ directory });

    const seed = await catchAtGate(t, gate, up({ directory, type: SEED }));

    await rival.query('BEGIN');
    await rival.query(RIVAL_ROWS_SQL);
    await gate.open();
    await findSessionId(testDb, SECOND_ROW_MARK);
    await rival.query(RIVAL_FIRST_ROW_SQL);

    await assert.rejects(seed.running, SEED_DEADLOCK_REGEXP);
  });

  test('leaves a file dirty when a later statement of it gave up on a table: the DDL before it has stayed', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const hasty = testDb.open({ db: { migrationTableLockTimeout: TABLE_LOCK_TIMEOUT } }, t);

    await up({ directory });
    await writeMigrationFiles(directory, { '0002_user_names.up.sql': `CREATE TABLE names (id INT PRIMARY KEY);\n${ADD_NAME}` });
    await testDb.holdTable(t, 'users');

    await assert.rejects(up({ directory }, hasty), {
      message: `0002_user_names.up.sql: statement 2 failed: ${MIGRATION_TEXT.TABLE_HELD}; the migration is left dirty`,
    });
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false], ['user_names', true]]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'names', 'users']);
  });

  UNPROVEN_OPENINGS.forEach(({ opening, sql, tables }) => {
    test(`leaves a file dirty when it begins with ${opening} that gave up on a table: unlike one definition, such a statement may have done a part of its work before it waited`, async (t) => {
      const directory = await createMigrationDir(t, { ...USERS, ...ROUTINE });
      const hasty = testDb.open({ db: { migrationTableLockTimeout: TABLE_LOCK_TIMEOUT } }, t);

      await up({ directory });
      await writeMigrationFiles(directory, { '0003_user_names.up.sql': sql });
      await testDb.holdTable(t, 'users');

      await assert.rejects(up({ directory }, hasty), {
        message: `0003_user_names.up.sql: statement 1 failed: ${MIGRATION_TEXT.TABLE_HELD}; the migration is left dirty`,
      });
      assert.deepEqual(await readDirtyMarks(testDb), [['users', false], ['routine', false], ['user_names', true]]);
      assert.deepEqual(await listTableNames(testDb), tables);
    });
  });

  test('sets the session of a file apart from those of the pool: its wait for a table comes from the config, and no limit of its account cuts a statement', async (t) => {
    const account = await testDb.createOwner(t, [], { limit: `MAX_STATEMENT_TIME ${STATEMENT_LIMIT_SECONDS}` });
    const directory = await createMigrationDir(t, PROBE);
    const owner = testDb.open({ env: account }, t);
    const pools = TABLE_LOCK_WAITS.map(({ timeout }) => testDb.open({ env: account, db: { migrationTableLockTimeout: timeout } }, t));

    assert.deepEqual(await owner.readRows('SELECT @@max_statement_time AS statement_limit'), [{ statement_limit: STATEMENT_LIMIT_SECONDS }]);
    assert.deepEqual(
      await mapSeries(pools, (pool) => probeFileSession(directory, pool)),
      TABLE_LOCK_WAITS.map(({ seconds }) => ({ lock_wait: seconds, statement_limit: NO_LIMIT })),
    );
  });

  test('runs every file in a session of its own under the lock of a running file, and keeps the lock of the database on one connection of the pool', async (t) => {
    const single = testDb.open({ db: { connectionLimit: 1 } }, t);
    const directory = await createMigrationDir(t, WITNESSES);
    const { sessionId } = await readLocks(single);

    await up({ directory }, single);

    const [first, second] = await testDb.readRows('SELECT session_id, file_lock, database_lock FROM witnesses ORDER BY id');
    const sessions = [first.session_id, second.session_id, sessionId];

    assert.deepEqual([first.file_lock, second.file_lock], [first.session_id, second.session_id]);
    assert.deepEqual([first.database_lock, second.database_lock], [sessionId, sessionId]);
    assert.equal(new Set(sessions).size, sessions.length);
    assert.deepEqual(await readLocks(single), { sessionId, databaseLock: null, fileLock: null });
  });

  test('does not start a file while another session holds the lock of a running file, and leaves that file unmarked', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...LATER });
    const rival = await connectRival(t);

    await assert.rejects(up({ directory, onFileFinish: () => askForFileLock(t, rival) }), {
      message: '0003_later.up.sql was not run: another session holds the lock of a running file of this database',
    });
    assert.deepEqual(await readDirtyMarks(testDb), [['users', false]]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);

    await rival.end();
    await waitForFreeLock('fileLock');

    assert.deepEqual((await up({ directory })).files, ['0003_later.up.sql']);
  });
});
