import { randomInt } from '#utils/random.js';
import { isFunction, isNumber, isNumberInRange } from '#utils/type.js';

// setTimeout() turns a longer delay into 1 ms.
const TIMER_MAX_MS = 2 ** 31 - 1;

const TIMEOUT_ERROR_NAME = 'TimeoutError';

const RETRY_FIRST_ATTEMPT = 1;
const RETRY_RETRIES = 3;
const RETRY_MIN_DELAY_MS = 100;
const RETRY_MAX_DELAY_MS = 5000;
const RETRY_FACTOR = 2;

function isTimerDelay(ms) {
  return isNumberInRange(ms, 0, TIMER_MAX_MS);
}

function assertFunction(fn, name) {
  if (!isFunction(fn)) {
    throw new TypeError(`${name} requires a function`);
  }
}

function assertSignal(signal, name) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError(`${name} requires signal to be an AbortSignal`);
  }
}

export async function sleep(ms, { signal } = {}) {
  if (!isTimerDelay(ms)) {
    throw new RangeError(`sleep(ms) requires a number of milliseconds from 0 to ${TIMER_MAX_MS}`);
  }

  assertSignal(signal, 'sleep(ms, options)');
  signal?.throwIfAborted();

  const { promise, resolve, reject } = Promise.withResolvers();

  function onAbort() {
    reject(signal.reason);
  }

  const timer = setTimeout(resolve, ms);

  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function withTimeout(fn, ms, { signal } = {}) {
  assertFunction(fn, 'withTimeout(fn, ms)');

  if (!isTimerDelay(ms) || ms === 0) {
    throw new RangeError(`withTimeout(fn, ms) requires a number of milliseconds above 0 and up to ${TIMER_MAX_MS}`);
  }

  assertSignal(signal, 'withTimeout(fn, ms, options)');
  signal?.throwIfAborted();

  // Created here, not in the timer callback: the stack then shows who called withTimeout().
  const timeoutError = new DOMException(`The operation timed out after ${ms} ms`, TIMEOUT_ERROR_NAME);
  const controller = new AbortController();
  const { promise: whenAborted, reject } = Promise.withResolvers();

  function abort(reason) {
    controller.abort(reason);
    reject(controller.signal.reason);
  }

  function onAbort() {
    abort(signal.reason);
  }

  const timer = setTimeout(abort, ms, timeoutError);

  signal?.addEventListener('abort', onAbort, { once: true });

  // The signal is not aborted once fn has settled: that would cut off a result that still streams, such as a fetch body.
  try {
    return await Promise.race([Promise.try(fn, controller.signal), whenAborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function assertRetryOptions(options) {
  if (!Number.isSafeInteger(options.retries) || options.retries < 0) {
    throw new RangeError('retry(fn, options) requires retries to be a non-negative integer');
  }

  if (!isTimerDelay(options.minDelayMs) || !isTimerDelay(options.maxDelayMs)) {
    throw new RangeError(`retry(fn, options) requires minDelayMs and maxDelayMs from 0 to ${TIMER_MAX_MS}`);
  }

  if (!isNumber(options.factor) || options.factor < 1) {
    throw new RangeError('retry(fn, options) requires a factor of at least 1');
  }

  if (options.shouldRetry !== undefined && !isFunction(options.shouldRetry)) {
    throw new TypeError('retry(fn, options) requires shouldRetry to be a function');
  }

  assertSignal(options.signal, 'retry(fn, options)');
}

// The power is clamped to a finite number: at a high attempt it is Infinity, and 0 * Infinity would make the ceiling NaN.
function backoffCeiling(attempt, { minDelayMs, maxDelayMs, factor }) {
  const growth = Math.min(factor ** (attempt - 1), Number.MAX_VALUE);

  return Math.floor(Math.min(maxDelayMs, minDelayMs * growth));
}

async function waitBeforeRetry(error, attempt, options) {
  const { retries, signal, shouldRetry } = options;

  if (attempt > retries || (shouldRetry && !(await shouldRetry(error, attempt)))) {
    throw error;
  }

  await sleep(randomInt(0, backoffCeiling(attempt, options)), { signal });
}

async function runAttempt(fn, attempt, options) {
  options.signal?.throwIfAborted();

  try {
    return await fn(attempt);
  } catch (error) {
    await waitBeforeRetry(error, attempt, options);
  }

  return runAttempt(fn, attempt + 1, options);
}

export async function retry(fn, {
  retries = RETRY_RETRIES,
  minDelayMs = RETRY_MIN_DELAY_MS,
  maxDelayMs = RETRY_MAX_DELAY_MS,
  factor = RETRY_FACTOR,
  signal,
  shouldRetry,
} = {}) {
  const options = {
    retries, minDelayMs, maxDelayMs, factor, signal, shouldRetry,
  };

  assertFunction(fn, 'retry(fn, options)');
  assertRetryOptions(options);

  return runAttempt(fn, RETRY_FIRST_ATTEMPT, options);
}

// A linked list, not an array: shift() on a long array takes time proportional to its length.
function createQueue() {
  let head = null;
  let tail = null;
  let size = 0;

  function push(item) {
    const node = { item, next: null };

    if (tail) {
      tail.next = node;
    } else {
      head = node;
    }

    tail = node;
    size += 1;
  }

  function shift() {
    const node = head;

    if (!node) {
      return null;
    }

    head = node.next;
    size -= 1;

    if (!head) {
      tail = null;
    }

    return node.item;
  }

  function getSize() {
    return size;
  }

  return { push, shift, getSize };
}

export function pLimit(concurrency) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('pLimit(concurrency) requires a positive integer');
  }

  const waiting = createQueue();
  let activeCount = 0;

  // The slot is counted here, at the grant, not when the call resumes a tick later: a call made in between
  // would otherwise see the slot as free and run above the limit.
  function grant() {
    if (activeCount < concurrency && waiting.getSize()) {
      const start = waiting.shift();

      activeCount += 1;
      start();
    }
  }

  function release() {
    activeCount -= 1;
    grant();
  }

  async function limit(fn) {
    assertFunction(fn, 'limit(fn)');

    await new Promise((resolve) => {
      waiting.push(resolve);
      grant();
    });

    try {
      return await fn();
    } finally {
      release();
    }
  }

  return Object.defineProperties(limit, {
    activeCount: { get: () => activeCount },
    pendingCount: { get: waiting.getSize },
  });
}

export function singleFlight() {
  const flights = new Map();

  // Promise.try(), not a bare call: a synchronous throw would run the finally before run() has stored the flight,
  // and the key would then hold that rejected promise for good.
  async function fly(key, fn) {
    try {
      return await Promise.try(fn);
    } finally {
      flights.delete(key);
    }
  }

  function run(key, fn) {
    if (key === undefined || key === null || !isFunction(fn)) {
      return Promise.reject(new TypeError('run(key, fn) requires a key and a function'));
    }

    if (!flights.has(key)) {
      flights.set(key, fly(key, fn));
    }

    return flights.get(key);
  }

  return run;
}
