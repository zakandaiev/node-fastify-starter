import { settleAlerts } from '#core/alert/index.js';
import { refreshSession } from '#core/auth/refresh.js';
import { DbError } from '#core/db/error.js';
import { AppError } from '#core/error/index.js';
import { COOKIE } from '#enums/cookie.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { TABLE } from '#enums/table.js';
import { accept, createAlertReceiver, readTitles } from '#root/tests/helper/alert.js';
import { errorBody } from '#root/tests/helper/app.js';
import { rejectionOf, timeIt, waitFor } from '#root/tests/helper/async.js';
import { TEST_ENV } from '#root/tests/helper/config.js';
import {
  createDownEnv,
  createGate,
  createTestDb,
  findSessionId,
  killSession,
} from '#root/tests/helper/db.js';
import { findLogLines, forgetLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTcpProxy } from '#root/tests/helper/redis.js';
import { getServiceAddress } from '#root/tests/helper/service.js';
import {
  AUTH_COOKIES,
  openLoggedApp,
  readAuthCookies,
  readSessionRow,
  runInApp,
  signIn,
  takeRefreshCookie,
  toBearer,
} from '#root/tests/helper/session.js';
import { convertStringToMs } from '#utils/date.js';
import { sha256 } from '#utils/hash.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { before, describe, test } from 'node:test';

const testDb = await createTestDb();
const { openKeeper } = testDb;
const { up } = bindMigrator(testDb);

const LOOPBACK = '127.0.0.1';
const REFRESH_URL = '/api/v1/auth/refresh';
const ME_URL = '/api/v1/auth/me';

const REPLAY_MESSAGE = 'A refresh token that had been replaced was used again';
const RETRY_MESSAGE = 'The token of a session is set again after a lock conflict';
const ABANDONED_MESSAGE = 'Every client that asked for a rotation had gone by the time it was done';
const INCOMING_MESSAGE = 'incoming request';
const REQUEST_FAILED_MESSAGE = 'Request failed';

const SERVER_ERROR_TITLE = 'Server error (5xx)';
const CONNECTION_TITLE = 'Database connection failed';
const REPLAY_TITLE = 'Refresh token replay';

const REQUEST = Object.freeze({ headers: Object.freeze({ [HEADER.USER_AGENT]: 'refresh-failure-agent' }), ip: '198.51.100.23' });
const LATE_REQUEST = Object.freeze({ headers: Object.freeze({ [HEADER.USER_AGENT]: 'late-agent' }), ip: '198.51.100.24' });

// For an app that is only to fail: too short for one that has to answer on a busy machine.
const SHORT_TIMEOUT = '0.3s';
const TIMEOUT = '1s';

// Below every limit a test leaves as it is.
const PROMPT_MS = 2500;

// A timer may fire a little before its time by the other clock.
const TIMER_SLACK_MS = 5;

// The server counts the wait for a lock in whole seconds.
const LOCK_WAIT = Object.freeze({ lockWaitTimeout: '1s' });

const POOL_OF_ONE = Object.freeze({ connectionLimit: 1 });

// The first moments at which a refresh asks about its client: the third is behind Redis.
const ASK = Object.freeze({ BEFORE_UPDATE: 1, BEHIND_UPDATE: 2 });

const LOCK_WAIT_CODE = 'ER_LOCK_WAIT_TIMEOUT';

// A few sessions at the server for each of them.
const CONCURRENT_TESTS = 3;

// A call that must settle and does not is a test that never ends: the limit turns it into a failure.
const HANG_TIMEOUT_MS = 15000;

const MS_IN_SECOND = 1000;

const SCOPES_READ = `FROM ${TABLE.USER_GROUPS}`;

// What a rotation that has been taken back leaves as it was.
const TOKEN_COLUMNS = Object.freeze(['refresh_token_hash', 'expires_at', 'revoked_at']);

const AUDIT_IPS_SQL = 'SELECT ip FROM audit_logs WHERE entity_id = :sid';
const COUNT_AUDITS_SQL = 'SELECT COUNT(*) AS total FROM audit_logs WHERE entity_id = :sid';
const START_SQL = 'UPDATE sessions SET started_at = :startedAt WHERE id = :sid';
const SHORTEN_SQL = 'UPDATE sessions SET expires_at = expires_at - INTERVAL 1 HOUR WHERE id = :sid';
const REVOKE_SQL = 'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = :sid';

// The tables belong to the file, not to its first suite: a test that is run alone by its name needs them too.
if (!testDb.skip) {
  before(() => up());
}

function openApp(t, options) {
  return openLoggedApp(t, testDb, options);
}

async function openProxiedApp(t, sections) {
  const proxy = await createTcpProxy(t, getServiceAddress('mariadb'));
  const opened = await openApp(t, { ...sections, env: proxy.databaseEnv });

  return { ...opened, proxy };
}

function refreshIn(fastify, token, options) {
  return runInApp(fastify, () => refreshSession({ token, request: REQUEST, ...options }));
}

function postRefresh(fastify, token) {
  return fastify.inject({ method: HTTP_METHOD.POST, url: REFRESH_URL, cookies: { [COOKIE.REFRESH_TOKEN]: token } });
}

function readRow(sid) {
  return readSessionRow(testDb, sid);
}

async function countAudits(sid) {
  const [{ total }] = await testDb.readRows(COUNT_AUDITS_SQL, { sid });

  return total;
}

// An hour less to live than a rotation gives: the end of the row is told from that of the next pair.
async function openSession(fastify) {
  const { userId, sid, issued } = await signIn(fastify);

  await testDb.readRows(SHORTEN_SQL, { sid });

  return {
    userId, sid, token: issued.refreshToken, row: await readRow(sid),
  };
}

