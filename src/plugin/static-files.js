import { absPath } from '#core/path.js';
import fastifyStatic from '@fastify/static';

async function useStaticFiles(fastify) {
  await fastify.register(fastifyStatic, {
    root: absPath.public,
  });
}

export default useStaticFiles;
