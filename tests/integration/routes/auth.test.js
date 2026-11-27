import { SCHEMA_LIMITS } from '#config/schema.js';
import { HEADER } from '#enums/header.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { TABLE } from '#enums/table.js';
import { TOKEN_TYPE } from '#enums/token-type.js';
import { USER_STATUS } from '#enums/user-status.js';
import {
  accept,
  createAlertReceiver,
  NO_THROTTLE,
  readBlock,
  readTitles,
} from '#root/tests/helper/alert.js';
import { errorBody, readRequestId, successBody } from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createGate, createTestDb, SMALL_POOL } from '#root/tests/helper/db.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import {
  createTcpProxy,
  createTestRedis,
  FAST_RECONNECT,
  REDIS_DOWN_ENV,
} from '#root/tests/helper/redis.js';
import { assertRevoked } from '#root/tests/helper/route.js';
import { getServiceAddress } from '#root/tests/helper/service.js';
import {
  connectAppRedis,
  createUser,
  grantScopes,
  LONG_MEMORY,
  readAppRows,
  readAuthCookies,
  readClaims,
  readSessionRow,
  runInApp,
  signIn,
  takeRefreshCookie,
  toBearer,
  toRegistryKey,
} from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { convertStringToMs, convertStringToSeconds } from '#utils/date.js';
import { sha256 } from '#utils/hash.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const ME_URL = '/api/v1/auth/me';
const REFRESH_URL = '/api/v1/auth/refresh';
const LOGOUT_URL = '/api/v1/auth/logout';
const SESSIONS_URL = '/api/v1/sessions';

const LOOPBACK = '127.0.0.1';
const USER_AGENT = 'auth-test-agent';
const EMPTY_BODY = '{}';
const BASIC = 'Basic dXNlcjpwYXNzd29yZA==';

const MODES = Object.freeze([
  Object.freeze({ title: 'with Redis up', isRedisUp: true }),
  Object.freeze({ title: 'with Redis down', isRedisUp: false }),
]);

const POOL_OF_ONE = Object.freeze({ connectionLimit: 1 });

// How long a process takes a session it has found alive for alive: over within a test.
const SHORT_MEMORY = Object.freeze({ registryMemoryTtl: '0.2s' });

// How long a command waits for a Redis that hangs: until the test lets it go on, or a part of a second.
const PATIENT = Object.freeze({ ...FAST_RECONNECT, commandTimeout: '5s', socketTimeout: '10s' });
const IMPATIENT = Object.freeze({ ...FAST_RECONNECT, commandTimeout: '0.3s', socketTimeout: '0.6s' });

// What a test holds and a regression never lets go of fails the test at this, instead of holding the run for ever.
const HANG_TIMEOUT_MS = 15000;

const SHORT_READ = '0.3s';
const RETRY_AFTER_SECONDS = '60';
const NO_STORE = 'no-store';
const BEARER_SCHEME = 'Bearer';

const MS_IN_SECOND = 1000;
const HALF_A_DAY_MS = convertStringToMs('12h');
const SESSION_MAX_AGE = convertStringToSeconds('90d');
const ALMOST_OVER = convertStringToSeconds('5m');
const FULL_LIFE = Object.freeze({ accessTtl: convertStringToSeconds('10m'), refreshTtl: convertStringToSeconds('30d') });

const REPLAY_ACTION = 'session.refresh_replay';
const REPLAY_TITLE = 'Refresh token replay';
const REPLAY_MESSAGE = 'A refresh token that had been replaced was used again';

const QUERY_MESSAGE = 'Database query';
const INCOMING_MESSAGE = 'incoming request';
const REQUEST_FAILED_MESSAGE = 'Request failed';

const ROTATION_PATTERN = '%UPDATE sessions%';
const TABLE_REGEXP = /(?:FROM|UPDATE) \w+/;
const READ_SESSIONS = 'FROM sessions';
const READ_SCOPES = 'FROM user_groups';
const PAIRS = 5;

const COUNT_STATEMENTS_SQL = `
  SELECT COUNT(*) AS total
  FROM information_schema.processlist
  WHERE db = :database AND info LIKE :pattern AND id <> CONNECTION_ID()
`;

const AUDIT_SQL = `
  SELECT actor_id, action, entity_type, entity_id, meta, ip, request_id
  FROM audit_logs
  WHERE entity_id = :sid
`;

const REVOKE_SQL = 'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = :sid';
const EXPIRE_SQL = 'UPDATE sessions SET expires_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE id = :sid';
const START_SQL = 'UPDATE sessions SET started_at = :startedAt WHERE id = :sid';
const REST_SQL = 'UPDATE sessions SET rotated_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY WHERE id = :sid';
const BLOCK_SQL = 'UPDATE users SET status = :status WHERE id = :userId';
const DELETE_USER_SQL = 'DELETE FROM users WHERE id = :userId';

const SECURE = Object.freeze({ secure: true, sameSite: 'Lax' });
const NOT_SECURE = Object.freeze({ sameSite: 'Lax' });
const CLEARED = Object.freeze({ value: '', maxAge: 0, expires: new Date(0) });
const MARKER = '1';

function describeCookies(values, shared) {
  return [
    {
      name: 'accessToken',
      path: '/api',
      httpOnly: true,
      ...shared,
      ...values.accessToken,
    },
    {
      name: 'hasAccess',
      path: '/',
      ...shared,
      ...values.hasAccess,
    },
    {
      name: 'hasSession',
      path: '/',
      ...shared,
      ...values.hasSession,
    },
    {
      name: 'refreshToken',
      path: REFRESH_URL,
      httpOnly: true,
      ...shared,
      ...values.refreshToken,
    },
  ];
}

