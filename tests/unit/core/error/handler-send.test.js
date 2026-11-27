import { MODE } from '#config/env.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import {
  accept,
  createAlertReceiver,
  NO_THROTTLE,
  readBlock,
  readTitles,
} from '#root/tests/helper/alert.js';
import {
  buildTestApp,
  errorBody,
  readRequestId,
  SECURITY_HEADERS,
} from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import {
  createLogSink,
  findLogLines,
  forgetLines,
  LOG_LEVEL,
} from '#root/tests/helper/log.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { sendRawRequest } from '#root/tests/helper/socket.js';
import { omit, pick } from '#utils/object.js';
import fp from 'fastify-plugin';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { setImmediate as nextLoop, setTimeout as sleep } from 'node:timers/promises';

const LOOPBACK = '127.0.0.1';
const HEAD = 'HEAD';
const POST = 'POST';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });
const BROKEN_JSON = '{"name":';

const BAD_URL = '/%FF';
const PING_URL = '/api/v1/system/ping';
const REFRESH_URL = '/api/v1/auth/refresh';
const ME_URL = '/api/v1/auth/me';

// A hook of the root reaches the routes declared before it too, those of src/routes among them: a request that has
// to be answered well beside the failing ones goes to an address under this one.
const HEALTHY_URL = '/healthy';

const REQUEST_FAILED = 'Request failed';
const HANDLER_FAILED = 'Error handler failed';
const SERVER_ERROR_TITLE = 'Server error (5xx)';

const HOOK_TEXT = 'inner text of a hook';
const ROUTE_TEXT = 'inner text of a route';
const BROKEN_MAX_AGE = 1.5;
const COOKIE_TEXT = `cookie maxAge is invalid: ${BROKEN_MAX_AGE}`;

// Node refuses it in a header.
const REFUSED_VALUE = 'line\nbreak';

const OWN_STATUS = 502;
const OWN_BODY = 'own';

const FASTIFY_CODE_PREFIX = 'FST';

const LINE_BREAK = '\r\n';
const HEAD_END = '\r\n\r\n';
const HEADER_SEPARATOR = ': ';
const CHUNKED = 'chunked';
const CHUNK_SIZE_RADIX = 16;
const STATUS_LINE_REGEXP = /^HTTP\/1\.1 (\d{3}) (.*)$/;

// Those of Node and of the plugins in front of every route: the error handler sets neither.
const NODE_HEADERS = Object.freeze(['date', 'connection', 'keep-alive', ...SECURITY_HEADERS]);

const ERROR_STATUS_MIN = 400;

// Long enough for a sent alert to reach the receiver: what is not there by then was never sent.
const SETTLE_MS = 300;

// A response that is neither finished nor torn down leaves inject() pending, and node:test waits for it forever.
const SUITE_OPTIONS = Object.freeze({ timeout: 15_000 });

function isHealthy(request) {
  return request.url.startsWith(HEALTHY_URL);
}

function isErrorReply(reply) {
  return reply.statusCode >= ERROR_STATUS_MIN;
}

function queueBrokenCookie(fastify) {
  fastify.addHook('onRequest', (request, reply, done) => {
    if (!isHealthy(request)) {
      reply.setCookie('broken', '1', { maxAge: BROKEN_MAX_AGE });
    }

    done();
  });
}

function rejectInHook(fastify) {
  fastify.addHook('onSend', async (request) => {
    if (!isHealthy(request)) {
      throw new Error(HOOK_TEXT);
    }
  });
}

function failInCallback(fastify) {
  fastify.addHook('onSend', (request, reply, payload, done) => {
    const error = isHealthy(request)
      ? null
      : new Error(HOOK_TEXT);

    setImmediate(done, error);
  });
}

function touchAndReject(fastify, touch) {
  fastify.addHook('onSend', async (request, reply) => {
    if (!isHealthy(request)) {
      await touch(reply, request);

      throw new Error(HOOK_TEXT);
    }
  });
}

function rejectErrorBodies(fastify) {
  fastify.addHook('onSend', async (request, reply) => {
    if (isErrorReply(reply)) {
      throw new Error(HOOK_TEXT);
    }
  });
}

function streamErrorBodies(fastify) {
  fastify.addHook('onSend', async (request, reply, payload) => (isErrorReply(reply) ? Readable.from([payload]) : payload));
}

function rejectSuccessBodies(fastify) {
  fastify.addHook('onSend', async (request, reply) => {
    if (!isErrorReply(reply)) {
      throw new Error(HOOK_TEXT);
    }
  });
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('x-after', 'ran');
  });
}

const BROKEN_COOKIE = Object.freeze({ what: 'a cookie that cannot be serialized', breakAnswers: queueBrokenCookie, text: COOKIE_TEXT });
const ASYNC_HOOK = Object.freeze({ what: 'an async hook that rejects', breakAnswers: rejectInHook, text: HOOK_TEXT });
const CALLBACK_HOOK = Object.freeze({ what: 'a callback hook that calls done(err)', breakAnswers: failInCallback, text: HOOK_TEXT });

// Each fails on every body: on that of the route, and on that of the error which has come of it.
const FAILURES = Object.freeze([BROKEN_COOKIE, ASYNC_HOOK, CALLBACK_HOOK]);

