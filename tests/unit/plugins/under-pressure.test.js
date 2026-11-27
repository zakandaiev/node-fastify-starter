import {
  accept,
  createAlertReceiver,
  NO_THROTTLE,
  readBlock,
} from '#root/tests/helper/alert.js';
import {
  buildTestApp,
  describeAnswer,
  errorBody,
  successBody,
} from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import {
  createLogSink,
  findLogLines,
  LOG_LEVEL,
} from '#root/tests/helper/log.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';

const PING_URL = '/api/v1/system/ping';
const LIVE_URL = '/health/live';
const EXEMPT_URL = '/exempt';
const NOT_EXEMPT_URL = '/not-exempt';

const PRESSURE_MESSAGE = 'Server is under pressure: requests are answered 503';
const RELIEF_MESSAGE = 'Server is no longer under pressure';
const PRESSURE_TITLE = 'Server under pressure';

const UTILIZATION_TYPE = 'eventLoopUtilization';
const DELAY_TYPE = 'eventLoopDelay';

const UNAVAILABLE_RETRY_AFTER = '2m';
const UNAVAILABLE_RETRY_AFTER_SECONDS = '120';

const DEFAULT_PRESSURE = createTestConfig().app.pressure;

// The shortest sample the plugin takes: ten ticks of its delay histogram.
const SAMPLE_MS = 100;
const SETTLE_SAMPLES = 3;

// Any work of the event loop is more than this share of the window: every sample after ready finds pressure.
const EVERY_SAMPLE = Object.freeze({
  maxEventLoopDelay: '1s',
  maxEventLoopUtilization: 0.000001,
  utilizationWindow: '0.5s',
  sampleInterval: '0.1s',
});

// A loop kept busy fills the window of three samples within two, and an idle one empties it as fast.
const HALF_BUSY = Object.freeze({
  maxEventLoopDelay: '1s',
  maxEventLoopUtilization: 0.5,
  utilizationWindow: '0.3s',
  sampleInterval: '0.1s',
});

// No share of a window is above 1: only the delay can be.
const LATE_ONLY = Object.freeze({
  maxEventLoopDelay: '0.02s',
  maxEventLoopUtilization: 1,
  utilizationWindow: '1s',
  sampleInterval: '0.2s',
});
const DELAY_LIMIT_MS = 20;

// Holds this short keep the ticks of the delay histogram nearly on time: only the utilization rises.
const BUSY_HOLD_MS = 5;

// Every tick of the delay histogram comes about this late: its mean, less the 10ms of its resolution, is above the
// limit in every sample while the loop is held.
const LATE_HOLD_MS = 40;

const START_BUSY_MS = 4 * SAMPLE_MS;
const CLOSED_BUSY_MS = 5 * SAMPLE_MS;

const NOT_EXEMPT_FLAGS = Object.freeze(['true', 1]);
const NOT_EXEMPT_URLS = Object.freeze(NOT_EXEMPT_FLAGS.map((flag, index) => `${NOT_EXEMPT_URL}/${index}`));
const SERVED = Object.freeze({ isServed: true });

// A spin, not Atomics.wait(): on Windows that sleeps for a tick of the system timer, about 15ms, whatever it is given.
function holdEventLoop(ms) {
  const end = performance.now() + ms;
  let spins = 0;

  while (performance.now() < end) {
    spins += 1;
  }

  return spins;
}

// Holds of holdMs with a turn of the event loop between them, until stopped: the timers of the sampler and of its delay
// histogram still run, and every tick of the histogram comes about holdMs late.
function keepBusy(holdMs) {
  const state = { isBusy: true };

  async function holdInTurns() {
    if (!state.isBusy) {
      return true;
    }

    holdEventLoop(holdMs);
    await nextTurn();

    return holdInTurns();
  }

  const done = holdInTurns();

  function stopBusy() {
    state.isBusy = false;

    return done;
  }

  return stopBusy;
}

