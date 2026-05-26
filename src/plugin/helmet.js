import fastifyHelmet from '@fastify/helmet';

async function useHelmet(fastify) {
  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: process.env.APP_MODE === 'dev'
      ? false
      : {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
    crossOriginEmbedderPolicy: false,
    global: true,
  });
}

export default useHelmet;
