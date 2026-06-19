import fastifyHelmet from '@fastify/helmet';

export default async function useHelmet(fastify) {
  await fastify.register(fastifyHelmet, {
    global: true,
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
    frameguard: { action: 'sameorigin' },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
    referrerPolicy: { policy: 'same-origin' },
  });
}
