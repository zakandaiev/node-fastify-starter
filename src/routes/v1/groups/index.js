import { SCOPE } from '#enums/scope.js';
import {
  deleteGroup,
  deleteGroupSchema,
  deleteMember,
  deleteMemberSchema,
  getGroup,
  getGroups,
  getGroupSchema,
  getGroupsSchema,
  getMembers,
  getMembersSchema,
  getScopes,
  getScopesSchema,
  patchGroup,
  patchGroupSchema,
  postGroup,
  postGroupSchema,
  putMember,
  putMemberSchema,
} from './controller.js';

const READ = Object.freeze({ auth: true, scopes: [SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE] });
const MANAGE = Object.freeze({ auth: true, scopes: [SCOPE.GROUPS_MANAGE] });

// The members are users, and their list shows what users:read guards.
const READ_MEMBERS = Object.freeze({
  auth: true,
  scopes: [[SCOPE.GROUPS_READ, SCOPE.USERS_READ], [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]],
});

export default async function useGroupRoutes(fastify) {
  fastify.get('/', { schema: getGroupsSchema, security: READ }, getGroups);
  fastify.get('/scopes', { schema: getScopesSchema, security: READ }, getScopes);
  fastify.get('/:id', { schema: getGroupSchema, security: READ }, getGroup);
  fastify.post('/', { schema: postGroupSchema, security: MANAGE }, postGroup);
  fastify.patch('/:id', { schema: patchGroupSchema, security: MANAGE }, patchGroup);
  fastify.delete('/:id', { schema: deleteGroupSchema, security: MANAGE }, deleteGroup);
  fastify.get('/:groupId/members', { schema: getMembersSchema, security: READ_MEMBERS }, getMembers);
  fastify.put('/:groupId/members/:userId', { schema: putMemberSchema, security: MANAGE }, putMember);
  fastify.delete('/:groupId/members/:userId', { schema: deleteMemberSchema, security: MANAGE }, deleteMember);
}
