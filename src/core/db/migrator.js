import { getContext } from '#core/context/index.js';
import {
  findDbError,
  isDatabaseAccessDenied,
  isLockConflict,
  isLockWaitTimeout,
  isMissingTable,
} from '#core/db/error.js';
import { getDb } from '#core/db/index.js';
import {
  assertMigrationType,
  assertRunnable,
  formatMigrationId,
  listMigrations,
  MIGRATION_DIRECTORY,
  MIGRATION_NAME_MAX_LENGTH,
  readMigrationFile,
  resolveMigrationDirectory,
  startsWithDefinition,
} from '#core/db/migration-file.js';
import {
  compareStructures,
  findDisallowedCollations,
  findServerNamedConstraints,
  readDatabaseDefaults,
  readStructure,
} from '#core/db/structure.js';
import { MIGRATION_STATE } from '#enums/migration-state.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { sortBy } from '#utils/array.js';
import { mapSeries } from '#utils/async.js';
import { rowToCamel } from '#utils/case.js';
import { convertStringToSeconds } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import {
  isArray,
  isBoolean,
  isFunction,
  isNonEmptyString,
  isString,
} from '#utils/type.js';
import nodePath from 'node:path';

const TABLE = '_migrations';
const TYPES = Object.freeze(Object.values(MIGRATION_TYPE));

// Two advisory locks, each named after the database, since a lock name is one for the whole server. The first
// is held by a migrator for its whole run. The second is held by the session that runs a file: when a migrator
// dies, the server drops the first at once and goes on with the file it was sent, and only the second tells.
const LOCK_PREFIX = 'migrator:';
const FILE_LOCK_PREFIX = 'migrator-file:';
const LOCK_GRANTED = 1;
const NO_WAIT = 0;

const NO_BATCH = 0;
const ONE_ROW = 1;
const FIRST_STATEMENT = 1;

// lock_wait_timeout takes whole seconds, and 0 means "do not wait at all".
const TABLE_LOCK_SECONDS_MIN = 1;

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    version BIGINT UNSIGNED NOT NULL,
    name VARCHAR(${MIGRATION_NAME_MAX_LENGTH}) NOT NULL,
    type VARCHAR(16) NOT NULL,
    checksum CHAR(64) NOT NULL,
    batch INT UNSIGNED NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    duration_ms INT UNSIGNED NULL,
    is_dirty TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (type, version),
    CONSTRAINT _migrations_type_check CHECK (type IN (${TYPES.map((type) => `'${type}'`).join(', ')}))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Migrations and seeds applied to this database'
`;

const ROW_COLUMNS = 'version, name, type, checksum, batch, applied_at, duration_ms, is_dirty';
const ROW_KEY = 'type = :type AND version = :version';
const ROWS_SQL = `SELECT ${ROW_COLUMNS} FROM ${TABLE}`;

// In one statement with the rows: read apart, the file could end between the two answers.
const STATUS_SQL = `SELECT ${ROW_COLUMNS}, IS_USED_LOCK(CONCAT(:prefix, DATABASE())) IS NOT NULL AS is_running FROM ${TABLE}`;

// Each of these must find exactly its row, in the state the step before has left it in: a row somebody has
// changed by hand while its file ran must not pass for a recorded one.
const MARK_UP_SQL = `
  INSERT INTO ${TABLE} (version, name, type, checksum, batch, is_dirty)
  VALUES (:version, :name, :type, :checksum, :batch, TRUE)
