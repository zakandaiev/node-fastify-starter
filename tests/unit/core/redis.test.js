import { createContext, findContext, runInContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import {
  createRedis,
  publish,
  REDIS_FAILURE,
  runRedisSafely,
} from '#core/redis/index.js';
import { timeIt, waitFor } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createLogSink, findLogLines as findLines, LOG_LEVEL as LEVEL } from '#root/tests/helper/log.js';
import { runNode } from '#root/tests/helper/process.js';
import {
  createFakeRedis,
  createSilentServer,
  FAST_RECONNECT,
  REDIS_DOWN_ENV,
  RESP_OK,
  toRespBulk,
  toRespError,
  waitUntilReady,
} from '#root/tests/helper/redis.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const CLOSE_REDIS = 'tests/fixture/close-redis.js';
const LABEL = 'Redis';

// A command that fails at once is far below this; one that waits for its timeout is not.
const FAST_FAILURE_MS = 200;

const MARKER_PASSWORD = 'marker-password-0123456789';
const WRONGPASS = 'WRONGPASS invalid username-password pair or user is disabled.';
const REQUEST_ID = 'request-1';

function toEnv(port) {
  return { APP_REDIS_HOST: '127.0.0.1', APP_REDIS_PORT: String(port) };
}

// The client logs with its own logger, the context with a child of it that carries the id of a request.
function openRedis(t, { env = REDIS_DOWN_ENV, redis: sections = {} } = {}) {
  const sink = createLogSink();
  const config = createTestConfig({
    env,
    redis: sections,
    logger: { level: 'debug', stream: sink.stream },
  });
  const { cache, ...main } = config.redis;
  const log = createLogger(config.logger);
  const redis = createRedis(main, { log, label: LABEL });
  const context = createContext({ config, log: log.child({ requestId: REQUEST_ID }), redis });

  function run(fn) {
    return runInContext(context, fn);
  }

  t.after(() => redis.close());

  return {
    config,
    main,
    log,
    redis,
    sink,
    run,
  };
}

async function openFake(t, respond, sections = {}) {
  const fake = await createFakeRedis(t, respond);
  const opened = openRedis(t, { env: { ...toEnv(fake.port), APP_REDIS_PASSWORD: MARKER_PASSWORD }, redis: sections });

  opened.redis.connect();
  await waitUntilReady(opened.redis);

  return { ...opened, fake };
}

function answer(name, reply) {
  return (args) => (args[0].toUpperCase() === name
    ? reply
    : null);
}

