import fastifyJwt from '@fastify/jwt';

async function useJwt(fastify) {
  await fastify.register(fastifyJwt, {
    secret: process.env.APP_JWT_ACCESS_SECRET,
  });

  await fastify.register(fastifyJwt, {
    secret: process.env.APP_JWT_REFRESH_SECRET,
    namespace: 'refresh',
    cookie: {
      cookieName: 'refreshToken',
    },
  });
}

export default useJwt;
