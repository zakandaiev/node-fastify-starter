import { createHttpConfig } from '#config/http.js';
import { createContext, runInContext } from '#core/context/index.js';
import { AppError } from '#core/error/index.js';
import { fetchExternal } from '#core/http/external.js';
import { findUpstreamError, UpstreamError } from '#core/http/index.js';
import { createLogger, serializeError } from '#core/logger/index.js';
import { rejectionOf, timeIt } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { createRawServer, readByteByByte } from '#root/tests/helper/net.js';
import { getFreePort } from '#root/tests/helper/process.js';
import assert from 'node:assert/strict';
import { lookup as dnsLookup } from 'node:dns/promises';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { describe, test } from 'node:test';

const LOOPBACK = '127.0.0.1';
const LOOPBACK_NETWORK = '127.0.0.1/32';
const SERVICE = 'test-avatar';

const PNG_TYPE = 'image/png';
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]);
const ALLOWED = Object.freeze({ allowedHosts: Object.freeze([LOOPBACK]), allowedTypes: Object.freeze([PNG_TYPE]) });

const REQUEST_MESSAGE = 'Upstream request';
const FAILED_MESSAGE = 'Upstream request failed';

const HTTP_DEFAULTS = createHttpConfig();

const MAX_BYTES = 64;
const STREAM_CHUNK = Buffer.alloc(16);
const STREAM_INTERVAL_MS = 5;

const SHORT_TIMEOUT = '0.3s';
const SHORT_TIMEOUT_MS = 300;
// The millisecond clock of libuv floors the moment a timer starts at: a timer may fire a millisecond early.
const TIMER_SLACK_MS = 5;
// Far below the default deadline of 10s: a refusal that waited for the deadline is not the one under test.
const QUICK_MS = 2000;

const HOP_DELAY_MS = 300;
const HOPS_TIMEOUT = '0.5s';

const USER_NAME = 'anna.kovalenko';

const CRLF = '\r\n';
const UPGRADE_ANSWER = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: other', 'Connection: Upgrade', '', ''].join(CRLF);
const MOVED_ANSWER = ['HTTP/1.1 302 Found', 'Location: /upgrade', 'Content-Length: 0', '', ''].join(CRLF);

// A label over 63 characters: the lookup of such a name fails without a query.
const UNRESOLVABLE_SITE = `${'a'.repeat(64)}.test`;

// The content type of a TLS record that carries a handshake, the first byte a client sends.
const TLS_HANDSHAKE_RECORD = 0x16;

function openContext({ networks = [LOOPBACK_NETWORK], external = {} } = {}) {
  const sink = createLogSink();
  const config = createTestConfig({
    http: { external: { ...HTTP_DEFAULTS.external, allowedPrivateNetworks: networks, ...external } },
    logger: { level: 'info', stream: sink.stream },
  });
  const context = createContext({ config, log: createLogger(config.logger) });

  function run(fn) {
    return runInContext(context, fn);
  }

  return { sink, run };
}

function fetchFrom(run, url, options = {}) {
  return run(() => fetchExternal(url, { service: SERVICE, ...ALLOWED, ...options }));
}

// A local upstream: "answer" writes each response as node:http lets it, and every request is recorded once read.
async function createUpstream(t, answer) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests.push({ method: request.method, path: request.url, headers: request.headers });
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

  const { port } = server.address();

  return { url: `http://${LOOPBACK}:${port}`, port, requests };
}

function answerPng(request, response) {
  response.writeHead(200, { 'content-type': PNG_TYPE, 'content-length': String(PNG.length) });
  response.end(PNG);
}

function redirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

