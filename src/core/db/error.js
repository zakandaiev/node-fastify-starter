import { AppError } from '#core/error/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { compact } from '#utils/object.js';
import { isArray, isNonEmptyString, isString } from '#utils/type.js';

const LINE_BREAK = '\n';
const QUOTE = "'";
const VALUE_MASK = '***';

const DUPLICATE_ENTRY_PREFIX = "Duplicate entry '";
const DUPLICATE_ENTRY_SUFFIX = "' for key ";
const CONSTRAINT_REGEXP = /^'([^']+)'/;

// The words the server puts before a value it repeats, and what it writes on the same line right after
// that value ('' is the end of the line): "Incorrect integer value: '…' for column …", "… syntax to use near '…'
// at line 1" (the tail of the statement, values included), "… value is out of range in '…'".
const VALUE_TAILS = Object.freeze({
  " value: '": ['', ' for column ', ' for function '],
  "syntax to use near '": [' at line '],
  "incorrect time zone: '": [''],
  "out of range in '": [''],
  "to the value of '": [''],
  "character string: '": [''],
  ", record '": [],
});
const STACK_FRAME_REGEXP = /[ \t]+at /y;

// The server cuts its message at this many bytes and pads a cut one to exactly this length.
const MESSAGE_BYTES_MAX = 511;
const OPENING_QUOTE_REGEXP = /(?<![A-Za-z])'/;
const MESSAGE_SEPARATOR = '; ';

const UNKNOWN_ERROR_MESSAGE = 'Database error';
const POOL_SATURATED_MESSAGE = 'The queue of the database pool is full';
export const POOL_SATURATED_CODE = 'POOL_QUEUE_FULL';

const TRANSACTION_TIMEOUT_MESSAGE = 'withTransaction(fn) was closed at its deadline, with nothing committed: fn had not settled, or a statement it had started';
const TRANSACTION_TIMEOUT_CODE = 'TRANSACTION_TIMEOUT';

const IDENTIFIER_REGEXP = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const EXPRESSION_COLUMN = 'a column named by its expression';

// The numbers of the server, not the names the driver gives them.
const ERRNO = Object.freeze({
  CHECKREAD: 1020,
  CON_COUNT: 1040,
  DBACCESS_DENIED: 1044,
  ACCESS_DENIED: 1045,
  BAD_NULL: 1048,
  BAD_DB: 1049,
  NON_UNIQ: 1052,
  BAD_FIELD: 1054,
  DUP_ENTRY: 1062,
  PARSE_ERROR: 1064,
  TABLEACCESS_DENIED: 1142,
  NO_SUCH_TABLE: 1146,
  TOO_MANY_USER_CONNECTIONS: 1203,
  LOCK_WAIT_TIMEOUT: 1205,
  LOCK_DEADLOCK: 1213,
  USER_LIMIT_REACHED: 1226,
  WARN_DATA_OUT_OF_RANGE: 1264,
  WARN_DATA_TRUNCATED: 1265,
  CANT_AGGREGATE_2COLLATIONS: 1267,
  NO_DEFAULT_FOR_FIELD: 1364,
  DATA_TOO_LONG: 1406,
  NO_PARTITION_FOR_GIVEN_VALUE: 1526,
  DUP_ENTRY_WITH_KEY_NAME: 1586,
  STATEMENT_TIMEOUT: 1969,
  CONSTRAINT_FAILED: 4025,
});

// "deadlock" is every lock conflict that ends a transaction which may be run again: the deadlock itself,
// a lock wait that timed out, and a row changed since it was read (innodb_snapshot_isolation).
const KIND_BY_ERRNO = Object.freeze({
  [ERRNO.DUP_ENTRY]: DB_ERROR_KIND.UNIQUE,
  [ERRNO.DUP_ENTRY_WITH_KEY_NAME]: DB_ERROR_KIND.UNIQUE,
  [ERRNO.LOCK_DEADLOCK]: DB_ERROR_KIND.DEADLOCK,
  [ERRNO.LOCK_WAIT_TIMEOUT]: DB_ERROR_KIND.DEADLOCK,
  [ERRNO.CHECKREAD]: DB_ERROR_KIND.DEADLOCK,
  [ERRNO.STATEMENT_TIMEOUT]: DB_ERROR_KIND.TIMEOUT,
  [ERRNO.CON_COUNT]: DB_ERROR_KIND.OVERLOAD,
  [ERRNO.TOO_MANY_USER_CONNECTIONS]: DB_ERROR_KIND.OVERLOAD,
});

// One number answers a limit of connections of an account and its hourly quotas. Only the first is an overload:
// it passes by itself in a moment, while a quota keeps the account out for up to an hour.
const USER_CONNECTIONS_RESOURCE = "'max_user_connections'";

