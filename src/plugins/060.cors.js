import { HEADER } from '#enums/header.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { convertStringToWholeSeconds } from '#utils/date.js';
import fastifyCors from '@fastify/cors';
import fp from 'fastify-plugin';

const ALLOWED_METHODS = Object.freeze(Object.values(HTTP_METHOD));

// What a page of another origin may read of an answer besides the headers every browser lets through.
const EXPOSED_HEADERS = Object.freeze([HEADER.REQUEST_ID, HEADER.RETRY_AFTER]);

// The list of the origin check (110), so a page is let read only what it may also send. A list even of one: the Origin
// of a request is echoed only when the list has it, with "Vary: Origin" for the caches between.
async function useCors(fastify) {
  const { allowedOrigins, preflightMaxAge } = fastify.config.cors;

  await fastify.register(fastifyCors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ALLOWED_METHODS,
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: convertStringToWholeSeconds(preflightMaxAge),
    // An OPTIONS without the headers of a preflight gets the 204 of any other, not a 400 in text/plain of the plugin.
    strictPreflight: false,
  });
}

export default fp(useCors, { name: 'cors' });
