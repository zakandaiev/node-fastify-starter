import { checkAuth, checkRole } from '#src/controller/auth.js';
import {
  deleteUserById,
  deleteUserByIdSchema,
  getAllUsers,
  getAllUsersSchema,
  getUserById,
  getUserByIdSchema,
} from '#src/controller/user.js';

async function useUserRoutes(fastify) {
  fastify.get('/user/:id', {
    preHandler: [checkAuth, checkRole('admin')],
    handler: getUserById,
    schema: getUserByIdSchema,
  });

  fastify.delete('/user/:id', {
    preHandler: [checkAuth, checkRole('admin')],
    handler: deleteUserById,
    schema: deleteUserByIdSchema,
  });

  fastify.get('/users', {
    preHandler: [checkAuth, checkRole('admin')],
    handler: getAllUsers,
    schema: getAllUsersSchema,
  });
}

export default useUserRoutes;