// The path /hops/N redirects N times before the image.
function answerHops(request, response) {
  const hopsLeft = Number(request.url.split('/').at(-1));

  if (hopsLeft > 0) {
    redirect(response, `/hops/${hopsLeft - 1}`);
  } else {
    answerPng(request, response);
  }
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

describe('fetchExternal', () => {
  test('resolves with the address, the status, the type and the bytes of an answer from an allowed host and of an allowed type', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerPng);
    const result = await fetchFrom(run, `${upstream.url}/avatars/1.png`);

    assert.deepEqual(Object.keys(result).sort(), ['bytes', 'contentType', 'status', 'url']);
    assert.equal(result.url, `${upstream.url}/avatars/1.png`);
    assert.equal(result.status, 200);
    assert.equal(result.contentType, PNG_TYPE);
    assert.ok(Buffer.isBuffer(result.bytes));
    assert.deepEqual(result.bytes, PNG);
  });

  test('takes the address as a URL object too', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerPng);
    const result = await fetchFrom(run, new URL(`${upstream.url}/avatars/1.png`));

    assert.deepEqual(result.bytes, PNG);
  });

  test('asks with GET for the types it takes, and for the bytes as they are, not compressed', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerPng);

    await fetchFrom(run, `${upstream.url}/avatars/1.png`, { allowedTypes: [PNG_TYPE, 'image/webp'] });

    const [request] = upstream.requests;

    assert.equal(request.method, 'GET');
    assert.equal(request.headers.accept, 'image/png, image/webp');
    assert.equal(request.headers['accept-encoding'], 'identity');
  });

  test('reads a type by its essence: neither its parameters nor the case of its letters count', async (t) => {
    const { run } = openContext();
    const types = ['image/png; charset=binary', 'Image/PNG'];
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(200, { 'content-type': types[Number(request.url.slice(1))] });
      response.end(PNG);
    });
    const results = await Promise.all(types.map((type, index) => fetchFrom(run, `${upstream.url}/${index}`)));

    results.forEach((result, index) => assert.equal(result.contentType, PNG_TYPE, types[index]));
  });

  test('reads a body of exactly maxBytes whole', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerPng);
    const result = await fetchFrom(run, `${upstream.url}/avatars/1.png`, { maxBytes: PNG.length });

    assert.deepEqual(result.bytes, PNG);
  });
});

