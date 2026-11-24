import { runNode } from '#root/tests/helper/process.js';
import { once } from 'node:events';
import net from 'node:net';

const LOOPBACK = '127.0.0.1';
const CRLF = '\r\n';
const BYTE_CHUNK = `1${CRLF}x${CRLF}`;
const LAST_CHUNK = `0${CRLF}${CRLF}`;

// Below what a list of the chunks of such a body takes, far above what the body itself does.
const BODY_BYTES = 1024 * 1024;
const SMALL_HEAP = Object.freeze({ NODE_OPTIONS: '--max-old-space-size=48' });
const READ_BYTE_BY_BYTE = 'tests/fixture/read-byte-by-byte.js';

// Answers each request with the bytes it is given, also with those node:http would refuse to write.
export async function createRawServer(t, readAnswer) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', (chunk) => {
      const [, path] = chunk.toString('latin1').split(' ');

      socket.write(readAnswer(path));
    });
  });

  t.after(() => {
    sockets.forEach((socket) => socket.destroy());
    server.close();
  });

  server.listen(0, LOOPBACK);
  await once(server, 'listening');

  const { port } = server.address();

  return { url: `http://${LOOPBACK}:${port}`, port };
}

// A process with a small heap reads a body whose every byte is an HTTP chunk of its own, with the client of this name
// ("upstream" or "external"): it exits with 0 and prints the length, or dies of a lack of memory.
export async function readByteByByte(t, client) {
  const headers = ['HTTP/1.1 200 OK', 'Content-Type: image/png', 'Transfer-Encoding: chunked', '', ''].join(CRLF);
  const server = await createRawServer(t, () => `${headers}${BYTE_CHUNK.repeat(BODY_BYTES)}${LAST_CHUNK}`);
  const { code, stdout, stderr } = await runNode(READ_BYTE_BY_BYTE, { args: [client, server.url, String(BODY_BYTES)], env: SMALL_HEAP });

  return { code, isWhole: stdout === String(BODY_BYTES), stderr };
}
