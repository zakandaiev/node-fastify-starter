import { linkProvider, signInWithEmail, signInWithProvider } from '#core/auth/account.js';
import { invalidateCacheTables } from '#core/cache/index.js';
import { createQuery } from '#core/db/query.js';
import { AppError } from '#core/error/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { GROUP_SLUG } from '#enums/group.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { IDENTITY_LINK_REASON } from '#enums/identity-link-reason.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  connectAppRedis,
  readClaims,
  runInApp,
  TEST_CLIENT,
} from '#root/tests/helper/session.js';
import { unique } from '#utils/array.js';
import { nowUtc } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import {
  after,
  before,
  describe,
  test,
} from 'node:test';
import { inspect } from 'node:util';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const GOOGLE = 'google';
const TELEGRAM = 'telegram';

// An address of its own for each test: the rows of the file stay for the tests after it.
const ADMIN = Object.freeze({
  FIRST: 'first@admin.test',
  KNOWN: 'known@admin.test',
  MERGED: 'merged@admin.test',
  LINKED: 'linked@admin.test',
  DEV: 'dev@admin.test',
  AWAY: 'away@admin.test',
  UNVERIFIED: 'unverified@admin.test',
  MEMBER: 'member@admin.test',
  BESIDE: 'beside@admin.test',
  TWICE: 'twice@admin.test',
  CACHED: 'cached@admin.test',
});
const ADMIN_ENV = Object.freeze({ APP_ADMIN_EMAILS: Object.values(ADMIN).join(', ') });

// Few on purpose: the files of the tests share the connections of one server.
const SMALL_POOL = Object.freeze({ connectionLimit: 3 });

// What a sign-in records of its request in the audit.
const REQUEST = Object.freeze({ ip: '198.51.100.23', id: uuidv7() });

const RACE_MESSAGE = 'A sign-in is run again: another one has written the same identity or email first';
const NO_ADMIN_GROUP_MESSAGE = 'A listed email is not granted the admin group: there is no such group, the seed of the groups has not been applied';

const PROVIDER_REFUSAL = /requires the id of a provider of config\.oauth/;
const PROFILE_REFUSAL = /requires the profile of a provider: \{ subject, email, isEmailVerified, firstName, lastName, claims \}/;
const CLIENT_REFUSAL = /requires the client of the request: readClient\(request\)/;
const USER_ID_REFUSAL = /requires the UUID of a user/;

const EMOJI = String.fromCodePoint(0x1F600);
const LONE_SURROGATE = String.fromCharCode(0xD800);
const REPLACEMENT_CHARACTER = String.fromCharCode(0xFFFD);

const AWAY_SLUG = 'admin-away';
const UNKNOWN_PROVIDER = 'github';
const FULFILLED = 'fulfilled';
const REJECTED = 'rejected';

// The state of a session that waits for a lock another session holds on a whole table, of either kind.
const TABLE_WAIT_STATE = 'Waiting for table%';

const USER_SQL = 'SELECT id, email, email_verified_at, first_name, last_name, status FROM users WHERE id = :id';
const USERS_OF_EMAIL_SQL = 'SELECT id FROM users WHERE email = :email';
const INSERT_USER_SQL = `
  INSERT INTO users (id, email, email_verified_at, first_name, last_name, status)
  VALUES (:id, :email, :emailVerifiedAt, :firstName, :lastName, :status)
`;
const STATUS_SQL = 'UPDATE users SET status = :status WHERE id = :id';

const IDENTITY_COLUMNS = 'user_id, provider, provider_user_id, email, profile, last_login_at';
const IDENTITIES_OF_USER_SQL = `SELECT ${IDENTITY_COLUMNS} FROM user_identities WHERE user_id = :userId ORDER BY created_at, id`;
const IDENTITIES_SQL = `SELECT ${IDENTITY_COLUMNS} FROM user_identities WHERE provider = :provider AND provider_user_id = :subject`;
const INSERT_IDENTITY_SQL = 'INSERT INTO user_identities (user_id, provider, provider_user_id) VALUES (:userId, :provider, :subject)';

const SESSIONS_SQL = 'SELECT is_dev FROM sessions WHERE user_id = :userId';
const AUDIT_SQL = 'SELECT actor_id, action, entity_type, entity_id, meta, ip, request_id FROM audit_logs WHERE entity_id = :userId ORDER BY created_at, id';
const MEMBERSHIPS_SQL = 'SELECT g.slug, ug.granted_by FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE ug.user_id = :userId';
const INSERT_MEMBERSHIP_SQL = 'INSERT INTO user_groups (user_id, group_id, granted_by) VALUES (:userId, :groupId, :grantedBy)';
const MEMBER_IDS_SQL = 'SELECT user_id FROM user_groups WHERE group_id = :groupId ORDER BY user_id';
const RENAME_GROUP_SQL = 'UPDATE groups SET slug = :to WHERE slug = :from';
const SLUG_SQL = 'SELECT id FROM groups WHERE slug = :slug';

