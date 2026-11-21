import { createOverloadError, DbError } from '#core/db/error.js';
import {
  classifyError,
  findUniqueViolation,
  getErrorStatus,
  isSchemaError,
} from '#core/error/classify.js';
import { AppError } from '#core/error/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

const CATALOGUE_STATUSES = Object.freeze({
  BAD_REQUEST_ERROR: 400,
  AUTHENTICATION_ERROR: 401,
  SESSION_REVOKED: 401,
  AUTHORIZATION_ERROR: 403,
  ORIGIN_ERROR: 403,
  NOT_FOUND_ERROR: 404,
  NO_CHANGES: 409,
  PAYLOAD_TOO_LARGE_ERROR: 413,
  UNSUPPORTED_MEDIA_TYPE_ERROR: 415,
  VALIDATION_ERROR: 422,
  RATE_LIMIT_ERROR: 429,
  SERVER_ERROR: 500,
  UPSTREAM_ERROR: 502,
  SERVICE_UNAVAILABLE_ERROR: 503,
});

const OWN_CODES = Object.freeze([
  [404, 'NOT_FOUND_ERROR'],
  [413, 'PAYLOAD_TOO_LARGE_ERROR'],
  [415, 'UNSUPPORTED_MEDIA_TYPE_ERROR'],
  [429, 'RATE_LIMIT_ERROR'],
]);
const SESSION_STATUSES = Object.freeze([401, 403]);
const UNAVAILABLE_STATUS = 503;

const BAD_REQUEST = Object.freeze({ code: 'BAD_REQUEST_ERROR', statusCode: 400 });
const SERVER_FAULT = Object.freeze({ code: 'SERVER_ERROR', statusCode: 500 });
const UNAVAILABLE = Object.freeze({ code: 'SERVICE_UNAVAILABLE_ERROR', statusCode: 503 });
const INVALID = Object.freeze({ code: 'VALIDATION_ERROR', statusCode: 422 });

const INVALID_STATUSES = Object.freeze([99, 200, 302, 399, 600, 700, '404', 404.5, NaN, Infinity, -404, null, undefined, true, [404], {}]);

const NON_ERRORS = Object.freeze([null, undefined, 'boom', '404', 404, 503, true, Symbol('boom'), {}, { message: 'boom' }, [], () => {}]);

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (unused, index) => from + index);
}

function createForeignError(fields) {
  return Object.assign(new Error('boom'), fields);
}

function classifyStatus(statusCode) {
  return classifyError(createForeignError({ statusCode }));
}

// What the driver throws for a row that breaks a unique index: the value in its text is masked already.
function createDuplicate(constraint = 'uq_users_email', fields = {}) {
  return Object.assign(new DbError(`Duplicate entry '***' for key '${constraint}'`, {
    kind: DB_ERROR_KIND.UNIQUE,
    constraint,
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    sqlState: '23000',
  }), fields);
}

// What Fastify hands over for a part that failed its schema: the errors of AJV and the name of the part.
function createSchemaError(validationContext) {
  return Object.assign(new Error('Request is not valid'), {
    statusCode: 400,
    code: 'FST_ERR_VALIDATION',
    validation: [{ instancePath: '/id', keyword: 'type', params: { type: 'integer' } }],
    validationContext,
  });
}

