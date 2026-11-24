import { createContext, runInContext } from '#core/context/index.js';
import { AppError } from '#core/error/index.js';
import {
  assertServiceOptions,
  createUpstreamFailure,
  createWayFailure,
  fetchJson,
  fetchUpstream,
  findUpstreamError,
  isRedirectStatus,
  isSuccessStatus,
  logUpstreamCall,
  logUpstreamFailure,
  maskUrl,
  parseUpstreamUrl,
  readTimeout,
  toUpstreamAppError,
  UpstreamError,
} from '#core/http/index.js';
import { createLogger, serializeError } from '#core/logger/index.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { rejectionOf, timeIt } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { createRawServer, readByteByByte } from '#root/tests/helper/net.js';
import { getFreePort } from '#root/tests/helper/process.js';
import { toMimeEssence } from '#utils/mime.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';

const LOOPBACK = '127.0.0.1';
const SERVICE = 'test-upstream';
const STATUSES = Object.freeze([200, 404, 500]);

const REQUEST_MESSAGE = 'Upstream request';
const FAILED_MESSAGE = 'Upstream request failed';

const SHORT_TIMEOUT = '0.2s';
const SHORT_TIMEOUT_MS = 200;
// The millisecond clock of libuv floors the moment a timer starts at: a timer may fire a millisecond early.
const TIMER_SLACK_MS = 5;
// Far below the default deadline of 5s: a failure that waited for the deadline is not the one under test.
const QUICK_MS = 2000;

const MAX_BYTES = 64;
const STREAM_CHUNK = 'x'.repeat(16);
const STREAM_INTERVAL_MS = 5;

const SECRET = 'secret-0123456789';
const BODY_TEXT = 'upstream-body-text';
const CRLF = '\r\n';

// A label over 63 characters: the lookup of such a name fails without a query.
const UNRESOLVABLE_SITE = `${'a'.repeat(64)}.test`;

// What the error of fetch() and of the socket may tell: what they quote stays out.
const CAUSE_KEYS = Object.freeze(['type', 'code', 'syscall', 'cause']);
const HEADER_VALUE = 'upstream-header-value';

function openContext(sections = {}) {
  const sink = createLogSink();
  const config = createTestConfig({ ...sections, logger: { level: 'info', stream: sink.stream } });
  const context = createContext({ config, log: createLogger(config.logger) });

  function run(fn) {
    return runInContext(context, fn);
  }

  return { config, sink, run };
}

// A local upstream: "answer" writes each response as node:http lets it, and every request is recorded once read.
async function createUpstream(t, answer) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const chunks = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      answer(request, response);
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  t.after(() => {
    sockets.forEach((socket) => socket.destroy());
    server.close();
  });

  server.listen(0, LOOPBACK);
  await once(server, 'listening');

  return { url: `http://${LOOPBACK}:${server.address().port}`, requests };
}

// The status to answer with is the last segment of the path: /v1/status/404.
function answerWithStatus(request, response) {
  const status = Number(request.url.split('?')[0].split('/').at(-1));

  response.writeHead(status, { 'content-type': 'text/plain', 'x-upstream-note': HEADER_VALUE });
  response.end(`${BODY_TEXT} ${status}`);
}

function answerJson(status, body) {
  function answer(request, response) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  }

  return answer;
}

// Writes a chunk at a time and never ends: only a reader that stops reading gets out.
function streamForever(response) {
  const timer = setInterval(() => response.write(STREAM_CHUNK), STREAM_INTERVAL_MS);

  response.once('close', () => clearInterval(timer));
}

function assertUpstreamFailure(error, reason, label = reason) {
  assert.ok(error instanceof AppError, `${label}: ${error}`);
  assert.equal(error.code, 'UPSTREAM_ERROR', label);
  assert.equal(error.statusCode, 502, label);
  assert.ok(error.cause instanceof UpstreamError, `${label}: ${error.cause}`);
  assert.equal(error.cause.reason, reason, label);

  return error.cause;
}

// What a line of the log and the Error block of an alert hold of it.
function readLoggedText(error) {
  return JSON.stringify(serializeError(error));
}

function readCauseChain(cause) {
  return cause === undefined
    ? []
    : [cause, ...readCauseChain(cause.cause)];
}

function readErrorTexts(error) {
  return [
    JSON.stringify(error),
    JSON.stringify(error.cause),
    error.message,
    error.cause?.message,
    error.stack,
    error.cause?.stack,
  ].join('\n');
}

describe('fetchUpstream', () => {
  test('resolves with the status, the headers, the text and the duration of any answer: 200, 404 and 500 alike', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerWithStatus);
    const results = await Promise.all(STATUSES.map((status) => run(() => fetchUpstream(`${upstream.url}/v1/status/${status}`, { service: SERVICE }))));

    results.forEach((result, index) => {
      assert.deepEqual(Object.keys(result).sort(), ['durationMs', 'headers', 'status', 'text']);
      assert.equal(result.status, STATUSES[index]);
      assert.equal(result.text, `${BODY_TEXT} ${STATUSES[index]}`);
      assert.equal(result.headers.get('x-upstream-note'), HEADER_VALUE);
      assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0, String(result.durationMs));
    });
  });

  test('logs each call once at the info level with its service, method, masked address, status and duration, never its body or headers', async (t) => {
    const { run, sink } = openContext();
    const upstream = await createUpstream(t, answerWithStatus);
    const token = `123456789:${SECRET}`;
    const results = await Promise.all(STATUSES.map((status) => run(() => fetchUpstream(`${upstream.url}/bot${token}/status/${status}?key=query-value`, {
      service: SERVICE,
      headers: { authorization: 'Bearer request-header-value' },
      secrets: [token],
    }))));
    const lines = findLogLines(sink, REQUEST_MESSAGE);
    const written = JSON.stringify(sink.lines);

    assert.equal(lines.length, STATUSES.length);
    STATUSES.forEach((status, index) => {
      const line = lines.find(({ upstream: logged }) => logged.status === status);

      assert.equal(line.level, LOG_LEVEL.INFO);
      assert.deepEqual(line.upstream, {
        service: SERVICE,
        method: 'GET',
        url: `${upstream.url}/bot***/status/${status}?key=***`,
        status,
        durationMs: results[index].durationMs,
      });
    });
    [SECRET, 'query-value', 'request-header-value', HEADER_VALUE, BODY_TEXT].forEach((text) => {
      assert.equal(written.includes(text), false, text);
    });
  });

  test('resolves an answer without a body with an empty text', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(204);
      response.end();
    });
    const result = await run(() => fetchUpstream(`${upstream.url}/v1/items`, { service: SERVICE }));

    assert.equal(result.status, 204);
    assert.equal(result.text, '');
  });

  test('sends the method, the headers and the body it is given, and GET without a body by default', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => response.end('done'));

    await run(() => fetchUpstream(`${upstream.url}/v1/items`, {
      service: SERVICE,
      method: 'POST',
      headers: { 'x-trace': 'trace-1' },
      body: 'payload',
    }));
    await run(() => fetchUpstream(`${upstream.url}/v1/items`, { service: SERVICE }));

    assert.deepEqual(upstream.requests.map(({ method, body }) => [method, body]), [['POST', 'payload'], ['GET', '']]);
    assert.equal(upstream.requests[0].headers['x-trace'], 'trace-1');
  });

  test('writes the method in upper case: fetch() does so for six common methods only, and a "patch" would be refused', async (t) => {
    const { run, sink } = openContext();
    const upstream = await createUpstream(t, (request, response) => response.end('done'));

    await run(() => fetchUpstream(`${upstream.url}/v1/items`, { service: SERVICE, method: 'patch', body: 'payload' }));
    await run(() => fetchUpstream(`${upstream.url}/v1/items`, { service: SERVICE, method: 'get', body: null }));

    assert.deepEqual(upstream.requests.map(({ method, body }) => [method, body]), [['PATCH', 'payload'], ['GET', '']]);
    assert.deepEqual(findLogLines(sink, REQUEST_MESSAGE).map((line) => line.upstream.method), ['PATCH', 'GET']);
  });
});