function describeSetCookies({ accessToken, refreshToken }, { accessTtl, refreshTtl }, shared = SECURE) {
  return describeCookies({
    accessToken: { value: accessToken, maxAge: accessTtl },
    hasAccess: { value: MARKER, maxAge: accessTtl },
    hasSession: { value: MARKER, maxAge: refreshTtl },
    refreshToken: { value: refreshToken, maxAge: refreshTtl },
  }, shared);
}

function describeClearedCookies(shared = SECURE) {
  return describeCookies({
    accessToken: CLEARED,
    hasAccess: CLEARED,
    hasSession: CLEARED,
    refreshToken: CLEARED,
  }, shared);
}

function listCookies(response) {
  return response.cookies
    .map((cookie) => ({ ...cookie }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function readLifetime(token) {
  const { iat, exp } = readClaims(token);

  return exp - iat;
}

function readEnd(token) {
  return new Date(readClaims(token).exp * MS_IN_SECOND);
}

function readTokens(response) {
  const { accessToken, refreshToken } = readAuthCookies(response);

  return { accessToken: accessToken.value, refreshToken: refreshToken.value };
}

function takeAccessCookie(response) {
  return pick(readTokens(response), ['accessToken']);
}

function getMe(fastify, request) {
  return fastify.inject({ url: ME_URL, ...request });
}

function postRefresh(fastify, cookies, request) {
  return fastify.inject({
    method: 'POST',
    url: REFRESH_URL,
    cookies,
    ...request,
  });
}

function postLogout(fastify, request) {
  return fastify.inject({ method: 'POST', url: LOGOUT_URL, ...request });
}

function assertRefused(response, code, message) {
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers['cache-control'], NO_STORE);
  assert.deepEqual(response.json(), errorBody(response, code, message));
}

function assertUnauthenticated(response) {
  assertRefused(response, 'AUTHENTICATION_ERROR', 'Authentication error');
  assert.deepEqual(listCookies(response), []);
}

function assertUnavailable(response) {
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers[HEADER.RETRY_AFTER], RETRY_AFTER_SECONDS);
  assert.equal(response.headers['cache-control'], NO_STORE);
  assert.equal(response.headers['www-authenticate'], undefined);
  assert.deepEqual(response.json(), errorBody(response, 'SERVICE_UNAVAILABLE_ERROR', 'Service unavailable'));
  assert.deepEqual(listCookies(response), []);
}

function assertAllowed(response, userId) {
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.id, userId);
}

// Told to connect also to a Redis that is down, as the entrypoint does: a client never started is another state.
async function openApp(t, { isRedisUp = true, env = {}, ...sections } = {}) {
  const sink = createLogSink();
  const fastify = await testDb.buildApp({
    ...sections,
    env: { ...(!isRedisUp && REDIS_DOWN_ENV), ...env },
    db: { ...SMALL_POOL, ...sections.db },
    logger: { level: 'info', stream: sink.stream },
  });

  t.after(() => fastify.close());
  await fastify.ready();

  if (isRedisUp) {
    await connectAppRedis(fastify);
  } else {
    fastify.redis.connect();
  }

  return { fastify, sink };
}

async function openProxiedApp(t, deadlines) {
  const proxy = await createTcpProxy(t, getServiceAddress('redis'));
  const opened = await openApp(t, { env: proxy.env, redis: deadlines, auth: SHORT_MEMORY });

  return { ...opened, proxy };
}

// The table of each statement of one request: those a test runs beside it carry no id of a request.
function listStatements(sink, requestId) {
  return findLogLines(sink, QUERY_MESSAGE)
    .filter((line) => line.requestId === requestId)
    .map((line) => TABLE_REGEXP.exec(line.sql)?.[0]);
}

function countSessionReads(sink, response) {
  return listStatements(sink, readRequestId(response)).filter((statement) => statement === READ_SESSIONS).length;
}

function waitForRotations(count) {
  return waitFor(async () => {
    const [{ total }] = await testDb.readRows(COUNT_STATEMENTS_SQL, { database: testDb.name, pattern: ROTATION_PATTERN });

    return total === count;
  }, `${count} rotation(s) at the row that is held`);
}

function waitForRequests(sink, count) {
  return waitFor(() => findLogLines(sink, INCOMING_MESSAGE).length === count, `${count} request(s) to come in`);
}

function waitForStatus(statusCode, send) {
  return waitFor(async () => {
    const response = await send();

    return response.statusCode === statusCode && response;
  }, `an answer with the status ${statusCode}`);
}

// With a body: once it is read to its end the request is destroyed, and would pass for that of a client that has gone.
function sendRefresh(fastify, refreshToken) {
  const request = http.request({
    host: LOOPBACK,
    port: fastify.server.address().port,
    method: 'POST',
    path: REFRESH_URL,
    headers: { cookie: `refreshToken=${refreshToken}`, [HEADER.CONTENT_TYPE]: MEDIA_TYPE.JSON },
    agent: false,
  });

  return request.end(EMPTY_BODY);
}

function readAudit(fastify, sid) {
  return readAppRows(fastify, AUDIT_SQL, { sid });
}

async function readRotation(fastify, sid) {
  return pick(await readSessionRow(fastify, sid), ['refresh_token_hash', 'revoked_at']);
}

function describeRotation(refreshToken) {
  return { refresh_token_hash: sha256(refreshToken), revoked_at: null };
}