// The token is the one that has been replaced.
async function openReplaced(fastify) {
  const { sid, issued } = await signIn(fastify);
  const current = await refreshIn(fastify, issued.refreshToken);

  return {
    sid, token: issued.refreshToken, current, row: await readRow(sid),
  };
}

// What became of each UPDATE of a session the app has sent: the code it failed with, or the rows it has changed.
function readUpdates(sink) {
  return sink.lines
    .filter((line) => line.sql?.includes('UPDATE sessions'))
    .map((line) => line.code ?? line.rowsCount);
}

function readVerbs(sink) {
  return sink.lines
    .filter((line) => line.sql !== undefined)
    .map((line) => line.sql.trim().split(' ')[0]);
}

function readTakeBacks(sink) {
  return findLogLines(sink, ABANDONED_MESSAGE).map((line) => pick(line, ['level', 'sid', 'isTakenBack']));
}

function assertUnavailable(error) {
  assert.equal(error.constructor, AppError);
  assert.equal(error.code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
}

function assertUnavailableBy(error, cause) {
  assertUnavailable(error);
  assert.equal(error.cause.constructor, DbError);
  assert.deepEqual(pick({ ...error.cause }, Object.keys(cause)), cause);
}

function assertTimedOut(error) {
  assertUnavailableBy(error, { kind: 'timeout', code: 'READ_TIMEOUT' });
}

async function assertRotates(fastify, { sid, token }) {
  const { refreshToken } = await refreshIn(fastify, token);

  assert.equal((await readRow(sid)).refresh_token_hash, sha256(refreshToken));
}

async function assertStillCurrent(fastify, session) {
  assert.deepEqual(await readRow(session.sid), session.row);
  await assertRotates(fastify, session);
}

async function assertTakenBack(fastify, sink, session) {
  const { sid, row } = session;

  assert.deepEqual(readTakeBacks(sink), [{ level: LOG_LEVEL.WARN, sid, isTakenBack: true }]);
  assert.deepEqual(pick(await readRow(sid), TOKEN_COLUMNS), pick(row, TOKEN_COLUMNS));
  await assertRotates(fastify, session);
  assert.equal(await countAudits(sid), 0);
}

function assertSentAgainOnce(sink) {
  assert.deepEqual(findLogLines(sink, RETRY_MESSAGE).map((line) => [line.level, line.err.code]), [[LOG_LEVEL.WARN, LOCK_WAIT_CODE]]);
}

async function assertFoundAgain(fastify, {
  sid, token, current, row,
}) {
  assert.deepEqual(await readRow(sid), row);
  assert.equal(await countAudits(sid), 0);

  const again = await rejectionOf(refreshIn(fastify, token));
  const after = await rejectionOf(refreshIn(fastify, current.refreshToken));

  assert.deepEqual([again, after].map((error) => error.code), [ERROR_CODE.SESSION_REVOKED, ERROR_CODE.SESSION_REVOKED]);
  assert.equal(await countAudits(sid), 1);
}

async function withoutTable(table, fn) {
  await testDb.readRows(`RENAME TABLE ${table} TO ${table}_away`);

  try {
    return await fn();
  } finally {
    await testDb.readRows(`RENAME TABLE ${table}_away TO ${table}`);
  }
}

function findRunning(text) {
  return findSessionId(testDb, text);
}

function findUpdate(sid) {
  return findRunning(`UPDATE sessions%${sid}`);
}

// A refresh on a connection of its own, which its client can close: the server knows by the time leave() resolves.
async function connectClient(t, fastify, token) {
  const gone = Promise.withResolvers();

  fastify.addHook('onRequest', async (request, reply) => {
    reply.raw.once('close', gone.resolve);
  });
  await fastify.listen({ host: LOOPBACK, port: 0 });

  const client = net.connect(fastify.server.address().port, LOOPBACK);

  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write([
    `${HTTP_METHOD.POST} ${REFRESH_URL} HTTP/1.1`,
    `Host: ${TEST_ENV.APP_HOST}`,
    `Cookie: ${COOKIE.REFRESH_TOKEN}=${token}`,
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n'));

  async function leave() {
    client.destroy();
    await gone.promise;
  }

  return { leave };
}

function waitForFailure(sink) {
  return waitFor(() => findLogLines(sink, REQUEST_FAILED_MESSAGE)[0], 'the request to fail');
}

// A client that has gone by the second ask. At the ask of this number the one connection of the pool goes to the gate:
// the UPDATE that is next waits in the queue until the test opens it.
function createLeaver(fastify, gate, blockedAsk) {
  const leaver = { askCount: 0, busy: null };

  function isAbandoned() {
    leaver.askCount += 1;

    if (leaver.askCount === blockedAsk) {
      leaver.busy = fastify.db.query(gate.statement);
    }

    return leaver.askCount >= ASK.BEHIND_UPDATE;
  }

  return Object.assign(leaver, { isAbandoned });
}

async function waitForQueued(fastify, gate) {
  await gate.findWaiter(testDb);
  await waitFor(() => fastify.db.getStats().queueLength === 1, 'the UPDATE to wait for a connection');
}

describe('refreshSession with a database it cannot read', { skip: testDb.skip }, () => {
  const AWAY = [
    ['is down', createDownEnv, { code: 'ECONNREFUSED', isConnectFailure: true }],
    ['does not let the app in', () => ({ APP_DATABASE_PASSWORD: 'a-password-nobody-set' }), { code: 'ER_ACCESS_DENIED_ERROR', isConnectFailure: true }],
  ];

  // The read of the session joins the users.
  const READS = [
    ['session', TABLE.USERS],
    ['scopes', TABLE.USER_GROUPS],
  ];

  AWAY.forEach(([name, readEnv, cause]) => {
    test(`answers 503 when the database ${name}, with the error of the connection as the cause and one alert of it: nothing is rotated`, async (t) => {
      const receiver = await createAlertReceiver(t, accept);
      const { fastify } = await openApp(t);
      const { fastify: cut } = await openApp(t, { receiver, env: await readEnv() });
      const session = await openSession(fastify);
      const error = await rejectionOf(refreshIn(cut, session.token));
      const response = await postRefresh(cut, session.token);

      await settleAlerts(cut.redis);

      assertUnavailableBy(error, cause);
      assert.equal(response.statusCode, HTTP_STATUS.SERVICE_UNAVAILABLE);
      assert.deepEqual(response.json(), errorBody(response, 'SERVICE_UNAVAILABLE_ERROR', 'Service unavailable'));
      assert.equal(response.headers[HEADER.RETRY_AFTER], '60');
      assert.deepEqual(readAuthCookies(response), {});
      assert.deepEqual(readTitles(receiver), [CONNECTION_TITLE]);
      await assertStillCurrent(fastify, session);
    });
  });

  test('gives the same 503 to a request that joined the refresh of another', async (t) => {
    const { fastify } = await openApp(t);
    const { fastify: down } = await openApp(t, { env: await createDownEnv() });
    const session = await openSession(fastify);
    const [first, second] = await Promise.all([refreshIn(down, session.token), refreshIn(down, session.token)].map((refresh) => rejectionOf(refresh)));

    assertUnavailableBy(first, { code: 'ECONNREFUSED', isConnectFailure: true });
    assert.equal(second, first);
    await assertStillCurrent(fastify, session);
  });

  test('answers 503 when the queue of the pool is full', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: { connectionLimit: 1, queueLimit: 0 } });
    const session = await openSession(fastify);
    const busy = runInApp(fastify, () => fastify.db.query(gate.statement));

    await gate.findWaiter(testDb);

    const error = await rejectionOf(refreshIn(fastify, session.token));

    await gate.open();
    await busy;

    assertUnavailableBy(error, { kind: 'overload', code: 'POOL_QUEUE_FULL' });
    assert.deepEqual(readUpdates(sink), []);
    await assertStillCurrent(fastify, session);
  });

  test('answers 503 when the deadline passes over the scopes, which are read after the session', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify } = await openApp(t);
    const { fastify: hurried, sink } = await openApp(t, { auth: { readTimeout: SHORT_TIMEOUT } });
    const session = await openSession(fastify);

    await keeper.lockTables([TABLE.USER_GROUPS], 'WRITE');

    const { result: error, durationMs } = await timeIt(() => rejectionOf(refreshIn(hurried, session.token)));

    await keeper.release();

    assertTimedOut(error);
    assert.ok(durationMs < PROMPT_MS, `${durationMs} ms`);
    assert.deepEqual(readUpdates(sink), []);
    await assertStillCurrent(fastify, session);
  });

  READS.forEach(([name, table]) => {
    test(`answers 503 when the server cuts the read of the ${name} at its own limit, below the deadline`, { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const keeper = await openKeeper(t);
      const { fastify } = await openApp(t);
      const { fastify: hurried, sink } = await openApp(t, { db: { statementTimeout: SHORT_TIMEOUT } });
      const session = await openSession(fastify);

      await keeper.lockTables([table], 'WRITE');

      const { result: error, durationMs } = await timeIt(() => rejectionOf(refreshIn(hurried, session.token)));

      await keeper.release();

      assertUnavailableBy(error, { kind: 'timeout', code: 'ER_STATEMENT_TIMEOUT' });
      assert.ok(durationMs < PROMPT_MS, `${durationMs} ms`);
      assert.deepEqual(readUpdates(sink), []);
      await assertStillCurrent(fastify, session);
    });
  });

  test('leaves the error as it is when the database is there and refuses the statement', async (t) => {
    const { fastify, sink } = await openApp(t);
    const session = await openSession(fastify);
    const error = await withoutTable(TABLE.USER_GROUPS, () => rejectionOf(refreshIn(fastify, session.token)));

    assert.equal(error.constructor, DbError);
    assert.equal(error.code, 'ER_NO_SUCH_TABLE');
    assert.deepEqual(readUpdates(sink), []);
    await assertStillCurrent(fastify, session);
  });
});