describe('fetchUpstream: the deadline', () => {
  test('covers the body: an answer that stalls after its headers rejects with "timeout" once the deadline has passed', async (t) => {
    const { run, sink } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('the start of a body');
    });
    const { result: error, durationMs } = await timeIt(() => rejectionOf(run(() => fetchUpstream(`${upstream.url}/v1/slow`, {
      service: SERVICE,
      timeout: SHORT_TIMEOUT,
    }))));
    const cause = assertUpstreamFailure(error, 'timeout');
    const [line] = findLogLines(sink, FAILED_MESSAGE);

    assert.ok(durationMs >= SHORT_TIMEOUT_MS - TIMER_SLACK_MS && durationMs < QUICK_MS, `${durationMs} ms`);
    assert.equal(cause.service, SERVICE);
    assert.equal(cause.method, 'GET');
    assert.equal(cause.url, `${upstream.url}/v1/slow`);
    assert.ok(cause.durationMs >= SHORT_TIMEOUT_MS - TIMER_SLACK_MS, String(cause.durationMs));
    assert.equal(line.upstream.reason, 'timeout');
    assert.equal(line.upstream.durationMs, cause.durationMs);
  });

  test('ends a call the upstream never answers with "timeout" too', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, () => {});
    const { result: error, durationMs } = await timeIt(() => rejectionOf(run(() => fetchUpstream(`${upstream.url}/v1/silent`, {
      service: SERVICE,
      timeout: SHORT_TIMEOUT,
    }))));

    assertUpstreamFailure(error, 'timeout');
    assert.ok(durationMs >= SHORT_TIMEOUT_MS - TIMER_SLACK_MS && durationMs < QUICK_MS, `${durationMs} ms`);
    assert.equal(upstream.requests.length, 1);
  });

  test('takes config.http.timeout when the call names none', async (t) => {
    const { run } = openContext({ http: { timeout: SHORT_TIMEOUT } });
    const upstream = await createUpstream(t, () => {});
    const { result: error, durationMs } = await timeIt(() => rejectionOf(run(() => fetchUpstream(`${upstream.url}/v1/silent`, { service: SERVICE }))));

    assertUpstreamFailure(error, 'timeout');
    assert.ok(durationMs < QUICK_MS, `${durationMs} ms`);
  });
});

describe('fetchUpstream: the way there', () => {
  // fetch() refuses the ports of its bad-ports list, port 1 among them: a free port stands for one nothing listens on.
  test('rejects with "network" and the code of the socket when nothing listens on the port', async () => {
    const { run, sink } = openContext();
    const port = await getFreePort();
    const error = await rejectionOf(run(() => fetchUpstream(`http://${LOOPBACK}:${port}/v1`, { service: SERVICE })));
    const cause = assertUpstreamFailure(error, 'network');
    const [line] = findLogLines(sink, FAILED_MESSAGE);

    assert.equal(cause.code, 'ECONNREFUSED');
    assert.equal(line.upstream.reason, 'network');
    assert.equal(line.upstream.code, 'ECONNREFUSED');
  });

  test('rejects with "network" an answer the upstream cuts off in the middle of its body', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(MAX_BYTES) });
      response.write(STREAM_CHUNK, () => request.socket.destroy());
    });
    const error = await rejectionOf(run(() => fetchUpstream(`${upstream.url}/v1/cut`, { service: SERVICE })));

    assertUpstreamFailure(error, 'network');
  });

  test('tells of the error behind the failure its type, code and system call, and nothing it quotes', async () => {
    const { run } = openContext();
    const port = await getFreePort();
    const error = await rejectionOf(run(() => fetchUpstream(`http://${LOOPBACK}:${port}/v1`, { service: SERVICE })));
    const [first, second, ...rest] = readCauseChain(assertUpstreamFailure(error, 'network').cause);

    assert.equal(first.type, 'TypeError');
    assert.deepEqual([second.code, second.syscall, rest], ['ECONNREFUSED', 'connect', []]);
    assert.equal(readLoggedText(error).includes(String(port)), true);
    assert.equal(JSON.stringify(error.cause.cause).includes(String(port)), false);
  });

  test('keeps out of the failure the rest of an answer that breaks the protocol: the parser of fetch() quotes it', async (t) => {
    const { run } = openContext();
    const body = `{"access_token":"${SECRET}"}`;
    const answers = {
      '/chunk': ['HTTP/1.1 200 OK', 'Transfer-Encoding: chunked', '', 'ZZ', body, '0', '', ''].join(CRLF),
      '/header': ['HTTP/1.1 200 OK', 'Bad Header: x', 'Content-Length: 64', '', body].join(CRLF),
      '/body': body,
    };
    const server = await createRawServer(t, (path) => answers[path]);
    const errors = await Promise.all(Object.keys(answers).map((path) => rejectionOf(run(() => fetchJson(`${server.url}${path}`, { service: SERVICE })))));

    errors.forEach((error) => {
      const chain = readCauseChain(assertUpstreamFailure(error, 'network').cause);

      assert.ok(chain.length > 0);
      chain.forEach((cause) => assert.deepEqual(Object.keys(cause).filter((key) => !CAUSE_KEYS.includes(key)), []));
      assert.equal(readLoggedText(error).includes(SECRET), false);
    });
  });

  test('keeps out of the failure a secret host, which a lookup quotes, and a header fetch() refuses', async () => {
    const { run } = openContext();
    const secretUrl = `http://${SECRET}.${UNRESOLVABLE_SITE}/hook`;
    const [hidden, named, header] = await Promise.all([
      rejectionOf(run(() => fetchUpstream(secretUrl, { service: SERVICE, isAddressSecret: true }))),
      rejectionOf(run(() => fetchUpstream(secretUrl, { service: SERVICE, secrets: [SECRET] }))),
      rejectionOf(run(() => fetchUpstream(`http://${LOOPBACK}/v1`, { service: SERVICE, headers: { authorization: `Bearer ${SECRET}\nrest` } }))),
    ]);

    assert.deepEqual([hidden.cause.code, named.cause.code], ['ENOTFOUND', 'ENOTFOUND']);
    [hidden, named, header].forEach((error) => {
      assertUpstreamFailure(error, 'network');
      assert.equal(readLoggedText(error).includes(SECRET), false);
    });
  });
});

