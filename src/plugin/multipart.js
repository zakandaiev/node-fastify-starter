import fastifyMultipart from '@fastify/multipart';

export default async function useMultipart(fastify) {
  await fastify.register(fastifyMultipart, {
    limits: {
      fileSize: process.env.APP_UPLOAD_MAX_SIZE,
    },
  });
}
