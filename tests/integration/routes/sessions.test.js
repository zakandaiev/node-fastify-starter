import { HEADER } from '#enums/header.js';
import { errorBody, successBody } from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createTestDb, SMALL_POOL } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis, REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { assertRevoked } from '#root/tests/helper/route.js';
import {
  connectAppRedis,
  createUser,
  LONG_MEMORY,
  readAppRows,
  readSessionRow,
  signIn,
  TEST_CLIENT,
} from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const SESSIONS_URL = '/api/v1/sessions';
const ME_URL = '/api/v1/auth/me';
const REFRESH_URL = '/api/v1/auth/refresh';
const LOGOUT_URL = '/api/v1/auth/logout';

const MODES = Object.freeze([
  Object.freeze({ title: 'with Redis up', isRedisUp: true }),
  Object.freeze({ title: 'with Redis down', isRedisUp: false }),
]);

const LOOPBACK = '127.0.0.1';
const REVOKE_CHANNEL = 'auth:revoke';
const NO_STORE = 'no-store';

const STARTED_AT = '2026-11-01T08:00:00.000Z';
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
const MORNING = '2026-11-20T09:00:00.000Z';
const NOON = '2026-11-20T12:00:00.000Z';
const EVENING = '2026-11-20T18:00:00.000Z';

const SET_LIFE_SQL = 'UPDATE sessions SET started_at = :startedAt, expires_at = :expiresAt WHERE id IN (:sids)';
const SET_ACTIVITY_SQL = 'UPDATE sessions SET rotated_at = :rotatedAt WHERE id = :sid';
const REVOKE_SQL = 'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = :sid';
const EXPIRE_SQL = 'UPDATE sessions SET expires_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE id = :sid';
const NOT_REVOKED_SQL = 'SELECT id FROM sessions WHERE user_id = :userId AND revoked_at IS NULL ORDER BY id';

const AUTH_PATHS = Object.freeze({ accessToken: '/api', refreshToken: REFRESH_URL });
const AUTH_NAMES = Object.freeze(['accessToken', 'hasAccess', 'hasSession', 'refreshToken']);
const TOKEN_NAMES = Object.freeze(['accessToken', 'refreshToken']);

const NO_CHOICE = Object.freeze({
  column: 'scope',
  columnValue: null,
  operator: 'oneOf',
  operatorValue: ['except', 'scope'],
});

// Told to connect also to a Redis that is down, as the entrypoint does: a client never started is another state.
async function openApp(t, { isRedisUp = true, ...sections } = {}) {
  const fastify = await testDb.buildApp({
    ...sections,
    ...(!isRedisUp && { env: REDIS_DOWN_ENV }),
    db: SMALL_POOL,
  });

  t.after(() => fastify.close());

  if (isRedisUp) {
    await connectAppRedis(fastify);
  } else {
    fastify.redis.connect();
  }

  return fastify;
}

// One user on as many devices as a test names, the first sign-in first: an id made later is the greater one.
async function signInOn(fastify, count, userId) {
  const ownerId = userId ?? await createUser(fastify);
  const devices = await mapSeries(Array.from({ length: count }), () => signIn(fastify, { userId: ownerId }));

  return { userId: ownerId, devices };
}

function setLife(fastify, devices) {
  return readAppRows(fastify, SET_LIFE_SQL, {
    startedAt: new Date(STARTED_AT),
    expiresAt: new Date(FAR_FUTURE),
    sids: devices.map(({ sid }) => sid),
  });
}

function setActivity(fastify, { sid }, rotatedAt) {
  return readAppRows(fastify, SET_ACTIVITY_SQL, { rotatedAt: new Date(rotatedAt), sid });
}

async function listNotRevoked(fastify, userId) {
  const rows = await readAppRows(fastify, NOT_REVOKED_SQL, { userId });

  return rows.map((row) => row.id);
}

function getMe(fastify, request) {
  return fastify.inject({ url: ME_URL, ...request });
}

function getSessions(fastify, request) {
  return fastify.inject({ url: SESSIONS_URL, ...request });
}

function deleteSessions(fastify, path, request) {
  return fastify.inject({ method: 'DELETE', url: `${SESSIONS_URL}${path}`, ...request });
}

function readSids(response) {
  return response.json().data.map((session) => session.id);
}