describe('fetchUpstream: the ceiling of the body', () => {
  test('refuses an answer that declares a length over maxBytes without waiting for its body', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(MAX_BYTES * 10) });
      response.write(STREAM_CHUNK);
    });
    const { result: error, durationMs } = await timeIt(() => rejectionOf(run(() => fetchUpstream(`${upstream.url}/v1/large`, {
      service: SERVICE,
      maxBytes: MAX_BYTES,
    }))));
    const cause = assertUpstreamFailure(error, 'too-large');

    assert.ok(durationMs < QUICK_MS, `${durationMs} ms`);
    assert.equal(cause.status, 200);
    assert.equal(cause.maxBytes, MAX_BYTES);
  });

  test('stops reading a body without a length as soon as it grows over maxBytes', async (t) => {
    const { run } = openContext();
    const closing = Promise.withResolvers();
    const upstream = await createUpstream(t, (request, response) => {
      response.once('close', closing.resolve);
      response.writeHead(200, { 'content-type': 'text/plain' });
      streamForever(response);
    });
    const { result: [error], durationMs } = await timeIt(() => Promise.all([
      rejectionOf(run(() => fetchUpstream(`${upstream.url}/v1/endless`, { service: SERVICE, maxBytes: MAX_BYTES }))),
      closing.promise,
    ]));
    const cause = assertUpstreamFailure(error, 'too-large');

    assert.equal(cause.status, 200);
    assert.equal(cause.maxBytes, MAX_BYTES);
    assert.ok(durationMs < QUICK_MS, `${durationMs} ms`);
  });

  test('reads a body that comes byte by byte in a heap which a list of its chunks would not fit', async (t) => {
    const { code, isWhole, stderr } = await readByteByByte(t, 'upstream');

    assert.deepEqual([code, isWhole], [0, true], stderr.slice(0, 500));
  });

  // fetch() unpacks a gzip body by itself: the length the upstream declares is that of the packed bytes.
  test('counts the bytes it reads, not the length declared for a compressed body', async (t) => {
    const { run } = openContext();
    const packed = gzipSync(Buffer.alloc(MAX_BYTES * 100));
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(packed.length) });
      response.end(packed);
    });
    const error = await rejectionOf(run(() => fetchUpstream(`${upstream.url}/v1/packed`, { service: SERVICE, maxBytes: MAX_BYTES })));

    assert.ok(packed.length <= MAX_BYTES, `${packed.length} packed bytes`);
    assert.equal(assertUpstreamFailure(error, 'too-large').maxBytes, MAX_BYTES);
  });

  test('reads a body of exactly maxBytes whole', async (t) => {
    const { run } = openContext();
    const body = 'y'.repeat(MAX_BYTES);
    const upstream = await createUpstream(t, (request, response) => response.end(body));
    const result = await run(() => fetchUpstream(`${upstream.url}/v1/full`, { service: SERVICE, maxBytes: MAX_BYTES }));

    assert.equal(result.text, body);
  });

  test('takes an answer to HEAD and a 304 whatever length they declare: it is that of a body which is not sent', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(Number(request.url.slice(1)), { 'content-length': String(MAX_BYTES * 2) });
      response.end();
    });
    const [head, notModified] = await Promise.all([
      run(() => fetchUpstream(`${upstream.url}/200`, { service: SERVICE, method: 'HEAD', maxBytes: MAX_BYTES })),
      run(() => fetchUpstream(`${upstream.url}/304`, { service: SERVICE, maxBytes: MAX_BYTES })),
    ]);

    assert.deepEqual([[head.status, head.text], [notModified.status, notModified.text]], [[200, ''], [304, '']]);
  });

  test('takes config.http.maxResponseBytes when the call names no maxBytes', async (t) => {
    const { run } = openContext({ http: { maxResponseBytes: MAX_BYTES } });
    const upstream = await createUpstream(t, (request, response) => response.end('z'.repeat(MAX_BYTES + 1)));
    const error = await rejectionOf(run(() => fetchUpstream(`${upstream.url}/v1/large`, { service: SERVICE })));

    assert.equal(assertUpstreamFailure(error, 'too-large').maxBytes, MAX_BYTES);
  });
});

describe('fetchUpstream: an address it refuses', () => {
  test('refuses with "invalid-url" what is not a URL, an ftp: address and one with credentials, before any request', async (t) => {
    const { run, sink } = openContext();
    const upstream = await createUpstream(t, (request, response) => response.end('done'));
    const host = upstream.url.slice('http://'.length);
    const addresses = [
      `${host}/v1`,
      `ftp://${host}/v1`,
      `http://user:p4ssw0rd@${host}/v1`,
      `http://user@${host}/v1`,
      new URL(`http://user:p4ssw0rd@${host}/v1`),
      undefined,
      42,
    ];
    const errors = await Promise.all(addresses.map((url) => rejectionOf(run(() => fetchUpstream(url, { service: SERVICE })))));
    const lines = findLogLines(sink, FAILED_MESSAGE);

    errors.forEach((error, index) => assertUpstreamFailure(error, 'invalid-url', String(addresses[index])));
    assert.deepEqual(upstream.requests, []);
    assert.equal(lines.length, addresses.length);
    assert.ok(lines.every(({ upstream: logged }) => logged.reason === 'invalid-url' && logged.service === SERVICE));
    assert.deepEqual(findLogLines(sink, REQUEST_MESSAGE), []);
  });

  test('writes none of an address it refuses to the error or the log, a secret in it included', async () => {
    const { run, sink } = openContext();
    const addresses = [
      `upstream.example.test/v1?token=${SECRET}`,
      `ftp://upstream.example.test/v1?token=${SECRET}`,
      `http://user:${SECRET}@upstream.example.test/v1`,
    ];
    const errors = await Promise.all(addresses.map((url) => rejectionOf(run(() => fetchUpstream(url, { service: SERVICE })))));
    const written = JSON.stringify(sink.lines);

    errors.forEach((error, index) => {
      const texts = readErrorTexts(error);

      assert.equal(texts.includes(SECRET), false, addresses[index]);
      assert.equal(texts.includes(addresses[index]), false, addresses[index]);
    });
    assert.equal(written.includes(SECRET), false);
  });

  test('writes nothing of an address whose scheme has no origin, such as mailto: or data:, to the error or the log', async () => {
    const { run, sink } = openContext();
    const addresses = [`mailto:${SECRET}@example.test`, `data:text/plain,${SECRET}`];
    const errors = await Promise.all(addresses.map((url) => rejectionOf(run(() => fetchUpstream(url, { service: SERVICE })))));

    errors.forEach((error, index) => {
      const cause = assertUpstreamFailure(error, 'invalid-url');

      assert.equal(readErrorTexts(error).includes(SECRET), false, `${addresses[index]} gave ${cause.url}`);
    });
    assert.equal(JSON.stringify(sink.lines).includes(SECRET), false);
  });
});

