import { createSession } from '#core/auth/session.js';
import { runInContext } from '#core/context/index.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
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
import { uuidv7 } from '#utils/id.js';
import { mapValues, pick } from '#utils/object.js';

const LOOPBACK = '127.0.0.1';
const KEY_SEPARATOR = ':';
const ALIVE_MARK = '1';

// The cookies of a signed-in browser: the two tokens and their markers, not those of a sign-in on its way.
export const AUTH_COOKIES = Object.freeze([COOKIE.ACCESS_TOKEN, COOKIE.REFRESH_TOKEN, COOKIE.HAS_SESSION, COOKIE.HAS_ACCESS]);

export const TEST_CLIENT = Object.freeze({ userAgent: 'session-test-agent', ip: '203.0.113.7' });

export const UNTOLD_MESSAGE = 'Sessions are revoked, and Redis did not take all it was told: another process may take an old mark for live until the access token ends';

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