describe('fetchExternal: hosts and addresses', () => {
  test('refuses a loopback address unless config.http.external.allowedPrivateNetworks lets it through', async (t) => {
    const { run } = openContext({ networks: [] });
    const upstream = await createUpstream(t, answerPng);
    const error = await rejectionOf(fetchFrom(run, `${upstream.url}/avatars/1.png`));

    assertUpstreamFailure(error, 'refused-address');
    assert.deepEqual(upstream.requests, []);
  });

  test('refuses a redirect to a private address at once, even one its allow-list names', async (t) => {
    const { run } = openContext();
    const targets = [
      'http://10.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
      'http://0.0.0.0/',
    ];
    const allowedHosts = [LOOPBACK, '10.0.0.1', '169.254.169.254', '::ffff:a9fe:a9fe', '0.0.0.0'];
    const upstream = await createUpstream(t, (request, response) => redirect(response, targets[Number(request.url.slice(1))]));
    const { result: errors, durationMs } = await timeIt(() => Promise.all(targets.map((target, index) => rejectionOf(fetchFrom(run, `${upstream.url}/${index}`, { allowedHosts })))));

    errors.forEach((error, index) => assertUpstreamFailure(error, 'refused-address', targets[index]));
    assert.ok(durationMs < QUICK_MS, `${durationMs} ms`);
    assert.equal(upstream.requests.length, targets.length);
  });

  test('checks the lookup of every hop: a redirect to an allowed name that resolves to a private address goes no further', async (t) => {
    const addresses = await dnsLookup('localhost', { all: true });

    if (addresses.every(({ address }) => address === LOOPBACK)) {
      t.skip('localhost resolves to 127.0.0.1 alone here: no address of it lies outside the networks the test allows');

      return false;
    }

    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => (request.url === '/start'
      ? redirect(response, `http://localhost:${upstream.port}/final.png`)
      : answerPng(request, response)));
    const error = await rejectionOf(fetchFrom(run, `${upstream.url}/start`, { allowedHosts: [LOOPBACK, 'localhost'] }));

    assertUpstreamFailure(error, 'refused-address');
    assert.deepEqual(upstream.requests.map((request) => request.path), ['/start']);

    return true;
  });

  test('speaks TLS to an https address: the first byte it sends opens a handshake', async (t) => {
    const { run } = openContext();
    const firstBytes = [];
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        firstBytes.push(chunk[0]);
        socket.destroy();
      });
    });

    t.after(() => server.close());
    server.listen(0, LOOPBACK);
    await once(server, 'listening');

    const error = await rejectionOf(fetchFrom(run, `https://${LOOPBACK}:${server.address().port}/avatars/1.png`));

    assertUpstreamFailure(error, 'network');
    assert.deepEqual(firstBytes, [TLS_HANDSHAKE_RECORD]);
  });

  test('refuses a host whose name resolves to a private address at the lookup, before any request', async (t) => {
    const { run } = openContext({ networks: [] });
    const upstream = await createUpstream(t, answerPng);
    const error = await rejectionOf(fetchFrom(run, `http://localhost:${upstream.port}/avatars/1.png`, { allowedHosts: ['localhost'] }));

    assertUpstreamFailure(error, 'refused-address');
    assert.deepEqual(upstream.requests, []);
  });

  test('refuses a redirect to a host that is not on its allow-list', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => redirect(response, 'http://evil.example.test/avatars/1.png'));
    const error = await rejectionOf(fetchFrom(run, `${upstream.url}/avatars/1.png`));

    assertUpstreamFailure(error, 'refused-host');
    assert.equal(upstream.requests.length, 1);
  });

  test('refuses an IPv6 literal of a loopback address, [::1], by its address when the allow-list names it', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerPng);
    const url = `http://[::1]:${upstream.port}/avatars/1.png`;
    const [listed, unlisted] = await Promise.all([
      rejectionOf(fetchFrom(run, url, { allowedHosts: ['::1'] })),
      rejectionOf(fetchFrom(run, url)),
    ]);

    assertUpstreamFailure(listed, 'refused-address');
    assertUpstreamFailure(unlisted, 'refused-host');
  });

  test('refuses with "invalid-url" an address with credentials, another scheme and what is not a URL, before any request', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerPng);
    const addresses = [
      `http://anna:p4ssw0rd@${LOOPBACK}:${upstream.port}/avatars/1.png`,
      `http://anna@${LOOPBACK}:${upstream.port}/avatars/1.png`,
      `ftp://${LOOPBACK}:${upstream.port}/avatars/1.png`,
      'file:///C:/avatars/1.png',
      `${LOOPBACK}:${upstream.port}/avatars/1.png`,
      undefined,
    ];
    const errors = await Promise.all(addresses.map((url) => rejectionOf(fetchFrom(run, url))));

    errors.forEach((error, index) => assertUpstreamFailure(error, 'invalid-url', String(addresses[index])));
    assert.deepEqual(upstream.requests, []);
  });

  test('refuses with "invalid-url" a redirect to an address with credentials or of another scheme', async (t) => {
    const { run } = openContext();
    const targets = [`ftp://${LOOPBACK}/avatars/1.png`, `http://anna:p4ssw0rd@${LOOPBACK}/avatars/1.png`];
    const upstream = await createUpstream(t, (request, response) => redirect(response, targets[Number(request.url.slice(1))]));
    const errors = await Promise.all(targets.map((target, index) => rejectionOf(fetchFrom(run, `${upstream.url}/${index}`))));

    errors.forEach((error, index) => assertUpstreamFailure(error, 'invalid-url', targets[index]));
    assert.equal(upstream.requests.length, targets.length);
  });

  // A name that passes the allow-list is looked up, and no name under .test resolves (RFC 2606): a refused
  // host shows it was refused before the lookup, any other failure that the lookup was tried.
  test('matches a host and its subdomains, never a host that merely ends with the same letters', async () => {
    const { run } = openContext();
    const options = { allowedHosts: ['Example.Test'], timeout: '2s' };
    const refused = ['badexample.test', 'example.test.evil.test', 'evil.test'];
    const passed = ['example.test', 'cdn.example.test', 'a.cdn.example.test'];
    const [refusedErrors, passedErrors] = await Promise.all([refused, passed].map((hosts) => Promise.all(hosts.map((host) => rejectionOf(fetchFrom(run, `http://${host}/avatars/1.png`, options))))));

    refusedErrors.forEach((error, index) => assertUpstreamFailure(error, 'refused-host', refused[index]));
    passedErrors.forEach((error, index) => {
      const cause = findUpstreamError(error);

      assert.ok(cause, `${passed[index]}: ${error}`);
      assert.notEqual(cause.reason, 'refused-host', passed[index]);
    });
  });

  test('fetches a host whose name resolves to allowed networks only, through the lookup it has checked', async (t) => {
    const { run } = openContext({ networks: [LOOPBACK_NETWORK, '::1/128'] });
    const upstream = await createUpstream(t, answerPng);
    const result = await fetchFrom(run, `http://localhost:${upstream.port}/avatars/1.png`, { allowedHosts: ['localhost'] });

    assert.deepEqual(result.bytes, PNG);
    assert.equal(upstream.requests.length, 1);
  });

  test('rejects with "network" and the code of the socket when nothing listens on the port', async () => {
    const { run } = openContext();
    const port = await getFreePort();
    const error = await rejectionOf(fetchFrom(run, `http://${LOOPBACK}:${port}/avatars/1.png`));

    assert.equal(assertUpstreamFailure(error, 'network').code, 'ECONNREFUSED');
  });

  test('rejects with "network" an answer the upstream cuts off in the middle of its body', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(200, { 'content-type': PNG_TYPE, 'content-length': String(PNG.length) });
      response.write(PNG.subarray(0, 4), () => request.socket.destroy());
    });
    const error = await rejectionOf(fetchFrom(run, `${upstream.url}/avatars/1.png`));

    assertUpstreamFailure(error, 'network');
  });
});

