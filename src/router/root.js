export default async function useRootRoutes(fastify) {
  fastify.get('/', {
    handler: (_, reply) => reply.sendFile('index.html', { maxAge: 0, immutable: false }),
    schema: {
      hide: true,
    },
  });
}