describe('fetchUpstream in a route', () => {
  test('a failure the route lets through answers 502 UPSTREAM_ERROR, with neither the address nor the failure in the answer', async (t) => {
    const sink = createLogSink();
    const fastify = await buildTestApp({ logger: { level: 'info', stream: sink.stream } });
    const port = await getFreePort();
    const url = `http://${LOOPBACK}:${port}/v1?token=${SECRET}`;

    t.after(() => fastify.close());

    // Outside the API prefix: the contract of a route (security, a typed response schema) is not under test here.
    fastify.get('/upstream', async () => {
      await fetchUpstream(url, { service: SERVICE });

      return { isReached: true };
    });

    const response = await fastify.inject('/upstream');
    const [failure] = findLogLines(sink, 'Request failed');

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      status: 'error',
      code: 'UPSTREAM_ERROR',
      message: 'Upstream error',
      meta: { requestId: response.headers['x-request-id'] },
    });
    assert.equal(failure.level, LOG_LEVEL.ERROR);
    assert.equal(failure.err.code, 'UPSTREAM_ERROR');
    assert.equal(failure.err.cause.reason, 'network');
    assert.equal(failure.err.cause.service, SERVICE);
    assert.equal(JSON.stringify(sink.lines).includes(SECRET), false);
  });
});

describe('fetchUpstream: options', () => {
  const URL_TEXT = 'http://127.0.0.1/v1';

  test('requires options with the name of the service', async () => {
    const { run } = openContext();
    const refused = [undefined, null, {}, { service: '' }, { service: 1 }, 'service'];

    await Promise.all(refused.map((options) => assert.rejects(run(() => fetchUpstream(URL_TEXT, options)), {
      name: 'TypeError',
      message: /requires options with the name of the service/,
    }, JSON.stringify(options))));
  });

  test('requires headers to be a plain object', async () => {
    const { run } = openContext();
    const refused = [new Headers({ 'x-trace': '1' }), [['x-trace', '1']], 'x-trace: 1', null];

    await Promise.all(refused.map((headers) => assert.rejects(run(() => fetchUpstream(URL_TEXT, { service: SERVICE, headers })), {
      name: 'TypeError',
      message: /requires headers to be a plain object/,
    }, String(headers))));
  });

  test('requires maxBytes to be a positive integer', async () => {
    const { run } = openContext();
    const refused = [0, -1, 1.5, '64', null, Number.NaN, Number.MAX_SAFE_INTEGER + 1];

    await Promise.all(refused.map((maxBytes) => assert.rejects(run(() => fetchUpstream(URL_TEXT, { service: SERVICE, maxBytes })), {
      name: 'TypeError',
      message: /requires maxBytes to be a positive integer/,
    }, String(maxBytes))));
  });

  test('requires a timeout above zero', async () => {
    const { run } = openContext();

    await Promise.all(['0s', '-1s', '0.0001s'].map((timeout) => assert.rejects(run(() => fetchUpstream(URL_TEXT, { service: SERVICE, timeout })), {
      name: 'TypeError',
      message: /requires a timeout above zero/,
    }, timeout)));
    await assert.rejects(run(() => fetchUpstream(URL_TEXT, { service: SERVICE, timeout: '5 min' })), TypeError);
  });

  test('requires secrets to be a list of non-empty strings', async () => {
    const { run } = openContext();

    await assert.rejects(run(() => fetchUpstream(URL_TEXT, { service: SERVICE, secrets: 'token' })), {
      name: 'TypeError',
      message: /requires secrets to be a list of non-empty strings/,
    });
  });
});

