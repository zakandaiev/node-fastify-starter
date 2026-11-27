import { handleClientError, handleError } from '#core/error/handler.js';
import { AppError } from '#core/error/index.js';
import { createLogger } from '#core/logger/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createLogSink, forgetLines } from '#root/tests/helper/log.js';
import { sendRawRequest } from '#root/tests/helper/socket.js';
import { uuidVersion } from '#utils/id.js';
import assert from 'node:assert/strict';
import { maxHeaderSize } from 'node:http';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const BAD_URL = '/%FF';
const PING_URL = '/api/v1/system/ping';

const BAD_REQUEST = Object.freeze({ code: 'BAD_REQUEST_ERROR', message: 'Bad request' });
const SERVER_ERROR = Object.freeze({ code: 'SERVER_ERROR', message: 'Server error' });
const SERVICE_UNAVAILABLE = Object.freeze({ code: 'SERVICE_UNAVAILABLE_ERROR', message: 'Service unavailable' });

const LOG_LEVEL_WARN = 40;
const LOG_LEVEL_ERROR = 50;
const REQUEST_FAILED = 'Request failed';
const RESPONSE_STARTED = 'Request failed after the response had started';
const HANDLER_FAILED = 'Error handler failed';
const LOG_DOWN = 'log down';

const DESTROYED_CODE = 'LIGHT_ECONNRESET';
const ALREADY_SENT_CODE = 'FST_ERR_REP_ALREADY_SENT';

const LINE_BREAK = '\r\n';
const HEAD_END = '\r\n\r\n';
const HEADER_SEPARATOR = ': ';
const RESPONSE_START_REGEXP = /(?=HTTP\/1\.1 \d{3} )/;
const STATUS_LINE_REGEXP = /^HTTP\/1\.1 (\d{3}) (.*)$/;
const TEST_TIMEOUT_MS = 15_000;
const SLOW_ROUTE_MS = 100;
const PIPELINE_TIMEOUT_MS = 2000;

// A response that is neither finished nor torn down leaves inject() pending, and node:test waits for it forever.
const SUITE_OPTIONS = Object.freeze({ timeout: TEST_TIMEOUT_MS });

// pino hands an exception of its stream to the caller of the log method.
function createBrokenSink(isRefused) {
  const lines = [];
  const refused = [];
  const stream = {
    write(text) {
      const line = JSON.parse(text);

      if (isRefused(line)) {
        refused.push(line);

        throw new Error(LOG_DOWN);
      }

      lines.push(line);
    },
  };

  return { lines, refused, stream };
}

// "incoming request" has to get through: Fastify writes it before the handler runs, outside any try/catch.
function isHandlerLine({ msg }) {
  return msg === REQUEST_FAILED;
}

function isHandlerOrErrorLine({ msg, level }) {
  return msg === REQUEST_FAILED || level >= LOG_LEVEL_ERROR;
}

async function buildLoggedApp(sink, overrides) {
  const fastify = await buildTestApp({ ...overrides, logger: { level: 'info', stream: sink.stream } });

  forgetLines(sink);

  return fastify;
}

function findFailures(sink) {
  return sink.lines.filter(({ level }) => level >= LOG_LEVEL_WARN);
}

function toItemUrl(idLength) {
  return `/items/${'a'.repeat(idLength)}`;
}

function declareItemRoute(fastify) {
  fastify.get('/items/:id', (request) => ({ id: request.params.id }));
}

function createConstraintStorage() {
  const handlers = new Map();

  return {
    get: (value) => handlers.get(value) ?? null,
    set: (value, handler) => handlers.set(value, handler),
  };
}

// A constraint that is derived through a callback makes the lookup asynchronous:
// its failure is the third error the router hands to frameworkErrors, and the only one with a 5xx status.
function declareConstrainedRoute(fastify) {
  fastify.addConstraintStrategy({
    name: 'tenant',
    storage: createConstraintStorage,
    deriveConstraint(request, context, done) {
      done(new Error('tenant lookup is down'));
    },
  });
  fastify.get('/items', { constraints: { tenant: 'acme' } }, () => ({ isReached: true }));
}

function declareThrowingRoute(fastify, createError) {
  fastify.get('/items', async () => {
    throw createError();
  });
}

// flushHeaders() and not write(): Node keeps a written chunk corked until the next tick,
// so nothing would be on the wire by the time the handler tears the response down.
function startResponse(reply) {
  reply.raw.writeHead(200, { 'content-type': 'text/plain' });
  reply.raw.flushHeaders();
}

function declareStartedRoute(fastify) {
  fastify.get('/items', async (request, reply) => {
    startResponse(reply);

    throw new Error('late failure');
  });
}

// Node refuses a line break in a header value: left on the reply, it would make writeHead() throw
// after the handler has sent its envelope.
function declareRefusedHeaderRoute(fastify) {
  fastify.get('/items', async (request, reply) => {
    reply.raw.setHeader('etag', '"v1"');
    reply.header('cache-control', 'public, max-age=3600');
    reply.header('x-note', 'line\nbreak');

    throw new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
  });
}

// Here Node refuses the answer of the route itself, after its writeHead has marked the response: the reason
// phrase of the first status, no body after a 204 or a 304, chunked framing.
function declareRefusedAnswerRoutes(fastify) {
  fastify.get('/refused/no-content', async (request, reply) => reply.header('x-note', 'line\nbreak').noContent());
  fastify.get('/refused/not-modified', async (request, reply) => reply.header('x-note', 'line\nbreak').code(304).send());
  fastify.get('/refused/created', async (request, reply) => reply.header('x-note', 'line\nbreak').created({ id: 1 }));
  fastify.get('/refused/chunked', async (request, reply) => reply
    .header('transfer-encoding', 'chunked')
    .header('x-note', 'line\nbreak')
    .ok({ id: 1 }));
}

