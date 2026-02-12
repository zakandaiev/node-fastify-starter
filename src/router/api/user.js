import { checkJwtAuth, checkUserRole } from '#src/controller/auth.js';
import {
  deleteUserById,
  deleteUserByIdSchema,
  getAllUsers,
  getAllUsersSchema,
  getCurrentUser,
  getCurrentUserSchema,
  getUserById,
  getUserByIdSchema,
} from '#src/controller/user.js';

async function useUserRoutes(fastify) {
  fastify.get('/users', {
    preHandler: [checkJwtAuth, checkUserRole('admin')],
    handler: getAllUsers,
    schema: getAllUsersSchema,
  });

  fastify.get('/users/me', {
    preHandler: [checkJwtAuth],
    handler: getCurrentUser,
    schema: getCurrentUserSchema,
  });

  fastify.get('/users/:id', {
    preHandler: [checkJwtAuth, checkUserRole('admin')],
    handler: getUserById,
    schema: getUserByIdSchema,
  });

  fastify.delete('/users/:id', {
    preHandler: [checkJwtAuth, checkUserRole('admin')],
    handler: deleteUserById,
    schema: deleteUserByIdSchema,
  });
}

export default useUserRoutes;
