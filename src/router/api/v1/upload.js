import { checkJwtAuth } from '#src/controller/v1/auth.js';
import {
  postUpload,
  postUploadSchema,
} from '#src/controller/v1/upload.js';

export default async function useUploadRoutes(fastify) {
  fastify.post('/upload', {
    preHandler: checkJwtAuth,
    handler: postUpload,
    schema: postUploadSchema,
    validatorCompiler: () => () => true,
  });
}