const REFUSED_ANSWER_URLS = Object.freeze(['/refused/no-content', '/refused/not-modified', '/refused/created', '/refused/chunked']);

function raise(value) {
  throw value;
}

function makeUnreadable(error, key) {
  return Object.defineProperty(error, key, {
    get() {
      throw new Error(`${key} cannot be read`);
    },
  });
}

async function listen(fastify) {
  await fastify.listen({ host: '127.0.0.1', port: 0 });

  return fastify.server.address().port;
}

function toRequest(url, { isLast = false, method = 'GET' } = {}) {
  const connection = isLast
    ? `Connection: close${LINE_BREAK}`
    : '';

  return `${method} ${url} HTTP/1.1${LINE_BREAK}Host: localhost${LINE_BREAK}${connection}${LINE_BREAK}`;
}

function parseHeader(line) {
  const separator = line.indexOf(HEADER_SEPARATOR);

  return [line.slice(0, separator).toLowerCase(), line.slice(separator + HEADER_SEPARATOR.length)];
}

function parseResponse(text) {
  const headEnd = text.indexOf(HEAD_END);
  const [statusLine, ...headerLines] = text.slice(0, headEnd).split(LINE_BREAK);
  const [, statusCode, statusMessage] = statusLine.match(STATUS_LINE_REGEXP);

  return {
    statusCode: Number(statusCode),
    statusMessage,
    headers: Object.fromEntries(headerLines.map((line) => parseHeader(line))),
    payload: text.slice(headEnd + HEAD_END.length),
  };
}

function parseResponses(received) {
  return received
    .split(RESPONSE_START_REGEXP)
    .filter((text) => text !== '')
    .map((text) => parseResponse(text));
}

// One connection for all of them: an answer to the next request proves that the previous one left it open.
async function requestInTurn(port, urls) {
  const requests = urls.map((url, index) => toRequest(url, { isLast: index === urls.length - 1 }));

  return parseResponses(await sendRawRequest(port, requests.join('')));
}

// Takes a response of fastify.inject() or one parsed from a socket: it reads only what both have.
function assertEnvelope(response, {
  statusCode,
  statusMessage,
  code,
  message,
}) {
  const requestId = response.headers['x-request-id'];

  assert.equal(response.statusCode, statusCode);
  assert.equal(response.statusMessage, statusMessage);
  assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE);
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.payload)));
  assert.equal(uuidVersion(requestId), 7);
  assert.deepEqual(JSON.parse(response.payload), {
    status: 'error',
    code,
    message,
    meta: { requestId },
  });
}

describe('handleError as frameworkErrors', SUITE_OPTIONS, () => {
  test('answers a URL that cannot be decoded with 400 BAD_REQUEST_ERROR', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const response = await fastify.inject(BAD_URL);

    assertEnvelope(response, { statusCode: 400, statusMessage: 'Bad Request', ...BAD_REQUEST });
  });

  test('answers a path parameter over config.app.maxParamLength with 414 BAD_REQUEST_ERROR', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declareItemRoute(fastify);

    const { maxParamLength } = fastify.config.app;
    const [atLimit, overLimit] = await Promise.all(
      [maxParamLength, maxParamLength + 1].map((idLength) => fastify.inject(toItemUrl(idLength))),
    );

    assert.equal(atLimit.statusCode, 200);
    assertEnvelope(overLimit, { statusCode: 414, statusMessage: 'URI Too Long', ...BAD_REQUEST });
  });

  test('takes the limit of a path parameter from the config', async (t) => {
    const fastify = await buildTestApp({ app: { maxParamLength: 8 } });
    t.after(() => fastify.close());

    declareItemRoute(fastify);

    const [atLimit, overLimit] = await Promise.all([8, 9].map((idLength) => fastify.inject(toItemUrl(idLength))));

    assert.equal(atLimit.statusCode, 200);
    assertEnvelope(overLimit, { statusCode: 414, statusMessage: 'URI Too Long', ...BAD_REQUEST });
  });

  test('answers a failed async constraint with 500 SERVER_ERROR and logs it as an error', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareConstrainedRoute(fastify);

    const response = await fastify.inject('/items');
    const failures = findFailures(sink);

    assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.deepEqual(failures.map(({ msg, level }) => [msg, level]), [[REQUEST_FAILED, LOG_LEVEL_ERROR]]);
  });

  test('generates the request id itself: the one a client sends is ignored', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const response = await fastify.inject({ url: BAD_URL, headers: { 'x-request-id': 'chosen-by-the-client' } });

    assert.equal(uuidVersion(response.headers['x-request-id']), 7);
    assert.equal(response.json().meta.requestId, response.headers['x-request-id']);
  });

  test('tells a developer what is wrong with the URL and attaches no stack to a client error', async (t) => {
    const fastify = await buildTestApp({ env: { APP_MODE: 'dev' } });
    t.after(() => fastify.close());

    const response = await fastify.inject(BAD_URL);

    assertEnvelope(response, {
      statusCode: 400,
      statusMessage: 'Bad Request',
      code: 'BAD_REQUEST_ERROR',
      message: "'/%FF' is not a valid url component",
    });
  });

  test('logs the failure once, as a warning under the id of the request', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const response = await fastify.inject(BAD_URL);
    const failures = findFailures(sink);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].msg, REQUEST_FAILED);
    assert.equal(failures[0].level, LOG_LEVEL_WARN);
    assert.equal(failures[0].requestId, response.headers['x-request-id']);
    assert.equal(failures[0].err.code, 'FST_ERR_BAD_URL');
  });

  test('writes the reason phrase of the status and keeps the connection open', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declareItemRoute(fastify);

    const port = await listen(fastify);
    const responses = await requestInTurn(port, [BAD_URL, toItemUrl(fastify.config.app.maxParamLength + 1), PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [400, 414, 200]);
    assertEnvelope(responses[0], { statusCode: 400, statusMessage: 'Bad Request', ...BAD_REQUEST });
    assertEnvelope(responses[1], { statusCode: 414, statusMessage: 'URI Too Long', ...BAD_REQUEST });
  });
});

