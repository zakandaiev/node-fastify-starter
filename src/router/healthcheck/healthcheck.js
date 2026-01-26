import { getHealthCheck, getHealthCheckSchema } from '#src/controller/healthcheck.js';

async function useUserRoutes(fastify) {
  fastify.get('', {
    handler: getHealthCheck,
    schema: getHealthCheckSchema,
  });
}

export default useUserRoutes;
