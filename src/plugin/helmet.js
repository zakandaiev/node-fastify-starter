import fastifyHelmet from '@fastify/helmet';

async function useHelmet(fastify) {
  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    global: true,
  });
}

export default useHelmet;
