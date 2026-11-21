import { bindSql } from '#core/db/binding.js';
import {
  createOverloadError,
  DbError,
  describeColumn,
  findDbError,
  isIdentifier,
  toDbError,
} from '#core/db/error.js';
import { assertIsolation } from '#core/db/isolation.js';
import {
  isSymbol,
  SYMBOL,
  TOKEN_TYPE,
  tokenizeSql,
} from '#core/db/lexer.js';
import { CHARSET } from '#enums/collation.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ISOLATION_LEVEL } from '#enums/isolation-level.js';
import { pLimit } from '#utils/async.js';
import { convertStringToMs, convertStringToSeconds } from '#utils/date.js';
import { compact } from '#utils/object.js';
import { isArray, isFunction, isNonEmptyString } from '#utils/type.js';
import { createConnection, createPool } from 'mysql2/promise';

const CLIENT_TIME_ZONE = 'Z';
const SESSION_TIME_ZONE = '+00:00';
const MESSAGE_LOCALE = 'en_US';
const UNESCAPED_SQL_MODE = 'NO_BACKSLASH_ESCAPES';
const EMPTY_AS_NULL_SQL_MODE = 'EMPTY_STRING_IS_NULL';

const LOCAL_FILES_OFF_FLAG = '-LOCAL_FILES';

const BOOLEAN_TYPE = 'TINY';
const BOOLEAN_LENGTH = 1;
const BOOLEAN_TRUE = '1';

// On the wire a JSON column of MariaDB is LONGTEXT: only the extended metadata of the field tells it is JSON.
const JSON_FORMAT = 'json';

const MIN_VERSION = Object.freeze({ major: 12, minor: 3 });
const VERSION_REGEXP = /^(\d+)\.(\d+)\.\d+(?:-\d+)?-MariaDB/;
const SQL_MODE_SEPARATOR = ',';
const UNSAFE_SQL_MODES = Object.freeze([UNESCAPED_SQL_MODE, EMPTY_AS_NULL_SQL_MODE, 'ANSI_QUOTES']);

const MULTIPLE_RESULTS_MESSAGE = 'The statement returned several result sets: one statement gives one, a procedure may select once';
const MULTIPLE_RESULTS_CODE = 'MULTIPLE_RESULT_SETS';

const SCRIPT_LEFT_DATABASE_MESSAGE = 'The script changed the database of its session: USE has no place in a script, and what followed it was written elsewhere';
const SCRIPT_LEFT_DATABASE_CODE = 'SCRIPT_LEFT_DATABASE';

const SEVERAL_STATEMENTS_MESSAGE = 'script.query(sql, binding) takes one statement with no semicolon inside it: a compound statement (BEGIN ... END, IF ... END IF) and a text of several are run with script.run(text)';
const SEVERAL_STATEMENTS_CODE = 'SEVERAL_STATEMENTS';

const UNREADABLE_JSON_CODE = 'UNREADABLE_JSON';
const DUPLICATE_COLUMN_CODE = 'DUPLICATE_COLUMN';

const NAME_QUOTE = '`';

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

// QUESTIONS counts every statement the server has started for the session, each statement of a script included.
// BYTES_RECEIVED tells whether that count can be trusted: FLUSH STATUS in a script sets both to zero.
const SCRIPT_STATE_SQL = `
  SELECT
    DATABASE() AS name,
    (SELECT CAST(variable_value AS UNSIGNED) FROM information_schema.session_status WHERE variable_name = 'QUESTIONS') AS questionCount,
    (SELECT CAST(variable_value AS UNSIGNED) FROM information_schema.session_status WHERE variable_name = 'BYTES_RECEIVED') AS receivedByteCount
`;
const BEGIN_SQL = 'START TRANSACTION';
const COMMIT_SQL = 'COMMIT';
const ROLLBACK_SQL = 'ROLLBACK';

// Under the default level a write to a row another session has changed since the transaction first read fails
// the whole transaction (ER_CHECKREAD): a script that runs beside traffic would meet that often. For the
// session, not for one transaction: a script may open transactions of its own.
const SCRIPT_SESSION_SQL = `SET SESSION TRANSACTION ISOLATION LEVEL ${ISOLATION_LEVEL.READ_COMMITTED}`;

const SCRIPT_SAVEPOINT = 'script_start';
const SAVEPOINT_SQL = `SAVEPOINT ${SCRIPT_SAVEPOINT}`;
const UNDO_SQL = `ROLLBACK TO SAVEPOINT ${SCRIPT_SAVEPOINT}`;

// MariaDB keeps as JSON more than JSON.parse reads ("1.", "[1e]", "\d" in a string). Thrown in the row parser of
// mysql2, the error would leave the rest of the result set to a connection with no statement to read it, and the
// connection would be lost. run() fails the statement after its last row; a script drops its rows unread.
function readJson(field, next, onUnreadable) {
  try {
    return next();
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    onUnreadable?.(field.name);

    return null;
  }
}

