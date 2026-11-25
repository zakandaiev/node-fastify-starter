import { issueTokens } from '#core/auth/token.js';
import { getContext } from '#core/context/index.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { TEST_ENV } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { runInApp, toBearer } from '#root/tests/helper/session.js';
import { nowUtc } from '#utils/date.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const ROTATION_MESSAGE = 'Tokens signed with a previous secret are accepted';
const VERIFY_MODE_MESSAGE = /secret is configured in verify mode/;

const USER_ID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b';
const SID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2d';
const SCOPES = ['users:read'];

const PREVIOUS_ACCESS_SECRET = 'previous-access-secret-0123456789-abcdef';
const PREVIOUS_REFRESH_SECRET = 'previous-refresh-secret-0123456789-abcdef';

const PREVIOUS_ACCESS = Object.freeze({ APP_JWT_ACCESS_SECRET_PREVIOUS: PREVIOUS_ACCESS_SECRET });
const PREVIOUS_REFRESH = Object.freeze({ APP_JWT_REFRESH_SECRET_PREVIOUS: PREVIOUS_REFRESH_SECRET });
const PREVIOUS_BOTH = Object.freeze({ ...PREVIOUS_ACCESS, ...PREVIOUS_REFRESH });

const SECRETS = [
  TEST_ENV.APP_JWT_ACCESS_SECRET,
  TEST_ENV.APP_JWT_REFRESH_SECRET,
  PREVIOUS_ACCESS_SECRET,
  PREVIOUS_REFRESH_SECRET,
];

const EARLIER_KEYS = ['config', 'log', 'db', 'redis', 'cacheRedis'];

async function buildApp(t, env = {}) {
  const sink = createLogSink();
  const fastify = await buildTestApp({
    env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()), ...env },
    logger: { level: 'trace', stream: sink.stream },
  });

  t.after(() => fastify.close());

  return { fastify, sink };
}

function issue(fastify) {
  return runInApp(fastify, () => issueTokens({
    userId: USER_ID,
    sid: SID,
    scopes: SCOPES,
    startedAt: nowUtc(),
  })).issued;
}

function readIdentity(request) {
  return { jwtPayload: request.jwtPayload, user: request.user, session: request.session };
}

describe('jwt plugin', () => {
  test('is registered under the name "jwt" over the plugin of Fastify', async (t) => {
    const { fastify } = await buildApp(t);

    assert.deepEqual(['jwt', '@fastify/jwt'].map((name) => fastify.hasPlugin(name)), [true, true]);
  });

  test('holds a space of keys for each kind of token, and one more for each previous secret there is', async (t) => {
    const envs = [{}, PREVIOUS_ACCESS, PREVIOUS_REFRESH, PREVIOUS_BOTH];
    const apps = await Promise.all(envs.map((env) => buildApp(t, env)));

    assert.deepEqual(apps.map(({ fastify }) => Object.keys(fastify.jwt)), [
      ['access', 'refresh'],
      ['access', 'refresh', 'accessPrevious'],
      ['access', 'refresh', 'refreshPrevious'],
      ['access', 'refresh', 'accessPrevious', 'refreshPrevious'],
    ]);
  });

  test('each space names the one algorithm it signs and checks with, and the claims a token of its kind must have', async (t) => {
    const { fastify } = await buildApp(t, PREVIOUS_BOTH);
    const sign = { algorithm: 'HS256' };
    const access = { sign, verify: { algorithms: ['HS256'], requiredClaims: ['tokenType', 'sub', 'sid', 'scopes', 'exp'] } };
    const refresh = { sign, verify: { algorithms: ['HS256'], requiredClaims: ['tokenType', 'sub', 'sid', 'jti', 'exp'] } };

    assert.deepEqual(
      Object.entries(fastify.jwt).map(([name, space]) => [name, pick(space.options, ['sign', 'verify'])]),
      [['access', access], ['refresh', refresh], ['accessPrevious', access], ['refreshPrevious', refresh]],
    );
  });

  test('the space of a previous secret checks the tokens it has signed as the current one, and signs no more', async (t) => {
    const former = await buildApp(t, { APP_JWT_ACCESS_SECRET: PREVIOUS_ACCESS_SECRET, APP_JWT_REFRESH_SECRET: PREVIOUS_REFRESH_SECRET });
    const { fastify: { jwt } } = await buildApp(t, PREVIOUS_BOTH);
    const { accessToken, refreshToken } = issue(former.fastify);

    assert.equal(jwt.accessPrevious.verify(accessToken).sub, USER_ID);
    assert.equal(jwt.refreshPrevious.verify(refreshToken).sub, USER_ID);
    [jwt.accessPrevious, jwt.refreshPrevious].forEach((space) => assert.throws(() => space.sign({ sub: USER_ID }), VERIFY_MODE_MESSAGE));
  });

  test('puts jwt into the context of the app beside the services of the earlier plugins, and so into the context of a request', async (t) => {
    const { fastify } = await buildApp(t);

    fastify.get('/probe', () => ({ isSame: getContext().jwt === fastify.jwt }));

    const response = await fastify.inject('/probe');

    assert.equal(fastify.context.jwt, fastify.jwt);
    assert.ok(Object.isFrozen(fastify.context));
    EARLIER_KEYS.forEach((key) => assert.equal(fastify.context[key], fastify[key], key));
    assert.deepEqual(response.json(), { isSame: true });
  });
});