function startSessionEarlier(fastify, sid, secondsLeft) {
  const startedAt = new Date(Date.now() - (SESSION_MAX_AGE - secondsLeft) * MS_IN_SECOND);

  return readAppRows(fastify, START_SQL, { startedAt, sid });
}

MODES.forEach(({ title, isRedisUp }) => {
  describe(`tokens and sessions over HTTP, ${title}`, { skip: testDb.skip || (isRedisUp && testRedis.skip) }, () => {
    before(() => up());

    test('an access token that is still valid is refused with the very next request once its session is deleted', async (t) => {
      const { fastify } = await openApp(t, { isRedisUp, auth: LONG_MEMORY });
      const userId = await createUser(fastify);
      const [phone, laptop] = [await signIn(fastify, { userId }), await signIn(fastify, { userId })];

      assertAllowed(await getMe(fastify, { cookies: phone.accessCookie }), userId);

      const deleted = await fastify.inject({ method: 'DELETE', url: `${SESSIONS_URL}/${phone.sid}`, cookies: laptop.accessCookie });

      assert.equal(deleted.statusCode, 204);
      assertRevoked(await getMe(fastify, { cookies: phone.accessCookie }));
      assertRevoked(await getMe(fastify, { headers: phone.bearer }));
      assertAllowed(await getMe(fastify, { cookies: laptop.accessCookie }), userId);
    });

    test('a request is authorized by the mark in Redis, or by the row of the database while there is no Redis, and a session that is over is refused either way, also by a process that has never seen it', async (t) => {
      const { fastify, sink } = await openApp(t, { isRedisUp });
      const { userId, accessCookie: cookies } = await signIn(fastify);
      const reads = isRedisUp
        ? 0
        : 1;
      const allowed = await getMe(fastify, { cookies });

      assertAllowed(allowed, userId);
      assert.equal(countSessionReads(sink, allowed), reads);
      assert.equal((await postLogout(fastify, { cookies })).statusCode, 204);

      const restarted = await openApp(t, { isRedisUp });
      const refused = await getMe(restarted.fastify, { cookies });

      assertRevoked(await getMe(fastify, { cookies }));
      assertRevoked(refused);
      assert.equal(countSessionReads(restarted.sink, refused), reads);
    });

    test('a refresh token used again after it was replaced ends the session, with one record of the audit and one alert', async (t) => {
      const receiver = await createAlertReceiver(t, accept);
      const { fastify } = await openApp(t, {
        isRedisUp,
        env: receiver.env.webhook,
        alert: { ...receiver.config.alert, throttleWindow: NO_THROTTLE },
      });
      const { userId, sid, refreshCookie } = await signIn(fastify);
      const rotated = await postRefresh(fastify, refreshCookie);

      assertAllowed(await getMe(fastify, { cookies: takeAccessCookie(rotated) }), userId);

      const replayed = await postRefresh(fastify, refreshCookie);

      assertRevoked(replayed);
      assert.deepEqual(listCookies(replayed), describeClearedCookies());
      assertRevoked(await getMe(fastify, { cookies: takeAccessCookie(rotated) }));
      assertRevoked(await postRefresh(fastify, takeRefreshCookie(rotated)));
      assertRevoked(await postRefresh(fastify, refreshCookie));
      assert.ok((await readSessionRow(fastify, sid)).revoked_at instanceof Date);
      assert.deepEqual(await readAudit(fastify, sid), [{
        actor_id: null,
        action: REPLAY_ACTION,
        entity_type: 'sessions',
        entity_id: sid,
        meta: { userId },
        ip: LOOPBACK,
        request_id: readRequestId(replayed),
      }]);

      await waitFor(() => receiver.requests.length > 0, 'the alert of the replay');

      const [{ body }] = receiver.requests;
      const secrets = [refreshCookie.refreshToken, ...Object.values(readTokens(rotated))];

      assert.deepEqual(readTitles(receiver), [REPLAY_TITLE]);
      assert.deepEqual(pick(body, ['space', 'throttleClass', 'isSilent']), { space: 'internal', throttleClass: 'warning', isSilent: false });
      assert.deepEqual(readBlock(body, 'Error'), { message: REPLAY_MESSAGE, sid, userId });
      assert.deepEqual(secrets.filter((secret) => JSON.stringify(body).includes(secret)), []);
    });

    test('of two refreshes of one token side by side one gets the new pair and the other a 401 that clears no cookie: the session lives on', async (t) => {
      const { fastify } = await openApp(t, { isRedisUp });
      const devices = await mapSeries(Array.from({ length: PAIRS }), () => signIn(fastify));
      const pairs = await mapSeries(devices, ({ refreshCookie }) => Promise.all([
        postRefresh(fastify, refreshCookie),
        postRefresh(fastify, refreshCookie),
      ]));
      const winners = pairs.map((pair) => pair.find((response) => response.statusCode === 200));
      const losers = pairs.map((pair) => pair.find((response) => response.statusCode === 401));

      losers.forEach((response) => assertUnauthenticated(response));
      assert.deepEqual(
        await mapSeries(devices, ({ sid }) => readRotation(fastify, sid)),
        winners.map((response) => describeRotation(readTokens(response).refreshToken)),
      );
      assert.deepEqual(await mapSeries(devices, ({ sid }) => readAudit(fastify, sid)), devices.map(() => []));
      assertAllowed(await getMe(fastify, { cookies: takeAccessCookie(winners[0]) }), devices[0].userId);
      assertAllowed(await postRefresh(fastify, takeRefreshCookie(winners[0])), devices[0].userId);
    });

    test('two processes that have both read the row before either has rotated it: one wins, the other sets no cookie, and nobody is taken for a thief', { timeout: HANG_TIMEOUT_MS }, async (t) => {
      const keeper = await testDb.openKeeper(t);
      const first = await openApp(t, { isRedisUp, db: POOL_OF_ONE });
      const second = await openApp(t, { isRedisUp, db: POOL_OF_ONE });
      const { userId, sid, refreshCookie } = await signIn(first.fastify);

      await keeper.holdRow(TABLE.SESSIONS, sid);

      const answers = Promise.all([postRefresh(first.fastify, refreshCookie), postRefresh(second.fastify, refreshCookie)]);

      await waitForRotations(2);
      await keeper.release();

      const responses = await answers;
      const winner = responses.find((response) => response.statusCode === 200);
      const loser = responses.find((response) => response.statusCode === 401);

      assertUnauthenticated(loser);
      assert.deepEqual(await readRotation(first.fastify, sid), describeRotation(readTokens(winner).refreshToken));
      assert.deepEqual(await readAudit(first.fastify, sid), []);
      assertAllowed(await getMe(second.fastify, { cookies: takeAccessCookie(winner) }), userId);
    });

    test('a refresh token nobody can use is refused without a single query: garbage, alg none, another algorithm', async (t) => {
      const { fastify, sink } = await openApp(t, { isRedisUp });
      const { userId, sid, refreshCookie } = await signIn(fastify);
      const claims = {
        tokenType: TOKEN_TYPE.REFRESH,
        sub: userId,
        sid,
        jti: uuidv7(),
      };
      const [, payload] = refreshCookie.refreshToken.split('.');
      const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;
      const otherAlgorithm = fastify.jwt.refresh.sign(claims, { algorithm: 'HS512', expiresIn: FULL_LIFE.refreshTtl });
      const refused = await mapSeries(['garbage', unsigned, otherAlgorithm], (refreshToken) => postRefresh(fastify, { refreshToken }));
      const genuine = await postRefresh(fastify, refreshCookie);

      refused.forEach((response) => assertUnauthenticated(response));
      assert.deepEqual(refused.map((response) => listStatements(sink, readRequestId(response))), refused.map(() => []));
      assertAllowed(genuine, userId);
      assert.equal(countSessionReads(sink, genuine), 1);
    });

    test('the access token authorizes from the Authorization header with no cookie, an unusable one there is 401 beside a valid cookie, and a refresh token is taken from no header and no body', async (t) => {
      const { fastify } = await openApp(t, { isRedisUp });
      const {
        userId,
        sid,
        issued: { refreshToken },
        bearer,
        accessCookie,
        refreshCookie,
      } = await signIn(fastify);

      assertAllowed(await getMe(fastify, { headers: bearer }), userId);
      assertUnauthenticated(await getMe(fastify, { headers: toBearer('garbage'), cookies: accessCookie }));
      assertAllowed(await getMe(fastify, { cookies: accessCookie }), userId);
      assertUnauthenticated(await postRefresh(fastify, {}, { headers: toBearer(refreshToken) }));
      assertUnauthenticated(await postRefresh(fastify, {}, { payload: { refreshToken } }));
      assert.deepEqual(await readRotation(fastify, sid), describeRotation(refreshToken));
      assertAllowed(await postRefresh(fastify, refreshCookie), userId);
    });

    test('the markers live exactly as long as the tokens they stand for', async (t) => {
      const { fastify } = await openApp(t, { isRedisUp });
      const { refreshCookie } = await signIn(fastify);
      const refreshed = await postRefresh(fastify, refreshCookie);
      const { accessToken, refreshToken } = readTokens(refreshed);
      const { hasAccess, hasSession } = readAuthCookies(refreshed);

      assert.deepEqual([hasAccess.value, hasSession.value], [MARKER, MARKER]);
      assert.deepEqual([hasAccess.maxAge, hasSession.maxAge], [readLifetime(accessToken), readLifetime(refreshToken)]);
      assert.deepEqual([hasAccess.maxAge, hasSession.maxAge], [FULL_LIFE.accessTtl, FULL_LIFE.refreshTtl]);
    });
  });
});

