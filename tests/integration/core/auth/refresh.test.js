import { settleAlerts } from '#core/alert/index.js';
import { refreshSession } from '#core/auth/refresh.js';
import { listSessions, revokeAllSessions, revokeSession } from '#core/auth/session.js';
import { createContext, runInContext } from '#core/context/index.js';
import { COOKIE } from '#enums/cookie.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { TABLE } from '#enums/table.js';
import { TOKEN_TYPE } from '#enums/token-type.js';
import { accept, createAlertReceiver } from '#root/tests/helper/alert.js';
import { errorBody, readRequestId, successBody } from '#root/tests/helper/app.js';
import { rejectionOf, timeIt, waitFor } from '#root/tests/helper/async.js';
import { TEST_ENV } from '#root/tests/helper/config.js';
import { createDownEnv, createTestDb } from '#root/tests/helper/db.js';
import { findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import {
  createFakeRedis,
  createTcpProxy,
  createTestRedis,
  FAST_RECONNECT,
  REDIS_DOWN_ENV,
} from '#root/tests/helper/redis.js';
import { getServiceAddress } from '#root/tests/helper/service.js';
import {
  connectAppRedis,
  createUser,
  grantScopes,
  openLoggedApp,
  readAppRows,
  readAuthCookies,
  readClaims,
  readSessionRow,
  runInApp,
  signIn,
  toBearer,
} from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { convertStringToMs, convertStringToSeconds } from '#utils/date.js';
import { encodeBase64Url } from '#utils/encoding.js';
import { hmac, sha256 } from '#utils/hash.js';
import { uuidv7, uuidVersion } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { openKeeper } = testDb;
const { up } = bindMigrator(testDb);

const LOOPBACK = '127.0.0.1';
const REFRESH_URL = '/api/v1/auth/refresh';
const ME_URL = '/api/v1/auth/me';

const REPLAY_MESSAGE = 'A refresh token that had been replaced was used again';
const LOST_MESSAGE = 'A refresh lost the race: the row of its session has changed since it was read, or its pair went to another request';
const ABANDONED_MESSAGE = 'Every client that asked for a rotation had gone by the time it was done';
const REPLAY_TITLE = 'Refresh token replay';

const CLIENT = Object.freeze({ userAgent: 'refresh-test-agent', ip: '198.51.100.23' });
const REQUEST = Object.freeze({ headers: Object.freeze({ [HEADER.USER_AGENT]: CLIENT.userAgent }), ip: CLIENT.ip });
const OTHER_CLIENT = Object.freeze({ userAgent: 'other-agent', ip: '198.51.100.24' });
const OTHER_REQUEST = Object.freeze({ headers: Object.freeze({ [HEADER.USER_AGENT]: OTHER_CLIENT.userAgent }), ip: OTHER_CLIENT.ip });

const ALGORITHM = 'HS256';
const BASE64URL = 'base64url';
const NEXT_SECRET = 'next-refresh-secret-0123456789-abcdef';
const TOKEN_SECONDS = 60;
const EXPIRED_SECONDS = -60;

const UUID_V7 = 7;
const MS_IN_SECOND = 1000;
const USER_AGENT_COLUMN_LENGTH = 255;

// The clock of the database is not the clock of the host.
const CLOCK_SLACK_MS = 5000;
const TTL_SLACK_MS = 5000;

const CLOCK_LAG_MS = convertStringToMs('5m');

// Below the deadline of a channel of alerts: an answer that waited for one would take that long.
const PROMPT_MS = 5000;

// A call that must settle and does not is a test that never ends: the limit turns it into a failure.
const HANG_TIMEOUT_MS = 10000;

const AUDIT_SQL = 'SELECT actor_id, action, entity_type, entity_id, meta, ip, request_id FROM audit_logs WHERE entity_id = :sid';

// An hour back in every date of the row: what a rotation moves is then told from what it keeps.
const AGE_SQL = `
  UPDATE sessions
  SET
    started_at = started_at - INTERVAL 1 HOUR,
    rotated_at = rotated_at - INTERVAL 1 HOUR,
    expires_at = expires_at - INTERVAL 1 HOUR,
    created_at = created_at - INTERVAL 1 HOUR,
    updated_at = updated_at - INTERVAL 1 HOUR
  WHERE id = :sid
`;

const START_SQL = 'UPDATE sessions SET started_at = :startedAt WHERE id = :sid';
const JUST_OVER_SQL = 'UPDATE sessions SET expires_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = :sid';

// What the server has opened and committed for the session that asks.
const TRANSACTIONS_SQL = `
  SELECT variable_name AS name, CAST(variable_value AS UNSIGNED) AS total
  FROM information_schema.session_status
  WHERE variable_name IN ('COM_BEGIN', 'COM_COMMIT')
  ORDER BY variable_name
`;

const WAITING_SQL = `
  SELECT id
  FROM information_schema.processlist
  WHERE db = :database AND info LIKE :pattern AND id <> CONNECTION_ID()
`;

const ENDINGS = Object.freeze([
  ['a revoked session', 'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = :sid'],
  ['an expired session', 'UPDATE sessions SET expires_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE id = :sid'],
  ['a deleted session', 'DELETE FROM sessions WHERE id = :sid'],
  ['a session of a blocked user', "UPDATE users SET status = 'blocked' WHERE id = :userId"],
  ['a session of a deleted user', 'DELETE FROM users WHERE id = :userId'],
]);

// The tables belong to the file, not to its first suite: a test that is run alone by its name needs them too.
if (!testDb.skip) {
  before(() => up());
}

function openApp(t, options) {
  return openLoggedApp(t, testDb, options);
}

function refreshIn(fastify, token, options) {
  return runInApp(fastify, () => refreshSession({ token, request: REQUEST, ...options }));
}

function postRefresh(fastify, token) {
  return fastify.inject({
    method: HTTP_METHOD.POST,
    url: REFRESH_URL,
    remoteAddress: CLIENT.ip,
    headers: REQUEST.headers,
    cookies: { [COOKIE.REFRESH_TOKEN]: token },
  });
}

function getMe(fastify, accessToken) {
  return fastify.inject({ url: ME_URL, headers: toBearer(accessToken) });
}

function readTokens(response) {
  const cookies = readAuthCookies(response);

  return { accessToken: cookies[COOKIE.ACCESS_TOKEN].value, refreshToken: cookies[COOKIE.REFRESH_TOKEN].value };
}

function isSignedWith(token, secret) {
  const [header, payload, signature] = token.split('.');

  return hmac(`${header}.${payload}`, secret, { encoding: BASE64URL }) === signature;
}

// Issued by nobody: a session that lives takes it for a token that has been replaced.
function signToken(fastify, { userId, sid }, { expiresIn = TOKEN_SECONDS, ...claims } = {}) {
  return fastify.jwt.refresh.sign({
    tokenType: TOKEN_TYPE.REFRESH,
    sub: userId,
    sid,
    jti: uuidv7(),
    ...claims,
  }, { algorithm: ALGORITHM, expiresIn });
}

function readRow(sid) {
  return readSessionRow(testDb, sid);
}

function readAudits(sid) {
  return testDb.readRows(AUDIT_SQL, { sid });
}

function waitForRow(sid, isExpected) {
  return waitFor(async () => {
    const row = await readRow(sid);

    return isExpected(row) && row;
  }, 'the change of the row');
}

function toMarkKey(sid) {
  return `${testRedis.keyPrefix}session:${sid}`;
}

function readVerbs(sink, response) {
  const requestId = readRequestId(response);

  return sink.lines
    .filter((line) => line.requestId === requestId && line.sql !== undefined)
    .map((line) => line.sql.trim().split(' ')[0]);
}

function readWrites(sink, response) {
  return readVerbs(sink, response).filter((verb) => verb !== 'SELECT');
}

async function readAlerts(fastify, receiver) {
  await settleAlerts(fastify.redis);

  return receiver.requests.map((request) => request.body);
}

function assertRefused(response, code, message) {
  assert.equal(response.statusCode, HTTP_STATUS.UNAUTHORIZED);
  assert.deepEqual(response.json(), errorBody(response, code, message));
}

function assertRevoked(response) {
  assertRefused(response, 'SESSION_REVOKED', 'Session revoked');
}

function assertLost(response) {
  assertRefused(response, 'AUTHENTICATION_ERROR', 'Authentication error');
  assert.deepEqual(readAuthCookies(response), {});
}

function assertJustNow(date) {
  assert.ok(Math.abs(Date.now() - date.getTime()) < CLOCK_SLACK_MS, `${date.toISOString()} is not now`);
}

function assertHoldsNone(text, secrets) {
  assert.deepEqual(secrets.filter((secret) => text.includes(secret)), []);
}

function toOutcome({ status, reason }) {
  return status === 'fulfilled'
    ? 'rotated'
    : reason.code;
}

function waitForUpdates(sid, count) {
  return waitFor(async () => {
    const rows = await testDb.readRows(WAITING_SQL, { database: testDb.name, pattern: `%UPDATE sessions%${sid}%` });

    return rows.length === count;
  }, `${count} UPDATE of the session at the server`);
}

async function openReplaced(fastify) {
  const { userId, sid, issued } = await signIn(fastify);
  const current = await refreshIn(fastify, issued.refreshToken);

  return {
    userId, sid, replaced: issued, current,
  };
}

describe('refreshSession: a rotation', { skip: testDb.skip }, () => {
  test('puts the new token, its end, the moment, the user agent and the ip of the request into the row, and keeps the rest of it', async (t) => {
    const { fastify } = await openApp(t);
    const { sid, issued } = await signIn(fastify, { isDev: true });

    await testDb.readRows(AGE_SQL, { sid });

    const row = await readRow(sid);
    const rotated = await refreshIn(fastify, issued.refreshToken);
    const next = await readRow(sid);

    assert.deepEqual(next, {
      ...row,
      refresh_token_hash: sha256(rotated.refreshToken),
      expires_at: new Date(readClaims(rotated.refreshToken).exp * MS_IN_SECOND),
      user_agent: CLIENT.userAgent,
      ip: CLIENT.ip,
      rotated_at: next.rotated_at,
      updated_at: next.updated_at,
    });
    assertJustNow(next.rotated_at);
  });

  test('gives a pair of the same user and session, each token with its claims and its whole lifetime', async (t) => {
    const { fastify } = await openApp(t);
    const { userId, sid, issued } = await signIn(fastify);
    const rotated = await refreshIn(fastify, issued.refreshToken);
    const accessTtl = convertStringToSeconds(fastify.config.auth.accessTtl);
    const refreshTtl = convertStringToSeconds(fastify.config.auth.refreshTtl);
    const access = readClaims(rotated.accessToken);
    const refresh = readClaims(rotated.refreshToken);

    assert.deepEqual(rotated, {
      userId,
      sid,
      scopes: [],
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      accessTtl,
      refreshTtl,
    });
    assert.deepEqual(access, {
      tokenType: 'access',
      sub: userId,
      sid,
      scopes: [],
      iat: access.iat,
      exp: access.iat + accessTtl,
    });
    assert.deepEqual(refresh, {
      tokenType: 'refresh',
      sub: userId,
      sid,
      jti: refresh.jti,
      iat: access.iat,
      exp: access.iat + refreshTtl,
    });
    assert.equal(uuidVersion(refresh.jti), UUID_V7);
    assert.notEqual(refresh.jti, readClaims(issued.refreshToken).jti);
  });

  test('takes the token it has given, three times in turn, and leaves every access token of the session valid', async (t) => {
    const { fastify } = await openApp(t);
    const { userId, sid, issued } = await signIn(fastify);
    const chain = [issued];
    const responses = await mapSeries(['first', 'second', 'third'], async () => {
      const response = await postRefresh(fastify, chain.at(-1).refreshToken);

      chain.push(readTokens(response));

      return response;
    });
    const states = await mapSeries(chain, ({ accessToken }) => getMe(fastify, accessToken));

    [...responses, ...states].forEach((response) => assert.deepEqual(response.json(), successBody(response, { id: userId, scopes: [] })));
    assert.equal(new Set(chain.map(({ refreshToken }) => refreshToken)).size, chain.length);
    assert.equal((await readRow(sid)).refresh_token_hash, sha256(chain.at(-1).refreshToken));
  });

  test('writes once, and sends no statement after that', async (t) => {
    const { fastify, sink } = await openApp(t);
    const { issued } = await signIn(fastify);
    const response = await postRefresh(fastify, issued.refreshToken);

    assert.equal(response.statusCode, HTTP_STATUS.OK);
    assert.deepEqual(readWrites(sink, response), ['UPDATE']);
    assert.equal(readVerbs(sink, response).at(-1), 'UPDATE');
  });

  test('commits by itself: no transaction is opened around its UPDATE', async (t) => {
    const { fastify } = await openApp(t, { db: { connectionLimit: 1 } });
    const { issued } = await signIn(fastify);
    const counts = await readAppRows(fastify, TRANSACTIONS_SQL);

    await refreshIn(fastify, issued.refreshToken);

    assert.deepEqual(counts.map(({ total }) => total > 0), [true, true], 'The transaction of the sign-in is not counted: the test would prove nothing');
    assert.deepEqual(await readAppRows(fastify, TRANSACTIONS_SQL), counts);
  });

  test('reads the scopes of the user anew each time: those granted, those of a superadmin, and none once they are taken away', async (t) => {
    const { fastify } = await openApp(t);
    const { userId, issued } = await signIn(fastify);

    await grantScopes(fastify, userId, ['users:write', 'users:read']);

    const granted = await refreshIn(fastify, issued.refreshToken);

    await grantScopes(fastify, userId, [], { isSuperadmin: true });

    const raised = await refreshIn(fastify, granted.refreshToken);

    await testDb.readRows('DELETE FROM user_groups WHERE user_id = :userId', { userId });

    const stripped = await refreshIn(fastify, raised.refreshToken);
    const pairs = [issued, granted, raised, stripped];
    const scopes = [[], ['users:read', 'users:write'], ['*'], []];

    assert.deepEqual(pairs.map((pair) => pair.scopes), scopes);
    assert.deepEqual(pairs.map((pair) => readClaims(pair.accessToken).scopes), scopes);
  });

  test('is not failed by a user agent longer than its column, by a missing one, or by an ip that is not an address', async (t) => {
    const { fastify } = await openApp(t);
    const { sid, issued } = await signIn(fastify);
    const longest = 'a'.repeat(USER_AGENT_COLUMN_LENGTH);
    const cut = await refreshIn(fastify, issued.refreshToken, { request: { headers: { [HEADER.USER_AGENT]: `${longest}b` }, ip: 'unknown' } });

    assert.deepEqual(pick(await readRow(sid), ['user_agent', 'ip']), { user_agent: longest, ip: null });

    await refreshIn(fastify, cut.refreshToken, { request: { headers: {}, ip: '2001:db8::1' } });

    assert.deepEqual(pick(await readRow(sid), ['user_agent', 'ip']), { user_agent: null, ip: '2001:db8::1' });
  });

  test('takes a token signed with the previous secret and signs the next one with the current', async (t) => {
    const env = { APP_JWT_REFRESH_SECRET: NEXT_SECRET };
    const [{ fastify: old }, { fastify: swapping }, { fastify: swapped }] = await Promise.all([
      openApp(t),
      openApp(t, { env: { ...env, APP_JWT_REFRESH_SECRET_PREVIOUS: TEST_ENV.APP_JWT_REFRESH_SECRET } }),
      openApp(t, { env }),
    ]);
    const { issued } = await signIn(old);
    const early = await rejectionOf(refreshIn(swapped, issued.refreshToken));
    const rotated = await refreshIn(swapping, issued.refreshToken);
    const late = await rejectionOf(refreshIn(old, rotated.refreshToken));

    assert.deepEqual([early, late].map((error) => error.code), [ERROR_CODE.AUTHENTICATION_ERROR, ERROR_CODE.AUTHENTICATION_ERROR]);
    assert.equal(isSignedWith(issued.refreshToken, TEST_ENV.APP_JWT_REFRESH_SECRET), true);
    assert.equal(isSignedWith(rotated.refreshToken, NEXT_SECRET), true);

    await refreshIn(swapped, rotated.refreshToken);
  });
});

describe('refreshSession: the longest life of a session', { skip: testDb.skip }, () => {
  const MAX_AGE_MS = convertStringToMs('90d');
  const OLD_AGE_MS = convertStringToMs('89d');
  const LAST_MINUTE_AGE_MS = MAX_AGE_MS - convertStringToMs('1m');

  // Not a whole second: the lifetimes are counted from the second it is in.
  const ODD_MS = 437;

  function toSeconds(ms) {
    return Math.floor(ms / MS_IN_SECOND);
  }

  // The age is judged by the clock of the app.
  function toStartedAt(ageMs) {
    return new Date(toSeconds(Date.now() - ageMs) * MS_IN_SECOND + ODD_MS);
  }

  async function openOld(fastify, startedAt) {
    const { sid, issued } = await signIn(fastify);

    await testDb.readRows(START_SQL, { sid, startedAt });

    return { sid, token: issued.refreshToken, endsAt: toSeconds(startedAt.getTime() + MAX_AGE_MS) };
  }

  function readMaxAges(response) {
    return Object.fromEntries(Object.values(readAuthCookies(response)).map(({ name, maxAge }) => [name, maxAge]));
  }

  test('caps the pair of a session of 89 days by what is left of the 90, in whole seconds, and so its cookies and its row', async (t) => {
    const { fastify } = await openApp(t);
    const startedAt = toStartedAt(OLD_AGE_MS);
    const { sid, token, endsAt } = await openOld(fastify, startedAt);
    const response = await postRefresh(fastify, token);
    const { accessToken, refreshToken } = readTokens(response);
    const { iat, exp } = readClaims(refreshToken);
    const accessTtl = convertStringToSeconds(fastify.config.auth.accessTtl);

    assert.equal(exp, endsAt);
    assert.equal(readClaims(accessToken).exp, iat + accessTtl);
    assert.deepEqual(readMaxAges(response), {
      [COOKIE.ACCESS_TOKEN]: accessTtl,
      [COOKIE.REFRESH_TOKEN]: endsAt - iat,
      [COOKIE.HAS_SESSION]: endsAt - iat,
      [COOKIE.HAS_ACCESS]: accessTtl,
    });
    assert.deepEqual(pick(await readRow(sid), ['started_at', 'expires_at']), {
      started_at: startedAt,
      expires_at: new Date(endsAt * MS_IN_SECOND),
    });
  });

  test('gives the access token of a session in its last minute no longer life than the session has', async (t) => {
    const { fastify } = await openApp(t);
    const { token, endsAt } = await openOld(fastify, toStartedAt(LAST_MINUTE_AGE_MS));
    const rotated = await refreshIn(fastify, token);

    assert.deepEqual([rotated.accessToken, rotated.refreshToken].map((issued) => readClaims(issued).exp), [endsAt, endsAt]);
    assert.equal(rotated.accessTtl, rotated.refreshTtl);
  });

  test('is over with less than a second left, and gives a pair of one second with a whole one', async (t) => {
    const { fastify } = await openApp(t);
    const now = toSeconds(Date.now()) * MS_IN_SECOND;
    const ended = await openOld(fastify, new Date(now + MS_IN_SECOND - 1 - MAX_AGE_MS));
    const last = await openOld(fastify, new Date(now + MS_IN_SECOND - MAX_AGE_MS));

    t.mock.timers.enable({ apis: ['Date'], now });

    assert.equal((await rejectionOf(refreshIn(fastify, ended.token))).code, ERROR_CODE.SESSION_REVOKED);
    assert.deepEqual(pick(await refreshIn(fastify, last.token), ['accessTtl', 'refreshTtl']), { accessTtl: 1, refreshTtl: 1 });
  });

  test('ends at 90 days, whatever the row and the token still allow: 401 SESSION_REVOKED, and nothing is written', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await openApp(t, { receiver });
    const { sid, token } = await openOld(fastify, new Date(Date.now() - MAX_AGE_MS));
    const row = await readRow(sid);
    const response = await postRefresh(fastify, token);

    assertRevoked(response);
    assert.ok(row.expires_at.getTime() > Date.now());
    assert.deepEqual(await readRow(sid), row);
    assert.deepEqual(readWrites(sink, response), []);
    assert.deepEqual(await readAudits(sid), []);
    assert.deepEqual(await readAlerts(fastify, receiver), []);
  });
});

