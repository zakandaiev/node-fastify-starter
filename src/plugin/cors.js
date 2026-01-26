import fastifyCors from '@fastify/cors';

async function useCors(fastify) {
  await fastify.register(fastifyCors, {
    origin: false,
  });
}

export default useCors;