describe('fetchExternal: the answer', () => {
  test('refuses a body over maxBytes, streamed without a length or declared over it', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      if (request.url === '/declared') {
        response.writeHead(200, { 'content-type': PNG_TYPE, 'content-length': String(MAX_BYTES * 10) });
        response.write(STREAM_CHUNK);
      } else {
        response.writeHead(200, { 'content-type': PNG_TYPE });
        streamForever(response);
      }
    });
    const { result: [streamed, declared], durationMs } = await timeIt(() => Promise.all(['/streamed', '/declared'].map((path) => rejectionOf(fetchFrom(run, `${upstream.url}${path}`, { maxBytes: MAX_BYTES })))));

    assert.equal(assertUpstreamFailure(streamed, 'too-large', 'streamed').status, 200);
    assert.equal(assertUpstreamFailure(declared, 'too-large', 'declared').status, 200);
    assert.ok(durationMs < QUICK_MS, `${durationMs} ms`);
  });

  test('reads a body that comes byte by byte in a heap which a list of its chunks would not fit', async (t) => {
    const { code, isWhole, stderr } = await readByteByByte(t, 'external');

    assert.deepEqual([code, isWhole], [0, true], stderr.slice(0, 500));
  });

  test('takes config.http.external.maxBytes and maxRedirects when the call names none', async (t) => {
    const { run } = openContext({ external: { maxBytes: PNG.length - 1, maxRedirects: 0 } });
    const upstream = await createUpstream(t, answerHops);
    const [large, moved] = await Promise.all(['/hops/0', '/hops/1'].map((path) => rejectionOf(fetchFrom(run, `${upstream.url}${path}`))));

    assertUpstreamFailure(large, 'too-large');
    assertUpstreamFailure(moved, 'too-many-redirects');
  });

  test('refuses a type that is not on its list and an answer without a type with "refused-type"', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(200, request.url === '/html' ? { 'content-type': 'text/html' } : {});
      response.end('<p>not an image</p>');
    });
    const errors = await Promise.all(['/html', '/untyped'].map((path) => rejectionOf(fetchFrom(run, `${upstream.url}${path}`))));

    errors.forEach((error) => assert.equal(assertUpstreamFailure(error, 'refused-type').status, 200));
  });

  // The type of an answer without a Content-Type reads as null: a null on the list must not let such an answer in.
  test('never takes an answer without a type, not even for a null among allowedTypes', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(200);
      response.end('<p>not an image</p>');
    });
    const error = await rejectionOf(fetchFrom(run, `${upstream.url}/avatars/1.png`, { allowedTypes: [PNG_TYPE, null] }));

    assert.ok(error instanceof TypeError || findUpstreamError(error)?.reason === 'refused-type', String(error));
  });

  test('refuses a status that is not a success with "status" and that status', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(404, { 'content-type': PNG_TYPE });
      response.end(PNG);
    });
    const error = await rejectionOf(fetchFrom(run, `${upstream.url}/avatars/1.png`));

    assert.equal(assertUpstreamFailure(error, 'status').status, 404);
  });
});

