import { buildTestApp, errorBody } from '#root/tests/helper/app.js';
import { TEST_ENV } from '#root/tests/helper/config.js';
import { sendRawRequest } from '#root/tests/helper/socket.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PROBE_URL = '/origin-probe';
const PING_URL = '/api/v1/system/ping';
const LOG_URL = '/api/v1/log/error';
const ENCODED_LOG_URL = '/%61pi/v1/log/error';
const UNKNOWN_URL = '/origin-probe/unknown';

const APP_ORIGIN = `https://${TEST_ENV.APP_HOST}`;
const FRONTEND_ORIGIN = 'http://localhost:5173';
const FOREIGN_ORIGIN = 'https://evil.test';

const MUTATING_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });
const PROBE_BODY = Object.freeze({ name: 'probe' });

const LINE_BREAK = '\r\n';
const HEAD_END = '\r\n\r\n';
const ANNOUNCED_BYTES = 1000;

async function buildProbeApp(t) {
  const fastify = await buildTestApp({ env: { APP_CORS_ORIGINS: FRONTEND_ORIGIN } });
  const calls = { hooks: 0, handlers: 0 };

  t.after(() => fastify.close());

  async function countHook() {
    calls.hooks += 1;
  }

  async function countHandler() {
    calls.handlers += 1;

    return { isDone: true };
  }

  // Fastify writes the methods of a route back into the list it is given: a frozen one fails the declaration.
  fastify.route({
    method: [...MUTATING_METHODS],
    url: PROBE_URL,
    onRequest: countHook,
    handler: countHandler,
  });

  return { fastify, calls };
}

function send(fastify, method, headers, { url = PROBE_URL, payload = PROBE_BODY } = {}) {
  return fastify.inject({
    method,
    url,
    headers,
    payload,
  });
}

function sendAll(fastify, headerSets) {
  return Promise.all(MUTATING_METHODS.flatMap((method) => headerSets.map((headers) => send(fastify, method, headers))));
}

function readStatuses(responses) {
  return responses.map((response) => response.statusCode);
}

function assertRefused(responses) {
  responses.forEach((response) => {
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), errorBody(response, 'ORIGIN_ERROR', 'Origin is not allowed'));
  });
}

function toAnnouncedPost(origin) {
  const head = [
    `POST ${PROBE_URL} HTTP/1.1`,
    `Host: ${TEST_ENV.APP_HOST}`,
    `Origin: ${origin}`,
    'Content-Type: application/json',
    `Content-Length: ${ANNOUNCED_BYTES}`,
    'Connection: close',
  ];

  return `${head.join(LINE_BREAK)}${HEAD_END}`;
}

