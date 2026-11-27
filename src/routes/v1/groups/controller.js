import { createSchema } from '#core/schema/create-schema.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { SCOPE_CATALOG } from '#enums/scope.js';
import {
  addMember,
  createGroup,
  listGroups,
  listMembers,
  readGroup,
  removeGroup,
  removeMember,
  updateGroup,
} from '#modules/groups/groups.service.js';
import { USER_LIST_FIELDS } from '#modules/users/users.repository.js';
import * as paginationSchema from '#schemas/common/pagination.js';
import * as groupSchema from '#schemas/entity/group.js';
import * as scopeSchema from '#schemas/entity/scope.js';
import * as userSchema from '#schemas/entity/user.js';
import { freezeDeep } from '#utils/object.js';

const TAGS = Object.freeze(['Groups']);

const GROUP_RESPONSE_FIELDS = Object.freeze(Object.keys(groupSchema.properties));
const BODY_FIELDS = Object.freeze(['slug', 'name', 'description', 'isSuperadmin', 'scopes']);
const SCOPE_FIELDS = Object.freeze(Object.keys(scopeSchema.properties));

const membership = freezeDeep({
  properties: {
    groupId: groupSchema.properties.id,
    userId: userSchema.properties.id,
  },
});

const HOLDER_RULE = 'Only one who holds every scope a group grants, full access too, may give it, take it away or change who has it; the database judges what one holds, the token does not';

export async function getGroups(request, reply) {
  return reply.list(await listGroups(request.query));
}

export const getGroupsSchema = createSchema(groupSchema, paginationSchema)
  .meta({ tags: TAGS, summary: 'List the groups' })
  .query(['name', 'sort', 'limit', 'offset'])
  .response(HTTP_STATUS.OK, { data: GROUP_RESPONSE_FIELDS, format: 'array' })
  .defaultResponses()
  .build();

export async function getScopes(request, reply) {
  return reply.list({ data: SCOPE_CATALOG.map((entry) => ({ ...entry })) });
}

export const getScopesSchema = createSchema(scopeSchema)
  .meta({ tags: TAGS, summary: 'List the scopes a group may grant' })
  .response(HTTP_STATUS.OK, { data: SCOPE_FIELDS, format: 'array' })
  .defaultResponses()
  .build();

export async function getGroup(request, reply) {
  return reply.ok(await readGroup(request.params.id));
}

export const getGroupSchema = createSchema(groupSchema)
  .meta({ tags: TAGS, summary: 'Get a group with its scopes' })
  .params(['id'])
  .response(HTTP_STATUS.OK, { data: GROUP_RESPONSE_FIELDS })
  .defaultResponses()
  .build();

export async function postGroup(request, reply) {
  return reply.created(await createGroup({ input: request.body, actorId: request.user.id, request }));
}

export const postGroupSchema = createSchema(groupSchema)
  .meta({ tags: TAGS, summary: 'Create a group', description: `${HOLDER_RULE}. The slug of a group of the system is taken` })
  .body(BODY_FIELDS, { required: ['slug', 'name'] })
  .response(HTTP_STATUS.CREATED, { data: GROUP_RESPONSE_FIELDS })
  .response(HTTP_STATUS.CONFLICT, { codes: [ERROR_CODE.GROUP_PROTECTED] })
  .defaultResponses()
  .build();

export async function patchGroup(request, reply) {
  return reply.ok(await updateGroup({
    id: request.params.id,
    input: request.body,
    actorId: request.user.id,
    request,
  }));
}

export const patchGroupSchema = createSchema(groupSchema)
  .meta({
    tags: TAGS,
    summary: 'Change a group',
    description: `${HOLDER_RULE}. "scopes" replaces the whole list. A group of the system keeps its slug and its full access`,
  })
  .params(['id'])
  .body(BODY_FIELDS, { isPatch: true })
  .response(HTTP_STATUS.OK, { data: GROUP_RESPONSE_FIELDS })
  .response(HTTP_STATUS.CONFLICT, { codes: [ERROR_CODE.GROUP_PROTECTED, ERROR_CODE.NO_CHANGES] })
  .defaultResponses()
  .build();

export async function deleteGroup(request, reply) {
  await removeGroup({ id: request.params.id, actorId: request.user.id, request });

  return reply.noContent();
}

export const deleteGroupSchema = createSchema(groupSchema)
  .meta({ tags: TAGS, summary: 'Delete a group', description: `${HOLDER_RULE}. A group of the system is never deleted` })
  .params(['id'])
  .response(HTTP_STATUS.NO_CONTENT)
  .response(HTTP_STATUS.CONFLICT, { codes: [ERROR_CODE.GROUP_PROTECTED] })
  .defaultResponses()
  .build();

export async function getMembers(request, reply) {
  return reply.list(await listMembers({ groupId: request.params.groupId, payload: request.query }));
}

export const getMembersSchema = createSchema(userSchema, paginationSchema, membership)
  .meta({ tags: TAGS, summary: 'List the members of a group' })
  .params(['groupId'])
  .query(['firstName', 'status', 'createdAt', 'sort', 'limit', 'offset'])
  .response(HTTP_STATUS.OK, { data: [...USER_LIST_FIELDS], format: 'array' })
  .defaultResponses()
  .build();

export async function putMember(request, reply) {
  await addMember({ ...request.params, actorId: request.user.id, request });

  return reply.noContent();
}

export const putMemberSchema = createSchema(membership)
  .meta({ tags: TAGS, summary: 'Add a user to a group', description: `${HOLDER_RULE}. Nobody changes their own groups; a member already is one` })
  .params(['groupId', 'userId'])
  .response(HTTP_STATUS.NO_CONTENT)
  .defaultResponses()
  .build();

export async function deleteMember(request, reply) {
  await removeMember({ ...request.params, actorId: request.user.id, request });

  return reply.noContent();
}

export const deleteMemberSchema = createSchema(membership)
  .meta({
    tags: TAGS,
    summary: 'Take a user out of a group',
    description: `${HOLDER_RULE}. Nobody changes their own groups, and a group of the system with full access keeps one member at least`,
  })
  .params(['groupId', 'userId'])
  .response(HTTP_STATUS.NO_CONTENT)
  .response(HTTP_STATUS.CONFLICT, { codes: [ERROR_CODE.GROUP_PROTECTED] })
  .defaultResponses()
  .build();
