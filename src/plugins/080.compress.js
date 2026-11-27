import { HTTP_METHOD } from '#enums/http-method.js';
import { isArray } from '#utils/type.js';
import fastifyCompress from '@fastify/compress';
import fp from 'fastify-plugin';
import { parseHeadOnSendHandlers } from 'fastify/lib/head-route.js';

// In the order the server prefers among those the client accepts.
const ENCODINGS = Object.freeze(['br', 'gzip', 'deflate']);

// The onSend handler Fastify gives the HEAD twin of a GET: it writes the length of the body it gets and drops the body.
const HEAD_SEND = parseHeadOnSendHandlers(null);

// Compress pushes its own after that handler: the twin would tell the length of the body before compression and leave
// Content-Encoding and Vary out, unlike its GET.
function sendHeadLast(routeOptions) {
  const { method, onSend } = routeOptions;

  if (method !== HTTP_METHOD.HEAD || !isArray(onSend) || !onSend.includes(HEAD_SEND)) {
    return false;
  }

  routeOptions.onSend = [...onSend.filter((hook) => hook !== HEAD_SEND), HEAD_SEND];

  return true;
}

// Answers only: a browser never compresses what it sends, and a decoder of request bodies would be one more parser
// that anyone can reach.
async function useCompress(fastify) {
  await fastify.register(fastifyCompress, {
    encodings: ENCODINGS,
    threshold: fastify.config.app.compressMinBytes,
    globalDecompression: false,
  });

  fastify.addHook('onRoute', sendHeadLast);
}

export default fp(useCompress, { name: 'compress' });
