import fastifyUnderPressure from '@fastify/under-pressure';

export default async function useUnderPressure(fastify) {
  await fastify.register(fastifyUnderPressure);
}
