import { checkJwtAuth, checkUserRole } from '#root/src/controller/v1/auth.js';
import {
  deleteUserById,
  deleteUserByIdSchema,
  getAllUsers,
  getAllUsersSchema,
  getUserById,
  getUserByIdSchema,
} from '#root/src/controller/v1/user.js';

async function useUserRoutes(fastify) {
  fastify.get('/users', {
    preHandler: [checkJwtAuth, checkUserRole('admin')],
    handler: getAllUsers,
    schema: getAllUsersSchema,
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