async function readStatuses(fastify, devices) {
  const responses = await mapSeries(devices, ({ bearer }) => getMe(fastify, { headers: bearer }));

  return responses.map((response) => response.statusCode);
}

function readHeaders(response) {
  return [response.headers['cache-control'], response.headers['www-authenticate']];
}

function assertEnded(response, clearedNames) {
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['cache-control'], NO_STORE);
  assert.deepEqual(response.cookies.map((cookie) => cookie.name).toSorted(), clearedNames);
  assert.deepEqual(response.cookies.filter((cookie) => cookie.value !== '' || cookie.maxAge !== 0), []);
}

function assertNotFound(response) {
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), errorBody(response, 'NOT_FOUND_ERROR', 'Not found'));
  assert.deepEqual(readHeaders(response), [NO_STORE, undefined]);
  assert.deepEqual(response.cookies, []);
}

function createBrowser(fastify, { issued }, userAgent) {
  const jar = new Map(Object.entries(AUTH_PATHS).map(([name, path]) => [name, { name, path, value: issued[name] }]));

  async function send(method, url) {
    const response = await fastify.inject({
      method,
      url,
      cookies: [...jar.values()],
      headers: { [HEADER.USER_AGENT]: userAgent },
    });

    response.cookies.forEach((cookie) => {
      jar.delete(cookie.name);

      if (cookie.maxAge > 0) {
        jar.set(cookie.name, cookie);
      }
    });

    return response;
  }

  return { send, listNames: () => [...jar.keys()].toSorted() };
}

describe('GET /api/v1/sessions', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => up());

  test('lists the live sessions of the user, the last active first, those of one moment by their id, with the current one marked: every field of a row and no other', async (t) => {
    const fastify = await openApp(t);
    const { userId, devices: [revoked, expired] } = await signInOn(fastify, 2);

    await readAppRows(fastify, REVOKE_SQL, { sid: revoked.sid });
    await readAppRows(fastify, EXPIRE_SQL, { sid: expired.sid });

    const { devices: [phone, laptop, tablet] } = await signInOn(fastify, 3, userId);
    const tool = await signIn(fastify, { userId, client: { userAgent: null, ip: null }, isDev: true });
    const foreign = await signIn(fastify);

    await setLife(fastify, [phone, laptop, tablet, tool]);
    await setActivity(fastify, phone, NOON);
    await setActivity(fastify, laptop, EVENING);
    await setActivity(fastify, tablet, NOON);
    await setActivity(fastify, tool, MORNING);

    const shared = { startedAt: STARTED_AT, expiresAt: FAR_FUTURE };
    const [response, ofForeign] = await Promise.all([
      getSessions(fastify, { cookies: phone.accessCookie }),
      getSessions(fastify, { headers: foreign.bearer }),
    ]);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), successBody(response, [
      {
        ...shared,
        ...TEST_CLIENT,
        id: laptop.sid,
        isDev: false,
        rotatedAt: EVENING,
        isCurrent: false,
      },
      {
        ...shared,
        ...TEST_CLIENT,
        id: tablet.sid,
        isDev: false,
        rotatedAt: NOON,
        isCurrent: false,
      },
      {
        ...shared,
        ...TEST_CLIENT,
        id: phone.sid,
        isDev: false,
        rotatedAt: NOON,
        isCurrent: true,
      },
      {
        ...shared,
        id: tool.sid,
        userAgent: null,
        ip: null,
        isDev: true,
        rotatedAt: MORNING,
        isCurrent: false,
      },
    ]));
    assert.deepEqual(response.cookies, []);
    assert.deepEqual(readSids(ofForeign), [foreign.sid]);
  });

  test('says nothing of the tokens of a session: none of them, nor the hash of one, is anywhere in the answer', async (t) => {
    const fastify = await openApp(t);
    const device = await signIn(fastify);
    const response = await getSessions(fastify, { cookies: device.accessCookie });
    const { refresh_token_hash: hash } = await readSessionRow(fastify, device.sid);
    const secrets = [hash, device.issued.refreshToken, device.issued.accessToken];

    assert.deepEqual(readSids(response), [device.sid]);
    assert.deepEqual(secrets.filter((secret) => response.body.includes(secret)), []);
  });

  test('may be stored by nobody, at either spelling of its address, nor may the answer to its HEAD twin', async (t) => {
    const fastify = await openApp(t);
    const { accessCookie: cookies } = await signIn(fastify);
    const requests = [SESSIONS_URL, `${SESSIONS_URL}/`].flatMap((url) => ['GET', 'HEAD'].map((method) => ({ method, url, cookies })));
    const responses = await mapSeries(requests, (request) => fastify.inject(request));

    assert.deepEqual(responses.map((response) => [response.statusCode, ...readHeaders(response)]), requests.map(() => [200, NO_STORE, undefined]));
  });
});

