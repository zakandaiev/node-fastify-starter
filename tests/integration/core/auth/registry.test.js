import {
  isSessionAlive,
  markSessionAlive,
  markSessionsRevoked,
  watchRevokedSessions,
} from '#core/auth/registry.js';
import { createContext, runInContext } from '#core/context/index.js';
import { DbError } from '#core/db/error.js';
import { createDb } from '#core/db/index.js';
import { afterCommit, withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { TABLE } from '#enums/table.js';
import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import {
  createAclUser,
  createTcpProxy,
  createTestRedis,
  FAST_RECONNECT,
  REDIS_DOWN_ENV,
  waitUntilReady,
} from '#root/tests/helper/redis.js';
import { getServiceAddress } from '#root/tests/helper/service.js';
import { listUntold, toRegistryKey, untoldOf } from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { addToDate, nowUtc } from '#utils/date.js';
import { sha256 } from '#utils/hash.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const LOOPBACK = '127.0.0.1';
const USER_ID = uuidv7();

const INSERT_USER_SQL = 'INSERT INTO users (id) VALUES (:id)';
const INSERT_SESSION_SQL = `
  INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, revoked_at)
  VALUES (:sid, :userId, :refreshTokenHash, :expiresAt, :revokedAt)
`;
const REVOKE_SQL = 'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = :sid';
const DELETE_SQL = 'DELETE FROM sessions WHERE id = :sid';

const ACCESS_TTL_SECONDS = 300;
const ACCESS_TTL_MS = 300_000;
const TTL_SLACK_MS = 5000;

// What a process has found alive it keeps for the whole test: only a message or a revocation of its own ends it there.
const AUTH = Object.freeze({ accessTtl: '5m', registryMemoryTtl: '1h' });
const SHORT_MEMORY = Object.freeze({ registryMemoryTtl: '0.3s' });
const SHORT_READ_TIMEOUT = Object.freeze({ readTimeout: '1s' });
const SHORT_STATEMENT_TIMEOUT = Object.freeze({ statementTimeout: '0.3s' });

const LONG_LIFE = '30d';
const SHORT_LIFE = '90s';
const SHORT_LIFE_SECONDS = 90;
const SHORT_LIFE_MS = 90_000;
const ENDED_LIFE = '-1h';

// A command held on a frozen connection must not time out before the test lets it go.
const PATIENT = Object.freeze({ commandTimeout: '10s', socketTimeout: '20s' });
const IMPATIENT = Object.freeze({ ...FAST_RECONNECT, commandTimeout: '0.3s', socketTimeout: '0.6s' });

// A command that hangs times out, and the connection it hangs on stays.
const HANGING = Object.freeze({ commandTimeout: '0.3s', socketTimeout: '20s' });

const NO_SET_RULES = Object.freeze(['+@all', '-set']);
const NO_PUBLISH_RULES = Object.freeze(['+@all', '-publish']);

// A held check that a regression never lets go of fails its test at this, instead of holding the run for ever.
const HANG_TIMEOUT_MS = 20_000;

const NO_MARK = Object.freeze({ value: null, ttlMs: -2 });

async function insertSession({ life = LONG_LIFE, isRevoked = false } = {}) {
  const sid = uuidv7();

  await testDb.readRows(INSERT_SESSION_SQL, {
    sid,
    userId: USER_ID,
    refreshTokenHash: sha256(sid),
    expiresAt: addToDate(nowUtc(), life),
    revokedAt: isRevoked
      ? nowUtc()
      : null,
  });

  return sid;
}

function revokeRow(sid) {
  return testDb.readRows(REVOKE_SQL, { sid });
}

// The read has been made by the time it is held: what is committed after that is not in it.
function holdAnswers() {
  const reached = Promise.withResolvers();
  const released = Promise.withResolvers();

  async function query(...args) {
    const result = await testDb.db.query(...args);

    reached.resolve();
    await released.promise;

    return result;
  }

  return { db: { ...testDb.db, query }, reached: reached.promise, release: released.resolve };
}

// The connection is open before the test freezes it: a check that had to open one would wait for that, not for its read.
async function openProxiedDb(t) {
  const proxy = await createTcpProxy(t, getServiceAddress('mariadb'));
  const pool = testDb.open({ env: { APP_DATABASE_HOST: LOOPBACK, APP_DATABASE_PORT: String(proxy.port) } }, t);

  await pool.db.ping();

  return { proxy, db: pool.db };
}

// The server names the command a connection has run last, which tells that it is done also while its answer is held.
function waitForCommand(clientId, name) {
  return waitFor(async () => (await testRedis.admin.client('LIST', 'ID', clientId)).includes(` cmd=${name} `), `Redis to run ${name}`);
}

function waitForRefusal(instance, sid) {
  return waitFor(async () => !(await instance.check(sid)), 'the process to refuse the session');
}

function assertMark(mark, value, limitMs) {
  assert.equal(mark.value, value);
  assert.ok(mark.ttlMs > limitMs - TTL_SLACK_MS && mark.ttlMs <= limitMs, `${mark.ttlMs} ms left of ${limitMs}`);
}

function openMarks(keyPrefix) {
  function toKey(sid) {
    return toRegistryKey(keyPrefix, sid);
  }

  async function readMark(sid) {
    const [value, ttlMs] = await Promise.all([testRedis.admin.get(toKey(sid)), testRedis.admin.pttl(toKey(sid))]);

    return { value, ttlMs };
  }

  function dropMark(sid) {
    return testRedis.admin.unlink(toKey(sid));
  }

  return { readMark, dropMark };
}

// A subscription is in place once Redis counts it: a message published before that would be lost.
async function listen(context, listening) {
  const channel = context.redis.toChannel('auth:revoke');

  watchRevokedSessions(context);
  listening.count += 1;
  await waitFor(async () => (await testRedis.admin.pubsub('NUMSUB', channel))[1] === listening.count, 'the subscription');
}

// The processes of one test: the keys and the channel of a prefix of their own, so that nobody else listens there.
function createDeployment(t) {
  const keyPrefix = `${testRedis.keyPrefix}${uuidv7()}:`;
  const listening = { count: 0 };

  async function open({
    env = {},
    auth = {},
    redis = {},
    db = testDb.db,
    isDown = false,
    isListening = false,
  } = {}) {
    const sink = createLogSink();
    const opened = testRedis.open({
      env: isDown
        ? REDIS_DOWN_ENV
        : env,
      auth: { ...AUTH, ...auth },
      redis: { ...redis, keyPrefix },
      logger: { level: 'info', stream: sink.stream },
    });
    const context = createContext({ ...opened.context, db });

    t.after(() => opened.redis.close());

    if (!isDown) {
      await waitUntilReady(opened.redis);
    }

    if (isListening) {
      await listen(context, listening);
    }

    return {
      sink,
      redis: opened.redis,
      check: (sid) => runInContext(context, () => isSessionAlive(sid)),
      markAlive: (sid, ttlSeconds) => runInContext(context, () => markSessionAlive(sid, ttlSeconds)),
      markRevoked: (sids) => runInContext(context, () => markSessionsRevoked(sids)),
    };
  }

  return { open, ...openMarks(keyPrefix) };
}

describe('the registry of sessions', { skip: testRedis.skip || testDb.skip }, () => {
  before(async () => {
    await up();
    await testDb.readRows(INSERT_USER_SQL, { id: USER_ID });
  });

  describe('a session without a mark', () => {
    test('a live row is found, and its mark is written back for as long as an access token lives, or as long as the session has left', async (t) => {
      const { open, readMark } = createDeployment(t);
      const [first, second] = [await open(), await open()];
      const [long, short] = [await insertSession(), await insertSession({ life: SHORT_LIFE })];

      assert.deepEqual(await mapSeries([long, short], first.check), [true, true]);
      assertMark(await readMark(long), '1', ACCESS_TTL_MS);
      assertMark(await readMark(short), '1', SHORT_LIFE_MS);

      await testDb.readRows(DELETE_SQL, { sid: long });

      assert.equal(await second.check(long), true, 'The mark answers the other process, not the row');
    });

    test('a row that is expired, revoked or not there is refused, and gets no mark', async (t) => {
      const { open, readMark } = createDeployment(t);
      const first = await open();
      const sids = [await insertSession({ life: ENDED_LIFE }), await insertSession({ isRevoked: true }), uuidv7()];

      assert.deepEqual(await mapSeries(sids, first.check), [false, false, false]);
      assert.deepEqual(await Promise.all(sids.map((sid) => readMark(sid))), [NO_MARK, NO_MARK, NO_MARK]);
    });

    test('a Redis that has lost its marks costs a question to the database: a live session goes on, a revoked one stays refused', async (t) => {
      const { open, readMark, dropMark } = createDeployment(t);
      const [first, second] = [await open(), await open()];
      const [live, revoked] = [await insertSession(), await insertSession()];

      await Promise.all([live, revoked].map((sid) => first.markAlive(sid, ACCESS_TTL_SECONDS)));
      await revokeRow(revoked);
      await first.markRevoked([revoked]);
      await Promise.all([live, revoked].map((sid) => dropMark(sid)));

      assert.deepEqual(await mapSeries([live, revoked], second.check), [true, false]);
      assertMark(await readMark(live), '1', ACCESS_TTL_MS);
      assert.deepEqual(await readMark(revoked), NO_MARK);
    });
  });

  describe('a revocation', () => {
    test('the process that revokes refuses at once, another one within the message, and Redis keeps a "0" for as long as an access token lives', async (t) => {
      const { open, readMark } = createDeployment(t);
      const [first, second] = [await open({ isListening: true }), await open({ isListening: true })];
      const sids = [await insertSession(), await insertSession()];
      const other = await insertSession();

      assert.deepEqual(await mapSeries([...sids, other], first.check), [true, true, true]);
      assert.deepEqual(await mapSeries([...sids, other], second.check), [true, true, true]);

      await Promise.all(sids.map((sid) => revokeRow(sid)));

      assert.equal(await first.markRevoked(sids), true);
      assert.deepEqual(await mapSeries([...sids, other], first.check), [false, false, true]);

      await Promise.all(sids.map((sid) => waitForRefusal(second, sid)));

      assert.equal(await second.check(other), true);

      const marks = await Promise.all(sids.map((sid) => readMark(sid)));

      marks.forEach((mark) => assertMark(mark, '0', ACCESS_TTL_MS));
      assert.deepEqual(listUntold(first.sink), []);
    });

    test('a "0" replaces a mark of life, whatever that has left, with the whole time of an access token', async (t) => {
      const { open, readMark } = createDeployment(t);
      const [first, second] = [await open(), await open()];
      const sid = await insertSession();

      await first.markAlive(sid, SHORT_LIFE_SECONDS);

      assertMark(await readMark(sid), '1', SHORT_LIFE_MS);

      await first.markRevoked([sid]);

      assertMark(await readMark(sid), '0', ACCESS_TTL_MS);
      assert.equal(await second.check(sid), false);
    });

    test('a process that hears no messages refuses once its memory of the live session has ended', async (t) => {
      const { open } = createDeployment(t);
      const [first, forgetful, mindful] = [await open(), await open({ auth: SHORT_MEMORY }), await open()];
      const sid = await insertSession();

      assert.deepEqual(await mapSeries([first, forgetful, mindful], (instance) => instance.check(sid)), [true, true, true]);

      await revokeRow(sid);
      await first.markRevoked([sid]);
      await waitForRefusal(forgetful, sid);

      assert.equal(await first.check(sid), false);
      assert.equal(await mindful.check(sid), true, 'Nothing but its memory stands between a process and the mark');
    });

    test('a revocation that is not committed yet leaves the session alive, and the mark of life written meanwhile ends with the commit', async (t) => {
      const { open, readMark } = createDeployment(t);
      const [first, second] = [await open(), await open({ isListening: true })];
      const sid = await insertSession();
      const seen = [];

      await testDb.run(() => withTransaction(async () => {
        await testDb.db.query(REVOKE_SQL, { sid });
        seen.push(await first.check(sid), await second.check(sid), (await readMark(sid)).value);
        await afterCommit(() => first.markRevoked([sid]));
      }));

      assert.deepEqual(seen, [true, true, '1']);
      assert.equal(await first.check(sid), false);
      await waitForRefusal(second, sid);
      assertMark(await readMark(sid), '0', ACCESS_TTL_MS);
    });

    test('a check whose "1" from Redis is still on its way when the message comes is refused, and a check beside it does not wait', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { open } = createDeployment(t);
      const [first, second] = [await open(), await open({ redis: PATIENT, isListening: true })];
      const [sid, witness] = [await insertSession(), await insertSession()];
      const { client } = second.redis;

      await Promise.all([sid, witness].map((marked) => first.markAlive(marked, ACCESS_TTL_SECONDS)));

      assert.equal(await second.check(witness), true);

      // After the GET of the witness: the one waited for below must be the next the connection runs.
      const clientId = await client.client('ID');

      client.stream.pause();

      const checking = second.check(sid);

      await waitForCommand(clientId, 'get');
      await Promise.all([sid, witness].map((revoked) => revokeRow(revoked)));
      await first.markRevoked([sid, witness]);
      await waitForRefusal(second, witness);

      assert.equal(await second.check(sid), false);

      client.stream.resume();

      assert.equal(await checking, false);
      assert.equal(await second.check(sid), false);
    });

    test('a check whose "alive" from the database is still on its way when the message comes is refused, and a check beside it does not wait', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { open, readMark } = createDeployment(t);
      const held = holdAnswers();
      const [first, second] = [await open(), await open({ isListening: true, db: held.db })];
      const [sid, witness] = [await insertSession({ life: SHORT_LIFE }), await insertSession()];

      await first.markAlive(witness, ACCESS_TTL_SECONDS);

      assert.equal(await second.check(witness), true);

      const checking = second.check(sid);

      await held.reached;
      await Promise.all([sid, witness].map((revoked) => revokeRow(revoked)));
      await first.markRevoked([sid, witness]);
      await waitForRefusal(second, witness);

      assert.equal(await second.check(sid), false);

      held.release();

      assert.equal(await checking, false);
      assert.equal(await second.check(sid), false);
      assertMark(await readMark(sid), '0', SHORT_LIFE_MS);
    });
  });

  // The rows are left live here, so nothing but the "0" refuses, and a mark that comes too late is seen by the time
  // it gives the "0": what the session has left, not what an access token has.
  describe('a mark of life that comes after the revocation', () => {
    test('the mark of a sign-in or of a refresh leaves the "0", and every process refuses', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { open, readMark } = createDeployment(t);
      const proxy = await createTcpProxy(t, getServiceAddress('redis'));
      const first = await open({ env: proxy.env, redis: PATIENT, isListening: true });
      const second = await open();
      const [created, refreshed] = [await insertSession(), await insertSession()];
      const sids = [created, refreshed];

      await second.markAlive(refreshed, ACCESS_TTL_SECONDS);
      proxy.freeze();

      const marking = Promise.all(sids.map((sid) => first.markAlive(sid, SHORT_LIFE_SECONDS)));

      await second.markRevoked(sids);

      const marksBefore = await Promise.all(sids.map((sid) => readMark(sid)));

      proxy.thaw();

      assert.deepEqual(await marking, [true, true]);

      const marksAfter = await Promise.all(sids.map((sid) => readMark(sid)));

      marksBefore.forEach((mark) => assertMark(mark, '0', ACCESS_TTL_MS));
      marksAfter.forEach((mark) => assertMark(mark, '0', SHORT_LIFE_MS));
      assert.deepEqual(await mapSeries(sids, second.check), [false, false]);
      await Promise.all(sids.map((sid) => waitForRefusal(first, sid)));

      const restarted = await open();

      assert.deepEqual(await mapSeries(sids, restarted.check), [false, false]);
    });

    test('a write-back held on its way to Redis while the session is revoked leaves the "0", and both processes refuse', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { open, readMark } = createDeployment(t);
      const proxy = await createTcpProxy(t, getServiceAddress('redis'));
      const held = holdAnswers();
      const first = await open({
        env: proxy.env,
        redis: PATIENT,
        db: held.db,
        isListening: true,
      });
      const second = await open();
      const sid = await insertSession({ life: SHORT_LIFE });
      const checking = first.check(sid);

      await held.reached;
      proxy.freeze();
      held.release();
      await second.markRevoked([sid]);

      assertMark(await readMark(sid), '0', ACCESS_TTL_MS);

      proxy.thaw();
      await checking;

      assertMark(await readMark(sid), '0', SHORT_LIFE_MS);
      assert.equal(await second.check(sid), false);
      await waitForRefusal(first, sid);

      const restarted = await open();

      assert.equal(await restarted.check(sid), false);
    });
  });

  describe('a Redis that takes one half of a revocation', () => {
    async function openRestricted(t, open, rules) {
      const account = await createAclUser(testRedis.admin, rules);
      const instance = await open({ env: account.env });

      t.after(() => account.remove());

      return instance;
    }

    test('a Redis that refuses the marks still passes the message on', async (t) => {
      const { open, readMark } = createDeployment(t);
      const revoker = await openRestricted(t, open, NO_SET_RULES);
      const other = await open({ isListening: true });
      const sid = await insertSession();

      assert.equal(await other.check(sid), true);

      await revokeRow(sid);

      assert.equal(await revoker.markRevoked([sid]), false);
      assert.equal(await revoker.check(sid), false);
      await waitForRefusal(other, sid);
      assertMark(await readMark(sid), '1', ACCESS_TTL_MS);
      assert.deepEqual(listUntold(revoker.sink), [untoldOf([sid])]);
    });

    test('a Redis that refuses the message still keeps the marks: the others refuse once their memory has ended', async (t) => {
      const { open, readMark } = createDeployment(t);
      const revoker = await openRestricted(t, open, NO_PUBLISH_RULES);
      const other = await open({ isListening: true, auth: SHORT_MEMORY });
      const sid = await insertSession();

      assert.equal(await other.check(sid), true);

      await revokeRow(sid);

      assert.equal(await revoker.markRevoked([sid]), false);
      assert.equal(await revoker.check(sid), false);
      assertMark(await readMark(sid), '0', ACCESS_TTL_MS);
      await waitForRefusal(other, sid);
      assert.deepEqual(listUntold(revoker.sink), [untoldOf([sid])]);
    });
  });

  describe('a Redis that is away', () => {
    test('with Redis down the database decides: a live session is alive, one that is expired, revoked or not there is refused', async (t) => {
      const { open } = createDeployment(t);
      const first = await open({ isDown: true });
      const sids = [
        await insertSession(),
        await insertSession({ life: ENDED_LIFE }),
        await insertSession({ isRevoked: true }),
        uuidv7(),
      ];

      assert.deepEqual(await mapSeries(sids, first.check), [true, false, false, false]);
    });

    test('with Redis down the process that revokes refuses at once and names the sessions nobody was told of, another one refuses once its memory has ended', async (t) => {
      const { open } = createDeployment(t);
      const [first, second] = [await open({ isDown: true }), await open({ isDown: true, auth: SHORT_MEMORY })];
      const [sid, other] = [await insertSession(), await insertSession()];

      assert.deepEqual(await mapSeries([sid, other], first.check), [true, true]);
      assert.deepEqual(await mapSeries([sid, other], second.check), [true, true]);

      await revokeRow(sid);

      assert.equal(await first.markRevoked([sid]), false);
      assert.deepEqual(await mapSeries([sid, other], first.check), [false, true]);
      assert.deepEqual(listUntold(first.sink), [untoldOf([sid])]);

      await waitForRefusal(second, sid);

      assert.equal(await second.check(other), true);
    });

    test('a connection lost with a question and two marks on their way throws nothing: the database answers, neither mark is there, and the process refuses what it has revoked', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { open, readMark } = createDeployment(t);
      const proxy = await createTcpProxy(t, getServiceAddress('redis'));
      const first = await open({ env: proxy.env, redis: IMPATIENT });
      const [live, created, revoked] = [await insertSession(), await insertSession(), await insertSession()];

      proxy.freeze();

      const answers = Promise.all([first.check(live), first.markAlive(created, ACCESS_TTL_SECONDS), first.markRevoked([revoked])]);

      proxy.kill();
      proxy.thaw();

      assert.deepEqual(await answers, [true, false, false]);
      assert.equal(await first.check(revoked), false);
      assert.deepEqual(await Promise.all([live, created, revoked].map((sid) => readMark(sid))), [NO_MARK, NO_MARK, NO_MARK]);
      assert.deepEqual(listUntold(first.sink), [untoldOf([revoked])]);
    });

    test('a revocation that hangs on its way is refused at once by its own process, is named in the log, and reaches the others when Redis goes on', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { open, readMark } = createDeployment(t);
      const proxy = await createTcpProxy(t, getServiceAddress('redis'));
      const first = await open({ env: proxy.env, redis: HANGING });
      const second = await open({ isListening: true });
      const sid = await insertSession();

      assert.deepEqual([await first.check(sid), await second.check(sid)], [true, true]);

      await revokeRow(sid);
      proxy.freeze();

      const marking = first.markRevoked([sid]);

      assert.equal(await first.check(sid), false);
      assert.equal(await marking, false);
      assert.deepEqual(listUntold(first.sink), [untoldOf([sid])]);

      proxy.thaw();
      await waitForRefusal(second, sid);

      assertMark(await readMark(sid), '0', ACCESS_TTL_MS);
    });

    test('a revocation made while Redis was away leaves its mark of life no longer than an access token lives, and the process that made it refuses also once Redis is back', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { open, readMark, dropMark } = createDeployment(t);
      const proxy = await createTcpProxy(t, getServiceAddress('redis'));
      const first = await open({ env: proxy.env, redis: IMPATIENT });
      const second = await open({ isListening: true, auth: SHORT_MEMORY });
      const sid = await insertSession();

      assert.deepEqual([await first.check(sid), await second.check(sid)], [true, true]);

      proxy.freeze();
      proxy.kill();
      await waitFor(() => !first.redis.isReady(), 'the client to lose Redis');
      await revokeRow(sid);

      assert.equal(await first.markRevoked([sid]), false);
      assert.equal(await first.check(sid), false);
      assert.deepEqual(listUntold(first.sink), [untoldOf([sid])]);

      proxy.thaw();
      await waitUntilReady(first.redis);

      assert.equal(await first.check(sid), false);
      assertMark(await readMark(sid), '1', ACCESS_TTL_MS);
      assert.equal(await second.check(sid), true, 'The bound of a revocation Redis could not be told of');

      await dropMark(sid);
      await waitForRefusal(second, sid);

      assert.deepEqual(await readMark(sid), NO_MARK);
    });
  });

  describe('a database that fails', () => {
    test('a database that goes silent costs a check readTimeout and a 503, and the next one is answered as soon as it speaks again', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { open, readMark } = createDeployment(t);
      const { proxy, db } = await openProxiedDb(t);
      const first = await open({ db, auth: SHORT_READ_TIMEOUT });
      const sid = await insertSession();

      proxy.freeze();

      const error = await rejectionOf(first.check(sid));

      assert.ok(error instanceof AppError);
      assert.deepEqual([error.code, error.statusCode, error.cause.code], ['SERVICE_UNAVAILABLE_ERROR', 503, 'READ_TIMEOUT']);
      assert.deepEqual(await readMark(sid), NO_MARK);

      proxy.thaw();

      assert.equal(await first.check(sid), true);
      assertMark(await readMark(sid), '1', ACCESS_TTL_MS);
    });

    test('a read the server cuts at statementTimeout is its 503 as it is, with the timeout as its cause, and the next check is answered', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { open } = createDeployment(t);
      const keeper = await testDb.openKeeper(t);
      const { db } = testDb.open({ db: SHORT_STATEMENT_TIMEOUT }, t);
      const first = await open({ db });
      const sid = await insertSession();

      await keeper.lockTables([TABLE.SESSIONS], 'WRITE');

      const error = await rejectionOf(first.check(sid));

      await keeper.release();

      assert.ok(error instanceof AppError);
      assert.ok(error.cause instanceof DbError);
      assert.deepEqual([error.code, error.statusCode, error.cause.kind], ['SERVICE_UNAVAILABLE_ERROR', 503, DB_ERROR_KIND.TIMEOUT]);
      assert.equal(await first.check(sid), true);
    });

    test('a connection lost in the middle of the read is a 503 with its error as the cause, and the next check takes another connection', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const { open } = createDeployment(t);
      const { proxy, db } = await openProxiedDb(t);
      const first = await open({ db });
      const sid = await insertSession();

      proxy.freeze();

      const checking = rejectionOf(first.check(sid));

      await waitFor(() => db.getStats().activeCount === 1, 'the read to be on its way');
      proxy.kill();
      proxy.thaw();

      const error = await checking;

      assert.ok(error instanceof AppError);
      assert.ok(error.cause instanceof DbError);
      assert.deepEqual([error.code, error.statusCode, error.cause.isFatal], ['SERVICE_UNAVAILABLE_ERROR', 503, true]);
      assert.equal(await first.check(sid), true);
    });

    test('a database without the table is the error it is, not a 503: it is there, and somebody has to be told', async (t) => {
      const { open } = createDeployment(t);
      const neighbour = await testDb.createNeighbour(t);
      const db = createDb(createTestConfig({ env: { APP_DATABASE_NAME: neighbour } }).db);

      t.after(() => db.close());

      const first = await open({ db });
      const error = await rejectionOf(first.check(uuidv7()));

      assert.ok(error instanceof DbError);
      assert.equal(error.code, 'ER_NO_SUCH_TABLE');
    });
  });
});
