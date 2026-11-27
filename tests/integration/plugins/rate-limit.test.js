import { HEADER } from '#enums/header.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { issueFor } from '#root/tests/helper/guard.js';
import {
  createTcpProxy,
  createTestRedis,
  FAST_RECONNECT,
  scanKeys,
  toScanPattern,
} from '#root/tests/helper/redis.js';
import { getServiceAddress } from '#root/tests/helper/service.js';
import { connectAppRedis } from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { convertStringToMs } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const testRedis = await createTestRedis();

const NAMESPACE = 'rate-limit:';

const PING_URL = '/ping';
const TWIN_URL = '/twin';

const GUEST_MAX = 2;
const USER_MAX = 4;
const WINDOW = '1m';
const WINDOW_MS = convertStringToMs(WINDOW);

const TIERS = Object.freeze({
  guest: Object.freeze({ max: GUEST_MAX, window: WINDOW }),
  user: Object.freeze({ max: USER_MAX, window: WINDOW }),
});
const TWIN_LIMIT = Object.freeze({ max: 2, window: WINDOW });

// inject() comes from loopback, an internal request the limiter never counts: the client is named in X-Forwarded-For.
const CLIENT = '8.8.8.8';

// The TTL of a counter falls this far before the refused requests: a window they started again would be back above it.
const FALL_MS = 50;

// A command that hangs gives up soon, and so does the connection it hangs on.
const IMPATIENT = Object.freeze({ commandTimeout: '0.2s', socketTimeout: '0.2s', ...FAST_RECONNECT });

function answerDone() {
  return { isDone: true };
}

// Under the prefix of the file, so the keys go with it, and apart for each test: one client is the same in all of them.
function createAppPrefix() {
  return `${testRedis.keyPrefix}${uuidv7()}:`;
}

async function openApp(t, { keyPrefix = createAppPrefix(), env = {}, redis = {} } = {}) {
  const fastify = await buildTestApp({
    env: { ...(await createDownEnv()), ...env },
    redis: { ...redis, keyPrefix },
    rateLimit: { tiers: TIERS },
  });

  t.after(() => fastify.close());
  fastify.get(PING_URL, answerDone);
  fastify.get(TWIN_URL, { security: { auth: false, rateLimit: TWIN_LIMIT } }, answerDone);
  await connectAppRedis(fastify);

  return { fastify, keyPrefix };
}

function fromAddress(address, request = {}) {
  return {
    url: PING_URL,
    ...request,
    headers: { [HEADER.X_FORWARDED_FOR]: address, ...request.headers },
  };
}

function repeat(count, item) {
  return Array.from({ length: count }, () => item);
}

function sendInTurn(fastify, requests) {
  return mapSeries(requests, (request) => fastify.inject(request));
}

function readStatuses(responses) {
  return responses.map((response) => response.statusCode);
}

function toAddressKey(keyPrefix, address) {
  return `${keyPrefix}${NAMESPACE}ip:${address}`;
}