describe('fetchExternal: redirects', () => {
  test('follows maxRedirects redirects and refuses one more with "too-many-redirects"', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerHops);
    const result = await fetchFrom(run, `${upstream.url}/hops/2`, { maxRedirects: 2 });
    const error = await rejectionOf(fetchFrom(run, `${upstream.url}/hops/3`, { maxRedirects: 2 }));

    assert.equal(result.url, `${upstream.url}/hops/0`);
    assert.deepEqual(result.bytes, PNG);
    assert.equal(assertUpstreamFailure(error, 'too-many-redirects').status, 302);
    assert.deepEqual(upstream.requests.map(({ path }) => path), ['/hops/2', '/hops/1', '/hops/0', '/hops/3', '/hops/2', '/hops/1']);
  });

  test('follows no redirect with maxRedirects 0', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, answerHops);
    const result = await fetchFrom(run, `${upstream.url}/hops/0`, { maxRedirects: 0 });
    const error = await rejectionOf(fetchFrom(run, `${upstream.url}/hops/1`, { maxRedirects: 0 }));

    assert.deepEqual(result.bytes, PNG);
    assertUpstreamFailure(error, 'too-many-redirects');
    assert.deepEqual(upstream.requests.map(({ path }) => path), ['/hops/0', '/hops/1']);
  });

  test('resolves a relative Location against the hop that gave it', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      if (request.url === '/avatars/start') {
        redirect(response, 'final.png');
      } else {
        answerPng(request, response);
      }
    });
    const result = await fetchFrom(run, `${upstream.url}/avatars/start`);

    assert.equal(result.url, `${upstream.url}/avatars/final.png`);
    assert.deepEqual(upstream.requests.map(({ path }) => path), ['/avatars/start', '/avatars/final.png']);
  });

  test('refuses a redirect without a Location with "invalid-url"', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(302);
      response.end();
    });
    const error = await rejectionOf(fetchFrom(run, `${upstream.url}/avatars/1.png`));

    assert.equal(assertUpstreamFailure(error, 'invalid-url').status, 302);
  });
});

describe('fetchExternal: an answer that never comes', () => {
  test('settles with "network" a 101 with an upgrade nobody listens for, on the first hop and after a redirect', { timeout: QUICK_MS }, async (t) => {
    const { run, sink } = openContext();
    const server = await createRawServer(t, (path) => (path === '/moved'
      ? MOVED_ANSWER
      : UPGRADE_ANSWER));
    const errors = await Promise.all(['/upgrade', '/moved'].map((path) => rejectionOf(fetchFrom(run, `${server.url}${path}`))));

    errors.forEach((error) => assert.equal(assertUpstreamFailure(error, 'network').code, 'ECONNRESET'));
    assert.deepEqual(findLogLines(sink, FAILED_MESSAGE).map((line) => line.upstream.code), ['ECONNRESET', 'ECONNRESET']);
  });

  test('keeps out of the failure the host of an address from outside, which a lookup quotes', async () => {
    const { run } = openContext();
    const error = await rejectionOf(fetchFrom(run, `http://${USER_NAME}.${UNRESOLVABLE_SITE}/photo.png`, { allowedHosts: [UNRESOLVABLE_SITE] }));

    assert.equal(assertUpstreamFailure(error, 'network').code, 'ENOTFOUND');
    assert.equal(JSON.stringify(serializeError(error)).includes(USER_NAME), false);
  });
});