describe('refreshSession: a token nobody can use', { skip: testDb.skip }, () => {
  test('is AUTHENTICATION_ERROR before any statement: the database of this app is down, and only a whole token meets that', async (t) => {
    const [{ fastify: live }, { fastify: foreign }, { fastify: down }] = await Promise.all([
      openApp(t),
      openApp(t, { env: { APP_JWT_REFRESH_SECRET: NEXT_SECRET } }),
      openApp(t, { env: await createDownEnv() }),
    ]);
    const session = await signIn(live);
    const { accessToken, refreshToken } = session.issued;
    const [header, payload, signature] = refreshToken.split('.');

    const tokens = {
      missing: undefined,
      null: null,
      empty: '',
      garbage: 'garbage',
      'three parts of garbage': 'a.b.c',
      expired: signToken(live, session, { expiresIn: EXPIRED_SECONDS }),
      'signed with another secret': signToken(foreign, session),
      'changed after it was signed': [header, encodeBase64Url(JSON.stringify({ ...readClaims(refreshToken), sub: uuidv7() })), signature].join('.'),
      'alg none': [encodeBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' })), payload, ''].join('.'),
      'an access token': accessToken,
      'an access token under the key of refresh tokens': signToken(live, session, { tokenType: TOKEN_TYPE.ACCESS }),
    };
    const codes = await Promise.all(Object.entries(tokens).map(async ([name, token]) => [name, (await rejectionOf(refreshIn(down, token))).code]));
    const bare = await rejectionOf(runInApp(down, () => refreshSession()));
    const control = await rejectionOf(refreshIn(down, signToken(live, session)));

    assert.deepEqual(codes, Object.keys(tokens).map((name) => [name, ERROR_CODE.AUTHENTICATION_ERROR]));
    assert.equal(bare.code, ERROR_CODE.AUTHENTICATION_ERROR);
    assert.equal(control.code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
  });
});

describe('refreshSession: a session that is over', { skip: testDb.skip }, () => {
  ENDINGS.forEach(([name, sql]) => {
    test(`is SESSION_REVOKED for ${name}: no write, no record, no warning and no alert`, async (t) => {
      const receiver = await createAlertReceiver(t, accept);
      const { fastify, sink } = await openApp(t, { receiver });
      const { userId, sid, issued } = await signIn(fastify);

      await testDb.readRows(sql, { sid, userId });

      const row = await readRow(sid);
      const response = await postRefresh(fastify, issued.refreshToken);

      assertRevoked(response);
      assert.deepEqual(await readRow(sid), row);
      assert.deepEqual(readWrites(sink, response), []);
      assert.deepEqual(await readAudits(sid), []);
      assert.deepEqual(findLogLines(sink, REPLAY_MESSAGE), []);
      assert.deepEqual(await readAlerts(fastify, receiver), []);
    });
  });

  test('is SESSION_REVOKED for one over by the clock of the database, which the list and the revocations go by too: also while the clock of the app is behind', async (t) => {
    const { fastify, sink } = await openApp(t);
    const { userId, sid, issued } = await signIn(fastify);

    await testDb.readRows(JUST_OVER_SQL, { sid });

    const row = await readRow(sid);

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() - CLOCK_LAG_MS });

    const listed = await runInApp(fastify, () => listSessions(userId));
    const endedCount = await runInApp(fastify, () => revokeAllSessions(userId));
    const isRevoked = await runInApp(fastify, () => revokeSession({ sid, userId }));
    const response = await postRefresh(fastify, issued.refreshToken);

    assert.ok(row.expires_at.getTime() > Date.now());
    assert.deepEqual([listed, endedCount, isRevoked], [[], 0, false]);
    assertRevoked(response);
    assert.deepEqual(readWrites(sink, response), []);
    assert.deepEqual(await readRow(sid), row);
  });

  test('is SESSION_REVOKED for a token that names the session of another user, which goes on', async (t) => {
    const { fastify, sink } = await openApp(t);
    const { sid, issued } = await signIn(fastify);
    const row = await readRow(sid);
    const response = await postRefresh(fastify, signToken(fastify, { userId: await createUser(fastify), sid }));

    assertRevoked(response);
    assert.deepEqual(readWrites(sink, response), []);
    assert.deepEqual(await readRow(sid), row);
    assert.deepEqual(await readAudits(sid), []);

    await refreshIn(fastify, issued.refreshToken);
  });
});