describe('createRedis', () => {
  test('requires the redis section with a host, a port, a key prefix and durations above zero', (t) => {
    const { main, log } = openRedis(t);
    const options = { log, label: LABEL };

    assert.throws(() => createRedis(undefined, options), /requires the redis section/);
    assert.throws(() => createRedis({ ...main, host: '' }, options), /requires a host and a port/);
    assert.throws(() => createRedis({ ...main, port: '6379' }, options), /requires a host and a port/);
    assert.throws(() => createRedis({ ...main, keyPrefix: '' }, options), /requires a keyPrefix/);
    assert.throws(() => createRedis({ ...main, commandTimeout: '0s' }, options), /to be above zero/);
    assert.throws(() => createRedis({ ...main, failureLogWindow: undefined }, options), /convertStringToMs/);
    assert.throws(() => createRedis({ ...main, reconnectStep: '1 s' }, options), /convertStringToMs/);
    assert.throws(() => createRedis({ ...main, socketTimeout: '0.5s', commandTimeout: '1s' }, options), /socketTimeout to be at least commandTimeout/);
  });

  test('requires a logger and a label', (t) => {
    const { main, log } = openRedis(t);

    assert.throws(() => createRedis(main), /requires a logger and a label/);
    assert.throws(() => createRedis(main, { log }), /requires a logger and a label/);
    assert.throws(() => createRedis(main, { log: {}, label: LABEL }), /requires a logger and a label/);
  });

  test('gives the client the contract: no offline queue, one retry, a deadline for every command, for a silent socket and for a wait on loading, no resend after a reconnect', (t) => {
    const { redis, config } = openRedis(t);
    const { options } = redis.client;

    assert.equal(options.lazyConnect, true);
    assert.equal(options.enableOfflineQueue, false);
    assert.equal(options.maxRetriesPerRequest, 1);
    assert.equal(options.autoResendUnfulfilledCommands, false);
    assert.equal(options.commandTimeout, 1000);
    assert.equal(options.socketTimeout, 2000);
    assert.equal(options.connectTimeout, 10000);
    assert.equal(options.maxLoadingRetryTime, 1000);
    assert.equal(options.disconnectTimeout, 0);
    assert.equal(options.keyPrefix, config.redis.keyPrefix);
    assert.equal(redis.keyPrefix, config.redis.keyPrefix);
    assert.equal(redis.address, `${config.redis.host}:${config.redis.port}`);
  });

  test('backs off linearly from the step to the ceiling of the config', (t) => {
    const { redis } = openRedis(t, { redis: { reconnectStep: '0.5s', reconnectMaxDelay: '2s' } });
    const delays = [1, 2, 3, 4, 5, 100].map((attempt) => redis.client.options.retryStrategy(attempt));

    assert.deepEqual(delays, [500, 1000, 1500, 2000, 2000, 2000]);
  });

  test('opens no connection until connect() is called, also when a command is asked for, and says once that it was never started', async (t) => {
    const server = await createSilentServer(t);
    const { redis, run, sink } = openRedis(t, { env: toEnv(server.port) });
    let isAsked = false;

    function ask() {
      return run(() => runRedisSafely(() => {
        isAsked = true;

        return 'never';
      }, 'Redis read failed'));
    }

    const results = [await ask(), await ask()];

    await sleep(FAST_FAILURE_MS);

    assert.deepEqual(results, [REDIS_FAILURE, REDIS_FAILURE]);
    assert.equal(isAsked, false);
    assert.equal(redis.client.status, 'wait');
    assert.equal(redis.isStarted(), false);
    assert.equal(redis.isReady(), false);
    assert.equal(server.countAccepted(), 0);
    assert.deepEqual(sink.lines.map((line) => [line.level, line.msg]), [
      [LEVEL.ERROR, `${LABEL} was never told to connect: nothing reaches it, call connect() in the entrypoint`],
    ]);
  });
});

describe('createRedis: a Redis that is down', () => {
  test('connect() starts the client once and the server is never asked while it is down', async (t) => {
    const { redis, run } = openRedis(t, { redis: FAST_RECONNECT });

    assert.equal(redis.connect(), true);
    assert.equal(redis.connect(), false);
    assert.equal(redis.isStarted(), true);

    await waitFor(() => redis.client.status === 'reconnecting', 'the client to retry');

    const { result, durationMs } = await timeIt(() => run(() => runRedisSafely((client) => client.get('key'), 'Redis read failed')));

    assert.equal(result, REDIS_FAILURE);
    assert.ok(durationMs < FAST_FAILURE_MS, `${durationMs} ms`);
    assert.equal(redis.isReady(), false);
  });

  test('logs one warning for the outage, not one for every reconnect', async (t) => {
    const { redis, sink } = openRedis(t, { redis: FAST_RECONNECT });

    redis.connect();
    await waitFor(() => findLines(sink, `${LABEL} is still not reachable`).length >= 6, 'several reconnects');

    const warnings = sink.lines.filter((line) => line.level >= LEVEL.WARN);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].msg, `${LABEL} is not reachable`);
    assert.equal(warnings[0].level, LEVEL.WARN);
    assert.equal(warnings[0].redis.address, redis.address);
    assert.equal(warnings[0].err.code, 'ECONNREFUSED');
    assert.ok(findLines(sink, `${LABEL} is still not reachable`).every((line) => line.level === LEVEL.DEBUG));
  });

  test('a server that takes the connection and never answers: commands fail at once, the handshake ends at commandTimeout and the client tries again', async (t) => {
    const server = await createSilentServer(t);
    const { redis, run } = openRedis(t, {
      env: toEnv(server.port),
      redis: { ...FAST_RECONNECT, commandTimeout: '0.2s', socketTimeout: '0.2s' },
    });

    redis.connect();
    await waitFor(() => redis.client.status === 'connect', 'the TCP connection');

    const { result, durationMs } = await timeIt(() => run(() => runRedisSafely((client) => client.get('key'), 'Redis read failed')));

    assert.equal(result, REDIS_FAILURE);
    assert.ok(durationMs < FAST_FAILURE_MS, `${durationMs} ms`);
    await waitFor(() => server.countAccepted() >= 2, 'a second connection after the handshake timed out');
    assert.equal(redis.isReady(), false);
  });

  test('whenReady() resolves false at its deadline, through failed attempts, and never rejects', async (t) => {
    const { redis } = openRedis(t, { redis: FAST_RECONNECT });

    redis.connect();

    const { result, durationMs } = await timeIt(() => redis.whenReady({ timeout: '0.3s' }));

    assert.equal(result, false);
    assert.ok(durationMs >= 290, `${durationMs} ms`);
  });

  test('publish() to a Redis that is not ready asks nothing and returns REDIS_FAILURE; without a Redis as well', async (t) => {
    const { redis, run } = openRedis(t);

    assert.equal(await run(() => publish('events', 'hello')), REDIS_FAILURE);
    assert.equal(await publish('events', 'hello', { redis: null }), REDIS_FAILURE);
    assert.equal(redis.client.status, 'wait');
  });
});