`;
const CLOSE_UP_SQL = `UPDATE ${TABLE} SET is_dirty = FALSE, duration_ms = :durationMs, applied_at = CURRENT_TIMESTAMP(3) WHERE ${ROW_KEY} AND is_dirty = TRUE`;
const UNMARK_UP_SQL = `DELETE FROM ${TABLE} WHERE ${ROW_KEY} AND is_dirty = TRUE`;
const MARK_DOWN_SQL = `UPDATE ${TABLE} SET is_dirty = TRUE WHERE ${ROW_KEY} AND is_dirty = FALSE`;
const CLOSE_DOWN_SQL = `DELETE FROM ${TABLE} WHERE ${ROW_KEY} AND is_dirty = TRUE`;
const UNMARK_DOWN_SQL = `UPDATE ${TABLE} SET is_dirty = FALSE WHERE ${ROW_KEY} AND is_dirty = TRUE`;
const ROW_STATE_SQL = `SELECT is_dirty FROM ${TABLE} WHERE ${ROW_KEY}`;

// The name of the database is the one the server gives its session, not the one of the config: two spellings
// of one database must not make two locks. The limit a server or an account keeps for a statement is lifted
// for the wait: it would cut the wait short, and GET_LOCK answers NULL then.
const LOCK_SQL = 'SET STATEMENT max_statement_time = 0 FOR SELECT DATABASE() AS name, GET_LOCK(CONCAT(:prefix, DATABASE()), :timeout) AS result';
const UNLOCK_SQL = 'SELECT RELEASE_LOCK(CONCAT(:prefix, DATABASE())) AS result';
const HOLDER_SQL = 'SELECT IS_USED_LOCK(CONCAT(:prefix, DATABASE())) AS holder';

// A statement of a file that needs a table another session holds would wait for a day by default, with every
// other statement on that table behind it. A limit on statements that the server may have would cut a long one.
const FILE_SESSION_SQL = 'SET SESSION lock_wait_timeout = :seconds, max_statement_time = 0';

// The connection that holds the lock sends nothing while a file runs, and the server closes a session
// that stands idle for longer than its wait_timeout.
const IDLE_SQL = 'SET SESSION wait_timeout = :seconds';
const IDLE_RESET_SQL = 'SET SESSION wait_timeout = DEFAULT';

const STATUS_FIELDS = Object.freeze([
  'id',
  'version',
  'name',
  'state',
  'batch',
  'appliedAt',
  'durationMs',
  'checksum',
  'fileChecksum',
]);

function isListOfNames(value) {
  return isArray(value) && value.every((name) => isString(name));
}

function assertOptions(options, signature) {
  const callbacks = [options.onLockWait, options.onFileStart, options.onFileFinish];

  assertMigrationType(options.type, signature);

  if ((options.names !== undefined && !isListOfNames(options.names)) || !isListOfNames(options.namesExclude)) {
    throw new TypeError(`${signature} requires names and namesExclude to be lists of names`);
  }

  if (!isBoolean(options.isDryRun) || !isNonEmptyString(options.directory)) {
    throw new TypeError(`${signature} requires isDryRun to be a boolean and directory a path`);
  }

  if (!callbacks.every((callback) => callback === undefined || isFunction(callback))) {
    throw new TypeError(`${signature} requires onLockWait, onFileStart and onFileFinish to be functions`);
  }
}

function createJob(options, signature) {
  const {
    type = MIGRATION_TYPE.MIGRATION,
    names,
    namesExclude = [],
    isDryRun = false,
    directory = MIGRATION_DIRECTORY,
    onLockWait,
    onFileStart,
    onFileFinish,
  } = options;
  const job = {
    type, names, namesExclude, isDryRun, directory, onLockWait, onFileStart, onFileFinish,
  };

  assertOptions(job, signature);

  const db = getDb();
  const { config } = getContext();

  return {
    ...job,
    db,
    driver: db.driver,
    isDev: config.app.isDev,
    lockTimeout: config.db.migrationLockTimeout,
    tableLockTimeout: config.db.migrationTableLockTimeout,
    idleTimeout: config.db.migrationIdleTimeout,
    referencePrefix: config.db.migrationReferencePrefix,
  };
}

async function isDone(action) {
  try {
    await action();

    return true;
  } catch {
    return false;
  }
}

// GET_LOCK answers 1 for the lock, 0 when the time is up and NULL, not an error, when the wait was cut short
// by KILL QUERY: only 1 is the lock.
async function tryLock(query, timeout) {
  const { rows: [lock] } = await query(LOCK_SQL, { prefix: LOCK_PREFIX, timeout });

  return { database: lock.name, isLocked: lock.result === LOCK_GRANTED, isCut: lock.result === null };
}

async function readHolder(query, prefix) {
  const { rows: [{ holder }] } = await query(HOLDER_SQL, { prefix });

  return holder;
}

function describeHolder(holder) {
  return holder === null
    ? ''
    : `, on connection ${holder}: its row in information_schema.processlist tells what it is doing, and KILL ${holder} frees the lock if that migrator is gone`;
}

// A wait that was cut is not told as a migrator that held on for too long: the advice to kill it would be wrong.
async function describeLockFailure(job, query, { database, isCut }) {
  if (isCut) {
    return `The wait for the lock of the database "${database}" was cut short before ${job.lockTimeout} had passed, by KILL QUERY most likely: run the command again`;
  }

  return `Another migrator has held the lock of the database "${database}" for longer than ${job.lockTimeout}${describeHolder(await readHolder(query, LOCK_PREFIX))}`;
}

// "down" does not wait: what there is to roll back is decided by what the other migrator does meanwhile, and
// a run that has waited would roll back a batch its caller has never seen.
async function acquireLock(job, query, isWaiting) {
  const first = await tryLock(query, NO_WAIT);

  if (first.isLocked) {
    return first.database;
  }

  if (!isWaiting) {
    throw new Error(`Another migrator is at work on the database "${first.database}"${describeHolder(await readHolder(query, LOCK_PREFIX))}. A rollback does not wait for it: what there is to roll back changes with what that one does. Look at the status when it has finished, then run the rollback again`);
  }

  await job.onLockWait?.();

  const second = await tryLock(query, convertStringToSeconds(job.lockTimeout));

  if (!second.isLocked) {
    throw new Error(await describeLockFailure(job, query, second));
  }

  return second.database;
}

// The lock and the idle limit stay with the connection when the pool takes it back: one that did not give
// both up is closed.
async function releaseLock(job, connection, query) {
  const isReleased = await isDone(async () => {
    const { rows: [{ result }] } = await query(UNLOCK_SQL, { prefix: LOCK_PREFIX });

    if (result !== LOCK_GRANTED) {
      throw new Error('The lock was not held');
    }

    await query(IDLE_RESET_SQL);
  });

  if (!isReleased) {
    job.driver.destroy(connection);
  }
}

// The lock tells that the session lives, not that its file still runs: a session whose client is gone
// unnoticed keeps the lock, idle, until the server gives up on it.
async function assertNoFileRunning(query) {
  const holder = await readHolder(query, FILE_LOCK_PREFIX);

  if (holder !== null) {
    throw new Error(`A file of another migrator holds the database, on connection ${holder}: that migrator no longer holds the lock (it is gone, or has lost its connection), and the server goes on with the file it was sent. The row of connection ${holder} in information_schema.processlist tells whether the file still runs (Query) or only its session is left (Sleep). Run the command again when the session has ended; KILL ${holder} ends it at once, undoes what the file has not committed and leaves its row dirty`);
  }
}

// What the driver says of a connection that is gone ("Can't add new command when connection is in closed state")
// does not tell which connection it was, and that it was this one decides what is done next.
class LockLostError extends Error {
  constructor(cause) {
    super(`The connection the migrator keeps its lock on was lost (${cause.message}): run the command again`, { cause });
  }
}

// One connection of the pool for the whole run: it holds the lock and writes every row of the table, and never
// runs the text of a file. So a connection that was lost, and the lock with it, fails the next row it is asked
// to write, and the run stops before the next file.
function runLocked(job, fn, { isWaiting = true } = {}) {
  return job.driver.withConnection(async (connection) => {
    async function query(sql, binding) {
      try {
        return await job.driver.execute(connection, job.driver.prepare(sql, binding));
      } catch (error) {
        const dbError = findDbError(error);

        throw dbError?.isFatal
          ? new LockLostError(dbError)
          : error;
      }
    }

    const database = await acquireLock(job, query, isWaiting);

    try {
      await query(IDLE_SQL, { seconds: Math.ceil(convertStringToSeconds(job.idleTimeout)) });
      await assertNoFileRunning(query);

      return await fn({ ...job, database, query });
    } finally {
      await releaseLock(job, connection, query);
    }
  });
}

// Before the first run the table is not there: that reads as nothing applied.
async function readRows(query, sql = ROWS_SQL, binding = {}) {
  try {
    const { rows } = await query(sql, binding);

    return rows.map((row) => rowToCamel(row));
  } catch (error) {
    if (isMissingTable(error)) {
      return [];
    }

    throw error;
  }
}

// The mark of a half-applied file comes first: it stops every run, whatever else is true of the migration.
function readState(migration, row, checksum) {
  if (!row) {
    return MIGRATION_STATE.PENDING;
  }

  if (row.isDirty) {
    return row.isRunning
      ? MIGRATION_STATE.RUNNING
      : MIGRATION_STATE.DIRTY;
  }

  if (!migration.upPath) {
    return MIGRATION_STATE.MISSING;
  }

  return row.checksum === checksum
    ? MIGRATION_STATE.APPLIED
    : MIGRATION_STATE.CHANGED;
}

// "checksum" is what the row holds, "fileChecksum" what the up file gives now.
function toItem(migration, row, file = { sql: null, checksum: null }) {
  return {
    ...migration,
    sql: file.sql,
    fileChecksum: file.checksum,
    checksum: row?.checksum ?? null,
    state: readState(migration, row, file.checksum),
    batch: row?.batch ?? null,
    appliedAt: row?.appliedAt ?? null,
    durationMs: row?.durationMs ?? null,
  };
}

// A row whose file this build does not have: the database is ahead of the build, as after a rollback to an older image.
function toMissingItem(row) {
  const migration = {
    ...pick(row, ['type', 'version', 'name']),
    id: formatMigrationId(row.version, row.name),
    upPath: null,
    downPath: null,
  };

  return toItem(migration, row);
}

// A row and a file are one migration when the version (as a number) and the name are both the same: two branches
// may each have made a migration under one number, and the file of the one is not the row of the other.
function isSameMigration(row, migration) {
  return row.version === migration.version && row.name === migration.name;
}

async function describeMigrations(job, rows) {
  const typeRows = rows.filter((row) => row.type === job.type);
  const migrations = await listMigrations(job);
  const known = await mapSeries(migrations, async (migration) => toItem(
    migration,
    typeRows.find((row) => isSameMigration(row, migration)),
    await readMigrationFile(migration.upPath),
  ));
  const missing = typeRows
    .filter((row) => !migrations.some((migration) => isSameMigration(row, migration)))
    .map((row) => toMissingItem(row));

  return sortBy([...known, ...missing], 'version');
}

function describeRowKey(row) {
  return `type = '${row.type}' AND version = ${row.version}`;
}

// A file corrected after it failed must not come back as "changed", so the UPDATE records the file as it is
// now. After a rollback that failed on a changed file that is not what the database holds, and it is said.
function describeChecksumNote(dirty, checksum) {
  return checksum === dirty.checksum
    ? ''
    : `. The up file is not the text the row was marked with: the UPDATE records the file as it is now; without "checksum" in it the row keeps the text it has, and the ${dirty.type} reads as changed`;
}

// A file that failed, or whose run was cut short, has left its row marked: what it applied is not known, so
// nothing runs until a person has looked, a seed included. The row does not tell whether an up or a down file
// marked it, so both recipes speak of what the up file makes.
async function assertClean(job, rows) {
  const dirty = rows.find((row) => row.isDirty);

  if (!dirty) {
    return false;
  }

  const id = formatMigrationId(dirty.version, dirty.name);
  const key = describeRowKey(dirty);
  const migrations = await listMigrations({ directory: job.directory, type: dirty.type });
  const migration = migrations.find((item) => isSameMigration(dirty, item));
  const checksum = migration
    ? (await readMigrationFile(migration.upPath)).checksum
    : dirty.checksum;

  throw new Error(`The ${dirty.type} ${id} is dirty: a run of its up or its down file failed or was cut short after its row was marked, and how much the database holds of what ${id}.up.sql makes is not known. Look at the database, then say which it is. It holds nothing of that (the up file left nothing, or the rollback is complete): DELETE FROM ${TABLE} WHERE ${key}. It holds all of it (the up file is complete, or the rollback changed nothing): UPDATE ${TABLE} SET is_dirty = 0, checksum = '${checksum}' WHERE ${key}${describeChecksumNote(dirty, checksum)}`);
}

function assertUnchanged(items) {
  const changed = items.find((item) => item.state === MIGRATION_STATE.CHANGED);

  if (changed) {
    throw new Error(`The ${changed.type} ${changed.id} was changed after it was applied: its row holds the checksum ${changed.checksum}, its up file gives ${changed.fileChecksum}. An applied file is not edited, its comments included: restore it. If the database already holds what the file now says, record the new text: UPDATE ${TABLE} SET checksum = '${changed.fileChecksum}' WHERE ${describeRowKey(changed)}. A ${changed.type} that is still being written is rolled back with "down" before its file is changed`);
  }
}

// A file that is not applied must not share its number or its name with a row that has no file. Under one
// number two branches have each made a migration: the row would be rolled back with the down file of the other.
// Under one name the file got another number after a database took it: it would be applied twice.
function assertIdentity(items) {
  const orphans = items.filter((item) => !item.upPath);
  const unapplied = items.filter((item) => item.upPath && item.batch === null);
  const taken = unapplied.find((item) => orphans.some((orphan) => orphan.version === item.version));
  const renumbered = unapplied.find((item) => orphans.some((orphan) => orphan.name === item.name));

  if (taken) {
    const orphan = orphans.find((item) => item.version === taken.version);

    throw new Error(`Version ${taken.version} is applied to this database as the ${taken.type} ${orphan.id}, and this build has ${taken.id} under it: two ${taken.type}s took one number, or the file was renamed after it was applied. Give another number to the one that is not applied, or give the file its name back`);
  }

  if (renumbered) {
    const orphan = orphans.find((item) => item.name === renumbered.name);

    throw new Error(`The ${renumbered.type} ${renumbered.name} is applied to this database as version ${orphan.version}, and this build numbers it ${renumbered.version}: it got another number after this database took it. Give it its number back, or roll it back with the build that applied it`);
  }
}

function assertKnownNames(job, items) {
  const unknown = [...job.names ?? [], ...job.namesExclude].find((name) => !items.some((item) => item.name === name));

  if (unknown !== undefined) {
    throw new Error(`No ${job.type} is named "${unknown}": a name is given without its version, as it stands after the number in the name of the file`);
  }
}

function filterByNames(job, items) {
  return items.filter((item) => (!job.names || job.names.includes(item.name)) && !job.namesExclude.includes(item.name));
}

function describeFailure(step, error) {
  const dbError = findDbError(error);
  const place = dbError?.statementNumber
    ? `statement ${dbError.statementNumber} failed`
    : 'failed';
  const text = isLockWaitTimeout(dbError)
    ? `${dbError.message}: another session holds what the statement waited for, an open transaction on its table most likely`
    : dbError?.message ?? error.message;

  return `${step.fileName}: ${place}: ${text}`;
}

function toRowChangedError(mark) {
  return new Error(`The row of ${formatMigrationId(mark.binding.version, mark.binding.name)} in ${TABLE} is not what the migrator left: it was changed while the migrator worked`);
}

// A write to the table that must find its row. The statement and its values are kept apart from the connection,
// so that the same write can be made through another one, or printed for a person to make.
async function writeMark(query, mark) {
  const { affectedRows } = await query(mark.sql, mark.binding);

  if (affectedRows !== ONE_ROW) {
    throw toRowChangedError(mark);
  }
}

function describeMark(run, mark) {
  return run.driver.prepare(mark.sql, mark.binding).text;
}

function isRowClean(row) {
  return Boolean(row) && !row.isDirty;
}

function isRowAbsent(row) {
  return !row;
}

// A write the lost connection could not make, made through a connection of its own. The first try may have
// reached the table with only its answer lost, so what counts is the row as it stands afterwards. The session
// of the file still holds its lock at this point: no other migrator is at work on the row.
function writeAlone(run, mark) {
  return run.driver.withScript({ database: run.database }, async (script) => {
    await script.query(mark.sql, mark.binding);

    const { rows: [row] } = await script.query(ROW_STATE_SQL, mark.binding);

    if (!mark.isSettled(row && rowToCamel(row))) {
      throw toRowChangedError(mark);
    }
  });
}

// A first statement that gave up on a lock has changed nothing when it is one statement that defines something;
// a block or a call in its place may have done a part of its work before it waited.
function hasOnlyWaited(step, dbError) {
  return dbError?.statementNumber === FIRST_STATEMENT && isLockConflict(dbError) && startsWithDefinition(step.sql);
}

// The driver proves a whole rollback, or the file has not begun at all.
function isNothingApplied(step, error) {
  const dbError = findDbError(error);

  return Boolean(dbError?.isRolledBack) || hasOnlyWaited(step, dbError);
}

async function takeMarkBack(run, step) {
  try {
    await writeMark(run.query, step.unmark);

    return true;
  } catch (error) {
    return error instanceof LockLostError && isDone(() => writeAlone(run, step.unmark));
  }
}

// A file that has left nothing behind leaves no mark either: there is nothing for a person to look at.
async function toFileError(run, step, error) {
  const failure = describeFailure(step, error);

  if (!isNothingApplied(step, error)) {
    return new Error(step.mark ? `${failure}; the ${run.type} is left dirty` : failure, { cause: error });
  }

  if (!step.unmark || await takeMarkBack(run, step)) {
    return new Error(`${failure}; nothing of the file was applied`, { cause: error });
  }

  return new Error(`${failure}; nothing of the file was applied, but its mark could not be taken back. Take it back by hand: ${describeMark(run, step.unmark)}`, { cause: error });
}

// Only the migrator knows that the file is complete: the refusal of the next run would call it "not known".
function describeUnrecorded(run, step, close, reason) {
  return `${step.fileName} has run to its end, but that could not be recorded: ${reason}. Record it by hand: ${describeMark(run, close)}`;
}

// The file has run to its end and its row could not be closed. When the connection that holds the lock is
// lost, the row is closed through a connection of its own: with files left the run stops there, the lock
// being gone, and after the last file it is done. A row changed by hand keeps the words about that.
async function closeAlone(run, step, close, error) {
  if (!(error instanceof LockLostError)) {
    const dbError = findDbError(error);

    return dbError
      ? new Error(describeUnrecorded(run, step, close, `${dbError.message}; the row is left dirty`), { cause: error })
      : error;
  }

  try {
    await writeAlone(run, close);
  } catch (failure) {
    return findDbError(failure)
      ? new Error(describeUnrecorded(run, step, close, 'the connection that held the lock was lost while it ran, and the row is left dirty'), { cause: error })
      : failure;
  }

  return step.isLast
    ? null
    : new Error(`${step.fileName} has run to its end and is recorded, but the connection that held the lock was lost while it ran: nothing after it was run. Run the command again`, { cause: error });
}

async function closeMark(run, step, durationMs) {
  const close = step.close(durationMs);

  try {
    await writeMark(run.query, close);
  } catch (error) {
    const failure = await closeAlone(run, step, close, error);

    if (failure) {
      throw failure;
    }
  }
}

// A file of the live database runs under the second lock; one that builds the reference of "verify" does not.
async function openFileSession(run, script, step) {
  const seconds = Math.max(TABLE_LOCK_SECONDS_MIN, Math.ceil(convertStringToSeconds(run.tableLockTimeout)));

  await script.query(FILE_SESSION_SQL, { seconds });

  if (step.database) {
    return false;
  }

  const { rows: [{ result }] } = await script.query(LOCK_SQL, { prefix: FILE_LOCK_PREFIX, timeout: NO_WAIT });

  if (result !== LOCK_GRANTED) {
    throw new Error(`${step.fileName} was not run: another session holds the lock of a running file of this database`);
  }

  return true;
}

async function runText(run, script, step) {
  const startedAt = performance.now();

  try {
    await script.run(step.sql);
  } catch (error) {
    throw await toFileError(run, step, error);
  }

  return Math.round(performance.now() - startedAt);
}

// The mark may have reached the table before the connection was lost; the file has not been sent either way.
async function markFile(run, step) {
  try {
    await writeMark(run.query, step.mark);
  } catch (error) {
    if (!(error instanceof LockLostError)) {
      throw error;
    }

    throw new Error(`${step.fileName} was not run: the connection the migrator keeps its lock on was lost before the file was sent. Run the command again; should it call the ${run.type} dirty, the mark is all that was written, and this takes it back: ${describeMark(run, step.unmark)}`, { cause: error });
  }
}

async function runSteps(run, script, step) {
  await run.onFileStart?.(step.fileName);

  if (step.mark) {
    await markFile(run, step);
  }

  const durationMs = await runText(run, script, step);

  if (step.close) {
    await closeMark(run, step, durationMs);
  }

  await run.onFileFinish?.(step.fileName, durationMs);
}

// The row is marked before the file is sent and closed after it: whatever ends the run in between leaves the
// mark, because how much of the file the server has applied cannot be told then. The connection is opened
// before the mark, so a file that could not even get a connection leaves none.
async function runFile(run, step) {
  await run.driver.withScript({ database: step.database ?? run.database }, async (script) => {
    const isLocked = await openFileSession(run, script, step);

    try {
      await runSteps(run, script, step);
    } finally {
      // Given back here, not left to the end of the session: the server drops a closed session a moment
      // later, and the next file would find the lock still held.
      if (isLocked) {
        await isDone(() => script.query(UNLOCK_SQL, { prefix: FILE_LOCK_PREFIX }));
      }
    }
  });
}

function toResult(job, paths, details = {}) {
  return { files: paths.map((path) => nodePath.basename(path)), isDryRun: job.isDryRun, ...details };
}

// One count for both types: a seed applied after a migration has a higher batch than it.
function readLastBatch(rows) {
  return rows.reduce((last, row) => Math.max(last, row.batch), NO_BATCH);
}

function listAhead(items) {
  return items.filter((item) => item.state === MIGRATION_STATE.MISSING).map((item) => item.id);
}

// A build that has lost its files (an image made without the folder) would otherwise say "nothing to do".
function assertBuildHasFiles(job, items) {
  if (items.length && items.every((item) => !item.upPath)) {
    throw new Error(`This build has no ${job.type} file in ${resolveMigrationDirectory(job.directory, job.type)}, and the database holds ${items.length} applied: the build has lost its ${job.type}s`);
  }
}

// Everything is checked before the first file runs: a name that is not there, a changed or an empty file
// further down the list must not stop the run halfway.
async function planUp(run) {
  const rows = await readRows(run.query);

  await assertClean(run, rows);

  const items = await describeMigrations(run, rows);

  assertBuildHasFiles(run, items);
  assertIdentity(items);
  assertKnownNames(run, items);
  assertUnchanged(items);

  const pending = filterByNames(run, items.filter((item) => item.state === MIGRATION_STATE.PENDING));

  pending.forEach((item) => assertRunnable({ path: item.upPath, sql: item.sql, database: run.database }));

  return { pending, batch: readLastBatch(rows) + 1, ahead: listAhead(items) };
}

function applyUp(run, item, { batch, isLast }) {
  const row = pick(item, ['version', 'name', 'type']);

  return runFile(run, {
    fileName: nodePath.basename(item.upPath),
    sql: item.sql,
    isLast,
    mark: { sql: MARK_UP_SQL, binding: { ...row, checksum: item.fileChecksum, batch } },
    close: (durationMs) => ({ sql: CLOSE_UP_SQL, binding: { ...row, durationMs }, isSettled: isRowClean }),
    unmark: { sql: UNMARK_UP_SQL, binding: row, isSettled: isRowAbsent },
  });
}

// The table of the migrator is made with the first file to record: a run that was refused, or had nothing to do,
// writes nothing at all.
async function runUp(run) {
  const { pending, batch, ahead } = await planUp(run);

  if (!run.isDryRun && pending.length) {
    await run.query(TABLE_SQL);
    await mapSeries(pending, (item, index) => applyUp(run, item, { batch, isLast: index === pending.length - 1 }));
  }

  return toResult(run, pending.map((item) => item.upPath), { ahead });
}

// A file whose version is lower than an applied one runs too, and a row the build has no file for is passed
// over and named in "ahead": the database may be ahead of the build. A dry run reads under the lock as well:
// without it, a file another migrator is running would read as one that failed.
export async function migrateUp({
  type, names, namesExclude, isDryRun, directory, onLockWait, onFileStart, onFileFinish,
} = {}) {
  const job = createJob({
    type, names, namesExclude, isDryRun, directory, onLockWait, onFileStart, onFileFinish,
  }, 'migrateUp(options)');

  return runLocked(job, (run) => runUp(run));
}

async function readDown(run, item) {
  if (!item.downPath) {
    throw new Error(item.upPath
      ? `The ${item.type} ${item.id} has no down file`
      : `The ${item.type} ${item.id} cannot be rolled back here: a newer build applied it and this one has no file of it. Roll it back with that build`);
  }

  const { sql } = await readMigrationFile(item.downPath);

  assertRunnable({ path: item.downPath, sql, database: run.database });

  return { ...item, downSql: sql };
}

// A seed that was applied after a migration fills the tables of it: rolled back first, the migration would
// leave the seed recorded as applied with its rows gone, and the next "up" of the seeds would do nothing.
function assertNoSeedAbove(run, rows, selected) {
  const lowestBatch = Math.min(...selected.map((item) => item.batch));
  const seed = rows.find((row) => row.type === MIGRATION_TYPE.SEED && row.batch > lowestBatch);

  if (run.type === MIGRATION_TYPE.MIGRATION && seed) {
    throw new Error(`The seed ${formatMigrationId(seed.version, seed.name)} was applied after the migrations to roll back: roll the seeds back first ("down" of the type seed)`);
  }
}

// Without names: what the last batch of the type applied. With names: those migrations, whatever batch applied
// them, in the reverse of the order the database recorded: a lower version may have been applied after a higher
// one it depends on. A changed file does not stand in the way: a migration under work is rolled back to be changed.
async function planDown(run) {
  const rows = await readRows(run.query);

  await assertClean(run, rows);

  const items = await describeMigrations(run, rows);

  assertIdentity(items);
  assertKnownNames(run, items);

  const applied = items.filter((item) => item.batch !== null);
  const lastBatch = readLastBatch(applied);
  const named = filterByNames(run, applied.filter((item) => run.names || item.batch === lastBatch));
  const selected = sortBy(named, 'batch').toReversed();

  assertNoSeedAbove(run, rows, selected);

  return mapSeries(selected, (item) => readDown(run, item));
}

function applyDown(run, item, isLast) {
  const row = pick(item, ['version', 'name', 'type']);

  return runFile(run, {
    fileName: nodePath.basename(item.downPath),
    sql: item.downSql,
    isLast,
    mark: { sql: MARK_DOWN_SQL, binding: row },
    close: () => ({ sql: CLOSE_DOWN_SQL, binding: row, isSettled: isRowAbsent }),
    unmark: { sql: UNMARK_DOWN_SQL, binding: row, isSettled: isRowClean },
  });
}

async function runDown(run) {
  const selected = await planDown(run);

  if (!run.isDryRun) {
    await mapSeries(selected, (item, index) => applyDown(run, item, index === selected.length - 1));
  }

  return toResult(run, selected.map((item) => item.downPath));
}

export async function migrateDown({
  type, names, namesExclude, isDryRun, directory, onLockWait, onFileStart, onFileFinish,
} = {}) {
  const job = createJob({
    type, names, namesExclude, isDryRun, directory, onLockWait, onFileStart, onFileFinish,
  }, 'migrateDown(options)');

  return runLocked(job, (run) => runDown(run), { isWaiting: false });
}

function buildCreateDatabase(run, name, defaults) {
  return run.driver.prepare(`CREATE DATABASE ${name} CHARACTER SET :charset COLLATE :collation COMMENT :comment`, defaults).text;
}

// Dropped and created anew, with the defaults it had: that also takes what no list of tables names (routines,
// events). The session that drops a database loses it as its default, so the script ends by entering it again;
// every other session, this run's own and a running app's, keeps its default and finds the new database under it.
async function recreateDatabase(run) {
  const name = run.driver.escapeName(run.database);
  const create = buildCreateDatabase(run, name, await readDatabaseDefaults(run.database, { query: run.query }));
  const step = {
    fileName: `DROP DATABASE ${name}`,
    sql: ['SET FOREIGN_KEY_CHECKS = 0', `DROP DATABASE ${name}`, create, `USE ${name}`].join(';\n'),
  };

  try {
    await runFile(run, step);
  } catch (error) {
    throw new Error(`${error.message}. If the database is gone, put it back: ${create}`, { cause: error });
  }
}

// What a dry run of "fresh" reads in place of the table: after the drop there is no row.
function readNothing() {
  return { rows: [] };
}

// Everything the database holds is gone after this, so it runs in dev mode only. The files are checked before
// anything is dropped. Seeds are not applied.
export async function migrateFresh({
  isDryRun, directory, onLockWait, onFileStart, onFileFinish,
} = {}) {
  const job = createJob({
    isDryRun, directory, onLockWait, onFileStart, onFileFinish,
  }, 'migrateFresh(options)');
  const { database } = job.driver;

  if (!job.isDev) {
    throw new Error(`"fresh" drops the database "${database}" with everything in it: it runs only when APP_MODE=dev`);
  }

  const { pending } = await planUp({ ...job, database, query: readNothing });

  if (job.isDryRun) {
    return toResult(job, pending.map((item) => item.upPath), { database });
  }

  return runLocked(job, async (run) => {
    await recreateDatabase(run);

    const { files } = await runUp(run);

    return { files, isDryRun: false, database: run.database };
  });
}

// Never throws for what it shows and waits for nobody: a dirty or a changed migration is a state here, not
// a refusal, and the file a migrator is running at this moment is told apart from one that failed.
export async function getMigrationStatus({ type, directory } = {}) {
  const job = createJob({ type, directory }, 'getMigrationStatus(options)');
  const rows = await readRows(job.db.query, STATUS_SQL, { prefix: FILE_LOCK_PREFIX });
  const items = await describeMigrations(job, rows);

  return items.map((item) => pick(item, STATUS_FIELDS));
}

async function createReference(run, reference) {
  const defaults = await readDatabaseDefaults(run.database, { query: run.query });

  try {
    await run.query(buildCreateDatabase(run, run.driver.quoteName(reference), { ...defaults, comment: '' }));
  } catch (error) {
    if (!isDatabaseAccessDenied(error)) {
      throw error;
    }

    throw new Error(`"verify" builds a database of its own beside the live one, and this account may not create it. Give it the right: GRANT ALL PRIVILEGES ON \`${run.referencePrefix.replaceAll('_', '\\_')}%\`.* TO the account`, { cause: error });
  }
}

