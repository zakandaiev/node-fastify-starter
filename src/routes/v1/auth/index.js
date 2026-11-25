import {
  getMe,
  getMeSchema,
  postLogout,
  postLogoutSchema,
  postRefresh,
  postRefreshSchema,
} from './controller.js';

export default async function useAuthRoutes(fastify) {
  fastify.get('/me', {
    schema: getMeSchema,
    security: { auth: true },
  }, getMe);

  fastify.post('/refresh', {
    schema: postRefreshSchema,
    security: { auth: false },
  }, postRefresh);

  fastify.post('/logout', {
    schema: postLogoutSchema,
    security: { auth: true },
  }, postLogout);
}
