import { resolvePath } from '#core/path.js';
import { readFileSync } from 'node:fs';

const INDEX_HTML = readFileSync(resolvePath('public', 'index.html'), 'utf8');

export default async function useRootRoutes(fastify) {
  fastify.get('/', {
    handler: (request, reply) => reply.type('text/html').send(INDEX_HTML),
    schema: {
      hide: true,
    },
  });
}
