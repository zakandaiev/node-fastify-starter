import { absPath } from '#core/path.js';
import fastifyStatic from '@fastify/static';
import nodePath from 'node:path';

export default async function useStaticFiles(fastify) {
  await fastify.register(fastifyStatic, {
    root: absPath.public,
    index: false,
    list: false,
    decorateReply: true,
    serveDotFiles: false,
    cacheControl: false,
    etag: true,
    lastModified: true,
    setHeaders(res, file) {
      const fileExtension = nodePath.extname(file).toLowerCase();

      const cacheControl = ['.html', '.json', '.xml', '.txt', '.md']
        .includes(fileExtension)
        ? 'no-cache'
        : 'public, max-age=2592000'; // 30 days

      res.setHeader('Cache-Control', cacheControl);
    },
  });

  await fastify.register(fastifyStatic, {
    root: absPath.upload,
    prefix: '/upload/',
    index: false,
    list: false,
    decorateReply: false,
    serveDotFiles: false,
    cacheControl: false,
    etag: true,
    lastModified: true,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // 365 days
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });
}