describe('refreshSession: a replaced token that comes again', { skip: testDb.skip || testRedis.skip }, () => {
  async function replay(t) {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await openApp(t, { receiver });

    await connectAppRedis(fastify);

    const session = await openReplaced(fastify);
    const row = await readRow(session.sid);
    const response = await postRefresh(fastify, session.replaced.refreshToken);
    const pairs = [session.replaced, session.current];

    return {
      ...session,
      receiver,
      fastify,
      sink,
      row,
      response,
      secrets: pairs.flatMap((pair) => [pair.accessToken, pair.refreshToken, sha256(pair.refreshToken)]),
    };
  }

  test('ends its session: 401 SESSION_REVOKED, the moment in the row and nothing else of it changed, and the mark of the registry', async (t) => {
    const {
      fastify, sid, current, row, response,
    } = await replay(t);
    const ended = await readRow(sid);
    const ttlMs = await testRedis.admin.pttl(toMarkKey(sid));
    const accessTtlMs = convertStringToMs(fastify.config.auth.accessTtl);

    assertRevoked(response);
    assert.deepEqual(pick(row, ['refresh_token_hash', 'revoked_at']), { refresh_token_hash: sha256(current.refreshToken), revoked_at: null });
    assert.deepEqual(ended, { ...row, revoked_at: ended.revoked_at, updated_at: ended.updated_at });
    assertJustNow(ended.revoked_at);
    assert.equal(await testRedis.admin.get(toMarkKey(sid)), '0');
    assert.ok(ttlMs > accessTtlMs - TTL_SLACK_MS && ttlMs <= accessTtlMs, `${ttlMs} ms`);
  });

  test('is written down once, with nobody named as the actor: it is the user or a thief', async (t) => {
    const { userId, sid, response } = await replay(t);

    assert.deepEqual(await readAudits(sid), [{
      actor_id: null,
      action: 'session.refresh_replay',
      entity_type: 'sessions',
      entity_id: sid,
      meta: { userId },
      ip: CLIENT.ip,
      request_id: readRequestId(response),
    }]);
  });

  test('is one alert of the class "warning" that names the session and the user and holds no token', async (t) => {
    const {
      receiver, fastify, userId, sid, response, secrets,
    } = await replay(t);
    const alerts = await readAlerts(fastify, receiver);
    const { name, version, mode } = fastify.config.app;

    assert.deepEqual(alerts.map((alert) => pick(alert, ['title', 'space', 'throttleClass', 'isSilent', 'blocks'])), [{
      title: REPLAY_TITLE,
      space: 'internal',
      throttleClass: 'warning',
      isSilent: false,
      blocks: [
        { name: 'App', value: { name, version, mode } },
        { name: 'Url', value: `${fastify.config.app.url}${REFRESH_URL}` },
        { name: 'Error', value: { message: REPLAY_MESSAGE, sid, userId } },
        {
          name: 'Request',
          value: {
            method: HTTP_METHOD.POST,
            ip: CLIENT.ip,
            userAgent: CLIENT.userAgent,
            userId: null,
            requestId: readRequestId(response),
          },
        },
      ],
    }]);
    assertHoldsNone(JSON.stringify(receiver.requests), secrets);
  });

  test('is one warning in the log, under the id of its request, and no token is in the log', async (t) => {
    const {
      sink, userId, sid, response, secrets,
    } = await replay(t);
    const lines = findLogLines(sink, REPLAY_MESSAGE);

    assert.deepEqual(lines.map((line) => pick(line, ['level', 'sid', 'userId', 'requestId'])), [{
      level: LOG_LEVEL.WARN,
      sid,
      userId,
      requestId: readRequestId(response),
    }]);
    assertHoldsNone(JSON.stringify(sink.lines), secrets);
  });

  test('takes the token that was current and every access token of the session down with it', async (t) => {
    const { fastify, replaced, current } = await replay(t);

    assertRevoked(await postRefresh(fastify, current.refreshToken));
    assertRevoked(await getMe(fastify, replaced.accessToken));
    assertRevoked(await getMe(fastify, current.accessToken));
  });

  test('leaves the other sessions of the user alone', async (t) => {
    const { fastify } = await openApp(t);
    const { userId, replaced } = await openReplaced(fastify);
    const other = await signIn(fastify, { userId });
    const row = await readRow(other.sid);

    assertRevoked(await postRefresh(fastify, replaced.refreshToken));
    assert.deepEqual(await readRow(other.sid), row);

    await refreshIn(fastify, other.issued.refreshToken);
  });

  test('changes nothing more when it comes once more: the row, the record, the alert and the warning are as they were', async (t) => {
    const {
      receiver, fastify, sink, sid, replaced,
    } = await replay(t);
    const row = await readRow(sid);
    const audits = await readAudits(sid);
    const alerts = await readAlerts(fastify, receiver);
    const response = await postRefresh(fastify, replaced.refreshToken);

    assertRevoked(response);
    assert.deepEqual(readWrites(sink, response), []);
    assert.deepEqual(await readRow(sid), row);
    assert.deepEqual(await readAudits(sid), audits);
    assert.deepEqual(await readAlerts(fastify, receiver), alerts);
    assert.equal(findLogLines(sink, REPLAY_MESSAGE).length, 1);
  });

  test('is an alert for each session: two of one user are two', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await openApp(t, { receiver });
    const first = await openReplaced(fastify);
    const second = await signIn(fastify, { userId: first.userId });

    await refreshIn(fastify, second.issued.refreshToken);
    await mapSeries([first.replaced, second.issued], async ({ refreshToken }) => assertRevoked(await postRefresh(fastify, refreshToken)));

    const alerts = await readAlerts(fastify, receiver);

    assert.deepEqual(alerts.map(({ title, blocks }) => [title, blocks[2].value.sid]).toSorted(), [first.sid, second.sid].map((sid) => [REPLAY_TITLE, sid]).toSorted());
  });

  test('is answered without waiting for a channel of its alert that hangs', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const receiver = await createAlertReceiver(t, () => ({ isHanging: true }));
    const { fastify } = await openApp(t, { receiver });
    const { replaced } = await openReplaced(fastify);
    const { result: response, durationMs } = await timeIt(() => postRefresh(fastify, replaced.refreshToken));

    await waitFor(() => receiver.requests.length > 0, 'the alert at the receiver');

    assertRevoked(response);
    assert.ok(durationMs < PROMPT_MS, `${durationMs} ms`);
  });
});

