import { checkSource, postError, postErrorSchema } from './controller.js';

export default async function useLogRoutes(fastify) {
  fastify.post('/error', {
    schema: postErrorSchema,
    security: { auth: false },
    bodyLimit: fastify.config.alert.intake.bodyLimit,
    onRequest: checkSource,
  }, postError);
}
