import fastifyCors from '@fastify/cors';

async function useCors(fastify) {
  await fastify.register(fastifyCors, {
    origin: process.env.APP_MODE === 'dev'
      ? ['http://localhost:5173']
      : false,
    credentials: true,
  });
}

export default useCors;
