import { once } from 'node:events';
import net from 'node:net';

const SOCKET_TIMEOUT_MS = 3000;

// How a server drops a connection whose request it has not read to the end.
const RESET_CODES = Object.freeze(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

// For what fastify.inject() cannot show: it bypasses the HTTP parser and has no real connection to tear down.
// Resolves with what the server wrote before it closed the connection, so the request has to say
// "Connection: close" unless the server is expected to drop the connection itself. A connection still open
// at the deadline is a failure, not an answer: a response that hangs or drips must not look like one that was
// torn down. A reset may take the last bytes with it: a test that reads the text leaves no request bytes unread.
export function sendRawRequest(port, text, { timeoutMs = SOCKET_TIMEOUT_MS, followUp = null } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy(new Error(`sendRawRequest(port, text): the server kept the connection open for ${timeoutMs} ms`));
    }, timeoutMs);

    socket.once('connect', () => socket.write(text));

    // Once an answer has started: what comes in the same write as a request is read by the parser before any async hook
    // of that request has run.
    if (followUp !== null) {
      socket.once('data', () => socket.write(followUp));
    }

    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => {
      if (!RESET_CODES.includes(error.code)) {
        reject(error);
      }
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
  });
}

// A connection a test writes to piece by piece and may drop in the middle of a request, which sendRawRequest() cannot:
// it writes a request at once. "closed" resolves as sendRawRequest() does; "received" tells when the answer began.
export async function openRawConnection(port, { timeoutMs = SOCKET_TIMEOUT_MS } = {}) {
  const socket = net.connect({ host: '127.0.0.1', port });

  await once(socket, 'connect');

  const received = { chunks: [], firstAt: null };
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy(new Error(`openRawConnection(port): the server kept the connection open for ${timeoutMs} ms`));
    }, timeoutMs);

    socket.on('data', (chunk) => {
      received.firstAt ??= performance.now();
      received.chunks.push(chunk);
    });
    socket.on('error', (error) => {
      if (!RESET_CODES.includes(error.code)) {
        reject(error);
      }
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(received.chunks).toString('latin1'));
    });
  });

  // Once the bytes are handed to the system, or the server has torn the connection down under them.
  function write(bytes) {
    return new Promise((resolve) => {
      socket.write(bytes, () => resolve(true));
    });
  }

  return {
    socket,
    received,
    closed,
    write,
  };
}