describe('refreshSession before its UPDATE', { skip: testDb.skip }, () => {
  const MAX_AGE_MS = convertStringToMs('90d');

  const GONE = [
    ['a client that has given up', 1],
    ['three requests whose clients have all given up', 3],
  ];

  test('makes both tokens: an access token too big for its cookie leaves the row as it was', async (t) => {
    const { fastify } = await openApp(t);
    const { fastify: tight, sink } = await openApp(t, { auth: { accessTokenMaxBytes: 1 } });
    const session = await openSession(fastify);
    const error = await rejectionOf(refreshIn(tight, session.token));

    assert.equal(error.constructor, Error);
    assert.match(error.message, /^The access token takes \d+ bytes, above the 1 a cookie may hold/);
    assert.deepEqual(readUpdates(sink), []);
    await assertStillCurrent(fastify, session);
  });

  GONE.forEach(([name, count]) => {
    test(`answers 503 to ${name}, and rotates nothing`, async (t) => {
      const { fastify, sink } = await openApp(t);
      const session = await openSession(fastify);
      const errors = await Promise.all(Array.from({ length: count }, () => rejectionOf(refreshIn(fastify, session.token, { isAbandoned: () => true }))));

      errors.forEach((error) => assertUnavailable(error));
      assert.deepEqual(readUpdates(sink), []);
      await assertStillCurrent(fastify, session);
    });
  });

  test('asks about the client when every read is done and only the UPDATE is left, right behind it and once more behind Redis: no statement follows', async (t) => {
    const { fastify, sink } = await openApp(t);
    const { token } = await openSession(fastify);
    const asked = [];

    function isAbandoned() {
      asked.push(readVerbs(sink));

      return false;
    }

    forgetLines(sink);
    await refreshIn(fastify, token, { isAbandoned });

    const verbs = readVerbs(sink);

    assert.equal(verbs.at(-1), 'UPDATE');
    assert.deepEqual(asked, [verbs.slice(0, -1), verbs, verbs]);
  });

  test('finds out that a client has closed its connection while the request waited for the database, and rotates nothing', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t);
    const session = await openSession(fastify);

    await keeper.lockTables([TABLE.USER_GROUPS], 'WRITE');

    const client = await connectClient(t, fastify, session.token);

    await findRunning(SCOPES_READ);
    await client.leave();
    await keeper.release();

    const line = await waitForFailure(sink);

    assert.deepEqual([line.level, line.err.code], [LOG_LEVEL.WARN, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR]);
    assert.deepEqual(readUpdates(sink), []);
    await assertStillCurrent(fastify, session);
  });

  // Node destroys the stream of a request once its body is read to the end.
  test('does not take a client that stays on its connection for one that has gone, also when its request had a body', async (t) => {
    const { fastify } = await openApp(t);
    const { sid, token } = await openSession(fastify);

    await fastify.listen({ host: LOOPBACK, port: 0 });

    const response = await fetch(`http://${LOOPBACK}:${fastify.server.address().port}${REFRESH_URL}`, {
      method: HTTP_METHOD.POST,
      headers: { [HEADER.CONTENT_TYPE]: MEDIA_TYPE.JSON, cookie: `${COOKIE.REFRESH_TOKEN}=${token}` },
      body: JSON.stringify({}),
    });
    const { status } = await response.json();

    assert.deepEqual([response.status, status], [HTTP_STATUS.OK, 'success']);
    assert.notEqual((await readRow(sid)).refresh_token_hash, sha256(token));
  });

  test('answers SESSION_REVOKED when the 90 days of the session end while it reads the scopes', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify } = await openApp(t);
    const { sid, token } = await openSession(fastify);
    const now = Math.floor(Date.now() / MS_IN_SECOND) * MS_IN_SECOND;

    await testDb.readRows(START_SQL, { sid, startedAt: new Date(now + MS_IN_SECOND - MAX_AGE_MS) });

    const row = await readRow(sid);

    await keeper.lockTables([TABLE.USER_GROUPS], 'WRITE');

    t.mock.timers.enable({ apis: ['Date'], now });

    const running = rejectionOf(refreshIn(fastify, token));

    await findRunning(SCOPES_READ);
    t.mock.timers.setTime(now + MS_IN_SECOND);
    await keeper.release();

    assert.equal((await running).code, ERROR_CODE.SESSION_REVOKED);
    assert.deepEqual(await readRow(sid), row);
  });

  test('answers 503 when the queue of the pool is full by then, and rotates nothing', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: { connectionLimit: 1, queueLimit: 0 } });
    const session = await openSession(fastify);
    const started = {};

    // The last thing before the UPDATE: the one connection of the pool is taken there.
    function isAbandoned() {
      started.busy = fastify.db.query(gate.statement);

      return false;
    }

    const error = await rejectionOf(refreshIn(fastify, session.token, { isAbandoned }));

    await gate.open();
    await started.busy;

    assertUnavailableBy(error, { kind: 'overload', code: 'POOL_QUEUE_FULL' });
    assert.deepEqual(readUpdates(sink), []);
    await assertStillCurrent(fastify, session);
  });
});

