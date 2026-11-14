import { readRequestId } from '#root/tests/helper/app.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

function createResponse(requestId) {
  return { headers: { 'x-request-id': requestId } };
}

describe('readRequestId', () => {
  test('returns the id the response carries in X-Request-Id', () => {
    const requestId = uuidv7();

    assert.equal(readRequestId(createResponse(requestId)), requestId);
  });

  test('fails the test for a response without the header or with an id that is not a UUIDv7', () => {
    [undefined, '', 'req-1', randomUUID(), uuidv7().toUpperCase()].forEach((requestId) => {
      assert.throws(() => readRequestId(createResponse(requestId)), String(requestId));
    });
    assert.throws(() => readRequestId({ headers: {} }));
  });
});