describe('GET /api/v1/auth/me', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => up());

  test('says the id and the scopes of the token and nothing else, by the cookie and by the Bearer header, and sets no cookie', async (t) => {
    const { fastify } = await openApp(t);
    const [userId, adminId] = [await createUser(fastify), await createUser(fastify)];

    await grantScopes(fastify, userId, ['users:write', 'groups:read']);
    await grantScopes(fastify, adminId, [], { isSuperadmin: true });

    const [user, admin] = [await signIn(fastify, { userId }), await signIn(fastify, { userId: adminId })];
    const responses = await Promise.all([
      getMe(fastify, { cookies: user.accessCookie }),
      getMe(fastify, { headers: user.bearer }),
      getMe(fastify, { cookies: admin.accessCookie }),
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 200]);
    assert.deepEqual(responses.map((response) => response.json()), [
      successBody(responses[0], { id: userId, scopes: ['groups:read', 'users:write'] }),
      successBody(responses[1], { id: userId, scopes: ['groups:read', 'users:write'] }),
      successBody(responses[2], { id: adminId, scopes: ['*'] }),
    ]);
    assert.deepEqual(responses.map((response) => listCookies(response)), [[], [], []]);
  });

  test('reads the Bearer header and not the cookie beside it: an unusable token is 401, that of another user is that user', async (t) => {
    const { fastify } = await openApp(t);
    const [device, other] = [await signIn(fastify), await signIn(fastify)];
    const cookies = device.accessCookie;
    const unusable = ['Bearer', 'Bearer  ', 'Bearer garbage', `Bearer ${other.issued.accessToken} ${other.issued.accessToken}`, `Bearer ${device.issued.refreshToken}`];
    const refused = await Promise.all(unusable.map((authorization) => getMe(fastify, { cookies, headers: { authorization } })));

    refused.forEach((response) => assertUnauthenticated(response));
    assertAllowed(await getMe(fastify, { cookies, headers: other.bearer }), other.userId);
  });

  test('leaves a header of another scheme to whoever sent it: Basic credentials beside a valid cookie are 200', async (t) => {
    const { fastify } = await openApp(t);
    const device = await signIn(fastify);

    assertAllowed(await getMe(fastify, { cookies: device.accessCookie, headers: { authorization: BASIC } }), device.userId);
    assertUnauthenticated(await getMe(fastify, { headers: { authorization: BASIC } }));
  });

  test('may be stored by nobody, whichever way the token came, nor may the answer to its HEAD twin', async (t) => {
    const { fastify } = await openApp(t);
    const { accessCookie: cookies, bearer: headers } = await signIn(fastify);
    const responses = await Promise.all([
      getMe(fastify, { cookies }),
      getMe(fastify, { headers }),
      getMe(fastify, { method: 'HEAD', cookies }),
    ]);

    assert.deepEqual(responses.map((response) => [response.statusCode, response.headers['cache-control']]), responses.map(() => [200, NO_STORE]));
  });
});

