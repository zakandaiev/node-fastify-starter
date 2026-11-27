import { writeAudit } from '#core/audit/index.js';
import { toValidPictureUrl } from '#core/auth/oauth/provider.js';
import { copyProviderPicture } from '#core/auth/picture.js';
import { createSession, SESSION_TRANSACTION } from '#core/auth/session.js';
import {
  ACCOUNT_FIELDS,
  assertActiveUser,
  lockAccount,
  lockUsers,
} from '#core/auth/user.js';
import { grantMembership } from '#core/authz/membership.js';
import { getContext } from '#core/context/index.js';
import { insertReturning, updateReturning } from '#core/db/index.js';
import { createQuery } from '#core/db/query.js';
import { retryOnce, withTransaction } from '#core/db/transaction.js';
import { findUniqueViolation } from '#core/error/classify.js';
import { AppError } from '#core/error/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { GROUP_SLUG } from '#enums/group.js';
import { IDENTITY_LINK_REASON } from '#enums/identity-link-reason.js';
import { TABLE } from '#enums/table.js';
import { UNIQUE_INDEX } from '#enums/unique-index.js';
import { nowUtc } from '#utils/date.js';
import { assertUuid, isUuid, uuidv7 } from '#utils/id.js';
import { compact } from '#utils/object.js';
import { toValidPersonName } from '#utils/person.js';
import { toJsonTree } from '#utils/serialize.js';
import {
  isBoolean,
  isNonEmptyObject,
  isNonEmptyString,
  isObject,
} from '#utils/type.js';
import { toValidEmail } from '#utils/validate.js';

const IDENTITY_FIELDS = Object.freeze(['id']);

const EMAIL_OWNER_SQL = 'SELECT id FROM users WHERE email = :email';
const LISTED_IDENTITY_SQL = `
  SELECT id
  FROM user_identities
  WHERE user_id = :userId AND email IN (:emails) AND is_email_verified = TRUE
  LIMIT 1
`;
const IDENTITY_SQL = 'SELECT id, user_id FROM user_identities WHERE provider = :provider AND provider_user_id = :subject';

const ADMIN_GROUP_SQL = `
  SELECT g.id, ug.user_id AS member_id
  FROM groups g
  LEFT JOIN user_groups ug ON ug.group_id = g.id AND ug.user_id = :userId
  WHERE g.slug = :slug
`;

// Two first sign-ins of one identity or one email meet at these. Under READ COMMITTED the second run reads what the
// first has committed, and signs in to that account instead of making another.
const RACE_INDEXES = Object.freeze([UNIQUE_INDEX.USERS_EMAIL, UNIQUE_INDEX.USER_IDENTITIES_PROVIDER_USER]);

const RACE_MESSAGE = 'A sign-in is run again: another one has written the same identity or email first';
const NO_ADMIN_GROUP_MESSAGE = 'A listed email is not granted the admin group: there is no such group, the seed of the groups has not been applied';

function readProvider(providerId, signature) {
  const provider = getContext().config.oauth.providers.find((record) => record.id === providerId);

  if (provider === undefined) {
    throw new TypeError(`${signature} requires the id of a provider of config.oauth`);
  }

  return provider;
}

function assertClient(client, signature) {
  if (!isObject(client)) {
    throw new TypeError(`${signature} requires the client of the request: readClient(request)`);
  }
}

// Normalized once more where it is written, whoever mapped it: a user holds a valid name or none, an email in the form
// it is searched by, and an avatar copied from an address over TLS alone. The claims become JSON here, before any
// statement: a value JSON cannot take fails first.
function readProfile(profile, signature) {
  const isProfile = isObject(profile)
    && isNonEmptyString(profile.subject)
    && isBoolean(profile.isEmailVerified)
    && isObject(profile.claims);

  if (!isProfile) {
    throw new TypeError(`${signature} requires the profile of a provider: { subject, email, isEmailVerified, firstName, lastName, claims }`);
  }

  const email = toValidEmail(profile.email);

  return {
    subject: profile.subject,
    email,
    isEmailVerified: email !== null && profile.isEmailVerified,
    firstName: toValidPersonName(profile.firstName),
    lastName: toValidPersonName(profile.lastName),
    pictureUrl: toValidPictureUrl(profile.pictureUrl),
    claimsJson: JSON.stringify(toJsonTree(profile.claims)),
  };
}

