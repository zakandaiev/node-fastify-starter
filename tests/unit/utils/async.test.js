import {
  pLimit,
  retry,
  singleFlight,
  sleep,
  withTimeout,
} from '#utils/async.js';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, test } from 'node:test';

const TIMER_MAX_MS = 2 ** 31 - 1;
const LONG_MS = 30_000;
const SOON_MS = 5000;
const SAMPLES = 200;
const PENDING = Symbol('pending');

// A regression in this file tends to hang, not to fail, and the runner waits for a pending test forever.
const SUITE = Object.freeze({ timeout: 30_000 });

const NOT_FUNCTIONS = [null, undefined, 'fn', 1, {}, []];
const NOT_SIGNALS = [null, 'signal', 1, {}, { aborted: false }, new AbortController()];
const NOT_DELAYS = [-1, -0.5, Number.NaN, Infinity, -Infinity, '10', 10n, true, null, [10]];

function nextTurn() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function pendingAfterTurn() {
  await nextTurn();

  return PENDING;
}

function peek(promise) {
  return Promise.race([promise, pendingAfterTurn()]);
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  return assert.fail('The promise was expected to reject');
}

function errorNaming(ErrorClass, name) {
  return (error) => error instanceof ErrorClass && error.message.startsWith(`${name}(`);
}

function activeTimers() {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

function abortListeners(signal) {
  return getEventListeners(signal, 'abort').length;
}

function mockTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  return t.mock.timers;
}

function skipWaits(t) {
  const delays = [];

  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    delays.push(delay);
    setImmediate(callback);
  });

  return delays;
}

function watchUnhandledRejections(t) {
  const onUnhandledRejection = t.mock.fn();

  process.on('unhandledRejection', onUnhandledRejection);
  t.after(() => process.off('unhandledRejection', onUnhandledRejection));

  return onUnhandledRejection;
}

function attemptsOf(fn) {
  return fn.mock.calls.map((call) => call.arguments[0]);
}

function range(length) {
  return Array.from({ length }, (unused, index) => index);
}

function fail() {
  return Promise.reject(new Error('boom'));
}

async function repeat(times, action) {
  if (times < 1) {
    return false;
  }

  await action();

  return repeat(times - 1, action);
}

async function sampleWaits(t, options) {
  const delays = skipWaits(t);

  await repeat(SAMPLES, () => assert.rejects(retry(fail, options), /boom/));

  return range(options.retries).map((position) => delays.filter((delay, index) => index % options.retries === position));
}

// 200 samples of each wait: the chance that all of them miss a fifth of a correct range is below 1e-19.
function assertBackoff(waits, ceilings) {
  assert.equal(waits.length, ceilings.length);

  ceilings.forEach((ceiling, position) => {
    const samples = waits[position];
    const lowest = Math.min(...samples);
    const highest = Math.max(...samples);
    const label = `the ${samples.length} waits before attempt ${position + 2} ranged from ${lowest} to ${highest} ms`;

    assert.equal(samples.length, SAMPLES);
    assert.ok(samples.every((delay) => Number.isInteger(delay)), label);
    assert.ok(lowest >= 0 && lowest < ceiling * 0.2, label);
    assert.ok(highest <= ceiling && highest > ceiling * 0.8, label);
  });
}

