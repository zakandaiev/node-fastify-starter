import { alert } from '#core/alert/index.js';
import { runInContext } from '#core/context/index.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import { assertDurations, convertStringToMs } from '#utils/date.js';
import { isNumberInRange } from '#utils/type.js';
import fp from 'fastify-plugin';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const PRESSURE_TITLE = 'Server under pressure';
const PRESSURE_MESSAGE = 'Server is under pressure: requests are answered 503';
const RELIEF_MESSAGE = 'Server is no longer under pressure';
const DEDUPE_PREFIX = 'under-pressure';
const KEY_SEPARATOR = ':';

const PRESSURE_TYPE = Object.freeze({
  EVENT_LOOP_DELAY: 'eventLoopDelay',
  EVENT_LOOP_UTILIZATION: 'eventLoopUtilization',
});

const DURATION_KEYS = Object.freeze(['maxEventLoopDelay', 'utilizationWindow', 'sampleInterval']);
const UTILIZATION_MIN = 0;
const UTILIZATION_MAX = 1;

// The timer of the histogram ticks this often and records the time since its tick before: this much plus the delay.
const DELAY_RESOLUTION_MS = 10;
const NS_IN_MS = 1e6;

// A sample tells its delay by the ticks it has recorded: in a shorter one a single late tick, or none, would decide it.
const SAMPLE_TICKS_MIN = 10;

function assertPressureConfig(pressure) {
  assertDurations(pressure, DURATION_KEYS, 'config.app.pressure');

  const utilization = pressure.maxEventLoopUtilization;

  if (!isNumberInRange(utilization, UTILIZATION_MIN, UTILIZATION_MAX) || utilization === UTILIZATION_MIN) {
    throw new TypeError('config.app.pressure requires maxEventLoopUtilization to be above 0 and at most 1');
  }

  const sampleMs = convertStringToMs(pressure.sampleInterval);
  const windowMs = convertStringToMs(pressure.utilizationWindow);

  // The window is so many samples: one that is not a whole number of them would read a busy loop below its limit.
  if (sampleMs < SAMPLE_TICKS_MIN * DELAY_RESOLUTION_MS || windowMs % sampleMs !== 0) {
    throw new TypeError(`config.app.pressure requires sampleInterval of at least ${SAMPLE_TICKS_MIN * DELAY_RESOLUTION_MS} ms and utilizationWindow of a whole number of sampleIntervals`);
  }

  return true;
}

function readLimits(pressure) {
  return {
    maxEventLoopDelay: convertStringToMs(pressure.maxEventLoopDelay),
    maxEventLoopUtilization: pressure.maxEventLoopUtilization,
    windowMs: convertStringToMs(pressure.utilizationWindow),
    sampleMs: convertStringToMs(pressure.sampleInterval),
  };
}

// The average delay since the last sample. A sample without a tick is a loop that was blocked all the time since the
// last one: that time is the delay.
function createDelaySampler() {
  const histogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  let sampledAt = performance.now();

  histogram.enable();

  return {
    read() {
      const now = performance.now();
      const delay = histogram.count === 0
        ? now - sampledAt
        : Math.max(0, histogram.mean / NS_IN_MS - DELAY_RESOLUTION_MS);

      histogram.reset();
      sampledAt = now;

      return delay;
    },
    stop() {
      histogram.disable();
    },
  };
}

// The utilization of the last utilizationWindow: an average since the start never rises over a limit again in a process
// that has run for a while, and the last sample alone takes one busy second for pressure. Until the window has filled,
// the time it lacks counts as idle.
function createUtilizationWindow({ windowMs, sampleMs }) {
  const size = Math.round(windowMs / sampleMs);
  const snapshots = [performance.eventLoopUtilization()];

  return function readUtilization() {
    const current = performance.eventLoopUtilization();
    const { active, idle } = performance.eventLoopUtilization(current, snapshots[0]);

    snapshots.push(current);

    if (snapshots.length > size) {
      snapshots.shift();
    }

    return active / Math.max(active + idle, windowMs);
  };
}

function readPressure({ delay, utilization }, limits) {
  if (delay > limits.maxEventLoopDelay) {
    return { type: PRESSURE_TYPE.EVENT_LOOP_DELAY, value: delay, limit: limits.maxEventLoopDelay };
  }

  return utilization > limits.maxEventLoopUtilization
    ? { type: PRESSURE_TYPE.EVENT_LOOP_UTILIZATION, value: utilization, limit: limits.maxEventLoopUtilization }
    : null;
}

// Once when it starts and once when it ends, not on every refusal: a process that cannot keep up must not pay for an
// alert on each request it turns away. A guest can cause it, so the class is "warning".
function reportChange(fastify, pressure, previous) {
  if (pressure === null) {
    fastify.log.info({ pressure: previous }, RELIEF_MESSAGE);

    return false;
  }

  fastify.log.warn({ pressure }, PRESSURE_MESSAGE);
  runInContext(fastify.context, () => alert({
    title: PRESSURE_TITLE,
    dedupeKey: [DEDUPE_PREFIX, pressure.type].join(KEY_SEPARATOR),
    error: { message: PRESSURE_MESSAGE, ...pressure },
    throttleClass: THROTTLE_CLASS.WARNING,
  }));

  return true;
}

function sample(fastify, state, limits) {
  const pressure = readPressure({ delay: state.delaySampler.read(), utilization: state.readUtilization() }, limits);

  if ((pressure === null) !== (state.pressure === null)) {
    reportChange(fastify, pressure, state.pressure);
  }

  state.pressure = pressure;
}

// From onReady to onClose: the work of the start, the schemas that ready() compiles above all, is no pressure.
function watchPressure(fastify, limits) {
  const state = {
    pressure: null,
    delaySampler: null,
    readUtilization: null,
    timer: null,
    isClosed: false,
  };

  // A close() called in the same turn as ready() runs onClose first: the sampler must not start after it. No value comes
  // back: Fastify takes whatever an onReady hook resolves with for its error.
  fastify.addHook('onReady', async () => {
    if (!state.isClosed) {
      state.delaySampler = createDelaySampler();
      state.readUtilization = createUtilizationWindow(limits);
      state.timer = setInterval(() => sample(fastify, state, limits), limits.sampleMs);
      state.timer.unref();
    }
  });

  fastify.addHook('onClose', async () => {
    state.isClosed = true;
    clearInterval(state.timer);
    state.delaySampler?.stop();
  });

  return state;
}

// A route that must answer under pressure, such as /health/live, says so in config.isPressureExempt.
function createPressureGuard(state) {
  return async function refuseUnderPressure(request) {
    if (state.pressure === null || request.routeOptions.config?.isPressureExempt === true) {
      return false;
    }

    throw new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
  };
}

async function useUnderPressure(fastify) {
  const { pressure } = fastify.config.app;

  assertPressureConfig(pressure);

  fastify.addHook('onRequest', createPressureGuard(watchPressure(fastify, readLimits(pressure))));
}

export default fp(useUnderPressure, { name: 'under-pressure' });