function isRaceOfSignIns(error) {
  return RACE_INDEXES.includes(findUniqueViolation(error)?.constraint);
}

// Every flow locks the row of the user before what refers to it, as createSession() does: its identities, then its
// groups, the audit and its sessions.
function runInAccount(fn) {
  return retryOnce(() => withTransaction(fn, SESSION_TRANSACTION), { shouldRetry: isRaceOfSignIns, message: RACE_MESSAGE });
}

async function readRow(sql, binding) {
  const query = createQuery(sql, binding);

  await query.execute();

  return query.fetch();
}

// Found without a lock and locked by its key: a lock taken through the entry of the email first would cross a deletion
// or a change of the email that holds the row and goes for that entry. An owner that changed meanwhile is none.
async function lockEmailOwner(email) {
  const found = await readRow(EMAIL_OWNER_SQL, { email });

  if (found === null) {
    return null;
  }

  const [owner = null] = await lockUsers([found.id]);

  return owner?.email === email
    ? owner
    : null;
}

// A plain read: no lock of a flow comes before the lock of the user.
function findIdentity(providerId, subject) {
  return readRow(IDENTITY_SQL, { provider: providerId, subject });
}

function insertUser({
  email,
  isEmailVerified,
  firstName,
  lastName,
}, now) {
  return insertReturning(TABLE.USERS, {
    id: uuidv7(),
    email: isEmailVerified
      ? email
      : null,
    emailVerifiedAt: isEmailVerified
      ? now
      : null,
    firstName,
    lastName,
  }, { returning: ACCOUNT_FIELDS });
}

async function updateUser(user, patch) {
  if (!isNonEmptyObject(patch)) {
    return user;
  }

  const [updated] = await updateReturning(TABLE.USERS, patch, { where: { id: user.id }, returning: ACCOUNT_FIELDS });

  return updated;
}

function toIdentityFields(profile, now) {
  return {
    email: profile.email,
    isEmailVerified: profile.isEmailVerified,
    profile: profile.claimsJson,
    lastLoginAt: now,
  };
}

function insertIdentity(userId, { providerId, profile, now }) {
  return insertReturning(TABLE.USER_IDENTITIES, {
    id: uuidv7(),
    userId,
    provider: providerId,
    providerUserId: profile.subject,
    ...toIdentityFields(profile, now),
  }, { returning: IDENTITY_FIELDS });
}

// The identity was read before the lock of its user: it may be gone since, with the user or on its own.
async function touchIdentity(identity, userId, { profile, now }) {
  const [touched] = await updateReturning(TABLE.USER_IDENTITIES, toIdentityFields(profile, now), {
    where: { id: identity.id, userId },
    returning: IDENTITY_FIELDS,
  });

  if (touched === undefined) {
    throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
  }

  return touched;
}

function recordLink(userId, { providerId, request }, reason) {
  return writeAudit({
    action: AUDIT_ACTION.USER_IDENTITY_LINK,
    entityType: TABLE.USERS,
    entityId: userId,
    actorId: userId,
    meta: { provider: providerId, reason },
    request,
  });
}

// A provider fills what is empty and changes nothing the user has, and marks verified the email the user holds.
function readEmptyFields(user, profile, now) {
  const isOwnEmailVerified = profile.isEmailVerified && user.email === profile.email && user.emailVerifiedAt === null;

  return compact({
    firstName: user.firstName === null
      ? profile.firstName
      : null,
    lastName: user.lastName === null
      ? profile.lastName
      : null,
    emailVerifiedAt: isOwnEmailVerified
      ? now
      : null,
  });
}