describe('runRedisSafely', () => {
  test('requires an action, a message and a client of createRedis() or null', async (t) => {
    const { redis, run } = openRedis(t);

    await assert.rejects(run(() => runRedisSafely('get', 'message')), /requires an action and a message/);
    await assert.rejects(run(() => runRedisSafely(() => 1, '')), /requires an action and a message/);
    await assert.rejects(run(() => runRedisSafely(() => 1, 'message', { redis: {} })), /requires a client of createRedis\(\) or null/);
    await assert.rejects(run(() => runRedisSafely(() => 1, 'message', { redis: redis.client })), /requires a client of createRedis\(\) or null/);
  });

  test('without a Redis in the context or given, asks nothing and returns REDIS_FAILURE, also outside any context', async () => {
    let isAsked = false;

    function action() {
      isAsked = true;

      return 1;
    }

    assert.equal(await runRedisSafely(action, 'message'), REDIS_FAILURE);
    assert.equal(await runRedisSafely(action, 'message', { redis: null }), REDIS_FAILURE);
    assert.equal(isAsked, false);
  });

  test('runs the command of a ready client, the one of the context by default', async (t) => {
    const { redis, run } = await openFake(t, answer('GET', toRespBulk('value')));

    assert.equal(await run(() => runRedisSafely((client) => client.get('key'), 'Redis read failed')), 'value');
    assert.equal(await runRedisSafely((client) => client.get('key'), 'Redis read failed', { redis }), 'value');
  });

  test('logs a failure outside any context with the logger of the client, and never throws', async (t) => {
    const { redis, sink } = await openFake(t, answer('GET', toRespError('MISCONF Redis is configured to save RDB snapshots')));

    const result = await runRedisSafely((client) => client.get('key'), 'Redis read failed', { redis });
    const [failed] = findLines(sink, 'Redis read failed');

    assert.equal(result, REDIS_FAILURE);
    assert.equal(failed.level, LEVEL.ERROR);
    assert.match(failed.err.message, /^MISCONF/);
    assert.deepEqual(failed.err.command, { name: 'get' });
    assert.equal(failed.requestId, undefined);
  });

  test('logs a failure inside a request with the logger of the request', async (t) => {
    const { run, sink } = await openFake(t, answer('GET', toRespError('READONLY You can\'t write against a read only replica.')));

    await run(() => runRedisSafely((client) => client.get('key'), 'Redis read failed'));

    assert.equal(findLines(sink, 'Redis read failed')[0].requestId, REQUEST_ID);
  });

  test('logs one line for each kind of failure in a window and counts the rest into the next one', async (t) => {
    const { redis, sink } = await openFake(t, (args) => (args[0] === 'set'
      ? toRespError('OOM command not allowed when used memory > maxmemory')
      : null), { failureLogWindow: '0.3s' });

    function write() {
      return runRedisSafely((client) => client.set('key', 'value'), 'Redis write failed', { redis });
    }

    await Promise.all(Array.from({ length: 5 }, () => write()));
    await runRedisSafely((client) => client.incrby('key', 'x'), 'Redis write failed', { redis });
    await sleep(350);
    await write();

    const lines = findLines(sink, 'Redis write failed');

    assert.deepEqual(lines.map((line) => line.redis.suppressedCount), [0, 0, 4]);
    assert.match(lines[0].err.message, /^OOM/);
    assert.match(lines[1].err.message, /^ERR/);
  });

  test('does not let a pipeline hide an error in its result', async (t) => {
    const { redis, sink } = await openFake(t, answer('INCR', toRespError('ERR value is not an integer or out of range')));
    const result = await runRedisSafely((client) => client.pipeline().ping().incr('word'), 'Redis pipeline failed', { redis });
    const [failed] = findLines(sink, 'Redis pipeline failed');

    assert.equal(result, REDIS_FAILURE);
    assert.match(failed.err.message, /not an integer/);
  });

  test('keeps the arguments of a failed command out of the log: the value of a SET, of a command in a pipeline', async (t) => {
    const secret = 'user-secret@example.com';
    const { redis, sink } = await openFake(t, answer('SET', toRespError('ERR invalid expire time in set')));

    await runRedisSafely((client) => client.set('profile', secret, 'PX', -1), 'Redis write failed', { redis });
    await runRedisSafely((client) => client.pipeline().set('profile', secret), 'Redis pipeline failed', { redis });

    assert.equal(findLines(sink, 'Redis write failed').length, 1);
    assert.equal(findLines(sink, 'Redis pipeline failed').length, 1);
    assert.equal(JSON.stringify(sink.lines).includes(secret), false);
  });

  test('keeps the arguments of the commands a refused MULTI carries out of the log as well', async (t) => {
    const secret = 'session-secret-0123456789';
    const { redis, sink } = await openFake(t, (args) => ({
      multi: RESP_OK,
      set: toRespError('OOM command not allowed when used memory > maxmemory'),
      get: '+QUEUED\r\n',
      exec: toRespError('EXECABORT Transaction discarded because of previous errors.'),
    })[args[0]] ?? null);

    const result = await runRedisSafely((client) => client.multi().set('session', secret).get('session'), 'Redis transaction failed', { redis });
    const [failed] = findLines(sink, 'Redis transaction failed');

    assert.equal(result, REDIS_FAILURE);
    assert.match(failed.err.message, /^EXECABORT/);
    assert.deepEqual(failed.err.previousErrors.map((previous) => previous.command), [{ name: 'set' }]);
    assert.equal(JSON.stringify(sink.lines).includes(secret), false);
  });
});