describe('sleep', SUITE, () => {
  test('resolves with undefined once the time has passed, and not a millisecond earlier', async (t) => {
    const timers = mockTimers(t);
    const pending = sleep(1000);

    timers.tick(999);
    assert.equal(await peek(pending), PENDING);

    timers.tick(1);
    assert.equal(await pending, undefined);
  });

  test('waits on the real timer and leaves none behind', async () => {
    const timers = activeTimers();
    const startedAt = performance.now();

    await sleep(30);

    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed >= 25 && elapsed < SOON_MS, `slept for ${elapsed} ms`);
    assert.equal(activeTimers(), timers);
  });

  test('accepts zero and the longest delay a timer can hold', async (t) => {
    assert.equal(await sleep(0), undefined);

    const timers = mockTimers(t);
    const pending = sleep(TIMER_MAX_MS);

    timers.tick(TIMER_MAX_MS - 1);
    assert.equal(await peek(pending), PENDING);

    timers.tick(1);
    assert.equal(await pending, undefined);
  });

  test('rejects with a RangeError for a time that is not a finite non-negative number', async () => {
    await Promise.all([...NOT_DELAYS, undefined].map((ms) => assert.rejects(sleep(ms), errorNaming(RangeError, 'sleep'))));
  });

  test('rejects with a RangeError for a time above the ceiling of a timer, which would fire after 1 ms instead', async () => {
    await assert.rejects(sleep(TIMER_MAX_MS + 1), errorNaming(RangeError, 'sleep'));
    await assert.rejects(sleep(Number.MAX_VALUE), errorNaming(RangeError, 'sleep'));
  });

  test('rejects with a TypeError for a signal that is not an AbortSignal and for options that are null', async () => {
    await Promise.all(NOT_SIGNALS.map((signal) => assert.rejects(sleep(1, { signal }), errorNaming(TypeError, 'sleep'))));
    await assert.rejects(sleep(1, null), TypeError);
  });

  test('rejects with the reason of an already aborted signal and starts no timer', async () => {
    const reason = new Error('stop');
    const timers = activeTimers();
    const pending = sleep(LONG_MS, { signal: AbortSignal.abort(reason) });

    assert.equal(activeTimers(), timers);
    assert.equal(await rejectionOf(pending), reason);
  });

  test('rejects with the reason at once when the signal aborts in the middle, and leaves no timer or listener behind', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    const timers = activeTimers();
    const startedAt = performance.now();
    const pending = sleep(LONG_MS, { signal: controller.signal });

    assert.equal(activeTimers(), timers + 1);
    controller.abort(reason);

    assert.equal(await rejectionOf(pending), reason);
    assert.ok(performance.now() - startedAt < SOON_MS);
    assert.equal(activeTimers(), timers);
    assert.equal(abortListeners(controller.signal), 0);
  });

  test('rejects with the AbortError of a signal that aborts without a reason', async () => {
    const controller = new AbortController();
    const pending = sleep(LONG_MS, { signal: controller.signal });

    controller.abort();

    const error = await rejectionOf(pending);

    assert.equal(error, controller.signal.reason);
    assert.equal(error.name, 'AbortError');
  });

  test('is cut short by a signal of AbortSignal.timeout()', async () => {
    const timers = activeTimers();
    const error = await rejectionOf(sleep(LONG_MS, { signal: AbortSignal.timeout(10) }));

    assert.equal(error.name, 'TimeoutError');
    assert.equal(activeTimers(), timers);
  });

  test('removes its listener from the signal when the time has passed', async () => {
    const controller = new AbortController();

    await sleep(1, { signal: controller.signal });

    assert.equal(abortListeners(controller.signal), 0);
  });
});

