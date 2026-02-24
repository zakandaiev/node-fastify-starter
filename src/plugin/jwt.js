import fastifyJwt from '@fastify/jwt';

async function useJwt(fastify) {
  await fastify.register(fastifyJwt, {
    cookie: {
      cookieName: 'accessToken',
    },
    secret: process.env.APP_JWT_ACCESS_SECRET,
  });

  await fastify.register(fastifyJwt, {
    namespace: 'refresh',
    cookie: {
      cookieName: 'refreshToken',
    },
    secret: process.env.APP_JWT_REFRESH_SECRET,
  });
}

export default useJwt;
