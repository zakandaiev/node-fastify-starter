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
} from '#root/src/controller/v1/auth.js';

async function useAuthRoutes(fastify) {
  fastify.get('/auth/me', {
    preHandler: [checkJwtAuth],
    handler: getCurrentUser,
    schema: getCurrentUserSchema,
  });

  fastify.post('/auth/login', {
    handler: postLogin,
    schema: postLoginSchema,
  });

  if (process.env.APP_MODE === 'dev') {
    fastify.post('/auth/login-dev', {
      handler: postLoginDev,
      schema: postLoginDevSchema,
    });
  }

  fastify.post('/auth/logout', {
    handler: postLogout,
    schema: postLogoutSchema,
  });

  fastify.post('/auth/register', {
    handler: postRegister,
    schema: postRegisterSchema,
  });
}

export default useAuthRoutes;