describe('fetchExternal: the deadline', () => {
  test('covers the body: an answer that stalls after its headers ends in "timeout" once the deadline has passed', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(200, { 'content-type': PNG_TYPE });
      response.write(PNG.subarray(0, 4));
    });
    const { result: error, durationMs } = await timeIt(() => rejectionOf(fetchFrom(run, `${upstream.url}/avatars/1.png`, { timeout: SHORT_TIMEOUT })));

    assertUpstreamFailure(error, 'timeout');
    assert.ok(durationMs >= SHORT_TIMEOUT_MS - TIMER_SLACK_MS && durationMs < QUICK_MS, `${durationMs} ms`);
  });

  // A deadline for each hop would never fire here: every hop answers within it, and the chain would end in the image.
  test('is one for all the hops: a redirect does not start it again', async (t) => {
    const { run } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      setTimeout(() => answerHops(request, response), HOP_DELAY_MS);
    });
    const { result: error, durationMs } = await timeIt(() => rejectionOf(fetchFrom(run, `${upstream.url}/hops/3`, { timeout: HOPS_TIMEOUT })));

    assertUpstreamFailure(error, 'timeout');
    assert.ok(durationMs < HOP_DELAY_MS * 3, `${durationMs} ms`);
    assert.ok(upstream.requests.length <= 2, `${upstream.requests.length} requests`);
  });

  test('takes config.http.external.timeout when the call names none', async (t) => {
    const { run } = openContext({ external: { timeout: SHORT_TIMEOUT } });
    const upstream = await createUpstream(t, () => {});
    const { result: error, durationMs } = await timeIt(() => rejectionOf(fetchFrom(run, `${upstream.url}/avatars/1.png`)));

    assertUpstreamFailure(error, 'timeout');
    assert.ok(durationMs < QUICK_MS, `${durationMs} ms`);
  });
});