describe('withTimeout', SUITE, () => {
  test('resolves with the result of fn, returned or resolved', async () => {
    assert.equal(await withTimeout(() => 'value', LONG_MS), 'value');
    assert.equal(await withTimeout(async () => 'value', LONG_MS), 'value');
  });

  test('rejects with the error of fn, thrown synchronously or rejected', async () => {
    const error = new Error('boom');

    assert.equal(await rejectionOf(withTimeout(() => { throw error; }, LONG_MS)), error);
    assert.equal(await rejectionOf(withTimeout(async () => { throw error; }, LONG_MS)), error);
  });

  test('calls fn once with an AbortSignal that is not aborted', async (t) => {
    const fn = t.mock.fn();

    await withTimeout(fn, LONG_MS);

    assert.equal(fn.mock.callCount(), 1);
    assert.equal(fn.mock.calls[0].arguments.length, 1);
    assert.ok(fn.mock.calls[0].arguments[0] instanceof AbortSignal);
    assert.equal(fn.mock.calls[0].arguments[0].aborted, false);
  });

  test('rejects with a TimeoutError that tells the time when it is up, even if fn ignores the signal and never settles', async (t) => {
    const timers = mockTimers(t);
    const pending = withTimeout(() => new Promise(() => {}), 1000);

    timers.tick(999);
    assert.equal(await peek(pending), PENDING);

    timers.tick(1);

    const error = await rejectionOf(pending);

    assert.ok(error instanceof DOMException);
    assert.equal(error.name, 'TimeoutError');
    assert.match(error.message, /1000 ms/);
  });

  test('aborts the signal of fn with the very error it rejects with when the time is up', async (t) => {
    const timers = mockTimers(t);
    const fn = t.mock.fn((signal) => sleep(LONG_MS, { signal }));
    const pending = withTimeout(fn, 1000);

    timers.tick(1000);

    const error = await rejectionOf(pending);
    const [signal] = fn.mock.calls[0].arguments;

    assert.equal(error.name, 'TimeoutError');
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, error);
  });

  test('times out on the real timer and leaves none behind', async () => {
    const timers = activeTimers();
    const startedAt = performance.now();
    const error = await rejectionOf(withTimeout(() => new Promise(() => {}), 30));
    const elapsed = performance.now() - startedAt;

    assert.equal(error.name, 'TimeoutError');
    assert.ok(elapsed >= 25 && elapsed < SOON_MS, `timed out after ${elapsed} ms`);
    assert.equal(activeTimers(), timers);
  });

  test('keeps the caller in the stack of the TimeoutError', async (t) => {
    const timers = mockTimers(t);

    async function slowCaller() {
      return withTimeout(() => new Promise(() => {}), 1000);
    }

    const pending = slowCaller();

    timers.tick(1000);

    assert.match((await rejectionOf(pending)).stack, /slowCaller/);
  });

  test('leaves no timer behind when fn settles first, with a value or with an error', async () => {
    const timers = activeTimers();

    await withTimeout(() => 'value', LONG_MS);
    await assert.rejects(withTimeout(fail, LONG_MS), /boom/);

    assert.equal(activeTimers(), timers);
  });

  test('does not abort the signal of fn once fn has settled: a result may still stream through it', async (t) => {
    const timers = mockTimers(t);
    const signal = await withTimeout((inner) => inner, 1000);

    timers.tick(LONG_MS);

    assert.equal(signal.aborted, false);
  });

  test('does not let a rejection of fn that comes after the timeout go unhandled', async (t) => {
    const onUnhandledRejection = watchUnhandledRejections(t);
    const timers = mockTimers(t);
    const late = Promise.withResolvers();
    const pending = withTimeout(() => late.promise, 1000);

    timers.tick(1000);
    await assert.rejects(pending, { name: 'TimeoutError' });

    late.reject(new Error('late'));
    await nextTurn();

    assert.equal(onUnhandledRejection.mock.callCount(), 0);
  });

  test('does not let the abort go unhandled when fn aborts the outer signal and then throws', async (t) => {
    const onUnhandledRejection = watchUnhandledRejections(t);
    const controller = new AbortController();
    const error = new Error('boom');
    const pending = withTimeout(() => {
      controller.abort();

      throw error;
    }, LONG_MS, { signal: controller.signal });

    assert.equal(await rejectionOf(pending), error);
    await nextTurn();

    assert.equal(onUnhandledRejection.mock.callCount(), 0);
  });

  test('rejects with the reason of an already aborted outer signal, without a call of fn or a timer', async (t) => {
    const fn = t.mock.fn();
    const reason = new Error('stop');
    const timers = activeTimers();
    const pending = withTimeout(fn, LONG_MS, { signal: AbortSignal.abort(reason) });

    assert.equal(activeTimers(), timers);
    assert.equal(await rejectionOf(pending), reason);
    assert.equal(fn.mock.callCount(), 0);
  });

  test('rejects with the reason of the outer signal at once when it aborts in the middle, and passes the reason to fn', async (t) => {
    const controller = new AbortController();
    const reason = new Error('stop');
    const fn = t.mock.fn(() => new Promise(() => {}));
    const timers = activeTimers();
    const startedAt = performance.now();
    const pending = withTimeout(fn, LONG_MS, { signal: controller.signal });

    controller.abort(reason);

    assert.equal(await rejectionOf(pending), reason);
    assert.ok(performance.now() - startedAt < SOON_MS);
    assert.equal(fn.mock.calls[0].arguments[0].reason, reason);
    assert.equal(activeTimers(), timers);
    assert.equal(abortListeners(controller.signal), 0);
  });

  test('lets go of the outer signal once fn has settled', async () => {
    const controller = new AbortController();
    const signal = await withTimeout((inner) => inner, LONG_MS, { signal: controller.signal });

    assert.equal(abortListeners(controller.signal), 0);

    controller.abort();

    assert.equal(signal.aborted, false);
  });

  test('rejects with a TypeError for what is not a function, without a timer', async () => {
    const timers = activeTimers();

    await Promise.all(NOT_FUNCTIONS.map((fn) => assert.rejects(withTimeout(fn, LONG_MS), errorNaming(TypeError, 'withTimeout'))));

    assert.equal(activeTimers(), timers);
  });

  test('rejects with a RangeError for a time that is not a finite positive number, without a call of fn', async (t) => {
    const fn = t.mock.fn();

    await Promise.all([...NOT_DELAYS, undefined, 0, -0].map((ms) => assert.rejects(withTimeout(fn, ms), errorNaming(RangeError, 'withTimeout'))));

    assert.equal(fn.mock.callCount(), 0);
  });

  test('rejects with a RangeError for a time above the ceiling of a timer, which would fire after 1 ms instead', async (t) => {
    mockTimers(t);

    await assert.rejects(withTimeout(() => 'value', TIMER_MAX_MS + 1), errorNaming(RangeError, 'withTimeout'));
    assert.equal(await withTimeout(() => 'value', TIMER_MAX_MS), 'value');
  });

  test('rejects with a TypeError for an outer signal that is not an AbortSignal and for options that are null, without a call of fn', async (t) => {
    const fn = t.mock.fn();

    await Promise.all(NOT_SIGNALS.map((signal) => assert.rejects(withTimeout(fn, 1000, { signal }), errorNaming(TypeError, 'withTimeout'))));
    await assert.rejects(withTimeout(fn, 1000, null), TypeError);

    assert.equal(fn.mock.callCount(), 0);
  });
});