describe('POST /api/v1/auth/refresh', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => up());

  test('answers the id and the scopes of now, and sets the four cookies: each with its path, its flags and the lifetime of its token', async (t) => {
    const { fastify } = await openApp(t);
    const { userId, sid, refreshCookie } = await signIn(fastify);

    await grantScopes(fastify, userId, ['users:read']);

    const refreshed = await postRefresh(fastify, refreshCookie);
    const tokens = readTokens(refreshed);
    const access = readClaims(tokens.accessToken);
    const refresh = readClaims(tokens.refreshToken);

    assert.equal(refreshed.statusCode, 200);
    assert.deepEqual(refreshed.json(), successBody(refreshed, { id: userId, scopes: ['users:read'] }));
    assert.deepEqual(listCookies(refreshed), describeSetCookies(tokens, FULL_LIFE));
    assert.deepEqual(access, {
      tokenType: 'access',
      sub: userId,
      sid,
      scopes: ['users:read'],
      iat: access.iat,
      exp: access.iat + FULL_LIFE.accessTtl,
    });
    assert.deepEqual(refresh, {
      tokenType: 'refresh',
      sub: userId,
      sid,
      jti: refresh.jti,
      iat: access.iat,
      exp: access.iat + FULL_LIFE.refreshTtl,
    });
    assertAllowed(await getMe(fastify, { cookies: takeAccessCookie(refreshed) }), userId);
  });

  test('changes the row of its session and no other: the hash of the new token, the activity, the end, and where the request came from', async (t) => {
    const { fastify } = await openApp(t);
    const userId = await createUser(fastify);
    const [device, other] = [await signIn(fastify, { userId }), await signIn(fastify, { userId })];

    await readAppRows(fastify, REST_SQL, { sid: device.sid });

    const [rowBefore, otherBefore] = [await readSessionRow(fastify, device.sid), await readSessionRow(fastify, other.sid)];
    const refreshed = await postRefresh(fastify, device.refreshCookie, { headers: { [HEADER.USER_AGENT]: USER_AGENT } });
    const { refreshToken } = readTokens(refreshed);
    const rowAfter = await readSessionRow(fastify, device.sid);

    assert.deepEqual(rowAfter, {
      ...rowBefore,
      refresh_token_hash: sha256(refreshToken),
      rotated_at: rowAfter.rotated_at,
      expires_at: readEnd(refreshToken),
      user_agent: USER_AGENT,
      ip: LOOPBACK,
      updated_at: rowAfter.updated_at,
    });
    // Half of the day it was put back by: the clock of a server may be set back meanwhile.
    assert.ok(rowAfter.rotated_at.getTime() - rowBefore.rotated_at.getTime() > HALF_A_DAY_MS);
    assert.deepEqual(await readSessionRow(fastify, other.sid), otherBefore);
  });

  test('cuts a user agent longer than its column, and keeps no address that is none: neither fails the refresh', async (t) => {
    const { fastify } = await openApp(t);
    const { sid, refreshCookie } = await signIn(fastify);
    const userAgent = 'a'.repeat(SCHEMA_LIMITS.userAgentMaxLength);
    const refreshed = await postRefresh(fastify, refreshCookie, {
      headers: { [HEADER.USER_AGENT]: `${userAgent} and more`, 'x-forwarded-for': 'not-an-address' },
    });

    assert.equal(refreshed.statusCode, 200);
    assert.deepEqual(pick(await readSessionRow(fastify, sid), ['user_agent', 'ip']), { user_agent: userAgent, ip: null });
  });

  test('sets cookies without Secure for an app on plain http, and clears them the same way', async (t) => {
    const { fastify } = await openApp(t, { env: { APP_PROTOCOL: 'http' } });
    const { sid, refreshCookie } = await signIn(fastify);
    const refreshed = await postRefresh(fastify, refreshCookie);

    await readAppRows(fastify, REVOKE_SQL, { sid });

    const refused = await postRefresh(fastify, takeRefreshCookie(refreshed));

    assert.deepEqual(listCookies(refreshed), describeSetCookies(readTokens(refreshed), FULL_LIFE, NOT_SECURE));
    assert.deepEqual(listCookies(refused), describeClearedCookies(NOT_SECURE));
  });

  test('sets the cookies of the tokens on the paths of the API prefix of the config, and the markers on the whole site', async (t) => {
    const { fastify } = await openApp(t, { app: { apiPrefix: '/backend' } });
    const { refreshCookie } = await signIn(fastify);
    const refreshed = await fastify.inject({ method: 'POST', url: '/backend/v1/auth/refresh', cookies: refreshCookie });

    assert.equal(refreshed.statusCode, 200);
    assert.deepEqual(listCookies(refreshed).map(({ name, path }) => [name, path]), [
      ['accessToken', '/backend'],
      ['hasAccess', '/'],
      ['hasSession', '/'],
      ['refreshToken', '/backend/v1/auth/refresh'],
    ]);
  });

  test('gives a session that is almost as old as one may be no more than what is left: both tokens, their cookies, the markers and the row end together', async (t) => {
    const { fastify } = await openApp(t);
    const { sid, refreshCookie } = await signIn(fastify);

    await startSessionEarlier(fastify, sid, ALMOST_OVER);

    const refreshed = await postRefresh(fastify, refreshCookie);
    const tokens = readTokens(refreshed);
    const { started_at: startedAt, expires_at: expiresAt } = await readSessionRow(fastify, sid);
    const { iat } = readClaims(tokens.refreshToken);
    const secondsLeft = Math.floor(startedAt.getTime() / MS_IN_SECOND) + SESSION_MAX_AGE - iat;

    assert.ok(secondsLeft > 0 && secondsLeft <= ALMOST_OVER, String(secondsLeft));
    assert.deepEqual([readLifetime(tokens.accessToken), readLifetime(tokens.refreshToken)], [secondsLeft, secondsLeft]);
    assert.deepEqual([readEnd(tokens.accessToken), readEnd(tokens.refreshToken)], [expiresAt, expiresAt]);
    assert.deepEqual(listCookies(refreshed), describeSetCookies(tokens, { accessTtl: secondsLeft, refreshTtl: secondsLeft }));
  });

  test('answers 401 SESSION_REVOKED and clears the four cookies for a session that is over, whatever has ended it, and writes nothing', async (t) => {
    const { fastify } = await openApp(t);
    const endings = {
      'a session that was revoked': ({ sid }) => readAppRows(fastify, REVOKE_SQL, { sid }),
      'a session that has expired': ({ sid }) => readAppRows(fastify, EXPIRE_SQL, { sid }),
      'a session as old as one may be': ({ sid }) => startSessionEarlier(fastify, sid, 0),
      'a user who is blocked': ({ userId }) => readAppRows(fastify, BLOCK_SQL, { status: USER_STATUS.BLOCKED, userId }),
      'a user who is deleted': ({ userId }) => readAppRows(fastify, DELETE_USER_SQL, { userId }),
    };
    const names = Object.keys(endings);
    const devices = await mapSeries(names, () => signIn(fastify));

    await mapSeries(names, (name, index) => endings[name](devices[index]));

    const rowsBefore = await mapSeries(devices, ({ sid }) => readSessionRow(fastify, sid));
    const responses = await mapSeries(devices, ({ refreshCookie }) => postRefresh(fastify, refreshCookie));

    responses.forEach((response) => assertRevoked(response));
    assert.deepEqual(
      responses.map((response, index) => [names[index], listCookies(response)]),
      names.map((name) => [name, describeClearedCookies()]),
    );
    assert.deepEqual(await mapSeries(devices, ({ sid }) => readSessionRow(fastify, sid)), rowsBefore);
    assert.deepEqual(await mapSeries(devices, ({ sid }) => readAudit(fastify, sid)), devices.map(() => []));
  });

  test('goes by its cookie alone beside a Bearer header: it clears the four cookies of a session that is over, and sets those of one that lives', async (t) => {
    const { fastify } = await openApp(t);
    const [ended, alive] = [await signIn(fastify), await signIn(fastify)];

    await readAppRows(fastify, REVOKE_SQL, { sid: ended.sid });

    const refused = await mapSeries([ended, alive], ({ bearer: headers }) => postRefresh(fastify, ended.refreshCookie, { headers }));
    const refreshed = await postRefresh(fastify, alive.refreshCookie, { headers: ended.bearer });

    refused.forEach((response) => assertRevoked(response));
    assert.deepEqual(refused.map((response) => listCookies(response)), [describeClearedCookies(), describeClearedCookies()]);
    assertAllowed(refreshed, alive.userId);
    assert.deepEqual(listCookies(refreshed), describeSetCookies(readTokens(refreshed), FULL_LIFE));
  });

  test('names no scheme in a 401 of either code, where the guard names Bearer in both of its own: a refresh token is taken from no header', async (t) => {
    const { fastify } = await openApp(t);
    const { accessCookie: cookies, bearer: headers, refreshCookie } = await signIn(fastify);

    assert.equal((await postLogout(fastify, { cookies })).statusCode, 204);

    const ofRefresh = [await postRefresh(fastify, {}), await postRefresh(fastify, refreshCookie)];
    const ofGuard = [await getMe(fastify), await getMe(fastify, { cookies }), await postLogout(fastify, { headers })];

    assert.deepEqual(ofRefresh.map((response) => [response.json().code, response.headers['www-authenticate']]), [
      ['AUTHENTICATION_ERROR', undefined],
      ['SESSION_REVOKED', undefined],
    ]);
    assert.deepEqual(ofGuard.map((response) => [response.json().code, response.headers['www-authenticate']]), [
      ['AUTHENTICATION_ERROR', BEARER_SCHEME],
      ['SESSION_REVOKED', BEARER_SCHEME],
      ['SESSION_REVOKED', BEARER_SCHEME],
    ]);
  });

  test('takes a token that comes again while the answer to it is still on its way for a lost race, not for a replay', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { fastify, sink, proxy } = await openProxiedApp(t, PATIENT);
    const { sid, refreshCookie } = await signIn(fastify);
    const { refresh_token_hash: hash } = await readRotation(fastify, sid);
    const requestsBefore = findLogLines(sink, INCOMING_MESSAGE).length;

    proxy.freeze();

    const first = postRefresh(fastify, refreshCookie);

    await waitFor(async () => (await readRotation(fastify, sid)).refresh_token_hash !== hash, 'the row to be rotated');

    const second = postRefresh(fastify, refreshCookie);

    await waitForRequests(sink, requestsBefore + 2);
    proxy.thaw();

    const [won, lost] = await Promise.all([first, second]);

    assert.equal(won.statusCode, 200);
    assertUnauthenticated(lost);
    assert.deepEqual(await readRotation(fastify, sid), describeRotation(readTokens(won).refreshToken));
  });

  test('rotates nothing for a client that has gone while its request waited: the token is as good as it was, and rotates for a client that stays', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const gate = await createGate(t);
    const { fastify, sink } = await openApp(t, { db: POOL_OF_ONE });
    const { sid, issued: { refreshToken } } = await signIn(fastify);
    const sockets = [];

    fastify.server.on('connection', (socket) => sockets.push(socket));
    await fastify.listen({ host: LOOPBACK, port: 0 });

    // The one connection of the pool waits at the gate, and the refresh waits for it.
    const held = runInApp(fastify, () => fastify.db.query(gate.statement));

    await gate.findWaiter(testDb);

    const abandoned = sendRefresh(fastify, refreshToken);

    abandoned.on('error', () => {});
    await waitFor(() => fastify.db.getStats().queueLength === 1, 'the refresh to wait for a connection');
    abandoned.destroy();
    await waitFor(() => sockets[0].closed, 'the server to see the client go');
    await gate.open();
    await held;

    const failure = await waitFor(() => findLogLines(sink, REQUEST_FAILED_MESSAGE)[0], 'the refresh to be given up');

    assert.equal(failure.err.code, 'SERVICE_UNAVAILABLE_ERROR');
    assert.deepEqual(listStatements(sink, failure.requestId), [READ_SESSIONS, READ_SCOPES]);
    assert.deepEqual(await readRotation(fastify, sid), describeRotation(refreshToken));

    const [answer] = await once(sendRefresh(fastify, refreshToken), 'response');

    answer.resume();

    assert.equal(answer.statusCode, 200);
    assert.notDeepEqual(await readRotation(fastify, sid), describeRotation(refreshToken));
  });
});