// In a savepoint of its own: another user may hold the address, and then the email stays empty and the rest goes on.
async function fillEmail(user, { profile, now }) {
  try {
    return await withTransaction(() => updateUser(user, { email: profile.email, emailVerifiedAt: now }));
  } catch (error) {
    if (findUniqueViolation(error)?.constraint !== UNIQUE_INDEX.USERS_EMAIL) {
      throw error;
    }

    return user;
  }
}

async function fillProfile(user, flow) {
  const filled = await updateUser(user, readEmptyFields(user, flow.profile, flow.now));

  return filled.email === null && flow.profile.isEmailVerified
    ? fillEmail(filled, flow)
    : filled;
}

function isListedEmail(email) {
  return email !== null && getContext().config.auth.adminEmails.includes(email);
}

async function hasConfirmingIdentity(userId, emails) {
  return (await readRow(LISTED_IDENTITY_SQL, { userId, emails })) !== null;
}

// A provider vouches for the address, not a manager: one may set an address before it is listed, and the list would then
// hand full access to their own account. Dev mode trusts its caller with the address.
async function isListedAdmin(user, { isTrusted }) {
  if (user.emailVerifiedAt === null || !isListedEmail(user.email)) {
    return false;
  }

  return isTrusted || hasConfirmingIdentity(user.id, [user.email]);
}

// Whom a sign-in makes an admin through APP_ADMIN_EMAILS holds full access already: an address of the list on the row,
// confirmed or not, as the provider of its owner confirms it; or, while the row has none, a confirmed one of their
// identities, whose address the sign-in copies onto the row.
export async function isAdminCandidate(user) {
  if (!isObject(user) || !isUuid(user.id) || !(user.email === null || isNonEmptyString(user.email))) {
    throw new TypeError('isAdminCandidate(user) requires the row of a user { id, email }');
  }

  if (isListedEmail(user.email)) {
    return true;
  }

  const { adminEmails } = getContext().config.auth;

  if (user.email !== null || !adminEmails.length) {
    return false;
  }

  return hasConfirmingIdentity(user.id, adminEmails);
}

// Granted by nobody: writeAudit() takes the actor from request.user, which the routes of signing in never set. The
// row of the user is locked by then.
async function grantListedAdmin(user, request, { isTrusted = false } = {}) {
  if (!(await isListedAdmin(user, { isTrusted }))) {
    return false;
  }

  const group = await readRow(ADMIN_GROUP_SQL, { userId: user.id, slug: GROUP_SLUG.ADMIN });

  if (group === null) {
    getContext().log.warn({ userId: user.id }, NO_ADMIN_GROUP_MESSAGE);

    return false;
  }

  if (group.memberId !== null) {
    return false;
  }

  return grantMembership({ userId: user.id, group: { id: group.id, slug: GROUP_SLUG.ADMIN }, request });
}

async function signInByIdentity(identity, flow) {
  const user = await lockAccount(identity.userId);

  await touchIdentity(identity, user.id, flow);

  return fillProfile(user, flow);
}

// Merged only when both sides have verified the email: an account that holds it unverified may be of someone who typed
// that address, and the merge would let its owner in there. The refusal comes before any write.
async function mergeByEmail(owner, flow) {
  if (owner.emailVerifiedAt === null) {
    throw new AppError(ERROR_CODE.CONTACT_TAKEN);
  }

  // The merge would give the row the identity that the grant of the admin group waits for.
  if (isListedEmail(owner.email) && !(await hasConfirmingIdentity(owner.id, [owner.email]))) {
    throw new AppError(ERROR_CODE.CONTACT_TAKEN);
  }

  assertActiveUser(owner);
  await insertIdentity(owner.id, flow);
  await recordLink(owner.id, flow, IDENTITY_LINK_REASON.EMAIL);

  return fillProfile(owner, flow);
}