describe('retry', SUITE, () => {
  test('resolves with the result of the first attempt when it succeeds, without a wait', async (t) => {
    const delays = skipWaits(t);
    const fn = t.mock.fn(async () => 'value');

    assert.equal(await retry(fn), 'value');
    assert.deepEqual(fn.mock.calls.map((call) => call.arguments), [[1]]);
    assert.deepEqual(delays, []);
  });

  test('calls fn again after a failure, with the attempt number starting at 1, until it succeeds', async (t) => {
    skipWaits(t);

    const fn = t.mock.fn(async (attempt) => {
      if (attempt < 3) {
        throw new Error(`attempt ${attempt} failed`);
      }

      return `attempt ${attempt} succeeded`;
    });

    assert.equal(await retry(fn), 'attempt 3 succeeded');
    assert.deepEqual(attemptsOf(fn), [1, 2, 3]);
  });

  test('retries a synchronous throw like a rejection and accepts a plain return value', async (t) => {
    skipWaits(t);

    const fn = t.mock.fn((attempt) => {
      if (attempt === 1) {
        throw new Error('thrown');
      }

      return attempt === 2
        ? Promise.reject(new Error('rejected'))
        : 'value';
    });

    assert.equal(await retry(fn), 'value');
    assert.deepEqual(attemptsOf(fn), [1, 2, 3]);
  });

  test('gives up after "retries" more attempts and rejects with the last error', async (t) => {
    skipWaits(t);

    const errors = [new Error('first'), new Error('second'), new Error('third')];
    const fn = t.mock.fn(async (attempt) => {
      throw errors[attempt - 1];
    });

    assert.equal(await rejectionOf(retry(fn, { retries: 2 })), errors[2]);
    assert.deepEqual(attemptsOf(fn), [1, 2, 3]);
  });

  test('makes 3 more attempts by default and none with retries 0', async (t) => {
    const delays = skipWaits(t);
    const fn = t.mock.fn(fail);

    await assert.rejects(retry(fn), /boom/);
    assert.equal(fn.mock.callCount(), 4);

    await assert.rejects(retry(fn, { retries: 0 }), /boom/);
    assert.equal(fn.mock.callCount(), 5);
    assert.equal(delays.length, 3);
  });

  test('waits a random whole number of milliseconds between 0 and min(maxDelayMs, minDelayMs * factor ** (n - 1)) before attempt n + 1', async (t) => {
    const waits = await sampleWaits(t, {
      retries: 6,
      minDelayMs: 100,
      maxDelayMs: 4000,
      factor: 3,
    });

    assertBackoff(waits, [100, 300, 900, 2700, 4000, 4000]);
  });

  test('backs off from 100 ms by a factor of 2 up to 5000 ms by default', async (t) => {
    const waits = await sampleWaits(t, { retries: 8 });

    assertBackoff(waits, [100, 200, 400, 800, 1600, 3200, 5000, 5000]);
  });

  test('takes both ends of the range, 0 and the ceiling', async (t) => {
    const [waits] = await sampleWaits(t, { retries: 1, minDelayMs: 1 });

    assert.deepEqual([...new Set(waits)].sort(), [0, 1]);
  });

  test('caps the wait by maxDelayMs even when it is below minDelayMs, and keeps it constant with factor 1', async (t) => {
    const delays = skipWaits(t);

    await assert.rejects(retry(fail, { retries: 20, minDelayMs: 1000, maxDelayMs: 3 }), /boom/);
    await assert.rejects(retry(fail, { retries: 20, minDelayMs: 2.5, factor: 1 }), /boom/);

    assert.equal(delays.length, 40);
    delays.slice(0, 20).forEach((delay) => assert.ok(Number.isInteger(delay) && delay >= 0 && delay <= 3, `the wait was ${delay} ms`));
    delays.slice(20).forEach((delay) => assert.ok(Number.isInteger(delay) && delay >= 0 && delay <= 2, `the wait was ${delay} ms`));
  });

  test('keeps a zero wait at an attempt whose backoff power overflows', async (t) => {
    const delays = skipWaits(t);

    await assert.rejects(retry(fail, { retries: 4, minDelayMs: 0, factor: Number.MAX_VALUE }), /boom/);

    assert.deepEqual(delays, [0, 0, 0, 0]);
  });

  test('survives thousands of attempts', async (t) => {
    skipWaits(t);

    const error = new Error('boom');
    let calls = 0;

    function failAgain() {
      calls += 1;

      throw error;
    }

    assert.equal(await rejectionOf(retry(failAgain, { retries: 2000, minDelayMs: 0 })), error);
    assert.equal(calls, 2001);
  });

  test('waits on the real timer between the attempts and leaves none behind', async (t) => {
    const timers = activeTimers();
    const fn = t.mock.fn(async (attempt) => {
      if (attempt < 3) {
        throw new Error('boom');
      }

      return 'value';
    });

    assert.equal(await retry(fn, { minDelayMs: 2, maxDelayMs: 2 }), 'value');
    assert.deepEqual(attemptsOf(fn), [1, 2, 3]);
    assert.equal(activeTimers(), timers);
  });

  test('stops at once with the error when shouldRetry returns false, and passes it the error and the attempt', async (t) => {
    const delays = skipWaits(t);
    const error = new Error('fatal');
    const fn = t.mock.fn(async () => {
      throw error;
    });
    const shouldRetry = t.mock.fn(() => false);

    assert.equal(await rejectionOf(retry(fn, { shouldRetry })), error);
    assert.equal(fn.mock.callCount(), 1);
    assert.deepEqual(shouldRetry.mock.calls.map((call) => call.arguments), [[error, 1]]);
    assert.deepEqual(delays, []);
  });

  test('retries only the errors shouldRetry accepts', async (t) => {
    skipWaits(t);

    const errors = [new Error('busy'), new Error('busy'), new Error('fatal')];
    const fn = t.mock.fn(async (attempt) => {
      throw errors[attempt - 1];
    });
    const shouldRetry = t.mock.fn((error) => error.message === 'busy');

    assert.equal(await rejectionOf(retry(fn, { retries: 5, shouldRetry })), errors[2]);
    assert.deepEqual(attemptsOf(fn), [1, 2, 3]);
    assert.deepEqual(shouldRetry.mock.calls.map((call) => call.arguments), [[errors[0], 1], [errors[1], 2], [errors[2], 3]]);
  });

  test('does not ask shouldRetry about the last attempt', async (t) => {
    skipWaits(t);

    const shouldRetry = t.mock.fn(() => true);

    await assert.rejects(retry(fail, { retries: 2, shouldRetry }), /boom/);
    assert.deepEqual(shouldRetry.mock.calls.map((call) => call.arguments[1]), [1, 2]);

    await assert.rejects(retry(fail, { retries: 0, shouldRetry }), /boom/);
    assert.equal(shouldRetry.mock.callCount(), 2);
  });

  test('awaits an asynchronous shouldRetry and treats any falsy answer as a refusal', async (t) => {
    skipWaits(t);

    const fn = t.mock.fn(fail);

    await assert.rejects(retry(fn, { shouldRetry: async () => false }), /boom/);
    await assert.rejects(retry(fn, { shouldRetry: () => undefined }), /boom/);
    assert.equal(fn.mock.callCount(), 2);

    await assert.rejects(retry(fn, { retries: 2, shouldRetry: async () => true }), /boom/);
    assert.equal(fn.mock.callCount(), 5);
  });

  test('rejects with the error of shouldRetry when it throws', async (t) => {
    skipWaits(t);

    const error = new Error('broken predicate');
    const fn = t.mock.fn(fail);

    assert.equal(await rejectionOf(retry(fn, { shouldRetry: () => { throw error; } })), error);
    assert.equal(fn.mock.callCount(), 1);
  });

  test('rejects with the reason of an already aborted signal without a call of fn', async (t) => {
    const fn = t.mock.fn();
    const reason = new Error('stop');

    assert.equal(await rejectionOf(retry(fn, { signal: AbortSignal.abort(reason) })), reason);
    assert.equal(fn.mock.callCount(), 0);
  });

  test('stops waiting and rejects with the reason when the signal aborts, and leaves no listener behind', async (t) => {
    mockTimers(t);

    const controller = new AbortController();
    const reason = new Error('stop');
    const fn = t.mock.fn(fail);
    const pending = retry(fn, { signal: controller.signal });

    await nextTurn();
    assert.equal(abortListeners(controller.signal), 1);

    controller.abort(reason);

    assert.equal(await rejectionOf(pending), reason);
    assert.equal(fn.mock.callCount(), 1);
    assert.equal(abortListeners(controller.signal), 0);
  });

  test('leaves no timer behind when the signal aborts a wait on the real timer', async () => {
    const controller = new AbortController();
    const timers = activeTimers();
    const pending = retry(fail, { minDelayMs: LONG_MS, maxDelayMs: LONG_MS, signal: controller.signal });

    await nextTurn();
    controller.abort();

    assert.equal(await rejectionOf(pending), controller.signal.reason);
    assert.equal(activeTimers(), timers);
  });

  test('makes no further attempt when the signal aborts while fn runs, but keeps the result of an attempt that succeeds', async (t) => {
    const controller = new AbortController();
    const reason = new Error('stop');
    const fn = t.mock.fn(async () => {
      controller.abort(reason);

      throw new Error('boom');
    });

    assert.equal(await rejectionOf(retry(fn, { signal: controller.signal })), reason);
    assert.equal(fn.mock.callCount(), 1);

    const lucky = new AbortController();

    assert.equal(await retry(async () => {
      lucky.abort();

      return 'value';
    }, { signal: lucky.signal }), 'value');
  });

  test('rejects with a TypeError for what is not a function, without a wait', async (t) => {
    const delays = skipWaits(t);

    await Promise.all(NOT_FUNCTIONS.map((fn) => assert.rejects(retry(fn), errorNaming(TypeError, 'retry'))));

    assert.deepEqual(delays, []);
  });

  test('rejects with a RangeError for retries that are not a non-negative integer', async (t) => {
    const fn = t.mock.fn();

    await Promise.all([-1, 1.5, Number.NaN, Infinity, '3', 3n, null].map((retries) => assert.rejects(retry(fn, { retries }), errorNaming(RangeError, 'retry'))));

    assert.equal(fn.mock.callCount(), 0);
  });

  test('rejects with a RangeError for a delay that is not a finite non-negative number or is above the ceiling of a timer', async (t) => {
    const fn = t.mock.fn();
    const invalid = [...NOT_DELAYS, TIMER_MAX_MS + 1];

    await Promise.all(invalid.map((minDelayMs) => assert.rejects(retry(fn, { minDelayMs }), errorNaming(RangeError, 'retry'))));
    await Promise.all(invalid.map((maxDelayMs) => assert.rejects(retry(fn, { maxDelayMs }), errorNaming(RangeError, 'retry'))));

    assert.equal(fn.mock.callCount(), 0);
  });

  test('rejects with a RangeError for a factor that is not a finite number of at least 1', async (t) => {
    const fn = t.mock.fn();

    await Promise.all([0, 0.99, -2, Number.NaN, Infinity, '2', 2n, null].map((factor) => assert.rejects(retry(fn, { factor }), errorNaming(RangeError, 'retry'))));

    assert.equal(fn.mock.callCount(), 0);
  });

  test('rejects with a TypeError for a shouldRetry that is not a function, a signal that is not an AbortSignal and options that are null', async (t) => {
    const fn = t.mock.fn();

    await Promise.all([null, 'yes', true, {}].map((shouldRetry) => assert.rejects(retry(fn, { shouldRetry }), errorNaming(TypeError, 'retry'))));
    await Promise.all(NOT_SIGNALS.map((signal) => assert.rejects(retry(fn, { signal }), errorNaming(TypeError, 'retry'))));
    await assert.rejects(retry(fn, null), TypeError);

    assert.equal(fn.mock.callCount(), 0);
  });

  test('takes the default of an option that is undefined', async (t) => {
    const delays = skipWaits(t);
    const fn = t.mock.fn(fail);

    await assert.rejects(retry(fn, {
      retries: undefined,
      minDelayMs: undefined,
      maxDelayMs: undefined,
      factor: undefined,
      signal: undefined,
      shouldRetry: undefined,
    }), /boom/);

    assert.equal(fn.mock.callCount(), 4);
    assert.ok(delays.every((delay, index) => delay <= 100 * 2 ** index), `the waits were ${delays} ms`);
  });
});

