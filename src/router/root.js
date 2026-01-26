import { resolvePath } from '#root/core/path.js';
import { readFileSync } from 'node:fs';

async function useUserRoutes(fastify) {
  fastify.get('/', {
    handler: (request, reply) => {
      const pathToIndexHtml = resolvePath('public/index.html');
      const bufferIndexHtml = readFileSync(pathToIndexHtml, 'utf8');

      return reply.type('text/html').send(bufferIndexHtml);
    },
    schema: {
      hide: true,
    },
  });
}

export default useUserRoutes;