describe('origin check plugin: a mutating request', () => {
  test('with a foreign Origin is refused with 403 ORIGIN_ERROR for POST, PUT, PATCH and DELETE alike, before the onRequest hook of the route and the handler run', async (t) => {
    const { fastify, calls } = await buildProbeApp(t);
    const responses = await sendAll(fastify, [{ origin: FOREIGN_ORIGIN }]);

    assert.equal(responses.length, MUTATING_METHODS.length);
    assertRefused(responses);
    assert.deepEqual(calls, { hooks: 0, handlers: 0 });
  });

  test('with a foreign Origin is refused before its body is read: one over the body limit and broken JSON get the 403, where without Origin they get 413 and 400', async (t) => {
    const { fastify, calls } = await buildProbeApp(t);
    const oversized = { payload: JSON.stringify({ text: 'x'.repeat(fastify.config.app.bodyLimit) }) };
    const broken = { payload: '{"name":' };
    const foreign = { ...JSON_HEADERS, origin: FOREIGN_ORIGIN };
    const [foreignOversized, foreignBroken, oversizedAlone, brokenAlone] = await Promise.all([
      send(fastify, 'POST', foreign, oversized),
      send(fastify, 'PUT', foreign, broken),
      send(fastify, 'POST', JSON_HEADERS, oversized),
      send(fastify, 'PUT', JSON_HEADERS, broken),
    ]);

    assertRefused([foreignOversized, foreignBroken]);
    assert.deepEqual(readStatuses([oversizedAlone, brokenAlone]), [413, 400]);
    assert.deepEqual(calls, { hooks: 2, handlers: 0 });
  });

  test('with a foreign Origin is answered before its body arrives: a POST over a socket that announces a body and sends none gets the 403 at once', async (t) => {
    const { fastify, calls } = await buildProbeApp(t);

    await fastify.listen({ host: '127.0.0.1', port: 0 });

    const received = await sendRawRequest(fastify.server.address().port, toAnnouncedPost(FOREIGN_ORIGIN));
    const [head, body] = received.split(HEAD_END);

    assert.match(head, /^HTTP\/1\.1 403 /);
    assert.equal(JSON.parse(body).code, 'ORIGIN_ERROR');
    assert.deepEqual(calls, { hooks: 0, handlers: 0 });
  });

  test('passes with the origin of the app, with an origin of APP_CORS_ORIGINS, and without Origin and Referer, as a client that is no browser sends it', async (t) => {
    const { fastify, calls } = await buildProbeApp(t);
    const headerSets = [{ origin: APP_ORIGIN }, { origin: FRONTEND_ORIGIN }, {}];
    const responses = await sendAll(fastify, headerSets);

    assert.deepEqual(readStatuses(responses), responses.map(() => 200));
    assert.deepEqual(calls, { hooks: responses.length, handlers: responses.length });
  });

  test('without Origin is judged by the origin of its Referer, and an Origin outweighs the Referer', async (t) => {
    const { fastify } = await buildProbeApp(t);
    const cases = [
      [{ referer: `${FOREIGN_ORIGIN}/page` }, 403],
      [{ referer: `${APP_ORIGIN}/orders/42?tab=items` }, 200],
      [{ referer: `${FRONTEND_ORIGIN}/settings#profile` }, 200],
      [{ origin: FOREIGN_ORIGIN, referer: `${APP_ORIGIN}/orders/42` }, 403],
      [{ origin: APP_ORIGIN, referer: `${FOREIGN_ORIGIN}/page` }, 200],
    ];
    const responses = await Promise.all(cases.map(([headers]) => send(fastify, 'POST', headers)));

    assert.deepEqual(readStatuses(responses), cases.map(([, statusCode]) => statusCode));
  });

  test('with an Origin that names no origin, or the host of the app under another scheme or port, is refused, and one with the default port or in capitals passes as the origin of the app', async (t) => {
    const { fastify } = await buildProbeApp(t);
    const refused = ['null', 'not an origin', `http://${TEST_ENV.APP_HOST}`, `${APP_ORIGIN}:8443`, `https://${TEST_ENV.APP_HOST}.evil.test`];
    const passed = [`${APP_ORIGIN}:443`, APP_ORIGIN.toUpperCase()];
    const responses = await Promise.all([...refused, ...passed].map((origin) => send(fastify, 'PATCH', { origin })));

    assertRefused(responses.slice(0, refused.length));
    assert.deepEqual(readStatuses(responses.slice(refused.length)), passed.map(() => 200));
  });

  test('with a foreign Origin is refused on any path: /%61pi, which the router reads as /api, and a path no route takes', async (t) => {
    const { fastify } = await buildProbeApp(t);
    const [encoded, unknown, encodedAlone, unknownAlone] = await Promise.all([
      send(fastify, 'POST', { origin: FOREIGN_ORIGIN }, { url: ENCODED_LOG_URL }),
      send(fastify, 'DELETE', { origin: FOREIGN_ORIGIN }, { url: UNKNOWN_URL }),
      send(fastify, 'POST', {}, { url: ENCODED_LOG_URL }),
      send(fastify, 'DELETE', {}, { url: UNKNOWN_URL }),
    ]);

    assertRefused([encoded, unknown]);
    assert.deepEqual([encodedAlone, unknownAlone].map((response) => [response.statusCode, response.json().code]), [
      [401, 'AUTHENTICATION_ERROR'],
      [404, 'NOT_FOUND_ERROR'],
    ]);
  });
});

describe('origin check plugin: a request that changes nothing', () => {
  test('with a foreign Origin is not refused for GET, HEAD and OPTIONS: the browser lets the page read none of their answers', async (t) => {
    const { fastify } = await buildProbeApp(t);
    const responses = await Promise.all([
      fastify.inject({ url: PING_URL, headers: { origin: FOREIGN_ORIGIN } }),
      fastify.inject({ method: 'HEAD', url: PING_URL, headers: { origin: FOREIGN_ORIGIN } }),
      fastify.inject({ method: 'OPTIONS', url: LOG_URL, headers: { origin: FOREIGN_ORIGIN, 'access-control-request-method': 'POST' } }),
    ]);

    assert.deepEqual(
      responses.map((response) => [response.statusCode, response.headers['access-control-allow-origin']]),
      [[200, undefined], [200, undefined], [204, undefined]],
    );
  });
});
