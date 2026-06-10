import fastifyCookie from '@fastify/cookie';

export default async function useCookie(fastify) {
  await fastify.register(fastifyCookie, {
    secret: process.env.APP_COOKIE_SECRET,
  });
}