describe('handleError as frameworkErrors, when its log line is refused', SUITE_OPTIONS, () => {
  test('still answers a bad URL: a raw 400 envelope with its length and the request id', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const response = await fastify.inject(BAD_URL);

    assertEnvelope(response, { statusCode: 400, statusMessage: 'Bad Request', ...BAD_REQUEST });
    assert.deepEqual(sink.refused.map(({ msg }) => msg), [REQUEST_FAILED]);
  });

  test('keeps 414 for a path parameter over the limit', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareItemRoute(fastify);

    const response = await fastify.inject(toItemUrl(fastify.config.app.maxParamLength + 1));

    assertEnvelope(response, { statusCode: 414, statusMessage: 'URI Too Long', ...BAD_REQUEST });
    assert.deepEqual(sink.refused.map(({ msg }) => msg), [REQUEST_FAILED]);
  });

  test('answers a failed async constraint with a raw 500 SERVER_ERROR', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareConstrainedRoute(fastify);

    const response = await fastify.inject('/items');

    assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.deepEqual(sink.refused.map(({ msg }) => msg), [REQUEST_FAILED]);
  });

  test('logs what broke it at the error level, under the id of the request', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const response = await fastify.inject(BAD_URL);
    const failures = findFailures(sink);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].msg, HANDLER_FAILED);
    assert.equal(failures[0].level, LOG_LEVEL_ERROR);
    assert.equal(failures[0].requestId, response.headers['x-request-id']);
    assert.equal(failures[0].err.message, LOG_DOWN);
  });

  test('keeps the process alive and the connection open on a real socket', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareItemRoute(fastify);

    const port = await listen(fastify);
    const responses = await requestInTurn(port, [BAD_URL, toItemUrl(fastify.config.app.maxParamLength + 1), PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [400, 414, 200]);
    assertEnvelope(responses[0], { statusCode: 400, statusMessage: 'Bad Request', ...BAD_REQUEST });
    assertEnvelope(responses[1], { statusCode: 414, statusMessage: 'URI Too Long', ...BAD_REQUEST });
    assert.deepEqual(sink.refused.map(({ msg }) => msg), [REQUEST_FAILED, REQUEST_FAILED]);
  });

  test('answers when its own failure cannot be logged either', async (t) => {
    const sink = createBrokenSink(isHandlerOrErrorLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    // Only an instance that has served a request rejects inject() with what escapes frameworkErrors:
    // before that the exception is lost and the test would pass on the answer alone.
    await fastify.inject(PING_URL);

    const response = await fastify.inject(BAD_URL);

    assertEnvelope(response, { statusCode: 400, statusMessage: 'Bad Request', ...BAD_REQUEST });
    assert.deepEqual(sink.refused.map(({ msg }) => msg), [REQUEST_FAILED, HANDLER_FAILED]);
  });

  test('survives a log that refuses every error on a real socket', async (t) => {
    const sink = createBrokenSink(isHandlerOrErrorLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const port = await listen(fastify);
    const responses = await requestInTurn(port, [BAD_URL, PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [400, 200]);
    assertEnvelope(responses[0], { statusCode: 400, statusMessage: 'Bad Request', ...BAD_REQUEST });
    assert.deepEqual(sink.refused.map(({ msg }) => msg), [REQUEST_FAILED, HANDLER_FAILED]);
  });
});

describe('handleError on a route, when its log line is refused', SUITE_OPTIONS, () => {
  test('answers an unknown error with a raw 500 SERVER_ERROR, not with the body of Fastify', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareThrowingRoute(fastify, () => new Error('the database is on fire'));

    const response = await fastify.inject('/items');

    assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.deepEqual(sink.refused.map(({ msg }) => msg), [REQUEST_FAILED]);
  });

  test('keeps the status of a client error and reports it as BAD_REQUEST_ERROR', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareThrowingRoute(fastify, () => new AppError(ERROR_CODE.NOT_FOUND_ERROR));

    const response = await fastify.inject('/items');

    assertEnvelope(response, { statusCode: 404, statusMessage: 'Not Found', ...BAD_REQUEST });
    assert.deepEqual(sink.refused.map(({ msg }) => msg), [REQUEST_FAILED]);
  });

  test('answers 500 SERVER_ERROR for every status that is not a 4xx, an overload included', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const codes = [ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, ERROR_CODE.UPSTREAM_ERROR];

    codes.forEach((code) => {
      fastify.get(`/items/${code}`, async () => {
        throw new AppError(code);
      });
    });

    const responses = await Promise.all(codes.map((code) => fastify.inject(`/items/${code}`)));

    responses.forEach((response) => {
      assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    });
  });

  test('logs what broke it at the error level, under the id of the request', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareThrowingRoute(fastify, () => new Error('the database is on fire'));

    const response = await fastify.inject('/items');
    const failures = findFailures(sink);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].msg, HANDLER_FAILED);
    assert.equal(failures[0].level, LOG_LEVEL_ERROR);
    assert.equal(failures[0].requestId, response.headers['x-request-id']);
    assert.equal(failures[0].err.message, LOG_DOWN);
  });

  test('sends none of the headers the route had set', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    fastify.get('/items', async (request, reply) => {
      reply.header('cache-control', 'public, max-age=3600');
      reply.raw.setHeader('etag', '"v1"');

      throw new Error('the database is on fire');
    });

    const response = await fastify.inject('/items');

    assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers.etag, undefined);
  });

  test('keeps the rule of the status: a foreign 401 or 403 is a 400, a failed body a 422, a failed parameter a 404', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    fastify.get('/foreign/:statusCode', async (request) => {
      throw Object.assign(new Error('Refused by a plugin'), { statusCode: Number(request.params.statusCode) });
    });
    fastify.post('/items', { schema: { body: { type: 'object', required: ['name'] } } }, async () => ({ isReached: true }));
    fastify.get('/items/:id', { schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } } }, async () => ({ isReached: true }));

    const [unauthorized, forbidden, body, params] = await Promise.all([
      fastify.inject('/foreign/401'),
      fastify.inject('/foreign/403'),
      fastify.inject({ method: 'POST', url: '/items', payload: {} }),
      fastify.inject('/items/abc'),
    ]);

    assertEnvelope(unauthorized, { statusCode: 400, statusMessage: 'Bad Request', ...BAD_REQUEST });
    assertEnvelope(forbidden, { statusCode: 400, statusMessage: 'Bad Request', ...BAD_REQUEST });
    assertEnvelope(body, { statusCode: 422, statusMessage: 'Unprocessable Entity', ...BAD_REQUEST });
    assertEnvelope(params, { statusCode: 404, statusMessage: 'Not Found', ...BAD_REQUEST });
    assert.equal(sink.refused.length, 4);
  });

  test('answers on a real socket under the reason phrase of its status and serves the next request', async (t) => {
    const sink = createBrokenSink(isHandlerOrErrorLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    fastify.get('/items', async (request, reply) => {
      reply.header('cache-control', 'public, max-age=3600');
      reply.raw.setHeader('etag', '"v1"');

      throw new Error('the database is on fire');
    });

    const port = await listen(fastify);
    const responses = await requestInTurn(port, ['/items', PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [500, 200]);
    assertEnvelope(responses[0], { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.equal(responses[0].headers['cache-control'], 'no-store');
    assert.equal(responses[0].headers.etag, undefined);
    assert.deepEqual(sink.refused.map(({ msg }) => msg), [REQUEST_FAILED, HANDLER_FAILED]);
  });
});

describe('handleError when the route had set a header Node refuses', SUITE_OPTIONS, () => {
  test('drops that header and answers the envelope of the error under its own status', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declareRefusedHeaderRoute(fastify);

    const response = await fastify.inject('/items');

    assertEnvelope(response, { statusCode: 503, statusMessage: 'Service Unavailable', ...SERVICE_UNAVAILABLE });
    assert.equal(response.headers['retry-after'], '60');
    assert.equal(response.headers['x-note'], undefined);
  });

  test('keeps the other headers of the route, except its caching policy', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declareRefusedHeaderRoute(fastify);

    const response = await fastify.inject('/items');

    assert.equal(response.headers.etag, '"v1"');
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  test('answers the same way on a real socket and serves the next request', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declareRefusedHeaderRoute(fastify);

    const port = await listen(fastify);
    const responses = await requestInTurn(port, ['/items', PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [503, 200]);
    assertEnvelope(responses[0], { statusCode: 503, statusMessage: 'Service Unavailable', ...SERVICE_UNAVAILABLE });
    assert.equal(responses[0].headers['x-note'], undefined);
  });

  test('logs the error of the route once and no failure of its own', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareRefusedHeaderRoute(fastify);

    const response = await fastify.inject('/items');
    const failures = findFailures(sink);

    assert.deepEqual(failures.map(({ msg, level }) => [msg, level]), [[REQUEST_FAILED, LOG_LEVEL_WARN]]);
    assert.equal(failures[0].err.code, 'SERVICE_UNAVAILABLE_ERROR');
    assert.equal(failures[0].requestId, response.headers['x-request-id']);
  });

  // On a socket: inject() writes a list with an undefined item as the text "undefined", Node refuses it.
  test('drops a list of values that holds one Node refuses, left by the route or brought by the error', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const sparse = [];

    sparse[1] = 'b';

    fastify.get('/items', async (request, reply) => {
      reply.header('set-cookie', ['sid=1; HttpOnly', undefined]);
      reply.header('x-holes', sparse);
      reply.header('x-kept', ['a', 'b']);

      throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR, {
        headers: { 'x-list': ['a', undefined], 'x-hole-list': sparse, 'x-copied': ['c', 'd'] },
      });
    });

    const port = await listen(fastify);
    const responses = await requestInTurn(port, ['/items', PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [401, 200]);
    assertEnvelope(responses[0], {
      statusCode: 401,
      statusMessage: 'Unauthorized',
      code: 'AUTHENTICATION_ERROR',
      message: 'Authentication error',
    });
    assert.equal(responses[0].headers['set-cookie'], undefined);
    assert.equal(responses[0].headers['x-list'], undefined);
    assert.equal(responses[0].headers['x-holes'], undefined);
    assert.equal(responses[0].headers['x-hole-list'], undefined);
    assert.equal(responses[0].headers['x-kept'], 'b');
    assert.equal(responses[0].headers['x-copied'], 'd');
    assert.deepEqual(findFailures(sink).map(({ msg }) => msg), [REQUEST_FAILED]);
  });

  test('drops the Trailer of a chunked answer that never came, from the route and from the error', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    fastify.get('/items', async (request, reply) => {
      reply.header('transfer-encoding', 'chunked');
      reply.header('trailer', 'x-checksum');

      throw new AppError(ERROR_CODE.NOT_FOUND_ERROR, { headers: { Trailer: 'x-digest' } });
    });

    const port = await listen(fastify);
    const responses = await requestInTurn(port, ['/items', PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [404, 200]);
    assertEnvelope(responses[0], {
      statusCode: 404,
      statusMessage: 'Not Found',
      code: 'NOT_FOUND_ERROR',
      message: 'Not found',
    });
    assert.equal(responses[0].headers.trailer, undefined);
    assert.equal(responses[0].headers['transfer-encoding'], undefined);
    assert.deepEqual(findFailures(sink).map(({ msg }) => msg), [REQUEST_FAILED]);
  });
});

