import { checkJwtAuth } from '#src/controller/auth.js';
import {
  postUpload,
  postUploadSchema,
} from '#src/controller/upload.js';

async function useUploadRoutes(fastify) {
  fastify.post('/upload', {
    preHandler: checkJwtAuth,
    handler: postUpload,
    schema: postUploadSchema,
  });
}

export default useUploadRoutes;