describe('createRedis: credentials', () => {
  test('a refused password never reaches the log, neither in the warning nor in the lines of the reconnects', async (t) => {
    const fake = await createFakeRedis(t, answer('HELLO', toRespError(WRONGPASS)));
    const { redis, sink } = openRedis(t, {
      env: { ...toEnv(fake.port), APP_REDIS_USER: 'app', APP_REDIS_PASSWORD: MARKER_PASSWORD },
      redis: FAST_RECONNECT,
    });

    redis.connect();
    await waitFor(() => findLines(sink, `${LABEL} is still not reachable`).length >= 3, 'several refused handshakes');

    const [refused] = findLines(sink, `${LABEL} is not reachable`);

    assert.match(refused.err.message, /^WRONGPASS/);
    assert.deepEqual(refused.err.command, { name: 'hello' });
    assert.ok(fake.commands.some((args) => args.includes(MARKER_PASSWORD)));
    assert.equal(JSON.stringify(sink.lines).includes(MARKER_PASSWORD), false);
  });
});

describe('createRedis: state', () => {
  test('watchState() hears the client go down when it is told to connect and up when it is ready, with one clock', async (t) => {
    const fake = await createFakeRedis(t);
    const { redis, sink } = openRedis(t, { env: toEnv(fake.port) });
    const events = [];

    redis.watchState({ onDown: (downSince) => events.push(['down', typeof downSince]), onUp: (downMs) => events.push(['up', downMs]) });
    redis.connect();
    await waitUntilReady(redis);

    const [ready] = findLines(sink, `${LABEL} is ready`);

    assert.deepEqual(events, [['down', 'number'], ['up', ready.redis.downMs]]);
    assert.throws(() => redis.watchState({ onDown: () => {} }), /requires two functions/);
  });

  test('a listener that throws is logged and does not stop the others', async (t) => {
    const fake = await createFakeRedis(t);
    const { redis, sink } = openRedis(t, { env: toEnv(fake.port) });
    const heard = [];

    redis.watchState({ onDown: () => { throw new Error('listener failed'); }, onUp: () => {} });
    redis.watchState({ onDown: () => heard.push('down'), onUp: () => heard.push('up') });
    redis.connect();
    await waitUntilReady(redis);

    assert.deepEqual(heard, ['down', 'up']);
    assert.equal(findLines(sink, `A listener of the ${LABEL} state failed`)[0].err.message, 'listener failed');
  });

  // The command arms the socket timeout of ioredis in the context of the request, and the timeout tears the
  // connection down from there.
  test('a listener hears a connection lost by a command of a request outside the context of that request', async (t) => {
    const { redis, run } = await openFake(t, (args) => (args[0] === 'get' ? '' : null), { commandTimeout: '0.2s', socketTimeout: '0.3s' });
    const heard = [];

    redis.watchState({ onDown: () => heard.push(findContext()), onUp: () => {} });
    await run(() => runRedisSafely((client) => client.get('key'), 'Redis read failed'));

    await waitFor(() => heard.length === 1, 'the connection to be lost');

    assert.deepEqual(heard, [null]);
  });
});