describe('getErrorStatus', () => {
  test('takes an integer from 400 to 599 from statusCode', () => {
    [400, 401, 404, 418, 499, 500, 503, 599].forEach((statusCode) => {
      assert.equal(getErrorStatus(createForeignError({ statusCode })), statusCode);
    });
  });

  test('prefers statusCode to status', () => {
    assert.equal(getErrorStatus(createForeignError({ statusCode: 404, status: 500 })), 404);
    assert.equal(getErrorStatus(createForeignError({ statusCode: 503, status: 400 })), 503);
  });

  test('falls back to status when statusCode is missing or is not such an integer', () => {
    assert.equal(getErrorStatus(createForeignError({ status: 404 })), 404);
    assert.equal(getErrorStatus(createForeignError({ status: 599 })), 599);

    INVALID_STATUSES.forEach((statusCode) => {
      assert.equal(getErrorStatus(createForeignError({ statusCode, status: 409 })), 409, inspect(statusCode));
    });
  });

  test('answers 500 when neither of them is an integer from 400 to 599', () => {
    assert.equal(getErrorStatus(new Error('boom')), 500);

    INVALID_STATUSES.forEach((status) => {
      assert.equal(getErrorStatus(createForeignError({ statusCode: status })), 500, inspect(status));
      assert.equal(getErrorStatus(createForeignError({ status })), 500, inspect(status));
      assert.equal(getErrorStatus(createForeignError({ statusCode: status, status })), 500, inspect(status));
    });
  });

  test('answers 500 for a thrown value that is not an error', () => {
    NON_ERRORS.forEach((value) => {
      assert.equal(getErrorStatus(value), 500, inspect(value));
    });
  });

  test('reads a thrown plain object the way it reads an error', () => {
    assert.equal(getErrorStatus({ statusCode: 416 }), 416);
    assert.equal(getErrorStatus({ status: 429 }), 429);
    assert.equal(getErrorStatus({ statusCode: '416', status: 302 }), 500);
  });

  test('answers 500 for an error whose status cannot be read', () => {
    const error = Object.defineProperty(new Error('boom'), 'statusCode', {
      get() {
        throw new Error('unreadable');
      },
    });
    const { proxy, revoke } = Proxy.revocable({}, {});

    revoke();

    assert.equal(getErrorStatus(error), 500);
    assert.equal(getErrorStatus(proxy), 500);
  });
});

describe('classifyError: an AppError whose code was changed after it was built', () => {
  test('is classified by its status, like an error of a plugin', () => {
    const renamed = Object.assign(new AppError(ERROR_CODE.NOT_FOUND_ERROR), { code: 'NOPE' });
    const inherited = Object.assign(new AppError(ERROR_CODE.NO_CHANGES), { code: 'toString' });

    assert.deepEqual(classifyError(renamed), { code: 'NOT_FOUND_ERROR', statusCode: 404 });
    assert.deepEqual(classifyError(inherited), { code: 'BAD_REQUEST_ERROR', statusCode: 409 });
  });

  test('is classified by its status when its cause is a duplicate too: the handler answers it as an AppError', () => {
    const renamed = Object.assign(new AppError(ERROR_CODE.NOT_FOUND_ERROR, { cause: createDuplicate() }), { code: 'NOPE' });
    const inherited = Object.assign(new AppError(ERROR_CODE.NO_CHANGES, { cause: createDuplicate('PRIMARY') }), { code: 'toString' });

    assert.deepEqual(classifyError(renamed), { code: 'NOT_FOUND_ERROR', statusCode: 404 });
    assert.deepEqual(classifyError(inherited), { code: 'BAD_REQUEST_ERROR', statusCode: 409 });
  });
});

describe('isSchemaError', () => {
  test('accepts an error with a list of schema errors and the name of the failed part', () => {
    ['params', 'body', 'querystring', 'headers'].forEach((part) => {
      assert.equal(isSchemaError(createSchemaError(part)), true, part);
    });

    assert.equal(isSchemaError({ validation: [], validationContext: 'body' }), true);
  });

  test('rejects a crashed validator: it carries the code of a schema error, but no list', () => {
    const error = createForeignError({ code: 'FST_ERR_VALIDATION', statusCode: 500, validationContext: 'body' });

    assert.equal(isSchemaError(error), false);
  });

  test('rejects a validation that is truthy but is not an array', () => {
    ['email', 1, true, { email: 'required' }, { length: 1, 0: {} }, new Set([{}])].forEach((validation) => {
      assert.equal(isSchemaError({ validation, validationContext: 'body' }), false, inspect(validation));
    });
  });

  test('rejects a list that comes without the name of the part', () => {
    assert.equal(isSchemaError({ validation: [{}] }), false);

    [undefined, null, 0, 1, true, ['body'], { part: 'body' }].forEach((validationContext) => {
      assert.equal(isSchemaError({ validation: [{}], validationContext }), false, inspect(validationContext));
    });
  });

  test('rejects an error without either mark and a thrown value that is not an error', () => {
    assert.equal(isSchemaError(new Error('boom')), false);

    NON_ERRORS.forEach((value) => {
      assert.equal(isSchemaError(value), false, inspect(value));
    });
  });
});

