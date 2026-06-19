import { ALLOWED_DOMAINS, ALLOWED_METHODS } from '#src/service/auth.js';
import fastifyCors from '@fastify/cors';

export default async function useCors(fastify) {
  await fastify.register(fastifyCors, {
    credentials: true,
    origin: ALLOWED_DOMAINS.length ? ALLOWED_DOMAINS : false,
    methods: ALLOWED_METHODS,
  });
}