describe('refreshSession for a client that leaves while its row is rotated', { skip: testDb.skip }, () => {
  test('takes the rotation back when the client has closed its connection while the UPDATE waited for the row', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t);
    const session = await openSession(fastify);

    await keeper.holdRow(TABLE.SESSIONS, session.sid);

    const client = await connectClient(t, fastify, session.token);

    await findUpdate(session.sid);
    await client.leave();
    await keeper.release();

    const line = await waitForFailure(sink);

    assert.deepEqual([line.level, line.err.code], [LOG_LEVEL.WARN, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR]);
    assert.deepEqual(readUpdates(sink), [1, 1]);
    await assertTakenBack(fastify, sink, session);
  });

  test('takes the rotation back when the client has left while the UPDATE waited for a connection of the pool', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: POOL_OF_ONE });
    const session = await openSession(fastify);
    const leaver = createLeaver(fastify, gate, ASK.BEFORE_UPDATE);
    const running = rejectionOf(refreshIn(fastify, session.token, { isAbandoned: leaver.isAbandoned }));

    await waitForQueued(fastify, gate);
    await gate.open();
    await leaver.busy;

    assertUnavailable(await running);
    assert.deepEqual(readUpdates(sink), [1, 1]);
    await assertTakenBack(fastify, sink, session);
  });

  test('changes nothing of a session that was revoked before the rotation could be taken back', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: POOL_OF_ONE });
    const { sid, token } = await openSession(fastify);
    const leaver = createLeaver(fastify, gate, ASK.BEHIND_UPDATE);
    const running = rejectionOf(refreshIn(fastify, token, { isAbandoned: leaver.isAbandoned }));

    await waitForQueued(fastify, gate);
    await testDb.readRows(REVOKE_SQL, { sid });

    const row = await readRow(sid);

    await gate.open();
    await leaver.busy;

    assertUnavailable(await running);
    assert.deepEqual(readUpdates(sink), [1, 0]);
    assert.deepEqual(readTakeBacks(sink), [{ level: LOG_LEVEL.WARN, sid, isTakenBack: false }]);
    assert.notEqual(row.revoked_at, null);
    assert.deepEqual(await readRow(sid), row);
    assert.equal((await rejectionOf(refreshIn(fastify, token))).code, ERROR_CODE.SESSION_REVOKED);
    assert.equal(await countAudits(sid), 0);
  });

  test('gives no pair to a request that has come meanwhile when the session was revoked before the rotation could be taken back', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: POOL_OF_ONE });
    const { sid, token } = await openSession(fastify);
    const leaver = createLeaver(fastify, gate, ASK.BEHIND_UPDATE);
    const running = rejectionOf(refreshIn(fastify, token, { isAbandoned: leaver.isAbandoned }));

    await waitForQueued(fastify, gate);

    const joining = rejectionOf(refreshIn(fastify, token));

    await testDb.readRows(REVOKE_SQL, { sid });
    await gate.open();
    await leaver.busy;

    assert.deepEqual([await running, await joining].map((error) => error.code), [ERROR_CODE.AUTHENTICATION_ERROR, ERROR_CODE.AUTHENTICATION_ERROR]);
    assert.deepEqual(readUpdates(sink), [1, 0, 0]);
    assert.deepEqual(readTakeBacks(sink), [{ level: LOG_LEVEL.WARN, sid, isTakenBack: false }]);
    assert.equal((await rejectionOf(refreshIn(fastify, token))).code, ERROR_CODE.SESSION_REVOKED);
    assert.equal(await countAudits(sid), 0);
  });

  test('rotates once more, with the same pair, for a request that has come while the rotation was being taken back: the row holds its client', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: POOL_OF_ONE });
    const { sid, token } = await openSession(fastify);
    const leaver = createLeaver(fastify, gate, ASK.BEHIND_UPDATE);
    const running = rejectionOf(refreshIn(fastify, token, { isAbandoned: leaver.isAbandoned }));

    await waitForQueued(fastify, gate);

    const rotated = await readRow(sid);
    const joining = refreshIn(fastify, token, { request: LATE_REQUEST });

    await gate.open();
    await leaver.busy;

    const { refreshToken } = await joining;

    assert.equal((await running).code, ERROR_CODE.AUTHENTICATION_ERROR);
    assert.deepEqual(readUpdates(sink), [1, 1, 1]);
    assert.deepEqual(readTakeBacks(sink), [{ level: LOG_LEVEL.WARN, sid, isTakenBack: true }]);
    assert.deepEqual([rotated.refresh_token_hash, rotated.user_agent], [sha256(refreshToken), REQUEST.headers[HEADER.USER_AGENT]]);
    assert.deepEqual(pick(await readRow(sid), ['refresh_token_hash', 'expires_at', 'user_agent', 'ip']), {
      refresh_token_hash: rotated.refresh_token_hash,
      expires_at: rotated.expires_at,
      user_agent: LATE_REQUEST.headers[HEADER.USER_AGENT],
      ip: LATE_REQUEST.ip,
    });
    await assertRotates(fastify, { sid, token: refreshToken });
    assert.equal(await countAudits(sid), 0);
  });

  test('takes a rotation back at once beside a sign-in on its way, whatever the hash of the token of that one is', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t, { db: LOCK_WAIT });
    const { userId, sid, token } = await openSession(fastify);
    const neighbour = (BigInt(`0x${sha256(token)}`) + 1n).toString(16).padStart(sha256(token).length, '0');

    await keeper.query('BEGIN');
    await keeper.query('INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (UUID_v7(), ?, ?, UTC_TIMESTAMP(3) + INTERVAL 1 DAY)', [userId, neighbour]);
    forgetLines(sink);

    const leaver = { askCount: 0 };
    const error = await rejectionOf(refreshIn(fastify, token, {
      isAbandoned: () => {
        leaver.askCount += 1;

        return leaver.askCount >= ASK.BEHIND_UPDATE;
      },
    }));

    await keeper.release();

    assertUnavailable(error);
    assert.deepEqual(readUpdates(sink), [1, 1]);
    assert.deepEqual(readTakeBacks(sink), [{ level: LOG_LEVEL.WARN, sid, isTakenBack: true }]);
    assert.equal((await readRow(sid)).refresh_token_hash, sha256(token));
  });

  test('says so when the rotation cannot be taken back, since the queue of the pool is full', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: { connectionLimit: 1, queueLimit: 0 } });
    const { sid, token } = await openSession(fastify);
    const leaver = createLeaver(fastify, gate, ASK.BEHIND_UPDATE);
    const error = await rejectionOf(refreshIn(fastify, token, { isAbandoned: leaver.isAbandoned }));

    await gate.open();
    await leaver.busy;

    assertUnavailableBy(error, { kind: 'overload', code: 'POOL_QUEUE_FULL' });
    assert.deepEqual(readUpdates(sink), [1]);
    assert.deepEqual(readTakeBacks(sink), [{ level: LOG_LEVEL.WARN, sid, isTakenBack: false }]);
  });

  test('gives the pair to a request that has joined when the client that began has closed its connection: the new cookies work, and nobody is told', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await openApp(t, { receiver });
    const { sid, token } = await openSession(fastify);

    await keeper.holdRow(TABLE.SESSIONS, sid);

    const client = await connectClient(t, fastify, token);

    await findUpdate(sid);

    const joining = postRefresh(fastify, token);

    await waitFor(() => findLogLines(sink, INCOMING_MESSAGE).length === 2, 'the second request to come in');
    await client.leave();
    await keeper.release();

    const response = await joining;

    assert.equal(response.statusCode, HTTP_STATUS.OK);
    assert.deepEqual(Object.keys(readAuthCookies(response)).toSorted(), AUTH_COOKIES.toSorted());
    assert.deepEqual(readUpdates(sink), [1]);

    const again = await postRefresh(fastify, takeRefreshCookie(response)[COOKIE.REFRESH_TOKEN]);

    await settleAlerts(fastify.redis);

    assert.equal(again.statusCode, HTTP_STATUS.OK);
    assert.equal(await countAudits(sid), 0);
    assert.deepEqual(readTitles(receiver), []);
  });
});