describe('classifyError: AppError', () => {
  test('answers with the code of the error and the status of that code in the catalogue', () => {
    Object.values(ERROR_CODE).forEach((code) => {
      assert.deepEqual(classifyError(new AppError(code)), { code, statusCode: CATALOGUE_STATUSES[code] });
    });
  });

  test('does not look at the message, the validation, the headers or the cause', () => {
    const error = new AppError(ERROR_CODE.RATE_LIMIT_ERROR, {
      message: 'Slow down',
      validation: [{ column: 'email', operator: 'unique' }],
      headers: { 'retry-after': '30' },
      cause: createForeignError({ statusCode: 502 }),
    });

    assert.deepEqual(classifyError(error), { code: 'RATE_LIMIT_ERROR', statusCode: 429 });
  });

  test('takes the status from the catalogue, not from the fields of the error', () => {
    const error = Object.assign(new AppError(ERROR_CODE.NOT_FOUND_ERROR), { statusCode: 500, status: 503 });

    assert.deepEqual(classifyError(error), { code: 'NOT_FOUND_ERROR', statusCode: 404 });
  });

  test('stays what it is when it carries the marks of a schema error', () => {
    const { validation } = createSchemaError('body');
    const inBody = Object.assign(new AppError(ERROR_CODE.NO_CHANGES), { validation, validationContext: 'body' });
    const inParams = Object.assign(new AppError(ERROR_CODE.AUTHORIZATION_ERROR), { validation, validationContext: 'params' });

    assert.deepEqual(classifyError(inBody), { code: 'NO_CHANGES', statusCode: 409 });
    assert.deepEqual(classifyError(inParams), { code: 'AUTHORIZATION_ERROR', statusCode: 403 });
  });
});

describe('classifyError: schema errors', () => {
  test('answers 422 VALIDATION_ERROR for the body, the query string and the headers', () => {
    ['body', 'querystring', 'headers'].forEach((part) => {
      assert.deepEqual(classifyError(createSchemaError(part)), { code: 'VALIDATION_ERROR', statusCode: 422 }, part);
    });
  });

  test('answers 404 NOT_FOUND_ERROR for the path parameters: no object can have such an id', () => {
    assert.deepEqual(classifyError(createSchemaError('params')), { code: 'NOT_FOUND_ERROR', statusCode: 404 });
  });

  test('answers 422 for a part with any other name', () => {
    assert.deepEqual(classifyError(createSchemaError('cookies')), { code: 'VALIDATION_ERROR', statusCode: 422 });
  });

  test('takes a crashed validator for a server fault, not for a 422', () => {
    const error = createForeignError({ code: 'FST_ERR_VALIDATION', statusCode: 500, validationContext: 'body' });

    assert.deepEqual(classifyError(error), SERVER_FAULT);
  });

  test('classifies an error with a truthy validation that is not an array by its status', () => {
    assert.deepEqual(classifyError(createForeignError({ statusCode: 400, validation: 'email', validationContext: 'body' })), BAD_REQUEST);
    assert.deepEqual(classifyError(createForeignError({ statusCode: 404, validation: { id: 'type' }, validationContext: 'params' })), { code: 'NOT_FOUND_ERROR', statusCode: 404 });
    assert.deepEqual(classifyError(createForeignError({ validation: true, validationContext: 'body' })), SERVER_FAULT);
  });

  test('classifies an error with a list but without the name of the part by its status', () => {
    const { validation } = createSchemaError('body');

    assert.deepEqual(classifyError(createForeignError({ statusCode: 409, validation })), { code: 'BAD_REQUEST_ERROR', statusCode: 409 });
    assert.deepEqual(classifyError(createForeignError({ validation })), SERVER_FAULT);
    assert.deepEqual(classifyError(createForeignError({ validation, validationContext: null })), SERVER_FAULT);
  });
});