// "Table has no partition for value 380501234567": the one text that repeats a value without quotes.
const UNQUOTED_VALUE_PREFIX = 'no partition for value ';

// What these put in quotes is the name of a column, a table, a database, a user or a resource, never a value.
const NAMING_ERRNOS = Object.freeze([
  ERRNO.CHECKREAD,
  ERRNO.DBACCESS_DENIED,
  ERRNO.ACCESS_DENIED,
  ERRNO.BAD_NULL,
  ERRNO.BAD_DB,
  ERRNO.NON_UNIQ,
  ERRNO.BAD_FIELD,
  ERRNO.TABLEACCESS_DENIED,
  ERRNO.NO_SUCH_TABLE,
  ERRNO.WARN_DATA_OUT_OF_RANGE,
  ERRNO.WARN_DATA_TRUNCATED,
  ERRNO.CANT_AGGREGATE_2COLLATIONS,
  ERRNO.NO_DEFAULT_FOR_FIELD,
  ERRNO.DATA_TOO_LONG,
  ERRNO.USER_LIMIT_REACHED,
  ERRNO.NO_PARTITION_FOR_GIVEN_VALUE,
]);

// mysql2 names an error by the table of MySQL, and from this number on MariaDB has errors of its own:
// its failed CHECK (4025) comes named as a size error of InnoDB, and its statement timeout has no name at all.
const MARIADB_ERRNO_MIN = 1900;
const MARIADB_CODES = Object.freeze({
  [ERRNO.STATEMENT_TIMEOUT]: 'ER_STATEMENT_TIMEOUT',
  [ERRNO.CONSTRAINT_FAILED]: 'ER_CONSTRAINT_FAILED',
});

// SQLSTATE of the class 08 is a connection exception: the server has closed its side, whatever the driver tells.
const CONNECTION_ERROR_CLASS = '08';

// An overload is answered with 503 and Retry-After, not with 500: nothing is broken, the client comes back later.
const UNAVAILABLE_KINDS = Object.freeze([DB_ERROR_KIND.TIMEOUT, DB_ERROR_KIND.OVERLOAD]);

// The value ends at the LAST suffix: the duplicate itself may hold a quote or the suffix text. A text cut before
// the suffix is masked to its end, and so is an entry cut after the last suffix: one more call, never a deeper one.
// Plain indexOf instead of a regular expression: the text also comes from a public endpoint.
function maskDuplicateEntry(text) {
  const start = text.indexOf(DUPLICATE_ENTRY_PREFIX);

  if (start === -1) {
    return text;
  }

  const valueStart = start + DUPLICATE_ENTRY_PREFIX.length;
  const valueEnd = text.lastIndexOf(DUPLICATE_ENTRY_SUFFIX);
  const masked = `${text.slice(0, valueStart)}${VALUE_MASK}`;

  if (valueEnd < valueStart) {
    return masked;
  }

  const rest = text.slice(valueEnd + DUPLICATE_ENTRY_SUFFIX.length);

  return `${masked}${DUPLICATE_ENTRY_SUFFIX}${maskDuplicateEntry(rest)}`;
}

// A value with a line break of its own leaves a line where an entry starts and does not end,
// or ends and did not start: other entries may stand complete on that same line.
function isBrokenLine(line) {
  const firstPrefix = line.indexOf(DUPLICATE_ENTRY_PREFIX);
  const firstSuffix = line.indexOf(DUPLICATE_ENTRY_SUFFIX);
  const isOpenAtEnd = line.lastIndexOf(DUPLICATE_ENTRY_PREFIX) > line.lastIndexOf(DUPLICATE_ENTRY_SUFFIX);
  const isOpenAtStart = firstSuffix !== -1 && (firstPrefix === -1 || firstSuffix < firstPrefix);

  return isOpenAtEnd || isOpenAtStart;
}

// Line by line, so the frames of a stack survive; when a value spans lines, everything from the first
// prefix to the last suffix of the whole text is the value.
function maskDuplicateEntries(text) {
  if (!text.includes(DUPLICATE_ENTRY_PREFIX)) {
    return text;
  }

  const lines = text.split(LINE_BREAK);

  return lines.some((line) => isBrokenLine(line))
    ? maskDuplicateEntry(text)
    : lines.map((line) => maskDuplicateEntry(line)).join(LINE_BREAK);
}

function maskUnquotedValue(line) {
  const start = line.indexOf(UNQUOTED_VALUE_PREFIX);

  return start === -1
    ? line
    : `${line.slice(0, start + UNQUOTED_VALUE_PREFIX.length)}${VALUE_MASK}`;
}

// To the end of its line only: the frames of a stack that follow must stay.
function maskUnquotedValues(text) {
  return text.includes(UNQUOTED_VALUE_PREFIX)
    ? text.split(LINE_BREAK).map((line) => maskUnquotedValue(line)).join(LINE_BREAK)
    : text;
}

