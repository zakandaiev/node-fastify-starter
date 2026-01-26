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
  fastify.post('/login', {
    handler: postLogin,
    schema: postLoginSchema,
  });

  if (process.env.APP_MODE === 'dev') {
    fastify.post('/login-dev', {
      handler: postLoginDev,
      schema: postLoginDevSchema,
    });
  }

  fastify.post('/logout', {
    handler: postLogout,
    schema: postLogoutSchema,
  });

  fastify.post('/refresh', {
    handler: postRefresh,
    schema: postRefreshSchema,
  });

  fastify.post('/register', {
    handler: postRegister,
    schema: postRegisterSchema,
  });
}

export default useAuthRoutes;
