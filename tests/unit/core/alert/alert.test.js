import {
  alert,
  assertAlertConfig,
  isAlertReported,
  settleAlerts,
} from '#core/alert/index.js';
import { createContext, runInContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import { createRedis } from '#core/redis/index.js';
import { ALERT_CHANNEL } from '#enums/alert-channel.js';
import { ALERT_SPACE } from '#enums/alert-space.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import {
  answerByDefault,
  answerOn,
  createAlertReceiver,
  failureOf,
  sumSuppressed,
  TELEGRAM_TEST_ENV,
  warningOf,
} from '#root/tests/helper/alert.js';
import { timeIt } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { FAST_RECONNECT, REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const REDIS_LABEL = 'Alert Redis';

const SHORT_WINDOWS = Object.freeze({ throttleWindow: '0.2s', dedupeTtl: '1h', sendTimeout: '0.3s' });
const PAST_WINDOW_MS = 300;
const SEND_TIMEOUT_MS = 300;

const BOT_API_PATH_PREFIX = '/bot';
const TEXT_REFUSAL = Object.freeze({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } });

const BURST = 100;

// fetch() refuses port 1 before the network: the Bot API is out of reach.
const DOWN_URL = 'http://127.0.0.1:1';

const NOT_DELIVERED_MESSAGE = 'Alert not delivered';
const FAILED_MESSAGE = 'Alert failed';
const UNSTARTED_MESSAGE = `${REDIS_LABEL} was never told to connect: nothing reaches it, call connect() in the entrypoint`;

const TELEGRAM_AND_WEBHOOK = Object.freeze([ALERT_CHANNEL.TELEGRAM, ALERT_CHANNEL.WEBHOOK]);

const EMPTY_RESULT = Object.freeze({ isDeduped: false, isThrottled: false, channels: {} });
const DEDUPED_RESULT = Object.freeze({ isDeduped: true, isThrottled: false, channels: {} });
const THROTTLED_RESULT = Object.freeze({ isDeduped: false, isThrottled: true, channels: {} });

const TITLE = 'Payments down';
const DEDUPE_KEY = 'upstream:payments:network';

const WRONG_CALLS = Object.freeze([
  ['no options', undefined],
  ['options that are not an object', TITLE],
  ['no title', { dedupeKey: DEDUPE_KEY }],
  ['an empty title', { title: '', dedupeKey: DEDUPE_KEY }],
  ['no dedupeKey', { title: TITLE }],
  ['a dedupeKey that is not a string', { title: TITLE, dedupeKey: 42 }],
  ['an unknown throttleClass', { title: TITLE, dedupeKey: DEDUPE_KEY, throttleClass: 'critical' }],
  ['an unknown space', { title: TITLE, dedupeKey: DEDUPE_KEY, space: 'external' }],
  ['isSilent that is not a boolean', { title: TITLE, dedupeKey: DEDUPE_KEY, isSilent: 'yes' }],
  ['a request that is not an object', { title: TITLE, dedupeKey: DEDUPE_KEY, request: 'GET /payments' }],
  ['a request that is null', { title: TITLE, dedupeKey: DEDUPE_KEY, request: null }],
  ['a url that is not a string', { title: TITLE, dedupeKey: DEDUPE_KEY, url: 42 }],
]);

function resultOf(channels) {
  return { isDeduped: false, isThrottled: false, channels };
}

function deliveredTo(...names) {
  return resultOf(Object.fromEntries(names.map((name) => [name, { isDelivered: true }])));
}

function readBodies(receiver, channel) {
  return receiver.findRequests(receiver.paths[channel]).map((request) => request.body);
}

function readLastLine(text) {
  return text.split('\n').at(-1);
}

function openRedis(t, config, log) {
  const { cache, ...main } = config.redis;
  const redis = createRedis(main, { log, label: REDIS_LABEL });

  t.after(() => redis.close());

  return redis;
}