async function buildApp(t, pressure, { receiver } = {}) {
  const sink = createLogSink();
  const fastify = await buildTestApp({
    env: { ...REDIS_DOWN_ENV, ...receiver?.env.webhook },
    alert: { ...receiver?.config.alert, throttleWindow: NO_THROTTLE },
    logger: { level: 'info', stream: sink.stream },
    app: { pressure, unavailableRetryAfter: UNAVAILABLE_RETRY_AFTER },
  });

  t.after(() => fastify.close());

  return { fastify, sink };
}

function buildWithPressure(pressure) {
  return buildTestApp({ app: { pressure: { ...DEFAULT_PRESSURE, ...pressure } } });
}

function addRoutes(fastify) {
  fastify.get(EXEMPT_URL, { config: { isPressureExempt: true } }, async () => SERVED);
  NOT_EXEMPT_FLAGS.forEach((isPressureExempt, index) => {
    fastify.get(NOT_EXEMPT_URLS[index], { config: { isPressureExempt } }, async () => SERVED);
  });
}

function injectAll(fastify, urls) {
  return Promise.all(urls.map((url) => fastify.inject(url)));
}

function injectRoutes(fastify) {
  return injectAll(fastify, [PING_URL, LIVE_URL, EXEMPT_URL, ...NOT_EXEMPT_URLS]);
}

function waitForLines(sink, message, count) {
  return waitFor(() => {
    const lines = findLogLines(sink, message);

    return lines.length >= count && lines;
  }, `${count} line(s) "${message}"`);
}

function readPressureLines(sink) {
  return sink.lines.filter((line) => [PRESSURE_MESSAGE, RELIEF_MESSAGE].includes(line.msg));
}

function readUtilizationLines(sink) {
  return readPressureLines(sink).filter((line) => line.pressure.type === UTILIZATION_TYPE);
}

function readUtilizationAlerts(receiver) {
  return receiver.requests.filter((request) => readBlock(request.body, 'Error')?.type === UTILIZATION_TYPE);
}

// The sampler tells nothing while there is no pressure: a test that waits for it to have sampled waits for its time.
function waitForSamples(count) {
  return sleep(count * SAMPLE_MS);
}

function describeUnavailable(response) {
  return {
    statusCode: 503,
    body: errorBody(response, 'SERVICE_UNAVAILABLE_ERROR', 'Service unavailable'),
    retryAfter: UNAVAILABLE_RETRY_AFTER_SECONDS,
    challenge: undefined,
    cacheControl: 'no-store',
    cookies: undefined,
  };
}

function assertUnavailable(responses) {
  responses.forEach((response) => {
    assert.deepEqual(describeAnswer(response), describeUnavailable(response));
  });
}

function assertServed([live, exempt]) {
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), successBody(live, { isAlive: true }));
  assert.equal(exempt.statusCode, 200);
  assert.deepEqual(exempt.json(), SERVED);
}

function assertPressure(line, { level, type, limit }) {
  const description = JSON.stringify(line.pressure);

  assert.equal(line.level, level);
  assert.deepEqual(Object.keys(line.pressure), ['type', 'value', 'limit']);
  assert.equal(line.pressure.type, type, description);
  assert.equal(line.pressure.limit, limit, description);
  assert.ok(line.pressure.value > limit, description);
}

