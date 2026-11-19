import { findContext } from '#core/context/index.js';
import {
  publish,
  REDIS_FAILURE,
  runRedisSafely,
} from '#core/redis/index.js';
import { timeIt, waitFor } from '#root/tests/helper/async.js';
import { createLogSink, findLogLines as findLines, LOG_LEVEL as LEVEL } from '#root/tests/helper/log.js';
import {
  createTcpProxy,
  createTestRedis,
  FAST_RECONNECT,
  waitUntilReady,
} from '#root/tests/helper/redis.js';
import { getServiceAddress } from '#root/tests/helper/service.js';
import { uuidv7 } from '#utils/id.js';
import { Redis } from 'ioredis';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const testRedis = await createTestRedis();

const LABEL = 'Proxied Redis';

// Short deadlines, so that a test of a hang takes a fraction of a second.
const SHORT_DEADLINES = Object.freeze({ ...FAST_RECONNECT, commandTimeout: '0.3s', socketTimeout: '0.6s' });
const COMMAND_TIMEOUT_MS = 300;
const FAST_FAILURE_MS = 100;
const TIMEOUT_SLACK_MS = 400;

// A client of the file's prefix that talks to Redis through a proxy the test can freeze and cut.
async function openProxied(t, sections = {}, { label = LABEL } = {}) {
  const proxy = await createTcpProxy(t, getServiceAddress('redis'));
  const sink = createLogSink();
  const opened = testRedis.open({
    ...sections,
    env: { ...proxy.env, ...sections.env },
    redis: { ...SHORT_DEADLINES, ...sections.redis },
    logger: { level: 'info', stream: sink.stream },
  }, { label });

  t.after(() => opened.redis.close());

  return { ...opened, proxy, sink };
}

async function openReadyProxied(t, sections) {
  const opened = await openProxied(t, sections);

  await waitUntilReady(opened.redis);

  return opened;
}

// The "ready" events from now on: right after a connection is cut, the status still reads "ready" for a moment.
function countReadyEvents(redis) {
  const ready = { count: 0 };

  redis.client.on('ready', () => {
    ready.count += 1;
  });

  return ready;
}

function collect() {
  const messages = [];

  function handler(message) {
    messages.push(message);
  }

  return { messages, handler };
}

async function countSubscribers(channel) {
  const [, count] = await testRedis.admin.pubsub('NUMSUB', channel);

  return count;
}

// A subscription is in place once Redis counts it: a message published before that would be lost.
function waitForSubscribers(channel, count, what) {
  return waitFor(async () => (await countSubscribers(channel)) === count, what);
}