// Through the connection of the run, and through one of its own when that one is lost. A reference that stays
// behind is told by a line of the result: it must not pass for a clean run.
async function dropReference(run, reference) {
  const sql = `DROP DATABASE IF EXISTS ${run.driver.quoteName(reference)}`;
  const isDropped = await isDone(() => run.query(sql))
    || await isDone(() => run.driver.withScript({ database: run.database }, (script) => script.query(sql)));

  return isDropped
    ? []
    : [`the database ${reference} that "verify" has built could not be dropped: drop it by hand`];
}

// In the order the database recorded: a batch after a batch, the versions of one batch in their order. Built
// in the order of the versions alone, a file that was applied late would put its columns elsewhere than the
// live table has them.
async function buildReference(run, applied, reference) {
  try {
    await mapSeries(applied, (item) => runFile(run, {
      fileName: nodePath.basename(item.upPath),
      sql: item.sql,
      database: reference,
    }));
  } catch (error) {
    throw new Error(`While building the reference database: ${error.message}`, { cause: error });
  }
}

async function compareWithReference(run, applied, reference) {
  await buildReference(run, applied, reference);

  const options = { query: run.query, except: [TABLE] };
  const live = await readStructure(run.database, options);
  const built = await readStructure(reference, options);

  return {
    database: run.database,
    tableCount: Object.keys(live.tables).length,
    differences: [
      ...compareStructures(live, built),
      ...findDisallowedCollations(built),
      ...findServerNamedConstraints(built),
    ],
  };
}

