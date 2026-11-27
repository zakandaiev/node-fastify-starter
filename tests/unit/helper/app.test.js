import { buildTestApp, readRequestId, SECURITY_HEADERS } from '#root/tests/helper/app.js';
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

describe('SECURITY_HEADERS', () => {
  test('names the headers that helmet and cors put on an answer of a route and of the 404 handler alike', async (t) => {
    const fastify = await buildTestApp();

    t.after(() => fastify.close());

    const responses = await Promise.all(['/health/live', '/nothing/here'].map((url) => fastify.inject(url)));

    responses.forEach((response) => {
      assert.deepEqual(SECURITY_HEADERS.filter((name) => response.headers[name] === undefined), [], response.req?.url);
    });
  });
});
