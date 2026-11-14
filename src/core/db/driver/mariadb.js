import { bindSql } from '#core/db/binding.js';
import {
  createOverloadError,
  DbError,
  findDbError,
  toDbError,
} from '#core/db/error.js';
import { assertIsolation } from '#core/db/isolation.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { pLimit } from '#utils/async.js';
import { convertStringToMs, convertStringToSeconds } from '#utils/date.js';
import { isArray, isFunction, isString } from '#utils/type.js';
import { createPool } from 'mysql2/promise';

const CHARSET = 'utf8mb4';
const CLIENT_TIME_ZONE = 'Z';
const SESSION_TIME_ZONE = '+00:00';
const MESSAGE_LOCALE = 'en_US';
const UNESCAPED_SQL_MODE = 'NO_BACKSLASH_ESCAPES';
const EMPTY_AS_NULL_SQL_MODE = 'EMPTY_STRING_IS_NULL';

const BOOLEAN_TYPE = 'TINY';
const BOOLEAN_LENGTH = 1;
const BOOLEAN_TRUE = '1';

const MIN_VERSION = Object.freeze({ major: 12, minor: 3 });
const VERSION_REGEXP = /^(\d+)\.(\d+)\.\d+(?:-\d+)?-MariaDB/;
const SQL_MODE_SEPARATOR = ',';
const UNSAFE_SQL_MODES = Object.freeze([UNESCAPED_SQL_MODE, EMPTY_AS_NULL_SQL_MODE, 'ANSI_QUOTES']);

const MULTIPLE_RESULTS_MESSAGE = 'The statement returned several result sets: one statement gives one, a procedure may select once';
const MULTIPLE_RESULTS_CODE = 'MULTIPLE_RESULT_SETS';

const NAME_REGEXP = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// A comma takes the place of a mode, not an empty string: under EMPTY_STRING_IS_NULL an empty literal is NULL
// and would wipe the whole sql_mode, strict mode included. That mode goes out too: it reads a bound '' as NULL.
const SQL_MODE_SQL = `sql_mode = REPLACE(REPLACE(@@sql_mode, '${UNESCAPED_SQL_MODE}', ','), '${EMPTY_AS_NULL_SQL_MODE}', ',')`;

// What every session is set to before its first statement, whatever the server gave it. The values are escaped
// on the client for this charset and with backslashes, the text of an error is read in English, and an aggregate
// (GROUP_CONCAT, JSON_ARRAYAGG) longer than group_concat_max_len is cut without an error.
export const SESSION_SQL = [
  `SET NAMES ${CHARSET}`,
  `time_zone = '${SESSION_TIME_ZONE}'`,
  SQL_MODE_SQL,
  'autocommit = 1',
  `lc_messages = '${MESSAGE_LOCALE}'`,
  'group_concat_max_len = @@max_allowed_packet',
].join(', ');

// The connections of the pools that have their session set: a wrapper of the pool is new on every hand-out,
// the connection under it is the same.
const sessions = new WeakSet();

const SERVER_SQL = 'SELECT VERSION() AS version, @@session.time_zone AS timeZone, @@session.sql_mode AS sqlMode';
const PING_SQL = 'SELECT 1';
const BEGIN_SQL = 'START TRANSACTION';
const COMMIT_SQL = 'COMMIT';
const ROLLBACK_SQL = 'ROLLBACK';

// field.string() reads NULL as null: compared straight to "1" it would come back as false.
function castField(field, next) {
  if (field.type !== BOOLEAN_TYPE || field.length !== BOOLEAN_LENGTH) {
    return next();
  }

  const text = field.string();

  return text === null
    ? null
    : text === BOOLEAN_TRUE;
}