// The reference goes whether the comparison was made or failed. A failure of the comparison is the error told,
// with a word about a reference that could not be dropped after it.
async function compareAndDrop(run, applied, reference) {
  await createReference(run, reference);

  try {
    const result = await compareWithReference(run, applied, reference);

    return { ...result, differences: [...result.differences, ...await dropReference(run, reference)] };
  } catch (error) {
    const [left] = await dropReference(run, reference);

    throw left
      ? new Error(`${findDbError(error)?.message ?? error.message}; ${left}`, { cause: error })
      : error;
  }
}

const STATE_LINES = Object.freeze({
  [MIGRATION_STATE.DIRTY]: 'is dirty: with no other line here, the tables, columns, indexes, checks and foreign keys of its up file are all there; the rows it writes are not compared',
  [MIGRATION_STATE.CHANGED]: 'was changed after it was applied: the comparison was made with the file as it is now',
});

function describeStates(items) {
  return items
    .filter((item) => Object.hasOwn(STATE_LINES, item.state))
    .map((item) => `the ${item.type} ${item.id} ${STATE_LINES[item.state]}`);
}

function describePending(items) {
  const pending = items.filter((item) => item.state === MIGRATION_STATE.PENDING).map((item) => item.id);

  return pending.length
    ? [`not applied, and so not compared: ${pending.join(', ')}`]
    : [];
}

