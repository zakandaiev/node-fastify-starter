import { IMAGE_INPUT_TYPES } from '#core/image/profile.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { SCOPE } from '#enums/scope.js';
import { freezeDeep } from '#utils/object.js';
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

function readProfileFiles(uploadConfig) {
  return freezeDeep({
    fields: {
      avatar: { maxSize: uploadConfig.avatarMaxSize, mime: [...IMAGE_INPUT_TYPES], image: IMAGE_PROFILE.AVATAR },
    },
  });
}

export default async function useUserRoutes(fastify) {
  fastify.get('/me', { schema: getMeSchema, security: OWN }, getMe);
  fastify.patch('/me', { schema: patchMeSchema, security: OWN, files: readProfileFiles(fastify.config.upload) }, patchMe);
  fastify.delete('/me', { schema: deleteMeSchema, security: OWN }, deleteMe);
  fastify.get('/', { schema: getUsersSchema, security: READ }, getUsers);
  fastify.get('/:id', { schema: getUserSchema, security: READ }, getUser);
  fastify.patch('/:id', { schema: patchUserSchema, security: MANAGE }, patchUser);
  fastify.delete('/:id', { schema: deleteUserSchema, security: MANAGE }, deleteUser);
  fastify.post('/:id/block', { schema: postBlockSchema, security: MANAGE }, postBlock);
  fastify.post('/:id/unblock', { schema: postUnblockSchema, security: MANAGE }, postUnblock);
}