// Only a real socket shows it: inject() reads the body from the response object, not from the wire.
describe('handleError when Node refuses the answer of the route itself', SUITE_OPTIONS, () => {
  test('answers a whole envelope under the reason phrase of 500, whatever the refused answer was', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declareRefusedAnswerRoutes(fastify);

    const port = await listen(fastify);
    const responses = await requestInTurn(port, [...REFUSED_ANSWER_URLS, PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [500, 500, 500, 500, 200]);
    responses.slice(0, -1).forEach((response) => {
      assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
      assert.equal(response.headers['transfer-encoding'], undefined);
      assert.equal(response.headers['x-note'], undefined);
    });
  });

  test('answers the same when its log line is refused and the raw answer takes over', async (t) => {
    const sink = createBrokenSink(isHandlerOrErrorLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareRefusedAnswerRoutes(fastify);

    const port = await listen(fastify);
    const responses = await requestInTurn(port, [...REFUSED_ANSWER_URLS, PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [500, 500, 500, 500, 200]);
    responses.slice(0, -1).forEach((response) => {
      assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
      assert.equal(response.headers['transfer-encoding'], undefined);
    });
    assert.equal(sink.refused.filter(({ msg }) => msg === REQUEST_FAILED).length, REFUSED_ANSWER_URLS.length);
  });

  // The raw answer writes the body itself: on the other road Fastify drops it for the HEAD twin of a route.
  test('still sends no body to a HEAD request, on either road', async (t) => {
    const sink = createBrokenSink(isHandlerOrErrorLine);
    const apps = await Promise.all([buildTestApp(), buildLoggedApp(sink)]);
    t.after(() => Promise.all(apps.map((fastify) => fastify.close())));

    const answers = await Promise.all(apps.map(async (fastify) => {
      declareRefusedAnswerRoutes(fastify);

      const port = await listen(fastify);
      const requests = [toRequest('/refused/created', { method: 'HEAD' }), toRequest(PING_URL, { isLast: true })];

      return parseResponses(await sendRawRequest(port, requests.join('')));
    }));

    answers.forEach(([head, ping]) => {
      assert.equal(head.statusCode, 500);
      assert.equal(head.statusMessage, 'Internal Server Error');
      assert.equal(head.payload, '');
      assert.equal(ping.statusCode, 200);
    });
    assert.equal(sink.refused.filter(({ msg }) => msg === REQUEST_FAILED).length, 1);
  });

  // For the twin of a GET route Fastify drops the body itself; a HEAD route declared by hand has only Node to rely on.
  test('sends no body to a HEAD route that is declared by hand', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.head('/refused/head', async (request, reply) => reply.header('x-note', 'line\nbreak').code(200).send());

    const port = await listen(fastify);
    const requests = [toRequest('/refused/head', { method: 'HEAD' }), toRequest(PING_URL, { isLast: true })];
    const [head, ping] = parseResponses(await sendRawRequest(port, requests.join('')));

    assert.equal(head.statusCode, 500);
    assert.equal(head.statusMessage, 'Internal Server Error');
    assert.equal(head.payload, '');
    assert.equal(ping.statusCode, 200);
    assert.deepEqual(JSON.parse(ping.payload).data, { isAlive: true });
  });
});

describe('handleError after the response has started', SUITE_OPTIONS, () => {
  test('tears the response down instead of appending JSON to it', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declareStartedRoute(fastify);

    await assert.rejects(fastify.inject('/items'), { code: DESTROYED_CODE });
  });

  test('logs the error once, at the error level', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareStartedRoute(fastify);

    await assert.rejects(fastify.inject('/items'), { code: DESTROYED_CODE });

    const failures = findFailures(sink);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].msg, RESPONSE_STARTED);
    assert.equal(failures[0].level, LOG_LEVEL_ERROR);
    assert.equal(failures[0].err.message, 'late failure');
    assert.equal(uuidVersion(failures[0].requestId), 7);
  });

  test('leaves a real client with the started headers and a closed connection, and serves the next one', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declareStartedRoute(fastify);

    const port = await listen(fastify);
    const started = parseResponses(await sendRawRequest(port, toRequest('/items')));
    const [ping] = await requestInTurn(port, [PING_URL]);

    assert.equal(started.length, 1);
    assert.equal(started[0].statusCode, 200);
    assert.equal(started[0].headers['content-type'], 'text/plain');
    assert.equal(started[0].payload, '');
    assert.equal(ping.statusCode, 200);
  });

  test('tears the response down even when the log refuses the line', async (t) => {
    const sink = createBrokenSink(isHandlerOrErrorLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareStartedRoute(fastify);

    await assert.rejects(fastify.inject('/items'), { code: DESTROYED_CODE });

    assert.deepEqual(sink.refused.map(({ msg }) => msg), [RESPONSE_STARTED, HANDLER_FAILED]);
  });

  // A response behind another one in a pipeline has no socket yet: destroy() alone closes nothing there,
  // and Node would later write the started head and leave the connection open for good.
  test('closes the connection when the started response waits in a pipeline, on either road', async (t) => {
    const sink = createBrokenSink(isHandlerOrErrorLine);
    const apps = await Promise.all([buildTestApp(), buildLoggedApp(sink)]);
    t.after(() => Promise.all(apps.map((fastify) => fastify.close())));

    const answers = await Promise.all(apps.map(async (fastify) => {
      declareStartedRoute(fastify);
      fastify.get('/slow', async () => {
        await sleep(SLOW_ROUTE_MS);

        return { isSlow: true };
      });

      const port = await listen(fastify);
      const requests = [toRequest('/slow'), toRequest('/items'), toRequest(PING_URL)];

      return sendRawRequest(port, requests.join(''), { timeoutMs: PIPELINE_TIMEOUT_MS });
    }));

    answers.forEach((received) => {
      const [slow, ...rest] = parseResponses(received);

      assert.equal(slow.statusCode, 200);
      assert.deepEqual(JSON.parse(slow.payload), { isSlow: true });
      assert.equal(rest.some(({ payload }) => payload.includes('"isAlive"')), false);
    });
  });
});