const COUNT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM user_identities) AS identities,
    (SELECT COUNT(*) FROM user_groups) AS memberships,
    (SELECT COUNT(*) FROM audit_logs) AS audits,
    (SELECT COUNT(*) FROM sessions) AS sessions
`;
const NOTHING_ADDED = Object.freeze({
  users: 0,
  identities: 0,
  memberships: 0,
  audits: 0,
  sessions: 0,
});

const TABLE_WAITS_SQL = `
  SELECT COUNT(*) AS total
  FROM information_schema.processlist
  WHERE db = :database AND state LIKE :state AND id <> CONNECTION_ID()
`;

const sink = createLogSink();
let fastify = null;
let adminGroupId = null;

function refusalOf(code, statusCode) {
  function isRefusal(error) {
    assert.ok(error instanceof AppError, inspect(error));
    assert.deepEqual([error.code, error.statusCode], [code, statusCode]);

    return true;
  }

  return isRefusal;
}

const UNAUTHENTICATED = refusalOf(ERROR_CODE.AUTHENTICATION_ERROR, HTTP_STATUS.UNAUTHORIZED);
const FORBIDDEN = refusalOf(ERROR_CODE.AUTHORIZATION_ERROR, HTTP_STATUS.FORBIDDEN);
const CONTACT_TAKEN = refusalOf(ERROR_CODE.CONTACT_TAKEN, HTTP_STATUS.CONFLICT);
const IDENTITY_TAKEN = refusalOf(ERROR_CODE.IDENTITY_TAKEN, HTTP_STATUS.CONFLICT);

function typeErrorOf(refusal) {
  function isTypeError(error) {
    assert.ok(error instanceof TypeError && refusal.test(error.message), inspect(error));

    return true;
  }

  return isTypeError;
}

function watchLog() {
  const start = sink.lines.length;

  return (message) => findLogLines({ lines: sink.lines.slice(start) }, message);
}

// As readProviderProfile() gives it.
function profileOf({
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

function verifiedProfileOf(email, fields = {}) {
  return profileOf({ ...fields, email, isEmailVerified: true });
}

function signInBy(providerId, profile) {
  return runInApp(fastify, () => signInWithProvider({
    providerId,
    profile,
    client: TEST_CLIENT,
    request: REQUEST,
  }));
}

function link(userId, providerId, profile) {
  return runInApp(fastify, () => linkProvider({
    userId,
    providerId,
    profile,
    request: REQUEST,
  }));
}

function signInByEmail(email) {
  return runInApp(fastify, () => signInWithEmail({ email, client: TEST_CLIENT, request: REQUEST }));
}

function readRows(sql, binding) {
  return testDb.readRows(sql, binding);
}

async function readUser(id) {
  const [user = null] = await readRows(USER_SQL, { id });

  return user;
}

function pickEmail(user) {
  return { email: user.email, email_verified_at: user.email_verified_at };
}

function readIdentitiesOf(userId) {
  return readRows(IDENTITIES_OF_USER_SQL, { userId });
}

function readIdentities(provider, subject) {
  return readRows(IDENTITIES_SQL, { provider, subject });
}

function readSessions(userId) {
  return readRows(SESSIONS_SQL, { userId });
}

function readAudits(userId) {
  return readRows(AUDIT_SQL, { userId });
}

function readMemberships(userId) {
  return readRows(MEMBERSHIPS_SQL, { userId });
}

async function insertUser({
  email = null,
  isVerified = false,
  firstName = null,
  lastName = null,
  status = USER_STATUS.ACTIVE,
} = {}) {
  const id = uuidv7();

  await readRows(INSERT_USER_SQL, {
    id,
    email,
    emailVerifiedAt: isVerified
      ? nowUtc()
      : null,
    firstName,
    lastName,
    status,
  });

  return id;
}

async function insertIdentity(userId, provider, subject) {
  await readRows(INSERT_IDENTITY_SQL, { userId, provider, subject });

  return subject;
}

function block(id) {
  return readRows(STATUS_SQL, { id, status: USER_STATUS.BLOCKED });
}

async function countRows() {
  const [counts] = await readRows(COUNT_SQL);

  return counts;
}

function countAdded(counted, now) {
  return Object.fromEntries(Object.entries(now).map(([table, total]) => [table, total - counted[table]]));
}

function addedOf(counts) {
  return { ...NOTHING_ADDED, ...counts };
}

async function assertWritesNothing(call, refusal) {
  const counted = await countRows();

  await assert.rejects(call(), refusal);
  assert.deepEqual(countAdded(counted, await countRows()), NOTHING_ADDED);
}

function linkRecordOf(userId, provider, reason) {
  return {
    actor_id: userId,
    action: AUDIT_ACTION.USER_IDENTITY_LINK,
    entity_type: TABLE.USERS,
    entity_id: userId,
    meta: { provider, reason },
    ip: REQUEST.ip,
    request_id: REQUEST.id,
  };
}

function grantRecordOf(userId) {
  return {
    actor_id: null,
    action: AUDIT_ACTION.USER_GROUP_GRANT,
    entity_type: TABLE.USERS,
    entity_id: userId,
    meta: { group: GROUP_SLUG.ADMIN, groupId: adminGroupId },
    ip: REQUEST.ip,
    request_id: REQUEST.id,
  };
}

async function readGrants(userId) {
  return (await readAudits(userId)).filter((record) => record.action === AUDIT_ACTION.USER_GROUP_GRANT);
}

// The admin group and one record of its grant, however many sign-ins came after it, and tokens of full access.
async function assertAdmin(userId, issuedList = []) {
  assert.deepEqual(await readMemberships(userId), [{ slug: GROUP_SLUG.ADMIN, granted_by: null }]);
  assert.deepEqual(await readGrants(userId), [grantRecordOf(userId)]);
  issuedList.forEach((issued) => {
    assert.deepEqual([issued.userId, issued.scopes, readClaims(issued.accessToken).scopes], [userId, [SCOPE_ALL], [SCOPE_ALL]]);
  });
}

async function assertNoAdmin(userId) {
  assert.deepEqual(await readMemberships(userId), []);
  assert.deepEqual(await readGrants(userId), []);
}

// Outside a transaction, as a read of the API runs: served from the cache while the version of user_groups stays.
async function readCachedAdminIds() {
  const query = await runInApp(fastify, () => createQuery(MEMBER_IDS_SQL, { groupId: adminGroupId }).cache({ tables: [TABLE.USER_GROUPS] }).execute());

  return query.fetchAll().map((row) => row.userId);
}

async function settle(promise) {
  const [outcome] = await Promise.allSettled([promise]);

  return outcome;
}

async function countTableWaits() {
  const [{ total }] = await readRows(TABLE_WAITS_SQL, { database: testDb.name, state: TABLE_WAIT_STATE });

  return total;
}

// Every write of the table waits until all the calls wait for it: each has read the table before any of them writes.
async function runSideBySide(t, table, calls) {
  const keeper = await testDb.openKeeper(t);

  await keeper.lockTables([table], 'READ');

  const running = Promise.allSettled(calls.map((call) => call()));
  const caught = await Promise.race([
    settle(running),
    waitFor(async () => (await countTableWaits()) >= calls.length, `${calls.length} calls to wait for the table ${table}`),
  ]);

  await keeper.release();
  assert.equal(caught, true, `The calls did not wait for the table ${table}: ${inspect(caught)}`);

  return running;
}

function readStatuses(outcomes) {
  return outcomes.map((outcome) => outcome.status);
}

function readUserIds(outcomes) {
  return unique(outcomes.map((outcome) => outcome.value?.userId));
}

describe('accounts', { skip: testRedis.skip || testDb.skip }, () => {
  before(async () => {
    await up();
    await up({ type: MIGRATION_TYPE.SEED });

    [{ id: adminGroupId }] = await readRows(SLUG_SQL, { slug: GROUP_SLUG.ADMIN });
    fastify = await testDb.buildApp({ env: ADMIN_ENV, db: SMALL_POOL, logger: { level: 'warn', stream: sink.stream } });
    await connectAppRedis(fastify);
  });

  after(() => fastify?.close());

  describe('signInWithProvider: a first sign-in', () => {
    test('makes a user with the first word of a name and the email the provider verified, its identity and a session', async () => {
      const profile = verifiedProfileOf(' Anna.K@Example.COM ', { firstName: 'Anna Maria', lastName: 'Kovalenko-Shevchenko' });
      const counted = await countRows();
      const issued = await signInBy(GOOGLE, profile);
      const user = await readUser(issued.userId);
      const [identity, ...others] = await readIdentitiesOf(issued.userId);

      assert.deepEqual(countAdded(counted, await countRows()), addedOf({ users: 1, identities: 1, sessions: 1 }));
      assert.deepEqual(user, {
        id: issued.userId,
        email: 'anna.k@example.com',
        email_verified_at: identity.last_login_at,
        first_name: 'Anna',
        last_name: 'Kovalenko-Shevchenko',
        status: USER_STATUS.ACTIVE,
      });
      assert.ok(user.email_verified_at instanceof Date);
      assert.deepEqual(others, []);
      assert.deepEqual(identity, {
        user_id: issued.userId,
        provider: GOOGLE,
        provider_user_id: profile.subject,
        email: 'anna.k@example.com',
        profile: profile.claims,
        last_login_at: identity.last_login_at,
      });
      assert.deepEqual(await readSessions(issued.userId), [{ is_dev: false }]);
      assert.deepEqual([issued.scopes, readClaims(issued.accessToken).sub], [[], issued.userId]);
      await assertNoAdmin(issued.userId);
    });

    test('makes a user whose names are no names, with both NULL', async () => {
      const issued = await signInBy(GOOGLE, profileOf({ firstName: EMOJI, lastName: `${EMOJI} ${EMOJI}` }));

      assert.deepEqual(await readUser(issued.userId), {
        id: issued.userId,
        email: null,
        email_verified_at: null,
        first_name: null,
        last_name: null,
        status: USER_STATUS.ACTIVE,
      });
    });

    test('keeps an email the provider has not verified off the user and on the identity, normalized, and merges nothing by it', async () => {
      const holder = await insertUser({ email: 'olha@example.com', isVerified: true });
      const issued = await signInBy(TELEGRAM, profileOf({ email: ' Olha@Example.COM ' }));
      const [identity] = await readIdentitiesOf(issued.userId);

      assert.notEqual(issued.userId, holder);
      assert.deepEqual(pickEmail(await readUser(issued.userId)), { email: null, email_verified_at: null });
      assert.equal(identity.email, 'olha@example.com');
      assert.deepEqual(await readIdentitiesOf(holder), []);
    });

    test('keeps the claims on the identity as JSON, a lone surrogate in them as U+FFFD', async () => {
      const issued = await signInBy(GOOGLE, profileOf({ claims: { name: `Anna ${LONE_SURROGATE}`, picture: null } }));
      const [identity] = await readIdentitiesOf(issued.userId);

      assert.deepEqual(identity.profile, { sub: identity.provider_user_id, name: `Anna ${REPLACEMENT_CHARACTER}`, picture: null });
    });

    test('refuses a profile that is not mapped, a provider the config does not know and a call without a client, and writes nothing', async () => {
      const wrongProfiles = [
        null,
        {},
        { ...profileOf(), subject: '' },
        { ...profileOf(), isEmailVerified: 'true' },
        { ...profileOf(), claims: null },
      ];
      const cyclic = profileOf();

      cyclic.claims.self = cyclic.claims;

      await Promise.all(wrongProfiles.map((profile) => assertWritesNothing(() => signInBy(GOOGLE, profile), typeErrorOf(PROFILE_REFUSAL))));
      await assertWritesNothing(() => signInBy(GOOGLE, cyclic), TypeError);
      await assertWritesNothing(() => signInBy(UNKNOWN_PROVIDER, profileOf()), typeErrorOf(PROVIDER_REFUSAL));
      await assertWritesNothing(
        () => runInApp(fastify, () => signInWithProvider({ providerId: GOOGLE, profile: profileOf() })),
        typeErrorOf(CLIENT_REFUSAL),
      );
    });
  });

  describe('signInWithProvider: a sign-in of an identity it knows', () => {
    test('signs in to its user with a session more, updates the identity and fills only what is empty', async () => {
      const profile = profileOf({ firstName: 'Olha' });
      const first = await signInBy(GOOGLE, profile);
      const counted = await countRows();
      const second = await signInBy(GOOGLE, {
        ...profile,
        email: 'Olha.S@Example.com',
        firstName: 'Anna',
        lastName: 'Shevchenko',
        claims: { sub: profile.subject, locale: 'uk' },
      });
      const [identity] = await readIdentitiesOf(first.userId);

      assert.equal(second.userId, first.userId);
      assert.notEqual(second.sid, first.sid);
      assert.deepEqual(countAdded(counted, await countRows()), addedOf({ sessions: 1 }));
      assert.deepEqual(await readUser(first.userId), {
        id: first.userId,
        email: null,
        email_verified_at: null,
        first_name: 'Olha',
        last_name: 'Shevchenko',
        status: USER_STATUS.ACTIVE,
      });
      assert.deepEqual([identity.email, identity.profile], ['olha.s@example.com', { sub: profile.subject, locale: 'uk' }]);
      assert.equal((await readSessions(first.userId)).length, 2);
    });

    test('fills an empty email the provider has verified, and leaves one the user has as it is', async () => {
      const emptyProfile = profileOf();
      const { userId: empty } = await signInBy(GOOGLE, emptyProfile);
      const owner = await insertUser({ email: 'own@example.com', isVerified: true });
      const ownSubject = await insertIdentity(owner, GOOGLE, uuidv7());
      const ownBefore = await readUser(owner);

      await signInBy(GOOGLE, { ...emptyProfile, email: 'Filled@Example.com', isEmailVerified: true });
      await signInBy(GOOGLE, verifiedProfileOf('other@example.com', { subject: ownSubject }));

      const [identity] = await readIdentitiesOf(empty);

      assert.deepEqual(pickEmail(await readUser(empty)), { email: 'filled@example.com', email_verified_at: identity.last_login_at });
      assert.deepEqual(await readUser(owner), ownBefore);
    });

    test('marks verified the email the user holds unverified, once the provider has verified it too', async () => {
      const userId = await insertUser({ email: 'mark@example.com' });
      const subject = await insertIdentity(userId, GOOGLE, uuidv7());

      await signInBy(GOOGLE, profileOf({ subject, email: 'mark@example.com' }));

      assert.deepEqual(pickEmail(await readUser(userId)), { email: 'mark@example.com', email_verified_at: null });

      await signInBy(GOOGLE, verifiedProfileOf('Mark@Example.com', { subject }));

      const [identity] = await readIdentitiesOf(userId);

      assert.deepEqual(pickEmail(await readUser(userId)), { email: 'mark@example.com', email_verified_at: identity.last_login_at });
    });

    test('leaves the email empty when another user holds the address, and commits the rest of the sign-in', async () => {
      const watch = watchLog();
      const holder = await insertUser({ email: 'held@example.com' });
      const holderBefore = await readUser(holder);
      const profile = profileOf();
      const { userId } = await signInBy(TELEGRAM, profile);
      const counted = await countRows();
      const issued = await signInBy(TELEGRAM, {
        ...profile,
        email: 'held@example.com',
        isEmailVerified: true,
        firstName: 'Anna',
      });
      const [identity] = await readIdentitiesOf(userId);

      assert.equal(issued.userId, userId);
      assert.deepEqual(countAdded(counted, await countRows()), addedOf({ sessions: 1 }));
      assert.deepEqual(await readUser(userId), {
        id: userId,
        email: null,
        email_verified_at: null,
        first_name: 'Anna',
        last_name: null,
        status: USER_STATUS.ACTIVE,
      });
      assert.equal(identity.email, 'held@example.com');
      assert.deepEqual(await readUser(holder), holderBefore);
      assert.deepEqual(watch(RACE_MESSAGE), []);
    });

    test('refuses a blocked user with AUTHORIZATION_ERROR, with no session and the identity as it was', async () => {
      const profile = profileOf();
      const { userId } = await signInBy(GOOGLE, profile);
      const identitiesBefore = await readIdentitiesOf(userId);

      await block(userId);
      await assertWritesNothing(() => signInBy(GOOGLE, { ...profile, email: 'blocked@example.com', firstName: 'Anna' }), FORBIDDEN);

      assert.deepEqual(await readIdentitiesOf(userId), identitiesBefore);
      assert.equal((await readUser(userId)).first_name, null);
      assert.equal((await readSessions(userId)).length, 1);
    });
  });

  describe('signInWithProvider: an email another user holds', () => {
    test('is merged into when both sides have verified it: an identity more, a record of the link, the empty fields filled', async () => {
      const first = await signInBy(GOOGLE, verifiedProfileOf('merge@example.com', { lastName: 'Kovalenko' }));
      const counted = await countRows();
      const issued = await signInBy(TELEGRAM, verifiedProfileOf('Merge@Example.com', { firstName: 'Anna', lastName: 'Other' }));
      const merged = await readUser(first.userId);

      assert.equal(issued.userId, first.userId);
      assert.deepEqual(countAdded(counted, await countRows()), addedOf({ identities: 1, audits: 1, sessions: 1 }));
      assert.deepEqual((await readIdentitiesOf(first.userId)).map((identity) => identity.provider), [GOOGLE, TELEGRAM]);
      assert.deepEqual(await readAudits(first.userId), [linkRecordOf(first.userId, TELEGRAM, IDENTITY_LINK_REASON.EMAIL)]);
      assert.deepEqual([merged.first_name, merged.last_name], ['Anna', 'Kovalenko']);
    });

    test('refuses with CONTACT_TAKEN and writes nothing when that user holds it unverified', async () => {
      const holder = await insertUser({ email: 'pending@example.com' });

      await assertWritesNothing(() => signInBy(GOOGLE, verifiedProfileOf('Pending@Example.com')), CONTACT_TAKEN);

      assert.deepEqual(pickEmail(await readUser(holder)), { email: 'pending@example.com', email_verified_at: null });
    });

    test('refuses with AUTHORIZATION_ERROR and writes nothing when that user is blocked', async () => {
      await insertUser({ email: 'blocked.holder@example.com', isVerified: true, status: USER_STATUS.BLOCKED });

      await assertWritesNothing(() => signInBy(TELEGRAM, verifiedProfileOf('blocked.holder@example.com')), FORBIDDEN);
    });
  });

  describe('the bootstrap of an admin', () => {
    test('grants a verified email of APP_ADMIN_EMAILS the admin group at a first sign-in, with one record, and not again', async () => {
      const profile = verifiedProfileOf(ADMIN.FIRST);
      const first = await signInBy(GOOGLE, profile);
      const second = await signInBy(GOOGLE, profile);

      await assertAdmin(first.userId, [first, second]);
    });

    test('grants it at the sign-in of a known identity that brings the email', async () => {
      const profile = profileOf();
      const first = await signInBy(GOOGLE, profile);

      await assertNoAdmin(first.userId);

      const second = await signInBy(GOOGLE, { ...profile, email: ADMIN.KNOWN, isEmailVerified: true });

      await assertAdmin(first.userId, [second]);
    });

    test('grants it at a merge by the email', async () => {
      const userId = await insertUser({ email: ADMIN.MERGED, isVerified: true });
      const issued = await signInBy(TELEGRAM, verifiedProfileOf(ADMIN.MERGED));

      await assertAdmin(userId, [issued]);
    });

    test('grants it at a link that brings the email, and the next sign-in has full access', async () => {
      const userId = await insertUser();
      const profile = verifiedProfileOf(ADMIN.LINKED);

      await link(userId, GOOGLE, profile);
      await assertAdmin(userId);

      const issued = await signInBy(GOOGLE, profile);

      await assertAdmin(userId, [issued]);
    });

    test('grants it at the sign-in by the email', async () => {
      const first = await signInByEmail(ADMIN.DEV.toUpperCase());
      const second = await signInByEmail(ADMIN.DEV);

      await assertAdmin(first.userId, [first, second]);
    });

    test('grants nothing again to a listed user who is in the admin group already: no second row, no record, the granted_by of the row it has, and a token of full access', async () => {
      const granterId = await insertUser();
      const userId = await insertUser({ email: ADMIN.MEMBER, isVerified: true });

      await readRows(INSERT_MEMBERSHIP_SQL, { userId, groupId: adminGroupId, grantedBy: granterId });

      const counted = await countRows();
      const issued = await signInByEmail(ADMIN.MEMBER);

      assert.deepEqual(countAdded(counted, await countRows()), addedOf({ sessions: 1 }));
      assert.deepEqual(await readMemberships(userId), [{ slug: GROUP_SLUG.ADMIN, granted_by: granterId }]);
      assert.deepEqual(await readGrants(userId), []);
      assert.deepEqual([issued.userId, issued.scopes, readClaims(issued.accessToken).scopes], [userId, [SCOPE_ALL], [SCOPE_ALL]]);
    });

    test('grants it to a listed user while another user is a member of the group: the row of someone else is no row of this user', async () => {
      const otherId = await insertUser();

      await readRows(INSERT_MEMBERSHIP_SQL, { userId: otherId, groupId: adminGroupId, grantedBy: null });

      const issued = await signInBy(GOOGLE, verifiedProfileOf(ADMIN.BESIDE));

      await assertAdmin(issued.userId, [issued]);
    });

    // A read of a table whose version is not there yet caches nothing: the bump starts the version first. The row behind
    // the back is written by a statement that moves no version, and the cached read does not learn of it.
    test('moves the version of user_groups with the grant: a cached read of the members of the admin group, which a write behind its back does not reach, shows the new admin at once', async () => {
      const behindId = await insertUser();

      await runInApp(fastify, () => invalidateCacheTables([TABLE.USER_GROUPS]));

      const cached = await readCachedAdminIds();

      await readRows(INSERT_MEMBERSHIP_SQL, { userId: behindId, groupId: adminGroupId, grantedBy: null });

      const stale = await readCachedAdminIds();
      const issued = await signInBy(GOOGLE, verifiedProfileOf(ADMIN.CACHED));

      assert.deepEqual(stale, cached);
      assert.deepEqual(await readCachedAdminIds(), [...cached, behindId, issued.userId].toSorted());
      await assertAdmin(issued.userId, [issued]);
    });

    test('grants nothing for an email of the list the provider has not verified', async () => {
      const issued = await signInBy(GOOGLE, profileOf({ email: ADMIN.UNVERIFIED }));

      await assertNoAdmin(issued.userId);
      assert.deepEqual(issued.scopes, []);
    });

    test('warns and grants nothing when there is no admin group, and the sign-in goes on', async (t) => {
      const watch = watchLog();

      await readRows(RENAME_GROUP_SQL, { from: GROUP_SLUG.ADMIN, to: AWAY_SLUG });
      t.after(() => readRows(RENAME_GROUP_SQL, { from: AWAY_SLUG, to: GROUP_SLUG.ADMIN }));

      const issued = await signInBy(GOOGLE, verifiedProfileOf(ADMIN.AWAY));

      await assertNoAdmin(issued.userId);
      assert.deepEqual(issued.scopes, []);
      assert.deepEqual(watch(NO_ADMIN_GROUP_MESSAGE).map((line) => line.userId), [issued.userId]);
      assert.deepEqual(await readSessions(issued.userId), [{ is_dev: false }]);
    });
  });

  describe('linkProvider', () => {
    test('links a new identity to the user with a record of the link, and fills what is empty', async () => {
      const userId = await insertUser({ lastName: 'Kovalenko' });
      const profile = profileOf({ firstName: 'Anna Maria', lastName: 'Other' });
      const linked = await link(userId, GOOGLE, profile);
      const issued = await signInBy(GOOGLE, profile);

      assert.deepEqual([linked.id, linked.firstName, linked.lastName], [userId, 'Anna', 'Kovalenko']);
      assert.equal((await readUser(userId)).first_name, 'Anna');
      assert.deepEqual((await readIdentitiesOf(userId)).map((identity) => identity.provider_user_id), [profile.subject]);
      assert.deepEqual(await readAudits(userId), [linkRecordOf(userId, GOOGLE, IDENTITY_LINK_REASON.LINK)]);
      assert.equal(issued.userId, userId);
    });

    test('links more identities of one provider to one user, and updates one it has without a record', async () => {
      const userId = await insertUser();
      const [first, second] = [profileOf(), profileOf()];

      await link(userId, GOOGLE, first);
      await link(userId, GOOGLE, second);

      const counted = await countRows();

      await link(userId, GOOGLE, { ...first, email: 'again@example.com' });

      const identities = await readIdentitiesOf(userId);

      assert.deepEqual(countAdded(counted, await countRows()), NOTHING_ADDED);
      assert.deepEqual(identities.map((identity) => [identity.provider, identity.provider_user_id]), [[GOOGLE, first.subject], [GOOGLE, second.subject]]);
      assert.equal(identities[0].email, 'again@example.com');
      assert.equal((await readAudits(userId)).length, 2);
    });

    test('refuses an identity of another user with IDENTITY_TAKEN, and writes nothing', async () => {
      const [owner, other] = await Promise.all([insertUser(), insertUser()]);
      const profile = profileOf({ firstName: 'Anna' });

      await link(owner, TELEGRAM, profile);
      await assertWritesNothing(() => link(other, TELEGRAM, profile), IDENTITY_TAKEN);

      assert.equal((await readUser(other)).first_name, null);
    });

    test('refuses a user that is not there with AUTHENTICATION_ERROR, and a blocked one with AUTHORIZATION_ERROR', async () => {
      const blocked = await insertUser({ status: USER_STATUS.BLOCKED });

      await assertWritesNothing(() => link(uuidv7(), GOOGLE, profileOf()), UNAUTHENTICATED);
      await assertWritesNothing(() => link(blocked, GOOGLE, profileOf()), FORBIDDEN);
    });

    test('refuses a user that is no UUID, a provider the config does not know and a profile that is not mapped, and writes nothing', async () => {
      await assertWritesNothing(() => link('user-1', GOOGLE, profileOf()), typeErrorOf(USER_ID_REFUSAL));
      await assertWritesNothing(() => link(uuidv7(), UNKNOWN_PROVIDER, profileOf()), typeErrorOf(PROVIDER_REFUSAL));
      await assertWritesNothing(() => link(uuidv7(), GOOGLE, { subject: 'sub-1' }), typeErrorOf(PROFILE_REFUSAL));
    });
  });

  describe('signInWithEmail', () => {
    test('makes a user with the email verified and a session of dev mode, then signs in to it', async () => {
      const first = await signInByEmail(' New.User@Example.com ');
      const second = await signInByEmail('new.user@example.com');
      const user = await readUser(first.userId);

      assert.equal(second.userId, first.userId);
      assert.equal(user.email, 'new.user@example.com');
      assert.ok(user.email_verified_at instanceof Date);
      assert.deepEqual(await readSessions(first.userId), [{ is_dev: true }, { is_dev: true }]);
      assert.deepEqual(await readIdentitiesOf(first.userId), []);
    });

    test('signs in to the user that holds the email, verified or not, and refuses a blocked one', async () => {
      const holder = await insertUser({ email: 'held.dev@example.com' });
      const issued = await signInByEmail('Held.Dev@Example.com');

      await insertUser({ email: 'blocked.dev@example.com', isVerified: true, status: USER_STATUS.BLOCKED });

      assert.equal(issued.userId, holder);
      assert.deepEqual(pickEmail(await readUser(holder)), { email: 'held.dev@example.com', email_verified_at: null });
      await assertWritesNothing(() => signInByEmail('blocked.dev@example.com'), FORBIDDEN);
    });
  });

  describe('sign-ins side by side', () => {
    test('two first sign-ins of one identity make one user and one identity, and a session each', async (t) => {
      const watch = watchLog();
      const profile = profileOf({ firstName: 'Anna' });
      const counted = await countRows();
      const outcomes = await runSideBySide(t, TABLE.USER_IDENTITIES, [() => signInBy(GOOGLE, profile), () => signInBy(GOOGLE, profile)]);
      const [identity, ...others] = await readIdentities(GOOGLE, profile.subject);

      assert.deepEqual(readStatuses(outcomes), [FULFILLED, FULFILLED]);
      assert.deepEqual(others, []);
      assert.deepEqual(readUserIds(outcomes), [identity.user_id]);
      assert.equal((await readSessions(identity.user_id)).length, 2);
      assert.deepEqual(countAdded(counted, await countRows()), addedOf({ users: 1, identities: 1, sessions: 2 }));
      assert.equal(watch(RACE_MESSAGE).length, 1);
    });

    test('one verified email through two providers at once makes one user, with both identities', async (t) => {
      const email = 'side.by.side@example.com';
      const outcomes = await runSideBySide(t, TABLE.USERS, [
        () => signInBy(GOOGLE, verifiedProfileOf(email)),
        () => signInBy(TELEGRAM, verifiedProfileOf(email)),
      ]);
      const [owner, ...others] = await readRows(USERS_OF_EMAIL_SQL, { email });

      assert.deepEqual(readStatuses(outcomes), [FULFILLED, FULFILLED]);
      assert.deepEqual(others, []);
      assert.deepEqual(readUserIds(outcomes), [owner.id]);
      assert.deepEqual((await readIdentitiesOf(owner.id)).map((identity) => identity.provider).toSorted(), [GOOGLE, TELEGRAM]);
      assert.equal((await readAudits(owner.id)).filter((record) => record.meta.reason === IDENTITY_LINK_REASON.EMAIL).length, 1);
    });

    test('two sign-ins of one listed user at once grant the admin group once: one row, one record, and full access for both', async (t) => {
      const userId = await insertUser({ email: ADMIN.TWICE, isVerified: true });
      const outcomes = await runSideBySide(t, TABLE.USERS, [() => signInByEmail(ADMIN.TWICE), () => signInByEmail(ADMIN.TWICE)]);

      assert.deepEqual(readStatuses(outcomes), [FULFILLED, FULFILLED]);
      await assertAdmin(userId, outcomes.map((outcome) => outcome.value));
    });

    test('two links of one account of a provider to two users: one is linked, the other gets IDENTITY_TAKEN', async (t) => {
      const watch = watchLog();
      const users = await Promise.all([insertUser(), insertUser()]);
      const profile = profileOf();
      const outcomes = await runSideBySide(t, TABLE.USER_IDENTITIES, users.map((userId) => () => link(userId, GOOGLE, profile)));
      const linked = outcomes.filter((outcome) => outcome.status === FULFILLED);
      const refused = outcomes.filter((outcome) => outcome.status === REJECTED);

      assert.deepEqual([linked.length, refused.length], [1, 1]);
      assert.ok(IDENTITY_TAKEN(refused[0].reason));
      assert.deepEqual((await readIdentities(GOOGLE, profile.subject)).map((identity) => identity.user_id), [linked[0].value.id]);
      assert.equal(watch(RACE_MESSAGE).length, 1);
    });
  });
});
