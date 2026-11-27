import {
  isAdminCandidate,
  linkProvider,
  signInWithEmail,
  signInWithProvider,
} from '#core/auth/account.js';
import { invalidateCacheTables } from '#core/cache/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { GROUP_SLUG } from '#enums/group.js';
import { IDENTITY_LINK_REASON } from '#enums/identity-link-reason.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import {
  createDownDb,
  createTestDb,
  findSessionId,
  REFUSED_CONNECTION_CODE,
  RETRY_MESSAGE,
  SMALL_POOL,
} from '#root/tests/helper/db.js';
import { appErrorOf, REFUSAL, typeErrorOf } from '#root/tests/helper/error.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  auditRecordOf,
  connectAppRedis,
  insertIdentity,
  insertUser,
  joinGroup,
  profileOf,
  readAdminId,
  readAudit,
  readCachedMemberIds,
  readClaims,
  runInApp,
  signInByProvider,
  TEST_CLIENT,
  TEST_REQUEST,
  verifiedProfileOf,
} from '#root/tests/helper/session.js';
import { unique } from '#utils/array.js';
import { mapSeries } from '#utils/async.js';
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
  CANDIDATE: 'candidate@admin.test',
  IDENTITY: 'identity@admin.test',
  BEHIND: 'behind@admin.test',
  UNCONFIRMED: 'unconfirmed@admin.test',
  CLAIMED: 'claimed@admin.test',
  PLANTED: 'planted@admin.test',
  VOUCHED: 'vouched@admin.test',
});
const ADMIN_ENV = Object.freeze({ APP_ADMIN_EMAILS: Object.values(ADMIN).join(', ') });

// What a manager's PATCH writes: the address and its confirmation by the manager, with no identity that brings it.
const PLANT_SQL = 'UPDATE users SET email = :email, email_verified_at = :emailVerifiedAt WHERE id = :id';

const RACE_MESSAGE = 'A sign-in is run again: another one has written the same identity or email first';
const NO_ADMIN_GROUP_MESSAGE = 'A listed email is not granted the admin group: there is no such group, the seed of the groups has not been applied';

const PROVIDER_REFUSAL = /requires the id of a provider of config\.oauth/;
const PROFILE_REFUSAL = /requires the profile of a provider: \{ subject, email, isEmailVerified, firstName, lastName, claims \}/;
const CLIENT_REFUSAL = /requires the client of the request: readClient\(request\)/;
const USER_ID_REFUSAL = /requires the UUID of a user/;
const CANDIDATE_REFUSAL = 'isAdminCandidate(user) requires the row of a user { id, email }';

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
const STATUS_SQL = 'UPDATE users SET status = :status WHERE id = :id';

// The lock of lockUsers(), as the server lists it while it waits. The keeper takes "?" placeholders.
const LOCK_USERS_MARK = 'FROM users WHERE id IN';
const MOVE_EMAIL_SQL = 'UPDATE users SET email = ? WHERE id = ?';
const DELETE_USER_SQL = 'DELETE FROM users WHERE id = ?';
const COMMIT_SQL = 'COMMIT';

const IDENTITY_COLUMNS = 'user_id, provider, provider_user_id, email, is_email_verified, profile, last_login_at';
const IDENTITIES_OF_USER_SQL = `SELECT ${IDENTITY_COLUMNS} FROM user_identities WHERE user_id = :userId ORDER BY created_at, id`;
const IDENTITIES_SQL = `SELECT ${IDENTITY_COLUMNS} FROM user_identities WHERE provider = :provider AND provider_user_id = :subject`;

const SESSIONS_SQL = 'SELECT is_dev FROM sessions WHERE user_id = :userId';
const MEMBERSHIPS_SQL = 'SELECT g.slug, ug.granted_by FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE ug.user_id = :userId';
const RENAME_GROUP_SQL = 'UPDATE groups SET slug = :to WHERE slug = :from';

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

const UNAUTHENTICATED = appErrorOf(REFUSAL.UNAUTHENTICATED);
const FORBIDDEN = appErrorOf(REFUSAL.FORBIDDEN);
const CONTACT_TAKEN = appErrorOf(REFUSAL.CONTACT_TAKEN);
const IDENTITY_TAKEN = appErrorOf(REFUSAL.IDENTITY_TAKEN);

function watchLog() {
  const start = sink.lines.length;

  return (message) => findLogLines({ lines: sink.lines.slice(start) }, message);
}

function link(userId, providerId, profile) {
  return runInApp(fastify, () => linkProvider({
    userId,
    providerId,
    profile,
    request: TEST_REQUEST,
  }));
}