// field.string() reads NULL as null: compared straight to "1" it would come back as false.
function castField(field, next, onUnreadableJson) {
  if (field.extendedFormat === JSON_FORMAT) {
    return readJson(field, next, onUnreadableJson);
  }

  if (field.type !== BOOLEAN_TYPE || field.length !== BOOLEAN_LENGTH) {
    return next();
  }

  const text = field.string();

  return text === null
    ? null
    : text === BOOLEAN_TRUE;
}

function toConnectionOptions(config) {
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
    connectTimeout: convertStringToMs(config.connectTimeout),
    typeCast: castField,
    // With the capability announced and no stream to read from, mysql2 fails LOAD DATA LOCAL on the client
    // while the server goes on with the rest of a script. Without it the server refuses the statement itself.
    flags: [LOCAL_FILES_OFF_FLAG],
  };
}

// mysql2 never queues: the gate in withConnection() asks for no more connections than the pool has,
// so who waits and how many is counted here, not read from the insides of the pool.
function toPoolOptions(connectionOptions, config) {
  return {
    ...connectionOptions,
    waitForConnections: false,
    connectionLimit: config.connectionLimit,
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

function createUnreadableJsonError(name) {
  return new DbError(`A row of the result cannot be read: ${describeColumn(name)} holds a text the server takes for JSON and JSON.parse refuses`, {
    code: UNREADABLE_JSON_CODE,
    isExecuted: true,
  });
}

function createDuplicateColumnError(name) {
  return new DbError(`A row keeps one value for a name, and ${describeColumn(name)} comes twice in the result: give each column a name of its own with an alias`, {
    code: DUPLICATE_COLUMN_CODE,
    isExecuted: true,
  });
}

// mysql2 drops a connection it has lost, but not one the server closed after an error of the class 08
// (a packet too large): left in the pool, it would fail the statement of the next caller.
async function run(connection, text) {
  let unreadableColumn = null;
  let result;

  function markUnreadable(name) {
    unreadableColumn ??= name;
  }

  try {
    result = await connection.query({ sql: text, typeCast: (field, next) => castField(field, next, markUnreadable) });
  } catch (error) {
    const dbError = toDbError(error);

    if (findDbError(dbError)?.isFatal) {
      connection.destroy();
    }

    throw dbError;
  }

  if (unreadableColumn !== null) {
    throw createUnreadableJsonError(unreadableColumn);
  }

  return result;
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
// mysql2 keeps one value for two columns of one name while "fields" lists both. The statement has run by then:
// a write with RETURNING outside a transaction stays.
function toRowsResult(rows, fields) {
  const names = fields.map((field) => field.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);

  if (repeated !== undefined) {
    throw createDuplicateColumnError(repeated);
  }

  return { rows, affectedRows: rows.length, fields: names.map((name) => ({ name })) };
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
    throw new DbError(MULTIPLE_RESULTS_MESSAGE, { code: MULTIPLE_RESULTS_CODE, isExecuted: true });
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

async function checkServer(state, connection) {
  const { rows: [server] } = await execute(state, connection, { text: SERVER_SQL });

  assertServer(server);

  return server.version;
}

function verify(state) {
  return withConnection(state, (connection) => checkServer(state, connection));
}

// The 503 a busy server is answered with belongs to a request: what runs a script is told the error itself.
async function connectAlone(options) {
  try {
    return await createConnection(options);
  } catch (error) {
    throw findDbError(toDbError(error));
  }
}

// A connection outside the pool, with its options and its session, and the server checked the same way.
// end() never rejects, also on a connection that is lost.
async function openScriptConnection(state, database) {
  const connection = await connectAlone({ ...state.connectionOptions, database, multipleStatements: true });

  // A session the server drops while it stands idle is told by an "error" event, which ends the process when
  // nobody listens. mysql2 takes the first one by a listener it happens to leave behind: this does not rely on it.
  connection.on('error', () => {});

  await initSession(connection);

  try {
    await run(connection, SCRIPT_SESSION_SQL);
    await checkServer(state, connection);
  } catch (error) {
    await connection.end();

    throw error;
  }

  return connection;
}

async function readScriptState(state, connection) {
  const { rows: [scriptState] } = await execute(state, connection, { text: SCRIPT_STATE_SQL });

  return scriptState;
}

// The server answers a failed script with the error of one statement and no word about which one it was:
// the statements it has started since the script began tell the number. A script that has reset the status of
// its session shows fewer bytes received than the script alone holds: no number is told then, not a wrong one.
async function readFailedStatement(state, connection, { start, text }) {
  try {
    const { questionCount, receivedByteCount } = await readScriptState(state, connection);
    const isReset = Number(receivedByteCount) < Number(start.receivedByteCount) + Buffer.byteLength(text);

    return isReset
      ? null
      : Number(questionCount) - Number(start.questionCount) - 1;
  } catch {
    return null;
  }
}

// The savepoint is still there only when nothing has ended the transaction since the script began: no DDL and
// no COMMIT of its own. Going back to it then undoes every write of the script, and the answer is the proof;
// a warning tells of a table that takes no part in transactions and has kept its rows.
async function undoScript(connection) {
  try {
    const [header] = await run(connection, UNDO_SQL);

    return header.warningStatus === 0;
  } catch {
    return false;
  }
}

// The raw error, whose "sql" is the whole script, goes no further than this.
async function toScriptError(state, connection, error, script) {
  const dbError = findDbError(toDbError(error, { isScript: true }));

  if (dbError.isFatal) {
    connection.destroy();

    return dbError;
  }

  const statementNumber = await readFailedStatement(state, connection, script);
  const isRolledBack = await undoScript(connection) || null;

  return Object.assign(dbError, compact({ statementNumber, isRolledBack }));
}

// One transaction around the script: a file of plain writes is applied whole or not at all, and is not committed
// row by row. DDL commits on its own, and so may the script: the COMMIT at the end then has nothing to do.
async function runScript(state, session, text) {
  if (!isNonEmptyString(text)) {
    throw new TypeError('script.run(text) requires the text of the script');
  }

  if (session.isRun) {
    throw new TypeError('script.run(text) runs one script on its connection: the next one needs a connection of its own');
  }

  const { connection } = session;

  session.isRun = true;
  await run(connection, BEGIN_SQL);
  await run(connection, SAVEPOINT_SQL);

  const start = await readScriptState(state, connection);

  try {
    await connection.query(text);
  } catch (error) {
    throw await toScriptError(state, connection, error, { start, text });
  }

  await run(connection, COMMIT_SQL);

  if ((await readScriptState(state, connection)).name !== start.name) {
    throw new DbError(SCRIPT_LEFT_DATABASE_MESSAGE, { code: SCRIPT_LEFT_DATABASE_CODE });
  }
}

// The connection of a script takes a text of several statements, and the result of "query" is read as
// the result of one: the second statement would run and its outcome be lost. The text is cut at its
// semicolon, after which only comments may stand: the server answers a comment there as one more statement.
function readOneStatement(sql) {
  const tokens = tokenizeSql(sql);
  const end = tokens.findIndex((token) => isSymbol(token, SYMBOL.SEMICOLON));

  if (end === -1) {
    return sql;
  }

  if (tokens.slice(end + 1).some((token) => token.type !== TOKEN_TYPE.COMMENT && !isSymbol(token, SYMBOL.SEMICOLON))) {
    throw new DbError(SEVERAL_STATEMENTS_MESSAGE, { code: SEVERAL_STATEMENTS_CODE });
  }

  return sql.slice(0, tokens[end].start);
}

// As in connectAlone(): the 503 belongs to a request, what runs a script is told the error itself.
async function queryScript(state, session, sql, binding) {
  const prepared = prepare(state, readOneStatement(sql), binding);

  try {
    return await execute(state, session.connection, prepared);
  } catch (error) {
    throw findDbError(error) ?? error;
  }
}

// For a text of several statements, which the pool refuses: a connection of its own, open while fn runs.
// One script per connection: a script leaves what it has set in its session (the checks of foreign keys, the
// sql_mode, variables). The database is named by the caller every time: a script must never land in one by default.
async function withScript(state, options, fn) {
  const database = options?.database;

  if (!isNonEmptyString(database) || !isFunction(fn)) {
    throw new TypeError('withScript({ database }, fn) requires the name of a database and a function');
  }

  const session = { connection: await openScriptConnection(state, database), isRun: false };

  try {
    return await fn(Object.freeze({
      query: queryScript.bind(null, state, session),
      run: runScript.bind(null, state, session),
    }));
  } finally {
    await session.connection.end();
  }
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
  if (!isIdentifier(name)) {
    throw new TypeError('A name of a table or a column must be 1 to 64 letters, digits and underscores and must not start with a digit');
  }

  return `\`${name}\``;
}

// A name the server or the config gave, such as the name of the database: any character may stand in it,
// so it is escaped, not checked.
function escapeName(name) {
  if (!isNonEmptyString(name)) {
    throw new TypeError('escapeName(name) requires a name');
  }

  return `${NAME_QUOTE}${name.replaceAll(NAME_QUOTE, `${NAME_QUOTE}${NAME_QUOTE}`)}${NAME_QUOTE}`;
}

function buildUpsertClause(quotedColumns) {
  return `ON DUPLICATE KEY UPDATE ${quotedColumns.map((column) => `${column} = VALUES(${column})`).join(', ')}`;
}

export function createMariadbDriver(config) {
  const connectionOptions = toConnectionOptions(config);
  const pool = createPool(toPoolOptions(connectionOptions, config));
  const state = {
    pool,
    connectionOptions,
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
    database: config.database,
    withScript: withScript.bind(null, state),
    verify: verify.bind(null, state),
    ping: ping.bind(null, state),
    close: close.bind(null, state),
    getStats: getStats.bind(null, state),
    begin,
    commit,
    rollback,
    destroy,
    quoteName,
    escapeName,
    buildUpsertClause,
  });
}