describe('jwt plugin: a request', () => {
  test('has a check for each space and jwtPayload for what it reads, and no check for a space that is not there', async (t) => {
    const { fastify } = await buildApp(t, PREVIOUS_ACCESS);
    const names = ['accessJwtVerify', 'refreshJwtVerify', 'accessPreviousJwtVerify', 'jwtPayload', 'jwtVerify', 'refreshPreviousJwtVerify'];

    assert.deepEqual(names.map((name) => fastify.hasRequestDecorator(name)), [true, true, true, true, false, false]);
  });

  test('gets the claims the library has checked into jwtPayload, and never into user or session: only the guard fills those', async (t) => {
    const { fastify } = await buildApp(t);
    const { accessToken, refreshToken } = issue(fastify);

    fastify.get('/unchecked', (request) => readIdentity(request));
    fastify.get('/access', async (request) => {
      await request.accessJwtVerify();

      return readIdentity(request);
    });
    fastify.get('/refresh', async (request) => {
      await request.refreshJwtVerify();

      return readIdentity(request);
    });

    const [unchecked, access, refresh] = await Promise.all([
      fastify.inject({ url: '/unchecked', headers: toBearer(accessToken) }),
      fastify.inject({ url: '/access', headers: toBearer(accessToken) }),
      fastify.inject({ url: '/refresh', headers: toBearer(refreshToken) }),
    ]);

    assert.equal(access.json().jwtPayload.sub, USER_ID);
    assert.deepEqual(unchecked.json(), { jwtPayload: null, user: null, session: null });
    assert.deepEqual(access.json(), { jwtPayload: fastify.jwt.access.decode(accessToken), user: null, session: null });
    assert.deepEqual(refresh.json(), { jwtPayload: fastify.jwt.refresh.decode(refreshToken), user: null, session: null });
  });
});

describe('jwt plugin: a swap of secrets', () => {
  test('is told in one info line at the start, which names the kinds of tokens a previous secret is accepted for', async (t) => {
    const envs = [PREVIOUS_ACCESS, PREVIOUS_REFRESH, PREVIOUS_BOTH];
    const apps = await Promise.all(envs.map((env) => buildApp(t, env)));
    const lines = apps.map(({ sink }) => findLogLines(sink, ROTATION_MESSAGE).map((line) => pick(line, ['level', 'rotation'])));

    assert.deepEqual(lines, [
      [{ level: LOG_LEVEL.INFO, rotation: { access: true, refresh: false } }],
      [{ level: LOG_LEVEL.INFO, rotation: { access: false, refresh: true } }],
      [{ level: LOG_LEVEL.INFO, rotation: { access: true, refresh: true } }],
    ]);
  });

  test('is told of in no line while there is no previous secret', async (t) => {
    const { sink } = await buildApp(t);

    assert.notEqual(sink.lines.length, 0);
    assert.deepEqual(findLogLines(sink, ROTATION_MESSAGE), []);
  });

  test('puts no secret into the log, neither a current one nor a previous one', async (t) => {
    const { fastify, sink } = await buildApp(t, PREVIOUS_BOTH);

    await fastify.ready();

    const log = JSON.stringify(sink.lines);

    assert.equal(findLogLines(sink, ROTATION_MESSAGE).length, 1);
    assert.deepEqual(SECRETS.filter((secret) => log.includes(secret)), []);
  });
});