async function register(flow) {
  const user = await insertUser(flow.profile, flow.now);

  await insertIdentity(user.id, flow);

  return user;
}

async function findAccount(flow) {
  const identity = await findIdentity(flow.providerId, flow.profile.subject);

  if (identity !== null) {
    return signInByIdentity(identity, flow);
  }

  const owner = flow.profile.isEmailVerified
    ? await lockEmailOwner(flow.profile.email)
    : null;

  return owner === null
    ? register(flow)
    : mergeByEmail(owner, flow);
}

// After the commit, never inside it: the picture comes over the network. Like a name, it fills an empty avatar alone,
// and a provider whose record names no hosts of pictures gives none.
async function fillAvatar(user, { provider, pictureUrl }) {
  if (user.avatarKey !== null || pictureUrl === null || provider.pictureHosts === undefined) {
    return user;
  }

  const avatarKey = await copyProviderPicture({ userId: user.id, provider, pictureUrl });

  return avatarKey === null
    ? user
    : { ...user, avatarKey };
}

// An email the provider has not verified stays on the identity: it neither finds an account nor reaches one.
export async function signInWithProvider({
  providerId,
  profile,
  client,
  request,
} = {}) {
  const signature = 'signInWithProvider({ providerId, profile, client, request })';

  const provider = readProvider(providerId, signature);

  assertClient(client, signature);

  const mapped = readProfile(profile, signature);
  const { user, issued } = await runInAccount(async () => {
    const found = await findAccount({
      providerId,
      profile: mapped,
      now: nowUtc(),
      request,
    });

    await grantListedAdmin(found, request);

    return { user: found, issued: await createSession({ userId: found.id, client }) };
  });

  await fillAvatar(user, { provider, pictureUrl: mapped.pictureUrl });

  return issued;
}

// Several identities of one provider may belong to one user: each is an account of its own there.
async function linkIdentity(user, flow) {
  const identity = await findIdentity(flow.providerId, flow.profile.subject);

  if (identity === null) {
    await insertIdentity(user.id, flow);
    await recordLink(user.id, flow, IDENTITY_LINK_REASON.LINK);

    return true;
  }

  if (identity.userId !== user.id) {
    throw new AppError(ERROR_CODE.IDENTITY_TAKEN);
  }

  await touchIdentity(identity, user.id, flow);

  return false;
}

export async function linkProvider({
  userId,
  providerId,
  profile,
  request,
} = {}) {
  const signature = 'linkProvider({ userId, providerId, profile, request })';

  assertUuid(userId, signature, 'a user');

  const provider = readProvider(providerId, signature);
  const mapped = readProfile(profile, signature);
  const linked = await runInAccount(async () => {
    const flow = {
      providerId,
      profile: mapped,
      now: nowUtc(),
      request,
    };
    const user = await lockAccount(userId);

    await linkIdentity(user, flow);

    const filled = await fillProfile(user, flow);

    await grantListedAdmin(filled, request);

    return filled;
  });

  return fillAvatar(linked, { provider, pictureUrl: mapped.pictureUrl });
}

// The sign-in of dev mode: it trusts its caller with the email, which nothing proves here. A user that is not there
// yet is made with the email verified.
export async function signInWithEmail({ email, client, request } = {}) {
  const signature = 'signInWithEmail({ email, client, request })';

  const address = toValidEmail(email);

  if (address === null) {
    throw new TypeError(`${signature} requires an email`);
  }

  assertClient(client, signature);

  return runInAccount(async () => {
    const owner = await lockEmailOwner(address);
    const user = owner === null
      ? await insertUser({
        email: address,
        isEmailVerified: true,
        firstName: null,
        lastName: null,
      }, nowUtc())
      : assertActiveUser(owner);

    await grantListedAdmin(user, request, { isTrusted: true });

    return createSession({ userId: user.id, client, isDev: true });
  });
}