// Every channel named points at a receiver of the test. The Redis is a client of the test alone and is never started
// unless the test starts it: the state of dedupe and throttle lives in the memory of that client, apart from the rest.
async function openAlert(t, {
  channels = [ALERT_CHANNEL.WEBHOOK],
  respond = answerByDefault,
  alert: alertSection = {},
  redis: sharedRedis,
} = {}) {
  const receiver = await createAlertReceiver(t, respond);
  const sink = createLogSink();
  const config = createTestConfig({
    env: channels.reduce((env, name) => ({ ...env, ...receiver.env[name] }), REDIS_DOWN_ENV),
    redis: FAST_RECONNECT,
    alert: { ...SHORT_WINDOWS, ...receiver.config.alert, ...alertSection },
    logger: { level: 'debug', stream: sink.stream },
  });
  const log = createLogger(config.logger);
  const redis = sharedRedis ?? openRedis(t, config, log);
  const context = createContext({ config, log, redis });

  function send(options) {
    return runInContext(context, () => alert(options));
  }

  return {
    receiver,
    sink,
    redis,
    send,
  };
}

describe('alert', () => {
  test('a stopped service gives one message, not hundreds: of 100 alerts of one dedupe key at once one goes out, and the key holds after the window', async (t) => {
    const { receiver, send } = await openAlert(t, { channels: TELEGRAM_AND_WEBHOOK });
    const results = await Promise.all(Array.from({ length: BURST }, () => send(failureOf('payments'))));
    const throttledCount = results.filter((result) => result.isThrottled).length;
    const dedupedCount = results.filter((result) => result.isDeduped).length;

    assert.deepEqual(results.filter((result) => isAlertReported(result)), [deliveredTo(...TELEGRAM_AND_WEBHOOK)]);
    assert.equal(throttledCount + dedupedCount, BURST - 1);
    assert.equal(readBodies(receiver, ALERT_CHANNEL.TELEGRAM).length, 1);
    assert.equal(readBodies(receiver, ALERT_CHANNEL.WEBHOOK).length, 1);

    await sleep(PAST_WINDOW_MS);

    assert.deepEqual(await send(failureOf('payments')), DEDUPED_RESULT);
    assert.deepEqual(await send(failureOf('mail')), deliveredTo(...TELEGRAM_AND_WEBHOOK));
    assert.deepEqual(readBodies(receiver, ALERT_CHANNEL.WEBHOOK).map((body) => [body.title, body.suppressedCount]), [
      [failureOf('payments').title, 0],
      [failureOf('mail').title, throttledCount],
    ]);
  });

  test('alerts of other keys in the same window are throttled, and the first message after it says "Suppressed by throttle: N"', async (t) => {
    const { receiver, send } = await openAlert(t, { channels: TELEGRAM_AND_WEBHOOK });
    const others = ['mail', 'search', 'storage'];

    assert.deepEqual(await send(failureOf('payments')), deliveredTo(...TELEGRAM_AND_WEBHOOK));

    const throttled = await Promise.all(others.map((service) => send(failureOf(service))));

    await sleep(PAST_WINDOW_MS);

    const next = await send(failureOf('queue'));
    const [firstText, nextText] = readBodies(receiver, ALERT_CHANNEL.TELEGRAM).map((body) => body.text);

    throttled.forEach((result) => assert.deepEqual(result, THROTTLED_RESULT));
    assert.deepEqual(next, deliveredTo(...TELEGRAM_AND_WEBHOOK));
    assert.equal(firstText.includes('Suppressed by throttle'), false);
    assert.equal(readLastLine(nextText), `⏳ *Suppressed by throttle:* ${others.length}`);
    assert.deepEqual(readBodies(receiver, ALERT_CHANNEL.WEBHOOK).map((body) => body.suppressedCount), [0, others.length]);
  });

  test('a warning does not mute a failure: both go out at the same moment, and the silent window and the public space are apart from them', async (t) => {
    const { receiver, send } = await openAlert(t);
    const first = await Promise.all([
      send({ ...failureOf('search'), throttleClass: THROTTLE_CLASS.WARNING }),
      send(failureOf('payments')),
      send({ title: 'Weekly canary', dedupeKey: 'canary:1', isSilent: true }),
      send({ ...failureOf('payments'), space: ALERT_SPACE.PUBLIC }),
    ]);
    const second = await Promise.all([
      send({ ...failureOf('storage'), throttleClass: THROTTLE_CLASS.WARNING }),
      send(failureOf('mail')),
      send({ title: 'Weekly canary', dedupeKey: 'canary:2', isSilent: true }),
      send({ ...failureOf('mail'), space: ALERT_SPACE.PUBLIC }),
    ]);
    const windows = readBodies(receiver, ALERT_CHANNEL.WEBHOOK).map((body) => `${body.space}:${body.throttleClass}`);

    first.forEach((result) => assert.deepEqual(result, deliveredTo(ALERT_CHANNEL.WEBHOOK)));
    second.forEach((result) => assert.deepEqual(result, THROTTLED_RESULT));
    assert.deepEqual(windows.toSorted(), ['internal:failure', 'internal:silent', 'internal:warning', 'public:failure']);
  });

  test('a failed delivery releases the dedupe key: the same alert waits only for the window and goes out again', async (t) => {
    const { receiver, sink, send } = await openAlert(t, { respond: answerOn([1], { status: 500, body: { error: 'Internal Server Error' } }) });

    assert.deepEqual(await send(failureOf('payments')), resultOf({ webhook: { isDelivered: false, reason: 'failed' } }));
    assert.deepEqual(await send(failureOf('payments')), THROTTLED_RESULT);

    await sleep(PAST_WINDOW_MS);

    assert.deepEqual(await send(failureOf('payments')), deliveredTo(ALERT_CHANNEL.WEBHOOK));
    assert.equal(readBodies(receiver, ALERT_CHANNEL.WEBHOOK).length, 2);
    assert.deepEqual(findLogLines(sink, NOT_DELIVERED_MESSAGE).map((line) => line.alert.isMarkReleased), [true]);
  });

  test('a text Telegram refused keeps the dedupe key: the same alert is deduped after the window', async (t) => {
    const { receiver, sink, send } = await openAlert(t, {
      channels: [ALERT_CHANNEL.TELEGRAM],
      respond: () => ({
        status: 400,
        body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 7" },
      }),
    });

    assert.deepEqual(await send(failureOf('payments')), resultOf({ telegram: { isDelivered: false, reason: 'rejected-text' } }));

    await sleep(PAST_WINDOW_MS);

    assert.deepEqual(await send(failureOf('payments')), DEDUPED_RESULT);
    assert.equal(readBodies(receiver, ALERT_CHANNEL.TELEGRAM).length, 1);
    assert.deepEqual(findLogLines(sink, NOT_DELIVERED_MESSAGE).map((line) => line.alert.isMarkReleased), [false]);
  });

  test('does not throw when Telegram and Redis are down: it resolves what failed and logs one line without the text, the key, the token or the chat id', async (t) => {
    const { sink, redis, send } = await openAlert(t, { channels: [ALERT_CHANNEL.TELEGRAM], alert: { telegramApiUrl: DOWN_URL } });
    const email = 'anna@example.com';
    const text = `The card of ${email} was refused`;
    const dedupeKey = 'payments:card-refused:203.0.113.7';

    redis.connect();

    const result = await send({ title: TITLE, dedupeKey, error: new Error(text) });
    const lines = findLogLines(sink, NOT_DELIVERED_MESSAGE);
    const [line] = lines;
    const secrets = [text, email, dedupeKey, '203.0.113.7', TELEGRAM_TEST_ENV.APP_ALERT_TELEGRAM_BOT_TOKEN, TELEGRAM_TEST_ENV.APP_ALERT_TELEGRAM_CHAT_ID];

    assert.deepEqual(result, resultOf({ telegram: { isDelivered: false, reason: 'unreachable' } }));
    assert.equal(isAlertReported(result), false);
    assert.equal(lines.length, 1);
    assert.equal(line.level, LOG_LEVEL.ERROR);
    assert.equal(line.alert.channel, ALERT_CHANNEL.TELEGRAM);
    assert.equal(line.alert.space, ALERT_SPACE.INTERNAL);
    assert.equal(line.alert.title, TITLE);
    assert.equal(line.alert.reason, 'unreachable');
    assert.match(line.alert.hint, /\S/);
    secrets.forEach((secret) => {
      assert.equal(JSON.stringify(line).includes(secret), false, secret);
      assert.equal(JSON.stringify(sink.lines).includes(secret), false, secret);
    });
    assert.equal(line.alert.isMarkReleased, true);
  });

  test('gets through with the webhook channel alone', async (t) => {
    const { receiver, send } = await openAlert(t, { channels: [ALERT_CHANNEL.WEBHOOK] });
    const result = await send({ ...failureOf('payments'), error: { message: 'connect ECONNREFUSED' } });
    const [request] = receiver.requests;

    assert.deepEqual(result, deliveredTo(ALERT_CHANNEL.WEBHOOK));
    assert.equal(receiver.requests.length, 1);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, receiver.paths.webhook);
    assert.equal(request.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(request.body.title, failureOf('payments').title);
    assert.equal(request.body.space, ALERT_SPACE.INTERNAL);
    assert.equal(request.body.throttleClass, THROTTLE_CLASS.FAILURE);
  });

  test('a wrong call resolves an empty result, sends nothing and logs "Alert failed" with a TypeError', async (t) => {
    const { receiver, sink, send } = await openAlert(t, { channels: TELEGRAM_AND_WEBHOOK });
    const results = await Promise.all(WRONG_CALLS.map(([, options]) => send(options)));
    const lines = findLogLines(sink, FAILED_MESSAGE);

    results.forEach((result, index) => assert.deepEqual(result, EMPTY_RESULT, WRONG_CALLS[index][0]));
    assert.equal(lines.length, WRONG_CALLS.length);
    lines.forEach((line) => {
      assert.equal(line.level, LOG_LEVEL.ERROR);
      assert.equal(line.err.type, 'TypeError');
      assert.match(line.err.message, /^alert\(/);
    });
    assert.equal(JSON.stringify(lines).includes(DEDUPE_KEY), false);
    assert.deepEqual(receiver.requests, []);
  });

  test('resolves an empty result with no context at all', async () => {
    assert.deepEqual(await alert(failureOf('payments')), EMPTY_RESULT);
    assert.deepEqual(await alert(), EMPTY_RESULT);
  });

  test('resolves an empty result when even the logger throws', async () => {
    const log = {
      error() {
        throw new Error('The log is gone');
      },
    };
    const context = createContext({ config: createTestConfig(), log });

    assert.deepEqual(await runInContext(context, () => alert({ title: TITLE })), EMPTY_RESULT);
  });

  // A zero deadline is refused by fetchUpstream() with a TypeError that no channel turns into a result of its own:
  // it stands for a bug of a channel.
  test('a channel that throws counts as a failed delivery: the failure is logged and alert() still resolves', async (t) => {
    const { receiver, sink, send } = await openAlert(t, { channels: TELEGRAM_AND_WEBHOOK, alert: { sendTimeout: '0s' } });
    const result = await send(failureOf('payments'));
    const lines = findLogLines(sink, 'An alert channel failed');

    assert.deepEqual(result, resultOf({
      telegram: { isDelivered: false, reason: 'failed' },
      webhook: { isDelivered: false, reason: 'failed' },
    }));
    assert.deepEqual(lines.map((line) => line.alert.channel).toSorted(), [...TELEGRAM_AND_WEBHOOK].toSorted());
    lines.forEach((line) => assert.equal(line.err.type, 'TypeError'));
    assert.deepEqual(receiver.requests, []);
  });

  test('when nothing reached a channel the suppressed count goes back to its window, and the next delivered message carries it', async (t) => {
    const { receiver, send } = await openAlert(t, { respond: answerOn([2], { status: 503 }) });

    assert.deepEqual(await send(failureOf('payments')), deliveredTo(ALERT_CHANNEL.WEBHOOK));
    assert.deepEqual(await send(failureOf('mail')), THROTTLED_RESULT);
    assert.deepEqual(await send(failureOf('search')), THROTTLED_RESULT);

    await sleep(PAST_WINDOW_MS);

    assert.deepEqual(await send(failureOf('storage')), resultOf({ webhook: { isDelivered: false, reason: 'failed' } }));
    assert.deepEqual(await send(failureOf('queue')), THROTTLED_RESULT);

    await sleep(PAST_WINDOW_MS);

    assert.deepEqual(await send(failureOf('cache')), deliveredTo(ALERT_CHANNEL.WEBHOOK));
    assert.deepEqual(readBodies(receiver, ALERT_CHANNEL.WEBHOOK).map((body) => body.suppressedCount), [0, 2, 3]);
  });

  test('of two alerts of one dedupe key at the same moment in two windows one goes, and the other gives the count of its window back', async (t) => {
    const { receiver, send } = await openAlert(t);

    assert.deepEqual(await Promise.all([send(failureOf('mail')), send(warningOf('mail'))]), [
      deliveredTo(ALERT_CHANNEL.WEBHOOK),
      deliveredTo(ALERT_CHANNEL.WEBHOOK),
    ]);
    assert.deepEqual(await Promise.all([send(failureOf('search')), send(warningOf('search'))]), [THROTTLED_RESULT, THROTTLED_RESULT]);

    await sleep(PAST_WINDOW_MS);

    const raced = await Promise.all([
      send(failureOf('payments')),
      send({ ...failureOf('payments'), throttleClass: THROTTLE_CLASS.WARNING }),
    ]);

    await sleep(PAST_WINDOW_MS);

    const after = await Promise.all([send(failureOf('storage')), send(warningOf('storage'))]);
    const bodies = readBodies(receiver, ALERT_CHANNEL.WEBHOOK);

    assert.equal(raced.filter((result) => result.channels.webhook?.isDelivered).length, 1);
    assert.equal(raced.filter((result) => result.isDeduped).length, 1);
    after.forEach((result) => assert.deepEqual(result, deliveredTo(ALERT_CHANNEL.WEBHOOK)));
    assert.equal(bodies.length, 5);
    assert.deepEqual([sumSuppressed(bodies, THROTTLE_CLASS.FAILURE), sumSuppressed(bodies, THROTTLE_CLASS.WARNING)], [1, 1]);
  });

  test('isSilent sends without a sound in a window of its own, and the public space never goes silent', async (t) => {
    const { receiver, send } = await openAlert(t, { channels: TELEGRAM_AND_WEBHOOK });

    assert.deepEqual(await send({ title: 'Weekly canary', dedupeKey: 'canary:1', isSilent: true }), deliveredTo(...TELEGRAM_AND_WEBHOOK));
    assert.deepEqual(await send(failureOf('payments')), deliveredTo(...TELEGRAM_AND_WEBHOOK));
    assert.deepEqual(await send({ title: 'Weekly canary', dedupeKey: 'canary:2', isSilent: true }), THROTTLED_RESULT);
    assert.deepEqual(await send({ ...failureOf('search'), space: ALERT_SPACE.PUBLIC, isSilent: true }), deliveredTo(...TELEGRAM_AND_WEBHOOK));
    assert.deepEqual(await send({
      ...failureOf('mail'),
      space: ALERT_SPACE.PUBLIC,
      throttleClass: THROTTLE_CLASS.WARNING,
      isSilent: true,
    }), deliveredTo(...TELEGRAM_AND_WEBHOOK));

    const webhook = readBodies(receiver, ALERT_CHANNEL.WEBHOOK);

    assert.deepEqual(readBodies(receiver, ALERT_CHANNEL.TELEGRAM).map((body) => body.disable_notification), [true, false, false, false]);
    assert.deepEqual(webhook.map((body) => body.isSilent), [true, false, false, false]);
    assert.deepEqual(webhook.map((body) => body.throttleClass), [
      THROTTLE_CLASS.SILENT,
      THROTTLE_CLASS.FAILURE,
      THROTTLE_CLASS.FAILURE,
      THROTTLE_CLASS.WARNING,
    ]);
  });

  test('holds for each channel it tried only whether it delivered, and the reason when it did not', async (t) => {
    const answers = {};
    const { receiver, sink, send } = await openAlert(t, {
      channels: Object.values(ALERT_CHANNEL),
      respond: (request) => answers[request.path] ?? answerByDefault(request),
    });

    Object.assign(answers, {
      [receiver.paths.webhook]: { status: 500, body: { error: 'Internal Server Error' } },
      [receiver.paths.slack]: { status: 429, headers: { 'retry-after': '30' }, body: { error: 'rate_limited' } },
      [receiver.paths.discord]: { status: 400, body: { message: 'Cannot send an empty message' } },
    });

    const result = await send(failureOf('payments'));
    const slackLine = findLogLines(sink, NOT_DELIVERED_MESSAGE).find((line) => line.alert.channel === ALERT_CHANNEL.SLACK);

    assert.deepEqual(result, resultOf({
      telegram: { isDelivered: true },
      webhook: { isDelivered: false, reason: 'failed' },
      slack: { isDelivered: false, reason: 'rate-limited' },
      discord: { isDelivered: false, reason: 'rejected-text' },
    }));
    assert.equal(slackLine.alert.status, 429);
    assert.equal(slackLine.alert.retryAfter, 30);
  });

  test('releases the dedupe key when one channel refused the text and another may pass next time: the alert goes out again', async (t) => {
    const { receiver, sink, send } = await openAlert(t, {
      channels: TELEGRAM_AND_WEBHOOK,
      respond: (request) => (request.path.startsWith(BOT_API_PATH_PREFIX) ? TEXT_REFUSAL : { status: 503 }),
    });

    assert.deepEqual(await send(failureOf('payments')), resultOf({
      telegram: { isDelivered: false, reason: 'rejected-text' },
      webhook: { isDelivered: false, reason: 'failed' },
    }));
    assert.deepEqual(findLogLines(sink, NOT_DELIVERED_MESSAGE).map((line) => line.alert.isMarkReleased), [true, true]);

    await sleep(PAST_WINDOW_MS);

    assert.equal((await send(failureOf('payments'))).isDeduped, false);
    assert.equal(readBodies(receiver, ALERT_CHANNEL.WEBHOOK).length, 2);
  });

  test('with isDetached resolves once dedupe and throttle have decided, and its delivery once the channels have answered', async (t) => {
    const { receiver, send } = await openAlert(t, { respond: () => ({ isHanging: true }) });
    const { result: detached, durationMs } = await timeIt(() => send({ ...failureOf('payments'), isDetached: true }));

    assert.equal(detached.isDeduped, false);
    assert.equal(detached.isThrottled, false);
    assert.deepEqual(detached.channels, {});
    assert.ok(durationMs < SEND_TIMEOUT_MS, `${durationMs} ms`);
    assert.deepEqual(await detached.delivery, resultOf({ webhook: { isDelivered: false, reason: 'unreachable' } }));
    assert.equal(receiver.requests.length, 1);
  });

  test('with isDetached gives a held-back alert and a wrong call a delivery as well, resolved with the same result', async (t) => {
    const { send } = await openAlert(t);

    await send(failureOf('payments'));

    const deduped = await send({ ...failureOf('payments'), isDetached: true });
    const wrong = await send({ isDetached: true });

    assert.equal(deduped.isDeduped, true);
    assert.deepEqual(await deduped.delivery, DEDUPED_RESULT);
    assert.deepEqual(await wrong.delivery, EMPTY_RESULT);
  });

  test('with no channel enabled resolves an empty result and touches no state', async (t) => {
    const quiet = await openAlert(t, { channels: [] });
    const results = await Promise.all(Array.from({ length: 3 }, () => quiet.send(failureOf('payments'))));
    const loud = await openAlert(t, { channels: [ALERT_CHANNEL.WEBHOOK], redis: quiet.redis });

    results.forEach((result) => assert.deepEqual(result, EMPTY_RESULT));
    assert.deepEqual(findLogLines(quiet.sink, UNSTARTED_MESSAGE), []);
    assert.deepEqual(await loud.send(failureOf('payments')), deliveredTo(ALERT_CHANNEL.WEBHOOK));
    assert.deepEqual(readBodies(loud.receiver, ALERT_CHANNEL.WEBHOOK).map((body) => body.suppressedCount), [0]);
    assert.equal(findLogLines(loud.sink, UNSTARTED_MESSAGE).length, 1);
  });

  test('with no channel enabled still holds back a public report by dedupe and throttle: its flags tell nothing', async (t) => {
    const quiet = await openAlert(t, { channels: [] });
    const report = { title: 'Frontend error', dedupeKey: 'frontend:first', space: ALERT_SPACE.PUBLIC };
    const first = await quiet.send(report);
    const repeat = await quiet.send(report);
    const other = await quiet.send({ ...report, dedupeKey: 'frontend:other' });

    assert.deepEqual([first, repeat, other], [EMPTY_RESULT, DEDUPED_RESULT, THROTTLED_RESULT]);
    assert.deepEqual(quiet.receiver.requests, []);
  });
});

describe('settleAlerts', () => {
  test('waits for the deliveries whose state lives in the Redis it is given, and for those of no other', async (t) => {
    const hanging = await openAlert(t, { respond: () => ({ isHanging: true }) });
    const other = await openAlert(t);
    const { delivery } = await hanging.send({ ...failureOf('payments'), isDetached: true });
    const { durationMs } = await timeIt(() => settleAlerts(other.redis));
    const beforeItSettles = await Promise.race([delivery, null]);

    assert.equal(await settleAlerts(hanging.redis), true);

    const afterItSettles = await Promise.race([delivery, null]);

    assert.ok(durationMs < SEND_TIMEOUT_MS, `${durationMs} ms`);
    assert.equal(beforeItSettles, null);
    assert.deepEqual(afterItSettles, resultOf({ webhook: { isDelivered: false, reason: 'unreachable' } }));
  });

  test('waits for an alert nobody awaits from its first step, and for one that starts while it waits', async (t) => {
    const { redis, send } = await openAlert(t, { respond: () => ({ isHanging: true }) });
    const first = send(failureOf('payments'));
    const settled = settleAlerts(redis);

    await sleep(SEND_TIMEOUT_MS / 2);

    const second = send(warningOf('mail'));

    await settled;

    assert.deepEqual(await Promise.all([Promise.race([first, null]), Promise.race([second, null])]), [
      resultOf({ webhook: { isDelivered: false, reason: 'unreachable' } }),
      resultOf({ webhook: { isDelivered: false, reason: 'unreachable' } }),
    ]);
  });

  test('waits for the alert a caller starts once the one it awaited has settled', async (t) => {
    const { redis, receiver, send } = await openAlert(t);

    // One function deeper, as the cache plugin stands to its watchdog: a microtask is not enough for it.
    async function sendFirst() {
      return send(failureOf('payments'));
    }

    async function report() {
      await sendFirst();

      return send(warningOf('mail'));
    }

    const reported = report();

    await settleAlerts(redis);

    assert.deepEqual(await Promise.race([reported, null]), deliveredTo(ALERT_CHANNEL.WEBHOOK));
    assert.equal(receiver.requests.length, 2);
  });

  test('is not held by an alert whose steps fail', async (t) => {
    const { redis, send, sink } = await openAlert(t, { alert: { throttleWindow: '0s' } });
    const failing = send(failureOf('payments'));

    assert.equal(await settleAlerts(redis), true);
    assert.deepEqual(await failing, EMPTY_RESULT);
    assert.equal(findLogLines(sink, FAILED_MESSAGE).length, 1);
  });

  test('resolves at once for a Redis with no delivery on its way and for one no alert has used', async (t) => {
    const { redis, send } = await openAlert(t);

    await send(failureOf('payments'));

    assert.deepEqual(await Promise.all([settleAlerts(redis), settleAlerts({})]), [true, true]);
  });
});

describe('assertAlertConfig', () => {
  const VALID = Object.freeze({
    dedupeTtl: '1h',
    throttleWindow: '0.001s',
    suppressedTtl: '1d',
    sendTimeout: '10s',
    memoryMaxEntries: 1,
  });

  test('takes durations of at least a millisecond and a memory of at least one entry', () => {
    assert.equal(assertAlertConfig(VALID), true);
    assert.equal(assertAlertConfig(createTestConfig().alert), true);
  });

  test('refuses a duration nobody can read, one of zero, and a memory without entries', () => {
    const refused = [
      ...['dedupeTtl', 'throttleWindow', 'suppressedTtl', 'sendTimeout'].flatMap((key) => ['0s', '0.0001s', '1 minute', undefined].map((value) => ({ [key]: value }))),
      { memoryMaxEntries: 0 },
      { memoryMaxEntries: '1000' },
    ];

    refused.forEach((section) => {
      assert.throws(() => assertAlertConfig({ ...VALID, ...section }), TypeError, JSON.stringify(section));
    });
    assert.throws(() => assertAlertConfig({ ...VALID, throttleWindow: '0s' }), /config\.alert requires dedupeTtl, throttleWindow, suppressedTtl, sendTimeout to be above zero/);
    assert.throws(() => assertAlertConfig({ ...VALID, memoryMaxEntries: 0 }), /config\.alert requires memoryMaxEntries to be a positive integer/);
  });
});

describe('isAlertReported', () => {
  test('is false for an alert held back by its dedupe key or by its window', () => {
    assert.equal(isAlertReported(DEDUPED_RESULT), false);
    assert.equal(isAlertReported(THROTTLED_RESULT), false);
  });

  test('is false when no channel delivered it', () => {
    assert.equal(isAlertReported(resultOf({
      telegram: { isDelivered: false, reason: 'unreachable' },
      webhook: { isDelivered: false, reason: 'failed' },
    })), false);
  });

  test('is true when one channel delivered it, whatever the others did', () => {
    assert.equal(isAlertReported(resultOf({
      telegram: { isDelivered: false, reason: 'unreachable' },
      webhook: { isDelivered: true },
    })), true);
  });

  test('is true when there was no channel to try', () => {
    assert.equal(isAlertReported(EMPTY_RESULT), true);
  });
});
