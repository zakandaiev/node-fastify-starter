import { createContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import { handleFatalErrors } from '#core/process/index.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { writeSync } from 'node:fs';
import { argv, stdout } from 'node:process';
import { setImmediate as nextLoop } from 'node:timers/promises';

// node tests/fixture/fatal-error.js <failure> <shutdown> <timeout> [<webhook url>]
const [, , failureName, shutdownName, timeout, webhookUrl] = argv;

const SHUTDOWN_MESSAGE = 'Shutdown ran';
const EXIT_MESSAGE = 'Process exits';
const KEEP_ALIVE_MS = 1000;

// Synchronous: a line of the "exit" event would wait in the buffer of the logger and never be written.
const syncStdout = {
  write(line) {
    writeSync(stdout.fd, line);
  },
};

const config = createTestConfig({ env: { APP_ALERT_WEBHOOK_URL: webhookUrl }, logger: { level: 'info' } });
const log = createLogger({ ...config.logger, stream: syncStdout });

function rejectUnawaited() {
  Promise.reject(new Error('A promise nothing awaits rejected'));

  return true;
}

function throwFromTimer() {
  setTimeout(() => {
    throw new Error('A timer threw');
  });

  return true;
}

// A reason without a primitive form: String() throws on it.
function rejectWithBareObject() {
  Promise.reject(Object.create(null));

  return true;
}

async function shutdownAtOnce() {
  log.info(SHUTDOWN_MESSAGE);

  return true;
}

// The second failure comes while the first one is still shutting the process down.
async function shutdownFailingAgain() {
  log.info(SHUTDOWN_MESSAGE);
  Promise.reject(new Error('The shutdown failed as well'));
  await nextLoop();

  return true;
}

// A handle nobody closes, as a server whose close hangs: the process cannot exit by itself.
function shutdownNever() {
  log.info(SHUTDOWN_MESSAGE);
  setInterval(() => {}, KEEP_ALIVE_MS);

  return new Promise(() => {});
}

async function shutdownRejecting() {
  log.info(SHUTDOWN_MESSAGE);

  throw new Error('The shutdown rejected');
}

function shutdownThrowing() {
  log.info(SHUTDOWN_MESSAGE);

  throw new Error('The shutdown threw at once');
}

const FAILURES = Object.freeze({
  rejection: rejectUnawaited,
  exception: throwFromTimer,
  bare: rejectWithBareObject,
});

const SHUTDOWNS = Object.freeze({
  'at-once': shutdownAtOnce,
  'failing-again': shutdownFailingAgain,
  never: shutdownNever,
  rejecting: shutdownRejecting,
  throwing: shutdownThrowing,
});

process.once('exit', (code) => log.info({ code }, EXIT_MESSAGE));

handleFatalErrors({
  context: createContext({ config, log }),
  shutdown: SHUTDOWNS[shutdownName],
  timeout,
});

FAILURES[failureName]();