describe('findUniqueViolation', () => {
  test('finds an error of the database of the kind "unique" that is the error itself', () => {
    const duplicates = [createDuplicate(), createDuplicate('PRIMARY'), new DbError('Database error', { kind: DB_ERROR_KIND.UNIQUE })];

    duplicates.forEach((duplicate) => assert.equal(findUniqueViolation(duplicate), duplicate, inspect(duplicate)));
  });

  test('finds nothing in the cause of an AppError, whether its code is in the catalogue or was changed after it was built', () => {
    const wrappers = [
      new AppError(ERROR_CODE.NO_CHANGES, { cause: createDuplicate() }),
      new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause: createDuplicate() }),
      Object.assign(new AppError(ERROR_CODE.NOT_FOUND_ERROR, { cause: createDuplicate() }), { code: 'NOPE' }),
    ];

    wrappers.forEach((error) => assert.equal(findUniqueViolation(error), null, inspect(error)));
  });

  test('finds nothing in an error of the database of another kind or none, nor in anything else', () => {
    const others = [
      new DbError('Deadlock found', { kind: DB_ERROR_KIND.DEADLOCK }),
      new DbError('Database error'),
      createOverloadError(),
      Object.assign(new Error('Duplicate entry'), { kind: DB_ERROR_KIND.UNIQUE }),
      { kind: DB_ERROR_KIND.UNIQUE, constraint: 'uq_users_email' },
      new Error('wrapped', { cause: createDuplicate() }),
      ...NON_ERRORS,
    ];

    others.forEach((error) => assert.equal(findUniqueViolation(error), null, inspect(error)));
  });
});

describe('classifyError: a duplicate in the database', () => {
  test('answers 422 VALIDATION_ERROR, whatever index, status or marks of a schema error it carries', () => {
    const duplicates = [
      createDuplicate(),
      createDuplicate('PRIMARY'),
      new DbError('Database error', { kind: DB_ERROR_KIND.UNIQUE }),
      createDuplicate('uq_users_email', { statusCode: 500, status: 503 }),
      createDuplicate('uq_users_email', createSchemaError('params')),
    ];

    duplicates.forEach((error) => assert.deepEqual(classifyError(error), INVALID, inspect(error)));
  });

  test('keeps the code of an AppError whose cause is a duplicate', () => {
    assert.deepEqual(classifyError(new AppError(ERROR_CODE.NO_CHANGES, { cause: createDuplicate() })), { code: 'NO_CHANGES', statusCode: 409 });
    assert.deepEqual(classifyError(new AppError(ERROR_CODE.SERVER_ERROR, { cause: createDuplicate() })), SERVER_FAULT);
  });

  test('leaves an error of the database of another kind to its status, and a lookalike too', () => {
    assert.deepEqual(classifyError(new DbError('Deadlock found', { kind: DB_ERROR_KIND.DEADLOCK })), SERVER_FAULT);
    assert.deepEqual(classifyError(new DbError('Database error')), SERVER_FAULT);
    assert.deepEqual(classifyError(createOverloadError()), UNAVAILABLE);
    assert.deepEqual(classifyError(createForeignError({ kind: DB_ERROR_KIND.UNIQUE, constraint: 'uq_users_email' })), SERVER_FAULT);
    assert.deepEqual(classifyError({ kind: DB_ERROR_KIND.UNIQUE, statusCode: 409 }), { code: 'BAD_REQUEST_ERROR', statusCode: 409 });
  });
});