// What the live database must hold is what its own rows say was applied, built again from the files of this
// build: a migration that is not applied yet takes no part, and a dirty one does, so that the comparison tells
// how much of its file is there.
async function verifyLocked(run) {
  const items = await describeMigrations(run, await readRows(run.query));
  const applied = sortBy(sortBy(items.filter((item) => item.batch !== null), 'version'), 'batch');
  const missing = applied.find((item) => !item.upPath);

  assertIdentity(items);

  if (missing) {
    throw new Error(`The ${missing.type} ${missing.id} is applied, and this build has no file of it: "verify" builds from the files of the build that applied it`);
  }

  applied.forEach((item) => assertRunnable({ path: item.upPath, sql: item.sql, database: run.database }));

  const reference = `${run.referencePrefix}${uuidv7().replaceAll('-', '_')}`;
  const result = await compareAndDrop(run, applied, reference);

  return {
    ...result,
    differences: [...result.differences, ...describeStates(items)],
    notes: describePending(items),
  };
}

// Builds a database on the same server from the files of the migrations the live one has recorded, and
// compares the live one with it: a table altered by hand shows as a difference. The collations the migrations
// give are checked on the way. Every up file runs once more for this, in a database of its own.
export async function verifyMigrations({
  directory, onLockWait, onFileStart, onFileFinish,
} = {}) {
  const job = createJob({
    directory, onLockWait, onFileStart, onFileFinish,
  }, 'verifyMigrations(options)');

  return runLocked(job, (run) => verifyLocked(run));
}

// The migrations this build knows that are not applied, or are half applied: none means the database is ready
// for the build. What the database holds beyond them is not counted. Only the names of the files are read.
export async function findPendingMigrations({ directory = MIGRATION_DIRECTORY } = {}) {
  const db = getDb();
  const migrations = await listMigrations({ directory, type: MIGRATION_TYPE.MIGRATION });
  const rows = await readRows((sql, binding) => db.query(sql, binding, { isTimeLimited: true }));
  const applied = rows.filter((row) => row.type === MIGRATION_TYPE.MIGRATION);
  const settled = applied.filter((row) => !row.isDirty);

  if (!migrations.length && applied.length) {
    throw new Error(`This build has no migration file in ${directory}, and the database holds ${applied.length} applied: the build has lost its migrations`);
  }

  return migrations
    .filter((migration) => !settled.some((row) => isSameMigration(row, migration)))
    .map((migration) => migration.id);
}
