import fastifyCors from '@fastify/cors';

async function useCors(fastify) {
  await fastify.register(fastifyCors, {
    credentials: true,
    origin: process.env.APP_MODE === 'dev'
      ? ['http://localhost:5173']
      : false,
    methods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST'],
  });
}

export default useCors;