function signInByEmail(email) {
  return runInApp(fastify, () => signInWithEmail({ email, client: TEST_CLIENT, request: TEST_REQUEST }));
}

async function readUser(id) {
  const [user = null] = await testDb.readRows(USER_SQL, { id });

  return user;
}

function pickEmail(user) {
  return { email: user.email, email_verified_at: user.email_verified_at };
}

function readIdentitiesOf(userId) {
  return testDb.readRows(IDENTITIES_OF_USER_SQL, { userId });
}

function readIdentities(provider, subject) {
  return testDb.readRows(IDENTITIES_SQL, { provider, subject });
}

async function readEmailFlags(userId) {
  return (await readIdentitiesOf(userId)).map((identity) => [identity.email, identity.is_email_verified]);
}

function readSessions(userId) {
  return testDb.readRows(SESSIONS_SQL, { userId });
}

function readMemberships(userId) {
  return testDb.readRows(MEMBERSHIPS_SQL, { userId });
}

function block(id) {
  return testDb.readRows(STATUS_SQL, { id, status: USER_STATUS.BLOCKED });
}

async function countRows() {
  const [counts] = await testDb.readRows(COUNT_SQL);

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
  return auditRecordOf(AUDIT_ACTION.USER_IDENTITY_LINK, { entityId: userId, actorId: userId, meta: { provider, reason } });
}

function grantRecordOf(userId) {
  return auditRecordOf(AUDIT_ACTION.USER_GROUP_GRANT, { entityId: userId, actorId: null, meta: { group: GROUP_SLUG.ADMIN, groupId: adminGroupId } });
}