describe('handleError after the response was sent', SUITE_OPTIONS, () => {
  test('leaves the answer of the route as it is', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/items/sync', (request, reply) => {
      reply.send({ isDone: true });

      throw new Error('after the answer');
    });
    fastify.get('/items/async', async (request, reply) => {
      reply.send({ isDone: true });

      throw new Error('after the answer');
    });

    const responses = await Promise.all(['/items/sync', '/items/async'].map((url) => fastify.inject(url)));

    responses.forEach((response) => {
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { isDone: true });
    });
  });

  test('puts nothing on the wire after that answer and keeps the connection open', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/items', async (request, reply) => {
      reply.send({ isDone: true });

      throw new Error('after the answer');
    });

    const port = await listen(fastify);
    const responses = await requestInTurn(port, ['/items', PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [200, 200]);
    assert.equal(responses[0].payload, '{"isDone":true}');
  });

  test('does nothing to a reply that was sent when it is called for it', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    fastify.get('/items', (request, reply) => {
      reply.send({ isDone: true });
      handleError(new Error('after the answer'), request, reply);
    });

    const port = await listen(fastify);
    const responses = await requestInTurn(port, ['/items', PING_URL]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [200, 200]);
    assert.equal(responses[0].payload, '{"isDone":true}');
    assert.deepEqual(sink.lines.filter(({ err }) => err?.code === ALREADY_SENT_CODE), []);
  });
});

