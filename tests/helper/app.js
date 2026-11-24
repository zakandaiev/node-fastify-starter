import { HEADER } from '#enums/header.js';
import { buildApp } from '#root/src/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { uuidVersion } from '#utils/id.js';
import assert from 'node:assert/strict';

const REQUEST_ID_VERSION = 7;

export function buildTestApp(overrides) {
  return buildApp({ config: createTestConfig(overrides) });
}

// Every response of the app carries the id the server gave the request: reading it is also the check of that.
export function readRequestId(response) {
  const requestId = response.headers[HEADER.REQUEST_ID];

  assert.equal(uuidVersion(requestId), REQUEST_ID_VERSION);

  return requestId;
}

export function successBody(response, data) {
  return {
    status: 'success',
    data,
    meta: { requestId: readRequestId(response) },
  };
}

export function errorBody(response, code, message) {
  return {
    status: 'error',
    code,
    message,
    meta: { requestId: readRequestId(response) },
  };
}
