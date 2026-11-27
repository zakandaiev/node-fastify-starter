import { SCOPE } from '#enums/scope.js';
import {
  deleteMe,
  deleteMeSchema,
  deleteUser,
  deleteUserSchema,
  getMe,
  getMeSchema,
  getUser,
  getUserSchema,
  getUsers,
  getUsersSchema,
  patchMe,
  patchMeSchema,
  patchUser,
  patchUserSchema,
  postBlock,
  postBlockSchema,
  postUnblock,
  postUnblockSchema,
} from './controller.js';

const OWN = Object.freeze({ auth: true });
const READ = Object.freeze({ auth: true, scopes: [SCOPE.USERS_READ, SCOPE.USERS_MANAGE] });
const MANAGE = Object.freeze({ auth: true, scopes: [SCOPE.USERS_MANAGE] });

export default async function useUserRoutes(fastify) {
  fastify.get('/me', { schema: getMeSchema, security: OWN }, getMe);
  fastify.patch('/me', { schema: patchMeSchema, security: OWN }, patchMe);
  fastify.delete('/me', { schema: deleteMeSchema, security: OWN }, deleteMe);
  fastify.get('/', { schema: getUsersSchema, security: READ }, getUsers);
  fastify.get('/:id', { schema: getUserSchema, security: READ }, getUser);
  fastify.patch('/:id', { schema: patchUserSchema, security: MANAGE }, patchUser);
  fastify.delete('/:id', { schema: deleteUserSchema, security: MANAGE }, deleteUser);
  fastify.post('/:id/block', { schema: postBlockSchema, security: MANAGE }, postBlock);
  fastify.post('/:id/unblock', { schema: postUnblockSchema, security: MANAGE }, postUnblock);
}
