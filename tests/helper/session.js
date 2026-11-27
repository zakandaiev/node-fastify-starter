import { signInWithProvider } from '#core/auth/account.js';
import { isSessionAlive } from '#core/auth/registry.js';
import { createSession } from '#core/auth/session.js';
import { runInContext } from '#core/context/index.js';
import { createQuery } from '#core/db/query.js';
import { withTransaction } from '#core/db/transaction.js';
import { COOKIE } from '#enums/cookie.js';
import { GROUP_SLUG } from '#enums/group.js';
import { HEADER } from '#enums/header.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { NO_THROTTLE } from '#root/tests/helper/alert.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { createLogSink, LOG_LEVEL } from '#root/tests/helper/log.js';
import {
  createFakeRedis,
  REDIS_DOWN_ENV,
  toRespBulk,
  waitUntilReady,
} from '#root/tests/helper/redis.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import { mapValues, pick } from '#utils/object.js';
import assert from 'node:assert/strict';

const LOOPBACK = '127.0.0.1';
const KEY_SEPARATOR = ':';

// A time left out keeps the one the server has written: the columns take no NULL.
const PROFILE_SQL = `
  UPDATE users
  SET email = :email, email_verified_at = :emailVerifiedAt, first_name = :firstName, last_name = :lastName, locale = :locale,
    timezone = :timezone, created_at = COALESCE(:createdAt, created_at), updated_at = COALESCE(:updatedAt, updated_at)
  WHERE id = :id
`;
const IDENTITY_SQL = `
  INSERT INTO user_identities (user_id, provider, provider_user_id, email, is_email_verified)
  VALUES (:userId, :provider, :subject, :email, :isEmailVerified)
`;
const GROUP_SQL = 'INSERT INTO groups (id, slug, name, is_superadmin, is_system) VALUES (:id, :slug, :slug, :isSuperadmin, :isSystem)';
const JOIN_SQL = 'INSERT INTO user_groups (user_id, group_id, granted_by) VALUES (:userId, :groupId, :grantedBy)';
const SLUG_SQL = 'SELECT id FROM groups WHERE slug = :slug';
const MEMBERSHIPS_SQL = 'SELECT user_id, group_id, granted_by FROM user_groups WHERE group_id = :groupId ORDER BY user_id';
const MEMBER_IDS_SQL = 'SELECT user_id FROM user_groups WHERE group_id = :groupId ORDER BY user_id';
const AUDIT_SQL = `
  SELECT actor_id, action, entity_type, entity_id, meta, ip, request_id
  FROM audit_logs
  WHERE entity_id = :entityId
  ORDER BY id
`;

// Each table in the order of its key: a state read twice is equal while nothing has written it.
const STATE_ORDER = Object.freeze({
  [TABLE.USERS]: 'id',
  [TABLE.USER_IDENTITIES]: 'id',
  [TABLE.GROUPS]: 'id',
  [TABLE.GROUP_SCOPES]: 'group_id, scope',
  [TABLE.USER_GROUPS]: 'user_id, group_id',
  [TABLE.AUDIT_LOGS]: 'id',
  [TABLE.SESSIONS]: 'id',
});

// The cookies of a signed-in browser: the two tokens and their markers, not those of a sign-in on its way.
export const AUTH_COOKIES = Object.freeze([COOKIE.ACCESS_TOKEN, COOKIE.REFRESH_TOKEN, COOKIE.HAS_SESSION, COOKIE.HAS_ACCESS]);

export const TEST_CLIENT = Object.freeze({ userAgent: 'session-test-agent', ip: '203.0.113.7' });

// The request a call of the core is given outside a route: the audit records its ip and its id.
export const TEST_REQUEST = Object.freeze({ ip: '198.51.100.23', id: uuidv7() });

export const UNTOLD_MESSAGE = 'Sessions are revoked, and Redis did not take all it was told: another process may take an old mark for live until the access token ends';

// The marks of the registry and the namespace of their keys, as src/core/auth/registry.js writes them: a session that
// has no mark is read as null.
export const SESSION_KEY_NAMESPACE = 'session:';
export const ALIVE_MARK = '1';
export const REVOKED_MARK = '0';

// What a process has found alive it takes for alive longer than any test lasts: it refuses only what it was told of.
export const LONG_MEMORY = Object.freeze({ registryMemoryTtl: '1h' });

// No service: the database and Redis are closed ports. A route that asks one of them answers 503, not 401.
export async function buildDownApp(t, { env = {}, ...sections } = {}) {
  const fastify = await buildTestApp({ ...sections, env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()), ...env } });

  t.after(() => fastify.close());

  return fastify;
}

// An app on a test database, with a log the test reads and no throttle on its alerts. Its Redis is down until
// connectAppRedis().
export async function openLoggedApp(t, testDb, {
  receiver, env, level = 'info', ...sections
} = {}) {
  const sink = createLogSink();
  const fastify = await testDb.buildApp({
    ...sections,
    env: { ...receiver?.env.webhook, ...env },
    alert: { ...receiver?.config.alert, throttleWindow: NO_THROTTLE },
    logger: { level, stream: sink.stream },
  });

  t.after(() => fastify.close());

  return { fastify, sink };
}

