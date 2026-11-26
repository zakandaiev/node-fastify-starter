import { readScopeTerms } from '#core/authz/match.js';
import { addErrorResponses } from '#core/schema/create-schema.js';
import { dropSchemaMarkers, readDocumentedSchema } from '#core/schema/docs.js';
import { COOKIE } from '#enums/cookie.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { isObject } from '#utils/type.js';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';

const OPENAPI_VERSION = '3.1.0';

const INDEX_PATH = '/';
const BOTH_SLASHES = 'both';

// The same access token rides in either: the cookie in a browser, the header for curl, tests and the Authorize
// button. Which operation takes them the security of its route tells.
const SECURITY_SCHEMES = Object.freeze({
  cookieAuth: { type: 'apiKey', in: 'cookie', name: COOKIE.ACCESS_TOKEN },
  bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
});

const SECURITY_SCHEME_NAMES = Object.freeze(Object.keys(SECURITY_SCHEMES));

// What @fastify/swagger documents for a route without a response schema: a map of refusals alone would replace it.
const DEFAULT_RESPONSE = Object.freeze({ [HTTP_STATUS.OK]: { type: 'null', description: 'Default Response' } });

// The "/" of a plugin with a prefix is served with the slash and without it, and the docs are given the former.
function readDocumentedUrl(url, { prefix, routePath, prefixTrailingSlash = BOTH_SLASHES }) {
  return prefix && routePath === INDEX_PATH && prefixTrailingSlash === BOTH_SLASHES
    ? prefix
    : url;
}

// OpenAPI 3.1 lets a requirement of an apiKey or an http scheme name roles: each term of the scopes is one, for
// either way the token rides in.
function toSecurityRequirements(scopes) {
  const terms = scopes === undefined
    ? [[]]
    : readScopeTerms(scopes);

  return terms.flatMap((term) => SECURITY_SCHEME_NAMES.map((name) => ({ [name]: term })));
}

function documentSecurity(schema, security) {
  if (security?.auth !== true) {
    return schema;
  }

  const refusals = security.scopes === undefined
    ? [HTTP_STATUS.UNAUTHORIZED]
    : [HTTP_STATUS.UNAUTHORIZED, HTTP_STATUS.FORBIDDEN];

  return {
    ...schema,
    security: toSecurityRequirements(security.scopes),
    response: addErrorResponses(schema?.response ?? DEFAULT_RESPONSE, refusals),
  };
}

function documentRoute({ schema, url, route }) {
  return {
    schema: documentSecurity(schema && readDocumentedSchema(schema), route.security),
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