describe('createRedis: subscribe', () => {
  test('requires a channel and a function, and opens no connection of its own before connect()', async (t) => {
    const server = await createSilentServer(t);
    const { redis } = openRedis(t, { env: toEnv(server.port) });

    assert.throws(() => redis.subscribe('', () => {}), /non-empty string/);
    assert.throws(() => redis.subscribe('events', 'handler'), /requires a function/);

    const unsubscribe = redis.subscribe('events', () => {});

    await sleep(FAST_FAILURE_MS);
    assert.equal(server.countAccepted(), 0);

    redis.connect();
    await waitFor(() => server.countAccepted() === 2, 'the connection for commands and the one for messages');

    assert.equal(unsubscribe(), true);
    assert.equal(unsubscribe(), false);
  });

  test('puts the key prefix in front of a channel: ioredis does not', (t) => {
    const { redis } = openRedis(t);

    assert.equal(redis.toChannel('events'), `${redis.keyPrefix}events`);
  });
});

describe('createRedis: close', () => {
  test('is idempotent, a second call waits for the first, and a closed client neither connects nor subscribes again', async (t) => {
    const { redis } = openRedis(t);

    const [first, second] = await Promise.all([redis.close(), redis.close()]);

    assert.deepEqual([first, second], [true, false]);
    assert.equal(await redis.close(), false);
    assert.equal(redis.connect(), false);
    assert.equal(redis.isReady(), false);
    assert.equal(await redis.whenReady(), false);
    assert.throws(() => redis.subscribe('events', () => {}), /is closed/);
  });

  test('in every state it can be in without a Redis, leaves nothing that holds the process', async (t) => {
    const server = await createSilentServer(t);
    const loading = await createFakeRedis(t, answer('INFO', toRespBulk('# Server\r\nloading:1\r\nloading_eta_seconds:8\r\n')));
    const runs = await Promise.all([
      runNode(CLOSE_REDIS, { args: ['wait', REDIS_DOWN_ENV.APP_REDIS_PORT, '0'] }),
      runNode(CLOSE_REDIS, { args: ['reconnecting', REDIS_DOWN_ENV.APP_REDIS_PORT, '300'] }),
      runNode(CLOSE_REDIS, { args: ['connect', String(server.port), '300'] }),
      runNode(CLOSE_REDIS, { args: ['waiting', REDIS_DOWN_ENV.APP_REDIS_PORT, '300'] }),
      runNode(CLOSE_REDIS, { args: ['loading', String(loading.port), '300'] }),
    ]);
    const results = runs.map(({ code, stdout }) => ({ code, ...JSON.parse(stdout) }));

    assert.deepEqual(results.map(({ code, state, isReadyAfterWait }) => ({ code, state, isReadyAfterWait })), [
      { code: 0, state: 'wait', isReadyAfterWait: null },
      { code: 0, state: 'reconnecting', isReadyAfterWait: null },
      { code: 0, state: 'connect', isReadyAfterWait: null },
      { code: 0, state: 'reconnecting', isReadyAfterWait: false },
      { code: 0, state: 'connect', isReadyAfterWait: null },
    ]);
    results.slice(0, 4).forEach(({ lingerMs }) => assert.ok(lingerMs < FAST_FAILURE_MS, `${lingerMs} ms`));
    assert.ok(results[4].lingerMs < 1500, `a Redis that loads its data held the process for ${results[4].lingerMs} ms`);
  });
});
