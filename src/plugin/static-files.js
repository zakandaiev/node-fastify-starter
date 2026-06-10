import { absPath } from '#core/path.js';
import fastifyStatic from '@fastify/static';

export default async function useStaticFiles(fastify) {
  await fastify.register(fastifyStatic, {
    root: absPath.public,
    index: false,
    list: false,
    decorateReply: false,
    serveDotFiles: false,
  });

  await fastify.register(fastifyStatic, {
    root: absPath.upload,
    prefix: '/upload/',
    index: false,
    list: false,
    decorateReply: false,
    serveDotFiles: false,
    setHeaders(res) {
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });
}