describe('maskUrl', () => {
  test('leaves out the credentials and the fragment', () => {
    assert.equal(
      maskUrl('https://anna:p4ssw0rd@api.example.test/v1/items#access_token=abc'),
      'https://api.example.test/v1/items',
    );
  });

  test('masks every value of the query and keeps its keys, a repeated one included', () => {
    assert.equal(
      maskUrl('https://api.example.test/v1/items?token=abc&page=2&token=def&a%20b=c'),
      'https://api.example.test/v1/items?token=***&page=***&token=***&a%20b=***',
    );
  });

  test('masks a key without a value whole, as a bare "?token" is the secret itself, and a named secret in a key', () => {
    assert.equal(maskUrl('https://hooks.example.test/hook?abcSECRET123'), 'https://hooks.example.test/hook?***');
    assert.equal(maskUrl('https://hooks.example.test/hook?page=2&abcSECRET123'), 'https://hooks.example.test/hook?page=***&***');
    assert.equal(maskUrl('https://api.example.test/v1?123:SECRET=1', { secrets: ['123:SECRET'] }), 'https://api.example.test/v1?***=***');
  });

  test('masks a key with an empty value whole too: URLSearchParams writes a bare key so once it sets another', () => {
    const url = new URL('https://hooks.example.test/hook?abcSECRET123');

    url.searchParams.set('format', 'json');

    assert.equal(url.search, '?abcSECRET123=&format=json');
    assert.equal(maskUrl(url), 'https://hooks.example.test/hook?***&format=***');
  });

  test('masks a base64 token with its padding as the bare key it is, named or not', () => {
    ['dG9rZW4tc2VjcmV0MTIzNDU=', 'dG9rZW4tc2VjcmV0MTIzNA==', 'dG9rZW4tc2VjcmV0MTIzNDU2'].forEach((token) => {
      assert.equal(maskUrl(`https://hooks.example.test/hook?${token}`), 'https://hooks.example.test/hook?***', token);
      assert.equal(maskUrl(`https://hooks.example.test/hook?${token}`, { secrets: [token] }), 'https://hooks.example.test/hook?***', token);
    });
    assert.equal(maskUrl('https://hooks.example.test/hook?a=1&b&c=&d==&e=x='), 'https://hooks.example.test/hook?a=***&***&***&***&e=***');
  });

  test('masks such a token also as URLSearchParams writes it once it sets another parameter: its last "=" as %3D', () => {
    const token = 'dG9rZW4tc2VjcmV0MTIzNA==';
    const url = new URL(`https://hooks.example.test/hook?${token}`);

    url.searchParams.set('format', 'json');

    assert.equal(url.search, '?dG9rZW4tc2VjcmV0MTIzNA=%3D&format=json');
    assert.equal(maskUrl(url), 'https://hooks.example.test/hook?***&format=***');
    assert.equal(maskUrl(url, { secrets: [token] }), 'https://hooks.example.test/hook?***&format=***');
  });

  test('replaces a named secret that takes more than one part of the query, and shows none of its neighbours for that', () => {
    const base = 'https://api.example.test/v1';

    assert.equal(maskUrl(`${base}?page=2&to=ken&se=cret`, { secrets: ['to=ken&se=cret'] }), `${base}?page=***&***=***&***=***`);
    assert.equal(maskUrl(`${base}?sig=AAAA1111=BBBB2222`, { secrets: ['sig='] }), `${base}?***=***`);
    assert.equal(maskUrl(`${base}?BARETOKEN1&next=1`, { secrets: ['1&n'] }), `${base}?***&***ext=***`);
    assert.equal(maskUrl(`${base}?BARETOKEN1=&format=json`, { secrets: ['=&'] }), `${base}?***&format=***`);
  });

  test('keeps only the scheme, the site and the port of a secret address: its path, query and subdomains go', () => {
    assert.equal(maskUrl('https://hooks.example.test/services/T1/B2/X3?abcSECRET123', { isAddressSecret: true }), 'https://***.example.test/***?***');
    assert.equal(maskUrl('https://eo1a2b3c4d5e6f7.m.pipedream.test/', { isAddressSecret: true }), 'https://***.pipedream.test/***');
    assert.equal(maskUrl('https://discord.test/api/webhooks/1/SECRET', { isAddressSecret: true }), 'https://discord.test/***');
    assert.equal(maskUrl('http://127.0.0.1:8080/hook/SECRET', { isAddressSecret: true }), 'http://127.0.0.1:8080/***');
    assert.equal(maskUrl('http://[::1]:8080/hook/SECRET', { isAddressSecret: true }), 'http://[::1]:8080/***');
  });

  test('replaces a named secret in the host as well, in the lower case a URL writes a name in', () => {
    assert.equal(maskUrl('https://eo1a2b3c.m.pipedream.test/', { secrets: ['EO1A2B3C'] }), 'https://***.m.pipedream.test/');
  });

  test('keeps the port and the path, and adds no query when there is none', () => {
    assert.equal(maskUrl('http://127.0.0.1:8080/v1/items'), 'http://127.0.0.1:8080/v1/items');
    assert.equal(maskUrl('http://127.0.0.1:8080/v1/items?'), 'http://127.0.0.1:8080/v1/items');
  });

  test('replaces a secret of the path the caller names, both as it is and percent-encoded', () => {
    const token = '123456789:test-token_for-the-mask';

    assert.equal(
      maskUrl(`https://api.telegram.test/bot${token}/sendMessage`, { secrets: [token] }),
      'https://api.telegram.test/bot***/sendMessage',
    );
    assert.equal(
      maskUrl('https://hooks.example.test/hook/tést secret/run', { secrets: ['tést secret'] }),
      'https://hooks.example.test/hook/***/run',
    );
    assert.equal(
      maskUrl('https://hooks.example.test/hook/t%C3%A9st%20secret/run', { secrets: ['tést secret'] }),
      'https://hooks.example.test/hook/***/run',
    );
    assert.equal(
      maskUrl('https://hooks.example.test/x1/y2/x1', { secrets: ['x1', 'y2'] }),
      'https://hooks.example.test/***/***/***',
    );
  });

  test('replaces a named secret in the forms a path and a form write it in: ":" as it is, a space as %20 or +', () => {
    const url = new URL('https://api.example.test/v1');

    url.searchParams.set('ab:cd ef', '1');

    assert.equal(maskUrl('https://api.example.test/v1/ab:cd ef/x', { secrets: ['ab:cd ef'] }), 'https://api.example.test/v1/***/x');
    assert.equal(maskUrl(url, { secrets: ['ab:cd ef'] }), 'https://api.example.test/v1?***=***');
  });

  test('gives "***" for what it cannot parse', () => {
    ['upstream.example.test/v1?token=abc', '', 'http://exa mple.test/v1', undefined, null, 42, {}].forEach((value) => {
      assert.equal(maskUrl(value), '***', String(value));
    });
  });

  test('takes a URL object', () => {
    assert.equal(
      maskUrl(new URL('https://anna:p4ssw0rd@api.example.test/bot-secret/v1?token=abc'), { secrets: ['bot-secret'] }),
      'https://api.example.test/***/v1?token=***',
    );
  });

  test('requires secrets to be a list of non-empty strings', () => {
    ['token', [''], [1], ['token', null], null, {}].forEach((secrets) => {
      assert.throws(() => maskUrl('https://api.example.test/v1', { secrets }), {
        name: 'TypeError',
        message: 'maskUrl(url, { secrets, isAddressSecret }) requires secrets to be a list of non-empty strings and isAddressSecret a boolean',
      }, JSON.stringify(secrets));
    });
  });

  test('gives "***" for an address without a host of its own, such as mailto:, data: or blob:', () => {
    const addresses = ['mailto:anna@example.test', 'data:text/plain,anna@example.test', 'blob:https://anna:p4ssw0rd@example.test/secret?token=abc'];

    addresses.forEach((url) => {
      assert.equal(maskUrl(url), '***', url);
      assert.equal(maskUrl(url, { isAddressSecret: true }), '***', url);
    });
  });
});

describe('parseUpstreamUrl', () => {
  test('gives the URL of an http or https address, from a text or a URL object', () => {
    ['http://127.0.0.1:8080/v1?page=2', 'https://api.example.test/v1'].forEach((text) => {
      const parsed = parseUpstreamUrl(text);

      assert.ok(parsed instanceof URL, text);
      assert.equal(parsed.href, new URL(text).href);
    });
    assert.equal(parseUpstreamUrl(new URL('https://api.example.test/v1')).href, 'https://api.example.test/v1');
  });

  test('gives null for any other scheme, for credentials and for what is not a URL', () => {
    const refused = [
      'ftp://api.example.test/v1',
      'file:///etc/passwd',
      'ws://api.example.test/v1',
      'mailto:anna@example.test',
      'gopher://api.example.test/v1',
      'https://anna@api.example.test/v1',
      'https://:p4ssw0rd@api.example.test/v1',
      'https://anna:p4ssw0rd@api.example.test/v1',
      new URL('https://anna:p4ssw0rd@api.example.test/v1'),
      'api.example.test/v1',
      '',
      undefined,
      null,
      42,
    ];

    refused.forEach((value) => assert.equal(parseUpstreamUrl(value), null, String(value)));
  });
});

