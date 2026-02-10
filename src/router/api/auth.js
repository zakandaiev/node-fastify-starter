import {
  postLogin,
  postLoginDev,
  postLoginDevSchema,
  postLoginSchema,
  postLogout,
  postLogoutSchema,
  postRefresh,
  postRefreshSchema,
  postRegister,
  postRegisterSchema,
} from '#src/controller/auth.js';

async function useAuthRoutes(fastify) {
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

  fastify.post('/auth/refresh', {
    handler: postRefresh,
    schema: postRefreshSchema,
  });

  fastify.post('/auth/register', {
    handler: postRegister,
    schema: postRegisterSchema,
  });
}

export default useAuthRoutes;
