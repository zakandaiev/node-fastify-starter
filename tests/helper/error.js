import { AppError } from '#core/error/index.js';
import { ERROR_CATALOG, ERROR_CODE } from '#enums/error-code.js';
import { isString } from '#utils/type.js';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

function toRefusal(code) {
  return Object.freeze({ code, statusCode: ERROR_CATALOG[code].statusCode });
}

export const REFUSAL = Object.freeze({
  UNAUTHENTICATED: toRefusal(ERROR_CODE.AUTHENTICATION_ERROR),
  FORBIDDEN: toRefusal(ERROR_CODE.AUTHORIZATION_ERROR),
  NOT_FOUND: toRefusal(ERROR_CODE.NOT_FOUND_ERROR),
  NO_CHANGES: toRefusal(ERROR_CODE.NO_CHANGES),
  PROTECTED: toRefusal(ERROR_CODE.GROUP_PROTECTED),
  CONTACT_TAKEN: toRefusal(ERROR_CODE.CONTACT_TAKEN),
  IDENTITY_TAKEN: toRefusal(ERROR_CODE.IDENTITY_TAKEN),
});

// A string is the whole message, a pattern a part of it. The true it gives back is what assert.rejects() and
// assert.throws() need of a check: they refuse anything else.
export function assertTypeError(error, message) {
  assert.ok(error instanceof TypeError, inspect(error));

  if (isString(message)) {
    assert.equal(error.message, message);
  } else {
    assert.match(error.message, message);
  }

  return true;
}

export function assertAppError(error, { code, statusCode }) {
  assert.ok(error instanceof AppError, inspect(error));
  assert.deepEqual({ code: error.code, statusCode: error.statusCode }, { code, statusCode });

  return true;
}

export function typeErrorOf(message) {
  function isTypeError(error) {
    return assertTypeError(error, message);
  }

  return isTypeError;
}

export function appErrorOf(refusal) {
  function isAppError(error) {
    return assertAppError(error, refusal);
  }

  return isAppError;
}
