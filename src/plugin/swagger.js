import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';

async function useSwagger(fastify) {
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
    routePrefix: process.env.APP_API_DOCS_PREFIX,
    uiConfig: {
      docExpansion: 'none',
      deepLinking: true,
      persistAuthorization: true,
      withCredentials: true,

      // Safari compatibility
      tryItOutEnabled: true,
    },

    // Disable staticCSP for better Safari compatibility
    staticCSP: false,

    // Create a copy without host for Safari compatibility
    transformSpecification: (swaggerObject) => {
      const spec = { ...swaggerObject };
      delete spec.host;
      return spec;
    },
  });

  return fastify;
}

export default useSwagger;