// mysql2 never queues: the gate in withConnection() asks for no more connections than the pool has,
// so who waits and how many is counted here, not read from the insides of the pool.
function toPoolOptions(config) {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: CHARSET,
    timezone: CLIENT_TIME_ZONE,
    dateStrings: false,
    decimalNumbers: true,
    supportBigNumbers: true,
    namedPlaceholders: false,
    multipleStatements: false,
    waitForConnections: false,
    connectionLimit: config.connectionLimit,
    connectTimeout: convertStringToMs(config.connectTimeout),
    typeCast: castField,
  };
}

function isSupportedVersion(version) {
  const [, major, minor] = VERSION_REGEXP.exec(String(version)) ?? [];

  return Number(major) > MIN_VERSION.major
    || (Number(major) === MIN_VERSION.major && Number(minor) >= MIN_VERSION.minor);
}

// Under NO_BACKSLASH_ESCAPES a quote after a backslash ends the literal, under EMPTY_STRING_IS_NULL a bound '' is
// NULL: the session statement takes both out, and this proves it did. ANSI_QUOTES cannot be taken out of a combined
// mode such as ANSI: there a double quote opens a name, and the lexer reads the statement differently from the server.
export function assertServer({ version, timeZone, sqlMode } = {}) {
  if (!isSupportedVersion(version)) {
    throw new Error(`MariaDB ${MIN_VERSION.major}.${MIN_VERSION.minor} or newer is required, the server reports "${version}"`);
  }

  if (timeZone !== SESSION_TIME_ZONE) {
    throw new Error(`The database session must run in UTC, its time_zone is "${timeZone}"`);
  }

  const unsafeMode = String(sqlMode)
    .split(SQL_MODE_SEPARATOR)
    .find((mode) => UNSAFE_SQL_MODES.includes(mode));

  if (unsafeMode) {
    throw new Error(`The sql_mode ${unsafeMode} is not supported: remove it from the sql_mode of the server`);
  }
}

// Sent to a connection once, before it is handed out for the first time. A session that could not be set
// is closed, and what the server answered is the error of the caller that asked for the connection.
export async function initSession(connection) {
  if (sessions.has(connection.connection)) {
    return false;
  }

  try {
    await connection.query(SESSION_SQL);
  } catch (error) {
    connection.destroy();

    throw toDbError(error);
  }

  sessions.add(connection.connection);

  return true;
}

// mysql2 drops a connection it has lost, but not one the server closed after an error of the class 08
// (a packet too large): left in the pool, it would fail the statement of the next caller.
async function run(connection, text) {
  try {
    return await connection.query(text);
  } catch (error) {
    const dbError = toDbError(error);

    if (findDbError(dbError)?.isFatal) {
      connection.destroy();
    }

    throw dbError;
  }
}

async function connect(pool) {
  try {
    return await pool.getConnection();
  } catch (error) {
    throw toDbError(error);
  }
}

async function acquire(pool) {
  const connection = await connect(pool);

  await initSession(connection);

  return connection;
}

async function withConnection(state, fn) {
  if (!isFunction(fn)) {
    throw new TypeError('withConnection(fn) requires a function');
  }

  if (state.gate.activeCount >= state.connectionLimit && state.gate.pendingCount >= state.queueLimit) {
    state.rejectedCount += 1;

    throw createOverloadError();
  }

  return state.gate(async () => {
    const connection = await acquire(state.pool);

    try {
      return await fn(connection);
    } finally {
      connection.release();
    }
  });
}

// The text protocol has no parameters: every value is written into the statement here, escaped, at the place
// the lexer found for it. mysql2 gets a finished text and no values, so its own formatter has nothing to replace.
function prepare(state, sql, binding) {
  return Object.freeze({ text: bindSql(sql, binding, { render: state.escape }).sql });
}

// A statement that returns rows affects as many as it returns: that holds for INSERT ... RETURNING too.
function toRowsResult(rows, fields) {
  return { rows, affectedRows: rows.length, fields: fields.map((field) => ({ name: field.name })) };
}

