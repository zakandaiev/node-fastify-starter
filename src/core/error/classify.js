import { AppError } from '#core/error/index.js';
import { ERROR_CATALOG, ERROR_CODE } from '#enums/error-code.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { isArray, isNumberInRange, isString } from '#utils/type.js';

const ERROR_STATUS_MIN = 400;
const ERROR_STATUS_MAX = 599;

const PARAMS_CONTEXT = 'params';

const CLIENT_CODES = Object.freeze({
  [HTTP_STATUS.NOT_FOUND]: ERROR_CODE.NOT_FOUND_ERROR,
  [HTTP_STATUS.PAYLOAD_TOO_LARGE]: ERROR_CODE.PAYLOAD_TOO_LARGE_ERROR,
  [HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE]: ERROR_CODE.UNSUPPORTED_MEDIA_TYPE_ERROR,
  [HTTP_STATUS.TOO_MANY_REQUESTS]: ERROR_CODE.RATE_LIMIT_ERROR,
});

// The frontend reads 401 and 403 as the end of a session or a block: only authentication and authorization
// answer with them, through AppError. The same status on an error of a plugin is a plain bad request.
const RESERVED_STATUSES = Object.freeze([HTTP_STATUS.UNAUTHORIZED, HTTP_STATUS.FORBIDDEN]);

function isErrorStatus(value) {
  return Number.isInteger(value) && isNumberInRange(value, ERROR_STATUS_MIN, ERROR_STATUS_MAX);
}

function describe(code, statusCode = ERROR_CATALOG[code].statusCode) {
  return { code, statusCode };
}

// By the array, not by the code FST_ERR_VALIDATION: a validator that crashed carries the same code and no errors.
export function isSchemaError(error) {
  return isArray(error?.validation) && isString(error?.validationContext);
}

function readStatus(error) {
  if (isErrorStatus(error?.statusCode)) {
    return error.statusCode;
  }

  return isErrorStatus(error?.status)
    ? error.status
    : HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

// Anything can be thrown: null, a string, an error with a status of 99 or 302, an object whose getter throws.
export function getErrorStatus(error) {
  try {
    return readStatus(error);
  } catch {
    return HTTP_STATUS.INTERNAL_SERVER_ERROR;
  }
}

function classifyByStatus(statusCode) {
  if (statusCode === HTTP_STATUS.SERVICE_UNAVAILABLE) {
    return describe(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
  }

  if (statusCode >= HTTP_STATUS.INTERNAL_SERVER_ERROR) {
    return describe(ERROR_CODE.SERVER_ERROR);
  }

  if (RESERVED_STATUSES.includes(statusCode)) {
    return describe(ERROR_CODE.BAD_REQUEST_ERROR);
  }

  return describe(CLIENT_CODES[statusCode] ?? ERROR_CODE.BAD_REQUEST_ERROR, statusCode);
}

// The code is checked again: it is a plain property, and one changed after the error was built names no entry.
function isCatalogError(error) {
  return error instanceof AppError && Object.hasOwn(ERROR_CATALOG, error.code);
}

export function classifyError(error) {
  if (isCatalogError(error)) {
    return describe(error.code);
  }

  if (!isSchemaError(error)) {
    return classifyByStatus(getErrorStatus(error));
  }

  // No object can have such an id: a poll of the client must not take it for a temporary failure.
  return error.validationContext === PARAMS_CONTEXT
    ? describe(ERROR_CODE.NOT_FOUND_ERROR)
    : describe(ERROR_CODE.VALIDATION_ERROR);
}