describe('refreshSession when a wait runs out', { skip: testDb.skip, concurrency: CONCURRENT_TESTS }, () => {
  test('answers 503 to everyone who waits for a read on a connection that went silent, once the deadline has passed: the late answer rotates nothing', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { fastify, sink, proxy } = await openProxiedApp(t, { auth: { readTimeout: TIMEOUT } });
    const session = await openSession(fastify);

    forgetLines(sink);
    proxy.freeze();

    const { result: errors, durationMs } = await timeIt(() => Promise.all([
      rejectionOf(refreshIn(fastify, session.token)),
      rejectionOf(refreshIn(fastify, session.token)),
    ]));

    proxy.thaw();
    await waitFor(() => readVerbs(sink).length > 0, 'the late answer of the read');

    errors.forEach((error) => assertTimedOut(error));
    assert.equal(errors[1], errors[0]);
    assert.ok(durationMs >= convertStringToMs(TIMEOUT) - TIMER_SLACK_MS && durationMs < PROMPT_MS, `${durationMs} ms`);
    assert.deepEqual(readVerbs(sink), ['SELECT']);
    await assertStillCurrent(fastify, session);
  });

  test('answers 503 when the connection for the UPDATE does not open in time, and rotates nothing', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { fastify, sink, proxy } = await openProxiedApp(t, { db: { connectTimeout: TIMEOUT } });
    const session = await openSession(fastify);
    const started = {};

    // The connection that is open goes to another statement, and the database answers no new one.
    function isAbandoned() {
      started.busy = fastify.db.query('SELECT 1 AS alive');
      proxy.freeze();

      return false;
    }

    const error = await rejectionOf(refreshIn(fastify, session.token, { isAbandoned }));

    proxy.thaw();
    await started.busy;

    assertUnavailableBy(error, { code: 'ETIMEDOUT', isConnectFailure: true });
    assert.deepEqual(readUpdates(sink), []);
    await assertStillCurrent(fastify, session);
  });

  test('sends the UPDATE once more when it has waited out the lock of its row, and rotates', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t, { db: LOCK_WAIT });
    const { sid, token } = await openSession(fastify);

    await keeper.holdRow(TABLE.SESSIONS, sid);

    const running = Promise.allSettled([refreshIn(fastify, token)]);

    await waitFor(() => readUpdates(sink).length === 1, 'the first wait to run out');
    await keeper.release();

    const [{ value }] = await running;

    assert.deepEqual(readUpdates(sink), [LOCK_WAIT_CODE, 1]);
    assertSentAgainOnce(sink);
    assert.equal((await readRow(sid)).refresh_token_hash, sha256(value.refreshToken));
  });

  test('answers 503 when the UPDATE has waited out the lock twice, and rotates nothing', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t, { db: LOCK_WAIT });
    const session = await openSession(fastify);

    await keeper.holdRow(TABLE.SESSIONS, session.sid);

    const error = await rejectionOf(refreshIn(fastify, session.token));

    await keeper.release();

    assertUnavailableBy(error, { kind: 'deadlock', code: LOCK_WAIT_CODE });
    assert.deepEqual(readUpdates(sink), [LOCK_WAIT_CODE, LOCK_WAIT_CODE]);
    await assertStillCurrent(fastify, session);
  });

  test('takes the rotation back when the client has left while the UPDATE waited out the lock of its row and was sent once more', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t, { db: LOCK_WAIT });
    const session = await openSession(fastify);
    const client = { isGone: false };

    await keeper.holdRow(TABLE.SESSIONS, session.sid);

    const running = rejectionOf(refreshIn(fastify, session.token, { isAbandoned: () => client.isGone }));

    await findUpdate(session.sid);
    client.isGone = true;
    await waitFor(() => readUpdates(sink).length === 1, 'the first wait to run out');
    await keeper.release();

    assertUnavailable(await running);
    assert.deepEqual(readUpdates(sink), [LOCK_WAIT_CODE, 1, 1]);
    await assertTakenBack(fastify, sink, session);
  });

  test('answers 503 when a rotation cannot be taken back, since its row is held past both waits, and says so', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: { ...LOCK_WAIT, ...POOL_OF_ONE } });
    const { sid, token } = await openSession(fastify);
    const leaver = createLeaver(fastify, gate, ASK.BEHIND_UPDATE);
    const running = rejectionOf(refreshIn(fastify, token, { isAbandoned: leaver.isAbandoned }));

    await waitForQueued(fastify, gate);
    await keeper.holdRow(TABLE.SESSIONS, sid);
    await gate.open();
    await leaver.busy;

    const error = await running;

    await keeper.release();

    assertUnavailableBy(error, { kind: 'deadlock', code: LOCK_WAIT_CODE });
    assert.deepEqual(readUpdates(sink), [1, LOCK_WAIT_CODE, LOCK_WAIT_CODE]);
    assert.deepEqual(readTakeBacks(sink), [{ level: LOG_LEVEL.WARN, sid, isTakenBack: false }]);
    assertSentAgainOnce(sink);
  });

  test('gives the pair to a request that has come while the row of a rotation to be taken back is held past both waits: it is still the current one', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: { ...LOCK_WAIT, ...POOL_OF_ONE } });
    const { sid, token } = await openSession(fastify);
    const leaver = createLeaver(fastify, gate, ASK.BEHIND_UPDATE);
    const running = rejectionOf(refreshIn(fastify, token, { isAbandoned: leaver.isAbandoned }));

    await waitForQueued(fastify, gate);
    await keeper.holdRow(TABLE.SESSIONS, sid);

    const joining = Promise.allSettled([refreshIn(fastify, token)]);

    await gate.open();
    await leaver.busy;

    const [{ value }] = await joining;

    await keeper.release();

    assert.equal((await running).code, ERROR_CODE.AUTHENTICATION_ERROR);
    assert.deepEqual(readUpdates(sink), [1, LOCK_WAIT_CODE, LOCK_WAIT_CODE]);
    assert.deepEqual(readTakeBacks(sink), [{ level: LOG_LEVEL.WARN, sid, isTakenBack: false }]);
    assert.equal((await readRow(sid)).refresh_token_hash, sha256(value.refreshToken));
    await assertRotates(fastify, { sid, token: value.refreshToken });
    assert.equal(await countAudits(sid), 0);
  });

  test('sends the end of a replayed session once more as well, and writes it down once', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t, { db: LOCK_WAIT });
    const { sid, token } = await openReplaced(fastify);

    await keeper.holdRow(TABLE.SESSIONS, sid);

    forgetLines(sink);

    const running = rejectionOf(refreshIn(fastify, token));

    await waitFor(() => readUpdates(sink).length === 1, 'the first wait to run out');
    await keeper.release();

    assert.equal((await running).code, ERROR_CODE.SESSION_REVOKED);
    assert.deepEqual(readUpdates(sink), [LOCK_WAIT_CODE, 1]);
    assert.equal(findLogLines(sink, REPLAY_MESSAGE).length, 1);
    assert.equal(await countAudits(sid), 1);
  });

  test('answers 503 when the end of a replayed session has waited out the lock twice: the warning is there, and the client is found again', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t, { db: LOCK_WAIT });
    const session = await openReplaced(fastify);

    await keeper.holdRow(TABLE.SESSIONS, session.sid);

    forgetLines(sink);

    const error = await rejectionOf(refreshIn(fastify, session.token));

    await keeper.release();

    assertUnavailableBy(error, { kind: 'deadlock', code: LOCK_WAIT_CODE });
    assert.deepEqual(readUpdates(sink), [LOCK_WAIT_CODE, LOCK_WAIT_CODE]);
    assert.equal(findLogLines(sink, REPLAY_MESSAGE).length, 1);
    await assertFoundAgain(fastify, session);
  });
});