async function readGrants(userId) {
  return (await readAudit(testDb, userId)).filter((record) => record.action === AUDIT_ACTION.USER_GROUP_GRANT);
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

async function settle(promise) {
  const [outcome] = await Promise.allSettled([promise]);

  return outcome;
}

async function countTableWaits() {
  const [{ total }] = await testDb.readRows(TABLE_WAITS_SQL, { database: testDb.name, state: TABLE_WAIT_STATE });

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

// The sign-in by the email waits for the row of its owner, which the keeper holds and changes meanwhile.
async function signInAroundChange(t, keeper, { email, ownerId, change: [sql, values] }) {
  await keeper.holdRow(TABLE.USERS, ownerId);

  const running = signInByEmail(email);

  t.after(() => Promise.allSettled([running]));

  const sessionId = await Promise.race([findSessionId(testDb, LOCK_USERS_MARK), running]);

  assert.ok(Number.isInteger(sessionId), 'The sign-in has ended before it waited for the row of the owner');
  await keeper.query(sql, values);
  await keeper.query(COMMIT_SQL);

  return running;
}

describe('accounts', { skip: testRedis.skip || testDb.skip }, () => {
  before(async () => {
    await up();
    await up({ type: MIGRATION_TYPE.SEED });

    adminGroupId = await readAdminId(testDb);
    fastify = await testDb.buildApp({ env: ADMIN_ENV, db: SMALL_POOL, logger: { level: 'warn', stream: sink.stream } });
    await connectAppRedis(fastify);
  });

  after(() => fastify?.close());

  describe('signInWithProvider: a first sign-in', () => {
    test('makes a user with the first word of a name and the email the provider verified, its identity and a session', async () => {
      const profile = verifiedProfileOf(' Anna.K@Example.COM ', { firstName: 'Anna Maria', lastName: 'Kovalenko-Shevchenko' });
      const counted = await countRows();
      const issued = await signInByProvider(fastify, GOOGLE, profile);
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
        is_email_verified: true,
        profile: profile.claims,
        last_login_at: identity.last_login_at,
      });
      assert.deepEqual(await readSessions(issued.userId), [{ is_dev: false }]);
      assert.deepEqual([issued.scopes, readClaims(issued.accessToken).sub], [[], issued.userId]);
      await assertNoAdmin(issued.userId);
    });

    test('makes a user whose names are no names, with both NULL', async () => {
      const issued = await signInByProvider(fastify, GOOGLE, profileOf({ firstName: EMOJI, lastName: `${EMOJI} ${EMOJI}` }));

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
      const holder = await insertUser(testDb, { email: 'olha@example.com', emailVerifiedAt: nowUtc() });
      const issued = await signInByProvider(fastify, TELEGRAM, profileOf({ email: ' Olha@Example.COM ' }));
      const [identity] = await readIdentitiesOf(issued.userId);

      assert.notEqual(issued.userId, holder);
      assert.deepEqual(pickEmail(await readUser(issued.userId)), { email: null, email_verified_at: null });
      assert.equal(identity.email, 'olha@example.com');
      assert.deepEqual(await readIdentitiesOf(holder), []);
    });

    test('keeps the claims on the identity as JSON, a lone surrogate in them as U+FFFD', async () => {
      const issued = await signInByProvider(fastify, GOOGLE, profileOf({ claims: { name: `Anna ${LONE_SURROGATE}`, picture: null } }));
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

      await Promise.all(wrongProfiles.map((profile) => assertWritesNothing(() => signInByProvider(fastify, GOOGLE, profile), typeErrorOf(PROFILE_REFUSAL))));
      await assertWritesNothing(() => signInByProvider(fastify, GOOGLE, cyclic), TypeError);
      await assertWritesNothing(() => signInByProvider(fastify, UNKNOWN_PROVIDER, profileOf()), typeErrorOf(PROVIDER_REFUSAL));
      await assertWritesNothing(
        () => runInApp(fastify, () => signInWithProvider({ providerId: GOOGLE, profile: profileOf() })),
        typeErrorOf(CLIENT_REFUSAL),
      );
    });
  });

  describe('signInWithProvider: a sign-in of an identity it knows', () => {
    test('signs in to its user with a session more, updates the identity and fills only what is empty', async () => {
      const profile = profileOf({ firstName: 'Olha' });
      const first = await signInByProvider(fastify, GOOGLE, profile);
      const counted = await countRows();
      const second = await signInByProvider(fastify, GOOGLE, {
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
      const { userId: empty } = await signInByProvider(fastify, GOOGLE, emptyProfile);
      const owner = await insertUser(testDb, { email: 'own@example.com', emailVerifiedAt: nowUtc() });
      const ownSubject = await insertIdentity(testDb, { userId: owner, provider: GOOGLE });
      const ownBefore = await readUser(owner);

      await signInByProvider(fastify, GOOGLE, { ...emptyProfile, email: 'Filled@Example.com', isEmailVerified: true });
      await signInByProvider(fastify, GOOGLE, verifiedProfileOf('other@example.com', { subject: ownSubject }));

      const [identity] = await readIdentitiesOf(empty);

      assert.deepEqual(pickEmail(await readUser(empty)), { email: 'filled@example.com', email_verified_at: identity.last_login_at });
      assert.deepEqual(await readUser(owner), ownBefore);
    });

    test('writes on the identity whether its provider has verified the email, at the first sign-in and again at each later one: the flag follows the last sign-in, a verified email, one that is not and none at all', async () => {
      const verified = verifiedProfileOf('flag.verified@example.com');
      const unverified = profileOf({ email: 'flag.unverified@example.com' });
      const userIds = await mapSeries([[GOOGLE, verified], [TELEGRAM, unverified]], async ([providerId, profile]) => (await signInByProvider(fastify, providerId, profile)).userId);
      const first = await mapSeries(userIds, (userId) => readEmailFlags(userId));
      const later = await mapSeries([
        [GOOGLE, { ...verified, isEmailVerified: false }],
        [GOOGLE, { ...verified, email: null }],
        [GOOGLE, verified],
        [TELEGRAM, { ...unverified, isEmailVerified: true }],
      ], async ([providerId, profile]) => readEmailFlags((await signInByProvider(fastify, providerId, profile)).userId));

      assert.deepEqual(first, [[['flag.verified@example.com', true]], [['flag.unverified@example.com', false]]]);
      assert.deepEqual(later, [
        [['flag.verified@example.com', false]],
        [[null, false]],
        [['flag.verified@example.com', true]],
        [['flag.unverified@example.com', true]],
      ]);
    });

    test('marks verified the email the user holds unverified, once the provider has verified it too', async () => {
      const userId = await insertUser(testDb, { email: 'mark@example.com' });
      const subject = await insertIdentity(testDb, { userId, provider: GOOGLE });

      await signInByProvider(fastify, GOOGLE, profileOf({ subject, email: 'mark@example.com' }));

      assert.deepEqual(pickEmail(await readUser(userId)), { email: 'mark@example.com', email_verified_at: null });

      await signInByProvider(fastify, GOOGLE, verifiedProfileOf('Mark@Example.com', { subject }));

      const [identity] = await readIdentitiesOf(userId);

      assert.deepEqual(pickEmail(await readUser(userId)), { email: 'mark@example.com', email_verified_at: identity.last_login_at });
    });

    test('leaves the email empty when another user holds the address, and commits the rest of the sign-in', async () => {
      const watch = watchLog();
      const holder = await insertUser(testDb, { email: 'held@example.com' });
      const holderBefore = await readUser(holder);
      const profile = profileOf();
      const { userId } = await signInByProvider(fastify, TELEGRAM, profile);
      const counted = await countRows();
      const issued = await signInByProvider(fastify, TELEGRAM, {
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
      const { userId } = await signInByProvider(fastify, GOOGLE, profile);
      const identitiesBefore = await readIdentitiesOf(userId);

      await block(userId);
      await assertWritesNothing(() => signInByProvider(fastify, GOOGLE, { ...profile, email: 'blocked@example.com', firstName: 'Anna' }), FORBIDDEN);

      assert.deepEqual(await readIdentitiesOf(userId), identitiesBefore);
      assert.equal((await readUser(userId)).first_name, null);
      assert.equal((await readSessions(userId)).length, 1);
    });
  });

  describe('signInWithProvider: an email another user holds', () => {
    test('is merged into when both sides have verified it: an identity more, a record of the link, the empty fields filled', async () => {
      const first = await signInByProvider(fastify, GOOGLE, verifiedProfileOf('merge@example.com', { lastName: 'Kovalenko' }));
      const counted = await countRows();
      const issued = await signInByProvider(fastify, TELEGRAM, verifiedProfileOf('Merge@Example.com', { firstName: 'Anna', lastName: 'Other' }));
      const merged = await readUser(first.userId);

      assert.equal(issued.userId, first.userId);
      assert.deepEqual(countAdded(counted, await countRows()), addedOf({ identities: 1, audits: 1, sessions: 1 }));
      assert.deepEqual((await readIdentitiesOf(first.userId)).map((identity) => identity.provider), [GOOGLE, TELEGRAM]);
      assert.deepEqual(await readAudit(testDb, first.userId), [linkRecordOf(first.userId, TELEGRAM, IDENTITY_LINK_REASON.EMAIL)]);
      assert.deepEqual([merged.first_name, merged.last_name], ['Anna', 'Kovalenko']);
    });

    test('refuses with CONTACT_TAKEN and writes nothing when that user holds it unverified', async () => {
      const holder = await insertUser(testDb, { email: 'pending@example.com' });

      await assertWritesNothing(() => signInByProvider(fastify, GOOGLE, verifiedProfileOf('Pending@Example.com')), CONTACT_TAKEN);

      assert.deepEqual(pickEmail(await readUser(holder)), { email: 'pending@example.com', email_verified_at: null });
    });

    test('refuses with AUTHORIZATION_ERROR and writes nothing when that user is blocked', async () => {
      await insertUser(testDb, { email: 'blocked.holder@example.com', emailVerifiedAt: nowUtc(), status: USER_STATUS.BLOCKED });

      await assertWritesNothing(() => signInByProvider(fastify, TELEGRAM, verifiedProfileOf('blocked.holder@example.com')), FORBIDDEN);
    });
  });

  describe('the bootstrap of an admin', () => {
    test('grants a verified email of APP_ADMIN_EMAILS the admin group at a first sign-in, with one record, and not again', async () => {
      const profile = verifiedProfileOf(ADMIN.FIRST);
      const first = await signInByProvider(fastify, GOOGLE, profile);
      const second = await signInByProvider(fastify, GOOGLE, profile);

      await assertAdmin(first.userId, [first, second]);
    });

    test('grants it at the sign-in of a known identity that brings the email', async () => {
      const profile = profileOf();
      const first = await signInByProvider(fastify, GOOGLE, profile);

      await assertNoAdmin(first.userId);

      const second = await signInByProvider(fastify, GOOGLE, { ...profile, email: ADMIN.KNOWN, isEmailVerified: true });

      await assertAdmin(first.userId, [second]);
    });

    test('grants it at a merge by the email into a user whose identity has the provider confirm it', async () => {
      const userId = await insertUser(testDb, { email: ADMIN.MERGED, emailVerifiedAt: nowUtc() });

      await insertIdentity(testDb, {
        userId,
        provider: GOOGLE,
        email: ADMIN.MERGED,
        isEmailVerified: true,
      });

      const issued = await signInByProvider(fastify, TELEGRAM, verifiedProfileOf(ADMIN.MERGED));

      await assertAdmin(userId, [issued]);
    });

    // A manager confirms the address they set; listed later, it would hand full access to the account they set it on.
    test('grants nothing to a listed address that no provider has confirmed on an identity of the user, and refuses a merge into it with CONTACT_TAKEN that writes nothing', async () => {
      const profile = profileOf({ email: 'planter@example.com', isEmailVerified: true });
      const planted = await signInByProvider(fastify, GOOGLE, profile);

      await testDb.readRows(PLANT_SQL, { id: planted.userId, email: ADMIN.PLANTED, emailVerifiedAt: nowUtc() });

      const own = await signInByProvider(fastify, GOOGLE, profile);

      assert.equal(own.userId, planted.userId);
      await assertNoAdmin(planted.userId);
      await assertWritesNothing(() => signInByProvider(fastify, TELEGRAM, verifiedProfileOf(ADMIN.PLANTED)), CONTACT_TAKEN);
      await assertNoAdmin(planted.userId);
    });

    test('grants it once a provider of the user confirms the listed address on their row: the own identity that brings it', async () => {
      const profile = profileOf({ email: 'vouched.before@example.com', isEmailVerified: true });
      const first = await signInByProvider(fastify, GOOGLE, profile);

      await testDb.readRows(PLANT_SQL, { id: first.userId, email: ADMIN.VOUCHED, emailVerifiedAt: nowUtc() });
      await assertNoAdmin(first.userId);

      const confirmed = await signInByProvider(fastify, GOOGLE, { ...profile, email: ADMIN.VOUCHED });

      await assertAdmin(first.userId, [confirmed]);
    });

    test('grants it at a link that brings the email, and the next sign-in has full access', async () => {
      const userId = await insertUser(testDb);
      const profile = verifiedProfileOf(ADMIN.LINKED);

      await link(userId, GOOGLE, profile);
      await assertAdmin(userId);

      const issued = await signInByProvider(fastify, GOOGLE, profile);

      await assertAdmin(userId, [issued]);
    });

    test('grants it at the sign-in by the email', async () => {
      const first = await signInByEmail(ADMIN.DEV.toUpperCase());
      const second = await signInByEmail(ADMIN.DEV);

      await assertAdmin(first.userId, [first, second]);
    });

    test('grants nothing again to a listed user who is in the admin group already: no second row, no record, the granted_by of the row it has, and a token of full access', async () => {
      const granterId = await insertUser(testDb);
      const userId = await insertUser(testDb, { email: ADMIN.MEMBER, emailVerifiedAt: nowUtc() });

      await joinGroup(testDb, { userId, groupId: adminGroupId, grantedBy: granterId });

      const counted = await countRows();
      const issued = await signInByEmail(ADMIN.MEMBER);

      assert.deepEqual(countAdded(counted, await countRows()), addedOf({ sessions: 1 }));
      assert.deepEqual(await readMemberships(userId), [{ slug: GROUP_SLUG.ADMIN, granted_by: granterId }]);
      assert.deepEqual(await readGrants(userId), []);
      assert.deepEqual([issued.userId, issued.scopes, readClaims(issued.accessToken).scopes], [userId, [SCOPE_ALL], [SCOPE_ALL]]);
    });

    test('grants it to a listed user while another user is a member of the group: the row of someone else is no row of this user', async () => {
      const otherId = await insertUser(testDb);

      await joinGroup(testDb, { userId: otherId, groupId: adminGroupId });

      const issued = await signInByProvider(fastify, GOOGLE, verifiedProfileOf(ADMIN.BESIDE));

      await assertAdmin(issued.userId, [issued]);
    });

    // A read of a table whose version is not there yet caches nothing: the bump starts the version first. The row behind
    // the back is written by a statement that moves no version, and the cached read does not learn of it.
    test('moves the version of user_groups with the grant: a cached read of the members of the admin group, which a write behind its back does not reach, shows the new admin at once', async () => {
      const behindId = await insertUser(testDb);

      await runInApp(fastify, () => invalidateCacheTables([TABLE.USER_GROUPS]));

      const cached = await readCachedMemberIds(fastify, adminGroupId);

      await joinGroup(testDb, { userId: behindId, groupId: adminGroupId });

      const stale = await readCachedMemberIds(fastify, adminGroupId);
      const issued = await signInByProvider(fastify, GOOGLE, verifiedProfileOf(ADMIN.CACHED));

      assert.deepEqual(stale, cached);
      assert.deepEqual(await readCachedMemberIds(fastify, adminGroupId), [...cached, behindId, issued.userId].toSorted());
      await assertAdmin(issued.userId, [issued]);
    });

    test('grants nothing for an email of the list the provider has not verified', async () => {
      const issued = await signInByProvider(fastify, GOOGLE, profileOf({ email: ADMIN.UNVERIFIED }));

      await assertNoAdmin(issued.userId);
      assert.deepEqual(issued.scopes, []);
    });

    test('warns and grants nothing when there is no admin group, and the sign-in goes on', async (t) => {
      const watch = watchLog();

      await testDb.readRows(RENAME_GROUP_SQL, { from: GROUP_SLUG.ADMIN, to: AWAY_SLUG });
      t.after(() => testDb.readRows(RENAME_GROUP_SQL, { from: AWAY_SLUG, to: GROUP_SLUG.ADMIN }));

      const issued = await signInByProvider(fastify, GOOGLE, verifiedProfileOf(ADMIN.AWAY));

      await assertNoAdmin(issued.userId);
      assert.deepEqual(issued.scopes, []);
      assert.deepEqual(watch(NO_ADMIN_GROUP_MESSAGE).map((line) => line.userId), [issued.userId]);
      assert.deepEqual(await readSessions(issued.userId), [{ is_dev: false }]);
    });
  });

  describe('isAdminCandidate', () => {
    test('refuses with a TypeError what is no row of a user { id, email }, before any statement: outside any context as in the app', async () => {
      const id = uuidv7();
      const wrongUsers = [
        undefined,
        null,
        id,
        [{ id, email: null }],
        {},
        { id },
        { email: null },
        { id: 'user-1', email: null },
        { id: id.toUpperCase(), email: null },
        { id, email: '' },
        { id, email: 42 },
      ];

      await Promise.all(wrongUsers.map((user) => assert.rejects(isAdminCandidate(user), typeErrorOf(CANDIDATE_REFUSAL), inspect(user))));
      await Promise.all(wrongUsers.map((user) => assert.rejects(runInApp(fastify, () => isAdminCandidate(user)), typeErrorOf(CANDIDATE_REFUSAL), inspect(user))));
    });

    test('says true for a row that holds an address of APP_ADMIN_EMAILS, verified or not, and false for one that holds another whatever the identities of its user hold: by the row alone, with no statement', async (t) => {
      const down = await createDownDb(t, { env: ADMIN_ENV });
      const unlisted = 'unlisted.row@example.com';
      const userId = await insertUser(testDb, { email: unlisted });

      await insertIdentity(testDb, {
        userId,
        provider: GOOGLE,
        email: ADMIN.BEHIND,
        isEmailVerified: true,
      });

      const rows = [
        { id: uuidv7(), email: ADMIN.CANDIDATE, emailVerifiedAt: nowUtc() },
        { id: uuidv7(), email: ADMIN.CANDIDATE, emailVerifiedAt: null },
        { id: userId, email: unlisted, emailVerifiedAt: null },
      ];
      const verdicts = await mapSeries([(fn) => runInApp(fastify, fn), down.run], (runIn) => mapSeries(rows, (row) => runIn(() => isAdminCandidate(row))));

      assert.deepEqual(verdicts, [[true, true, false], [true, true, false]]);
    });

    test('says for a row that holds no address whether an identity of its user holds one of APP_ADMIN_EMAILS that its provider has confirmed: true for a listed one beside another, false for unlisted ones, for none and for one that another user holds', async () => {
      const [candidateId, plainId, bareId] = await mapSeries(['candidate', 'plain', 'bare'], () => insertUser(testDb));

      await mapSeries([
        [candidateId, GOOGLE, 'own.other@example.com'],
        [candidateId, TELEGRAM, ADMIN.IDENTITY],
        [plainId, GOOGLE, 'unlisted.identity@example.com'],
      ], ([userId, provider, email]) => insertIdentity(testDb, {
        userId,
        provider,
        email,
        isEmailVerified: true,
      }));
      await insertIdentity(testDb, { userId: plainId, provider: TELEGRAM });

      const verdicts = await mapSeries([candidateId, plainId, bareId, uuidv7()], (id) => runInApp(fastify, () => isAdminCandidate({ id, email: null })));

      assert.deepEqual(verdicts, [true, false, false, false]);
    });

    test('takes a listed address of an identity only once its provider has confirmed it: false for one it has not, also for the user of a sign-in that brought one, and true for the same address confirmed', async () => {
      const [unconfirmedId, confirmedId] = await mapSeries(['unconfirmed', 'confirmed'], () => insertUser(testDb));

      await mapSeries([[unconfirmedId, false], [confirmedId, true]], ([userId, isEmailVerified]) => insertIdentity(testDb, {
        userId,
        provider: GOOGLE,
        email: ADMIN.UNCONFIRMED,
        isEmailVerified,
      }));

      const { userId: claimedId } = await signInByProvider(fastify, TELEGRAM, profileOf({ email: ADMIN.CLAIMED }));
      const verdicts = await mapSeries([unconfirmedId, claimedId, confirmedId], (id) => runInApp(fastify, () => isAdminCandidate({ id, email: null })));

      assert.deepEqual(pickEmail(await readUser(claimedId)), { email: null, email_verified_at: null });
      assert.deepEqual(await readEmailFlags(claimedId), [[ADMIN.CLAIMED, false]]);
      assert.deepEqual(verdicts, [false, false, true]);
    });

    test('says false with no statement for a row that holds no address while APP_ADMIN_EMAILS is empty, where a list makes it read the identities', async (t) => {
      const [unlisted, listed] = await mapSeries([{}, { env: ADMIN_ENV }], (sections) => createDownDb(t, sections));
      const user = { id: uuidv7(), email: null };
      const reached = await rejectionOf(listed.run(() => isAdminCandidate(user)));

      assert.equal(await unlisted.run(() => isAdminCandidate(user)), false);
      assert.equal(reached.code, REFUSED_CONNECTION_CODE, inspect(reached));
    });
  });

  describe('linkProvider', () => {
    test('links a new identity to the user with a record of the link, and fills what is empty', async () => {
      const userId = await insertUser(testDb, { lastName: 'Kovalenko' });
      const profile = profileOf({ firstName: 'Anna Maria', lastName: 'Other' });
      const linked = await link(userId, GOOGLE, profile);
      const issued = await signInByProvider(fastify, GOOGLE, profile);

      assert.deepEqual([linked.id, linked.firstName, linked.lastName], [userId, 'Anna', 'Kovalenko']);
      assert.equal((await readUser(userId)).first_name, 'Anna');
      assert.deepEqual((await readIdentitiesOf(userId)).map((identity) => identity.provider_user_id), [profile.subject]);
      assert.deepEqual(await readAudit(testDb, userId), [linkRecordOf(userId, GOOGLE, IDENTITY_LINK_REASON.LINK)]);
      assert.equal(issued.userId, userId);
    });

    test('links more identities of one provider to one user, and updates one it has without a record', async () => {
      const userId = await insertUser(testDb);
      const [first, second] = [profileOf(), profileOf()];

      await link(userId, GOOGLE, first);
      await link(userId, GOOGLE, second);

      const counted = await countRows();

      await link(userId, GOOGLE, { ...first, email: 'again@example.com' });

      const identities = await readIdentitiesOf(userId);

      assert.deepEqual(countAdded(counted, await countRows()), NOTHING_ADDED);
      assert.deepEqual(identities.map((identity) => [identity.provider, identity.provider_user_id]), [[GOOGLE, first.subject], [GOOGLE, second.subject]]);
      assert.equal(identities[0].email, 'again@example.com');
      assert.equal((await readAudit(testDb, userId)).length, 2);
    });

    test('writes on the identity whether its provider has verified the email, at the link of a new identity and again at a link of one the user has: the flag follows the last link', async () => {
      const userId = await insertUser(testDb);
      const verified = verifiedProfileOf('link.verified@example.com');
      const unverified = profileOf({ email: 'link.unverified@example.com' });

      await link(userId, GOOGLE, verified);
      await link(userId, TELEGRAM, unverified);

      const linked = await readEmailFlags(userId);

      await link(userId, GOOGLE, { ...verified, isEmailVerified: false });
      await link(userId, TELEGRAM, { ...unverified, isEmailVerified: true });

      assert.deepEqual(linked, [['link.verified@example.com', true], ['link.unverified@example.com', false]]);
      assert.deepEqual(await readEmailFlags(userId), [['link.verified@example.com', false], ['link.unverified@example.com', true]]);
    });

    test('refuses an identity of another user with IDENTITY_TAKEN, and writes nothing', async () => {
      const [owner, other] = await Promise.all([insertUser(testDb), insertUser(testDb)]);
      const profile = profileOf({ firstName: 'Anna' });

      await link(owner, TELEGRAM, profile);
      await assertWritesNothing(() => link(other, TELEGRAM, profile), IDENTITY_TAKEN);

      assert.equal((await readUser(other)).first_name, null);
    });

    test('refuses a user that is not there with AUTHENTICATION_ERROR, and a blocked one with AUTHORIZATION_ERROR', async () => {
      const blocked = await insertUser(testDb, { status: USER_STATUS.BLOCKED });

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
      const holder = await insertUser(testDb, { email: 'held.dev@example.com' });
      const issued = await signInByEmail('Held.Dev@Example.com');

      await insertUser(testDb, { email: 'blocked.dev@example.com', emailVerifiedAt: nowUtc(), status: USER_STATUS.BLOCKED });

      assert.equal(issued.userId, holder);
      assert.deepEqual(pickEmail(await readUser(holder)), { email: 'held.dev@example.com', email_verified_at: null });
      await assertWritesNothing(() => signInByEmail('blocked.dev@example.com'), FORBIDDEN);
    });

    test('finds the owner of the email by a plain read and locks them by their key: an owner whose email changes meanwhile is none, the sign-in makes a new user with the email, and the owner keeps the other one and signs in by it', async (t) => {
      const watch = watchLog();
      const keeper = await testDb.openKeeper(t);
      const [searched, moved] = ['searched.owner@example.com', 'moved.owner@example.com'];
      const ownerId = await insertUser(testDb, { email: searched, emailVerifiedAt: nowUtc() });
      const issued = await signInAroundChange(t, keeper, { email: searched, ownerId, change: [MOVE_EMAIL_SQL, [moved, ownerId]] });
      const counted = await countRows();
      const again = await signInByEmail(moved);

      assert.notEqual(issued.userId, ownerId);
      assert.deepEqual(await testDb.readRows(USERS_OF_EMAIL_SQL, { email: searched }), [{ id: issued.userId }]);
      assert.ok((await readUser(issued.userId)).email_verified_at instanceof Date);
      assert.equal((await readUser(ownerId)).email, moved);
      assert.equal(again.userId, ownerId);
      assert.deepEqual(countAdded(counted, await countRows()), addedOf({ sessions: 1 }));
      assert.deepEqual([watch(RACE_MESSAGE), watch(RETRY_MESSAGE)], [[], []]);
    });

    test('takes an owner deleted meanwhile for none: the sign-in that waits for their row makes a new user with the email, and its locks cross none of the deletion', async (t) => {
      const watch = watchLog();
      const keeper = await testDb.openKeeper(t);
      const email = 'deleted.owner@example.com';
      const ownerId = await insertUser(testDb, { email, emailVerifiedAt: nowUtc() });
      const issued = await signInAroundChange(t, keeper, { email, ownerId, change: [DELETE_USER_SQL, [ownerId]] });

      assert.notEqual(issued.userId, ownerId);
      assert.equal(await readUser(ownerId), null);
      assert.deepEqual(await testDb.readRows(USERS_OF_EMAIL_SQL, { email }), [{ id: issued.userId }]);
      assert.deepEqual([watch(RACE_MESSAGE), watch(RETRY_MESSAGE)], [[], []]);
    });
  });

  describe('sign-ins side by side', () => {
    test('two first sign-ins of one identity make one user and one identity, and a session each', async (t) => {
      const watch = watchLog();
      const profile = profileOf({ firstName: 'Anna' });
      const counted = await countRows();
      const outcomes = await runSideBySide(t, TABLE.USER_IDENTITIES, [() => signInByProvider(fastify, GOOGLE, profile), () => signInByProvider(fastify, GOOGLE, profile)]);
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
        () => signInByProvider(fastify, GOOGLE, verifiedProfileOf(email)),
        () => signInByProvider(fastify, TELEGRAM, verifiedProfileOf(email)),
      ]);
      const [owner, ...others] = await testDb.readRows(USERS_OF_EMAIL_SQL, { email });

      assert.deepEqual(readStatuses(outcomes), [FULFILLED, FULFILLED]);
      assert.deepEqual(others, []);
      assert.deepEqual(readUserIds(outcomes), [owner.id]);
      assert.deepEqual((await readIdentitiesOf(owner.id)).map((identity) => identity.provider).toSorted(), [GOOGLE, TELEGRAM]);
      assert.equal((await readAudit(testDb, owner.id)).filter((record) => record.meta.reason === IDENTITY_LINK_REASON.EMAIL).length, 1);
    });

    test('two sign-ins of one listed user at once grant the admin group once: one row, one record, and full access for both', async (t) => {
      const userId = await insertUser(testDb, { email: ADMIN.TWICE, emailVerifiedAt: nowUtc() });
      const outcomes = await runSideBySide(t, TABLE.USERS, [() => signInByEmail(ADMIN.TWICE), () => signInByEmail(ADMIN.TWICE)]);

      assert.deepEqual(readStatuses(outcomes), [FULFILLED, FULFILLED]);
      await assertAdmin(userId, outcomes.map((outcome) => outcome.value));
    });

    test('two links of one account of a provider to two users: one is linked, the other gets IDENTITY_TAKEN', async (t) => {
      const watch = watchLog();
      const users = await Promise.all([insertUser(testDb), insertUser(testDb)]);
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
