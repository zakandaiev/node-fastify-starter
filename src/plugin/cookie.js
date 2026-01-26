import fastifyCookie from '@fastify/cookie';

async function useCookie(fastify) {
  await fastify.register(fastifyCookie, {
    secret: process.env.APP_COOKIE_SECRET,
  });
}

export default useCookie;