describe('handleError', SUITE_OPTIONS, () => {
  test('ends without a value, whatever it did to the reply', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const returned = {};

    fastify.get('/items/answered', (request, reply) => {
      returned.answered = handleError(new Error('boom'), request, reply);
    });
    fastify.get('/items/sent', (request, reply) => {
      reply.send({ isDone: true });
      returned.sent = handleError(new Error('boom'), request, reply);
    });
    fastify.get('/items/started', (request, reply) => {
      startResponse(reply);
      returned.started = handleError(new Error('boom'), request, reply);
    });

    const [answered, sent] = await Promise.all(['/items/answered', '/items/sent'].map((url) => fastify.inject(url)));
    await assert.rejects(fastify.inject('/items/started'), { code: DESTROYED_CODE });

    assert.deepEqual(returned, { answered: undefined, sent: undefined, started: undefined });
    assertEnvelope(answered, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.deepEqual(sent.json(), { isDone: true });
  });

  test('ends without a value when it had to fall back to the raw answer', async (t) => {
    const sink = createBrokenSink(isHandlerLine);
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const returned = [];

    fastify.get('/items', (request, reply) => {
      returned.push(handleError(new Error('boom'), request, reply));
    });

    const response = await fastify.inject('/items');

    assert.deepEqual(returned, [undefined]);
    assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.deepEqual(sink.refused.map(({ msg }) => msg), [REQUEST_FAILED]);
  });

  test('leaves nothing for Fastify to send after the envelope', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareThrowingRoute(fastify, () => new Error('boom'));

    const response = await fastify.inject('/items');

    assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.deepEqual(findFailures(sink).map(({ msg }) => msg), [REQUEST_FAILED]);
    assert.deepEqual(sink.lines.filter(({ err }) => err?.code === ALREADY_SENT_CODE), []);
  });
});

