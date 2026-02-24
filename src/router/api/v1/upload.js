import { checkJwtAuth } from '#root/src/controller/v1/auth.js';
import {
  postUpload,
  postUploadSchema,
} from '#root/src/controller/v1/upload.js';

async function useUploadRoutes(fastify) {
  fastify.post('/upload', {
    preHandler: checkJwtAuth,
    handler: postUpload,
    schema: postUploadSchema,
  });
}

export default useUploadRoutes;
