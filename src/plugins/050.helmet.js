import { freezeDeep } from '#utils/object.js';
import fastifyHelmet from '@fastify/helmet';
import fp from 'fastify-plugin';

const NONE = "'none'";

// The API answers with JSON and redirects: a document of its origin has nothing to load, to frame or to submit.
const API_CONTENT_SECURITY_POLICY = freezeDeep({
  useDefaults: false,
  directives: {
    defaultSrc: [NONE],
    baseUri: [NONE],
    formAction: [NONE],
    frameAncestors: [NONE],
  },
});

const DENY_FRAMES = freezeDeep({ action: 'deny' });

// The other headers keep the defaults of helmet. Swagger UI of dev mode runs scripts and styles of its own.
async function useHelmet(fastify) {
  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: fastify.config.app.isDev
      ? false
      : API_CONTENT_SECURITY_POLICY,
    // Under its own name only: helmet refuses a header given twice ("frameguard" is the old name of this one) when it
    // builds the headers, which is on every request, so every answer would be a 500.
    xFrameOptions: DENY_FRAMES,
  });
}

export default fp(useHelmet, { name: 'helmet' });
