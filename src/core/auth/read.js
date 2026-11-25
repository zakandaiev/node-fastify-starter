import { getContext } from '#core/context/index.js';
import { DbError } from '#core/db/error.js';
import { AppError } from '#core/error/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { isTimeoutError, withTimeout } from '#utils/async.js';
import { convertStringToMs } from '#utils/date.js';

const SILENT_MESSAGE = 'A read of a session or of its scopes did not end within config.auth.readTimeout: the pool was busy, or the database silent';
const SILENT_CODE = 'READ_TIMEOUT';

// An overload is told by an AppError of its own.
export function isDatabaseAway(error) {
  return error instanceof DbError && (error.isConnectFailure === true || error.isFatal === true);
}

// 503, not 401 and not 500: the client is not signed out, it comes back later. The cause stays for the alert.
export function createUnavailableError(cause) {
  return new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause });
}

// A deadline is told as a statement timeout of the database, which has an alert.
function toUnavailable(error) {
  if (isTimeoutError(error)) {
    return createUnavailableError(new DbError(SILENT_MESSAGE, { kind: DB_ERROR_KIND.TIMEOUT, code: SILENT_CODE }));
  }

  return isDatabaseAway(error)
    ? createUnavailableError(error)
    : error;
}

// For a read of a session or of its scopes, with a deadline of its own: requests that wait for the same row share one
// read, and a connection that went silent would hold them all. A database that is there and refuses the statement
// (a table or a column it does not have) stays the error it is.
export async function readInTime(read) {
  const timeoutMs = convertStringToMs(getContext().config.auth.readTimeout);

  try {
    return await withTimeout(read, timeoutMs);
  } catch (error) {
    throw toUnavailable(error);
  }
}