describe('classifyError: foreign errors', () => {
  test('gives a 404, a 413, a 415 and a 429 the code of that status', () => {
    OWN_CODES.forEach(([statusCode, code]) => {
      assert.deepEqual(classifyStatus(statusCode), { code, statusCode });
    });
  });

  test('keeps the status of another 4xx under BAD_REQUEST_ERROR', () => {
    [400, 405, 409, 414, 416, 418, 422].forEach((statusCode) => {
      assert.deepEqual(classifyStatus(statusCode), { code: 'BAD_REQUEST_ERROR', statusCode });
    });
  });

  test('does so for every 4xx that has no rule of its own', () => {
    const ruled = [...SESSION_STATUSES, ...OWN_CODES.map(([statusCode]) => statusCode)];
    const statuses = range(400, 499).filter((statusCode) => !ruled.includes(statusCode));

    assert.equal(statuses.length, 94);
    assert.deepEqual(
      statuses.map((statusCode) => classifyStatus(statusCode)),
      statuses.map((statusCode) => ({ code: 'BAD_REQUEST_ERROR', statusCode })),
    );
  });

  test('turns a 401 and a 403 into 400 BAD_REQUEST_ERROR: only an AppError may end a session', () => {
    SESSION_STATUSES.forEach((status) => {
      assert.deepEqual(classifyStatus(status), BAD_REQUEST);
      assert.deepEqual(classifyError(createForeignError({ status })), BAD_REQUEST);
    });
  });

  test('answers 503 SERVICE_UNAVAILABLE_ERROR for a 503', () => {
    assert.deepEqual(classifyStatus(UNAVAILABLE_STATUS), UNAVAILABLE);
    assert.deepEqual(classifyError(createForeignError({ status: UNAVAILABLE_STATUS })), UNAVAILABLE);
  });

  test('answers 500 SERVER_ERROR for every other 5xx', () => {
    const statuses = range(500, 599).filter((statusCode) => statusCode !== UNAVAILABLE_STATUS);

    assert.equal(statuses.length, 99);
    assert.deepEqual(statuses.map((statusCode) => classifyStatus(statusCode)), statuses.map(() => SERVER_FAULT));
  });

  test('reads the status from "status" when statusCode is missing or invalid', () => {
    assert.deepEqual(classifyError(createForeignError({ status: 404 })), { code: 'NOT_FOUND_ERROR', statusCode: 404 });
    assert.deepEqual(classifyError(createForeignError({ status: 409 })), { code: 'BAD_REQUEST_ERROR', statusCode: 409 });
    assert.deepEqual(classifyError(createForeignError({ statusCode: 99, status: 429 })), { code: 'RATE_LIMIT_ERROR', statusCode: 429 });
    assert.deepEqual(classifyError(createForeignError({ statusCode: '413', status: 503 })), UNAVAILABLE);
    assert.deepEqual(classifyError(createForeignError({ statusCode: 200, status: 502 })), SERVER_FAULT);
    assert.deepEqual(classifyError(createForeignError({ statusCode: 413, status: 500 })), { code: 'PAYLOAD_TOO_LARGE_ERROR', statusCode: 413 });
  });

  test('answers 500 SERVER_ERROR for a status that is not an integer from 400 to 599', () => {
    INVALID_STATUSES.forEach((status) => {
      assert.deepEqual(classifyStatus(status), SERVER_FAULT, inspect(status));
      assert.deepEqual(classifyError(createForeignError({ status })), SERVER_FAULT, inspect(status));
    });
  });

  test('answers 500 SERVER_ERROR for an error without a status', () => {
    assert.deepEqual(classifyError(new Error('boom')), SERVER_FAULT);
    assert.deepEqual(classifyError(new TypeError('boom')), SERVER_FAULT);
  });

  test('answers 500 SERVER_ERROR for a thrown value that is not an error', () => {
    NON_ERRORS.forEach((value) => {
      assert.deepEqual(classifyError(value), SERVER_FAULT, inspect(value));
    });
  });

  test('classifies a thrown plain object by its status', () => {
    assert.deepEqual(
      classifyError({ statusCode: 416, headers: { 'content-range': 'bytes */100' } }),
      { code: 'BAD_REQUEST_ERROR', statusCode: 416 },
    );
    assert.deepEqual(classifyError({ status: 429 }), { code: 'RATE_LIMIT_ERROR', statusCode: 429 });
    assert.deepEqual(classifyError({ statusCode: 403 }), BAD_REQUEST);
  });

  test('does not trust the code or the name of a foreign error', () => {
    const lookalike = createForeignError({ name: 'AppError', code: 'AUTHENTICATION_ERROR', statusCode: 401 });

    assert.deepEqual(classifyError(lookalike), BAD_REQUEST);
    assert.deepEqual(classifyError({ name: 'AppError', code: 'SESSION_REVOKED', statusCode: 401 }), BAD_REQUEST);
    assert.deepEqual(classifyError(createForeignError({ code: 'NOT_FOUND_ERROR' })), SERVER_FAULT);
    assert.deepEqual(classifyError(createForeignError({ code: 'RATE_LIMIT_ERROR', statusCode: 502 })), SERVER_FAULT);
  });
});