describe('fetchExternal: the log', () => {
  test('logs the call once with the host and not the path, which may name the user', async (t) => {
    const { run, sink } = openContext();
    const upstream = await createUpstream(t, answerPng);

    await fetchFrom(run, `${upstream.url}/avatars/${USER_NAME}/photo.png?user=${USER_NAME}#${USER_NAME}`);

    const [line, ...rest] = findLogLines(sink, REQUEST_MESSAGE);

    assert.deepEqual(rest, []);
    assert.equal(line.level, LOG_LEVEL.INFO);
    assert.ok(Number.isInteger(line.upstream.durationMs) && line.upstream.durationMs >= 0, String(line.upstream.durationMs));
    assert.deepEqual(line.upstream, {
      service: SERVICE,
      method: 'GET',
      url: `${upstream.url}/***?***`,
      status: 200,
      durationMs: line.upstream.durationMs,
      redirectCount: 0,
      byteLength: PNG.length,
    });
    assert.equal(JSON.stringify(sink.lines).includes(USER_NAME), false);
  });

  test('writes nothing of the address a redirect leads to', async (t) => {
    const { run, sink } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      if (request.url === '/start') {
        redirect(response, `/avatars/${USER_NAME}/photo.png`);
      } else {
        answerPng(request, response);
      }
    });

    await fetchFrom(run, `${upstream.url}/start`);

    const [line] = findLogLines(sink, REQUEST_MESSAGE);

    assert.equal(line.upstream.url, `${upstream.url}/***`);
    assert.equal(line.upstream.redirectCount, 1);
    assert.equal(JSON.stringify(sink.lines).includes(USER_NAME), false);
  });

  test('writes the host and not the path of an answer it refuses to the error and the log', async (t) => {
    const { run, sink } = openContext();
    const upstream = await createUpstream(t, (request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<p>${USER_NAME}</p>`);
    });
    const error = await rejectionOf(fetchFrom(run, `${upstream.url}/avatars/${USER_NAME}/photo.png`));
    const cause = assertUpstreamFailure(error, 'refused-type');
    const [line] = findLogLines(sink, FAILED_MESSAGE);

    assert.equal(cause.url, `${upstream.url}/***`);
    assert.equal(line.upstream.url, `${upstream.url}/***`);
    assert.equal(line.upstream.reason, 'refused-type');
    assert.equal(JSON.stringify(cause).includes(USER_NAME), false);
    assert.equal(JSON.stringify(sink.lines).includes(USER_NAME), false);
  });

  test('writes nothing of the path of an address it refuses as invalid to the error or the log', async () => {
    const { run, sink } = openContext();
    const addresses = [
      `ftp://cdn.example.test/avatars/${USER_NAME}/photo.png`,
      `http://anna:p4ssw0rd@cdn.example.test/avatars/${USER_NAME}/photo.png`,
    ];
    const errors = await Promise.all(addresses.map((url) => rejectionOf(fetchFrom(run, url, { allowedHosts: ['cdn.example.test'] }))));

    errors.forEach((error, index) => {
      const cause = assertUpstreamFailure(error, 'invalid-url', addresses[index]);

      assert.equal(JSON.stringify(cause).includes(USER_NAME), false, `${addresses[index]} gave ${cause.url}`);
    });
    assert.equal(JSON.stringify(sink.lines).includes(USER_NAME), false);
  });
});

// No private network is let through here: a check that let a wrong option pass must not reach a port of this machine.
describe('fetchExternal: options', () => {
  const URL_TEXT = `http://${LOOPBACK}/avatars/1.png`;

  test('requires options with the name of the service', async () => {
    const { run } = openContext({ networks: [] });
    const refused = [undefined, null, { ...ALLOWED }, { ...ALLOWED, service: '' }, { ...ALLOWED, service: 1 }];

    await Promise.all(refused.map((options) => assert.rejects(run(() => fetchExternal(URL_TEXT, options)), {
      name: 'TypeError',
      message: /requires options with the name of the service/,
    }, JSON.stringify(options))));
  });

  test('requires allowedHosts: a non-empty list of hosts', async () => {
    const { run } = openContext({ networks: [] });
    const refused = [undefined, [], [''], 'example.test', [1], ['example.test', null]];

    await Promise.all(refused.map((allowedHosts) => assert.rejects(fetchFrom(run, URL_TEXT, { allowedHosts }), {
      name: 'TypeError',
      message: /requires allowedHosts/,
    }, JSON.stringify(allowedHosts))));
  });

  test('requires allowedTypes: media types in lower case and without parameters', async () => {
    const { run } = openContext({ networks: [] });
    const refused = [undefined, [], ['image/png; charset=binary'], ['Image/PNG'], ['png'], PNG_TYPE, [PNG_TYPE, 1]];

    await Promise.all(refused.map((allowedTypes) => assert.rejects(fetchFrom(run, URL_TEXT, { allowedTypes }), {
      name: 'TypeError',
      message: /requires allowedTypes/,
    }, JSON.stringify(allowedTypes))));
  });

  test('requires maxBytes above zero, maxRedirects not below zero and a timeout above zero', async () => {
    const { run } = openContext({ networks: [] });
    const refused = [{ maxBytes: 0 }, { maxBytes: 1.5 }, { maxBytes: '64' }, { maxRedirects: -1 }, { maxRedirects: 0.5 }];

    await Promise.all(refused.map((options) => assert.rejects(fetchFrom(run, URL_TEXT, options), {
      name: 'TypeError',
      message: /requires maxBytes above zero and maxRedirects not below zero/,
    }, JSON.stringify(options))));
    await assert.rejects(fetchFrom(run, URL_TEXT, { timeout: '0s' }), { name: 'TypeError', message: /requires a timeout above zero/ });
    await assert.rejects(fetchFrom(run, URL_TEXT, { timeout: '5 min' }), TypeError);
  });

  test('requires config.http.external.allowedPrivateNetworks to be a list of CIDR blocks', async () => {
    const { run } = openContext({ networks: [LOOPBACK] });

    await assert.rejects(fetchFrom(run, URL_TEXT), {
      name: 'TypeError',
      message: 'config.http.external.allowedPrivateNetworks must be a list of CIDR blocks',
    });
  });
});