describe('refreshSession: side by side', { skip: testDb.skip }, () => {
  const ROUNDS = 15;

  // The connection of the keeper is not set to UTC.
  const REVOKE_SQL = 'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?';
  const EXPIRE_SQL = 'UPDATE sessions SET expires_at = UTC_TIMESTAMP(3) WHERE id = ?';
  const DELETE_SQL = 'DELETE FROM sessions WHERE id = ?';

  function splitByStatus(responses) {
    return responses.toSorted((left, right) => left.statusCode - right.statusCode);
  }

  async function assertWon(sid, winner) {
    assert.equal(winner.statusCode, HTTP_STATUS.OK);
    assert.deepEqual(pick(await readRow(sid), ['refresh_token_hash', 'revoked_at']), {
      refresh_token_hash: sha256(readTokens(winner).refreshToken),
      revoked_at: null,
    });
  }

  test('two requests of one token get one pair and one 401 that keeps its cookies: the session lives, and nobody is told', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await openApp(t, { receiver });
    const { sid, issued } = await signIn(fastify);

    await keeper.holdRow(TABLE.SESSIONS, sid);

    const running = Promise.all([postRefresh(fastify, issued.refreshToken), postRefresh(fastify, issued.refreshToken)]);

    await waitForUpdates(sid, 1);
    await keeper.release();

    const [winner, loser] = splitByStatus(await running);

    await assertWon(sid, winner);
    assertLost(loser);
    assert.deepEqual(readVerbs(sink, loser), []);
    assert.deepEqual(findLogLines(sink, LOST_MESSAGE).map((line) => pick(line, ['level', 'sid', 'requestId'])), [{
      level: LOG_LEVEL.WARN,
      sid,
      requestId: readRequestId(loser),
    }]);
    assert.deepEqual(await readAudits(sid), []);
    assert.deepEqual(await readAlerts(fastify, receiver), []);

    await refreshIn(fastify, readTokens(winner).refreshToken);
  });

  test('of four requests the pair goes to the first whose client is still there, and to no other', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t);
    const { sid, issued } = await signIn(fastify);
    const client = { isGone: false };
    const leaving = { isAbandoned: () => client.isGone };

    await keeper.holdRow(TABLE.SESSIONS, sid);

    const running = Promise.allSettled([leaving, leaving, {}, {}].map((options) => refreshIn(fastify, issued.refreshToken, options)));

    await waitForUpdates(sid, 1);
    client.isGone = true;
    await keeper.release();

    const results = await running;
    const { AUTHENTICATION_ERROR } = ERROR_CODE;

    assert.deepEqual(results.map((result) => toOutcome(result)), [AUTHENTICATION_ERROR, AUTHENTICATION_ERROR, 'rotated', AUTHENTICATION_ERROR]);
    assert.equal((await readRow(sid)).refresh_token_hash, sha256(results[2].value.refreshToken));
    assert.deepEqual(findLogLines(sink, ABANDONED_MESSAGE), []);
    assert.deepEqual(await readAudits(sid), []);

    await refreshIn(fastify, results[2].value.refreshToken);
  });

  test('a request that has joined one whose client is gone before the UPDATE gets the pair, and the row holds its client', async (t) => {
    const { fastify } = await openApp(t);
    const { sid, issued } = await signIn(fastify);
    const callers = [{ isAbandoned: () => true }, { request: OTHER_REQUEST }, {}];
    const results = await Promise.allSettled(callers.map((options) => refreshIn(fastify, issued.refreshToken, options)));

    assert.deepEqual(results.map((result) => toOutcome(result)), [ERROR_CODE.AUTHENTICATION_ERROR, 'rotated', ERROR_CODE.AUTHENTICATION_ERROR]);
    assert.deepEqual(pick(await readRow(sid), ['refresh_token_hash', 'user_agent', 'ip']), {
      refresh_token_hash: sha256(results[1].value.refreshToken),
      user_agent: OTHER_CLIENT.userAgent,
      ip: OTHER_CLIENT.ip,
    });
  });

  // With one connection open and the next to be made, the second refresh would come to its read when the first has
  // rotated the row already, and be taken for a theft.
  async function raceOnColdPool(t, fastify) {
    const { sid, issued } = await signIn(fastify);
    const pool = testDb.open({}, t);
    const context = createContext({ ...fastify.context, db: pool.db });

    function refresh() {
      return runInContext(context, () => refreshSession({ token: issued.refreshToken, request: REQUEST }));
    }

    await pool.readRows('SELECT 1 AS alive');

    const results = await Promise.allSettled([refresh(), refresh()]);
    const row = await readRow(sid);
    const { value } = results.find((result) => result.status === 'fulfilled') ?? {};

    await pool.db.close();

    return {
      outcomes: results.map((result) => toOutcome(result)).toSorted(),
      isCurrent: row.refresh_token_hash === sha256(value?.refreshToken ?? ''),
      revokedAt: row.revoked_at,
      audits: await readAudits(sid),
    };
  }

  test('two requests get the same when the pool has one connection open, however often', async (t) => {
    const { fastify } = await openApp(t);
    const rounds = await mapSeries(Array.from({ length: ROUNDS }), () => raceOnColdPool(t, fastify));

    assert.deepEqual(rounds, Array.from({ length: ROUNDS }, () => ({
      outcomes: [ERROR_CODE.AUTHENTICATION_ERROR, 'rotated'],
      isCurrent: true,
      revokedAt: null,
      audits: [],
    })));
  });

  test('two processes that rotate one token at the same moment get one pair and one 401: the row decides', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const receiver = await createAlertReceiver(t, accept);
    const apps = await Promise.all([openApp(t, { receiver }), openApp(t, { receiver })]);
    const { sid, issued } = await signIn(apps[0].fastify);

    await keeper.holdRow(TABLE.SESSIONS, sid);

    const running = Promise.all(apps.map(({ fastify }) => postRefresh(fastify, issued.refreshToken)));

    await waitForUpdates(sid, apps.length);
    await keeper.release();

    const [winner, loser] = splitByStatus(await running);

    await assertWon(sid, winner);
    assertLost(loser);
    assert.deepEqual(apps.flatMap(({ sink }) => findLogLines(sink, LOST_MESSAGE)).map((line) => line.requestId), [readRequestId(loser)]);
    assert.deepEqual(await readAudits(sid), []);
    assert.deepEqual(await Promise.all(apps.map(({ fastify }) => readAlerts(fastify, receiver))), [[], []]);

    await refreshIn(apps[0].fastify, readTokens(winner).refreshToken);
  });

  async function loseTo(t, sql) {
    const keeper = await openKeeper(t);
    const { fastify, sink } = await openApp(t);
    const { sid, issued } = await signIn(fastify);
    const row = await readRow(sid);

    await keeper.holdRow(TABLE.SESSIONS, sid);

    const running = postRefresh(fastify, issued.refreshToken);

    await waitForUpdates(sid, 1);
    await keeper.query(sql, [sid]);
    await keeper.query('COMMIT');

    const response = await running;

    assertLost(response);
    assert.equal(findLogLines(sink, LOST_MESSAGE).length, 1);
    assertRevoked(await postRefresh(fastify, issued.refreshToken));
    assert.deepEqual(await readAudits(sid), []);

    return { row, left: await readRow(sid) };
  }

  test('a revocation that commits between the read and the UPDATE wins: AUTHENTICATION_ERROR, and nothing is rotated or recorded', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { row, left } = await loseTo(t, REVOKE_SQL);

    assert.notEqual(left.revoked_at, null);
    assert.deepEqual(left, { ...row, revoked_at: left.revoked_at, updated_at: left.updated_at });
  });

  test('a session that ends while the UPDATE waits for its row does not come back to life: AUTHENTICATION_ERROR, and nothing is rotated', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { row, left } = await loseTo(t, EXPIRE_SQL);

    assert.ok(left.expires_at < row.expires_at);
    assert.deepEqual(left, { ...row, expires_at: left.expires_at, updated_at: left.updated_at });
  });

  test('a session deleted between the read and the UPDATE is not made anew: AUTHENTICATION_ERROR', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    assert.equal((await loseTo(t, DELETE_SQL)).left, null);
  });

  test('two requests of one replayed token both get the end of the session, found and written down once', async (t) => {
    const { fastify, sink } = await openApp(t);
    const { sid, replaced } = await openReplaced(fastify);
    const errors = await Promise.all([refreshIn(fastify, replaced.refreshToken), refreshIn(fastify, replaced.refreshToken)].map((refresh) => rejectionOf(refresh)));

    assert.deepEqual(errors.map((error) => error.code), [ERROR_CODE.SESSION_REVOKED, ERROR_CODE.SESSION_REVOKED]);
    assert.equal(findLogLines(sink, REPLAY_MESSAGE).length, 1);
    assert.deepEqual(findLogLines(sink, LOST_MESSAGE), []);
    assert.equal((await readAudits(sid)).length, 1);
  });

  test('two replays at the same moment, of two tokens that had been replaced, make one record and one alert', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await openApp(t, { receiver });
    const { sid, replaced, current } = await openReplaced(fastify);

    await refreshIn(fastify, current.refreshToken);

    await keeper.holdRow(TABLE.SESSIONS, sid);

    const replays = [replaced, current].map((pair) => postRefresh(fastify, pair.refreshToken));

    await waitForUpdates(sid, replays.length);
    await keeper.release();

    (await Promise.all(replays)).forEach((response) => assertRevoked(response));
    assert.equal((await readAudits(sid)).length, 1);
    assert.deepEqual((await readAlerts(fastify, receiver)).map((alert) => alert.title), [REPLAY_TITLE]);
    assert.equal(findLogLines(sink, REPLAY_MESSAGE).length, replays.length);
  });

  test('a replay that finds the session ended by another process marks it all the same: that one may have had no Redis', { skip: testRedis.skip, timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify: cut } = await openApp(t, { env: REDIS_DOWN_ENV });
    const { fastify } = await openApp(t);

    cut.redis.connect();
    await connectAppRedis(fastify);

    const { sid, replaced, current } = await openReplaced(fastify);

    await refreshIn(fastify, current.refreshToken);
    await keeper.holdRow(TABLE.SESSIONS, sid);

    const ending = rejectionOf(refreshIn(cut, replaced.refreshToken));

    await waitForUpdates(sid, 1);

    const finding = rejectionOf(refreshIn(fastify, current.refreshToken));

    await waitForUpdates(sid, 2);
    await keeper.release();

    const errors = await Promise.all([ending, finding]);

    assert.deepEqual(errors.map((error) => error.code), [ERROR_CODE.SESSION_REVOKED, ERROR_CODE.SESSION_REVOKED]);
    assert.equal((await readAudits(sid)).length, 1);
    assert.equal(await testRedis.admin.get(toMarkKey(sid)), '0');
  });

  test('a replay beside a rotation of the current token leaves nothing of the session, whichever of them comes first', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify } = await openApp(t);
    const { sid, replaced, current } = await openReplaced(fastify);

    await keeper.holdRow(TABLE.SESSIONS, sid);

    const refreshes = [current, replaced].map((pair) => refreshIn(fastify, pair.refreshToken));
    const running = Promise.allSettled(refreshes);

    await waitForUpdates(sid, refreshes.length);
    await keeper.release();

    const [rotation, replay] = await running;
    const last = rotation.value ?? current;

    assert.ok(['rotated', ERROR_CODE.AUTHENTICATION_ERROR].includes(toOutcome(rotation)), toOutcome(rotation));
    assert.equal(toOutcome(replay), ERROR_CODE.SESSION_REVOKED);
    assert.notEqual((await readRow(sid)).revoked_at, null);
    assert.equal((await readAudits(sid)).length, 1);
    assertRevoked(await postRefresh(fastify, last.refreshToken));
    assertRevoked(await getMe(fastify, last.accessToken));
  });
});