// The log is on in every test of this group: with the level "silent" pino never walks the error,
// and its serializer is one more place a hostile error can break.
describe('handleError with a hostile error', SUITE_OPTIONS, () => {
  test('ignores headers of an error that are not an object', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const hostileHeaders = ['content-range: bytes */100', [['content-range', 'bytes */100']]];

    hostileHeaders.forEach((headers, index) => {
      fastify.get(`/items/${index}`, async () => {
        throw Object.assign(new Error('Range Not Satisfiable'), { statusCode: 416, headers });
      });
    });

    const responses = await Promise.all(hostileHeaders.map((headers, index) => fastify.inject(`/items/${index}`)));

    responses.forEach((response) => {
      assertEnvelope(response, { statusCode: 416, statusMessage: 'Range Not Satisfiable', ...BAD_REQUEST });
      assert.equal(response.headers['content-range'], undefined);
      assert.equal(response.headers['0'], undefined);
    });
  });

  test('copies headers of an error that have no prototype', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareThrowingRoute(fastify, () => Object.assign(new Error('Range Not Satisfiable'), {
      statusCode: 416,
      headers: Object.assign(Object.create(null), { 'content-range': 'bytes */100' }),
    }));

    const response = await fastify.inject('/items');

    assertEnvelope(response, { statusCode: 416, statusMessage: 'Range Not Satisfiable', ...BAD_REQUEST });
    assert.equal(response.headers['content-range'], 'bytes */100');
  });

  test('answers a frozen error with 500 SERVER_ERROR and logs what it says', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareThrowingRoute(fastify, () => Object.freeze(new Error('frozen failure')));

    const response = await fastify.inject('/items');
    const failures = findFailures(sink);

    assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].msg, REQUEST_FAILED);
    assert.equal(failures[0].level, LOG_LEVEL_ERROR);
    assert.equal(failures[0].err.message, 'frozen failure');
  });

  test('does not fail on a thrown value that is not an error: 500 SERVER_ERROR and one error line each', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const thrown = [null, undefined, 'a string', 42];

    thrown.forEach((value, index) => {
      fastify.get(`/items/${index}`, async () => raise(value));
    });

    const responses = await Promise.all(thrown.map((value, index) => fastify.inject(`/items/${index}`)));

    responses.forEach((response) => {
      assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    });
    assert.deepEqual(
      findFailures(sink).map(({ msg, level }) => [msg, level]),
      thrown.map(() => [REQUEST_FAILED, LOG_LEVEL_ERROR]),
    );
  });

  test('keeps the status of a client error whose headers cannot be read', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareThrowingRoute(fastify, () => makeUnreadable(Object.assign(new Error('Gone'), { statusCode: 410 }), 'headers'));

    const response = await fastify.inject('/items');

    assertEnvelope(response, { statusCode: 410, statusMessage: 'Gone', ...BAD_REQUEST });
  });

  test('answers 500 SERVER_ERROR when the status of the error cannot be read', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    declareThrowingRoute(fastify, () => makeUnreadable(new Error('hostile'), 'statusCode'));

    const response = await fastify.inject('/items');

    assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.equal(sink.lines.filter(({ level }) => level === LOG_LEVEL_ERROR).length, 1);
  });

  test('answers 500 SERVER_ERROR to a thrown value none of whose properties can be read', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declareThrowingRoute(fastify, () => new Proxy({}, {
      get() {
        throw new Error('unreadable');
      },
    }));

    const response = await fastify.inject('/items');

    assertEnvelope(response, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
  });

  test('keeps serving on a real socket after an error whose status cannot be read', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declareThrowingRoute(fastify, () => makeUnreadable(new Error('hostile'), 'statusCode'));

    const port = await listen(fastify);
    const [answer, ping] = await requestInTurn(port, ['/items', PING_URL]);

    assertEnvelope(answer, { statusCode: 500, statusMessage: 'Internal Server Error', ...SERVER_ERROR });
    assert.equal(ping.statusCode, 200);
  });
});

