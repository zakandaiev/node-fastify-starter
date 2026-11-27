import { settleAlerts } from '#core/alert/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { COOKIE } from '#enums/cookie.js';
import { GROUP_SLUG } from '#enums/group.js';
import { HEADER } from '#enums/header.js';
import { IDENTITY_LINK_REASON } from '#enums/identity-link-reason.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import {
  accept,
  createAlertReceiver,
  readBlock,
  readTitles,
} from '#root/tests/helper/alert.js';
import { successBody } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createTestDb, SMALL_POOL } from '#root/tests/helper/db.js';
import { findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createMockProvider, REFUSAL_DESCRIPTION, signInThroughProvider } from '#root/tests/helper/oauth.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  connectAppRedis,
  openLoggedApp,
  readAuthCookies,
  readClaims,
  signIn,
} from '#root/tests/helper/session.js';
import { nowUtc } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const ME_URL = '/api/v1/auth/me';
const PROVIDER_ID = 'mock';

// APP_HOST of the tests is "app.test" over https.
const APP_URL = 'https://app.test';

const USER_AGENT = 'oauth-route-test-agent';
const LOOPBACK = '127.0.0.1';
const NO_STORE = 'no-store';
const EMOJI = String.fromCodePoint(0x1F600);

// An address of its own for each test: the rows of the file stay for the tests after it.
const ADMIN_EMAIL = 'first.route@admin.test';
const ADMIN_ENV = Object.freeze({ APP_ADMIN_EMAILS: ADMIN_EMAIL });

const UPSTREAM_TITLE = 'Upstream service failed';
const REQUEST_FAILED_MESSAGE = 'Request failed';

const AUTH_NAMES = Object.freeze([COOKIE.ACCESS_TOKEN, COOKIE.HAS_ACCESS, COOKIE.HAS_SESSION, COOKIE.REFRESH_TOKEN]);
const FLOW_NAMES = Object.freeze([COOKIE.OAUTH_STATE, COOKIE.OAUTH_REDIRECT]);

const USER_SQL = 'SELECT id, email, email_verified_at, first_name, last_name, status FROM users WHERE id = :id';
const INSERT_USER_SQL = `
  INSERT INTO users (id, email, email_verified_at, first_name, last_name, status)
  VALUES (:id, :email, :emailVerifiedAt, :firstName, :lastName, :status)
`;
const IDENTITY_COLUMNS = 'user_id, provider, provider_user_id, email';
const IDENTITIES_OF_USER_SQL = `SELECT ${IDENTITY_COLUMNS} FROM user_identities WHERE user_id = :userId ORDER BY created_at, id`;
const IDENTITIES_SQL = `SELECT ${IDENTITY_COLUMNS} FROM user_identities WHERE provider = :provider AND provider_user_id = :subject`;
const INSERT_IDENTITY_SQL = 'INSERT INTO user_identities (user_id, provider, provider_user_id) VALUES (:userId, :provider, :subject)';
const SESSIONS_SQL = 'SELECT id, user_agent, ip, is_dev FROM sessions WHERE user_id = :userId ORDER BY id';
const AUDIT_SQL = 'SELECT actor_id, action, entity_type, entity_id, meta FROM audit_logs WHERE entity_id = :userId ORDER BY created_at, id';
const MEMBERSHIPS_SQL = 'SELECT g.slug FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE ug.user_id = :userId';
const SLUG_SQL = 'SELECT id FROM groups WHERE slug = :slug';
const COUNT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM user_identities) AS identities,
    (SELECT COUNT(*) FROM user_groups) AS memberships,
    (SELECT COUNT(*) FROM audit_logs) AS audits,
    (SELECT COUNT(*) FROM sessions) AS sessions