describe('refreshSession: Redis', { skip: testDb.skip || testRedis.skip }, () => {
  const DOWN = Object.freeze({ env: REDIS_DOWN_ENV });
  const IMPATIENT = Object.freeze({ commandTimeout: '0.2s' });

  // No command gives up before the test lets Redis answer.
  const PATIENT = Object.freeze({ commandTimeout: '10s', socketTimeout: '10s' });

  // The version of a table in the cache goes to another Redis, which nobody waits for.
  const CACHE_DOWN_ENV = Object.freeze({ APP_CACHE_REDIS_HOST: REDIS_DOWN_ENV.APP_REDIS_HOST, APP_CACHE_REDIS_PORT: REDIS_DOWN_ENV.APP_REDIS_PORT });

  const MARK_COMMANDS = Object.freeze(['multi', 'set', 'expire', 'exec']);
  const TOKEN_COLUMNS = Object.freeze(['refresh_token_hash', 'expires_at', 'revoked_at']);

  async function openProxied(t, redis, sections) {
    const proxy = await createTcpProxy(t, getServiceAddress('redis'));
    const opened = await openApp(t, { ...sections, env: { ...sections?.env, ...proxy.env }, redis });

    await connectAppRedis(opened.fastify);

    return { ...opened, proxy };
  }

  test('holds the mark of a live session for the lifetime of its access token after a rotation, which moves no version of a table', async (t) => {
    const { fastify } = await openApp(t);

    await connectAppRedis(fastify);

    const { sid, issued } = await signIn(fastify);

    await testRedis.admin.del(toMarkKey(sid));
    await refreshIn(fastify, issued.refreshToken);

    const ttlMs = await testRedis.admin.pttl(toMarkKey(sid));
    const accessTtlMs = convertStringToMs(fastify.config.auth.accessTtl);

    assert.equal(await testRedis.admin.get(toMarkKey(sid)), '1');
    assert.ok(ttlMs > accessTtlMs - TTL_SLACK_MS && ttlMs <= accessTtlMs, `${ttlMs} ms`);
    assert.equal(await testRedis.admin.exists(`${testRedis.keyPrefix}table-version:sessions`), 0);
  });

  test('may be down for a rotation: the row holds the new token, and the old access token and the new one stay valid', async (t) => {
    const { fastify } = await openApp(t, DOWN);

    fastify.redis.connect();

    const {
      userId, sid, replaced, current,
    } = await openReplaced(fastify);
    const states = await mapSeries([replaced, current], ({ accessToken }) => getMe(fastify, accessToken));

    assert.equal((await readRow(sid)).refresh_token_hash, sha256(current.refreshToken));
    states.forEach((response) => assert.deepEqual(response.json(), successBody(response, { id: userId, scopes: [] })));
  });

  test('may be down for a replay: the session ends in its row, with its record and its alert, and this process refuses its access token at once', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await openApp(t, { ...DOWN, receiver });

    fastify.redis.connect();

    const { sid, replaced, current } = await openReplaced(fastify);

    assertRevoked(await postRefresh(fastify, replaced.refreshToken));
    assert.notEqual((await readRow(sid)).revoked_at, null);
    assert.equal((await readAudits(sid)).length, 1);
    assert.deepEqual((await readAlerts(fastify, receiver)).map((alert) => alert.title), [REPLAY_TITLE]);
    assertRevoked(await getMe(fastify, current.accessToken));
  });

  test('is told of a rotation when the row holds it, not before', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { fastify, proxy } = await openProxied(t, PATIENT);
    const { sid, issued } = await signIn(fastify);

    proxy.freeze();

    const running = postRefresh(fastify, issued.refreshToken);
    const row = await waitForRow(sid, ({ refresh_token_hash: hash }) => hash !== sha256(issued.refreshToken));

    proxy.thaw();

    const response = await running;

    assert.equal(response.statusCode, HTTP_STATUS.OK);
    assert.equal(row.refresh_token_hash, sha256(readTokens(response).refreshToken));
  });

  test('is told of the end of a replayed session, and the alert goes, when that end is committed, not before', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, proxy } = await openProxied(t, PATIENT, { receiver });
    const { sid, replaced } = await openReplaced(fastify);

    proxy.freeze();

    const running = postRefresh(fastify, replaced.refreshToken);

    await waitForRow(sid, (row) => row.revoked_at !== null);

    const audits = await readAudits(sid);

    proxy.thaw();
    assertRevoked(await running);
    assert.equal(audits.length, 1);
    assert.equal(await testRedis.admin.get(toMarkKey(sid)), '0');
    assert.deepEqual((await readAlerts(fastify, receiver)).map((alert) => alert.title), [REPLAY_TITLE]);
  });

  test('is told of the end of a replayed session before its answer goes: one that hangs holds it, though the process refuses the session already', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { fastify, proxy } = await openProxied(t, PATIENT, { env: CACHE_DOWN_ENV });
    const { sid, replaced, current } = await openReplaced(fastify);
    const state = { isAnswered: false };

    async function replay() {
      const response = await postRefresh(fastify, replaced.refreshToken);

      state.isAnswered = true;

      return response;
    }

    assert.equal((await getMe(fastify, current.accessToken)).statusCode, HTTP_STATUS.OK);

    proxy.freeze();

    const replaying = replay();

    await waitFor(async () => (await getMe(fastify, current.accessToken)).statusCode === HTTP_STATUS.UNAUTHORIZED, 'the process to refuse the session');
    await mapSeries([sid, sid], readRow);

    const hanging = { ...state };

    proxy.thaw();

    assertRevoked(await replaying);
    assert.deepEqual(hanging, { isAnswered: false });
    assert.equal(await testRedis.admin.get(toMarkKey(sid)), '0');
  });

  test('may hang when a rotation writes its mark: the pair is given all the same', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { fastify, proxy } = await openProxied(t, IMPATIENT);
    const { sid, issued } = await signIn(fastify);

    proxy.freeze();

    const response = await postRefresh(fastify, issued.refreshToken);

    proxy.thaw();

    assert.equal(response.statusCode, HTTP_STATUS.OK);
    assert.equal((await readRow(sid)).refresh_token_hash, sha256(readTokens(response).refreshToken));
  });

  test('may hang until the client has left: the rotation is taken back, and the token the client holds rotates when it comes again', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { fastify, sink, proxy } = await openProxied(t, PATIENT);
    const { sid, issued } = await signIn(fastify);
    const client = { isGone: false };

    await testDb.readRows(AGE_SQL, { sid });

    const row = await readRow(sid);

    proxy.freeze();

    const running = rejectionOf(refreshIn(fastify, issued.refreshToken, { isAbandoned: () => client.isGone }));

    await waitForRow(sid, ({ refresh_token_hash: hash }) => hash !== row.refresh_token_hash);
    client.isGone = true;
    proxy.thaw();

    assert.equal((await running).code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
    assert.deepEqual(findLogLines(sink, ABANDONED_MESSAGE).map((line) => pick(line, ['level', 'sid', 'isTakenBack'])), [{
      level: LOG_LEVEL.WARN,
      sid,
      isTakenBack: true,
    }]);
    assert.deepEqual(pick(await readRow(sid), TOKEN_COLUMNS), pick(row, TOKEN_COLUMNS));
    assert.equal((await getMe(fastify, issued.accessToken)).statusCode, HTTP_STATUS.OK);
    assert.equal(await testRedis.admin.get(toMarkKey(sid)), '1');

    const { refreshToken } = await refreshIn(fastify, issued.refreshToken);

    assert.equal((await readRow(sid)).refresh_token_hash, sha256(refreshToken));
    assert.deepEqual(await readAudits(sid), []);
  });

  test('may hang until the client has left and another has come with the same token: that one gets the pair, and nothing is taken back', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { fastify, sink, proxy } = await openProxied(t, PATIENT);
    const { sid, issued } = await signIn(fastify);
    const client = { isGone: false };

    proxy.freeze();

    const leaving = rejectionOf(refreshIn(fastify, issued.refreshToken, { isAbandoned: () => client.isGone }));

    await waitForRow(sid, ({ refresh_token_hash: hash }) => hash !== sha256(issued.refreshToken));
    client.isGone = true;

    const joining = refreshIn(fastify, issued.refreshToken);

    proxy.thaw();

    const { refreshToken } = await joining;

    assert.equal((await leaving).code, ERROR_CODE.AUTHENTICATION_ERROR);
    assert.deepEqual(findLogLines(sink, ABANDONED_MESSAGE), []);
    assert.equal((await readRow(sid)).refresh_token_hash, sha256(refreshToken));

    await refreshIn(fastify, refreshToken);
  });

  test('is told of a rotation that another has come for, also when the client that began has left', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify } = await openApp(t);

    await connectAppRedis(fastify);

    const { sid, issued } = await signIn(fastify);
    const client = { isGone: false };

    await testRedis.admin.del(toMarkKey(sid));
    await keeper.holdRow(TABLE.SESSIONS, sid);

    const running = Promise.allSettled([{ isAbandoned: () => client.isGone }, {}].map((options) => refreshIn(fastify, issued.refreshToken, options)));

    await waitForUpdates(sid, 1);
    client.isGone = true;
    await keeper.release();

    assert.deepEqual((await running).map((result) => toOutcome(result)), [ERROR_CODE.AUTHENTICATION_ERROR, 'rotated']);
    assert.equal(await testRedis.admin.get(toMarkKey(sid)), '1');
  });

  test('is not told of a rotation nobody waits for any more: one that hangs does not hold up what takes it back', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const keeper = await openKeeper(t);
    const { fastify, sink, proxy } = await openProxied(t, PATIENT);
    const { sid, issued } = await signIn(fastify);
    const client = { isGone: false };

    await keeper.holdRow(TABLE.SESSIONS, sid);

    proxy.freeze();

    const running = rejectionOf(refreshIn(fastify, issued.refreshToken, { isAbandoned: () => client.isGone }));

    await waitForUpdates(sid, 1);
    client.isGone = true;
    await keeper.release();

    const error = await running;

    proxy.thaw();

    assert.equal(error.code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
    assert.deepEqual(findLogLines(sink, ABANDONED_MESSAGE).map((line) => line.isTakenBack), [true]);
    assert.equal((await readRow(sid)).refresh_token_hash, sha256(issued.refreshToken));
  });

  test('may die while a rotation writes its mark: the pair is given all the same, and the next refresh goes on from it', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const fake = await createFakeRedis(t, ([name]) => (MARK_COMMANDS.includes(name) ? '' : null));
    const { fastify } = await openApp(t, {
      env: { APP_REDIS_HOST: LOOPBACK, APP_REDIS_PORT: String(fake.port) },
      redis: { ...PATIENT, ...FAST_RECONNECT },
    });
    const { sid, issued } = await signIn(fastify);

    await connectAppRedis(fastify);

    const running = postRefresh(fastify, issued.refreshToken);

    await waitFor(() => fake.commands.some(([name]) => name === 'exec'), 'the mark to reach Redis');
    fake.die();

    const response = await running;

    assert.equal(response.statusCode, HTTP_STATUS.OK);
    assert.deepEqual(Object.keys(readAuthCookies(response)).toSorted(), Object.values(COOKIE).toSorted());

    const { refreshToken } = readTokens(response);

    assert.equal((await readRow(sid)).refresh_token_hash, sha256(refreshToken));
    assert.equal((await postRefresh(fastify, refreshToken)).statusCode, HTTP_STATUS.OK);
  });
});