// The parser of Node refuses these before a route, a hook or a reply exists: Fastify hands them to
// clientErrorHandler together with the bare socket.
describe('handleClientError', SUITE_OPTIONS, () => {
  function createSocket({ isWritable = true, isDestroyed = false, write } = {}) {
    const written = [];
    const destroyedWith = [];

    return {
      written,
      destroyedWith,
      writable: isWritable,
      destroyed: isDestroyed,
      write: write ?? ((text) => written.push(text)),
      destroy(error) {
        destroyedWith.push(error);
        this.destroyed = true;
      },
    };
  }

  function createParserError(code) {
    return Object.assign(new Error('Parse Error'), { code, rawPacket: Buffer.from('GET / HTTP/1.1 cookie: sid=secret') });
  }

  function handle(error, socket, sink = createLogSink()) {
    const log = createLogger({ level: 'info', stream: sink.stream });

    return { result: handleClientError.call({ log }, error, socket), sink };
  }

  test('answers a request the parser cannot read with a 400 envelope and closes the connection', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const port = await listen(fastify);
    const requests = [`GARBAGE${HEAD_END}`, `GET ${PING_URL} HTTP/1.1${LINE_BREAK}Host localhost${HEAD_END}`];
    const answers = await Promise.all(requests.map((request) => sendRawRequest(port, request)));

    answers.forEach((received) => {
      const responses = parseResponses(received);

      assert.equal(responses.length, 1);
      assertEnvelope(responses[0], { statusCode: 400, statusMessage: 'Bad Request', ...BAD_REQUEST });
      assert.equal(responses[0].headers.connection, 'close');
      assert.equal(responses[0].headers['cache-control'], 'no-store');
    });

    const [ping] = await requestInTurn(port, [PING_URL]);

    assert.equal(ping.statusCode, 200);
  });

  // Barely over the limit and in one write: the server has read every byte before it closes, so no reset eats the answer.
  test('answers headers over the limit of Node with a 431 envelope', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const port = await listen(fastify);
    const request = `GET ${PING_URL} HTTP/1.1${LINE_BREAK}Host: localhost${LINE_BREAK}X-Fill: ${'a'.repeat(maxHeaderSize)}${HEAD_END}`;
    const [response] = parseResponses(await sendRawRequest(port, request));

    assertEnvelope(response, { statusCode: 431, statusMessage: 'Request Header Fields Too Large', ...BAD_REQUEST });
    assert.equal(response.headers.connection, 'close');
  });

  test('logs the refusal once, as a warning under the id it answered with, and without the bytes of the request', async (t) => {
    const sink = createLogSink();
    const fastify = await buildLoggedApp(sink);
    t.after(() => fastify.close());

    const port = await listen(fastify);
    const [response] = parseResponses(await sendRawRequest(port, `GARBAGE${HEAD_END}`));
    const failures = findFailures(sink);

    assert.deepEqual(failures.map(({ msg, level }) => [msg, level]), [['Connection closed on a client error', LOG_LEVEL_WARN]]);
    assert.equal(failures[0].requestId, response.headers['x-request-id']);
    assert.equal(failures[0].err.code, 'HPE_INVALID_METHOD');
    assert.match(failures[0].err.rawPacket, /^\[Buffer of \d+ bytes\]$/);
  });

  test('answers 408 to a request that timed out, 431 to headers and 413 to chunk extensions over the limit of Node', () => {
    const payloadTooLarge = { code: 'PAYLOAD_TOO_LARGE_ERROR', message: 'Payload too large' };
    const cases = [
      ['ERR_HTTP_REQUEST_TIMEOUT', 'HTTP/1.1 408 Request Timeout', BAD_REQUEST],
      ['HPE_HEADER_OVERFLOW', 'HTTP/1.1 431 Request Header Fields Too Large', BAD_REQUEST],
      ['HPE_CHUNK_EXTENSIONS_OVERFLOW', 'HTTP/1.1 413 Payload Too Large', payloadTooLarge],
      ['HPE_INVALID_METHOD', 'HTTP/1.1 400 Bad Request', BAD_REQUEST],
      ['constructor', 'HTTP/1.1 400 Bad Request', BAD_REQUEST],
      [undefined, 'HTTP/1.1 400 Bad Request', BAD_REQUEST],
    ];

    cases.forEach(([code, statusLine, expected]) => {
      const socket = createSocket();
      const error = createParserError(code);
      const { result } = handle(error, socket);
      const [response] = parseResponses(socket.written.join(''));

      assert.equal(result, true);
      assert.equal(socket.written.join('').split(LINE_BREAK)[0], statusLine);
      assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.payload)));
      assert.deepEqual(JSON.parse(response.payload), {
        status: 'error',
        ...expected,
        meta: { requestId: response.headers['x-request-id'] },
      });
      assert.deepEqual(socket.destroyedWith, [error]);
    });
  });

  test('writes nothing over a response in flight whose head has gone out, and answers one that has not started', () => {
    const error = createParserError('HPE_INVALID_METHOD');
    const started = Object.assign(createSocket(), { _httpMessage: { _headerSent: true } });
    const waiting = Object.assign(createSocket(), { _httpMessage: { _headerSent: false } });

    handle(error, started);
    handle(error, waiting);

    assert.deepEqual(started.written, []);
    assert.deepEqual(started.destroyedWith, [error]);
    assert.equal(parseResponses(waiting.written.join(''))[0].statusCode, 400);
    assert.deepEqual(waiting.destroyedWith, [error]);
  });

  test('does not put its envelope into a response that has started when garbage follows on the same connection', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/stream', (request, reply) => {
      startResponse(reply);
    });

    const port = await listen(fastify);
    const received = await sendRawRequest(port, toRequest('/stream'), { followUp: `GARBAGE${HEAD_END}` });
    const [started, ...rest] = parseResponses(received);

    assert.equal(started.statusCode, 200);
    assert.equal(started.headers['content-type'], 'text/plain');
    assert.deepEqual(rest, []);
    assert.equal(received.includes('BAD_REQUEST_ERROR'), false);
  });

  test('does nothing for a connection that was reset or is destroyed already', () => {
    const reset = createSocket();
    const destroyed = createSocket({ isDestroyed: true });
    const first = handle(createParserError('ECONNRESET'), reset);
    const second = handle(createParserError('HPE_INVALID_METHOD'), destroyed);

    [first, second].forEach(({ result, sink }) => {
      assert.equal(result, false);
      assert.deepEqual(sink.lines, []);
    });
    [reset, destroyed].forEach((socket) => {
      assert.deepEqual(socket.written, []);
      assert.deepEqual(socket.destroyedWith, []);
    });
  });

  test('writes nothing to a socket that cannot be written to, and still closes it', () => {
    const socket = createSocket({ isWritable: false });
    const error = createParserError('HPE_INVALID_METHOD');

    handle(error, socket);

    assert.deepEqual(socket.written, []);
    assert.deepEqual(socket.destroyedWith, [error]);
  });

  test('never throws: a socket that refuses the write and a log that refuses the line still end in a closed connection', () => {
    const failing = createSocket({
      write() {
        throw new Error('write EPIPE');
      },
    });
    const answered = createSocket();
    const error = createParserError('HPE_INVALID_METHOD');
    const brokenSink = createBrokenSink(() => true);

    assert.doesNotThrow(() => handle(error, failing));
    assert.doesNotThrow(() => handle(error, answered, brokenSink));
    assert.deepEqual(failing.destroyedWith, [error]);
    assert.deepEqual(answered.destroyedWith, [error]);
    assert.equal(parseResponses(answered.written.join(''))[0].statusCode, 400);
    assert.equal(brokenSink.refused.length, 1);
  });

  test('never throws on what it was not built for: no instance to log with, an error or a socket that cannot be read', () => {
    const error = createParserError('HPE_INVALID_METHOD');
    const unbound = createSocket();
    const unreadableError = createSocket();
    const undestroyable = Object.assign(createSocket(), {
      destroy() {
        throw new Error('destroy failed');
      },
    });
    const unreadableSocket = Object.defineProperty(createSocket(), 'destroyed', {
      get() {
        throw new Error('destroyed cannot be read');
      },
    });
    const hostileError = Object.defineProperty(new Error('Parse Error'), 'code', {
      get() {
        throw new Error('code cannot be read');
      },
    });

    assert.doesNotThrow(() => handleClientError.call(undefined, error, unbound));
    assert.doesNotThrow(() => handle(hostileError, unreadableError));
    assert.doesNotThrow(() => handle(error, undestroyable));
    assert.doesNotThrow(() => handle(error, unreadableSocket));
    assert.doesNotThrow(() => handle(error, null));
    assert.doesNotThrow(() => handle(undefined, createSocket()));
    assert.equal(parseResponses(unbound.written.join(''))[0].statusCode, 400);
    assert.deepEqual(unbound.destroyedWith, [error]);
    assert.deepEqual(unreadableError.destroyedWith, [hostileError]);
    assert.deepEqual(unreadableSocket.destroyedWith, [error]);
  });

  test('sends a Date with its answer, as every response of the server has one', () => {
    const socket = createSocket();

    handle(createParserError('HPE_INVALID_METHOD'), socket);

    const [response] = parseResponses(socket.written.join(''));

    assert.equal(new Date(response.headers.date).toUTCString(), response.headers.date);
  });
});