`;

// The providers of the repository, without credentials here: the mock is a third record beside them.
const { providers: REPOSITORY_PROVIDERS } = createTestConfig().oauth;

// The tables belong to the file, not to its first suite: a test that is run alone by its name needs them too.
if (!testDb.skip) {
  before(async () => {
    await up();
    await up({ type: MIGRATION_TYPE.SEED });
  });
}

// "fields" change the record of the config, not the one the mock checks against: a wrong secret is its own refusal.
async function openApp(t, { receiver, fields = {} } = {}) {
  const mock = await createMockProvider(t);
  const { fastify, sink } = await openLoggedApp(t, testDb, {
    receiver,
    env: ADMIN_ENV,
    db: SMALL_POOL,
    oauth: { providers: [...REPOSITORY_PROVIDERS, { ...mock.record, ...fields }] },
  });

  await connectAppRedis(fastify);

  return { fastify, sink, mock };
}

function readRows(sql, binding) {
  return testDb.readRows(sql, binding);
}

async function readUser(id) {
  const [user = null] = await readRows(USER_SQL, { id });

  return user;
}

async function insertUser({ email = null, isVerified = false, status = USER_STATUS.ACTIVE } = {}) {
  const id = uuidv7();

  await readRows(INSERT_USER_SQL, {
    id,
    email,
    emailVerifiedAt: isVerified
      ? nowUtc()
      : null,
    firstName: null,
    lastName: null,
    status,
  });

  return id;
}

function insertIdentity(userId, subject) {
  return readRows(INSERT_IDENTITY_SQL, { userId, provider: PROVIDER_ID, subject });
}

function readIdentitiesOf(userId) {
  return readRows(IDENTITIES_OF_USER_SQL, { userId });
}

function readIdentities(subject) {
  return readRows(IDENTITIES_SQL, { provider: PROVIDER_ID, subject });
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

async function countRows() {
  const [counts] = await readRows(COUNT_SQL);

  return counts;
}

function describeRedirect(response) {
  return {
    statusCode: response.statusCode,
    location: response.headers[HEADER.LOCATION],
    cacheControl: response.headers[HEADER.CACHE_CONTROL],
    body: response.payload,
  };
}

function redirectTo(location) {
  return {
    statusCode: 302,
    location,
    cacheControl: NO_STORE,
    body: '',
  };
}

function failureOf(code) {
  return `${APP_URL}/auth/login?authError=${code}`;
}

// Each cookie an answer sets or clears, by name: a value, or null for one it clears.
function readCookieValues(response) {
  return Object.fromEntries(response.cookies
    .map((cookie) => [cookie.name, cookie.maxAge === 0 ? null : cookie.value])
    .toSorted(([left], [right]) => left.localeCompare(right)));
}

function clearedFlowOnly() {
  return { [COOKIE.OAUTH_REDIRECT]: null, [COOKIE.OAUTH_STATE]: null };
}

function readSignedIn(response) {
  const { sub, sid } = readClaims(readAuthCookies(response)[COOKIE.ACCESS_TOKEN].value);

  return { userId: sub, sid };
}

function getMe(fastify, response) {
  return fastify.inject({ url: ME_URL, cookies: { [COOKIE.ACCESS_TOKEN]: readAuthCookies(response)[COOKIE.ACCESS_TOKEN].value } });
}

function linkRecordOf(userId, reason) {
  return {
    actor_id: userId,
    action: AUDIT_ACTION.USER_IDENTITY_LINK,
    entity_type: TABLE.USERS,
    entity_id: userId,
    meta: { provider: PROVIDER_ID, reason },
  };
}

// A link of the browser signed in by "session", which rides along with both requests unless the callback names its own.
function linkThrough(fastify, mock, session, { claims, callbackSession = session } = {}) {
  return signInThroughProvider(fastify, mock, {
    claims,
    link: true,
    redirect: '/settings',
    cookies: session.accessCookie,
    callbackCookies: callbackSession.accessCookie,
  });
}

describe('sign-in through a provider over HTTP', { skip: testRedis.skip || testDb.skip }, () => {
  test('a full sign-in: the callback makes the user of the first word of a name and the verified email, its identity and a session, sets the cookies of the session, clears those of the flow, ends on the target, and the cookies sign the browser in', async (t) => {
    const { fastify, mock } = await openApp(t);
    const subject = uuidv7();
    const walk = await signInThroughProvider(fastify, mock, {
      claims: {
        sub: subject,
        email: ' Anna.K@Example.COM ',
        email_verified: true,
        given_name: 'Anna Maria',
        family_name: 'Kovalenko',
      },
      redirect: '/profile?tab=accounts',
      headers: { [HEADER.USER_AGENT]: USER_AGENT },
    });
    const { userId, sid } = readSignedIn(walk.callback);
    const user = await readUser(userId);
    const me = await getMe(fastify, walk.callback);

    assert.deepEqual(describeRedirect(walk.callback), redirectTo(`${APP_URL}/profile?tab=accounts`));
    assert.deepEqual(Object.keys(readCookieValues(walk.callback)), [...AUTH_NAMES, ...FLOW_NAMES].toSorted());
    assert.deepEqual(pick(readCookieValues(walk.callback), FLOW_NAMES), clearedFlowOnly());
    assert.deepEqual(user, {
      id: userId,
      email: 'anna.k@example.com',
      email_verified_at: user.email_verified_at,
      first_name: 'Anna',
      last_name: 'Kovalenko',
      status: USER_STATUS.ACTIVE,
    });
    assert.ok(user.email_verified_at instanceof Date);
    assert.deepEqual(await readIdentitiesOf(userId), [{
      user_id: userId,
      provider: PROVIDER_ID,
      provider_user_id: subject,
      email: 'anna.k@example.com',
    }]);
    assert.deepEqual(await readSessions(userId), [{
      id: sid,
      user_agent: USER_AGENT,
      ip: LOOPBACK,
      is_dev: false,
    }]);
    assert.deepEqual(me.json(), successBody(me, { id: userId, scopes: [] }));
    assert.equal(mock.requests.length, 1);
  });

  test('a name of no letters is NULL, and the user is made all the same', async (t) => {
    const { fastify, mock } = await openApp(t);
    const walk = await signInThroughProvider(fastify, mock, {
      claims: { given_name: EMOJI, name: EMOJI, family_name: `${EMOJI} ${EMOJI}` },
    });
    const { userId } = readSignedIn(walk.callback);

    assert.deepEqual(describeRedirect(walk.callback), redirectTo(`${APP_URL}/`));
    assert.deepEqual(pick(await readUser(userId), ['first_name', 'last_name', 'email', 'status']), {
      first_name: null,
      last_name: null,
      email: null,
      status: USER_STATUS.ACTIVE,
    });
    assert.equal((await readSessions(userId)).length, 1);
  });

  test('a callback whose state is not that of its cookie writes nothing and calls no token endpoint', async (t) => {
    const { fastify, mock } = await openApp(t);
    const counted = await countRows();
    const walk = await signInThroughProvider(fastify, mock, { callbackQuery: { state: 'forged-state' } });

    assert.deepEqual(describeRedirect(walk.callback), redirectTo(failureOf('AUTHENTICATION_ERROR')));
    assert.deepEqual(readCookieValues(walk.callback), clearedFlowOnly());
    assert.deepEqual(await countRows(), counted);
    assert.deepEqual(mock.requests, []);
  });

  test('a verified email that an account holds unverified is refused with CONTACT_TAKEN on the sign-in page, and nothing is written', async (t) => {
    const { fastify, mock } = await openApp(t);
    const holder = await insertUser({ email: 'held.route@example.com' });
    const counted = await countRows();
    const walk = await signInThroughProvider(fastify, mock, {
      claims: { email: 'Held.Route@Example.com', email_verified: true, given_name: 'Olha' },
    });

    assert.deepEqual(describeRedirect(walk.callback), redirectTo(failureOf('CONTACT_TAKEN')));
    assert.deepEqual(readCookieValues(walk.callback), clearedFlowOnly());
    assert.deepEqual(await countRows(), counted);
    assert.deepEqual(pick(await readUser(holder), ['email', 'email_verified_at', 'first_name']), {
      email: 'held.route@example.com',
      email_verified_at: null,
      first_name: null,
    });
  });

  test('merges by an email both sides have verified: the identity joins that account, with a record of the audit, and the session is of that account', async (t) => {
    const { fastify, mock } = await openApp(t);
    const owner = await insertUser({ email: 'merged.route@example.com', isVerified: true });
    const subject = uuidv7();
    const walk = await signInThroughProvider(fastify, mock, {
      claims: { sub: subject, email: 'Merged.Route@Example.com', email_verified: true },
    });

    assert.deepEqual(describeRedirect(walk.callback), redirectTo(`${APP_URL}/`));
    assert.equal(readSignedIn(walk.callback).userId, owner);
    assert.deepEqual((await readIdentitiesOf(owner)).map((identity) => identity.provider_user_id), [subject]);
    assert.deepEqual(await readAudits(owner), [linkRecordOf(owner, IDENTITY_LINK_REASON.EMAIL)]);
  });

  test('a second sign-in of the identity is of the same user, and fills only the fields that are empty', async (t) => {
    const { fastify, mock } = await openApp(t);
    const subject = uuidv7();
    const first = await signInThroughProvider(fastify, mock, { claims: { sub: subject, given_name: 'Anna' } });
    const second = await signInThroughProvider(fastify, mock, {
      claims: { sub: subject, given_name: 'Olena', family_name: 'Kovalenko' },
    });
    const { userId } = readSignedIn(first.callback);

    assert.equal(readSignedIn(second.callback).userId, userId);
    assert.deepEqual(pick(await readUser(userId), ['first_name', 'last_name']), { first_name: 'Anna', last_name: 'Kovalenko' });
    assert.equal((await readSessions(userId)).length, 2);
    assert.equal((await readIdentitiesOf(userId)).length, 1);
  });

  test('a verified email of APP_ADMIN_EMAILS joins the group admin with a record of the audit that names the group by its slug and its id, and its token carries full access', async (t) => {
    const { fastify, mock } = await openApp(t);
    const walk = await signInThroughProvider(fastify, mock, { claims: { email: ADMIN_EMAIL, email_verified: true } });
    const { userId } = readSignedIn(walk.callback);
    const me = await getMe(fastify, walk.callback);
    const [{ id: groupId }] = await readRows(SLUG_SQL, { slug: GROUP_SLUG.ADMIN });

    assert.deepEqual(await readMemberships(userId), [{ slug: GROUP_SLUG.ADMIN }]);
    assert.deepEqual(await readAudits(userId), [{
      actor_id: null,
      action: AUDIT_ACTION.USER_GROUP_GRANT,
      entity_type: TABLE.USERS,
      entity_id: userId,
      meta: { group: GROUP_SLUG.ADMIN, groupId },
    }]);
    assert.deepEqual(me.json(), successBody(me, { id: userId, scopes: [SCOPE_ALL] }));
  });

  test('a blocked user is refused with AUTHORIZATION_ERROR on the sign-in page and gets no session', async (t) => {
    const { fastify, mock } = await openApp(t);
    const userId = await insertUser({ status: USER_STATUS.BLOCKED });
    const subject = uuidv7();

    await insertIdentity(userId, subject);

    const walk = await signInThroughProvider(fastify, mock, { claims: { sub: subject } });

    assert.deepEqual(describeRedirect(walk.callback), redirectTo(failureOf('AUTHORIZATION_ERROR')));
    assert.deepEqual(readCookieValues(walk.callback), clearedFlowOnly());
    assert.deepEqual(await readSessions(userId), []);
  });

  test('a target off the site or inside the pages of signing in ends the sign-in on the success path', async (t) => {
    const { fastify, mock } = await openApp(t);
    const walks = await Promise.all(['/.//evil.com', '/auth/logout'].map((redirect) => signInThroughProvider(fastify, mock, { redirect })));

    assert.deepEqual(walks.map(({ callback }) => describeRedirect(callback)), walks.map(() => redirectTo(`${APP_URL}/`)));
    assert.deepEqual(walks.map(({ callback }) => Object.keys(readCookieValues(callback))), walks.map(() => [...AUTH_NAMES, ...FLOW_NAMES].toSorted()));
  });
});

describe('a failure of the token endpoint over HTTP', { skip: testRedis.skip || testDb.skip }, () => {
  test('invalid_grant ends on the sign-in page with AUTHENTICATION_ERROR and no alert, invalid_client with UPSTREAM_ERROR and one alert; both clear the flow cookies, and neither the code, the secret nor the words of the provider reach a log line or the alert', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const spent = await openApp(t, { receiver });
    const refused = await openApp(t, { receiver, fields: { clientSecret: 'not-the-secret-of-the-mock' } });
    const counted = await countRows();
    const spentWalk = await signInThroughProvider(spent.fastify, spent.mock, { callbackQuery: { code: 'a-code-never-issued' } });
    const refusedWalk = await signInThroughProvider(refused.fastify, refused.mock);

    await Promise.all([settleAlerts(spent.fastify.redis), settleAlerts(refused.fastify.redis)]);

    const [alerted] = receiver.requests;
    const texts = JSON.stringify([...spent.sink.lines, ...refused.sink.lines, ...receiver.requests.map((request) => request.body)]);
    const secrets = ['a-code-never-issued', refusedWalk.authorization.code, 'not-the-secret-of-the-mock', REFUSAL_DESCRIPTION];
    const [spentLine] = findLogLines(spent.sink, REQUEST_FAILED_MESSAGE);

    assert.deepEqual(describeRedirect(spentWalk.callback), redirectTo(failureOf('AUTHENTICATION_ERROR')));
    assert.deepEqual(describeRedirect(refusedWalk.callback), redirectTo(failureOf('UPSTREAM_ERROR')));
    assert.deepEqual([spentWalk, refusedWalk].map(({ callback }) => readCookieValues(callback)), [clearedFlowOnly(), clearedFlowOnly()]);
    assert.deepEqual([spent.mock.requests.length, refused.mock.requests.length], [1, 1]);
    assert.deepEqual(await countRows(), counted);
    assert.deepEqual(readTitles(receiver), [UPSTREAM_TITLE]);
    assert.equal(readBlock(alerted.body, 'Error').cause.providerError, 'invalid_client');
    assert.deepEqual(pick(spentLine, ['level']), { level: LOG_LEVEL.WARN });
    assert.equal(spentLine.err.cause.providerError, 'invalid_grant');
    // The lines and the alert name the call: what they leave out is left out, not missing.
    assert.ok(texts.includes(`oauth-${PROVIDER_ID}`));
    assert.deepEqual(secrets.filter((secret) => texts.includes(secret)), []);
  });
});

describe('a link of a provider over HTTP', { skip: testRedis.skip || testDb.skip }, () => {
  test('links an account at the provider to the user who is signed in and ends on the target with linked=<id>: a record of the audit, no new session, the cookies of the session left as they are', async (t) => {
    const { fastify, mock } = await openApp(t);
    const session = await signIn(fastify);
    const subject = uuidv7();
    const walk = await linkThrough(fastify, mock, session, { claims: { sub: subject, given_name: 'Anna' } });

    assert.deepEqual(describeRedirect(walk.start), redirectTo(walk.start.headers[HEADER.LOCATION]));
    assert.equal(mock.isAuthorizationUrl(walk.start.headers[HEADER.LOCATION]), true);
    assert.match(readCookieValues(walk.start)[COOKIE.OAUTH_STATE], new RegExp(`\\.link\\.${session.sid}$`));
    assert.deepEqual(describeRedirect(walk.callback), redirectTo(`${APP_URL}/settings?linked=${PROVIDER_ID}`));
    assert.deepEqual(readCookieValues(walk.callback), clearedFlowOnly());
    assert.deepEqual((await readIdentitiesOf(session.userId)).map((identity) => identity.provider_user_id), [subject]);
    assert.deepEqual(await readAudits(session.userId), [linkRecordOf(session.userId, IDENTITY_LINK_REASON.LINK)]);
    assert.deepEqual((await readSessions(session.userId)).map(({ id }) => id), [session.sid]);
    assert.equal((await readUser(session.userId)).first_name, 'Anna');
  });

  test('an identity the user has already linked is linked again without a second row or record', async (t) => {
    const { fastify, mock } = await openApp(t);
    const session = await signIn(fastify);
    const subject = uuidv7();
    const walks = [
      await linkThrough(fastify, mock, session, { claims: { sub: subject } }),
      await linkThrough(fastify, mock, session, { claims: { sub: subject } }),
    ];

    assert.deepEqual(walks.map(({ callback }) => describeRedirect(callback)), walks.map(() => redirectTo(`${APP_URL}/settings?linked=${PROVIDER_ID}`)));
    assert.equal((await readIdentitiesOf(session.userId)).length, 1);
    assert.equal((await readAudits(session.userId)).length, 1);
  });

  test('an identity linked to another user is refused with IDENTITY_TAKEN on the target, and stays where it is', async (t) => {
    const { fastify, mock } = await openApp(t);
    const [session, other] = [await signIn(fastify), await signIn(fastify)];
    const subject = uuidv7();

    await insertIdentity(other.userId, subject);

    const walk = await linkThrough(fastify, mock, session, { claims: { sub: subject } });

    assert.deepEqual(describeRedirect(walk.callback), redirectTo(`${APP_URL}/settings?authError=IDENTITY_TAKEN`));
    assert.deepEqual((await readIdentities(subject)).map((identity) => identity.user_id), [other.userId]);
    assert.deepEqual(await readIdentitiesOf(session.userId), []);
  });

  test('a link started under one session and finished under another is refused on the target, and no identity is written', async (t) => {
    const { fastify, mock } = await openApp(t);
    const [started, finished] = [await signIn(fastify), await signIn(fastify)];
    const subject = uuidv7();
    const walk = await linkThrough(fastify, mock, started, { claims: { sub: subject }, callbackSession: finished });
    const unsigned = await linkThrough(fastify, mock, started, { claims: { sub: subject }, callbackSession: { accessCookie: {} } });

    assert.deepEqual(
      [walk, unsigned].map(({ callback }) => describeRedirect(callback)),
      [redirectTo(`${APP_URL}/settings?authError=AUTHENTICATION_ERROR`), redirectTo(`${APP_URL}/settings?authError=AUTHENTICATION_ERROR`)],
    );
    assert.deepEqual(await readIdentities(subject), []);
    assert.deepEqual([await readAudits(started.userId), await readAudits(finished.userId)], [[], []]);
    // The code is never spent: the session is checked before the token endpoint is asked.
    assert.deepEqual(mock.requests, []);
  });
});
