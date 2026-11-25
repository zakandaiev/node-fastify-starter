import { refreshSession } from '#core/auth/refresh.js';
import { isSessionAlive } from '#core/auth/registry.js';
import {
  createSession,
  listSessions,
  revokeAllSessions,
  revokeSession,
} from '#core/auth/session.js';
import { verifyAccessToken, verifyRefreshToken } from '#core/auth/token.js';
import { withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { ISOLATION_LEVEL } from '#enums/isolation-level.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTcpProxy, createTestRedis } from '#root/tests/helper/redis.js';
import { getServiceAddress } from '#root/tests/helper/service.js';
import {
  connectAppRedis,
  createUser,
  grantScopes,
  readClaims,
  readSessionRow,
  runInApp,
  signIn,
  TEST_CLIENT,
} from '#root/tests/helper/session.js';
import { unique } from '#utils/array.js';
import { mapSeries } from '#utils/async.js';
import { convertStringToSeconds, parseStrictUtc, toDate } from '#utils/date.js';
import { sha256 } from '#utils/hash.js';
import { uuidv7, uuidVersion } from '#utils/id.js';
import { pick } from '#utils/object.js';
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

// One connection that is not of the app: what it reads is what is committed.
const observer = testDb.skip
  ? null
  : testDb.open({ db: { connectionLimit: 1 } });

const CONNECTION_LIMIT = 4;

// The server counts the wait for a lock in whole seconds.
const LOCK_WAIT = Object.freeze({ lockWaitTimeout: '1s' });

// No command gives up before the test lets Redis answer.
const PATIENT = Object.freeze({ commandTimeout: '10s', socketTimeout: '10s' });

// What is found alive is answered from memory for the whole test: another check would wait for the Redis that hangs.
const LONG_MEMORY = Object.freeze({ registryMemoryTtl: '1h' });

// Not the client of the sign-ins: a refresh then changes every column it may.
const REQUEST = Object.freeze({ headers: Object.freeze({ [HEADER.USER_AGENT]: 'session-refresh-agent' }), ip: '198.51.100.23' });

const USER_AGENT_COLUMN_LENGTH = 255;
const UUID_V7 = 7;
const MS_IN_SECOND = 1000;
const PAST_YEAR = 2020;
const FUTURE_YEAR = 2098;
const FAR_AWAY = parseStrictUtc('2099-01-01T00:00:00.000Z');

// The marks of the registry: a session that has none is read as null.
const ALIVE = '1';
const REVOKED = '0';
const TTL_SLACK_SECONDS = 5;

// A refresh that runs beside the end of its session either comes first or is refused.
const ROTATED = 'rotated';
const REFRESH_OUTCOMES = Object.freeze([ROTATED, ERROR_CODE.AUTHENTICATION_ERROR, ERROR_CODE.SESSION_REVOKED]);

const MAX_SESSIONS = 5;
const LOWERED_LIMIT = 2;
const SIGN_INS_AT_ONCE = 5;
const NEW_USERS_AT_ONCE = 4;
const ROUNDS = 5;

// A call that must settle and does not is a test that never ends: the limit turns it into a failure.
const HANG_TIMEOUT_MS = 10_000;

// A statement the server has listed for this long waits for a row of another transaction. The tests would also pass
// with one that is only slow: what they let go on then is the same.
const BLOCKED_MS = 100;
const BLOCKED_SQL = `
  SELECT id
  FROM information_schema.processlist
  WHERE db = :database AND info LIKE :pattern AND time_ms > :blockedMs AND id <> CONNECTION_ID()
`;

const READ_COMMITTED = Object.freeze({ isolation: ISOLATION_LEVEL.READ_COMMITTED });
const OTHER_LEVELS = Object.freeze([
  undefined,
  ISOLATION_LEVEL.READ_UNCOMMITTED,
  ISOLATION_LEVEL.REPEATABLE_READ,
  ISOLATION_LEVEL.SERIALIZABLE,
]);

const INSERT_SQL = `
  INSERT INTO sessions (id, user_id, refresh_token_hash, started_at, rotated_at, expires_at, revoked_at, user_agent, ip, is_dev)
  VALUES (:id, :userId, :hash, :startedAt, :rotatedAt, :expiresAt, :revokedAt, :userAgent, :ip, :isDev)
`;

// With this many rows of one user and one of another the server reads the table whole, unless it is told not to.
const SKEWED_ROWS = 100;
const SKEW_SQL = `
  INSERT INTO sessions (user_id, refresh_token_hash, expires_at, revoked_at)
  SELECT :userId, SHA2(CONCAT(:userId, seq), 256), :expiresAt, :revokedAt
  FROM seq_1_to_${SKEWED_ROWS}
`;
const MANY_DAYS = Object.freeze(Array.from({ length: 20 }, (unused, index) => index + 1));
const SCAN_REGEXP = /FROM sessions\b[^]*FOR UPDATE/;
const HINT_REGEXP = /FORCE INDEX \(\w+\)/;

// Of two transactions in a deadlock the server gives up the one that has written less.
const WEIGHT_SQL = "INSERT INTO groups (slug, name) SELECT UUID(), 'Weight' FROM seq_1_to_100";

const TRIGGER_SQL = `
  CREATE TRIGGER refuse_updates BEFORE UPDATE ON sessions
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The test refuses it'
`;

const LOCK_USER_SQL = 'SELECT id FROM users WHERE id = ? FOR UPDATE';
const BLOCK_USER_SQL = `UPDATE users SET status = '${USER_STATUS.BLOCKED}' WHERE id = ?`;
const DELETE_USER_SQL = 'DELETE FROM users WHERE id = ?';
const LEAVE_GROUPS_SQL = 'DELETE FROM user_groups WHERE user_id = ?';
const LOCK_SESSION_SQL = 'SELECT id FROM sessions WHERE id = ? FOR UPDATE';
const TOUCH_SESSION_SQL = 'UPDATE sessions SET rotated_at = CURRENT_TIMESTAMP(3) WHERE id = ?';

const RETRY_MESSAGE = 'Database transaction is run again after a lock conflict';
const ROTATION_RETRY_MESSAGE = 'The token of a session is set again after a lock conflict';
const QUERY_MESSAGE = 'Database query';
const QUERY_VALUES_MESSAGE = 'Database query with its values';

const LEVEL_REFUSAL = /cannot change the level of the transaction it is nested in/;
const USER_ID_REFUSAL = /requires the UUID of a user/;
const SID_REFUSAL = /requires the UUID of a session/;
const CLIENT_REFUSAL = /requires the client of the request: readClient\(request\)/;
const TOKEN_SIZE_REFUSAL = /The access token takes \d+ bytes/;

const UPPER_CASE_ID = uuidv7().toUpperCase();
const WRONG_USER_IDS = Object.freeze([undefined, null, '', 'user-1', 42, UPPER_CASE_ID]);
const WRONG_SIDS = Object.freeze([null, '', 'current', 42, UPPER_CASE_ID, [uuidv7()]]);

const sink = createLogSink();

function dayOf(day, year = PAST_YEAR) {
  return parseStrictUtc(`${year}-01-${String(day).padStart(2, '0')}T10:00:00.000Z`);
}

function toKey(sid) {
  return `${testRedis.keyPrefix}session:${sid}`;
}

function readMarks(sids) {
  return testRedis.admin.mget(sids.map((sid) => toKey(sid)));
}

async function readMark(sid) {
  const [mark] = await readMarks([sid]);

  return mark;
}

// SCAN may give a key twice.
async function readKeys() {
  return unique(await testRedis.readKeys()).toSorted();
}

function readUserRows(userId) {
  return observer.readRows('SELECT * FROM sessions WHERE user_id = :userId ORDER BY id', { userId });
}

function listIds(rows) {
  return rows.map((row) => row.id).toSorted();
}

// By the rows alone: an expired session that nobody has ended is "live" here.
async function readSids(userId) {
  const rows = await readUserRows(userId);

  return {
    live: listIds(rows.filter((row) => row.revoked_at === null)),
    ended: listIds(rows.filter((row) => row.revoked_at !== null)),
  };
}

async function insertSession(userId, {
  id = uuidv7(),
  startedAt = dayOf(1),
  rotatedAt = startedAt,
  expiresAt = FAR_AWAY,
  revokedAt = null,
  client = TEST_CLIENT,
  isDev = false,
} = {}) {
  await observer.readRows(INSERT_SQL, {
    id,
    userId,
    hash: sha256(id),
    startedAt,
    rotatedAt,
    expiresAt,
    revokedAt,
    ...client,
    isDev,
  });

  return id;
}

function insertIdle(userId, days, year) {
  return mapSeries(days, (day) => insertSession(userId, { rotatedAt: dayOf(day, year) }));
}

async function signInAs(fastify, userId) {
  const { sid } = await signIn(fastify, { userId });

  return sid;
}

// As many sessions as the limit allows, the longest idle first. That one has been made by a sign-in, with its mark.
async function fillUp(fastify, userId) {
  const first = await signInAs(fastify, userId);

  await observer.readRows('UPDATE sessions SET rotated_at = :rotatedAt WHERE id = :first', { first, rotatedAt: dayOf(1) });

  return [first, ...await insertIdle(userId, [2, 3, 4, 5])];
}

function create(fastify, userId) {
  return runInApp(fastify, () => createSession({ userId, client: TEST_CLIENT }));
}

function refresh(fastify, token) {
  return runInApp(fastify, () => refreshSession({ token, request: REQUEST }));
}

function revoke(fastify, sid, userId) {
  return runInApp(fastify, () => revokeSession({ sid, userId }));
}

function revokeAll(fastify, userId, options) {
  return runInApp(fastify, () => revokeAllSessions(userId, options));
}

function list(fastify, userId) {
  return runInApp(fastify, () => listSessions(userId));
}

function isAlive(fastify, sid) {
  return runInApp(fastify, () => isSessionAlive(sid));
}

function transact(fastify, fn, options = READ_COMMITTED) {
  return runInApp(fastify, () => withTransaction(fn, options));
}

async function buildApp({ auth = {}, db = {}, ...sections } = {}) {
  const fastify = await testDb.buildApp({
    ...sections,
    auth: { maxSessions: MAX_SESSIONS, ...auth },
    db: { connectionLimit: CONNECTION_LIMIT, ...db },
  });

  await connectAppRedis(fastify);

  return fastify;
}

async function openApp(t, sections) {
  const fastify = await buildApp(sections);

  t.after(() => fastify.close());

  return fastify;
}

function watchLog() {
  const start = sink.lines.length;

  return (message) => findLogLines({ lines: sink.lines.slice(start) }, message);
}

async function openTransaction(t) {
  const keeper = await testDb.openKeeper(t);

  await keeper.query('START TRANSACTION');

  return keeper;
}

async function hold(t, sql, id) {
  const other = await openTransaction(t);

  await other.query(sql, [id]);

  return other;
}

async function settle(promise) {
  const [outcome] = await Promise.allSettled([promise]);

  return outcome;
}

// Resolves once a statement with this text in it waits for a row of another transaction. A call that has ended before
// fails the test with what it has ended with.
async function catchAtRow(running, text) {
  const binding = { database: testDb.name, pattern: `%${text}%`, blockedMs: BLOCKED_MS };
  const caught = await Promise.race([
    settle(running),
    waitFor(async () => (await observer.readRows(BLOCKED_SQL, binding))[0]?.id, `a statement with "${text}" to wait for a row`),
  ]);

  assert.ok(Number.isInteger(caught), `The call did not wait for a row: ${inspect(caught)}`);
}

// A sign-in on its way: it holds the row of its user, and has made no session until it is told to go on.
async function startSignIn(t, fastify, userId) {
  const locked = Promise.withResolvers();
  const released = Promise.withResolvers();
  const running = transact(fastify, async () => {
    await fastify.db.query('SELECT id FROM users WHERE id = :userId FOR UPDATE', { userId });
    locked.resolve();
    await released.promise;

    return createSession({ userId, client: TEST_CLIENT });
  });

  function goOn() {
    released.resolve();

    return running;
  }

  t.after(() => released.resolve());
  await Promise.race([locked.promise, running]);

  return goOn;
}

function assertForbidden(error) {
  assert.ok(error instanceof AppError, inspect(error));
  assert.deepEqual([error.code, error.statusCode], [ERROR_CODE.AUTHORIZATION_ERROR, HTTP_STATUS.FORBIDDEN]);
}

async function assertRefused(values, call, refusal) {
  await Promise.all(values.map((value) => assert.rejects(
    call(value),
    (error) => error instanceof TypeError && refusal.test(error.message),
    `${inspect(value)} is not refused for its own reason`,
  )));
}

async function assertLevelRefused(fastify, call) {
  const errors = await mapSeries(OTHER_LEVELS, (isolation) => transact(fastify, () => rejectionOf(call()), { isolation }));

  errors.forEach((error, index) => {
    assert.ok(error instanceof TypeError, `${OTHER_LEVELS[index]}: ${inspect(error)}`);
    assert.match(error.message, LEVEL_REFUSAL);
  });
}

// The process refuses the session from the moment the call turns to Redis: a call that does not wait for Redis has
// resolved by the time that shows.
async function assertWaitsForRedis(t, end) {
  const proxy = await createTcpProxy(t, getServiceAddress('redis'));
  const slow = await openApp(t, { env: proxy.env, redis: PATIENT, auth: LONG_MEMORY });
  const { userId, sid } = await signIn(slow);
  const state = { isResolved: false };

  async function run() {
    await end(slow, sid, userId);
    state.isResolved = true;
  }

  assert.equal(await isAlive(slow, sid), true);
  proxy.freeze();

  const running = run();

  await waitFor(async () => !(await isAlive(slow, sid)), 'the process to refuse the session');

  const hanging = { ...state, mark: await readMark(sid) };

  proxy.thaw();
  await running;

  assert.deepEqual(hanging, { isResolved: false, mark: ALIVE });
  assert.equal(await readMark(sid), REVOKED);
}

describe('sessions', { skip: testRedis.skip || testDb.skip }, () => {
  let fastify;

  before(async () => {
    await up();

    fastify = await buildApp({ logger: { level: 'debug', stream: sink.stream } });
  });

  after(() => fastify?.close());

  describe('createSession', () => {
    test('writes one row, with the hash of the refresh token and the moment that token ends, and gives tokens that verify and their lifetimes', async () => {
      const userId = await createUser(fastify);
      const issued = await runInApp(fastify, () => createSession({ userId, client: TEST_CLIENT, isDev: true }));
      const rows = await readUserRows(userId);
      const { sid } = issued;
      const startedAt = rows[0].started_at;
      const verified = runInApp(fastify, () => ({
        accessToken: verifyAccessToken(issued.accessToken),
        refreshToken: verifyRefreshToken(issued.refreshToken),
      }));

      assert.equal(uuidVersion(sid), UUID_V7);
      assert.deepEqual({ ...issued, ...verified }, {
        userId,
        sid,
        scopes: [],
        accessToken: { userId, sid, scopes: [] },
        refreshToken: { userId, sid },
        accessTtl: convertStringToSeconds(fastify.config.auth.accessTtl),
        refreshTtl: convertStringToSeconds(fastify.config.auth.refreshTtl),
      });
      assert.ok(startedAt instanceof Date);
      assert.deepEqual(rows, [{
        id: sid,
        user_id: userId,
        refresh_token_hash: sha256(issued.refreshToken),
        started_at: startedAt,
        rotated_at: startedAt,
        expires_at: toDate(readClaims(issued.refreshToken).exp * MS_IN_SECOND),
        revoked_at: null,
        user_agent: TEST_CLIENT.userAgent,
        ip: TEST_CLIENT.ip,
        is_dev: true,
        created_at: startedAt,
        updated_at: startedAt,
      }]);
    });

    test('writes NULL for what the client has not told, and a session that is not of dev mode unless it is asked for one', async () => {
      const userId = await createUser(fastify);
      const { sid } = await runInApp(fastify, () => createSession({ userId, client: { userAgent: null, ip: null } }));

      assert.deepEqual(pick(await readSessionRow(fastify, sid), ['user_agent', 'ip', 'is_dev']), { user_agent: null, ip: null, is_dev: false });
    });

    test('puts into the access token what the groups of the user grant at that moment', async () => {
      const userId = await createUser(fastify);
      const bare = await create(fastify, userId);

      await grantScopes(fastify, userId, ['users:write', 'groups:read']);
      await grantScopes(fastify, userId, ['users:read', 'groups:read']);

      const granted = await create(fastify, userId);

      await grantScopes(fastify, userId, ['audit:read'], { isSuperadmin: true });

      const full = await create(fastify, userId);
      const scopes = [[], ['groups:read', 'users:read', 'users:write'], [SCOPE_ALL]];

      assert.deepEqual([bare, granted, full].map((issued) => issued.scopes), scopes);
      assert.deepEqual([bare, granted, full].map((issued) => readClaims(issued.accessToken).scopes), scopes);
    });

    test('marks the session alive in Redis for as long as its access token lives', async () => {
      const { sid, accessTtl } = await create(fastify, await createUser(fastify));
      const ttl = await testRedis.admin.ttl(toKey(sid));

      assert.equal(await readMark(sid), ALIVE);
      assert.ok(ttl > accessTtl - TTL_SLACK_SECONDS && ttl <= accessTtl, `The mark lives ${ttl} s`);
    });

    test('refuses with 403 a user who is blocked and one who is not there, and leaves neither a row nor a mark', async () => {
      const userIds = [await createUser(fastify, { status: USER_STATUS.BLOCKED }), uuidv7()];
      const keys = await readKeys();
      const errors = await Promise.all(userIds.map((userId) => rejectionOf(create(fastify, userId))));

      errors.forEach((error) => assertForbidden(error));
      assert.deepEqual(await Promise.all(userIds.map((userId) => readUserRows(userId))), [[], []]);
      assert.deepEqual(await readKeys(), keys);
    });

    test('refuses a user whom the transaction it has waited for has blocked, and one whom it has deleted', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      async function createBehind(sql) {
        const userId = await createUser(fastify);
        const other = await hold(t, sql, userId);
        const creating = create(fastify, userId);

        await catchAtRow(creating, userId);
        await other.query('COMMIT');

        return { error: await rejectionOf(creating), rows: await readUserRows(userId) };
      }

      const outcomes = await mapSeries([BLOCK_USER_SQL, DELETE_USER_SQL], createBehind);

      outcomes.forEach(({ error }) => assertForbidden(error));
      assert.deepEqual(outcomes.map(({ rows }) => rows), [[], []]);
    });

    test('signs in a user whose block has been taken back by the transaction it has waited for', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const userId = await createUser(fastify);
      const other = await hold(t, BLOCK_USER_SQL, userId);
      const creating = create(fastify, userId);

      await catchAtRow(creating, userId);
      await other.query('ROLLBACK');

      const { sid } = await creating;

      assert.deepEqual(await readSids(userId), { live: [sid], ended: [] });
    });

    test('puts into the access token no scope that the transaction it has waited for has taken away', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const userId = await createUser(fastify);

      await grantScopes(fastify, userId, ['users:write']);

      const other = await hold(t, LOCK_USER_SQL, userId);
      const creating = create(fastify, userId);

      await catchAtRow(creating, userId);
      await other.query(LEAVE_GROUPS_SQL, [userId]);
      await other.query('COMMIT');

      const { scopes, accessToken } = await creating;

      assert.deepEqual([scopes, readClaims(accessToken).scopes], [[], []]);
    });

    test('leaves neither a row nor a mark behind when its row cannot be written', async () => {
      const userId = await createUser(fastify);
      const keys = await readKeys();
      const client = { ...TEST_CLIENT, userAgent: 'a'.repeat(USER_AGENT_COLUMN_LENGTH + 1) };

      await assert.rejects(runInApp(fastify, () => createSession({ userId, client })), { name: 'DbError', code: 'ER_DATA_TOO_LONG' });
      assert.deepEqual(await readUserRows(userId), []);
      assert.deepEqual(await readKeys(), keys);
    });

    test('leaves no session behind when its tokens cannot be issued', async (t) => {
      const cramped = await openApp(t, { auth: { accessTokenMaxBytes: 1 } });
      const userId = await createUser(fastify);

      await assert.rejects(create(cramped, userId), TOKEN_SIZE_REFUSAL);
      assert.deepEqual(await readUserRows(userId), []);
    });

    test('leaves neither a row nor a mark behind when it fails after its row is written', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const userId = await createUser(fastify);

      await fillUp(fastify, userId);

      const rows = await readUserRows(userId);
      const keys = await readKeys();

      await observer.readRows(TRIGGER_SQL);
      t.after(() => observer.readRows('DROP TRIGGER refuse_updates'));

      await assert.rejects(create(fastify, userId), { name: 'DbError', code: 'ER_SIGNAL_EXCEPTION' });
      assert.deepEqual(await readUserRows(userId), rows);
      assert.deepEqual(await readKeys(), keys);
    });

    test('refuses a wrong id of a user and a missing client', async () => {
      await assertRefused(WRONG_USER_IDS, (userId) => createSession({ userId, client: TEST_CLIENT }), USER_ID_REFUSAL);
      await assertRefused([undefined, null], (client) => createSession({ userId: uuidv7(), client }), CLIENT_REFUSAL);
      await assert.rejects(createSession(), { name: 'TypeError', message: USER_ID_REFUSAL });
    });
  });

  describe('createSession: the limit of live sessions', () => {
    test('ends none while there are no more than the limit', async () => {
      const userId = await createUser(fastify);
      const sids = await mapSeries(Array.from({ length: MAX_SESSIONS }), () => signInAs(fastify, userId));

      assert.deepEqual(await readSids(userId), { live: sids.toSorted(), ended: [] });
      assert.deepEqual(await readMarks(sids), sids.map(() => ALIVE));
    });

    test('ends the session idle the longest once there are more: by its last activity, not by its sign-in, and no session of another user', async () => {
      const [userId, strangerId] = await Promise.all([createUser(fastify), createUser(fastify)]);
      const strange = await insertSession(strangerId, { rotatedAt: dayOf(1) });
      const active = await mapSeries([1, 2, 3, 4], (day) => insertSession(userId, { startedAt: dayOf(day), rotatedAt: dayOf(day + 10) }));
      const idle = await insertSession(userId, { startedAt: dayOf(5), rotatedAt: dayOf(6) });
      const { sid } = await create(fastify, userId);

      assert.deepEqual(await readSids(userId), { live: [...active, sid].toSorted(), ended: [idle] });
      assert.deepEqual(await readSids(strangerId), { live: [strange], ended: [] });
      assert.deepEqual(await readMarks([idle, ...active, sid]), [REVOKED, ...active.map(() => null), ALIVE]);
    });

    test('of two sessions idle equally long ends the one with the smaller id first, whichever was written first', async () => {
      const userId = await createUser(fastify);
      const [smaller, greater] = [uuidv7(), uuidv7()];

      await insertSession(userId, { id: greater, rotatedAt: dayOf(1) });
      await insertSession(userId, { id: smaller, rotatedAt: dayOf(1) });
      await insertIdle(userId, [2, 3, 4]);

      await create(fastify, userId);
      assert.deepEqual((await readSids(userId)).ended, [smaller]);

      await create(fastify, userId);
      assert.deepEqual((await readSids(userId)).ended, [smaller, greater]);
    });

    test('counts live sessions alone: one that is revoked or expired takes no place and stays as it is', async () => {
      const userId = await createUser(fastify);
      const revoked = await insertSession(userId, { rotatedAt: dayOf(1), revokedAt: dayOf(2) });
      const expired = await insertSession(userId, { rotatedAt: dayOf(1), expiresAt: dayOf(2) });
      const dead = await readUserRows(userId);
      const [idle] = await insertIdle(userId, [3, 4, 5, 6]);

      await create(fastify, userId);
      assert.deepEqual((await readSids(userId)).ended, [revoked]);

      await create(fastify, userId);
      assert.deepEqual((await readSids(userId)).ended, [revoked, idle].toSorted());
      assert.deepEqual((await readUserRows(userId)).filter((row) => [revoked, expired].includes(row.id)), dead);
    });

    test('never ends the session it makes, also when every other one has been active since', async () => {
      const userId = await createUser(fastify);
      const [first, ...rest] = await insertIdle(userId, [1, 2, 3, 4, 5], FUTURE_YEAR);
      const { sid } = await create(fastify, userId);

      assert.deepEqual(await readSids(userId), { live: [...rest, sid].toSorted(), ended: [first] });
    });

    test('ends as many as a limit lowered since asks for, the longest idle first', async (t) => {
      const lowered = await openApp(t, { auth: { maxSessions: LOWERED_LIMIT } });
      const userId = await createUser(fastify);
      const sids = await insertIdle(userId, [1, 2, 3, 4, 5]);
      const { sid } = await create(lowered, userId);
      const [kept, ...ended] = sids.toReversed();

      assert.deepEqual(await readSids(userId), { live: [kept, sid].toSorted(), ended: ended.toSorted() });
      assert.deepEqual(await readMarks([kept, sid, ...ended]), [null, ALIVE, ...ended.map(() => REVOKED)]);
    });

    test('passes over a session that is refreshed while it waits for its row: the next one idle the longest ends', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const userId = await createUser(fastify);
      const [refreshed, next, ...rest] = await insertIdle(userId, [1, 2, 3, 4, 5]);
      const other = await hold(t, TOUCH_SESSION_SQL, refreshed);
      const creating = create(fastify, userId);

      await catchAtRow(creating, userId);
      await other.query('COMMIT');

      const { sid } = await creating;

      assert.deepEqual(await readSids(userId), { live: [refreshed, ...rest, sid].toSorted(), ended: [next] });
    });
  });

  describe('createSession side by side', () => {
    test('leaves exactly as many sessions live as the limit allows, of one user who signs in many times at once, and the marks say the same', async (t) => {
      const lowered = await openApp(t, { auth: { maxSessions: LOWERED_LIMIT } });
      const userId = await createUser(fastify);
      const issued = await Promise.all(Array.from({ length: SIGN_INS_AT_ONCE }, () => create(lowered, userId)));
      const sids = issued.map(({ sid }) => sid);
      const { live, ended } = await readSids(userId);

      assert.equal(live.length, LOWERED_LIMIT);
      assert.deepEqual([...live, ...ended].toSorted(), sids.toSorted());
      assert.deepEqual(await readMarks(sids), sids.map((sid) => (live.includes(sid) ? ALIVE : REVOKED)));
    });

    test('signs in new users at once without a deadlock: none of them is run again', async () => {
      const readLog = watchLog();
      const rounds = await mapSeries(Array.from({ length: ROUNDS }), async () => {
        const userIds = await mapSeries(Array.from({ length: NEW_USERS_AT_ONCE }), () => createUser(fastify));
        const issued = await Promise.all(userIds.map((userId) => create(fastify, userId)));
        const states = await Promise.all(userIds.map((userId) => readSids(userId)));

        return { issued, states };
      });

      rounds.forEach(({ issued, states }) => assert.deepEqual(states, issued.map(({ sid }) => ({ live: [sid], ended: [] }))));
      assert.deepEqual(readLog(RETRY_MESSAGE), []);
    });

    test('runs beside the revocations and a refresh of the same user without a deadlock, and the marks say in the end what the rows do', async () => {
      const readLog = watchLog();
      const rounds = await mapSeries(Array.from({ length: ROUNDS }), async () => {
        const userId = await createUser(fastify);
        const first = await signInAs(fastify, userId);
        const second = await signIn(fastify, { userId });
        const [third, , fourth, , refreshed] = await Promise.all([
          create(fastify, userId),
          revokeAll(fastify, userId),
          create(fastify, userId),
          revoke(fastify, first, userId),
          settle(refresh(fastify, second.issued.refreshToken)),
        ]);
        const { live, ended } = await readSids(userId);

        return {
          made: [first, second.sid, third.sid, fourth.sid].toSorted(),
          found: [...live, ...ended].toSorted(),
          marks: await readMarks([...live, ...ended]),
          expected: [...live.map(() => ALIVE), ...ended.map(() => REVOKED)],
          refreshed: refreshed.reason?.code ?? ROTATED,
        };
      });

      rounds.forEach(({
        made, found, marks, expected, refreshed,
      }) => {
        assert.deepEqual(found, made);
        assert.deepEqual(marks, expected);
        assert.ok(REFRESH_OUTCOMES.includes(refreshed), refreshed);
      });
      assert.deepEqual([...readLog(RETRY_MESSAGE), ...readLog(ROTATION_RETRY_MESSAGE)], []);
    });
  });

  describe('createSession inside a transaction', () => {
    test('commits with it, and marks what it has made and what it has ended only after that commit', async () => {
      const userId = await createUser(fastify);
      const sids = await fillUp(fastify, userId);
      const [first, ...rest] = sids;
      const { sid, marks, committed } = await transact(fastify, async () => {
        const issued = await createSession({ userId, client: TEST_CLIENT });

        return {
          sid: issued.sid,
          marks: await readMarks([issued.sid, first]),
          committed: await readSids(userId),
        };
      });

      assert.deepEqual(marks, [null, ALIVE]);
      assert.deepEqual(committed, { live: sids.toSorted(), ended: [] });
      assert.deepEqual(await readSids(userId), { live: [...rest, sid].toSorted(), ended: [first] });
      assert.deepEqual(await readMarks([sid, first]), [ALIVE, REVOKED]);
    });

    test('goes with one that rolls back: there is no row and no mark of it, and the session it has ended is live', async () => {
      const userId = await createUser(fastify);
      const sids = await fillUp(fastify, userId);
      const [first] = sids;
      const rows = await readUserRows(userId);
      const failure = new Error('The sign-in failed after its session');
      const seen = {};
      const error = await rejectionOf(transact(fastify, async () => {
        seen.issued = await createSession({ userId, client: TEST_CLIENT });
        seen.ended = await fastify.db.query('SELECT id FROM sessions WHERE user_id = :userId AND revoked_at IS NOT NULL', { userId });

        throw failure;
      }));

      assert.equal(error, failure);
      assert.deepEqual(seen.ended.rows, [{ id: first }]);
      assert.deepEqual(await readUserRows(userId), rows);
      assert.deepEqual(await readMarks([seen.issued.sid, first]), [null, ALIVE]);
      assert.equal(await isAlive(fastify, first), true);
    });

    test('signs in a user whom that transaction has made, with the group it has given them', async () => {
      const groupId = await grantScopes(fastify, await createUser(fastify), ['users:read']);
      const userId = uuidv7();
      const { sid, scopes } = await transact(fastify, async () => {
        await fastify.db.query('INSERT INTO users (id) VALUES (:userId)', { userId });
        await fastify.db.query('INSERT INTO user_groups (user_id, group_id) VALUES (:userId, :groupId)', { userId, groupId });

        return createSession({ userId, client: TEST_CLIENT });
      });

      assert.deepEqual(scopes, ['users:read']);
      assert.deepEqual(await readSids(userId), { live: [sid], ended: [] });
    });

    test('goes on after a plain read of that transaction and a refresh and a change of the user another connection has committed since', async () => {
      const userId = await createUser(fastify);
      const first = await signIn(fastify, { userId });
      const { sid } = await transact(fastify, async () => {
        await fastify.db.query('SELECT s.id, u.locale FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.id = :userId', { userId });
        await refresh(fastify, first.issued.refreshToken);
        await observer.readRows("UPDATE users SET locale = 'uk' WHERE id = :userId", { userId });

        return createSession({ userId, client: TEST_CLIENT });
      });

      assert.deepEqual(await readSids(userId), { live: [first.sid, sid].toSorted(), ended: [] });
    });

    test('reads the scopes as they are at that moment, not as the transaction had found them', async () => {
      const userId = await createUser(fastify);

      await grantScopes(fastify, userId, ['users:read']);

      const { found, scopes } = await transact(fastify, async () => {
        const { rows } = await fastify.db.query('SELECT group_id FROM user_groups WHERE user_id = :userId', { userId });

        await observer.readRows('DELETE FROM user_groups WHERE user_id = :userId', { userId });

        const issued = await createSession({ userId, client: TEST_CLIENT });

        return { found: rows.length, scopes: issued.scopes };
      });

      assert.equal(found, 1);
      assert.deepEqual(scopes, []);
    });

    test('is refused by one of any other level, the default one too, and writes nothing', async () => {
      const userId = await createUser(fastify);

      await assertLevelRefused(fastify, () => createSession({ userId, client: TEST_CLIENT }));
      assert.deepEqual(await readUserRows(userId), []);
    });
  });

  describe('revokeSession', () => {
    test('ends the live session of its user, and no other: the row, the mark and the answer say so', async () => {
      const userId = await createUser(fastify);
      const sid = await signInAs(fastify, userId);
      const other = await signInAs(fastify, userId);
      const [row, otherRow] = await Promise.all([sid, other].map((id) => readSessionRow(fastify, id)));

      assert.equal(await revoke(fastify, sid, userId), true);

      const ended = await readSessionRow(fastify, sid);

      assert.ok(ended.revoked_at instanceof Date);
      assert.deepEqual(ended, { ...row, revoked_at: ended.revoked_at, updated_at: ended.updated_at });
      assert.deepEqual(await readSessionRow(fastify, other), otherRow);
      assert.deepEqual(await readMarks([sid, other]), [REVOKED, ALIVE]);
      assert.deepEqual([await isAlive(fastify, sid), await isAlive(fastify, other)], [false, true]);
    });

    test('gives false and changes nothing for a session of someone else, one that is revoked, one that is expired and one that is not there', async () => {
      const [userId, strangerId] = await Promise.all([createUser(fastify), createUser(fastify)]);
      const strange = await signInAs(fastify, strangerId);
      const revoked = await insertSession(userId, { revokedAt: dayOf(2) });
      const expired = await insertSession(userId, { expiresAt: dayOf(2) });
      const sids = [strange, revoked, expired, uuidv7()];
      const rows = await Promise.all([userId, strangerId].map((id) => readUserRows(id)));
      const answers = await Promise.all(sids.map((sid) => revoke(fastify, sid, userId)));

      assert.deepEqual(answers, [false, false, false, false]);
      assert.deepEqual(await Promise.all([userId, strangerId].map((id) => readUserRows(id))), rows);
      assert.deepEqual(await readMarks(sids), [ALIVE, null, null, null]);
      assert.equal(await isAlive(fastify, strange), true);
    });

    test('marks nothing inside a transaction until it commits, and nothing at all when it rolls back', async () => {
      const userId = await createUser(fastify);
      const lost = await signInAs(fastify, userId);
      const ended = await signInAs(fastify, userId);
      const failure = new Error('The action failed after the revocation');
      const seen = {};
      const error = await rejectionOf(transact(fastify, async () => {
        seen.isRevoked = await revokeSession({ sid: lost, userId });

        throw failure;
      }, {}));
      const inside = await transact(fastify, async () => {
        const isRevoked = await revokeSession({ sid: ended, userId });

        return { isRevoked, mark: await readMark(ended) };
      }, {});

      assert.equal(error, failure);
      assert.deepEqual(seen, { isRevoked: true });
      assert.deepEqual(inside, { isRevoked: true, mark: ALIVE });
      assert.deepEqual(await readSids(userId), { live: [lost], ended: [ended] });
      assert.deepEqual(await readMarks([lost, ended]), [ALIVE, REVOKED]);
      assert.deepEqual([await isAlive(fastify, lost), await isAlive(fastify, ended)], [true, false]);
    });

    test('fails a transaction of the default level that has read before a refresh of the session, and ends nothing: one that is run again, or reads what is committed, goes through', async () => {
      async function revokeBehindRefresh(options) {
        const { userId, sid, issued } = await signIn(fastify);
        const runs = { count: 0 };
        const { value, reason } = await settle(transact(fastify, async () => {
          runs.count += 1;
          await fastify.db.query('SELECT id FROM users WHERE id = :userId', { userId });

          if (runs.count === 1) {
            await refresh(fastify, issued.refreshToken);
          }

          return revokeSession({ sid, userId });
        }, options));

        return {
          outcome: value ?? reason.code,
          runCount: runs.count,
          isLive: (await readSids(userId)).live.includes(sid),
          mark: await readMark(sid),
        };
      }

      const ended = { outcome: true, isLive: false, mark: REVOKED };

      assert.deepEqual(await mapSeries([{}, { retry: true }, READ_COMMITTED], revokeBehindRefresh), [
        {
          outcome: 'ER_CHECKREAD', runCount: 1, isLive: true, mark: ALIVE,
        },
        { ...ended, runCount: 2 },
        { ...ended, runCount: 1 },
      ]);
    });

    test('resolves when Redis has been told, not before: a Redis that hangs holds it, though the process refuses the session already', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      await assertWaitsForRedis(t, revoke);
    });

    test('refuses a wrong id of a session and of a user', async () => {
      await assertRefused([undefined, ...WRONG_SIDS], (sid) => revokeSession({ sid, userId: uuidv7() }), SID_REFUSAL);
      await assertRefused(WRONG_USER_IDS, (userId) => revokeSession({ sid: uuidv7(), userId }), USER_ID_REFUSAL);
      await assert.rejects(revokeSession(), { name: 'TypeError', message: USER_ID_REFUSAL });
    });
  });

  describe('revokeAllSessions', () => {
    test('ends every live session of the user and tells how many: what was over already and another user stay as they are', async () => {
      const [userId, strangerId] = await Promise.all([createUser(fastify), createUser(fastify)]);
      const revoked = await insertSession(userId, { revokedAt: dayOf(2) });
      const expired = await insertSession(userId, { expiresAt: dayOf(2) });
      const dead = await readUserRows(userId);
      const live = [await signInAs(fastify, userId), await signInAs(fastify, userId), await insertSession(userId)];
      const strange = await signInAs(fastify, strangerId);
      const strangeRows = await readUserRows(strangerId);

      assert.equal(await revokeAll(fastify, userId), live.length);
      assert.deepEqual(await readSids(userId), { live: [expired], ended: [...live, revoked].toSorted() });
      assert.deepEqual((await readUserRows(userId)).filter((row) => !live.includes(row.id)), dead);
      assert.deepEqual(await readUserRows(strangerId), strangeRows);
      assert.deepEqual(await readMarks([...live, revoked, expired, strange]), [...live.map(() => REVOKED), null, null, ALIVE]);
    });

    test('keeps exactly the session named by except', async () => {
      const userId = await createUser(fastify);
      const first = await signInAs(fastify, userId);
      const kept = await signInAs(fastify, userId);
      const last = await signInAs(fastify, userId);
      const keptRow = await readSessionRow(fastify, kept);

      assert.equal(await revokeAll(fastify, userId, { except: kept }), [first, last].length);
      assert.deepEqual(await readSids(userId), { live: [kept], ended: [first, last].toSorted() });
      assert.deepEqual(await readSessionRow(fastify, kept), keptRow);
      assert.deepEqual(await readMarks([first, kept, last]), [REVOKED, ALIVE, REVOKED]);
      assert.equal(await isAlive(fastify, kept), true);
    });

    test('ends them all when except names a session of another user: it is neither kept for this one nor ended', async () => {
      const [userId, strangerId] = await Promise.all([createUser(fastify), createUser(fastify)]);
      const own = await signInAs(fastify, userId);
      const strange = await signInAs(fastify, strangerId);

      assert.equal(await revokeAll(fastify, userId, { except: strange }), 1);
      assert.deepEqual(await readMarks([own, strange]), [REVOKED, ALIVE]);
      assert.deepEqual([await readSids(userId), await readSids(strangerId)], [{ live: [], ended: [own] }, { live: [strange], ended: [] }]);
    });

    test('gives 0 when there is nothing to end, and sends no write then', async () => {
      const userId = await createUser(fastify);
      const only = await signInAs(fastify, userId);
      const readLog = watchLog();
      const counts = [await revokeAll(fastify, userId, { except: only }), await revokeAll(fastify, uuidv7())];
      const statements = readLog(QUERY_MESSAGE).map((line) => line.sql.trim());

      assert.deepEqual(counts, [0, 0]);
      assert.ok(statements.length > 0);
      assert.deepEqual(statements.filter((sql) => !sql.startsWith('SELECT')), []);
      assert.deepEqual(await readSids(userId), { live: [only], ended: [] });
      assert.equal(await readMark(only), ALIVE);
    });

    test('refuses a wrong except, null and an empty text too, and ends nothing: it must not pass for none', async () => {
      const userId = await createUser(fastify);
      const sid = await signInAs(fastify, userId);

      await assertRefused(WRONG_SIDS, (except) => revokeAll(fastify, userId, { except }), SID_REFUSAL);
      assert.deepEqual(await readSids(userId), { live: [sid], ended: [] });
      assert.equal(await readMark(sid), ALIVE);
    });

    test('refuses a wrong id of a user', async () => {
      await assertRefused(WRONG_USER_IDS, (userId) => revokeAllSessions(userId), USER_ID_REFUSAL);
    });

    test('waits for a sign-in on its way and ends the session it makes too', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const userId = await createUser(fastify);
      const goOn = await startSignIn(t, fastify, userId);
      const revoking = revokeAll(fastify, userId);

      await catchAtRow(revoking, userId);

      const [{ sid }, count] = await Promise.all([goOn(), revoking]);

      assert.equal(count, 1);
      assert.deepEqual(await readSids(userId), { live: [], ended: [sid] });
      assert.equal(await readMark(sid), REVOKED);
      assert.equal(await isAlive(fastify, sid), false);
    });

    test('in the transaction of a block ends the session of a sign-in that block has waited for, and the next sign-in is refused', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const userId = await createUser(fastify);
      const goOn = await startSignIn(t, fastify, userId);
      const blocking = transact(fastify, async () => {
        await fastify.db.query('UPDATE users SET status = :status WHERE id = :userId', { userId, status: USER_STATUS.BLOCKED });

        return revokeAllSessions(userId);
      });

      await catchAtRow(blocking, userId);

      const [{ sid }, count] = await Promise.all([goOn(), blocking]);

      assert.equal(count, 1);
      assert.deepEqual(await readSids(userId), { live: [], ended: [sid] });
      assert.equal(await readMark(sid), REVOKED);
      assertForbidden(await rejectionOf(create(fastify, userId)));
    });

    test('marks nothing inside a transaction until it commits, and nothing at all when it rolls back', async () => {
      const userId = await createUser(fastify);
      const sids = [await signInAs(fastify, userId), await signInAs(fastify, userId)];
      const rows = await readUserRows(userId);
      const failure = new Error('The action failed after the revocation');
      const seen = {};
      const error = await rejectionOf(transact(fastify, async () => {
        seen.count = await revokeAllSessions(userId);

        throw failure;
      }));

      assert.equal(error, failure);
      assert.deepEqual(seen, { count: sids.length });
      assert.deepEqual(await readUserRows(userId), rows);
      assert.deepEqual(await readMarks(sids), [ALIVE, ALIVE]);
      assert.deepEqual(await Promise.all(sids.map((sid) => isAlive(fastify, sid))), [true, true]);

      const inside = await transact(fastify, async () => ({ count: await revokeAllSessions(userId), marks: await readMarks(sids) }));

      assert.deepEqual(inside, { count: sids.length, marks: [ALIVE, ALIVE] });
      assert.deepEqual(await readMarks(sids), [REVOKED, REVOKED]);
    });

    test('resolves when Redis has been told, not before: a Redis that hangs holds it, though the process refuses the session already', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      await assertWaitsForRedis(t, (slow, sid, userId) => revokeAll(slow, userId));
    });

    test('fails with the error of the lock when the row of the user stays held, and ends nothing', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const hurried = await openApp(t, { db: LOCK_WAIT });
      const { userId, sid } = await signIn(fastify);

      await hold(t, LOCK_USER_SQL, userId);

      await assert.rejects(revokeAll(hurried, userId), { name: 'DbError', code: 'ER_LOCK_WAIT_TIMEOUT' });
      assert.deepEqual(await readSids(userId), { live: [sid], ended: [] });
      assert.equal(await readMark(sid), ALIVE);
    });

    test('goes on after a plain read of the transaction around it and a refresh another connection has committed since', async () => {
      const { userId, sid, issued } = await signIn(fastify);
      const count = await transact(fastify, async () => {
        await fastify.db.query('SELECT id FROM sessions WHERE user_id = :userId', { userId });
        await refresh(fastify, issued.refreshToken);

        return revokeAllSessions(userId);
      });

      assert.equal(count, 1);
      assert.deepEqual(await readSids(userId), { live: [], ended: [sid] });
    });

    test('is refused by a transaction of any other level, the default one too, and ends nothing', async () => {
      const userId = await createUser(fastify);
      const sid = await signInAs(fastify, userId);

      await assertLevelRefused(fastify, () => revokeAllSessions(userId));
      assert.deepEqual(await readSids(userId), { live: [sid], ended: [] });
    });
  });

  describe('listSessions', () => {
    test('lists the live sessions of the user, the last active first and then by the greater id, with neither the user nor the hash', async () => {
      const [userId, strangerId] = await Promise.all([createUser(fastify), createUser(fastify)]);
      const [smaller, greater] = [uuidv7(), uuidv7()];
      const common = {
        userAgent: TEST_CLIENT.userAgent,
        ip: TEST_CLIENT.ip,
        isDev: false,
        startedAt: dayOf(1),
        expiresAt: FAR_AWAY,
      };
      const idle = await insertSession(userId, { rotatedAt: dayOf(2), client: { userAgent: null, ip: null }, isDev: true });

      await insertSession(userId, { id: greater, rotatedAt: dayOf(3) });

      const active = await insertSession(userId, { startedAt: dayOf(3), rotatedAt: dayOf(4), expiresAt: dayOf(1, FUTURE_YEAR) });

      await insertSession(userId, { id: smaller, rotatedAt: dayOf(3) });
      await insertSession(userId, { rotatedAt: dayOf(5), revokedAt: dayOf(6) });
      await insertSession(userId, { rotatedAt: dayOf(5), expiresAt: dayOf(6) });
      await insertSession(strangerId, { rotatedAt: dayOf(5) });

      assert.deepEqual(await list(fastify, userId), [
        {
          ...common,
          id: active,
          startedAt: dayOf(3),
          rotatedAt: dayOf(4),
          expiresAt: dayOf(1, FUTURE_YEAR),
        },
        { ...common, id: greater, rotatedAt: dayOf(3) },
        { ...common, id: smaller, rotatedAt: dayOf(3) },
        {
          ...common,
          id: idle,
          userAgent: null,
          ip: null,
          isDev: true,
          rotatedAt: dayOf(2),
        },
      ]);
    });

    test('gives an empty list to a user who has none', async () => {
      assert.deepEqual(await list(fastify, await createUser(fastify)), []);
    });

    test('refuses a wrong id of a user', async () => {
      await assertRefused(WRONG_USER_IDS, (userId) => listSessions(userId), USER_ID_REFUSAL);
    });
  });

  describe('the locks on sessions', () => {
    async function skew() {
      const [userId, neighbourId] = await Promise.all([createUser(fastify), createUser(fastify)]);

      await observer.readRows('DELETE FROM sessions');
      await observer.readRows(SKEW_SQL, { userId, expiresAt: FAR_AWAY, revokedAt: dayOf(1) });

      const neighbour = await insertSession(neighbourId);

      await observer.readRows('ANALYZE TABLE sessions');

      return { userId, neighbour };
    }

    test('are taken through the index of the user, also when one user owns almost every row and the server would read them all', async () => {
      const { userId } = await skew();
      const readLog = watchLog();

      await create(fastify, userId);

      const scan = readLog(QUERY_VALUES_MESSAGE).map((line) => line.sql).find((sql) => SCAN_REGEXP.test(sql));
      const [plan] = await observer.readRows(`EXPLAIN ${scan}`);
      const [unforced] = await observer.readRows(`EXPLAIN ${scan.replace(HINT_REGEXP, '')}`);

      assert.deepEqual(pick(plan, ['table', 'type', 'key']), { table: 'sessions', type: 'ref', key: 'idx_sessions_user' });
      assert.deepEqual(pick(unforced, ['table', 'type', 'key']), { table: 'sessions', type: 'ALL', key: null });
    });

    test('of one user wait for no row of another, with as many live sessions as the limit allows and almost every row of the table', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { userId, neighbour } = await skew();
      const [idle, ...rest] = await insertIdle(userId, [1, 2, 3, 4, 5]);

      await hold(t, LOCK_SESSION_SQL, neighbour);

      const { sid } = await create(fastify, userId);

      assert.deepEqual((await readSids(userId)).live, [...rest, sid].toSorted());
      assert.equal(await revokeAll(fastify, userId), MAX_SESSIONS);
      assert.deepEqual((await readSids(userId)).live, []);
      assert.deepEqual(await readMarks([idle, ...rest, sid]), Array.from({ length: MAX_SESSIONS + 1 }, () => REVOKED));
    });

    test('wait for no row of another user however many sessions end at once: the server would read the whole table for a dozen ids', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const userId = await createUser(fastify);
      const neighbour = await insertSession(await createUser(fastify));

      await observer.readRows('DELETE FROM sessions WHERE id <> :neighbour', { neighbour });

      const sids = await insertIdle(userId, MANY_DAYS);

      await observer.readRows('ANALYZE TABLE sessions');
      await hold(t, LOCK_SESSION_SQL, neighbour);

      assert.equal(await revokeAll(fastify, userId), sids.length);
      assert.deepEqual((await readSids(userId)).live, []);
    });

    test('leave a refresh alone, the end of a replayed session and of a single one too: each runs while another transaction holds the row of their user', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const hurried = await openApp(t, { db: LOCK_WAIT });
      const userId = await createUser(fastify);
      const first = await signIn(fastify, { userId });
      const second = await signIn(fastify, { userId });

      // A token ends at a whole second: a refresh within the second of the sign-in would write the end that is there.
      await observer.readRows('UPDATE sessions SET expires_at = :expiresAt WHERE user_id = :userId', { userId, expiresAt: FAR_AWAY });
      await hold(t, LOCK_USER_SQL, userId);

      const { refreshToken } = await refresh(hurried, first.issued.refreshToken);
      const row = await readSessionRow(fastify, first.sid);
      const replay = await rejectionOf(refresh(hurried, first.issued.refreshToken));
      const isRevoked = await revoke(hurried, second.sid, userId);

      assert.deepEqual(pick(row, ['refresh_token_hash', 'revoked_at']), { refresh_token_hash: sha256(refreshToken), revoked_at: null });
      assert.equal(replay.code, ERROR_CODE.SESSION_REVOKED);
      assert.equal(isRevoked, true);
      assert.deepEqual(await readSids(userId), { live: [], ended: [first.sid, second.sid].toSorted() });
    });

    test('are asked for once more after a deadlock with a transaction that has taken them the other way round: there is one sign-in, and one revocation', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const userId = await createUser(fastify);
      const first = await signInAs(fastify, userId);

      async function runAgainst(call) {
        const readLog = watchLog();
        const other = await openTransaction(t);

        await other.query(WEIGHT_SQL);
        await other.query(LOCK_SESSION_SQL, [first]);

        const running = call();

        await catchAtRow(running, `FROM sessions%${userId}`);
        await other.query(LOCK_USER_SQL, [userId]);
        await other.query('ROLLBACK');

        return { result: await running, retryCount: readLog(RETRY_MESSAGE).length };
      }

      const signedIn = await runAgainst(() => create(fastify, userId));
      const { sid } = signedIn.result;

      assert.equal(signedIn.retryCount, 1);
      assert.deepEqual(await readSids(userId), { live: [first, sid].toSorted(), ended: [] });
      assert.equal(await readMark(sid), ALIVE);

      assert.deepEqual(await runAgainst(() => revokeAll(fastify, userId)), { result: [first, sid].length, retryCount: 1 });
      assert.deepEqual(await readMarks([first, sid]), [REVOKED, REVOKED]);
    });

    test('move no version of the table in the cache: no statement on sessions is cached', async () => {
      const userId = await createUser(fastify);
      const [first] = await fillUp(fastify, userId);
      const { sid, issued } = await signIn(fastify, { userId });
      const unmarked = await signInAs(fastify, userId);

      await testRedis.admin.del(toKey(unmarked));

      const found = await isAlive(fastify, unmarked);

      await refresh(fastify, issued.refreshToken);

      const replay = await rejectionOf(refresh(fastify, issued.refreshToken));

      await revoke(fastify, unmarked, userId);
      await revokeAll(fastify, userId);
      await list(fastify, userId);

      const prefix = `${testRedis.keyPrefix}table-version:`;
      const versions = (await readKeys()).filter((key) => key.startsWith(prefix));

      assert.equal(found, true);
      assert.equal(replay.code, ERROR_CODE.SESSION_REVOKED);
      assert.deepEqual(await readMarks([first, sid, unmarked]), [REVOKED, REVOKED, REVOKED]);
      assert.deepEqual(versions, [`${prefix}${TABLE.AUDIT_LOGS}`]);
    });
  });
});