describe('createRedis on a Redis', { skip: testRedis.skip }, () => {
  test('connects when told to, is ready, and puts the key prefix of the file in front of every key', async () => {
    const { redis, run } = testRedis;

    assert.equal(redis.isReady(), true);
    assert.equal(await run(() => runRedisSafely((client) => client.set('greeting', 'hello', 'PX', 60000), 'Redis write failed')), 'OK');
    assert.equal(await testRedis.admin.get(`${testRedis.keyPrefix}greeting`), 'hello');
    assert.equal(await testRedis.admin.get('greeting'), null);
  });

  test('gives back the values of a pipeline it runs', async () => {
    const { run } = testRedis;
    const result = await run(() => runRedisSafely((client) => client.pipeline().set('counter', '5', 'PX', 60000).incr('counter'), 'Redis pipeline failed'));

    assert.deepEqual(result, ['OK', 6]);
  });

  test('does not let a pipeline hide an error in its result, and logs it', async (t) => {
    const { redis, run, sink } = await openReadyProxied(t);
    const result = await run(() => runRedisSafely((client) => client.multi().set('word', 'abc', 'PX', 60000).incr('word'), 'Redis pipeline failed'));
    const [failed] = findLines(sink, 'Redis pipeline failed');

    assert.equal(result, REDIS_FAILURE);
    assert.equal(failed.level, LEVEL.ERROR);
    assert.match(failed.err.message, /not an integer/);
    assert.equal(failed.redis.address, redis.address);
  });

  test('keeps the arguments of a failed command out of the log: the value of a SET, alone and inside a refused MULTI', async (t) => {
    const { run, sink } = await openReadyProxied(t);
    const marker = `marker-${uuidv7()}`;

    await run(() => runRedisSafely((client) => client.set('profile', marker, 'PX', 0), 'Redis write failed'));
    await run(() => runRedisSafely((client) => client.multi().call('set', marker).get('profile'), 'Redis transaction failed'));

    const [single] = findLines(sink, 'Redis write failed');
    const [transaction] = findLines(sink, 'Redis transaction failed');

    assert.deepEqual(single.err.command, { name: 'set' });
    assert.match(transaction.err.message, /^EXECABORT/);
    assert.deepEqual(transaction.err.previousErrors.map((previous) => previous.command), [{ name: 'set' }]);
    assert.equal(JSON.stringify(sink.lines).includes(marker), false);
  });

  test('a password Redis refuses stays out of the log', async (t) => {
    const marker = `marker-${uuidv7()}`;
    const { sink } = await openProxied(t, { env: { APP_REDIS_USER: `nfs-test-${uuidv7()}`, APP_REDIS_PASSWORD: marker } });

    await waitFor(() => findLines(sink, `${LABEL} is not reachable`)[0], 'the refusal');

    assert.match(findLines(sink, `${LABEL} is not reachable`)[0].err.message, /WRONGPASS/);
    assert.equal(JSON.stringify(sink.lines).includes(marker), false);
  });

  test('a command to a Redis that hangs fails within commandTimeout and is logged', async (t) => {
    const { run, proxy, sink } = await openReadyProxied(t);

    proxy.freeze();

    const { result, durationMs } = await timeIt(() => run(() => runRedisSafely((client) => client.get('greeting'), 'Redis read failed')));
    const [failed] = findLines(sink, 'Redis read failed');

    assert.equal(result, REDIS_FAILURE);
    assert.ok(durationMs >= COMMAND_TIMEOUT_MS - 5 && durationMs < COMMAND_TIMEOUT_MS + TIMEOUT_SLACK_MS, `${durationMs} ms`);
    assert.equal(failed.err.message, 'Command timed out');
  });

  test('a connection that hangs stops being ready after socketTimeout: later commands fail at once', async (t) => {
    const { redis, run, proxy } = await openReadyProxied(t);

    proxy.freeze();
    await run(() => runRedisSafely((client) => client.get('greeting'), 'Redis read failed'));
    await waitFor(() => !redis.isReady(), 'the client to give the silent connection up');

    const { result, durationMs } = await timeIt(() => run(() => runRedisSafely((client) => client.get('greeting'), 'Redis read failed')));

    assert.equal(result, REDIS_FAILURE);
    assert.ok(durationMs < FAST_FAILURE_MS, `${durationMs} ms`);

    proxy.thaw();
    await waitUntilReady(redis);
  });

  // The connections are cut before the proxy thaws: the bytes it held die with them, as they would with a server
  // that never read them. What could reach Redis after that is only a command sent again.
  test('a command its caller saw time out is not sent again after the reconnect', async (t) => {
    const { redis, run, proxy } = await openReadyProxied(t);
    const ready = countReadyEvents(redis);

    proxy.freeze();
    assert.equal(await run(() => runRedisSafely((client) => client.incr('resent'), 'Redis write failed')), REDIS_FAILURE);
    proxy.kill();
    proxy.thaw();
    await waitFor(() => ready.count === 1, 'the client to come back');
    await run(() => runRedisSafely((client) => client.ping(), 'Redis ping failed'));

    assert.equal(await testRedis.admin.get(`${testRedis.keyPrefix}resent`), null);
  });

  test('the harness sees a command sent again: ioredis left to resend does run the INCR after the reconnect', async (t) => {
    const proxy = await createTcpProxy(t, getServiceAddress('redis'));
    const key = `${testRedis.keyPrefix}resent-control`;
    const client = new Redis({
      ...testRedis.redis.client.options,
      host: proxy.env.APP_REDIS_HOST,
      port: proxy.port,
      keyPrefix: undefined,
      lazyConnect: true,
      autoResendUnfulfilledCommands: true,
      socketTimeout: undefined,
    });

    t.after(() => client.disconnect());
    client.on('error', () => {});
    await client.connect();
    proxy.freeze();
    await assert.rejects(client.incr(key), /Command timed out/);
    proxy.kill();
    proxy.thaw();

    await waitFor(async () => (await testRedis.admin.get(key)) === '1', 'the INCR sent again');
  });

  test('logs the loss of the connection once and its return with the time it was away', async (t) => {
    const { redis, proxy, sink } = await openReadyProxied(t);

    proxy.kill();
    await waitFor(() => findLines(sink, `${LABEL} is back`)[0], 'the client to come back');

    const [lost] = findLines(sink, `${LABEL} connection is lost`);
    const [back] = findLines(sink, `${LABEL} is back`);

    assert.equal(findLines(sink, `${LABEL} connection is lost`).length, 1);
    assert.equal(lost.level, LEVEL.WARN);
    assert.equal(back.level, LEVEL.INFO);
    assert.equal(typeof back.redis.downMs, 'number');
    assert.equal(redis.isReady(), true);
  });

  test('close() says goodbye on both connections and leaves none open', async (t) => {
    const { redis, proxy } = await openReadyProxied(t);
    const { handler } = collect();

    redis.subscribe('events', handler);
    await waitForSubscribers(redis.toChannel('events'), 1, 'the subscription');
    assert.equal(proxy.countConnections(), 2);

    assert.equal(await redis.close(), true);
    await waitFor(() => proxy.countConnections() === 0, 'the connections to close');
    assert.equal(redis.isReady(), false);
  });

  // A paused socket of the proxy does not see the FIN of the client: the end is read from the client.
  test('close() of a client whose Redis hangs ends within commandTimeout and cuts its connection', async (t) => {
    const { redis, proxy } = await openReadyProxied(t);

    redis.subscribe('events', () => {});
    await waitForSubscribers(redis.toChannel('events'), 1, 'the subscription');
    proxy.freeze();

    const { result, durationMs } = await timeIt(() => redis.close());

    assert.equal(result, true);
    assert.ok(durationMs >= COMMAND_TIMEOUT_MS - 5 && durationMs < COMMAND_TIMEOUT_MS + TIMEOUT_SLACK_MS, `${durationMs} ms`);
    await waitFor(() => redis.client.status === 'end', 'the client to end');
    assert.equal(redis.client.stream.destroyed, true);
  });
});