function isStackFrameAt(text, position) {
  STACK_FRAME_REGEXP.lastIndex = position;

  return STACK_FRAME_REGEXP.test(text);
}

// A quote closes the value only when what the server writes after one follows it. At the end of a line
// that is nothing, so the next line must be the end of the text or a frame of a stack.
function isValueEnd(text, quoteAt, lineEnd, tails) {
  const tail = text.slice(quoteAt + 1, lineEnd);

  if (tail !== '') {
    return tails.some((known) => known !== '' && tail.startsWith(known));
  }

  return tails.includes('') && (lineEnd === text.length || isStackFrameAt(text, lineEnd + 1));
}

// The value runs to the last quote of its line: it may hold quotes of its own. A value that does not end
// on its line is cut or holds a line break: the rest of the text is taken for it, frames of a stack included.
// One pass per prefix, each line looked at once.
function maskValuesAfter(text, prefix) {
  const parts = [];
  let position = 0;
  let start = text.indexOf(prefix);

  while (start !== -1) {
    const valueStart = start + prefix.length;
    const lineBreak = text.indexOf(LINE_BREAK, valueStart);
    const lineEnd = lineBreak === -1
      ? text.length
      : lineBreak;
    const valueEnd = text.lastIndexOf(QUOTE, lineEnd - 1);

    parts.push(text.slice(position, valueStart), VALUE_MASK);

    if (valueEnd < valueStart || !isValueEnd(text, valueEnd, lineEnd, VALUE_TAILS[prefix])) {
      return parts.join('');
    }

    position = valueEnd;
    start = text.indexOf(prefix, lineEnd);
  }

  parts.push(text.slice(position));

  return parts.join('');
}

// For any text on its way to a log, an alert or a response: what the server repeats of a statement is hidden,
// the name of the index and the frames of a stack stay.
export function maskDbErrorValues(text) {
  if (!isString(text)) {
    return text;
  }

  return Object.keys(VALUE_TAILS).reduce(
    (masked, prefix) => (masked.includes(prefix) ? maskValuesAfter(masked, prefix) : masked),
    maskDuplicateEntries(maskUnquotedValues(text)),
  );
}

export function isIdentifier(name) {
  return isString(name) && IDENTIFIER_REGEXP.test(name);
}

// A column without an alias is named by its own text, and so by the values written into the statement:
// only a name that is an identifier goes into a message.
export function describeColumn(name) {
  return isIdentifier(name)
    ? `the column "${name}"`
    : EXPRESSION_COLUMN;
}

// From the first opening quote to the last quote: a value may hold quotes of its own, and the apostrophe
// of "doesn't" opens nothing. A message the server has cut has lost its closing quote: all the rest is the value.
function maskQuoted(text) {
  const start = text.search(OPENING_QUOTE_REGEXP);
  const end = text.lastIndexOf(QUOTE);

  if (start === -1) {
    return text;
  }

  return end > start && Buffer.byteLength(text) < MESSAGE_BYTES_MAX
    ? `${text.slice(0, start + 1)}${VALUE_MASK}${text.slice(end)}`
    : `${text.slice(0, start + 1)}${VALUE_MASK}`;
}

// Built anew instead of passing the error of the driver on: that one carries "sql" with the values
// substituted and the raw text of the server, and both would reach the log, the alert and the response.
export class DbError extends Error {
  constructor(message, { cause, ...details } = {}) {
    super(message, cause === undefined ? undefined : { cause });

    Object.assign(this, compact(details));
  }
}

// On the prototype, not on the instance: an own enumerable name is copied into every log line next to "type".
Object.defineProperty(DbError.prototype, 'name', {
  value: 'DbError',
  writable: true,
  configurable: true,
});

// A host with several addresses fails as an AggregateError without a message: the text is in its members.
function readText(error) {
  if (isNonEmptyString(error?.message)) {
    return error.message;
  }

  const texts = isArray(error?.errors)
    ? error.errors.map((member) => member?.message).filter((text) => isNonEmptyString(text))
    : [];

  return texts.join(MESSAGE_SEPARATOR) || UNKNOWN_ERROR_MESSAGE;
}

// The resource is the last thing in quotes: the name of the account, which comes first, may spell anything.
function readLastQuoted(text) {
  const end = text.lastIndexOf(QUOTE);

  return text.slice(text.lastIndexOf(QUOTE, end - 1), end + 1);
}

function readKind(error, text) {
  if (error?.errno === ERRNO.USER_LIMIT_REACHED) {
    return readLastQuoted(text) === USER_CONNECTIONS_RESOURCE
      ? DB_ERROR_KIND.OVERLOAD
      : null;
  }

  return KIND_BY_ERRNO[error?.errno] ?? null;
}