// A Redis that knows every session as a live one, but for those a test gives a mark of their own: with the database
// down, it alone lets a valid token in.
export async function createMarkedRedisEnv(t, marks = {}) {
  function respond([name, key]) {
    if (name !== 'get') {
      return null;
    }

    const sid = key.split(KEY_SEPARATOR).at(-1);

    return toRespBulk(Object.hasOwn(marks, sid)
      ? marks[sid]
      : ALIVE_MARK);
  }

  const fake = await createFakeRedis(t, respond);

  return { APP_REDIS_HOST: LOOPBACK, APP_REDIS_PORT: String(fake.port) };
}

// What a test of a session runs outside a request: a statement, or a function of the core.
export function runInApp(fastify, fn) {
  return runInContext(fastify.context, fn);
}

export async function readAppRows(fastify, sql, binding) {
  const { rows } = await runInApp(fastify, () => fastify.db.query(sql, binding));

  return rows;
}

export function runInTransaction(fastify, fn, options) {
  return runInApp(fastify, () => withTransaction(fn, options));
}

// The rows a call may write, table by table: a refused call leaves them as they were.
export function readState(fastify, tables) {
  return mapSeries(tables, (table) => readAppRows(fastify, `SELECT * FROM ${table} ORDER BY ${STATE_ORDER[table]}`));
}

export function readAudit(fastify, entityId) {
  return readAppRows(fastify, AUDIT_SQL, { entityId });
}

// A row of readAudit() about a user; a request of null is a call outside any request.
export function auditRecordOf(action, {
  entityId,
  actorId,
  meta = null,
  request = TEST_REQUEST,
}) {
  return {
    actor_id: actorId,
    action,
    entity_type: TABLE.USERS,
    entity_id: entityId,
    meta,
    ip: request?.ip ?? null,
    request_id: request?.id ?? null,
  };
}

// Outside a transaction, as a read of the API runs: served from the cache while the version of user_groups stays.
export async function readCachedMemberIds(fastify, groupId) {
  const query = await runInApp(fastify, () => createQuery(MEMBER_IDS_SQL, { groupId }).cache({ tables: [TABLE.USER_GROUPS] }).execute());

  return query.fetchAll().map((row) => row.userId);
}

// What another session may lock at once: SKIP LOCKED reads past a row that a transaction holds instead of waiting for
// it. The keeper of testDb.openKeeper() takes "?" placeholders.
export async function readUnlockedIds(keeper, table, ids) {
  const [rows] = await keeper.query(`SELECT id FROM ${table} WHERE id IN (?) ORDER BY id FOR UPDATE SKIP LOCKED`, [ids]);

  return rows.map((row) => row.id);
}

// As the entrypoint starts it: an app of the tests has its Redis down until it is told to connect.
export async function connectAppRedis(fastify) {
  fastify.redis.connect();

  return waitUntilReady(fastify.redis);
}

export async function createUser(fastify, { id = uuidv7(), status = USER_STATUS.ACTIVE } = {}) {
  await readAppRows(fastify, 'INSERT INTO users (id, status) VALUES (:id, :status)', { id, status });

  return id;
}

// A group of its own for the user, with these scopes or with full access.
export async function grantScopes(fastify, userId, scopes, { isSuperadmin = false } = {}) {
  const groupId = uuidv7();

  await readAppRows(fastify, 'INSERT INTO groups (id, slug, name, is_superadmin) VALUES (:groupId, :slug, :slug, :isSuperadmin)', {
    groupId,
    slug: groupId,
    isSuperadmin,
  });
  await Promise.all(scopes.map((scope) => readAppRows(fastify, 'INSERT INTO group_scopes (group_id, scope) VALUES (:groupId, :scope)', { groupId, scope })));
  await readAppRows(fastify, 'INSERT INTO user_groups (user_id, group_id) VALUES (:userId, :groupId)', { userId, groupId });

  return groupId;
}

// The row of createUser() with these columns of a profile written over it.
export async function insertUser(fastify, {
  email = null,
  emailVerifiedAt = null,
  firstName = null,
  lastName = null,
  locale = null,
  timezone = null,
  status = USER_STATUS.ACTIVE,
  createdAt = null,
  updatedAt = null,
} = {}) {
  const id = await createUser(fastify, { status });

  await readAppRows(fastify, PROFILE_SQL, {
    id,
    email,
    emailVerifiedAt,
    firstName,
    lastName,
    locale,
    timezone,
    createdAt,
    updatedAt,
  });

  return id;
}

