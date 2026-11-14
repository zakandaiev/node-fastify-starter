import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('AppError', () => {
  test('requires a code from the catalogue', () => {
    assert.throws(() => new AppError(), /requires a code from src\/enums\/error-code\.js, got "undefined"/);
    assert.throws(() => new AppError('TEAPOT_ERROR'), /got "TEAPOT_ERROR"/);
  });

  test('does not take an inherited key of the catalogue for a code', () => {
    assert.throws(() => new AppError('toString'), TypeError);
    assert.throws(() => new AppError('constructor'), TypeError);
    assert.throws(() => new AppError('__proto__'), TypeError);
  });

  test('takes the status and the message from the catalogue', () => {
    const error = new AppError(ERROR_CODE.NOT_FOUND_ERROR);

    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AppError');
    assert.equal(error.code, 'NOT_FOUND_ERROR');
    assert.equal(error.statusCode, 404);
    assert.equal(error.message, 'Not found');
    assert.match(error.stack, /error\.test\.js/);
  });

  test('keeps its own message and the cause', () => {
    const cause = new Error('connect ECONNREFUSED');
    const error = new AppError(ERROR_CODE.UPSTREAM_ERROR, { message: 'Mail provider is down', cause });

    assert.equal(error.message, 'Mail provider is down');
    assert.equal(error.cause, cause);
    assert.equal(error.statusCode, 502);
  });

  test('has a cause only when one is given, and its name is not a property of its own', () => {
    const plain = new AppError(ERROR_CODE.NO_CHANGES);
    const caused = new AppError(ERROR_CODE.SERVER_ERROR, { cause: null });

    assert.equal(Object.hasOwn(plain, 'cause'), false);
    assert.equal(Object.hasOwn(caused, 'cause'), true);
    assert.equal(caused.cause, null);
    assert.equal(Object.hasOwn(plain, 'name'), false);
    assert.deepEqual(Object.keys(plain), ['code', 'statusCode']);
  });

  test('carries validation and headers only when they are given', () => {
    const validation = [{
      column: 'email',
      columnValue: 'john@example.com',
      operator: 'unique',
      operatorValue: null,
    }];
    const headers = { 'retry-after': '30' };
    const plain = new AppError(ERROR_CODE.NO_CHANGES);
    const detailed = new AppError(ERROR_CODE.VALIDATION_ERROR, { validation, headers });

    assert.equal(Object.hasOwn(plain, 'validation'), false);
    assert.equal(Object.hasOwn(plain, 'headers'), false);
    assert.equal(detailed.validation, validation);
    assert.equal(detailed.headers, headers);
  });

  test('rejects options, validation and headers of a wrong type', () => {
    assert.throws(() => new AppError(ERROR_CODE.SERVER_ERROR, 'Boom'), /requires options to be a plain object/);
    assert.throws(() => new AppError(ERROR_CODE.SERVER_ERROR, null), /requires options to be a plain object/);
    assert.throws(() => new AppError(ERROR_CODE.VALIDATION_ERROR, { validation: 'email' }), /requires validation to be an array/);
    assert.throws(() => new AppError(ERROR_CODE.RATE_LIMIT_ERROR, { headers: [['retry-after', '1']] }), /requires headers to be a plain object/);
  });
});
