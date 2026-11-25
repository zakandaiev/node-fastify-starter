import fastifyCookie from '@fastify/cookie';
import fp from 'fastify-plugin';

// No secret: a token in a cookie is signed itself, and a marker is a hint that proves nothing. No hook: it would read
// every cookie of every request before anything can refuse it, and readCookie() of #utils/header.js reads one. Without it
// a cookie set in an onSend hook, on a reply that has none yet, is not written.
async function useCookie(fastify) {
  await fastify.register(fastifyCookie, { hook: false });
}

export default fp(useCookie, { name: 'cookie' });
