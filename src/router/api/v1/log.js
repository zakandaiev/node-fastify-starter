import { checkOriginAuth } from '#src/controller/v1/auth.js';
import {
  postLogError,
  postLogErrorSchema,
} from '#src/controller/v1/log.js';

export default async function useUploadRoutes(fastify) {
  fastify.post('/log/error', {
    preHandler: checkOriginAuth,
    handler: postLogError,
    schema: postLogErrorSchema,
  });
}
