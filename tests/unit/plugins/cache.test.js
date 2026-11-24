import { wrapCache } from '#core/cache/index.js';
import {
  ACCEPTED,
  createAlertReceiver,
  readBlock,
  readTitles,
} from '#root/tests/helper/alert.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import {
  createFakeRedis,
  createSilentServer,
  FAST_RECONNECT,
  REDIS_DOWN_ENV,
} from '#root/tests/helper/redis.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const SHARED_MESSAGE = 'Cache lives in the main Redis: it must run with noeviction and memory to spare';
const OWN_MESSAGE = 'Cache uses a Redis of its own';

const SHORT_OUTAGE = '0.2s';
const SHORT_OUTAGE_MS = 200;
const PAST_SHORT_OUTAGE_MS = 600;

const OUTAGE_TEXT = 'The cache is off and reads go to the database';

// The millisecond clock of libuv floors the moment a timer starts at: a timer may fire a millisecond early.
const TIMER_SLACK_MS = 5;

// Shorter than outageAlertAfter: the window a try has taken is over by the next try.
const SHORT_THROTTLE = '0.05s';

// Longer than outageAlertAfter and shorter than two of it: an alert taken just before the outage holds back
// its first report only.
const COVERING_THROTTLE = '0.3s';

// The handshake with a server that is silent ends at this, and the client tries again.
const SHORT_DEADLINES = Object.freeze({ commandTimeout: '0.2s', socketTimeout: '0.2s' });

const FAILED = Object.freeze({ status: 500 });

async function buildApp(t, { env = {}, ...sections } = {}) {
  const sink = createLogSink();
  const fastify = await buildTestApp({
    ...sections,
    env: { ...REDIS_DOWN_ENV, ...env },
    redis: { ...FAST_RECONNECT, ...sections.redis },
    cache: { outageAlertAfter: SHORT_OUTAGE },
    logger: { level: 'info', stream: sink.stream },
  });

  t.after(() => fastify.close());

  return { fastify, sink };
}

async function createOwnCacheEnv(t) {
  const server = await createSilentServer(t);

  return { APP_CACHE_REDIS_HOST: '127.0.0.1', APP_CACHE_REDIS_PORT: String(server.port) };
}

function findOutages(sink, label) {
  return sink.lines.filter((line) => line.msg === `${label} is down: the cache is off and reads go to the database`);
}

async function createTimedReceiver(t, answers = []) {
  const receivedAt = [];
  const queue = [...answers];
  const receiver = await createAlertReceiver(t, () => {
    receivedAt.push(performance.now());

    return queue.shift() ?? ACCEPTED;
  });

  return { ...receiver, receivedAt };
}

// Silent until goUp() and again after goDown(): every handshake with it times out meanwhile.
async function createSwitchableRedis(t) {
  const switchable = { isSilent: true };
  const fake = await createFakeRedis(t, () => (switchable.isSilent ? '' : null));

  function goUp() {
    switchable.isSilent = false;

    return true;
  }

  function goDown() {
    switchable.isSilent = true;

    return fake.kill();
  }

  return { env: { APP_REDIS_HOST: '127.0.0.1', APP_REDIS_PORT: String(fake.port) }, goUp, goDown };
}