function readConstraint(text) {
  const nameStart = text.lastIndexOf(DUPLICATE_ENTRY_SUFFIX);

  if (nameStart === -1) {
    return null;
  }

  const [, name = null] = CONSTRAINT_REGEXP.exec(text.slice(nameStart + DUPLICATE_ENTRY_SUFFIX.length)) ?? [];

  return name;
}

function readCode(error) {
  const errno = error?.errno;

  if (Object.hasOwn(MARIADB_CODES, errno)) {
    return MARIADB_CODES[errno];
  }

  return errno >= MARIADB_ERRNO_MIN || !isNonEmptyString(error?.code)
    ? null
    : error.code;
}

// An error of the server tells its number, so its text is read strictly: unless the number is known to quote
// names only, everything in quotes is taken for a value. Any other text gets the masking of known phrases.
// A duplicate is one entry however many lines and "for key" its value holds: the name of the index stays.
function readMessage(error, text, kind, isScript) {
  if (kind === DB_ERROR_KIND.UNIQUE && text.includes(DUPLICATE_ENTRY_PREFIX)) {
    return maskDuplicateEntry(text);
  }

  // The text of a script comes from the repository: the piece of it a syntax error shows stays as it is.
  // A value is still masked: a script that fails on the rows of a table repeats what those rows hold.
  if (isScript) {
    return error?.errno === ERRNO.PARSE_ERROR
      ? text
      : maskDbErrorValues(text);
  }

  return isString(error?.sqlState) && !NAMING_ERRNOS.includes(error?.errno)
    ? maskQuoted(text)
    : maskDbErrorValues(text);
}

function isConnectionLost(error) {
  return error?.fatal === true
    || (isString(error?.sqlState) && error.sqlState.startsWith(CONNECTION_ERROR_CLASS));
}

function refuseWhenUnavailable(dbError) {
  return UNAVAILABLE_KINDS.includes(dbError.kind)
    ? new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause: dbError })
    : dbError;
}

// "isScript" is for a statement whose text is a file of the repository and carries no value of a request,
// "isConnectFailure" for an error of opening a connection: it is about the database, whatever statement waits for it.
export function toDbError(error, { isScript = false, isConnectFailure = false } = {}) {
  if (error instanceof DbError || error instanceof AppError) {
    return error;
  }

  const text = readText(error);
  const kind = readKind(error, text);

  return refuseWhenUnavailable(new DbError(readMessage(error, text, kind, isScript), {
    kind,
    constraint: kind === DB_ERROR_KIND.UNIQUE
      ? readConstraint(text)
      : null,
    code: readCode(error),
    errno: error?.errno,
    sqlState: error?.sqlState,
    isFatal: isConnectionLost(error) || null,
    isConnectFailure: isConnectFailure || null,
  }));
}

export function createOverloadError() {
  return refuseWhenUnavailable(new DbError(POOL_SATURATED_MESSAGE, {
    kind: DB_ERROR_KIND.OVERLOAD,
    code: POOL_SATURATED_CODE,
  }));
}

export function createTransactionTimeoutError(cause) {
  return new DbError(TRANSACTION_TIMEOUT_MESSAGE, { code: TRANSACTION_TIMEOUT_CODE, cause });
}

// The error of the database behind a failure: the error itself, or the cause of the 503 it was turned into.
export function findDbError(error) {
  if (error instanceof DbError) {
    return error;
  }

  return error instanceof AppError && error.cause instanceof DbError
    ? error.cause
    : null;
}

export function isLockConflict(error) {
  return error instanceof DbError && error.kind === DB_ERROR_KIND.DEADLOCK;
}

// The wait for a lock that ran out of time, as apart from a deadlock: there another session still holds the lock.
export function isLockWaitTimeout(error) {
  return findDbError(error)?.errno === ERRNO.LOCK_WAIT_TIMEOUT;
}

export function isTransactionTimeout(error) {
  return findDbError(error)?.code === TRANSACTION_TIMEOUT_CODE;
}

// A connection lost on the way may have carried a write that landed, a COMMIT or a statement outside a transaction: what
// the call was told it failed to write may be written. One that never opened sent nothing, though the driver calls that
// fatal too, and one lost inside an open transaction took it with it (marked by core/db/transaction.js).
export function isOutcomeUnknown(error) {
  const dbError = findDbError(error);

  return dbError?.isFatal === true && dbError.isConnectFailure !== true && dbError.isRolledBack !== true;
}

export function isMissingTable(error) {
  return findDbError(error)?.errno === ERRNO.NO_SUCH_TABLE;
}

export function isDatabaseAccessDenied(error) {
  return findDbError(error)?.errno === ERRNO.DBACCESS_DENIED;
}