describe('under-pressure plugin: a busy event loop', () => {
  test('answers 503 SERVICE_UNAVAILABLE_ERROR with the Retry-After of config.app.unavailableRetryAfter and no-store to every route but /health/live and one of config.isPressureExempt: true', async (t) => {
    const { fastify, sink } = await buildApp(t, EVERY_SAMPLE);

    addRoutes(fastify);
    await fastify.ready();
    await waitForLines(sink, PRESSURE_MESSAGE, 1);

    const [ping, live, exempt, ...notExempt] = await injectRoutes(fastify);

    assertUnavailable([ping, ...notExempt]);
    assertServed([live, exempt]);
    assert.equal((await fastify.inject({ method: 'OPTIONS', url: PING_URL })).statusCode, 204);
  });

  test('writes one warn line and sends one alert "Server under pressure" of class warning as the pressure starts, not one for each request it refuses, and one info line once the loop has been idle for its window', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await buildApp(t, HALF_BUSY, { receiver });

    await fastify.ready();

    const stopBusy = keepBusy(BUSY_HOLD_MS);

    t.after(stopBusy);

    const [line] = await waitForLines(sink, PRESSURE_MESSAGE, 1);
    const refused = await injectAll(fastify, [PING_URL, PING_URL, PING_URL]);
    const [alert] = await waitFor(() => readUtilizationAlerts(receiver)[0] && readUtilizationAlerts(receiver), 'the alert at the receiver');

    await stopBusy();

    const [relief] = await waitForLines(sink, RELIEF_MESSAGE, 1);
    const served = await fastify.inject(PING_URL);
    const limits = { type: UTILIZATION_TYPE, limit: HALF_BUSY.maxEventLoopUtilization };

    assertUnavailable(refused);
    assert.equal(served.statusCode, 200);
    assert.deepEqual(readPressureLines(sink), [line, relief]);
    assertPressure(line, { ...limits, level: LOG_LEVEL.WARN });
    assertPressure(relief, { ...limits, level: LOG_LEVEL.INFO });
    assert.equal(readUtilizationAlerts(receiver).length, 1);
    assert.equal(alert.path, receiver.paths.webhook);
    assert.equal(alert.body.title, PRESSURE_TITLE);
    assert.equal(alert.body.space, 'internal');
    assert.equal(alert.body.throttleClass, 'warning');
    assert.deepEqual(alert.body.blocks.map((block) => block.name), ['App', 'Error']);
    assert.deepEqual(readBlock(alert.body, 'Error'), { message: PRESSURE_MESSAGE, ...line.pressure });
  });
});

describe('under-pressure plugin: a late event loop', () => {
  test('answers 503 by the delay check with the same answer and the same exemptions, and reports the delay in one warn line and its end in one info line', async (t) => {
    const { fastify, sink } = await buildApp(t, LATE_ONLY);

    addRoutes(fastify);
    await fastify.ready();

    const stopBusy = keepBusy(LATE_HOLD_MS);

    t.after(stopBusy);

    const [line] = await waitForLines(sink, PRESSURE_MESSAGE, 1);
    const [ping, live, exempt, ...notExempt] = await injectRoutes(fastify);

    await stopBusy();

    const [relief] = await waitForLines(sink, RELIEF_MESSAGE, 1);
    const served = await fastify.inject(PING_URL);
    const limits = { type: DELAY_TYPE, limit: DELAY_LIMIT_MS };

    assertUnavailable([ping, ...notExempt]);
    assertServed([live, exempt]);
    assert.equal(served.statusCode, 200);
    assert.deepEqual(readPressureLines(sink), [line, relief]);
    assertPressure(line, { ...limits, level: LOG_LEVEL.WARN });
    assertPressure(relief, { ...limits, level: LOG_LEVEL.INFO });
  });
});