// "*" stands for full access, the flag of a group; the other scopes go into a group of the user's own, whose id comes
// back: null without one.
export function grantActorScopes(fastify, userId, scopes = []) {
  const listed = scopes.filter((scope) => scope !== SCOPE_ALL);
  const isSuperadmin = listed.length !== scopes.length;

  return isSuperadmin || listed.length
    ? grantScopes(fastify, userId, listed, { isSuperadmin })
    : null;
}

export async function createActor(fastify, scopes = []) {
  const id = await createUser(fastify);

  await grantActorScopes(fastify, id, scopes);

  return id;
}

export async function insertIdentity(fastify, {
  userId,
  provider,
  subject = uuidv7(),
  email = null,
  isEmailVerified = false,
}) {
  await readAppRows(fastify, IDENTITY_SQL, {
    userId,
    provider,
    subject,
    email,
    isEmailVerified,
  });

  return subject;
}

// A group as a membership takes it. The slug is no copy of the id: a record that names both tells them apart.
export async function insertGroup(fastify, { isSuperadmin = false, isSystem = false } = {}) {
  const group = { id: uuidv7(), slug: `group-${uuidv7()}` };

  await readAppRows(fastify, GROUP_SQL, { ...group, isSuperadmin, isSystem });

  return group;
}

export function joinGroup(fastify, { userId, groupId, grantedBy = null }) {
  return readAppRows(fastify, JOIN_SQL, { userId, groupId, grantedBy });
}

export function readMemberships(fastify, groupId) {
  return readAppRows(fastify, MEMBERSHIPS_SQL, { groupId });
}

export async function findGroupId(fastify, slug) {
  const [row = null] = await readAppRows(fastify, SLUG_SQL, { slug });

  return row?.id ?? null;
}

// The group of full access that the seed of the groups makes.
export async function readAdminId(fastify) {
  const id = await findGroupId(fastify, GROUP_SLUG.ADMIN);

  assert.ok(id !== null, 'The admin group of the seed is missing');

  return id;
}

// As readProviderProfile() gives it.
export function profileOf({
  subject = uuidv7(),
  email = null,
  isEmailVerified = false,
  firstName = null,
  lastName = null,
  claims = {},
} = {}) {
  return {
    subject,
    email,
    isEmailVerified,
    firstName,
    lastName,
    claims: { sub: subject, ...claims },
  };
}

export function verifiedProfileOf(email, fields = {}) {
  return profileOf({ ...fields, email, isEmailVerified: true });
}

export function signInByProvider(fastify, providerId, profile) {
  return runInApp(fastify, () => signInWithProvider({
    providerId,
    profile,
    client: TEST_CLIENT,
    request: TEST_REQUEST,
  }));
}

export function toBearer(accessToken) {
  return { [HEADER.AUTHORIZATION]: `Bearer ${accessToken}` };
}

// A session as a sign-in makes it, through the core: what it gives goes into inject() as "cookies" or as "headers".
export async function signIn(fastify, { userId, client = TEST_CLIENT, isDev = false } = {}) {
  const ownerId = userId ?? await createUser(fastify);
  const issued = await runInApp(fastify, () => createSession({ userId: ownerId, client, isDev }));

  return {
    userId: ownerId,
    sid: issued.sid,
    issued,
    accessCookie: { [COOKIE.ACCESS_TOKEN]: issued.accessToken },
    refreshCookie: { [COOKIE.REFRESH_TOKEN]: issued.refreshToken },
    bearer: toBearer(issued.accessToken),
  };
}

export async function readSessionRow(fastify, sid) {
  const [row = null] = await readAppRows(fastify, 'SELECT * FROM sessions WHERE id = :sid', { sid });

  return row;
}

export function isAliveIn(fastify, sid) {
  return runInApp(fastify, () => isSessionAlive(sid));
}

export function toRegistryKey(keyPrefix, sid) {
  return `${keyPrefix}${SESSION_KEY_NAMESPACE}${sid}`;
}

// "testRedis" is what createTestRedis() gives.
export function readRegistryMarks(testRedis, sids) {
  return testRedis.admin.mget(sids.map((sid) => toRegistryKey(testRedis.keyPrefix, sid)));
}

// The cookies of sign-in an answer sets or clears, by name.
export function readAuthCookies(response) {
  return Object.fromEntries(response.cookies
    .filter((cookie) => AUTH_COOKIES.includes(cookie.name))
    .map((cookie) => [cookie.name, cookie]));
}

// The refresh token a successful answer has put into its cookie, as the next refresh sends it.
export function takeRefreshCookie(response) {
  return pick(mapValues(readAuthCookies(response), (cookie) => cookie.value), [COOKIE.REFRESH_TOKEN]);
}

export function readClaims(token) {
  const [, payload] = token.split('.');

  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

export function listUntold(sink) {
  return sink.lines
    .filter((line) => line.sids !== undefined)
    .map((line) => pick(line, ['level', 'msg', 'sids']));
}

export function untoldOf(sids) {
  return { level: LOG_LEVEL.ERROR, msg: UNTOLD_MESSAGE, sids };
}
