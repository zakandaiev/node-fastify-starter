import { ERROR_CATALOG, ERROR_CODE } from '#enums/error-code.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const EXPECTED_STATUSES = {
  BAD_REQUEST_ERROR: 400,
  AUTHENTICATION_ERROR: 401,
  SESSION_REVOKED: 401,
  AUTHORIZATION_ERROR: 403,
  ORIGIN_ERROR: 403,
  NOT_FOUND_ERROR: 404,
  NO_CHANGES: 409,
  CONTACT_TAKEN: 409,
  IDENTITY_TAKEN: 409,
  PAYLOAD_TOO_LARGE_ERROR: 413,
  UNSUPPORTED_MEDIA_TYPE_ERROR: 415,
  VALIDATION_ERROR: 422,
  RATE_LIMIT_ERROR: 429,
  SERVER_ERROR: 500,
  UPSTREAM_ERROR: 502,
  SERVICE_UNAVAILABLE_ERROR: 503,
};

describe('ERROR_CODE', () => {
  test('every code is its own name', () => {
    Object.entries(ERROR_CODE).forEach(([name, code]) => assert.equal(code, name));
  });

  test('is frozen', () => {
    assert.ok(Object.isFrozen(ERROR_CODE));
  });
});

describe('ERROR_CATALOG', () => {
  test('describes every code and nothing else', () => {
    assert.deepEqual(Object.keys(ERROR_CATALOG).sort(), Object.values(ERROR_CODE).sort());
  });

  test('maps every code to the HTTP status of the response format', () => {
    const statuses = Object.fromEntries(
      Object.entries(ERROR_CATALOG).map(([code, entry]) => [code, entry.statusCode]),
    );

    assert.deepEqual(statuses, EXPECTED_STATUSES);
  });

  test('gives every code a message for the developer', () => {
    Object.values(ERROR_CATALOG).forEach((entry) => {
      assert.equal(typeof entry.message, 'string');
      assert.notEqual(entry.message, '');
    });
  });

  test('logs client errors and an overload as warnings, and never alerts on them', () => {
    const quiet = Object.entries(ERROR_CATALOG).filter(([, entry]) => entry.statusCode < 500 || entry.statusCode === 503);

    assert.equal(quiet.length, 14);
    quiet.forEach(([code, entry]) => {
      assert.equal(entry.logLevel, 'warn', code);
      assert.equal(entry.isAlertable, false, code);
    });
  });

  test('logs a server fault as an error and alerts on it', () => {
    ['SERVER_ERROR', 'UPSTREAM_ERROR'].forEach((code) => {
      assert.equal(ERROR_CATALOG[code].logLevel, 'error');
      assert.equal(ERROR_CATALOG[code].isAlertable, true);
    });
  });

  test('is frozen together with its entries', () => {
    assert.ok(Object.isFrozen(ERROR_CATALOG));
    Object.values(ERROR_CATALOG).forEach((entry) => assert.ok(Object.isFrozen(entry)));
  });
});
