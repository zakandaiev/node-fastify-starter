import fastifyCors from '@fastify/cors';

async function useCors(fastify) {
  const frontendDomainList = process.env.APP_CORS_ALLOWED_DOMAINS
    ? process.env.APP_CORS_ALLOWED_DOMAINS.split(',')
    : false;

  await fastify.register(fastifyCors, {
    credentials: true,
    origin: frontendDomainList,
    methods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST'],
  });
}

export default useCors;
