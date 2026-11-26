import { writeAudit } from '#core/audit/index.js';
import { SESSION_TRANSACTION } from '#core/auth/session.js';
import { grantMembership, revokeMembership } from '#core/authz/membership.js';
import {
  isEveryScopeGranted,
  isGrantableScope,
  isRequirementMet,
  readGroupGrants,
} from '#core/authz/match.js';
import { readUserScopes } from '#core/authz/scope.js';
import { buildPatch } from '#core/db/patch.js';
import { withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { GROUP_SLUG } from '#enums/group.js';
import { SCOPE } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import {
  addGroupScopes,
  countActiveMembers,
  deleteGroup,
  findGroup,
  findGroups,
  findMembers,
  hasGroup,
  insertGroup,
  isMember,
  lockGroup,
  lockUsers,
  readMemberIds,
  removeGroupScopes,
  touchGroup,
  updateGroupFields,
} from '#modules/groups/groups.repository.js';
import { assertUuid, uuidv7 } from '#utils/id.js';
import { diff, pick } from '#utils/object.js';
import { isArray, isObject } from '#utils/type.js';

const FIELDS = Object.freeze(['slug', 'name', 'description', 'isSuperadmin']);
const PATCH_FIELDS = Object.freeze([...FIELDS, 'scopes']);

const MANAGE_REQUIREMENT = Object.freeze([SCOPE.GROUPS_MANAGE]);

// The seed makes a group of the system out of whatever row holds its slug, and the code finds it by that slug.
const RESERVED_SLUGS = Object.freeze(Object.values(GROUP_SLUG));

function assertScopes(scopes, signature) {
  if (!isArray(scopes) || !scopes.every((scope) => isGrantableScope(scope)) || new Set(scopes).size !== scopes.length) {
    throw new TypeError(`${signature} requires scopes to be distinct codes of the scope catalog in src/enums/scope.js`);
  }
}

function notFound() {
  return new AppError(ERROR_CODE.NOT_FOUND_ERROR);
}

// By the database, not by the token: a demoted or blocked manager would act for the life of the token. Holding all a
// group grants, before and after the change, keeps managing groups from being full access.
async function assertHeldBy(actor, groups) {
  const scopes = actor?.status === USER_STATUS.ACTIVE
    ? await readUserScopes(actor.id)
    : [];
  const isAllowed = isRequirementMet(scopes, MANAGE_REQUIREMENT)
    && groups.every((group) => isEveryScopeGranted(scopes, readGroupGrants(group)));

  if (!isAllowed) {
    throw new AppError(ERROR_CODE.AUTHORIZATION_ERROR);
  }

  return true;
}

function assertUnreserved(before, after) {
  if (after.slug !== before?.slug && RESERVED_SLUGS.includes(after.slug)) {
    throw new AppError(ERROR_CODE.GROUP_PROTECTED);
  }
}

// The admin group is the way back in: it keeps its slug and its full access.
function assertUnprotected(before, after) {
  const isKept = after !== null
    && after.slug === before.slug
    && (!before.isSuperadmin || after.isSuperadmin);

  if (before.isSystem && !isKept) {
    throw new AppError(ERROR_CODE.GROUP_PROTECTED);
  }

  if (after !== null) {
    assertUnreserved(before, after);
  }
}

function assertOtherUser(actorId, userId) {
  if (actorId === userId) {
    throw new AppError(ERROR_CODE.AUTHORIZATION_ERROR);
  }
}

function toAudited(group) {
  return { ...pick(group, FIELDS), scopes: group.scopes.toSorted() };
}

// Each flow locks the row of its actor first, as every flow that touches what refers to a user does: the audit row and
// granted_by refer to the actor.
async function lockActor(actorId) {
  const [actor = null] = await lockUsers([actorId]);

  return actor;
}

async function lockExistingGroup(id) {
  const group = await lockGroup(id);

  if (group === null) {
    throw notFound();
  }

  return group;
}

export function listGroups(payload) {
  return findGroups(payload);
}

export async function readGroup(id) {
  assertUuid(id, 'readGroup(id)', 'a group');

  const group = await findGroup(id);

  if (group === null) {
    throw notFound();
  }

  return group;
}

function readNewGroup(input, signature) {
  if (!isObject(input)) {
    throw new TypeError(`${signature} requires the fields of the group`);
  }

  const group = {
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    isSuperadmin: input.isSuperadmin ?? false,
    scopes: input.scopes ?? [],
  };

  assertScopes(group.scopes, signature);
  assertUnreserved(null, group);

  return group;
}

export async function createGroup({ input, actorId, request } = {}) {
  const signature = 'createGroup({ input, actorId, request })';

  assertUuid(actorId, signature, 'the actor');

  const group = readNewGroup(input, signature);

  return withTransaction(async () => {
    await assertHeldBy(await lockActor(actorId), [group]);

    const created = await insertGroup({ id: uuidv7(), ...pick(group, FIELDS) });

    await addGroupScopes(created.id, group.scopes);
    await writeAudit({
      action: AUDIT_ACTION.GROUP_CREATE,
      entityType: TABLE.GROUPS,
      entityId: created.id,
      actorId,
      meta: toAudited(group),
      request,
    });

    return { ...created, scopes: group.scopes.toSorted() };
  }, SESSION_TRANSACTION);
}

async function writeChanges(before, after, changes) {
  const fields = pick(after, FIELDS.filter((field) => Object.hasOwn(changes, field)));
  const updated = Object.keys(fields).length
    ? await updateGroupFields(before.id, fields)
    : null;

  if (!Object.hasOwn(changes, 'scopes')) {
    return { ...updated, scopes: before.scopes };
  }

  await removeGroupScopes(before.id, before.scopes.filter((scope) => !after.scopes.includes(scope)));
  await addGroupScopes(before.id, after.scopes.filter((scope) => !before.scopes.includes(scope)));

  if (updated !== null) {
    return { ...updated, scopes: after.scopes };
  }

  await touchGroup(before.id);

  return findGroup(before.id);
}

async function changeGroup(id, patch, { actorId, request }) {
  const actor = await lockActor(actorId);
  const before = await lockExistingGroup(id);
  const after = { ...before, ...patch, scopes: (patch.scopes ?? before.scopes).toSorted() };

  assertUnprotected(before, after);
  await assertHeldBy(actor, [before, after]);

  const changes = diff(toAudited(before), toAudited(after));

  if (!Object.keys(changes).length) {
    return before;
  }

  const changed = await writeChanges(before, after, changes);

  await writeAudit({
    action: AUDIT_ACTION.GROUP_UPDATE,
    entityType: TABLE.GROUPS,
    entityId: id,
    actorId,
    meta: { changes },
    request,
  });

  return changed;
}

export async function updateGroup({
  id,
  input,
  actorId,
  request,
} = {}) {
  const signature = 'updateGroup({ id, input, actorId, request })';

  assertUuid(id, signature, 'a group');
  assertUuid(actorId, signature, 'the actor');

  const patch = buildPatch(input, { allowed: PATCH_FIELDS });

  if (patch.scopes !== undefined) {
    assertScopes(patch.scopes, signature);
  }

  return withTransaction(() => changeGroup(id, patch, { actorId, request }), SESSION_TRANSACTION);
}

// Its members lose it through the foreign key: the record of the deletion names them.
export async function removeGroup({ id, actorId, request } = {}) {
  const signature = 'removeGroup({ id, actorId, request })';

  assertUuid(id, signature, 'a group');
  assertUuid(actorId, signature, 'the actor');

  return withTransaction(async () => {
    const actor = await lockActor(actorId);
    const group = await lockExistingGroup(id);

    assertUnprotected(group, null);
    await assertHeldBy(actor, [group]);

    const memberIds = await readMemberIds(id);

    await deleteGroup(id);
    await writeAudit({
      action: AUDIT_ACTION.GROUP_DELETE,
      entityType: TABLE.GROUPS,
      entityId: id,
      actorId,
      meta: { ...toAudited(group), memberIds },
      request,
    });

    return true;
  }, SESSION_TRANSACTION);
}

export async function listMembers({ groupId, payload } = {}) {
  assertUuid(groupId, 'listMembers({ groupId, payload })', 'a group');

  if (!(await hasGroup(groupId))) {
    throw notFound();
  }

  return findMembers(groupId, payload);
}

async function lockMembership({ groupId, userId, actorId }) {
  const users = await lockUsers([actorId, userId]);

  if (!users.some((user) => user.id === userId)) {
    throw notFound();
  }

  return {
    actor: users.find((user) => user.id === actorId) ?? null,
    member: users.find((user) => user.id === userId),
    group: await lockExistingGroup(groupId),
  };
}

function assertMembershipCall({ groupId, userId, actorId }, signature) {
  assertUuid(groupId, signature, 'a group');
  assertUuid(userId, signature, 'a user');
  assertUuid(actorId, signature, 'the actor');
  assertOtherUser(actorId, userId);
}

export async function addMember({
  groupId,
  userId,
  actorId,
  request,
} = {}) {
  assertMembershipCall({ groupId, userId, actorId }, 'addMember({ groupId, userId, actorId, request })');

  return withTransaction(async () => {
    const { actor, group } = await lockMembership({ groupId, userId, actorId });

    await assertHeldBy(actor, [group]);

    if (await isMember({ userId, groupId })) {
      return false;
    }

    return grantMembership({
      userId,
      group,
      actorId,
      request,
    });
  }, SESSION_TRANSACTION);
}

// A group of the system with full access keeps an active member: it is the way back in once the other groups with
// full access are gone, which a holder of full access from one of them could do after emptying it.
async function assertNotLastAdmin(group, member) {
  const isLast = group.isSystem
    && group.isSuperadmin
    && member.status === USER_STATUS.ACTIVE
    && (await countActiveMembers(group.id)) <= 1;

  if (isLast) {
    throw new AppError(ERROR_CODE.GROUP_PROTECTED);
  }

  return true;
}

export async function removeMember({
  groupId,
  userId,
  actorId,
  request,
} = {}) {
  assertMembershipCall({ groupId, userId, actorId }, 'removeMember({ groupId, userId, actorId, request })');

  return withTransaction(async () => {
    const { actor, member, group } = await lockMembership({ groupId, userId, actorId });

    if (!(await isMember({ userId, groupId }))) {
      throw notFound();
    }

    await assertNotLastAdmin(group, member);
    await assertHeldBy(actor, [group]);

    return revokeMembership({
      userId,
      group,
      actorId,
      request,
    });
  }, SESSION_TRANSACTION);
}
