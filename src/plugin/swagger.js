import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';

async function useSwagger(fastify) {
  if (process.env.APP_MODE !== 'dev') {
    return fastify;
  }

  await fastify.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: process.env.APP_NAME,
        version: process.env.APP_VERSION,
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [
        {
          bearerAuth: [],
        },
      ],
    },
  });

  await fastify.register(fastifySwaggerUI, {
    routePrefix: process.env.APP_DOCS_PREFIX,
    staticCSP: false,
    uiConfig: {
      docExpansion: 'none',
      deepLinking: true,
      persistAuthorization: true,
      tryItOutEnabled: true,
      withCredentials: true,
    },
    transformSpecification: (swaggerObject) => {
      const spec = { ...swaggerObject };
      delete spec.host;
      return spec;
    },
  });

  return fastify;
}

export default useSwagger;
