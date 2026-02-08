import { getHealthCheck, getHealthCheckSchema } from '#src/controller/healthcheck.js';

async function useHealthCheckRoutes(fastify) {
  fastify.get('', {
    handler: getHealthCheck,
    schema: getHealthCheckSchema,
  });
}

export default useHealthCheckRoutes;
