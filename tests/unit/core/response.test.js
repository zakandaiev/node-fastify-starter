import { createEnvelope } from '#core/response/index.js';
import { RESPONSE_STATUS } from '#enums/response-status.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PAGINATION = {
  total: 250,
  limit: 20,
  offset: 40,
  totalPages: 13,
  currentPage: 3,
  canLoadMore: true,
};

describe('createEnvelope', () => {
  test('builds a success that always carries data', () => {
    assert.deepEqual(createEnvelope(), { status: 'success', data: null });
    assert.deepEqual(createEnvelope({ data: { id: 1 } }), { status: 'success', data: { id: 1 } });
    assert.deepEqual(createEnvelope({ data: [] }), { status: 'success', data: [] });
    assert.deepEqual(createEnvelope({ data: 0 }), { status: 'success', data: 0 });
    assert.deepEqual(createEnvelope({ data: false }), { status: 'success', data: false });
  });

  test('builds an error from a code, without data unless it is given', () => {
    assert.deepEqual(
      createEnvelope({ code: 'NOT_FOUND_ERROR', message: 'Not found' }),
      { status: 'error', code: 'NOT_FOUND_ERROR', message: 'Not found' },
    );
    assert.deepEqual(
      createEnvelope({ code: 'SERVICE_UNAVAILABLE_ERROR', data: { mariadb: 'down' } }),
      { status: 'error', code: 'SERVICE_UNAVAILABLE_ERROR', data: { mariadb: 'down' } },
    );
  });

  test('exposes the two statuses', () => {
    assert.deepEqual(RESPONSE_STATUS, { SUCCESS: 'success', ERROR: 'error' });
    assert.ok(Object.isFrozen(RESPONSE_STATUS));
  });

  test('keeps the sections of a list in the documented order', () => {
    const sort = [{
      label: 'Newest first',
      value: 'newest',
      isChecked: true,
      isDefault: true,
    }];
    const filters = [{ type: 'text', name: 'firstName', label: 'Name' }];
    const envelope = createEnvelope({
      requestId: '019a0000-0000-7000-8000-000000000000',
      filters,
      sort,
      pagination: PAGINATION,
      data: [{ id: 1 }],
      message: 'Users',
    });

    assert.deepEqual(Object.keys(envelope), ['status', 'message', 'data', 'pagination', 'sort', 'filters', 'meta']);
    assert.equal(envelope.pagination, PAGINATION);
    assert.equal(envelope.sort, sort);
    assert.equal(envelope.filters, filters);
    assert.deepEqual(envelope.meta, { requestId: '019a0000-0000-7000-8000-000000000000' });
  });

  test('puts the code right after the status and validation before meta', () => {
    const validation = [{
      column: 'email',
      columnValue: 'abc',
      operator: 'format',
      operatorValue: 'email',
    }];
    const envelope = createEnvelope({
      requestId: 'id',
      validation,
      message: 'Validation error',
      code: 'VALIDATION_ERROR',
    });

    assert.deepEqual(Object.keys(envelope), ['status', 'code', 'message', 'validation', 'meta']);
    assert.equal(envelope.validation, validation);
  });

  test('does not serialize empty sections', () => {
    const envelope = createEnvelope({
      code: '',
      message: '',
      pagination: null,
      sort: [],
      filters: [],
      validation: [],
      requestId: '',
      stack: '',
    });

    assert.deepEqual(envelope, { status: 'success', data: null });
  });

  test('ignores sections of a wrong type instead of sending them', () => {
    const envelope = createEnvelope({
      message: { text: 'no' },
      pagination: [1, 2],
      sort: 'newest',
      filters: { name: 'status' },
      validation: 'email',
      requestId: 42,
    });

    assert.deepEqual(envelope, { status: 'success', data: null });
  });

  test('carries the stack in meta next to the request id', () => {
    const envelope = createEnvelope({ code: 'SERVER_ERROR', requestId: 'id', stack: 'Error: boom\n    at handler' });

    assert.deepEqual(envelope.meta, { requestId: 'id', stack: 'Error: boom\n    at handler' });
  });

  test('returns a plain object that JSON serializes as it is', () => {
    const envelope = createEnvelope({ data: { id: 1 }, requestId: 'id' });

    assert.equal(JSON.stringify(envelope), '{"status":"success","data":{"id":1},"meta":{"requestId":"id"}}');
  });
});