// Apart from the suite above, whose tests run side by side: nobody writes while the tables are locked.
describe('refreshSession beside a dump', { skip: testDb.skip }, () => {
  test('answers 503 when its tables stay locked against writes: the wait for a table ends as the one for a row, the UPDATE is sent once more, and nothing is rotated', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t, { db: LOCK_WAIT });
    const session = await openSession(fastify);

    await keeper.lockTables(Object.values(TABLE), 'READ LOCAL');

    const error = await rejectionOf(refreshIn(fastify, session.token));

    await keeper.release();

    assertUnavailableBy(error, { kind: 'deadlock', code: LOCK_WAIT_CODE });
    assert.deepEqual(readUpdates(sink), [LOCK_WAIT_CODE, LOCK_WAIT_CODE]);
    assertSentAgainOnce(sink);
    await assertStillCurrent(fastify, session);
  });
});

describe('refreshSession with a connection lost under its statement', { skip: testDb.skip }, () => {
  test('answers 503 when the statement is a read: nothing is rotated', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t);
    const session = await openSession(fastify);

    await keeper.lockTables([TABLE.USER_GROUPS], 'WRITE');

    const running = rejectionOf(refreshIn(fastify, session.token));

    await killSession(testDb, await findRunning(SCOPES_READ));

    const error = await running;

    await keeper.release();

    assertUnavailableBy(error, { isFatal: true });
    assert.deepEqual(readUpdates(sink), []);
    await assertStillCurrent(fastify, session);
  });

  test('gives the error of the database, never 503, when the statement is the rotation: nobody knows whether it was done, and it is not sent again', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t);
    const session = await openSession(fastify);

    await keeper.holdRow(TABLE.SESSIONS, session.sid);

    const running = rejectionOf(refreshIn(fastify, session.token));

    await killSession(testDb, await findUpdate(session.sid));

    const error = await running;

    await keeper.release();

    assert.equal(error.constructor, DbError);
    assert.deepEqual(pick({ ...error }, ['isFatal', 'isConnectFailure']), { isFatal: true });
    assert.deepEqual(readUpdates(sink), [error.code]);
    await assertStillCurrent(fastify, session);
  });

  test('gives it also to a request that has come meanwhile when the statement takes a rotation back: nobody knows which token is the current one', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: POOL_OF_ONE });
    const { sid, token } = await openSession(fastify);
    const leaver = createLeaver(fastify, gate, ASK.BEHIND_UPDATE);
    const running = rejectionOf(refreshIn(fastify, token, { isAbandoned: leaver.isAbandoned }));

    await waitForQueued(fastify, gate);
    await keeper.holdRow(TABLE.SESSIONS, sid);

    const joining = rejectionOf(refreshIn(fastify, token));

    await gate.open();
    await leaver.busy;
    await killSession(testDb, await findUpdate(sid));

    const errors = [await running, await joining];

    await keeper.release();

    assert.equal(errors[1], errors[0]);
    assert.equal(errors[0].constructor, DbError);
    assert.deepEqual(pick({ ...errors[0] }, ['isFatal', 'isConnectFailure']), { isFatal: true });
    assert.deepEqual(readUpdates(sink), [1, errors[0].code]);
    assert.deepEqual(readTakeBacks(sink), [{ level: LOG_LEVEL.WARN, sid, isTakenBack: false }]);
  });

  test('answers 500 with an alert then, and leaves the cookies alone', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await openApp(t, { receiver });
    const session = await openSession(fastify);

    await keeper.holdRow(TABLE.SESSIONS, session.sid);

    const running = postRefresh(fastify, session.token);

    await killSession(testDb, await findUpdate(session.sid));

    const response = await running;

    await keeper.release();
    await settleAlerts(fastify.redis);

    assert.equal(response.statusCode, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    assert.deepEqual(response.json(), errorBody(response, 'SERVER_ERROR', 'Server error'));
    assert.deepEqual(readAuthCookies(response), {});
    assert.deepEqual(readTitles(receiver), [SERVER_ERROR_TITLE]);
  });

  test('answers 503 when the statement ends a replayed session: the warning is there, and the client is found again', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t);
    const session = await openReplaced(fastify);

    await keeper.holdRow(TABLE.SESSIONS, session.sid);

    forgetLines(sink);

    const running = rejectionOf(refreshIn(fastify, session.token));

    await killSession(testDb, await findUpdate(session.sid));

    const error = await running;

    await keeper.release();

    assertUnavailableBy(error, { isFatal: true });
    assert.deepEqual(readUpdates(sink), [error.cause.code]);
    assert.equal(findLogLines(sink, REPLAY_MESSAGE).length, 1);
    await assertFoundAgain(fastify, session);
  });
});

