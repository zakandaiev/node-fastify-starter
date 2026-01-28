import { checkAuth } from '#src/controller/auth.js';
import {
  postUpload,
  postUploadSchema,
} from '#src/controller/upload.js';

async function useUploadRoutes(fastify) {
  fastify.post('', {
    preHandler: checkAuth,
    handler: postUpload,
    schema: postUploadSchema,
  });
}

export default useUploadRoutes;