describe('fetchJson', () => {
  test('sends the json as a JSON body under its content type, asks for JSON and gives the parsed answer', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerJson(201, JSON.stringify({ id: 7, isCreated: true })));
    const result = await run(() => fetchJson(`${upstream.url}/v1/items`, { service: SERVICE, method: 'POST', json: { name: 'Anna' } }));
    const [request] = upstream.requests;

    assert.deepEqual(result, { id: 7, isCreated: true });
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { name: 'Anna' });
    assert.equal(toMimeEssence(request.headers['content-type']), 'application/json');
    assert.equal(request.headers.accept, 'application/json');
  });

  test('lets a header of the caller win in any case it is written in: two spellings would be joined into one value', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerJson(200, '{}'));

    await run(() => fetchJson(`${upstream.url}/v1/items`, {
      service: SERVICE,
      method: 'POST',
      json: { name: 'Anna' },
      headers: { 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json' },
    }));

    const [request] = upstream.requests;

    assert.equal(request.headers['content-type'], 'application/vnd.api+json');
    assert.equal(request.headers.accept, 'application/vnd.api+json');
  });

  test('reads JSON after a byte order mark, as response.json() of fetch does', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerJson(200, `${String.fromCharCode(0xFEFF)}{"a":1}`));

    assert.deepEqual(await run(() => fetchJson(`${upstream.url}/v1/items`, { service: SERVICE })), { a: 1 });
  });

  test('resolves null for a success without a body, a 204 or an empty 200', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(request.url.endsWith('/204') ? 204 : 200);
      response.end();
    });
    const results = await Promise.all(['/v1/204', '/v1/200'].map((path) => run(() => fetchJson(`${upstream.url}${path}`, { service: SERVICE }))));

    assert.deepEqual(results, [null, null]);
  });

  test('masks in the body of a refusal the secrets it echoes as a URL, a form, encodeURIComponent() and JSON.stringify() write them, and keeps the rest', async (t) => {
    const { run } = openContext({ http: { errorBodyMaxLength: 2048 } });
    const upstream = await createUpstream(t, (request, response) => {
      const echo = {
        error: { code: 1001, message: 'Authentication failed', lang: 'en' },
        path: request.url,
        decoded: decodeURIComponent(request.url),
        note: `Cannot POST ${new URLSearchParams(request.url.split('?')[1]).get('access_token')}`,
      };

      response.writeHead(401, { 'content-type': 'application/json' });
      // As PHP writes JSON by default: "/" as "\/".
      response.end(JSON.stringify(echo).replaceAll('/', '\\/'));
    });
    const token = '123:SECRET-TOKEN';
    const url = new URL(`${upstream.url}/bot${token}/v1/items?page=2&lang=en&BARE-SECRET-KEY`);

    url.searchParams.set('access_token', 'QS~SECRET~TOKEN');
    url.searchParams.set('key', 'PLUS SECRET VALUE');

    const error = await rejectionOf(run(() => fetchJson(url, {
      service: SERVICE,
      method: 'POST',
      json: {},
      secrets: [token],
    })));
    const { body } = assertUpstreamFailure(error, 'status');

    assert.equal(readErrorTexts(error).includes('SECRET'), false, body);
    assert.equal(body.startsWith('{"error":{"code":1001,"message":"Authentication failed","lang":"en"}'), true, body);
    assert.equal(body.includes('page=2&lang=en'), true, body);
  });

  test('masks in the body of a refusal a base64 token with its padding that is the whole query', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path: request.url, keys: [...new URL(request.url, upstream.url).searchParams.keys()] }));
    });
    const rewritten = new URL(`${upstream.url}/hook?dG9rZW4tc2VjcmV0MTIzNA==`);

    rewritten.searchParams.set('format', 'json');

    const [raw, set] = await Promise.all([`${upstream.url}/hook?dG9rZW4tc2VjcmV0MTIzNA==`, rewritten].map((url) => rejectionOf(run(() => fetchJson(url, { service: SERVICE })))));

    assert.equal(assertUpstreamFailure(raw, 'status').body, '{"path":"/hook?***==","keys":["***"]}');
    assert.equal(assertUpstreamFailure(set, 'status').body, '{"path":"/hook?***=%3D&format=json","keys":["***","format"]}');
    [raw, set].forEach((error) => assert.equal(readLoggedText(error).includes('dG9rZW4'), false));
  });

  test('keeps the body of a refusal whole when a path in the query has a short form: one letter is no secret', async (t) => {
    const { run } = openContext();
    const body = '{"error":"not_found","message":"the file is not here, see https://docs.test/errors"}';
    const upstream = await createUpstream(t, answerJson(404, body));
    const queries = ['file=../../../e', 'file=..%2F..%2F..%2Fe', 'next=/home/../', 'file=reports/../r'];
    const errors = await Promise.all(queries.map((query) => rejectionOf(run(() => fetchJson(`${upstream.url}/v1?${query}`, { service: SERVICE })))));

    errors.forEach((error, index) => assert.equal(assertUpstreamFailure(error, 'status').body, body, queries[index]));
  });

  test('masks the values an error of the upstream repeats, in a text and in JSON, before it cuts the refusal', async (t) => {
    const { run } = openContext();
    const letter = Array.from({ length: 60 }, (_, index) => `PRIVATE-LINE-${index} of the letter`).join('\n');
    const message = `The value "${letter}" cannot be converted to an integer.`;
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(request.url === '/json'
        ? JSON.stringify({ statusCode: 500, message })
        : message);
    });
    const [text, json] = await Promise.all(['/text', '/json'].map((path) => rejectionOf(run(() => fetchJson(`${upstream.url}${path}`, { service: SERVICE })))));

    assert.equal(assertUpstreamFailure(text, 'status').body, 'The value "***" cannot be converted to an integer.');
    assert.equal(assertUpstreamFailure(json, 'status').body, '{"statusCode":500,"message":"The value \\"***\\" cannot be converted to an integer."}');
  });

  test('masks a named secret however short in every form of it, and a value of the query in those of its own', async (t) => {
    const { run } = openContext();
    const echo = ['a b/c', 'a%20b%2Fc', 'a+b%2fc', 'a b\\/c'].map((form) => `"${form}"`).join();
    const upstream = await createUpstream(t, answerJson(403, `{"named":[${echo}],"query":["QUERY%20SECRET%2FVALUE","QUERY SECRET\\/VALUE"]}`));
    const error = await rejectionOf(run(() => fetchJson(`${upstream.url}/v1?key=QUERY+SECRET%2FVALUE`, { service: SERVICE, secrets: ['a b/c'] })));

    assert.equal(assertUpstreamFailure(error, 'status').body, '{"named":["***","***","***","***"],"query":["***","***"]}');
  });

  test('keeps no body of a refusal for a secret address: an upstream may echo it cut into its segments', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `unknown hook ${request.url.split('/').at(-1)}` }));
    });
    const error = await rejectionOf(run(() => fetchJson(`${upstream.url}/hooks/T1/PATH-SECRET-123`, {
      service: SERVICE,
      method: 'POST',
      json: {},
      isAddressSecret: true,
    })));

    assert.equal(assertUpstreamFailure(error, 'status').body, undefined);
    assert.equal(readErrorTexts(error).includes('PATH-SECRET-123'), false);
  });

  test('refuses a body with GET or HEAD before any request: fetch would refuse it as a failure of the way there', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerJson(200, '{}'));

    await Promise.all([
      assert.rejects(run(() => fetchJson(`${upstream.url}/v1/items`, { service: SERVICE, json: { name: 'Anna' } })), { name: 'TypeError', message: /sends no body with GET/ }),
      assert.rejects(run(() => fetchUpstream(`${upstream.url}/v1/items`, { service: SERVICE, method: 'head', body: 'x' })), { name: 'TypeError', message: /sends no body with HEAD/ }),
    ]);
    assert.deepEqual(upstream.requests, []);
  });

  test('sends no content type without json, and a header of the caller wins over its own', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerJson(200, '[1,2]'));
    const result = await run(() => fetchJson(`${upstream.url}/v1/items`, { service: SERVICE, headers: { accept: 'application/vnd.api+json' } }));
    const [request] = upstream.requests;

    assert.deepEqual(result, [1, 2]);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['content-type'], undefined);
    assert.equal(request.headers.accept, 'application/vnd.api+json');
  });

  test('rejects a status that is not a success with "status", the status and the start of the body cut to config.http.errorBodyMaxLength', async (t) => {
    const { run } = openContext({ http: { errorBodyMaxLength: 16 } });
    const upstream = await createUpstream(t, answerJson(401, '{"error":"invalid_token","detail":"revoked"}'));
    const error = await rejectionOf(run(() => fetchJson(`${upstream.url}/v1/items`, { service: SERVICE })));
    const cause = assertUpstreamFailure(error, 'status');

    assert.equal(cause.status, 401);
    assert.equal(cause.body, '{"error":"inval…');
    assert.equal(cause.service, SERVICE);
    assert.equal(cause.url, `${upstream.url}/v1/items`);
  });

  test('keeps a short body of a refusal whole and gives no body for an empty one', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(request.url.endsWith('/empty') ? 503 : 404);
      response.end(request.url.endsWith('/empty') ? '' : 'not found');
    });
    const [short, empty] = await Promise.all(['/v1/short', '/v1/empty'].map((path) => rejectionOf(run(() => fetchJson(`${upstream.url}${path}`, { service: SERVICE })))));

    assert.equal(assertUpstreamFailure(short, 'status').body, 'not found');
    assert.equal(Object.hasOwn(assertUpstreamFailure(empty, 'status'), 'body'), false);
  });

  test('rejects an answer that is not JSON with "invalid-json" and its status, without the parse error: it quotes the body', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerJson(200, `{"access_token": ${SECRET}}`));
    const error = await rejectionOf(run(() => fetchJson(`${upstream.url}/v1/items`, { service: SERVICE })));
    const cause = assertUpstreamFailure(error, 'invalid-json');

    assert.equal(cause.status, 200);
    assert.equal(cause.cause, undefined);
    assert.equal(readErrorTexts(error).includes(SECRET), false);
  });

  test('rejects a failure of the way there as fetchUpstream does', async () => {
    const { run } = openContext();
    const error = await rejectionOf(run(() => fetchJson(`ftp://upstream.example.test/v1?token=${SECRET}`, { service: SERVICE })));

    assertUpstreamFailure(error, 'invalid-url');
    assert.equal(readErrorTexts(error).includes(SECRET), false);
  });

  test('takes either json or body, not both', async () => {
    const { run } = openContext();

    await assert.rejects(run(() => fetchJson('http://127.0.0.1/v1', { service: SERVICE, json: {}, body: '{}' })), {
      name: 'TypeError',
      message: /takes either json or body/,
    });
  });

  test('requires headers to be a plain object and the name of the service', async () => {
    const { run } = openContext();

    await assert.rejects(run(() => fetchJson('http://127.0.0.1/v1', { service: SERVICE, headers: new Headers() })), {
      name: 'TypeError',
      message: /requires headers to be a plain object/,
    });
    await assert.rejects(run(() => fetchJson('http://127.0.0.1/v1', { json: {} })), {
      name: 'TypeError',
      message: /requires options with the name of the service/,
    });
  });
});