describe('refreshSession with a replay of a client that has gone', { skip: testDb.skip }, () => {
  // The log of such an app never asks a request for its address, and Node knows none of a socket that has closed.
  test('writes down where it came from, also when nothing else has asked for that before', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t, { level: 'warn' });
    const { sid, token } = await openReplaced(fastify);

    await keeper.holdRow(TABLE.SESSIONS, sid);

    const client = await connectClient(t, fastify, token);

    await findUpdate(sid);
    await client.leave();
    await keeper.release();
    await waitForFailure(sink);

    assert.deepEqual(await testDb.readRows(AUDIT_IPS_SQL, { sid }), [{ ip: LOOPBACK }]);
  });
});

describe('refreshSession with a replay it cannot write down', { skip: testDb.skip }, () => {
  test('does not end the session: the answer is the error of the record, the warning is there, and the client is found again', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await openApp(t, { receiver });
    const session = await openReplaced(fastify);
    const response = await withoutTable(TABLE.AUDIT_LOGS, () => postRefresh(fastify, session.token));
    const state = await fastify.inject({ url: ME_URL, headers: toBearer(session.current.accessToken) });
    const [failed] = findLogLines(sink, REQUEST_FAILED_MESSAGE);

    await settleAlerts(fastify.redis);

    assert.equal(response.statusCode, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    assert.deepEqual(response.json(), errorBody(response, 'SERVER_ERROR', 'Server error'));
    assert.deepEqual(readAuthCookies(response), {});
    assert.deepEqual(pick(failed.err, ['type', 'code']), { type: 'DbError', code: 'ER_NO_SUCH_TABLE' });
    assert.deepEqual(findLogLines(sink, REPLAY_MESSAGE).map((line) => pick(line, ['level', 'sid'])), [{ level: LOG_LEVEL.WARN, sid: session.sid }]);
    assert.equal(state.statusCode, HTTP_STATUS.OK);
    assert.deepEqual(readTitles(receiver), [SERVER_ERROR_TITLE]);

    await assertFoundAgain(fastify, session);
    await settleAlerts(fastify.redis);

    assert.deepEqual(readTitles(receiver), [SERVER_ERROR_TITLE, REPLAY_TITLE]);
  });

  test('answers 503 when its transaction is closed at the deadline, with nothing committed: the warning is there, and the client is found again', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify } = await openApp(t);
    const { fastify: hurried, sink } = await openApp(t, { db: { lockWaitTimeout: '0.1s', transactionTimeout: SHORT_TIMEOUT } });
    const session = await openReplaced(fastify);

    await keeper.lockTables([TABLE.SESSIONS], 'READ');

    const error = await rejectionOf(refreshIn(hurried, session.token));

    await keeper.release();

    assertUnavailableBy(error, { code: 'TRANSACTION_TIMEOUT' });
    assert.equal(findLogLines(sink, REPLAY_MESSAGE).length, 1);
    await assertFoundAgain(fastify, session);
  });
});
