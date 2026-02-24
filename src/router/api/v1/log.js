import { checkOriginAuth } from '#root/src/controller/v1/auth.js';
import {
  postLogError,
  postLogErrorSchema,
} from '#root/src/controller/v1/log.js';

async function useUploadRoutes(fastify) {
  fastify.post('/log/error', {
    preHandler: checkOriginAuth,
    handler: postLogError,
    schema: postLogErrorSchema,
  });
}

export default useUploadRoutes;