describe('POST /api/v1/auth/logout', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => up());

  test('by the cookie: 204 with no body that nobody may store, the row revoked, the four cookies cleared, and the same access token refused at once, for a second logout too', async (t) => {
    const { fastify } = await openApp(t, { auth: LONG_MEMORY });
    const userId = await createUser(fastify);
    const [device, other] = [await signIn(fastify, { userId }), await signIn(fastify, { userId })];
    const cookies = device.accessCookie;

    assertAllowed(await getMe(fastify, { cookies }), userId);

    const loggedOut = await postLogout(fastify, { cookies });

    assert.equal(loggedOut.statusCode, 204);
    assert.equal(loggedOut.body, '');
    assert.equal(loggedOut.headers['cache-control'], NO_STORE);
    assert.deepEqual(listCookies(loggedOut), describeClearedCookies());
    assert.ok((await readSessionRow(fastify, device.sid)).revoked_at instanceof Date);

    const refused = [await getMe(fastify, { cookies }), await getMe(fastify, { headers: device.bearer }), await postLogout(fastify, { cookies })];

    refused.forEach((response) => assertRevoked(response));
    assert.deepEqual(refused.map((response) => listCookies(response)), [[], [], []]);

    const refreshed = await postRefresh(fastify, device.refreshCookie);

    assertRevoked(refreshed);
    assert.deepEqual(listCookies(refreshed), describeClearedCookies());
    assertAllowed(await getMe(fastify, { cookies: other.accessCookie }), userId);
  });

  test('by the Bearer header: the session of the token ends and the cookies of the browser are left alone, they may be of another one', async (t) => {
    const { fastify } = await openApp(t);
    const [device, browser] = [await signIn(fastify), await signIn(fastify)];
    const loggedOut = await postLogout(fastify, { headers: device.bearer, cookies: { ...browser.accessCookie, hasSession: MARKER } });

    assert.equal(loggedOut.statusCode, 204);
    assert.deepEqual(listCookies(loggedOut), []);
    assert.ok((await readSessionRow(fastify, device.sid)).revoked_at instanceof Date);
    assertRevoked(await getMe(fastify, { headers: device.bearer }));
    assertAllowed(await getMe(fastify, { cookies: browser.accessCookie }), browser.userId);
  });

  test('by the cookie beside Basic credentials, which are not the token of the request: the cookies are cleared', async (t) => {
    const { fastify } = await openApp(t);
    const device = await signIn(fastify);
    const loggedOut = await postLogout(fastify, { cookies: device.accessCookie, headers: { authorization: BASIC } });

    assert.equal(loggedOut.statusCode, 204);
    assert.deepEqual(listCookies(loggedOut), describeClearedCookies());
  });

  test('of a session that has been ended meanwhile, on a process that still takes it for alive, is a 204 that clears the four cookies as well, and leaves the row as it is', async (t) => {
    const { fastify } = await openApp(t, { isRedisUp: false, auth: LONG_MEMORY });
    const { userId, sid, accessCookie: cookies } = await signIn(fastify);

    assertAllowed(await getMe(fastify, { cookies }), userId);

    await readAppRows(fastify, REVOKE_SQL, { sid });

    const rowBefore = await readSessionRow(fastify, sid);
    const loggedOut = await postLogout(fastify, { cookies });

    assert.equal(loggedOut.statusCode, 204);
    assert.deepEqual(listCookies(loggedOut), describeClearedCookies());
    assert.deepEqual(await readSessionRow(fastify, sid), rowBefore);
  });

  test('ends the session also for the tokens a refresh has made since: the pair of before and the pair of now', async (t) => {
    const { fastify } = await openApp(t);
    const device = await signIn(fastify);
    const refreshed = await postRefresh(fastify, device.refreshCookie);

    assertAllowed(await getMe(fastify, { cookies: device.accessCookie }), device.userId);
    assert.equal((await postLogout(fastify, { cookies: device.accessCookie })).statusCode, 204);
    assertRevoked(await getMe(fastify, { cookies: takeAccessCookie(refreshed) }));
    assertRevoked(await postRefresh(fastify, takeRefreshCookie(refreshed)));
    assert.deepEqual(await readAudit(fastify, device.sid), []);
  });
});

