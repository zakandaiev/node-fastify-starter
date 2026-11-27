import { endAuthCookies } from '#core/auth/cookie.js';
import { createSchema } from '#core/schema/create-schema.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { USER_FIELDS, USER_LIST_FIELDS } from '#modules/users/users.repository.js';
import {
  blockUser,
  listUsers,
  readOwnProfile,
  readUser,
  removeOwnAccount,
  removeUser,
  unblockUser,
  updateOwnProfile,
  updateUser,
} from '#modules/users/users.service.js';
import * as paginationSchema from '#schemas/common/pagination.js';
import * as userSchema from '#schemas/entity/user.js';

const TAGS = Object.freeze(['Users']);

const MANAGED_BODY_FIELDS = Object.freeze(['email', 'firstName', 'lastName']);
const PROFILE_BODY_FIELDS = Object.freeze(['firstName', 'lastName']);

const MANAGER_RULE = 'Only one who holds users:manage and every scope the user holds, full access too, may change, block, unblock or delete them; one whose email is on the admin list of the server, or whose confirmed sign-in identity holds such an address while the user has none, counts as holding full access. The database judges what one holds, the token does not. Nobody does it to themselves here: one\'s own account has the routes of /me';
const ADMIN_GROUP_RULE = 'The last active member of a group of the system with full access stays: 409 GROUP_PROTECTED';

export async function getUsers(request, reply) {
  return reply.list(await listUsers(request.query));
}

export const getUsersSchema = createSchema(userSchema, paginationSchema)
  .meta({ tags: TAGS, summary: 'List the users' })
  .query(['firstName', 'status', 'createdAt', 'sort', 'limit', 'offset'])
  .response(HTTP_STATUS.OK, { data: [...USER_LIST_FIELDS], format: 'array' })
  .defaultResponses()
  .build();

export async function getUser(request, reply) {
  return reply.ok(await readUser(request.params.id));
}

export const getUserSchema = createSchema(userSchema)
  .meta({ tags: TAGS, summary: 'Get a user' })
  .params(['id'])
  .response(HTTP_STATUS.OK, { data: [...USER_FIELDS] })
  .defaultResponses()
  .build();

export async function patchUser(request, reply) {
  return reply.ok(await updateUser({
    id: request.params.id,
    input: request.body,
    actorId: request.user.id,
    request,
  }));
}

export const patchUserSchema = createSchema(userSchema)
  .meta({
    tags: TAGS,
    summary: 'Change a user',
    description: `${MANAGER_RULE}. The user is judged as they are and as the change leaves them: an email of the admin list, or null over a confirmed identity that holds one, needs full access too. A new email counts as confirmed by the manager who sets it: a sign-in through a provider that confirms the same address signs into this user, except an address of the admin list, which only a provider confirms. One another user holds answers 422 on email`,
  })
  .params(['id'])
  .body([...MANAGED_BODY_FIELDS], { isPatch: true })
  .response(HTTP_STATUS.OK, { data: [...USER_FIELDS] })
  .response(HTTP_STATUS.CONFLICT, { codes: [ERROR_CODE.NO_CHANGES] })
  .defaultResponses()
  .build();

export async function deleteUser(request, reply) {
  await removeUser({ id: request.params.id, actorId: request.user.id, request });

  return reply.noContent();
}

export const deleteUserSchema = createSchema(userSchema)
  .meta({
    tags: TAGS,
    summary: 'Delete a user',
    description: `${MANAGER_RULE}. ${ADMIN_GROUP_RULE}. The user goes with their sign-in identities, memberships and sessions. A deletion is no ban: the person may sign in again as a new user, a block keeps them out`,
  })
  .params(['id'])
  .response(HTTP_STATUS.NO_CONTENT)
  .response(HTTP_STATUS.CONFLICT, { codes: [ERROR_CODE.GROUP_PROTECTED] })
  .defaultResponses()
  .build();

export async function postBlock(request, reply) {
  return reply.ok(await blockUser({ id: request.params.id, actorId: request.user.id, request }));
}

export const postBlockSchema = createSchema(userSchema)
  .meta({
    tags: TAGS,
    summary: 'Block a user',
    description: `${MANAGER_RULE}. ${ADMIN_GROUP_RULE}. Every session of the user ends at once, and a blocked user cannot sign in; one who is blocked already is answered as they are`,
  })
  .params(['id'])
  .response(HTTP_STATUS.OK, { data: [...USER_FIELDS] })
  .response(HTTP_STATUS.CONFLICT, { codes: [ERROR_CODE.GROUP_PROTECTED] })
  .defaultResponses()
  .build();

export async function postUnblock(request, reply) {
  return reply.ok(await unblockUser({ id: request.params.id, actorId: request.user.id, request }));
}

export const postUnblockSchema = createSchema(userSchema)
  .meta({
    tags: TAGS,
    summary: 'Unblock a user',
    description: `${MANAGER_RULE}. One who is active is answered as they are`,
  })
  .params(['id'])
  .response(HTTP_STATUS.OK, { data: [...USER_FIELDS] })
  .defaultResponses()
  .build();

export async function getMe(request, reply) {
  return reply.ok(await readOwnProfile(request.user.id));
}

export const getMeSchema = createSchema(userSchema)
  .meta({
    tags: TAGS,
    summary: 'Get one\'s own profile',
    description: 'The id and the scopes of the session are GET /api/v1/auth/me',
  })
  .response(HTTP_STATUS.OK, { data: [...USER_FIELDS] })
  .defaultResponses()
  .build();

export async function patchMe(request, reply) {
  return reply.ok(await updateOwnProfile({ userId: request.user.id, input: request.body }));
}

export const patchMeSchema = createSchema(userSchema)
  .meta({
    tags: TAGS,
    summary: 'Change one\'s own profile',
    description: 'The names. The email is not changed here: an address nobody has confirmed would keep its owner out',
  })
  .body([...PROFILE_BODY_FIELDS], { isPatch: true })
  .response(HTTP_STATUS.OK, { data: [...USER_FIELDS] })
  .response(HTTP_STATUS.CONFLICT, { codes: [ERROR_CODE.NO_CHANGES] })
  .defaultResponses()
  .build();

// The cookies after the commit, as the last step: a deletion that failed leaves the session as it was.
export async function deleteMe(request, reply) {
  await removeOwnAccount({ userId: request.user.id, request });
  endAuthCookies(request, reply);

  return reply.noContent();
}

export const deleteMeSchema = createSchema(userSchema)
  .meta({
    tags: TAGS,
    summary: 'Delete one\'s own account',
    description: `${ADMIN_GROUP_RULE}. One transaction ends every session, deletes the user with their sign-in identities and memberships, and records the deletion; then the cookies of the session are cleared, unless the request came with a Bearer token`,
  })
  .response(HTTP_STATUS.NO_CONTENT)
  .response(HTTP_STATUS.CONFLICT, { codes: [ERROR_CODE.GROUP_PROTECTED] })
  .defaultResponses()
  .build();
