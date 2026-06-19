import { toNumber } from '#src/util/misc.js';
import fastifyMultipart from '@fastify/multipart';

export default async function useMultipart(fastify) {
  await fastify.register(fastifyMultipart, {
    limits: {
      fileSize: toNumber(process.env.APP_UPLOAD_MAX_SIZE) ?? 10485760, // 10MB
    },
  });
}
