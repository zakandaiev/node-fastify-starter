import { checkJwtAuth, checkUserRole } from '#src/controller/v1/auth.js';
import {
  deleteUserById,
  deleteUserByIdSchema,
  getAllUsers,
  getAllUsersSchema,
  getUserById,
  getUserByIdSchema,
  patchUserById,
  patchUserByIdSchema,
} from '#src/controller/v1/user.js';

export default async function useUserRoutes(fastify) {
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

  fastify.patch('/users/:id', {
    preHandler: [checkJwtAuth, checkUserRole('admin')],
    handler: patchUserById,
    schema: patchUserByIdSchema,
    validatorCompiler: () => () => true,
  });

  fastify.delete('/users/:id', {
    preHandler: [checkJwtAuth, checkUserRole('admin')],
    handler: deleteUserById,
    schema: deleteUserByIdSchema,
  });
}
