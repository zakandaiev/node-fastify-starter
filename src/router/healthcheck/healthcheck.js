import { getHealthCheck, getHealthCheckSchema } from '#src/controller/healthcheck.js';

export default async function useHealthCheckRoutes(fastify) {
  fastify.get('', {
    handler: getHealthCheck,
    schema: getHealthCheckSchema,
  });
}