describe('UpstreamError', () => {
  test('requires a reason from src/enums/upstream-failure.js', () => {
    [undefined, '', 'unknown', 'TIMEOUT', 'constructor', 'toString'].forEach((reason) => {
      assert.throws(() => new UpstreamError(reason), {
        name: 'TypeError',
        message: /requires a reason from src\/enums\/upstream-failure\.js/,
      }, String(reason));
    });
  });

  test('carries its reason, its details and its cause, and leaves out a detail that is undefined or null', () => {
    const cause = new Error('socket hang up');
    const error = new UpstreamError('network', {
      service: SERVICE,
      code: undefined,
      status: null,
      durationMs: 12,
      cause,
    });

    assert.equal(error.message, 'The upstream could not be reached');
    assert.equal(error.cause, cause);
    assert.deepEqual({ ...error }, { reason: 'network', service: SERVICE, durationMs: 12 });
    assert.equal(Object.hasOwn(new UpstreamError('timeout'), 'cause'), false);
  });

  test('keeps its name on the prototype, so a log line does not repeat it next to the type', () => {
    const sink = createLogSink();
    const error = new UpstreamError('timeout', { service: SERVICE });

    createLogger({ level: 'info', stream: sink.stream }).error({ err: error }, 'failed');

    assert.ok(error instanceof Error);
    assert.equal(error.name, 'UpstreamError');
    assert.equal(Object.hasOwn(error, 'name'), false);
    assert.equal(Object.getOwnPropertyDescriptor(UpstreamError.prototype, 'name').enumerable, false);
    assert.match(error.stack, /^UpstreamError: The upstream did not answer in time/);
    assert.equal(sink.lines[0].err.type, 'UpstreamError');
    assert.equal(Object.hasOwn(sink.lines[0].err, 'name'), false);
  });
});

