import { HEADER } from '#enums/header.js';
import { buildApp } from '#root/src/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { uuidVersion } from '#utils/id.js';
import assert from 'node:assert/strict';

const REQUEST_ID_VERSION = 7;

// What helmet and cors put on every answer of a route and of the 404 handler: a test of one answer reads past them. A
// refusal of the parser of Node (handleClientError) comes before any hook and carries none of them.
export const SECURITY_HEADERS = Object.freeze([
  'content-security-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
  'referrer-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-dns-prefetch-control',
  'x-download-options',
  'x-frame-options',
  'x-permitted-cross-domain-policies',
  'x-xss-protection',
  'vary',
  'access-control-allow-credentials',
  'access-control-expose-headers',
]);

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

export function describeAnswer(response) {
  return {
    statusCode: response.statusCode,
    body: response.json(),
    retryAfter: response.headers[HEADER.RETRY_AFTER],
    challenge: response.headers['www-authenticate'],
    cacheControl: response.headers['cache-control'],
    cookies: response.headers[HEADER.SET_COOKIE],
  };
}
