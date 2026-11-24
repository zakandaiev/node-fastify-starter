import { alert } from '#core/alert/index.js';
import { readErrorCause } from '#core/alert/message.js';
import { runInContext } from '#core/context/index.js';
import { convertStringToMs } from '#utils/date.js';
import { isFunction } from '#utils/type.js';

const FATAL_EVENTS = Object.freeze(['uncaughtException', 'unhandledRejection']);

const FATAL_MESSAGE = 'Process failed: it shuts down';
const AGAIN_MESSAGE = 'Process failed again while it shuts down';
const SHUTDOWN_FAILED_MESSAGE = 'Process failed to shut down';
const FATAL_TITLE = 'Process failed';
const DEDUPE_PREFIX = 'process-failed';

const EXIT_FAILED = 1;
const KEY_SEPARATOR = ':';
const REJECTED = 'rejected';

// A shutdown that throws at once is one more failure to wait for, not a way out of the wait.
async function runShutdown(shutdown) {
  await shutdown();

  return true;
}

async function failOnce(state, error, event) {
  const { context, shutdown, timeoutMs } = state;

  if (state.isFailing) {
    context.log.error({ err: error, event }, AGAIN_MESSAGE);

    return false;
  }

  state.isFailing = true;
  process.exitCode = EXIT_FAILED;

  // The one exit that is not graceful: a close that waits for a dead service would keep a broken process up.
  setTimeout(() => process.exit(EXIT_FAILED), timeoutMs).unref();

  context.log.fatal({ err: error, event }, FATAL_MESSAGE);

  // The dedupe of the alert is decided while Redis is still open, so a crash loop reports once, unless its Redis is not
  // ready then; the process stops taking traffic while the channels are being sent to, not after them.
  const pending = await runInContext(context, () => alert({
    title: FATAL_TITLE,
    dedupeKey: [DEDUPE_PREFIX, event, readErrorCause(error)].join(KEY_SEPARATOR),
    error,
    isDetached: true,
  }));

  const [, closed] = await Promise.allSettled([pending.delivery, runShutdown(shutdown)]);

  if (closed.status === REJECTED) {
    context.log.error({ err: closed.reason }, SHUTDOWN_FAILED_MESSAGE);
  }

  return true;
}

// A rejection here would come straight back as another unhandled one.
async function onFatal(state, error, event) {
  try {
    return await failOnce(state, error, event);
  } catch {
    return false;
  }
}

// For an entrypoint, once: an exception nothing caught and a rejection nothing awaited leave the process
// in a state nobody knows. Either is logged and alerted, and the process shuts down gracefully with the code 1;
// once "timeout" has passed it exits anyway.
export function handleFatalErrors({ context, shutdown, timeout } = {}) {
  if (!context || !isFunction(shutdown)) {
    throw new TypeError('handleFatalErrors({ context, shutdown, timeout }) requires the context of the app and a function that shuts it down');
  }

  const timeoutMs = convertStringToMs(timeout);

  if (!(timeoutMs > 0)) {
    throw new TypeError('handleFatalErrors({ timeout }) requires a duration above zero, such as "15s"');
  }

  const state = {
    context,
    shutdown,
    timeoutMs,
    isFailing: false,
  };

  FATAL_EVENTS.forEach((event) => {
    process.on(event, (error) => onFatal(state, error, event));
  });

  return true;
}