describe('pLimit', SUITE, () => {
  test('calls fn without arguments and resolves with its result, returned or resolved', async (t) => {
    const limit = pLimit(2);
    const fn = t.mock.fn(() => 'value');

    assert.equal(await limit(fn), 'value');
    assert.equal(await limit(async () => 'value'), 'value');
    assert.deepEqual(fn.mock.calls.map((call) => call.arguments), [[]]);
  });

  test('never runs more functions at the same time than the limit allows, and uses the whole limit', async () => {
    const limit = pLimit(3);
    let running = 0;
    let peak = 0;

    async function work(index) {
      running += 1;
      peak = Math.max(peak, running);
      await (index % 3 ? nextTurn() : null);
      running -= 1;

      return index;
    }

    const results = await Promise.all(range(30).map((index) => limit(() => work(index))));

    assert.equal(peak, 3);
    assert.deepEqual(results, range(30));
  });

  test('runs the functions one by one with a limit of 1', async () => {
    const limit = pLimit(1);
    const events = [];

    async function work(index) {
      events.push(`start ${index}`);
      await nextTurn();
      events.push(`end ${index}`);
    }

    await Promise.all(range(3).map((index) => limit(() => work(index))));

    assert.deepEqual(events, ['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
  });

  test('starts the waiting functions in the order they were queued, whatever the order the running ones finish in', async () => {
    const limit = pLimit(2);
    const started = [];
    const gates = range(6).map(() => Promise.withResolvers());
    const tasks = gates.map((gate, index) => limit(() => {
      started.push(index);

      return gate.promise;
    }));

    await nextTurn();
    assert.deepEqual(started, [0, 1]);

    gates[1].resolve();
    await tasks[1];
    await nextTurn();
    assert.deepEqual(started, [0, 1, 2]);

    gates[2].resolve();
    gates[0].resolve();
    await Promise.all([tasks[0], tasks[2]]);
    await nextTurn();
    assert.deepEqual(started, [0, 1, 2, 3, 4]);

    gates.forEach((gate) => gate.resolve());
    await Promise.all(tasks);
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  });

  test('hands a freed slot to the first waiting function, not to a call made in the same tick', async () => {
    const limit = pLimit(1);
    const gate = Promise.withResolvers();
    const started = [];
    let running = 0;
    let peak = 0;

    async function work(name) {
      started.push(name);
      running += 1;
      peak = Math.max(peak, running);
      await nextTurn();
      running -= 1;
    }

    async function callWhenSlotIsFreed() {
      await gate.promise;

      return limit(() => work('newcomer'));
    }

    const holder = limit(() => gate.promise);
    const waiting = limit(() => work('waiting'));

    await nextTurn();

    const newcomer = callWhenSlotIsFreed();

    gate.resolve();
    await Promise.all([holder, waiting, newcomer]);

    assert.deepEqual(started, ['waiting', 'newcomer']);
    assert.equal(peak, 1);
  });

  test('starts a waiting function before a later call that finds another slot free', async () => {
    const limit = pLimit(2);
    const gate = Promise.withResolvers();
    const started = [];

    async function callWhenSlotsAreFreed() {
      await gate.promise;

      return limit(() => started.push('newcomer'));
    }

    const holders = [limit(() => gate.promise), limit(() => gate.promise)];
    const waiting = limit(() => started.push('waiting'));

    await nextTurn();

    const newcomer = callWhenSlotsAreFreed();

    gate.resolve();
    await Promise.all([...holders, waiting, newcomer]);

    assert.deepEqual(started, ['waiting', 'newcomer']);
  });

  test('counts the running and the waiting functions in read-only activeCount and pendingCount', async () => {
    const limit = pLimit(2);
    const gate = Promise.withResolvers();

    assert.deepEqual([limit.activeCount, limit.pendingCount], [0, 0]);

    const tasks = range(5).map(() => limit(() => gate.promise));

    assert.deepEqual([limit.activeCount, limit.pendingCount], [2, 3]);
    assert.throws(() => {
      limit.activeCount = 0;
    }, TypeError);
    assert.throws(() => {
      limit.pendingCount = 0;
    }, TypeError);

    gate.resolve();
    await Promise.all(tasks);

    assert.deepEqual([limit.activeCount, limit.pendingCount], [0, 0]);
  });

  test('frees the slot after a rejection and after a synchronous throw, and fails only the call that caused it', async () => {
    const limit = pLimit(1);
    const error = new Error('boom');
    const outcomes = await Promise.allSettled([
      limit(async () => {
        throw error;
      }),
      limit(() => {
        throw error;
      }),
      limit(() => 'value'),
    ]);

    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected', 'fulfilled']);
    assert.equal(outcomes[0].reason, error);
    assert.equal(outcomes[1].reason, error);
    assert.equal(outcomes[2].value, 'value');
    assert.deepEqual([limit.activeCount, limit.pendingCount], [0, 0]);
  });

  test('keeps the slots of two limiters apart', async () => {
    const first = pLimit(1);
    const second = pLimit(1);
    const gate = Promise.withResolvers();
    const held = first(() => gate.promise);

    assert.equal(await second(() => 'value'), 'value');
    assert.deepEqual([first.activeCount, second.activeCount], [1, 0]);

    gate.resolve();
    await held;
  });

  test('drains a long queue in linear time', async () => {
    const limit = pLimit(1);
    const startedAt = performance.now();
    const results = await Promise.all(range(100_000).map((index) => limit(() => index)));

    assert.equal(results.length, 100_000);
    assert.equal(results.at(-1), 99_999);
    assert.ok(performance.now() - startedAt < SOON_MS);
  });

  test('throws a RangeError for a limit that is not a positive integer', () => {
    [0, -1, 1.5, Number.NaN, Infinity, '2', 2n, null, undefined].forEach((concurrency) => {
      assert.throws(() => pLimit(concurrency), errorNaming(RangeError, 'pLimit'));
    });
  });

  test('rejects with a TypeError for what is not a function and takes no slot for it', async () => {
    const limit = pLimit(1);

    await Promise.all(NOT_FUNCTIONS.map((fn) => assert.rejects(limit(fn), errorNaming(TypeError, 'limit'))));

    assert.deepEqual([limit.activeCount, limit.pendingCount], [0, 0]);
    assert.equal(await limit(() => 'value'), 'value');
  });
});

describe('singleFlight', SUITE, () => {
  test('calls fn once for 50 parallel calls of one key and resolves them all with its result', async (t) => {
    const run = singleFlight();
    const rows = [{ id: 1 }];
    const load = t.mock.fn(async () => {
      await nextTurn();

      return rows;
    });
    const results = await Promise.all(range(50).map(() => run('users', load)));

    assert.equal(load.mock.callCount(), 1);
    assert.equal(load.mock.calls[0].arguments.length, 0);
    assert.equal(results.length, 50);
    results.forEach((result) => assert.equal(result, rows));
  });

  test('gives every call of a key in flight the same promise, also a call that comes later', async (t) => {
    const run = singleFlight();
    const gate = Promise.withResolvers();
    const joined = t.mock.fn();
    const first = run('users', () => gate.promise);
    const second = run('users', joined);

    await nextTurn();

    const third = run('users', joined);

    assert.equal(second, first);
    assert.equal(third, first);

    gate.resolve('rows');

    assert.equal(await third, 'rows');
    assert.equal(joined.mock.callCount(), 0);
  });

  test('releases the key after success, so the next call runs fn anew', async () => {
    const run = singleFlight();

    assert.equal(await run('users', async () => 'first'), 'first');
    assert.equal(await run('users', async () => 'second'), 'second');
  });

  test('releases the key after a failure: every caller gets the error and the next call runs fn anew', async (t) => {
    const run = singleFlight();
    const error = new Error('boom');
    const load = t.mock.fn(async () => {
      await nextTurn();

      throw error;
    });
    const outcomes = await Promise.allSettled(range(50).map(() => run('users', load)));

    assert.equal(load.mock.callCount(), 1);
    outcomes.forEach((outcome) => assert.equal(outcome.reason, error));
    assert.equal(await run('users', async () => 'recovered'), 'recovered');
  });

  test('turns a synchronous throw of fn into a rejection shared by the calls of that tick, and releases the key', async (t) => {
    const run = singleFlight();
    const error = new Error('boom');
    const load = t.mock.fn(() => {
      throw error;
    });
    const first = run('users', load);
    const second = run('users', load);

    assert.equal(second, first);
    assert.equal(await rejectionOf(first), error);
    assert.equal(load.mock.callCount(), 1);
    assert.equal(await run('users', () => 'recovered'), 'recovered');
  });

  test('keeps keys apart: a flight or a failure of one key does not touch another', async () => {
    const run = singleFlight();
    const gate = Promise.withResolvers();
    const error = new Error('boom');
    const users = run('users', () => gate.promise);

    assert.equal(await run('groups', () => 'groups'), 'groups');
    assert.equal(await rejectionOf(run('roles', () => Promise.reject(error))), error);

    gate.resolve('users');

    assert.equal(await users, 'users');
  });

  test('accepts any value but null and undefined as a key, falsy ones too', async () => {
    const run = singleFlight();
    const gate = Promise.withResolvers();
    const flights = [0, '', false, '0'].map((key) => run(key, () => gate.promise));

    assert.equal(new Set(flights).size, 4);
    assert.equal(run(0, () => 'joined'), flights[0]);

    gate.resolve('value');
    await Promise.all(flights);
  });

  test('keeps two factories apart', async () => {
    const first = singleFlight();
    const second = singleFlight();
    const gate = Promise.withResolvers();
    const held = first('users', () => gate.promise);

    assert.equal(await second('users', () => 'second'), 'second');

    gate.resolve('first');

    assert.equal(await held, 'first');
  });

  test('rejects with a TypeError for a missing key or what is not a function, and takes no key for it', async () => {
    const run = singleFlight();

    await assert.rejects(run(undefined, () => 'value'), errorNaming(TypeError, 'run'));
    await assert.rejects(run(null, () => 'value'), errorNaming(TypeError, 'run'));
    await Promise.all(NOT_FUNCTIONS.map((fn) => assert.rejects(run('users', fn), errorNaming(TypeError, 'run'))));

    assert.equal(await run('users', () => 'value'), 'value');
  });
});