describe('findUpstreamError and toUpstreamAppError', () => {
  test('findUpstreamError finds the failure itself and as the cause of an AppError, and gives null for anything else', () => {
    const upstreamError = new UpstreamError('timeout');
    const others = [
      new Error('boom'),
      new AppError('SERVER_ERROR'),
      new AppError('SERVER_ERROR', { cause: new Error('boom') }),
      { cause: upstreamError },
      null,
      undefined,
      'timeout',
    ];

    assert.equal(findUpstreamError(upstreamError), upstreamError);
    assert.equal(findUpstreamError(new AppError('UPSTREAM_ERROR', { cause: upstreamError })), upstreamError);
    others.forEach((value) => assert.equal(findUpstreamError(value), null, String(value)));
  });

  test('toUpstreamAppError wraps the failure into an AppError UPSTREAM_ERROR that answers 502', () => {
    const upstreamError = new UpstreamError('status', { status: 503 });
    const error = toUpstreamAppError(upstreamError);

    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.statusCode, 502);
    assert.equal(error.message, 'Upstream error');
    assert.equal(error.cause, upstreamError);
    assert.equal(findUpstreamError(error), upstreamError);
  });

  test('createUpstreamFailure names the call by its service, method and masked address, with the details it is given', () => {
    const call = { service: SERVICE, method: 'POST', loggedUrl: 'https://api.example.test/v1?token=***' };
    const cause = assertUpstreamFailure(createUpstreamFailure(call, 'status', { status: 503, durationMs: 40, body: undefined }), 'status');

    assert.deepEqual({ ...cause }, {
      reason: 'status',
      service: SERVICE,
      method: 'POST',
      url: 'https://api.example.test/v1?token=***',
      status: 503,
      durationMs: 40,
    });
  });

  test('createWayFailure gives "timeout" for the deadline and "network" with the code of the socket for the rest', () => {
    const call = { service: SERVICE, method: 'GET', loggedUrl: 'https://api.example.test/v1' };
    const deadline = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const refusal = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const { signal } = new AbortController();
    const timeout = assertUpstreamFailure(createWayFailure(call, deadline, signal, 40), 'timeout');
    const network = assertUpstreamFailure(createWayFailure(call, refusal, signal, 40), 'network');
    const aborted = assertUpstreamFailure(createWayFailure(call, refusal, AbortSignal.abort(deadline), 40), 'timeout');
    const refusalCause = { type: 'TypeError', cause: { type: 'Error', code: 'ECONNREFUSED' } };

    assert.deepEqual([timeout.cause, network.cause, aborted.cause], [{ type: 'TimeoutError' }, refusalCause, refusalCause]);
    assert.deepEqual([timeout.code, network.code], [undefined, 'ECONNREFUSED']);
    assert.deepEqual([timeout.durationMs, network.durationMs], [40, 40]);
  });

  test('createWayFailure follows a chain of causes only so far, and takes what is not an error for no cause', () => {
    const call = { service: SERVICE, method: 'GET', loggedUrl: 'https://api.example.test/v1' };
    const { signal } = new AbortController();
    const loop = new Error('loop');

    loop.cause = loop;

    assert.equal(readCauseChain(createWayFailure(call, loop, signal, 40).cause.cause).length, 5);
    assert.equal(createWayFailure(call, 'refused', signal, 40).cause.cause, undefined);
  });
});

describe('assertServiceOptions and readTimeout', () => {
  const CALL = 'call(url, { service, timeout })';

  test('assertServiceOptions takes options that name the service and refuses the rest under the signature of the caller', () => {
    assert.equal(assertServiceOptions({ service: SERVICE }, CALL), true);
    [undefined, null, {}, { service: '' }, { service: 1 }, 'service'].forEach((options) => {
      assert.throws(() => assertServiceOptions(options, CALL), {
        name: 'TypeError',
        message: `${CALL} requires options with the name of the service, for the log and the alert`,
      }, JSON.stringify(options));
    });
  });

  test('readTimeout reads the value in milliseconds, the fallback without one, and refuses what is not above zero', () => {
    assert.equal(readTimeout('2s', '5s', CALL), 2000);
    assert.equal(readTimeout(undefined, '5s', CALL), 5000);
    ['0s', '-1s'].forEach((value) => {
      assert.throws(() => readTimeout(value, '5s', CALL), {
        name: 'TypeError',
        message: `${CALL} requires a timeout above zero, such as "5s"`,
      }, value);
    });
  });
});

describe('isSuccessStatus', () => {
  test('takes the integers from 200 to 299 only', () => {
    [200, 201, 204, 299].forEach((status) => assert.equal(isSuccessStatus(status), true, String(status)));
    [199, 300, 302, 404, 500, 200.5, '200', null, undefined, Number.NaN].forEach((status) => {
      assert.equal(isSuccessStatus(status), false, String(status));
    });
  });
});

describe('isRedirectStatus', () => {
  test('takes the integers from 300 to 399 only', () => {
    [300, 301, 304, 308, 399].forEach((status) => assert.equal(isRedirectStatus(status), true, String(status)));
    [200, 299, 400, 404, 500, 300.5, '301', null, undefined, Number.NaN].forEach((status) => {
      assert.equal(isRedirectStatus(status), false, String(status));
    });
  });
});

describe('logUpstreamCall and logUpstreamFailure', () => {
  test('write one info line each: the call with what it is given, the failure with its reason, code and duration', () => {
    const { run, sink } = openContext();
    const call = { service: SERVICE, method: 'GET', loggedUrl: 'https://api.example.test/v1' };
    const described = { service: SERVICE, method: 'GET', url: 'https://api.example.test/v1' };

    run(() => {
      logUpstreamCall(call, { status: 200, durationMs: 5 });
      logUpstreamFailure(call, createUpstreamFailure(call, 'network', { code: 'ECONNRESET', durationMs: 7 }));
      logUpstreamFailure(call, new Error('not a failure of an upstream'));
    });

    const calls = findLogLines(sink, REQUEST_MESSAGE);
    const failures = findLogLines(sink, FAILED_MESSAGE);

    assert.deepEqual(calls.map(({ level, upstream }) => [level, upstream]), [[LOG_LEVEL.INFO, { ...described, status: 200, durationMs: 5 }]]);
    assert.deepEqual(failures.map(({ level, upstream }) => [level, upstream]), [
      [LOG_LEVEL.INFO, {
        ...described,
        reason: 'network',
        code: 'ECONNRESET',
        durationMs: 7,
      }],
      [LOG_LEVEL.INFO, described],
    ]);
  });
});