describe('under-pressure plugin: its sampler', () => {
  test('samples nothing before ready: no line while a loop is kept busy before it, and that work is not in the samples after it', async (t) => {
    const { fastify, sink } = await buildApp(t, HALF_BUSY);
    const stopBusy = keepBusy(BUSY_HOLD_MS);

    t.after(stopBusy);
    await sleep(START_BUSY_MS);
    await stopBusy();

    const linesBeforeReady = readPressureLines(sink);

    await fastify.ready();
    await waitForSamples(SETTLE_SAMPLES);

    assert.deepEqual(linesBeforeReady, []);
    assert.deepEqual(readUtilizationLines(sink), []);
  });

  test('takes the work of ready() for no pressure: the schemas it compiles do not reach the delay of the first samples', async (t) => {
    const { fastify, sink } = await buildApp(t, LATE_ONLY);

    await fastify.ready();
    await waitForSamples(SETTLE_SAMPLES);

    assert.deepEqual(readPressureLines(sink), []);
  });

  test('stops on close: a loop kept busy after it is never reported', async (t) => {
    const { fastify, sink } = await buildApp(t, HALF_BUSY);

    await fastify.ready();
    await fastify.close();

    const stopBusy = keepBusy(BUSY_HOLD_MS);

    t.after(stopBusy);
    await sleep(CLOSED_BUSY_MS);
    await stopBusy();

    assert.deepEqual(readPressureLines(sink), []);
  });

  test('starts no sampler when close() comes in the same turn as ready(): onClose runs before onReady then', async (t) => {
    const { fastify, sink } = await buildApp(t, EVERY_SAMPLE);

    await Promise.allSettled([fastify.ready(), fastify.close()]);
    await waitForSamples(SETTLE_SAMPLES);

    assert.deepEqual(readPressureLines(sink), []);
  });
});

describe('under-pressure plugin: its settings', () => {
  test('starts on the default settings and on a maxEventLoopUtilization of 1, under the name "under-pressure"', async (t) => {
    const apps = await Promise.all([buildWithPressure({}), buildWithPressure({ maxEventLoopUtilization: 1 })]);

    t.after(() => Promise.all(apps.map((fastify) => fastify.close())));

    apps.forEach((fastify) => {
      assert.equal(fastify.hasPlugin('under-pressure'), true);
    });
  });

  test('refuses to start on a maxEventLoopUtilization that is not a number above 0 and at most 1', async () => {
    const values = [0, -0.1, 1.5, '0.5', Number.NaN, null];
    const results = await Promise.allSettled(values.map((maxEventLoopUtilization) => buildWithPressure({ maxEventLoopUtilization })));

    results.forEach((result) => {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.name, 'TypeError');
      assert.equal(result.reason.message, 'config.app.pressure requires maxEventLoopUtilization to be above 0 and at most 1');
    });
  });

  test('refuses to start on a duration nobody can read and on one of zero or less', async () => {
    const keys = ['maxEventLoopDelay', 'utilizationWindow', 'sampleInterval'];
    const unreadable = await Promise.allSettled(keys.map((key) => buildWithPressure({ [key]: '1 second' })));
    const notAboveZero = await Promise.allSettled(keys.flatMap((key) => ['0s', '-1s'].map((duration) => buildWithPressure({ [key]: duration }))));

    unreadable.forEach((result) => {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.name, 'TypeError');
      assert.match(result.reason.message, /^convertStringToMs\(value\) requires a number with a unit/);
    });
    notAboveZero.forEach((result) => {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.name, 'TypeError');
      assert.equal(result.reason.message, 'config.app.pressure requires maxEventLoopDelay, utilizationWindow, sampleInterval to be above zero');
    });
  });

  test('refuses to start on a sample too short to hold ticks of its delay histogram and on a window that is not a whole number of samples', async () => {
    const results = await Promise.allSettled([
      buildWithPressure({ sampleInterval: '0.05s', utilizationWindow: '1s' }),
      buildWithPressure({ sampleInterval: '1s', utilizationWindow: '0.5s' }),
      buildWithPressure({ sampleInterval: '1s', utilizationWindow: '1.4s' }),
      buildWithPressure({ sampleInterval: '3s', utilizationWindow: '10s' }),
    ]);

    results.forEach((result) => {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.name, 'TypeError');
      assert.equal(result.reason.message, `config.app.pressure requires sampleInterval of at least ${SAMPLE_MS} ms and utilizationWindow of a whole number of sampleIntervals`);
    });
  });
});
