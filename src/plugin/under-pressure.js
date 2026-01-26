import fastifyUnderPressure from '@fastify/under-pressure';

async function useUnderPressure(fastify) {
  await fastify.register(fastifyUnderPressure);
}

export default useUnderPressure;
