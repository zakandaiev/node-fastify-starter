import { createContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import Fastify from 'fastify';

// A literal on purpose: a numeric trustProxy (hop count) trusts nobody in Fastify 5,
// and request.ip becomes the address of the proxy.
const TRUST_PROXY = 'loopback,uniquelocal';

export async function buildApp({ config } = {}) {
  if (!config) {
    throw new TypeError('buildApp({ config }) requires the result of createConfig()');
  }

  const fastify = Fastify({
    loggerInstance: createLogger(config.logger),
    trustProxy: TRUST_PROXY,
    bodyLimit: config.app.bodyLimit,
  });

  fastify.decorate('config', config);
  fastify.decorate('context', createContext({ config, log: fastify.log }));

  return fastify;
}
