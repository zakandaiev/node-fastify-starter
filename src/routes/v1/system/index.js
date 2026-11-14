import { ping, pingSchema } from './controller.js';

export default async function useSystemRoutes(fastify) {
  fastify.get('/ping', {
    schema: pingSchema,
    security: { auth: false },
  }, ping);
}
