import { getFreePort } from '#root/tests/helper/process.js';
import { sendRawRequest } from '#root/tests/helper/socket.js';
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, test } from 'node:test';

const HOST = '127.0.0.1';
const SHORT_TIMEOUT_MS = 200;

// A helper whose deadline is broken never settles, and node:test has no timeout of its own:
// with this one the test fails by name instead of hanging the run.
const DEADLINE_TEST_OPTIONS = Object.freeze({ timeout: 2000 });
const DRIP_INTERVAL_MS = 50;
const UNREAD_BODY_BYTES = 4 * 1024 * 1024;
const PARTIAL_ANSWER = 'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial';

function listen(t, onRequest) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('data', () => onRequest(socket));
    });

    t.after(() => new Promise((done) => {
      sockets.forEach((socket) => socket.destroy());
      server.close(done);
    }));
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}

describe('sendRawRequest', () => {
  test('resolves with what the server wrote before it closed the connection', async (t) => {
    const port = await listen(t, (socket) => socket.end(PARTIAL_ANSWER));

    assert.equal(await sendRawRequest(port, 'GET / HTTP/1.1\r\n\r\n'), PARTIAL_ANSWER);
  });

  test('resolves with an empty text when the server drops the connection without a word', async (t) => {
    const port = await listen(t, (socket) => socket.destroy());

    assert.equal(await sendRawRequest(port, 'GET / HTTP/1.1\r\n\r\n'), '');
  });

  test('resolves when the server resets the connection with a part of the request unread', async (t) => {
    const port = await listen(t, (socket) => socket.destroy());
    const request = `POST / HTTP/1.1\r\nContent-Length: ${UNREAD_BODY_BYTES}\r\n\r\n${'x'.repeat(UNREAD_BODY_BYTES)}`;

    assert.equal(typeof await sendRawRequest(port, request), 'string');
  });

  test('rejects at the deadline when the server keeps writing: the timeout is not an idle timer', DEADLINE_TEST_OPTIONS, async (t) => {
    const port = await listen(t, (socket) => {
      const timer = setInterval(() => socket.write('.'), DRIP_INTERVAL_MS);

      socket.once('close', () => clearInterval(timer));
    });

    await assert.rejects(
      sendRawRequest(port, 'GET / HTTP/1.1\r\n\r\n', { timeoutMs: SHORT_TIMEOUT_MS }),
      /the server kept the connection open for 200 ms/,
    );
  });

  test('rejects when nothing listens on the port', async () => {
    await assert.rejects(sendRawRequest(await getFreePort(), 'GET / HTTP/1.1\r\n\r\n'), { code: 'ECONNREFUSED' });
  });

  test('rejects when the server leaves the connection open: a hang is not a torn-down response', DEADLINE_TEST_OPTIONS, async (t) => {
    const silent = await listen(t, () => {});
    const stalled = await listen(t, (socket) => socket.write(PARTIAL_ANSWER));

    await assert.rejects(
      sendRawRequest(silent, 'GET / HTTP/1.1\r\n\r\n', { timeoutMs: SHORT_TIMEOUT_MS }),
      /the server kept the connection open for 200 ms/,
    );
    await assert.rejects(
      sendRawRequest(stalled, 'GET / HTTP/1.1\r\n\r\n', { timeoutMs: SHORT_TIMEOUT_MS }),
      /the server kept the connection open for 200 ms/,
    );
  });
});
