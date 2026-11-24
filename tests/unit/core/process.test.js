import { createContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import { handleFatalErrors } from '#core/process/index.js';
import { createAlertReceiver } from '#root/tests/helper/alert.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { parseLogLines } from '#root/tests/helper/log.js';
import { runNode } from '#root/tests/helper/process.js';
import { convertStringToMs } from '#utils/date.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

const FATAL_ERROR = 'tests/fixture/fatal-error.js';

const FATAL_MESSAGE = 'Process failed: it shuts down';
const AGAIN_MESSAGE = 'Process failed again while it shuts down';
const ALERT_SENT_MESSAGE = 'Alert sent';
const SHUTDOWN_MESSAGE = 'Shutdown ran';
const SHUTDOWN_FAILED_MESSAGE = 'Process failed to shut down';
const EXIT_MESSAGE = 'Process exits';
const KEY_MESSAGES = Object.freeze([
  FATAL_MESSAGE,
  AGAIN_MESSAGE,
  ALERT_SENT_MESSAGE,
  SHUTDOWN_MESSAGE,
  SHUTDOWN_FAILED_MESSAGE,
  EXIT_MESSAGE,
]);
const ALERT_TITLE = 'Process failed';

const FATAL_EVENTS = Object.freeze(['uncaughtException', 'unhandledRejection']);
const FATAL_LEVEL = 60;
const ERROR_LEVEL = 50;
const EXIT_FAILED = 1;

// Far above a graceful shutdown: a process that exits before it did not wait for the timer.
const TIMEOUT = '5s';
const SHORT_TIMEOUT = '0.5s';

// Both times come from Date.now() of the child: a timer never fires early, the clock may round by a millisecond.
const CLOCK_TOLERANCE_MS = 5;

const CALL_REFUSAL = /requires the context of the app and a function that shuts it down/;
const TIMEOUT_REFUSAL = /requires a duration above zero/;

async function runFailing(t, {
  failure,
  shutdown = 'at-once',
  timeout = TIMEOUT,
  respond,
}) {
  const receiver = await createAlertReceiver(t, respond);
  const { code, stdout } = await runNode(FATAL_ERROR, {
    args: [failure, shutdown, timeout, receiver.env.webhook.APP_ALERT_WEBHOOK_URL],
  });
  const lines = parseLogLines(stdout);

  return {
    code,
    lines,
    messages: lines.map((line) => line.msg).filter((message) => KEY_MESSAGES.includes(message)),
    alerts: receiver.findRequests(receiver.paths.webhook),
  };
}

function findLine(lines, message) {
  return lines.find((line) => line.msg === message);
}

function readExitDelay(lines) {
  return findLine(lines, EXIT_MESSAGE).time - findLine(lines, FATAL_MESSAGE).time;
}

function readErrorBlock(request) {
  return request.body.blocks.find((block) => block.name === 'Error').value;
}

function countListeners() {
  return FATAL_EVENTS.map((event) => process.listenerCount(event));
}

async function shutdownNothing() {
  return true;
}

describe('handleFatalErrors', () => {
  test('logs a rejection nothing awaited once as fatal, starts the shutdown while the alert goes out, and exits with 1', async (t) => {
    const {
      code,
      lines,
      messages,
      alerts,
    } = await runFailing(t, { failure: 'rejection' });
    const fatal = findLine(lines, FATAL_MESSAGE);

    assert.equal(code, EXIT_FAILED);
    assert.deepEqual(messages, [FATAL_MESSAGE, SHUTDOWN_MESSAGE, ALERT_SENT_MESSAGE, EXIT_MESSAGE]);
    assert.equal(fatal.level, FATAL_LEVEL);
    assert.equal(fatal.event, 'unhandledRejection');
    assert.equal(fatal.err.type, 'Error');
    assert.equal(fatal.err.message, 'A promise nothing awaits rejected');
    assert.deepEqual(alerts.map((request) => request.body.title), [ALERT_TITLE]);
    assert.equal(readErrorBlock(alerts[0]).message, fatal.err.message);
    assert.equal(findLine(lines, EXIT_MESSAGE).code, EXIT_FAILED);
    assert.ok(readExitDelay(lines) < convertStringToMs(TIMEOUT));
  });

  test('does the same for an exception thrown from a timer', async (t) => {
    const {
      code,
      lines,
      messages,
      alerts,
    } = await runFailing(t, { failure: 'exception' });
    const fatal = findLine(lines, FATAL_MESSAGE);

    assert.equal(code, EXIT_FAILED);
    assert.deepEqual(messages, [FATAL_MESSAGE, SHUTDOWN_MESSAGE, ALERT_SENT_MESSAGE, EXIT_MESSAGE]);
    assert.equal(fatal.level, FATAL_LEVEL);
    assert.equal(fatal.event, 'uncaughtException');
    assert.equal(fatal.err.message, 'A timer threw');
    assert.deepEqual(alerts.map((request) => request.body.title), [ALERT_TITLE]);
    assert.equal(readErrorBlock(alerts[0]).message, fatal.err.message);
    assert.ok(readExitDelay(lines) < convertStringToMs(TIMEOUT));
  });

  test('logs a second failure during the shutdown apart, and still alerts and shuts down once', async (t) => {
    const {
      code,
      lines,
      messages,
      alerts,
    } = await runFailing(t, { failure: 'rejection', shutdown: 'failing-again' });
    const again = findLine(lines, AGAIN_MESSAGE);

    assert.equal(code, EXIT_FAILED);
    assert.deepEqual(messages, [FATAL_MESSAGE, SHUTDOWN_MESSAGE, AGAIN_MESSAGE, ALERT_SENT_MESSAGE, EXIT_MESSAGE]);
    assert.equal(again.level, ERROR_LEVEL);
    assert.equal(again.event, 'unhandledRejection');
    assert.equal(again.err.message, 'The shutdown failed as well');
    assert.equal(alerts.length, 1);
  });

  test('logs why a shutdown rejected or threw at once, and still alerts and exits with 1', async (t) => {
    const runs = await Promise.all(['rejecting', 'throwing'].map((shutdown) => runFailing(t, { failure: 'rejection', shutdown })));
    const failures = runs.map((run) => findLine(run.lines, SHUTDOWN_FAILED_MESSAGE));

    runs.forEach((run) => {
      assert.equal(run.code, EXIT_FAILED);
      assert.deepEqual(run.messages, [FATAL_MESSAGE, SHUTDOWN_MESSAGE, ALERT_SENT_MESSAGE, SHUTDOWN_FAILED_MESSAGE, EXIT_MESSAGE]);
      assert.equal(run.alerts.length, 1);
    });
    assert.deepEqual(failures.map((line) => [line.level, line.err.message]), [
      [ERROR_LEVEL, 'The shutdown rejected'],
      [ERROR_LEVEL, 'The shutdown threw at once'],
    ]);
  });

  test('exits with 1 once the timeout has passed when the shutdown never ends', async (t) => {
    const { code, lines, messages } = await runFailing(t, { failure: 'rejection', shutdown: 'never', timeout: SHORT_TIMEOUT });

    assert.equal(code, EXIT_FAILED);
    assert.deepEqual(messages, [FATAL_MESSAGE, SHUTDOWN_MESSAGE, ALERT_SENT_MESSAGE, EXIT_MESSAGE]);
    assert.ok(readExitDelay(lines) >= convertStringToMs(SHORT_TIMEOUT) - CLOCK_TOLERANCE_MS, `${readExitDelay(lines)} ms`);
  });

  test('shuts down while the alert still waits for its channel, and exits with 1 once the timeout has passed', async (t) => {
    const {
      code,
      lines,
      messages,
      alerts,
    } = await runFailing(t, {
      failure: 'rejection',
      timeout: SHORT_TIMEOUT,
      respond: () => ({ isHanging: true }),
    });

    assert.equal(code, EXIT_FAILED);
    assert.equal(alerts.length, 1);
    assert.deepEqual(messages, [FATAL_MESSAGE, SHUTDOWN_MESSAGE, EXIT_MESSAGE]);
    assert.ok(readExitDelay(lines) >= convertStringToMs(SHORT_TIMEOUT) - CLOCK_TOLERANCE_MS, `${readExitDelay(lines)} ms`);
    assert.ok(readExitDelay(lines) < convertStringToMs(createTestConfig().alert.sendTimeout), `${readExitDelay(lines)} ms`);
  });

  test('shuts down gracefully whatever a rejection holds, a reason without a primitive form included', async (t) => {
    const {
      code,
      lines,
      messages,
      alerts,
    } = await runFailing(t, { failure: 'bare' });

    assert.equal(code, EXIT_FAILED);
    assert.deepEqual(messages, [FATAL_MESSAGE, SHUTDOWN_MESSAGE, ALERT_SENT_MESSAGE, EXIT_MESSAGE]);
    assert.equal(findLine(lines, FATAL_MESSAGE).event, 'unhandledRejection');
    assert.deepEqual(alerts.map((request) => request.body.title), [ALERT_TITLE]);
    assert.ok(readExitDelay(lines) < convertStringToMs(TIMEOUT), `${readExitDelay(lines)} ms`);
  });

  test('refuses a missing context or shutdown and a timeout that is not above zero, and listens to nothing then', () => {
    const config = createTestConfig();
    const context = createContext({ config, log: createLogger(config.logger) });
    const shutdown = shutdownNothing;
    const listenersBefore = countListeners();

    [
      [undefined, CALL_REFUSAL],
      [{ shutdown, timeout: '1s' }, CALL_REFUSAL],
      [{ context, timeout: '1s' }, CALL_REFUSAL],
      [{ context, shutdown: 'shutdown', timeout: '1s' }, CALL_REFUSAL],
      [{ context, shutdown, timeout: '0s' }, TIMEOUT_REFUSAL],
      [{ context, shutdown, timeout: '-1s' }, TIMEOUT_REFUSAL],
      [{ context, shutdown, timeout: '0.0001s' }, TIMEOUT_REFUSAL],
    ].forEach(([options, refusal]) => {
      assert.throws(
        () => handleFatalErrors(options),
        (error) => error instanceof TypeError && refusal.test(error.message),
        inspect(options, { depth: 0 }),
      );
    });
    [{ context, shutdown }, { context, shutdown, timeout: 'soon' }].forEach((options) => {
      assert.throws(() => handleFatalErrors(options), TypeError, inspect(options, { depth: 0 }));
    });

    assert.deepEqual(countListeners(), listenersBefore);
  });
});
