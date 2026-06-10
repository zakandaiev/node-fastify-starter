import { reply } from '#src/service/response.js';

export default async function useDummyRoutes(fastify) {
  fastify.get('/dummy', {
    handler: (request, fastifyReply) => reply(fastifyReply, 'Dummy handler for api v2'),
    schema: {
      tags: ['v2'],
      summary: 'Dummy summary for api v2',
      description: 'Dummy description for api v2',
    },
  });
}