describe('cache plugin', () => {
  test('is registered under the name "cache" and says once at the start that the cache lives in the main Redis', async (t) => {
    const { fastify, sink } = await buildApp(t);
    const lines = sink.lines.filter((line) => line.msg === SHARED_MESSAGE);

    assert.equal(fastify.hasPlugin('cache'), true);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 30);
    assert.equal(lines[0].cache.redis, fastify.redis.address);
    assert.equal(sink.lines.some((line) => line.msg === OWN_MESSAGE), false);
  });

  test('says once that the cache uses a Redis of its own, with its address and no credentials', async (t) => {
    const env = { ...(await createOwnCacheEnv(t)), APP_CACHE_REDIS_USER: 'cache', APP_CACHE_REDIS_PASSWORD: 'cache-secret' };
    const { fastify, sink } = await buildApp(t, { env });
    const lines = sink.lines.filter((line) => line.msg === OWN_MESSAGE);

    assert.equal(lines.length, 1);
    assert.equal(lines[0].cache.redis, fastify.cacheRedis.address);
    assert.equal(JSON.stringify(sink.lines).includes('cache-secret'), false);
  });

  test('reports a Redis of its own that stays down, once', async (t) => {
    const { fastify, sink } = await buildApp(t, { env: await createOwnCacheEnv(t) });

    fastify.cacheRedis.connect();

    const outage = await waitFor(() => findOutages(sink, 'Cache Redis')[0], 'the outage to be reported');

    await sleep(PAST_SHORT_OUTAGE_MS);

    assert.equal(outage.level, 40);
    assert.equal(outage.cache.address, fastify.cacheRedis.address);
    assert.equal(findOutages(sink, 'Cache Redis').length, 1);
  });

  test('also reports the main Redis when the cache lives in it: that is the cache Redis then', async (t) => {
    const { fastify, sink } = await buildApp(t);

    fastify.redis.connect();
    await waitFor(() => findOutages(sink, 'Redis').length === 1, 'the outage to be reported');

    assert.equal(findOutages(sink, 'Redis')[0].cache.address, fastify.redis.address);
  });

  test('stops watching when the app closes', async (t) => {
    const { fastify, sink } = await buildApp(t, { env: await createOwnCacheEnv(t) });

    fastify.cacheRedis.connect();
    await fastify.close();
    await sleep(PAST_SHORT_OUTAGE_MS);

    assert.deepEqual(findOutages(sink, 'Cache Redis'), []);
  });

  test('a route that caches answers with what its function gives when Redis is down, not with a 500', async (t) => {
    const { fastify } = await buildApp(t);

    fastify.redis.connect();
    fastify.get('/cached', {
      schema: { response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { at: { type: 'string' } } } } } } },
    }, async (request, reply) => reply.ok(await wrapCache('cached', () => ({ at: new Date(0) }), { tables: ['users'] })));

    const response = await fastify.inject('/cached');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { at: '1970-01-01T00:00:00.000Z' });
  });
});