describe('rate-limit plugin on a Redis shared by processes', { skip: testRedis.skip }, () => {
  test('counts a client in one counter for every process on the prefix: what one counted, another refuses, for a tier and for a route with its HEAD twin', async (t) => {
    const first = await openApp(t);
    const second = await openApp(t, { keyPrefix: first.keyPrefix });
    const responses = await mapSeries([
      [first, { url: PING_URL }],
      [second, { url: PING_URL }],
      [first, { url: PING_URL }],
      [first, { url: TWIN_URL }],
      [second, { method: 'HEAD', url: TWIN_URL }],
      [second, { url: TWIN_URL }],
    ], ([app, request]) => app.fastify.inject(fromAddress(CLIENT, request)));

    assert.deepEqual(readStatuses(responses), [200, 200, 429, 200, 200, 429]);
  });

  test('keeps its counters under the prefix of the app and "rate-limit:", those of a route under its method and path, each with the TTL of its window', async (t) => {
    const { fastify, keyPrefix } = await openApp(t);
    const user = issueFor(fastify);
    const responses = await sendInTurn(fastify, [
      fromAddress(CLIENT),
      fromAddress(CLIENT, { headers: user.headers }),
      fromAddress(CLIENT, { url: TWIN_URL }),
      fromAddress(CLIENT, { method: 'HEAD', url: TWIN_URL }),
    ]);
    const keys = (await scanKeys(testRedis.admin, toScanPattern(keyPrefix))).toSorted();
    const [values, ttls] = await Promise.all([
      Promise.all(keys.map((key) => testRedis.admin.get(key))),
      Promise.all(keys.map((key) => testRedis.admin.pttl(key))),
    ]);

    assert.deepEqual(readStatuses(responses), [200, 200, 200, 200]);
    assert.deepEqual(keys, [
      `${keyPrefix}${NAMESPACE}GET ${TWIN_URL}:ip:${CLIENT}`,
      toAddressKey(keyPrefix, CLIENT),
      `${keyPrefix}${NAMESPACE}user:${user.userId}`,
    ]);
    assert.deepEqual(values, ['2', '1', '1']);
    ttls.forEach((ttl) => assert.ok(ttl > 0 && ttl <= WINDOW_MS, `${ttl} ms`));
  });

  test('does not extend the window of a client by its refused requests: the TTL of its counter goes on falling', async (t) => {
    const { fastify, keyPrefix } = await openApp(t);
    const key = toAddressKey(keyPrefix, CLIENT);
    const opened = await sendInTurn(fastify, repeat(GUEST_MAX, fromAddress(CLIENT)));
    const openedTtl = await testRedis.admin.pttl(key);

    await waitFor(async () => (await testRedis.admin.pttl(key)) <= openedTtl - FALL_MS, `the TTL ${FALL_MS} ms below ${openedTtl} ms`);

    const refused = await sendInTurn(fastify, repeat(3, fromAddress(CLIENT)));
    const ttl = await testRedis.admin.pttl(key);

    assert.deepEqual(readStatuses([...opened, ...refused]), [200, 200, 429, 429, 429]);
    assert.ok(ttl > 0 && ttl <= openedTtl - FALL_MS, `${ttl} ms after the refusals, ${openedTtl} ms before them`);
    assert.equal(await testRedis.admin.get(key), '5');
  });

  test('goes on limiting in memory, with no 500, once the Redis of the app is closed', async (t) => {
    const { fastify, keyPrefix } = await openApp(t);
    const key = toAddressKey(keyPrefix, CLIENT);
    const counted = await fastify.inject(fromAddress(CLIENT));
    const countedInRedis = await testRedis.admin.get(key);

    await fastify.redis.close();

    const inMemory = await sendInTurn(fastify, repeat(GUEST_MAX + 1, fromAddress(CLIENT)));

    assert.deepEqual([counted.statusCode, countedInRedis], [200, '1']);
    assert.deepEqual(readStatuses(inMemory), [200, 200, 429]);
    assert.equal(await testRedis.admin.get(key), '1');
  });

  test('goes on limiting in memory, with no 500, while the Redis of the app hangs and once it cannot be reached', async (t) => {
    const proxy = await createTcpProxy(t, getServiceAddress('redis'));
    const { fastify, keyPrefix } = await openApp(t, { env: proxy.env, redis: IMPATIENT });
    const key = toAddressKey(keyPrefix, CLIENT);
    const counted = await fastify.inject(fromAddress(CLIENT));

    proxy.freeze();

    const whileHanging = await fastify.inject(fromAddress(CLIENT));

    proxy.kill();

    const whileUnreachable = await sendInTurn(fastify, repeat(GUEST_MAX, fromAddress(CLIENT)));

    assert.deepEqual(readStatuses([counted, whileHanging, ...whileUnreachable]), [200, 200, 200, 429]);
    assert.equal(fastify.redis.isReady(), false);
    assert.equal(await testRedis.admin.get(key), '1');
  });
});