describe('a session and the services behind it', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => up());

  test('a user deleted by SQL is refused as soon as the memory of a process is over: a process that remembers longer lets them in longer', async (t) => {
    const [forgetful, mindful] = [
      await openApp(t, { isRedisUp: false, auth: SHORT_MEMORY }),
      await openApp(t, { isRedisUp: false, auth: LONG_MEMORY }),
    ];
    const { userId, sid, accessCookie: cookies } = await signIn(forgetful.fastify);

    assertAllowed(await getMe(forgetful.fastify, { cookies }), userId);
    assertAllowed(await getMe(mindful.fastify, { cookies }), userId);

    await readAppRows(forgetful.fastify, DELETE_USER_SQL, { userId });

    assertRevoked(await waitForStatus(401, () => getMe(forgetful.fastify, { cookies })));
    assert.equal(await readSessionRow(forgetful.fastify, sid), null);
    assertAllowed(await getMe(mindful.fastify, { cookies }), userId);
  });

  test('a user deleted by SQL is refused with Redis up once the mark of the session is gone, which lives no longer than the access token', async (t) => {
    const { fastify } = await openApp(t, { auth: SHORT_MEMORY });
    const { userId, sid, accessCookie: cookies } = await signIn(fastify);
    const key = toRegistryKey(testRedis.keyPrefix, sid);
    const ttl = await testRedis.admin.ttl(key);

    assertAllowed(await getMe(fastify, { cookies }), userId);
    assert.ok(ttl > 0 && ttl <= FULL_LIFE.accessTtl, String(ttl));

    await readAppRows(fastify, DELETE_USER_SQL, { userId });

    assert.equal(await testRedis.admin.unlink(key), 1);
    assertRevoked(await waitForStatus(401, () => getMe(fastify, { cookies })));
  });

  test('a database that hangs while Redis is down is 503 after the deadline of the read, for a refresh too, which rotates nothing: both go on once it is back', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const proxy = await createTcpProxy(t, getServiceAddress('mariadb'));
    const { fastify } = await openApp(t, {
      isRedisUp: false,
      env: proxy.databaseEnv,
      auth: { readTimeout: SHORT_READ },
    });
    const { userId, refreshCookie, accessCookie: cookies } = await signIn(fastify);

    proxy.freeze();

    const responses = await Promise.all([getMe(fastify, { cookies }), postRefresh(fastify, refreshCookie)]);

    responses.forEach((response) => assertUnavailable(response));
    proxy.thaw();

    assertAllowed(await waitForStatus(200, () => getMe(fastify, { cookies })), userId);
    assertAllowed(await waitForStatus(200, () => postRefresh(fastify, refreshCookie)), userId);
  });

  test('a Redis that hangs costs a request its deadline, not its session: the row decides, and one that is ended meanwhile stays ended once Redis is back', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { fastify, sink, proxy } = await openProxiedApp(t, IMPATIENT);
    const [device, ended] = [await signIn(fastify), await signIn(fastify)];

    proxy.freeze();

    const allowed = await getMe(fastify, { cookies: device.accessCookie });

    assertAllowed(allowed, device.userId);
    assert.equal(countSessionReads(sink, allowed), 1);
    assert.equal((await postLogout(fastify, { cookies: ended.accessCookie })).statusCode, 204);
    assertRevoked(await getMe(fastify, { cookies: ended.accessCookie }));

    proxy.thaw();
    await waitFor(() => fastify.redis.isReady(), 'Redis to be back');

    assertRevoked(await getMe(fastify, { cookies: ended.accessCookie }));
    assertAllowed(await getMe(fastify, { cookies: device.accessCookie }), device.userId);
  });
});
