import { checkOriginAuth } from '#src/controller/auth.js';
import {
  postLogError,
  postLogErrorSchema,
} from '#src/controller/log.js';

async function useUploadRoutes(fastify) {
  fastify.post('/log/error', {
    preHandler: checkOriginAuth,
    handler: postLogError,
    schema: postLogErrorSchema,
  });
}

export default useUploadRoutes;
