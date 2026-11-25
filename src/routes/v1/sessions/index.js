import {
  deleteSession,
  deleteSessions,
  deleteSessionSchema,
  deleteSessionsSchema,
  getSessions,
  getSessionsSchema,
} from './controller.js';

export default async function useSessionRoutes(fastify) {
  fastify.get('/', {
    schema: getSessionsSchema,
    security: { auth: true },
  }, getSessions);

  fastify.delete('/', {
    schema: deleteSessionsSchema,
    security: { auth: true },
  }, deleteSessions);

  fastify.delete('/:id', {
    schema: deleteSessionSchema,
    security: { auth: true },
  }, deleteSession);
}