describe('DELETE /api/v1/sessions/:id', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => up());

  test('ends another session of the user and leaves the cookies of the request alone; the same id once more is 404', async (t) => {
    const fastify = await openApp(t, { auth: LONG_MEMORY });
    const { userId, devices: [phone, laptop, tablet] } = await signInOn(fastify, 3);
    const cookies = phone.accessCookie;

    assert.deepEqual(await readStatuses(fastify, [phone, laptop, tablet]), [200, 200, 200]);

    assertEnded(await deleteSessions(fastify, `/${laptop.sid}`, { cookies }), []);
    assertRevoked(await getMe(fastify, { cookies: laptop.accessCookie }));
    assert.deepEqual(await readStatuses(fastify, [phone, laptop, tablet]), [200, 401, 200]);
    assert.deepEqual(await listNotRevoked(fastify, userId), [phone.sid, tablet.sid]);

    const rowBefore = await readSessionRow(fastify, laptop.sid);

    assertNotFound(await deleteSessions(fastify, `/${laptop.sid}`, { cookies }));
    assert.deepEqual(await readSessionRow(fastify, laptop.sid), rowBefore);
  });

  test('ends the current session and clears the four cookies of the request; with the Bearer header it leaves the cookies of the browser alone', async (t) => {
    const fastify = await openApp(t);
    const { devices: [phone, laptop] } = await signInOn(fastify, 2);
    const browser = await signIn(fastify);
    const byCookie = await deleteSessions(fastify, `/${phone.sid}`, { cookies: phone.accessCookie });
    const byHeader = await deleteSessions(fastify, `/${laptop.sid}`, { headers: laptop.bearer, cookies: browser.accessCookie });

    assertEnded(byCookie, AUTH_NAMES);
    assertEnded(byHeader, []);
    assertRevoked(await getMe(fastify, { cookies: phone.accessCookie }));
    assertRevoked(await deleteSessions(fastify, `/${laptop.sid}`, { headers: laptop.bearer }));
    assert.deepEqual(await readStatuses(fastify, [browser]), [200]);
  });

  test('answers 404 to the id of a foreign session, of none, of one that is over and to what is no id, and ends nothing', async (t) => {
    const fastify = await openApp(t);
    const { devices: [phone, expired] } = await signInOn(fastify, 2);
    const foreign = await signIn(fastify);

    await readAppRows(fastify, EXPIRE_SQL, { sid: expired.sid });

    const rowsBefore = await mapSeries([phone, expired, foreign], ({ sid }) => readSessionRow(fastify, sid));
    const ids = [foreign.sid, expired.sid, uuidv7(), 'not-a-uuid', phone.sid.toUpperCase(), `${phone.sid}%20`, 'null'];
    const responses = await mapSeries(ids, (id) => deleteSessions(fastify, `/${id}`, { cookies: phone.accessCookie }));

    responses.forEach((response) => assertNotFound(response));
    assert.deepEqual(await mapSeries([phone, expired, foreign], ({ sid }) => readSessionRow(fastify, sid)), rowsBefore);
    assert.deepEqual(await readStatuses(fastify, [phone, foreign]), [200, 200]);
  });

  test('refuses an ended session at once in the process that has ended it, and in another one of the same Redis as soon as it hears of it', async (t) => {
    // A prefix of their own: no other app of the file listens to their channel.
    const redis = { keyPrefix: `${testRedis.keyPrefix}${uuidv7()}:` };
    const first = await openApp(t, { redis, auth: LONG_MEMORY });
    const second = await openApp(t, { redis, auth: LONG_MEMORY });
    const { devices: [phone, laptop] } = await signInOn(first, 2);

    await waitFor(async () => {
      const [, count] = await testRedis.admin.pubsub('NUMSUB', first.redis.toChannel(REVOKE_CHANNEL));

      return count === 2;
    }, 'both processes to listen');

    assert.deepEqual([await readStatuses(first, [laptop]), await readStatuses(second, [laptop])], [[200], [200]]);

    assertEnded(await deleteSessions(first, `/${laptop.sid}`, { cookies: phone.accessCookie }), []);
    assertRevoked(await getMe(first, { cookies: laptop.accessCookie }));

    const refused = await waitFor(async () => {
      const response = await getMe(second, { cookies: laptop.accessCookie });

      return response.statusCode === 401 && response;
    }, 'the other process to refuse the session');

    assertRevoked(refused);
    assert.deepEqual(await readStatuses(second, [phone]), [200]);
  });
});