// "first" is what the app meets first and how it logs it: the failure of the hook, unless the request says otherwise.
const REQUESTS = Object.freeze([
  { what: 'a success body', url: '/success' },
  { what: 'reply.ok()', url: '/ok' },
  { what: 'HEAD', method: HEAD, url: '/success' },
  { what: 'an AppError', url: '/app-error', first: [LOG_LEVEL.WARN, 'NO_CHANGES'] },
  {
    what: 'HEAD of an AppError',
    method: HEAD,
    url: '/app-error',
    first: [LOG_LEVEL.WARN, 'NO_CHANGES'],
  },
  { what: 'a 500', url: '/boom', first: [LOG_LEVEL.ERROR, ROUTE_TEXT] },
  { what: 'a 500 of a handler that is not async', url: '/sync-boom', first: [LOG_LEVEL.ERROR, ROUTE_TEXT] },
  { what: 'an error handed to reply.send()', url: '/send-error', first: [LOG_LEVEL.ERROR, ROUTE_TEXT] },
  { what: 'an error of a hook before the handler', url: '/hook-error', first: [LOG_LEVEL.WARN, 'AUTHORIZATION_ERROR'] },
  { what: 'a 204', url: '/empty' },
  { what: 'a redirect', url: '/redirect' },
  { what: 'a stream', url: '/stream' },
  { what: 'HEAD of a stream', method: HEAD, url: '/stream' },
  {
    what: 'a validation error',
    method: POST,
    url: '/validated',
    payload: '{}',
    first: [LOG_LEVEL.WARN, 'FST_ERR_VALIDATION'],
  },
  {
    what: 'a broken JSON body',
    method: POST,
    url: '/validated',
    payload: BROKEN_JSON,
    first: [LOG_LEVEL.WARN, 'FST_ERR_CTP_INVALID_JSON_BODY'],
  },
  { what: 'an unknown URL', url: '/nope' },
  { what: 'HEAD of an unknown URL', method: HEAD, url: '/nope' },
  {
    what: 'an unknown URL with a broken JSON body',
    method: POST,
    url: '/nope',
    payload: BROKEN_JSON,
    first: [LOG_LEVEL.WARN, 'FST_ERR_CTP_INVALID_JSON_BODY'],
  },
  { what: 'reply.callNotFound()', url: '/call-not-found' },
  { what: 'a route of an fp plugin', url: '/plugin' },
  { what: 'a route of an encapsulated scope', url: '/scope' },
  { what: 'an error of an encapsulated scope', url: '/scope/boom', first: [LOG_LEVEL.ERROR, ROUTE_TEXT] },
  { what: 'reply.callNotFound() of an encapsulated scope', url: '/scope/call-not-found' },
  { what: 'an unknown URL under the prefix of a scope', url: '/scope/nope' },
  { what: 'a route of a nested scope', url: '/scope/nested' },
  { what: 'a route whose errorHandler calls that of its scope', url: '/own' },
  { what: 'an error of such a route', url: '/own/boom', first: [LOG_LEVEL.ERROR, ROUTE_TEXT] },
  { what: 'a route of src/routes', url: PING_URL },
  {
    what: 'an error of a handler of src/routes',
    method: POST,
    url: REFRESH_URL,
    first: [LOG_LEVEL.WARN, 'AUTHENTICATION_ERROR'],
  },
  { what: 'a refusal of the guard of src/routes', url: ME_URL, first: [LOG_LEVEL.WARN, 'AUTHENTICATION_ERROR'] },
  { what: 'the document of the API, which prod does not have', url: '/docs/json' },
  { what: 'a file of the docs, which prod does not have', url: '/docs/static/index.html' },
]);

function succeed() {
  return { isFine: true };
}

function failWith(error) {
  return async () => {
    throw error;
  };
}

function callNotFound(request, reply) {
  reply.callNotFound();
}

// As @fastify/static declares its routes.
function callScopeHandler(error, request, reply) {
  return request.server.errorHandler(error, request, reply);
}

async function useScope(scope) {
  scope.get('/', succeed);
  scope.get('/boom', failWith(new Error(ROUTE_TEXT)));
  scope.get('/call-not-found', callNotFound);
  scope.register(async (nested) => {
    nested.get('/nested', succeed);
  });
}

function declareRoutes(fastify) {
  fastify.get(HEALTHY_URL, succeed);
  fastify.get('/success', succeed);
  fastify.get('/ok', async (request, reply) => reply.ok(succeed()));
  fastify.get('/app-error', failWith(new AppError(ERROR_CODE.NO_CHANGES)));
  fastify.get('/boom', failWith(new Error(ROUTE_TEXT)));
  fastify.get('/sync-boom', () => {
    throw new Error(ROUTE_TEXT);
  });
  fastify.get('/send-error', (request, reply) => {
    reply.send(new Error(ROUTE_TEXT));
  });
  fastify.get('/hook-error', { preHandler: failWith(new AppError(ERROR_CODE.AUTHORIZATION_ERROR)) }, succeed);
  fastify.get('/empty', async (request, reply) => reply.noContent());
  fastify.get('/redirect', async (request, reply) => reply.redirect('/elsewhere'));
  fastify.get('/stream', async (request, reply) => reply.type('text/plain').send(Readable.from(['chunk'])));
  fastify.post('/validated', { schema: { body: { type: 'object', required: ['name'] } } }, succeed);
  fastify.get('/call-not-found', callNotFound);
  fastify.get('/own', { errorHandler: callScopeHandler }, succeed);
  fastify.get('/own/boom', { errorHandler: callScopeHandler }, failWith(new Error(ROUTE_TEXT)));
  fastify.register(fp(async (instance) => {
    instance.get('/plugin', succeed);
  }, { name: 'test-plugin' }));
  fastify.register(useScope, { prefix: '/scope' });
}

