import {
  checkJwtAuth,
  getCurrentUser,
  getCurrentUserSchema,
  postLogin,
  postLoginDev,
  postLoginDevSchema,
  postLoginSchema,
  postLogout,
  postLogoutSchema,
  postRegister,
  postRegisterSchema,
} from '#src/controller/v1/auth.js';

export default async function useAuthRoutes(fastify) {
  const rateLimit = { timeWindow: '1m', max: 10 };

  fastify.get('/auth/me', {
    preHandler: [checkJwtAuth],
    handler: getCurrentUser,
    schema: getCurrentUserSchema,
  });

  fastify.post('/auth/login', {
    config: { rateLimit },
    handler: postLogin,
    schema: postLoginSchema,
  });

  if (process.env.APP_MODE === 'dev') {
    fastify.post('/auth/login-dev', {
      config: { rateLimit },
      handler: postLoginDev,
      schema: postLoginDevSchema,
    });
  }

  fastify.post('/auth/logout', {
    config: { rateLimit },
    handler: postLogout,
    schema: postLogoutSchema,
  });

  fastify.post('/auth/register', {
    config: { rateLimit },
    handler: postRegister,
    schema: postRegisterSchema,
  });
}