describe('DELETE /api/v1/sessions', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => up());

  test('with except=current ends every other session of the user, none of anyone else, and leaves the cookies alone; with nothing left to end it is 204 again', async (t) => {
    const fastify = await openApp(t, { auth: LONG_MEMORY });
    const { userId, devices: [phone, laptop, tablet] } = await signInOn(fastify, 3);
    const foreign = await signIn(fastify);
    const cookies = laptop.accessCookie;

    assert.deepEqual(await readStatuses(fastify, [phone, laptop, tablet, foreign]), [200, 200, 200, 200]);

    assertEnded(await deleteSessions(fastify, '?except=current', { cookies }), []);
    assert.deepEqual(await listNotRevoked(fastify, userId), [laptop.sid]);
    assert.deepEqual(await readStatuses(fastify, [phone, laptop, tablet, foreign]), [401, 200, 401, 200]);
    assertRevoked(await getMe(fastify, { cookies: phone.accessCookie }));
    assert.deepEqual(readSids(await getSessions(fastify, { cookies })), [laptop.sid]);

    assertEnded(await deleteSessions(fastify, '?except=current', { cookies }), []);
    assert.deepEqual(await listNotRevoked(fastify, userId), [laptop.sid]);
  });

  test('with scope=all ends every session of the user, the current one too, none of anyone else, and clears the four cookies', async (t) => {
    const fastify = await openApp(t);
    const { userId, devices: [phone, laptop, tablet] } = await signInOn(fastify, 3);
    const foreign = await signIn(fastify);

    assertEnded(await deleteSessions(fastify, '?scope=all', { cookies: phone.accessCookie }), AUTH_NAMES);
    assert.deepEqual(await listNotRevoked(fastify, userId), []);
    assert.deepEqual(await readStatuses(fastify, [phone, laptop, tablet, foreign]), [401, 401, 401, 200]);
    assertRevoked(await deleteSessions(fastify, '?scope=all', { cookies: phone.accessCookie }));
  });

  test('with scope=all by the Bearer header leaves the cookies of the browser alone', async (t) => {
    const fastify = await openApp(t);
    const { userId, devices: [device] } = await signInOn(fastify, 2);
    const browser = await signIn(fastify);

    assertEnded(await deleteSessions(fastify, '?scope=all', { headers: device.bearer, cookies: browser.accessCookie }), []);
    assert.deepEqual(await listNotRevoked(fastify, userId), []);
    assert.deepEqual(await readStatuses(fastify, [browser]), [200]);
  });

  test('answers 422 to neither of the parameters, to both and to a value it does not know, names what is wrong, and ends nothing', async (t) => {
    const fastify = await openApp(t);
    const { userId, devices } = await signInOn(fastify, 2);
    const cookies = devices[0].accessCookie;
    const refusals = Object.entries({
      '': NO_CHOICE,
      '?scope=': NO_CHOICE,
      '?except=&scope=': NO_CHOICE,
      '?foo=1': NO_CHOICE,
      '?SCOPE=all': NO_CHOICE,
      '?except=current&scope=all': { ...NO_CHOICE, columnValue: 'all' },
      '?scope=everything': {
        column: 'scope',
        columnValue: 'everything',
        operator: 'enum',
        operatorValue: ['all'],
      },
      '?except=all': {
        column: 'except',
        columnValue: 'all',
        operator: 'enum',
        operatorValue: ['current'],
      },
    });
    const responses = await mapSeries(refusals, ([query]) => deleteSessions(fastify, query, { cookies }));

    assert.deepEqual(
      responses.map((response, index) => [refusals[index][0], response.statusCode, response.json(), response.cookies]),
      responses.map((response, index) => [refusals[index][0], 422, {
        ...errorBody(response, 'VALIDATION_ERROR', 'Validation error'),
        validation: [refusals[index][1]],
      }, []]),
    );
    assert.deepEqual(responses.map((response) => readHeaders(response)), responses.map(() => [NO_STORE, undefined]));
    assert.deepEqual(await listNotRevoked(fastify, userId), devices.map(({ sid }) => sid));
  });

  test('answers 422 to a parameter given twice, and drops one it does not know beside the one it takes', async (t) => {
    const fastify = await openApp(t);
    const { userId, devices: [phone, laptop] } = await signInOn(fastify, 2);
    const cookies = phone.accessCookie;
    const twice = await mapSeries(['?scope=all&scope=all', '?except=current&except=current'], (query) => deleteSessions(fastify, query, { cookies }));

    assert.deepEqual(twice.map((response) => [response.statusCode, response.json().code]), twice.map(() => [422, 'VALIDATION_ERROR']));
    assert.deepEqual(await listNotRevoked(fastify, userId), [phone.sid, laptop.sid]);

    assertEnded(await deleteSessions(fastify, '?except=current&page=1', { cookies }), []);
    assert.deepEqual(await listNotRevoked(fastify, userId), [phone.sid]);
  });
});

