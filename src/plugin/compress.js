import fastifyCompress from '@fastify/compress';

export default async function useCompress(fastify) {
  await fastify.register(fastifyCompress, {
    global: true,
    encodings: ['br', 'gzip', 'deflate'],
    threshold: 1024,
  });
}
