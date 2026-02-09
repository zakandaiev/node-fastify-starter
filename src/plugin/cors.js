import fastifyCors from '@fastify/cors';

async function useCors(fastify) {
  const frontendDomainList = process.env.APP_FRONTEND_DOMAINS
    ? process.env.APP_FRONTEND_DOMAINS.split(',')
    : false;

  await fastify.register(fastifyCors, {
    credentials: true,
    origin: frontendDomainList,
    methods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST'],
  });
}

export default useCors;