// The onError hook of the tests is a callback one: it adds no turn of its own between an error and its answer.
async function startApp(t, breakAnswers, { mode = MODE.PROD, env = {}, ...sections } = {}) {
  const sink = createLogSink();
  const reported = [];
  const fastify = await buildTestApp({
    ...sections,
    env: {
      ...(await createDownEnv()),
      ...REDIS_DOWN_ENV,
      ...env,
      APP_MODE: mode,
    },
    logger: { level: 'warn', stream: sink.stream },
  });

  forgetLines(sink);
  t.after(() => fastify.close());
  breakAnswers(fastify);
  fastify.addHook('onError', (request, reply, error, done) => {
    reported.push({ requestId: request.id, error });
    done();
  });
  declareRoutes(fastify);

  return { fastify, sink, reported };
}

function inject(fastify, { method = 'GET', url, payload }) {
  return fastify.inject({
    method,
    url,
    payload,
    headers: payload === undefined
      ? {}
      : JSON_HEADERS,
  });
}

function injectAll(fastify, urls) {
  return Promise.all(urls.map((url) => fastify.inject(url)));
}

async function listen(fastify) {
  await fastify.listen({ host: LOOPBACK, port: 0 });

  return fastify.server.address().port;
}

function watchProcess(t) {
  const events = [];

  function onWarning({ code }) {
    if (String(code).startsWith(FASTIFY_CODE_PREFIX)) {
      events.push(code);
    }
  }

  function onRejection(reason) {
    events.push(reason);
  }

  process.on('warning', onWarning);
  process.on('unhandledRejection', onRejection);
  t.after(() => {
    process.off('warning', onWarning);
    process.off('unhandledRejection', onRejection);
  });

  // A warning comes on the next tick, a rejection once the microtasks of its turn are done.
  async function readEvents() {
    await nextLoop();
    await nextLoop();

    return events;
  }

  return readEvents;
}

function nameError(error) {
  return error?.code ?? error?.message;
}

function readLog(sink, requestId) {
  return sink.lines
    .filter((line) => line.requestId === requestId)
    .map(({ level, msg, err }) => [level, msg, nameError(err)]);
}

function assertBothLogged(sink, response) {
  assert.deepEqual(readLog(sink, readRequestId(response)), [
    [LOG_LEVEL.ERROR, REQUEST_FAILED, HOOK_TEXT],
    [LOG_LEVEL.ERROR, HANDLER_FAILED, HOOK_TEXT],
  ]);
}

function serverErrorBody(response) {
  return errorBody(response, 'SERVER_ERROR', 'Server error');
}

function serverErrorHeaders(response) {
  return {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': String(Buffer.byteLength(JSON.stringify(serverErrorBody(response)))),
    'cache-control': 'no-store',
    'x-request-id': readRequestId(response),
  };
}

function assertServerError(response, extraHeaders = {}) {
  assert.equal(response.statusCode, 500);
  assert.deepEqual(omit(response.headers, NODE_HEADERS), { ...serverErrorHeaders(response), ...extraHeaders });
  assert.deepEqual(JSON.parse(response.payload), serverErrorBody(response));
}

// The body of an answer to HEAD is the matter of the tests with a socket: inject() shows one that does not go out.
function describeOutcome({ what, method }, response, { sink, reported }) {
  const requestId = readRequestId(response);

  return {
    what,
    statusCode: response.statusCode,
    headers: omit(response.headers, NODE_HEADERS),
    body: method === HEAD
      ? null
      : response.json(),
    log: readLog(sink, requestId),
    reported: reported.filter((entry) => entry.requestId === requestId).map(({ error }) => nameError(error)),
  };
}

function expectOutcome({ what, method, first }, response, text) {
  const [level, name] = first ?? [LOG_LEVEL.ERROR, text];

  return {
    what,
    statusCode: 500,
    headers: serverErrorHeaders(response),
    body: method === HEAD
      ? null
      : serverErrorBody(response),
    log: [[level, REQUEST_FAILED, name], [LOG_LEVEL.ERROR, HANDLER_FAILED, text]],
    reported: [name],
  };
}

