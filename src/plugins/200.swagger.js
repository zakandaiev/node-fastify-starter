import { dropSchemaMarkers, readDocumentedSchema } from '#core/schema/docs.js';
import { COOKIE } from '#enums/cookie.js';
import { isObject } from '#utils/type.js';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';

const OPENAPI_VERSION = '3.1.0';

const INDEX_PATH = '/';
const BOTH_SLASHES = 'both';

// The same access token rides in either: the cookie in a browser, the header for curl, tests and the Authorize
// button. Which operation takes them is the guard's to write.
const SECURITY_SCHEMES = Object.freeze({
  cookieAuth: { type: 'apiKey', in: 'cookie', name: COOKIE.ACCESS_TOKEN },
  bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
});

// The "/" of a plugin with a prefix is served with the slash and without it, and the docs are given the former.
function readDocumentedUrl(url, { prefix, routePath, prefixTrailingSlash = BOTH_SLASHES }) {
  return prefix && routePath === INDEX_PATH && prefixTrailingSlash === BOTH_SLASHES
    ? prefix
    : url;
}

function documentRoute({ schema, url, route }) {
  return {
    schema: schema && readDocumentedSchema(schema),
    url: readDocumentedUrl(url, route),
  };
}

// A shared schema (fastify.addSchema) that a route reaches by $ref goes to the components as it was added.
function documentComponents({ openapiObject }) {
  const { components } = openapiObject;

  if (!isObject(components?.schemas)) {
    return openapiObject;
  }

  return {
    ...openapiObject,
    components: {
      ...components,
      schemas: Object.fromEntries(Object.entries(components.schemas).map(([name, schema]) => [name, dropSchemaMarkers(schema)])),
    },
  };
}

// Dev mode only: in prod the plugin registers nothing, and /docs is the 404 of any unknown path.
async function useSwagger(fastify) {
  const {
    isDev,
    nameFormatted,
    version,
    description,
    docsPrefix,
  } = fastify.config.app;

  if (!isDev) {
    fastify.log.info('API docs are off: they are served in dev mode only');

    return false;
  }

  await fastify.register(fastifySwagger, {
    openapi: {
      openapi: OPENAPI_VERSION,
      info: { title: nameFormatted, version, description },
      components: { securitySchemes: SECURITY_SCHEMES },
    },
    transform: documentRoute,
    transformObject: documentComponents,
  });

  await fastify.register(fastifySwaggerUi, {
    routePrefix: docsPrefix,
    uiConfig: {
      docExpansion: 'none',
      deepLinking: true,
      persistAuthorization: true,
    },
  });

  fastify.log.info({ docs: { prefix: docsPrefix } }, 'API docs are served');

  return true;
}

export default fp(useSwagger, { name: 'swagger' });