describe('cache plugin: outage alerts', () => {
  test('sends one alert "<label> is down" to the channels once the outage outlasts outageAlertAfter, and no other', async (t) => {
    const receiver = await createTimedReceiver(t);
    const env = {
      ...receiver.env.webhook,
      ...(await createOwnCacheEnv(t)),
      APP_CACHE_REDIS_USER: 'cache',
      APP_CACHE_REDIS_PASSWORD: 'cache-secret',
    };
    const { fastify } = await buildApp(t, { env, ...receiver.config });
    const connectedAt = performance.now();

    fastify.cacheRedis.connect();

    const [request] = await waitFor(() => receiver.requests.length > 0 && receiver.requests, 'the outage alert');

    await sleep(PAST_SHORT_OUTAGE_MS);

    const { downMs, ...error } = readBlock(request.body, 'Error');
    const waitedMs = receiver.receivedAt[0] - connectedAt;

    assert.equal(receiver.requests.length, 1);
    assert.ok(waitedMs >= SHORT_OUTAGE_MS - TIMER_SLACK_MS, `The alert came ${waitedMs} ms after the outage began`);
    assert.equal(request.path, receiver.paths.webhook);
    assert.equal(request.body.title, 'Cache Redis is down');
    assert.equal(request.body.space, 'internal');
    assert.equal(request.body.isSilent, false);
    assert.deepEqual(error, { message: OUTAGE_TEXT, address: fastify.cacheRedis.address });
    assert.ok(downMs >= SHORT_OUTAGE_MS - TIMER_SLACK_MS, `${downMs} ms`);
    assert.equal(JSON.stringify(request.body).includes('cache-secret'), false);
  });

  test('tries again after outageAlertAfter when the channel fails, and the next try is delivered', async (t) => {
    const receiver = await createTimedReceiver(t, [FAILED]);
    const { fastify, sink } = await buildApp(t, {
      env: receiver.env.webhook,
      alert: { ...receiver.config.alert, throttleWindow: SHORT_THROTTLE },
    });

    fastify.redis.connect();
    await waitFor(() => receiver.requests.length === 2, 'the second try');
    await sleep(PAST_SHORT_OUTAGE_MS);

    const gapMs = receiver.receivedAt[1] - receiver.receivedAt[0];

    assert.deepEqual(readTitles(receiver), ['Redis is down', 'Redis is down']);
    assert.ok(gapMs >= SHORT_OUTAGE_MS - TIMER_SLACK_MS, `The second try came ${gapMs} ms after the first`);
    assert.equal(findLogLines(sink, 'Alert not delivered').length, 1);
    assert.equal(findLogLines(sink, 'Alert not delivered')[0].alert.reason, 'failed');
    assert.equal(findLogLines(sink, 'Alert sent').length, 1);
    assert.equal(findOutages(sink, 'Redis').length, 2);
  });

  test('tries again after outageAlertAfter when the alert is held back, and the next try is delivered', async (t) => {
    const receiver = await createTimedReceiver(t);
    const { fastify, sink } = await buildApp(t, {
      env: receiver.env.webhook,
      alert: { ...receiver.config.alert, throttleWindow: COVERING_THROTTLE },
    });

    fastify.get('/boom', async () => {
      throw new Error('Route failed');
    });
    await fastify.ready();

    const failure = await fastify.inject('/boom');
    const connectedAt = performance.now();

    fastify.redis.connect();
    await waitFor(() => receiver.requests.length === 2, 'the outage alert');
    await sleep(PAST_SHORT_OUTAGE_MS);

    const waitedMs = receiver.receivedAt[1] - connectedAt;

    assert.equal(failure.statusCode, 500);
    assert.deepEqual(readTitles(receiver), ['Server error (5xx)', 'Redis is down']);
    assert.ok(waitedMs >= 2 * SHORT_OUTAGE_MS - TIMER_SLACK_MS, `The outage alert came ${waitedMs} ms after the outage began`);
    assert.equal(findOutages(sink, 'Redis').length, 2);
  });

  test('sends a silent "<label> is back" once a reported outage is over, with the time it was down', async (t) => {
    const receiver = await createTimedReceiver(t);
    const switchable = await createSwitchableRedis(t);
    const { fastify } = await buildApp(t, {
      env: { ...receiver.env.webhook, ...switchable.env },
      ...receiver.config,
      redis: SHORT_DEADLINES,
    });

    fastify.redis.connect();
    await waitFor(() => receiver.requests.length === 1, 'the outage alert');
    switchable.goUp();
    await waitFor(() => receiver.requests.length === 2, 'the recovery alert');
    await sleep(PAST_SHORT_OUTAGE_MS);

    const { downMs, ...recovery } = readBlock(receiver.requests[1].body, 'Error');

    assert.deepEqual(receiver.requests.map((request) => [request.body.title, request.body.isSilent]), [
      ['Redis is down', false],
      ['Redis is back', true],
    ]);
    assert.equal(receiver.requests[1].body.throttleClass, 'silent');
    assert.deepEqual(recovery, { address: fastify.redis.address });
    assert.ok(downMs >= SHORT_OUTAGE_MS - TIMER_SLACK_MS, `${downMs} ms`);
  });

  test('reports a new outage after a reported recovery too: each outage that outlasts outageAlertAfter sends its alert', async (t) => {
    const receiver = await createTimedReceiver(t);
    const switchable = await createSwitchableRedis(t);
    const { fastify } = await buildApp(t, {
      env: { ...receiver.env.webhook, ...switchable.env },
      alert: { ...receiver.config.alert, throttleWindow: SHORT_THROTTLE },
      redis: SHORT_DEADLINES,
    });

    fastify.redis.connect();
    await waitFor(() => receiver.requests.length === 1, 'the first outage alert');
    switchable.goUp();
    await waitFor(() => receiver.requests.length === 2, 'the recovery alert');
    switchable.goDown();
    await waitFor(() => !fastify.redis.isReady(), 'the client to lose its connection');
    await sleep(2 * PAST_SHORT_OUTAGE_MS);

    assert.deepEqual(readTitles(receiver), ['Redis is down', 'Redis is back', 'Redis is down']);
  });
});
