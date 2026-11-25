import { assertAuthConfig } from '#core/auth/settings.js';
import { listJwtSpaces } from '#core/auth/token.js';
import { createContext } from '#core/context/index.js';
import { mapSeries } from '#utils/async.js';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';

const ROTATION_MESSAGE = 'Tokens signed with a previous secret are accepted';

function logRotation(fastify) {
  const { accessSecretPrevious, refreshSecretPrevious } = fastify.config.auth;
  const rotation = { access: accessSecretPrevious !== null, refresh: refreshSecretPrevious !== null };

  if (rotation.access || rotation.refresh) {
    fastify.log.info({ rotation }, ROTATION_MESSAGE);
  }
}

async function useJwt(fastify) {
  const { auth } = fastify.config;

  assertAuthConfig(auth);

  await mapSeries(listJwtSpaces(auth), (options) => fastify.register(fastifyJwt, options));

  fastify.context = createContext({ ...fastify.context, jwt: fastify.jwt });
  logRotation(fastify);
}

export default fp(useJwt, { name: 'jwt' });
