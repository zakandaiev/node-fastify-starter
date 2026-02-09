import { checkJwtAuth, checkUserRole } from '#src/controller/auth.js';
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
    preHandler: [checkJwtAuth, checkUserRole('admin')],
    handler: getUserById,
    schema: getUserByIdSchema,
  });

  fastify.delete('/user/:id', {
    preHandler: [checkJwtAuth, checkUserRole('admin')],
    handler: deleteUserById,
    schema: deleteUserByIdSchema,
  });

  fastify.get('/users', {
    preHandler: [checkJwtAuth, checkUserRole('admin')],
    handler: getAllUsers,
    schema: getAllUsersSchema,
  });
}

export default useUserRoutes;