describe('a user on three devices', { skip: testRedis.skip || testDb.skip }, () => {
  before(() => up());

  MODES.forEach(({ title, isRedisUp }) => {
    test(`refreshes on the laptop, ends the tablet from the phone, logs out of the laptop and ends them all from the phone, ${title}`, async (t) => {
      const fastify = await openApp(t, { isRedisUp });
      const { userId, devices } = await signInOn(fastify, 3);
      const [phone, laptop, tablet] = ['phone', 'laptop', 'tablet'].map((name, index) => createBrowser(fastify, devices[index], name));
      const [phoneSid, laptopSid, tabletSid] = devices.map(({ sid }) => sid);

      await setActivity(fastify, devices[0], MORNING);
      await setActivity(fastify, devices[1], NOON);
      await setActivity(fastify, devices[2], EVENING);

      assert.deepEqual(readSids(await phone.send('GET', SESSIONS_URL)), [tabletSid, laptopSid, phoneSid]);

      assert.equal((await laptop.send('POST', REFRESH_URL)).statusCode, 200);
      assert.deepEqual(laptop.listNames(), AUTH_NAMES);
      assert.equal((await laptop.send('GET', ME_URL)).json().data.id, userId);

      const listed = (await phone.send('GET', SESSIONS_URL)).json().data;

      assert.deepEqual(listed.map((session) => pick(session, ['id', 'userAgent', 'ip', 'isCurrent'])), [
        {
          id: laptopSid,
          userAgent: 'laptop',
          ip: LOOPBACK,
          isCurrent: false,
        },
        { ...TEST_CLIENT, id: tabletSid, isCurrent: false },
        { ...TEST_CLIENT, id: phoneSid, isCurrent: true },
      ]);

      assertEnded(await phone.send('DELETE', `${SESSIONS_URL}/${tabletSid}`), []);
      assertRevoked(await tablet.send('GET', ME_URL));
      assert.deepEqual(tablet.listNames(), TOKEN_NAMES);
      assertRevoked(await tablet.send('POST', REFRESH_URL));
      assert.deepEqual(tablet.listNames(), []);

      assertEnded(await laptop.send('POST', LOGOUT_URL), AUTH_NAMES);
      assert.deepEqual(laptop.listNames(), []);
      assertRevoked(await getMe(fastify, { cookies: devices[1].accessCookie }));
      assert.equal((await laptop.send('GET', ME_URL)).json().code, 'AUTHENTICATION_ERROR');
      assert.deepEqual(readSids(await phone.send('GET', SESSIONS_URL)), [phoneSid]);

      assertEnded(await phone.send('DELETE', `${SESSIONS_URL}?scope=all`), AUTH_NAMES);
      assert.deepEqual(phone.listNames(), []);
      assertRevoked(await getMe(fastify, { cookies: devices[0].accessCookie }));
      assert.deepEqual(await listNotRevoked(fastify, userId), []);
    });
  });
});