// CALL of a procedure that selects gives a list of results with a header at its end, and a list of field lists.
// More than one result set is refused, and by then the procedure has run: outside a transaction its writes stay.
function toResult(result, fields) {
  if (!isArray(result)) {
    return { rows: [], affectedRows: result.affectedRows, fields: [] };
  }

  if (!isArray(fields?.[0])) {
    return toRowsResult(result, fields);
  }

  if (isArray(fields[1])) {
    throw new DbError(MULTIPLE_RESULTS_MESSAGE, { code: MULTIPLE_RESULTS_CODE });
  }

  return toRowsResult(result[0], fields[0]);
}

async function execute(state, connection, { text }, { isTimeLimited = false } = {}) {
  try {
    const [result, fields] = await run(connection, isTimeLimited ? `${state.timeLimitPrefix}${text}` : text);

    return toResult(result, fields);
  } catch (error) {
    if (findDbError(error)?.kind === DB_ERROR_KIND.TIMEOUT) {
      state.timeoutCount += 1;
    }

    throw error;
  }
}

// The level holds for the next transaction only, then the session falls back to its default.
async function begin(connection, { isolation } = {}) {
  assertIsolation(isolation, 'begin(connection, { isolation })');

  if (isolation) {
    await run(connection, `SET TRANSACTION ISOLATION LEVEL ${isolation}`);
  }

  await run(connection, BEGIN_SQL);
}

async function commit(connection) {
  await run(connection, COMMIT_SQL);
}

async function rollback(connection) {
  await run(connection, ROLLBACK_SQL);
}

// A connection that may still hold an open transaction must not go back to the pool.
function destroy(connection) {
  connection.destroy();
}

async function verify(state) {
  const { rows: [server] } = await withConnection(state, (connection) => execute(state, connection, { text: SERVER_SQL }));

  assertServer(server);

  return server.version;
}

async function ping(state) {
  await withConnection(state, (connection) => run(connection, PING_SQL));

  return true;
}

async function close(state) {
  if (state.isClosed) {
    return false;
  }

  state.isClosed = true;

  try {
    await state.pool.end();
  } catch (error) {
    throw toDbError(error);
  }

  return true;
}

function getStats(state) {
  return {
    connectionLimit: state.connectionLimit,
    queueLimit: state.queueLimit,
    activeCount: state.gate.activeCount,
    queueLength: state.gate.pendingCount,
    rejectedCount: state.rejectedCount,
    timeoutCount: state.timeoutCount,
  };
}

// A name goes into the statement as text, so it is checked letter by letter: it comes from the code,
// and a key of a request body that got here by mistake must not become SQL.
function quoteName(name) {
  if (!isString(name) || !NAME_REGEXP.test(name)) {
    throw new TypeError('A name of a table or a column must be 1 to 64 letters, digits and underscores and must not start with a digit');
  }

  return `\`${name}\``;
}

function buildUpsertClause(quotedColumns) {
  return `ON DUPLICATE KEY UPDATE ${quotedColumns.map((column) => `${column} = VALUES(${column})`).join(', ')}`;
}

export function createMariadbDriver(config) {
  const pool = createPool(toPoolOptions(config));
  const state = {
    pool,
    gate: pLimit(config.connectionLimit),
    escape: (value) => pool.escape(value),
    connectionLimit: config.connectionLimit,
    queueLimit: config.queueLimit,
    timeLimitPrefix: `SET STATEMENT max_statement_time=${convertStringToSeconds(config.statementTimeout)} FOR `,
    rejectedCount: 0,
    timeoutCount: 0,
    isClosed: false,
  };

  return Object.freeze({
    withConnection: withConnection.bind(null, state),
    prepare: prepare.bind(null, state),
    execute: execute.bind(null, state),
    verify: verify.bind(null, state),
    ping: ping.bind(null, state),
    close: close.bind(null, state),
    getStats: getStats.bind(null, state),
    begin,
    commit,
    rollback,
    destroy,
    quoteName,
    buildUpsertClause,
  });
}