describe('createRedis on a Redis: pub/sub', { skip: testRedis.skip }, () => {
  test('delivers what is published to the channel under the prefix of the file, on a connection of its own', async (t) => {
    const { redis, run, proxy } = await openReadyProxied(t);
    const { messages, handler } = collect();

    redis.subscribe('events', handler);
    await waitForSubscribers(redis.toChannel('events'), 1, 'the subscription');

    assert.equal(proxy.countConnections(), 2);
    assert.equal(await run(() => publish('events', 'hello')), 1);
    await waitFor(() => messages.includes('hello'), 'the message');
  });

  test('keeps the channels of other prefixes apart', async (t) => {
    const { redis } = await openReadyProxied(t);
    const { messages, handler } = collect();

    redis.subscribe('events', handler);
    await waitForSubscribers(redis.toChannel('events'), 1, 'the subscription');
    await testRedis.admin.publish('events', 'bare');
    await testRedis.admin.publish(`${testRedis.keyPrefix}other:events`, 'foreign');
    await testRedis.admin.publish(redis.toChannel('events'), 'own');
    await waitFor(() => messages.includes('own'), 'the own message');

    assert.deepEqual(messages, ['own']);
  });

  test('subscribes again after the connection of messages is lost', async (t) => {
    const { redis, proxy } = await openReadyProxied(t);
    const { messages, handler } = collect();
    const channel = redis.toChannel('events');

    redis.subscribe('events', handler);
    await waitForSubscribers(channel, 1, 'the subscription');
    proxy.kill();
    await waitForSubscribers(channel, 0, 'the subscription to go with the connection');
    await waitForSubscribers(channel, 1, 'the subscription after the reconnect');
    await testRedis.admin.publish(channel, 'after');

    await waitFor(() => messages.includes('after'), 'the message after the reconnect');
  });

  test('a channel subscribed to while the connection is down is subscribed to once it is back', async (t) => {
    const { redis, proxy } = await openReadyProxied(t);
    const { messages, handler } = collect();
    const channel = redis.toChannel('late');

    proxy.freeze();
    proxy.kill();
    redis.subscribe('late', handler);
    await sleep(COMMAND_TIMEOUT_MS);
    proxy.thaw();
    await waitForSubscribers(channel, 1, 'the late subscription');
    await testRedis.admin.publish(channel, 'late');

    await waitFor(() => messages.includes('late'), 'the late message');
  });

  test('a handler that throws or rejects is logged, and the other handlers of the channel still get the message', async (t) => {
    const { redis, sink } = await openReadyProxied(t);
    const { messages, handler } = collect();
    const channel = redis.toChannel('events');

    redis.subscribe('events', () => {
      throw new Error('handler failed');
    });
    redis.subscribe('events', async () => {
      throw new Error('async handler failed');
    });
    redis.subscribe('events', handler);
    await waitForSubscribers(channel, 1, 'the subscription');
    await testRedis.admin.publish(channel, 'hello');
    await waitFor(() => findLines(sink, `A ${LABEL} message handler failed`).length === 2, 'the failures to be logged');

    const failures = findLines(sink, `A ${LABEL} message handler failed`).map((line) => line.err.message).sort();

    assert.deepEqual(failures, ['async handler failed', 'handler failed']);
    assert.deepEqual(messages, ['hello']);
  });

  test('runs a handler in the context its subscribe() was called in, and one subscribed outside any context without one', async (t) => {
    const { redis, run, context } = await openReadyProxied(t);
    const seen = [];
    const channel = redis.toChannel('events');

    run(() => redis.subscribe('events', () => seen.push(['inside', findContext() === context])));
    redis.subscribe('events', () => seen.push(['outside', findContext()]));
    await waitForSubscribers(channel, 1, 'the subscription');
    await testRedis.admin.publish(channel, 'hello');
    await waitFor(() => seen.length === 2, 'the message');

    assert.deepEqual(seen.sort(), [['inside', true], ['outside', null]]);
  });

  test('unsubscribe() stops the delivery to that handler only, and the last one leaves the channel', async (t) => {
    const { redis, run } = await openReadyProxied(t);
    const first = collect();
    const second = collect();
    const channel = redis.toChannel('events');
    const unsubscribeFirst = redis.subscribe('events', first.handler);
    const unsubscribeSecond = redis.subscribe('events', second.handler);

    await waitForSubscribers(channel, 1, 'the subscription');
    unsubscribeFirst();
    await run(() => publish('events', 'after'));
    await waitFor(() => second.messages.includes('after'), 'the message to the handler that stays');

    assert.equal(first.messages.includes('after'), false);

    unsubscribeSecond();
    await waitForSubscribers(channel, 0, 'the channel to be left');
  });
});