function toRequestText({ method = 'GET', url, payload }, isLast = false) {
  const lines = [`${method} ${url} HTTP/1.1`, 'Host: localhost'];

  if (payload !== undefined) {
    lines.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(payload)}`);
  }

  if (isLast) {
    lines.push('Connection: close');
  }

  return `${lines.join(LINE_BREAK)}${HEAD_END}${payload ?? ''}`;
}

function parseHeader(line) {
  const separator = line.indexOf(HEADER_SEPARATOR);

  return [line.slice(0, separator).toLowerCase(), line.slice(separator + HEADER_SEPARATOR.length)];
}

function parseHead(text) {
  const [statusLine, ...lines] = text.split(LINE_BREAK);
  const [, statusCode, statusMessage] = statusLine.match(STATUS_LINE_REGEXP);
  const headers = lines.map((line) => parseHeader(line));

  return {
    statusCode: Number(statusCode),
    statusMessage,
    headers: Object.fromEntries(headers.filter(([name]) => name !== 'set-cookie')),
    cookies: headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value),
  };
}

// Up to the empty chunk that ends them.
function readChunks(text) {
  const sizeEnd = text.indexOf(LINE_BREAK);
  const start = sizeEnd + LINE_BREAK.length;
  const end = start + Number.parseInt(text.slice(0, sizeEnd), CHUNK_SIZE_RADIX);
  const rest = text.slice(end + LINE_BREAK.length);

  if (start === end) {
    return { payload: '', rest };
  }

  const next = readChunks(rest);

  return { payload: `${text.slice(start, end)}${next.payload}`, rest: next.rest };
}

// As a client reads an answer off the wire: as many bytes as the head declares, or its chunks, and none for HEAD.
function readResponse(text, { method }) {
  const headEnd = text.indexOf(HEAD_END);

  assert.notEqual(headEnd, -1, `There is no head of the next answer in "${text}"`);

  const head = parseHead(text.slice(0, headEnd));
  const body = text.slice(headEnd + HEAD_END.length);

  if (head.headers['transfer-encoding'] === CHUNKED) {
    const { payload, rest } = readChunks(body);

    return { response: { ...head, payload }, rest };
  }

  const length = method === HEAD
    ? 0
    : Number(head.headers['content-length']);

  return { response: { ...head, payload: body.slice(0, length) }, rest: body.slice(length) };
}

function readResponses(text, requests) {
  const { responses, rest } = requests.reduce((read, request) => {
    const next = readResponse(read.rest, request);

    return { responses: [...read.responses, next.response], rest: next.rest };
  }, { responses: [], rest: text });

  assert.equal(rest, '');

  return responses;
}

// One connection for all of them, in one write, and one more request behind them: its answer proves that the last
// of them has left the connection whole.
async function requestInTurn(port, requests) {
  const all = [...requests, { url: HEALTHY_URL }];
  const texts = all.map((request, index) => toRequestText(request, index === requests.length));
  const responses = readResponses(await sendRawRequest(port, texts.join('')), all);
  const healthy = responses.pop();

  assert.equal(healthy.statusCode, 200);
  assert.deepEqual(JSON.parse(healthy.payload), succeed());

  return responses;
}

async function assertServesNext(port) {
  assert.deepEqual(await requestInTurn(port, []), []);
}

describe('handleError: when an onSend hook fails on every body', SUITE_OPTIONS, () => {
  FAILURES.forEach(({ what, breakAnswers, text }) => {
    [MODE.PROD, MODE.DEV].forEach((mode) => {
      test(`answers whatever was asked for with the 500 envelope, logs "Error handler failed" once and runs the onError hooks once: ${what}, ${mode} mode`, async (t) => {
        const readEvents = watchProcess(t);
        const app = await startApp(t, breakAnswers, { mode });
        const responses = await Promise.all(REQUESTS.map((request) => inject(app.fastify, request)));

        assert.deepEqual(
          REQUESTS.map((request, index) => describeOutcome(request, responses[index], app)),
          REQUESTS.map((request, index) => expectOutcome(request, responses[index], text)),
        );
        assert.deepEqual(await readEvents(), []);
      });
    });

    test(`puts a whole answer on the wire for each request and leaves the connection for the next: ${what}`, async (t) => {
      const { fastify } = await startApp(t, breakAnswers);
      const responses = await requestInTurn(await listen(fastify), REQUESTS);

      assert.deepEqual(
        responses.map((response, index) => ({ what: REQUESTS[index].what, ...response, headers: omit(response.headers, NODE_HEADERS) })),
        responses.map((response, index) => ({
          what: REQUESTS[index].what,
          statusCode: 500,
          statusMessage: 'Internal Server Error',
          headers: serverErrorHeaders(response),
          cookies: [],
          payload: REQUESTS[index].method === HEAD
            ? ''
            : JSON.stringify(serverErrorBody(response)),
        })),
      );
    });
  });

  FAILURES.forEach(({ what, breakAnswers }) => {
    test(`holds every rejection of a handler that forgets to return its answer, or fails behind it: ${what}`, async (t) => {
      const readEvents = watchProcess(t);
      const { fastify, sink } = await startApp(t, breakAnswers);

      fastify.get('/forgotten', async (request, reply) => {
        reply.send(succeed());
      });
      fastify.get('/forgotten-error', async (request, reply) => {
        reply.send(new Error(ROUTE_TEXT));
      });
      fastify.get('/failed-behind', async (request, reply) => {
        reply.send(succeed());

        throw new Error(ROUTE_TEXT);
      });

      const responses = await injectAll(fastify, ['/forgotten', '/forgotten-error', '/failed-behind']);

      // More than one line for a handler that sends again while an async hook is pending: each of its answers fails.
      responses.forEach((response) => {
        assertServerError(response);
        assert.ok(findLogLines(sink, HANDLER_FAILED).some(({ requestId }) => requestId === readRequestId(response)));
      });
      assert.deepEqual(await readEvents(), []);
    });
  });

  test('answers the same when the hook is one of a scope or of a route, also when it meets the 404 of reply.callNotFound()', async (t) => {
    const { fastify, sink } = await startApp(t, (instance) => {
      instance.get('/hooked', { onSend: failWith(new Error(HOOK_TEXT)) }, succeed);
      instance.get('/hooked/call-not-found', { onSend: failWith(new Error(HOOK_TEXT)) }, callNotFound);
      instance.register(async (scope) => {
        rejectInHook(scope);
        scope.get('/hooked-scope', succeed);
        scope.get('/hooked-scope/call-not-found', callNotFound);
      });
    });

    const urls = ['/hooked', '/hooked/call-not-found', '/hooked-scope', '/hooked-scope/call-not-found'];
    const responses = await injectAll(fastify, urls);
    const beside = await fastify.inject('/success');

    responses.forEach((response) => {
      assertServerError(response);
      assertBothLogged(sink, response);
    });
    assert.equal(beside.statusCode, 200);
  });

  test('answers the same when the hook returns what is no body, an early "return false"', async (t) => {
    const { fastify, sink } = await startApp(t, (instance) => instance.addHook('onSend', async () => false));
    const responses = await injectAll(fastify, ['/success', '/app-error', '/nope', '/scope/boom']);

    responses.forEach((response) => {
      assertServerError(response);
      assert.deepEqual(readLog(sink, readRequestId(response)).slice(1), [
        [LOG_LEVEL.ERROR, HANDLER_FAILED, 'FST_ERR_REP_INVALID_PAYLOAD_TYPE'],
      ]);
    });
  });

  test('answers the same when the hook passes and Node refuses the head: it has put a header on it that cannot be sent', async (t) => {
    const { fastify, sink } = await startApp(t, (instance) => instance.addHook('onSend', async (request, reply) => {
      if (!isHealthy(request)) {
        reply.header('x-note', REFUSED_VALUE);
      }
    }));
    const requests = [{ url: '/success' }, { url: '/empty' }, { url: '/app-error' }, { url: '/nope' }];
    const responses = await requestInTurn(await listen(fastify), requests);

    responses.forEach((response) => {
      assert.equal(response.statusMessage, 'Internal Server Error');
      assertServerError(response);
    });
    assert.equal(findLogLines(sink, HANDLER_FAILED).length, requests.length);
  });

  test('answers a bad URL by its own code: no hook runs on the path of frameworkErrors', async (t) => {
    const [prod, dev] = await Promise.all([MODE.PROD, MODE.DEV].map((mode) => startApp(t, rejectInHook, { mode })));
    const [response, devResponse] = await Promise.all([prod, dev].map(({ fastify }) => fastify.inject(BAD_URL)));

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), errorBody(response, 'BAD_REQUEST_ERROR', 'Bad request'));
    assert.equal(devResponse.statusCode, 400);
    assert.deepEqual(devResponse.json(), errorBody(devResponse, 'BAD_REQUEST_ERROR', `'${BAD_URL}' is not a valid url component`));
    assert.deepEqual(readLog(prod.sink, readRequestId(response)), [[LOG_LEVEL.WARN, REQUEST_FAILED, 'FST_ERR_BAD_URL']]);
    assert.deepEqual(prod.reported, []);
  });
});

describe('handleError: when an onSend hook fails on some bodies only', SUITE_OPTIONS, () => {
  test('answers a plain 500 the normal way when the body of the error goes out: the other hooks run on it, and nothing is said of a failed handler', async (t) => {
    const { fastify, sink, reported } = await startApp(t, rejectSuccessBodies);
    const urls = ['/success', '/ok', '/empty', '/stream', '/plugin', '/scope', '/own', PING_URL];
    const responses = await injectAll(fastify, urls);

    responses.forEach((response) => {
      assertServerError(response, { 'x-after': 'ran' });
      assert.deepEqual(readLog(sink, readRequestId(response)), [[LOG_LEVEL.ERROR, REQUEST_FAILED, HOOK_TEXT]]);
    });
    assert.deepEqual(reported.map(({ error }) => error.message), urls.map(() => HOOK_TEXT));
  });

  test('tells a developer what has failed there, as of any other 500', async (t) => {
    const { fastify } = await startApp(t, rejectSuccessBodies, { mode: MODE.DEV });
    const response = await fastify.inject('/success');
    const { meta: { stack, ...meta }, ...body } = response.json();

    assert.equal(response.statusCode, 500);
    assert.deepEqual({ ...body, meta }, errorBody(response, 'SERVER_ERROR', HOOK_TEXT));
    assert.ok(stack.startsWith(`Error: ${HOOK_TEXT}\n    at `));
  });

  test('keeps a success whole when only the bodies of errors fail', async (t) => {
    const { fastify, sink } = await startApp(t, rejectErrorBodies);
    const [success, failure] = await injectAll(fastify, ['/success', '/app-error']);

    assert.equal(success.statusCode, 200);
    assert.deepEqual(success.json(), succeed());
    assertServerError(failure);
    assert.deepEqual(readLog(sink, readRequestId(failure)), [
      [LOG_LEVEL.WARN, REQUEST_FAILED, 'NO_CHANGES'],
      [LOG_LEVEL.ERROR, HANDLER_FAILED, HOOK_TEXT],
    ]);
  });

  // By then the refused head has marked the response: no body after a 204 and a 304, chunked framing.
  test('answers a whole envelope on a response Node had refused a head for before the hook failed', async (t) => {
    const { fastify, sink } = await startApp(t, rejectErrorBodies);

    fastify.get('/refused/no-content', async (request, reply) => reply.header('x-note', REFUSED_VALUE).noContent());
    fastify.get('/refused/not-modified', async (request, reply) => reply.header('x-note', REFUSED_VALUE).code(304).send());
    fastify.get('/refused/chunked', async (request, reply) => reply
      .header('transfer-encoding', 'chunked')
      .header('x-note', REFUSED_VALUE)
      .ok(succeed()));

    const requests = [{ url: '/refused/no-content' }, { url: '/refused/not-modified' }, { url: '/refused/chunked' }];
    const responses = await requestInTurn(await listen(fastify), requests);

    responses.forEach((response) => {
      assert.equal(response.statusMessage, 'Internal Server Error');
      assertServerError(response);
    });
    assert.equal(findLogLines(sink, HANDLER_FAILED).length, requests.length);
  });

  test('answers the other requests of the connection by their own: the failure is of one reply', async (t) => {
    const { fastify, sink } = await startApp(t, (instance) => instance.addHook('onSend', async (request) => {
      if (request.query.isBroken) {
        throw new Error(HOOK_TEXT);
      }
    }));
    const responses = await requestInTurn(await listen(fastify), [
      { url: '/success?isBroken=1' },
      { url: '/app-error' },
      { url: '/app-error?isBroken=1' },
      { url: '/nope' },
      { url: '/success' },
    ]);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [500, 409, 500, 404, 200]);
    assert.deepEqual(JSON.parse(responses[1].payload), errorBody(responses[1], 'NO_CHANGES', 'No changes'));
    assert.deepEqual(JSON.parse(responses[3].payload), errorBody(responses[3], 'NOT_FOUND_ERROR', 'Not found'));
    assert.deepEqual(JSON.parse(responses[4].payload), succeed());
    assert.equal(findLogLines(sink, HANDLER_FAILED).length, 2);
  });
});

describe('handleError: when an onSend hook makes a stream of the body of an error', SUITE_OPTIONS, () => {
  test('sends the envelope in chunks and leaves the connection for the next request, also behind a route that had described a body of its own', async (t) => {
    const { fastify } = await startApp(t, streamErrorBodies);

    fastify.get('/described', async (request, reply) => {
      reply.header('content-encoding', 'gzip');
      reply.raw.setHeader('content-length', OWN_BODY.length);

      throw new AppError(ERROR_CODE.NO_CHANGES);
    });

    const requests = [{ url: '/app-error' }, { url: '/nope' }, { url: '/described' }, { url: '/boom' }];
    const responses = await requestInTurn(await listen(fastify), requests);

    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [409, 404, 409, 500]);
    assert.deepEqual(responses.map(({ payload }) => JSON.parse(payload)), [
      errorBody(responses[0], 'NO_CHANGES', 'No changes'),
      errorBody(responses[1], 'NOT_FOUND_ERROR', 'Not found'),
      errorBody(responses[2], 'NO_CHANGES', 'No changes'),
      serverErrorBody(responses[3]),
    ]);
    responses.forEach((response) => {
      assert.deepEqual(omit(response.headers, NODE_HEADERS), {
        'content-type': JSON_CONTENT_TYPE,
        'transfer-encoding': CHUNKED,
        'cache-control': 'no-store',
        'x-request-id': readRequestId(response),
      });
    });
  });
});

describe('handleError: what the failing hook throws', SUITE_OPTIONS, () => {
  const THROWN = Object.freeze([
    new AppError(ERROR_CODE.AUTHENTICATION_ERROR, { headers: { 'x-own': 'own' } }),
    new AppError(ERROR_CODE.SESSION_REVOKED),
    new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR),
    new AppError(ERROR_CODE.VALIDATION_ERROR, { validation: [{ column: 'email', columnValue: HOOK_TEXT }] }),
    Object.assign(new Error(HOOK_TEXT), { statusCode: 404, headers: { 'x-own': 'own' } }),
    Object.freeze(new Error(HOOK_TEXT)),
    HOOK_TEXT,
    42,
    null,
    undefined,
    new Proxy({}, {
      get() {
        throw new Error(HOOK_TEXT);
      },
    }),
  ]);

  async function throwByIndex(request) {
    throw THROWN[request.query.index];
  }

  test('never shows: the answer to the second call is 500 SERVER_ERROR without a header of it, whatever it is', async (t) => {
    const readEvents = watchProcess(t);
    const { fastify, sink } = await startApp(t, (instance) => instance.addHook('onSend', throwByIndex));
    const urls = ['/success', '/app-error', '/nope'].flatMap((url) => THROWN.map((value, index) => `${url}?index=${index}`));
    const responses = await injectAll(fastify, urls);

    responses.forEach((response) => assertServerError(response));
    assert.equal(findLogLines(sink, HANDLER_FAILED).length, responses.length);
    assert.deepEqual(await readEvents(), []);
  });

  test('is an error as any other while the body of an error still goes out: an AppError answers by its own code', async (t) => {
    const { fastify, sink } = await startApp(t, (instance) => instance.addHook('onSend', async (request, reply) => {
      if (!isErrorReply(reply)) {
        throw new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
      }
    }));
    const response = await fastify.inject('/success');

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), errorBody(response, 'SERVICE_UNAVAILABLE_ERROR', 'Service unavailable'));
    assert.equal(response.headers['retry-after'], '60');
    assert.deepEqual(readLog(sink, readRequestId(response)), [[LOG_LEVEL.WARN, REQUEST_FAILED, 'SERVICE_UNAVAILABLE_ERROR']]);
  });
});

describe('handleError: the cookies of an answer that cannot be sent', SUITE_OPTIONS, () => {
  const COOKIE_KEYS = Object.freeze(['name', 'value', 'path', 'maxAge', 'httpOnly']);
  const COOKIE_OPTION_KEYS = Object.freeze(['path', 'maxAge', 'httpOnly']);

  const ISSUED = Object.freeze({
    name: 'issued',
    value: '1',
    path: '/api',
    maxAge: 60,
    httpOnly: true,
  });
  const CLEARED = Object.freeze({
    name: 'cleared',
    value: '',
    path: '/',
    maxAge: 0,
  });

  const LINES = Object.freeze(['one=1', 'two=2', 'three=3']);

  function setCookies(reply) {
    reply.setCookie(ISSUED.name, ISSUED.value, pick(ISSUED, COOKIE_OPTION_KEYS));
    reply.clearCookie(CLEARED.name);
  }

  function declareCookieRoutes(fastify) {
    fastify.get('/cookies', async (request, reply) => {
      setCookies(reply);
      reply.header('etag', '"v1"').header('cache-control', 'public, max-age=3600');
      reply.raw.setHeader('x-raw', 'raw');

      return succeed();
    });
    fastify.get('/cookies/app-error', async (request, reply) => {
      setCookies(reply);

      throw new AppError(ERROR_CODE.SESSION_REVOKED, { headers: { 'x-own': 'own' } });
    });
    fastify.get('/cookies/header', async (request, reply) => {
      const [first, ...rest] = LINES;

      return reply.header('set-cookie', first).header('set-cookie', rest).ok(succeed());
    });
    fastify.get('/cookies/raw', async (request, reply) => {
      reply.raw.setHeader('set-cookie', [...LINES]);

      return succeed();
    });
  }

  test('survive it, of a success and of an error alike, for they may be those of a rotation that is committed: no other header does', async (t) => {
    const { fastify } = await startApp(t, rejectInHook);

    declareCookieRoutes(fastify);

    const responses = await injectAll(fastify, ['/cookies', '/cookies/app-error']);

    responses.forEach((response) => {
      assertServerError(response, pick(response.headers, ['set-cookie']));
      assert.deepEqual(response.cookies.map((cookie) => pick(cookie, COOKIE_KEYS)), [ISSUED, CLEARED]);
    });
  });

  test('survive it however they were put on the reply: one by one, as a list, on the response of Node', async (t) => {
    const { fastify } = await startApp(t, rejectInHook);

    declareCookieRoutes(fastify);

    const responses = await injectAll(fastify, ['/cookies/header', '/cookies/raw']);

    responses.forEach((response) => assertServerError(response, { 'set-cookie': LINES }));
  });

  test('survive another one that cannot be serialized', async (t) => {
    const { fastify } = await startApp(t, queueBrokenCookie);

    declareCookieRoutes(fastify);

    assertServerError(await fastify.inject('/cookies/header'), { 'set-cookie': LINES });
  });

  test('go out on the wire each in a line of its own', async (t) => {
    const { fastify } = await startApp(t, rejectInHook);

    declareCookieRoutes(fastify);

    const requests = [{ url: '/cookies/header' }, { method: HEAD, url: '/cookies/header' }];
    const responses = await requestInTurn(await listen(fastify), requests);

    assert.deepEqual(responses.map(({ statusCode, cookies }) => [statusCode, cookies]), responses.map(() => [500, LINES]));
    assertServerError(responses[0]);
  });

  test('are left out when Node would refuse one of them: the envelope goes out all the same', async (t) => {
    const { fastify, sink } = await startApp(t, (instance) => touchAndReject(instance, (reply, request) => {
      reply.header('set-cookie', request.query.isList
        ? [...LINES, REFUSED_VALUE]
        : REFUSED_VALUE);
    }));
    const responses = await injectAll(fastify, ['/success', '/success?isList=1']);

    responses.forEach((response) => assertServerError(response));
    assert.equal(findLogLines(sink, HANDLER_FAILED).length, responses.length);
  });
});

describe('handleError: a response that has gone out before the second call', SUITE_OPTIONS, () => {
  // On the body of the error, which the first call has sent: its head is on the wire when the hook fails.
  // flushHeaders() and not write(): Node keeps a written chunk corked until the next tick.
  function startErrorBody(reply) {
    if (isErrorReply(reply)) {
      reply.raw.writeHead(OWN_STATUS, { 'content-length': String(OWN_BODY.length) });
      reply.raw.flushHeaders();
    }
  }

  function sendErrorBody(reply) {
    if (isErrorReply(reply)) {
      reply.raw.writeHead(OWN_STATUS, { 'content-length': String(OWN_BODY.length) });
      reply.raw.end(OWN_BODY);
    }
  }

  function readWholeLog(sink) {
    return sink.lines.map(({ level, msg, err }) => [level, msg, nameError(err)]);
  }

  const BOTH_LINES = Object.freeze([
    [LOG_LEVEL.ERROR, REQUEST_FAILED, HOOK_TEXT],
    [LOG_LEVEL.ERROR, HANDLER_FAILED, HOOK_TEXT],
  ]);

  test('is torn down: the client has the head that went out and a closed connection, and the next one is served', async (t) => {
    const readEvents = watchProcess(t);
    const { fastify, sink } = await startApp(t, (instance) => touchAndReject(instance, startErrorBody));
    const port = await listen(fastify);
    const received = await sendRawRequest(port, toRequestText({ url: '/success' }));

    assert.ok(received.endsWith(HEAD_END));
    assert.equal(parseHead(received.slice(0, -HEAD_END.length)).statusCode, OWN_STATUS);
    assert.deepEqual(readWholeLog(sink), BOTH_LINES);
    await assertServesNext(port);
    assert.deepEqual(await readEvents(), []);
  });

  // A response that waits behind another one has no socket yet: destroy() alone closes nothing then.
  test('is torn down when its turn comes in a pipeline: nothing of what stands behind it reaches the client', async (t) => {
    const { fastify, sink } = await startApp(t, (instance) => touchAndReject(instance, startErrorBody));

    fastify.get(`${HEALTHY_URL}/slow`, async () => {
      await waitFor(() => findLogLines(sink, HANDLER_FAILED).length > 0, 'the failure behind the slow answer');

      return { isSlow: true };
    });

    const port = await listen(fastify);
    const texts = [`${HEALTHY_URL}/slow`, '/success', HEALTHY_URL].map((url) => toRequestText({ url }));
    const received = await sendRawRequest(port, texts.join(''));
    const { response: slow, rest } = readResponse(received, {});

    assert.equal(slow.statusCode, 200);
    assert.deepEqual(JSON.parse(slow.payload), { isSlow: true });
    assert.equal(rest.includes('isFine'), false);
    assert.equal(rest.includes('SERVER_ERROR'), false);
    assert.deepEqual(readWholeLog(sink), BOTH_LINES);
  });

  test('is left as it is when a hook has ended it itself: nothing is written over it', async (t) => {
    const readEvents = watchProcess(t);
    const { fastify, sink } = await startApp(t, (instance) => touchAndReject(instance, sendErrorBody));
    const [own] = await requestInTurn(await listen(fastify), [{ url: '/success' }]);

    assert.deepEqual([own.statusCode, own.payload], [OWN_STATUS, OWN_BODY]);
    assert.deepEqual(readWholeLog(sink), BOTH_LINES);
    assert.deepEqual(await readEvents(), []);
  });

  test('is left alone when its client has gone: the failure is logged, and the next client is served', async (t) => {
    const readEvents = watchProcess(t);
    const entered = Promise.withResolvers();
    const { fastify, sink } = await startApp(t, (instance) => touchAndReject(instance, async (reply) => {
      entered.resolve();

      if (!reply.raw.closed) {
        await once(reply.raw, 'close');
      }
    }));
    const port = await listen(fastify);
    const client = net.connect({ host: LOOPBACK, port });

    t.after(() => client.destroy());
    client.write(toRequestText({ url: '/success' }));
    await entered.promise;
    client.destroy();
    await waitFor(() => findLogLines(sink, HANDLER_FAILED).length > 0, 'the failure of the second answer');

    assert.deepEqual(readWholeLog(sink), BOTH_LINES);
    await assertServesNext(port);
    assert.deepEqual(await readEvents(), []);
  });
});

describe('handleError: a reply an onSend hook has taken over before it fails', SUITE_OPTIONS, () => {
  const OWN_TYPE = 'text/plain';

  // The hook answers in a turn of its own: over a head that has gone out meanwhile writeHead() throws where nothing catches.
  function takeOver(reply) {
    reply.hijack();
    reply.raw.setHeader('content-type', OWN_TYPE);
    setImmediate(() => reply.raw.writeHead(OWN_STATUS, { 'content-length': OWN_BODY.length }).end(OWN_BODY));
  }

  test('is left to the hook, on the body of a success and on that of an error: what the hook sends is the only answer, with the headers it had put on the response', async (t) => {
    const readEvents = watchProcess(t);
    const { fastify, sink } = await startApp(t, (instance) => touchAndReject(instance, takeOver));
    const responses = await requestInTurn(await listen(fastify), [{ url: '/success' }, { url: '/app-error' }, { url: '/nope' }]);

    responses.forEach((response) => {
      assert.deepEqual([response.statusCode, response.headers['content-type'], response.payload], [OWN_STATUS, OWN_TYPE, OWN_BODY]);
    });
    assert.deepEqual(findLogLines(sink, HANDLER_FAILED).map(({ err }) => err.message), [HOOK_TEXT]);
    assert.deepEqual(await readEvents(), []);
  });
});

describe('handleError: two errors of one request', SUITE_OPTIONS, () => {
  test('end in one whole 500 when the second comes while the answer to the first waits in an onSend hook', async (t) => {
    const readEvents = watchProcess(t);
    const [entered, opened] = [Promise.withResolvers(), Promise.withResolvers()];
    const { fastify, sink } = await startApp(t, (instance) => instance.addHook('onSend', async (request, reply, payload) => {
      entered.resolve();
      await opened.promise;

      return payload;
    }));

    fastify.get('/race', async (request, reply) => {
      reply.send(new AppError(ERROR_CODE.NO_CHANGES));
      await entered.promise;

      throw new Error(ROUTE_TEXT);
    });

    const response = await fastify.inject('/race');
    const log = readLog(sink, readRequestId(response));

    opened.resolve();

    assertServerError(response);
    assert.deepEqual(log, [
      [LOG_LEVEL.WARN, REQUEST_FAILED, 'NO_CHANGES'],
      [LOG_LEVEL.ERROR, HANDLER_FAILED, ROUTE_TEXT],
    ]);
    assert.deepEqual(await readEvents(), []);
  });
});

describe('handleError: the alert of an answer that cannot be sent', SUITE_OPTIONS, () => {
  test('is sent once, for the error the app met first: the failure behind it is a line of the log', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await startApp(t, rejectInHook, {
      env: receiver.env.webhook,
      alert: { ...receiver.config.alert, throttleWindow: NO_THROTTLE },
    });
    const refused = await fastify.inject('/app-error');
    const boom = await fastify.inject('/boom');

    await waitFor(() => receiver.requests.length > 0, 'the alert of the route');

    const success = await fastify.inject('/success');

    await waitFor(() => receiver.requests.length > 1, 'the alert of the hook');
    await sleep(SETTLE_MS);

    [refused, boom, success].forEach((response) => assertServerError(response));
    assert.equal(findLogLines(sink, HANDLER_FAILED).length, 3);
    assert.deepEqual(readTitles(receiver), [SERVER_ERROR_TITLE, SERVER_ERROR_TITLE]);
    assert.deepEqual(
      receiver.requests.map(({ body }) => [readBlock(body, 'Request').requestId, readBlock(body, 'Error').message]),
      [[readRequestId(boom), ROUTE_TEXT], [readRequestId(success), HOOK_TEXT]],
    );
  });
});
