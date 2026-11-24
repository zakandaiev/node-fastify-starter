import { alert } from '#core/alert/index.js';
import { isDeduped } from '#core/alert/state.js';
import { runInContext } from '#core/context/index.js';
import { ALERT_CHANNEL } from '#enums/alert-channel.js';
import { ALERT_SPACE } from '#enums/alert-space.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import {
  answerByDefault,
  answerOn,
  createAlertReceiver,
  failureOf,
  sumSuppressed,
  warningOf,
} from '#root/tests/helper/alert.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import {
  createAclUser,
  createTestRedis,
  FAST_RECONNECT,
  scanKeys,
  toScanPattern,
  waitUntilReady,
} from '#root/tests/helper/redis.js';
import { convertStringToMs } from '#utils/date.js';
import { sha256 } from '#utils/hash.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const testRedis = await createTestRedis();

const SHORT_WINDOWS = Object.freeze({ throttleWindow: '0.2s', dedupeTtl: '1h', sendTimeout: '0.3s' });
const PAST_WINDOW_MS = 400;

// Long enough that a slot taken a moment ago is still there when the test reads it.
const LONG_WINDOW = '1s';
const PAST_LONG_WINDOW_MS = 1300;

const TTL_SLACK_MS = 5000;
const BURST = 10;

// Reads only: every write of the state is refused with NOPERM. INFO is there for the ready check of ioredis.
const READ_ONLY_RULES = Object.freeze(['+@read', '+info']);

const WRITE_FAILED_MESSAGE = 'Alert could not set its dedupe mark: memory holds it';
const READ_FAILED_MESSAGE = 'Alert could not read its dedupe mark: memory decides';

const DEDUPED_RESULT = Object.freeze({ isDeduped: true, isThrottled: false, channels: {} });
const THROTTLED_RESULT = Object.freeze({ isDeduped: false, isThrottled: true, channels: {} });
const DELIVERED_RESULT = Object.freeze({ isDeduped: false, isThrottled: false, channels: { webhook: { isDelivered: true } } });

function toDedupeName(space, dedupeKey) {
  return `alert:dedupe:${space}:${sha256(dedupeKey)}`;
}

function toWindowName(namespace, space, throttleClass = THROTTLE_CLASS.FAILURE) {
  return `alert:${namespace}:${space}:${throttleClass}`;
}

function isDelivered(result) {
  return result.channels[ALERT_CHANNEL.WEBHOOK]?.isDelivered === true;
}

// What is left of the TTL of each key under the prefix, by its name after the prefix: -1 is a key without one.
async function readTtls(keyPrefix) {
  const keys = await scanKeys(testRedis.admin, toScanPattern(keyPrefix));
  const ttls = await Promise.all(keys.map((key) => testRedis.admin.pttl(key)));

  return Object.fromEntries(keys.map((key, index) => [key.slice(keyPrefix.length), ttls[index]]));
}

// The range the TTL of each kind of key must fall in, above the first bound and up to the second.
function readTtlRanges(alertConfig) {
  const dedupeTtlMs = convertStringToMs(alertConfig.dedupeTtl);
  const suppressedTtlMs = convertStringToMs(alertConfig.suppressedTtl);

  return {
    mark: [dedupeTtlMs - TTL_SLACK_MS, dedupeTtlMs],
    slot: [0, convertStringToMs(alertConfig.throttleWindow)],
    count: [suppressedTtlMs - TTL_SLACK_MS, suppressedTtlMs],
  };
}

function assertTtls(ttls, expected) {
  assert.deepEqual(Object.keys(ttls).toSorted(), Object.keys(expected).toSorted());
  Object.entries(expected).forEach(([name, [above, upTo]]) => {
    assert.ok(ttls[name] > above && ttls[name] <= upTo, `${name} has a TTL of ${ttls[name]} ms, expected (${above}, ${upTo}]`);
  });
}

function openInstance(t, scope, index) {
  const sink = createLogSink();
  const opened = testRedis.open({
    env: { ...scope.receiver.env.webhook, ...scope.env },
    redis: { keyPrefix: scope.keyPrefix },
    alert: { ...SHORT_WINDOWS, ...scope.receiver.config.alert, ...scope.alertSection },
    logger: { level: 'debug', stream: sink.stream },
  }, { label: `Alert Redis ${index + 1}` });

  t.after(() => opened.redis.close());

  function send(options) {
    return opened.run(() => alert(options));
  }

  return { ...opened, sink, send };
}

// Processes of one app on one Redis, each with a client of its own. Their keys go under a prefix of the test inside
// the file's: the windows of one test are not those of the next.
async function openInstances(t, {
  count = 2,
  env = {},
  alert: alertSection = {},
  respond = answerByDefault,
} = {}) {
  const receiver = await createAlertReceiver(t, respond);
  const scope = {
    receiver,
    keyPrefix: `${testRedis.keyPrefix}${uuidv7()}:`,
    env,
    alertSection,
  };
  const instances = Array.from({ length: count }, (_, index) => openInstance(t, scope, index));

  await Promise.all(instances.map((instance) => waitUntilReady(instance.redis)));

  return { receiver, keyPrefix: scope.keyPrefix, instances };
}

describe('alert on a Redis shared by processes', { skip: testRedis.skip }, () => {
  test('a message sent through one process throttles the other, and its dedupe mark holds the same alert back there', async (t) => {
    const { receiver, instances: [first, second] } = await openInstances(t);

    assert.deepEqual(await first.send(failureOf('payments')), DELIVERED_RESULT);
    assert.deepEqual(await second.send(failureOf('mail')), THROTTLED_RESULT);
    assert.deepEqual(await second.send(failureOf('payments')), DEDUPED_RESULT);

    await sleep(PAST_WINDOW_MS);

    assert.deepEqual(await second.send(failureOf('payments')), DEDUPED_RESULT);
    assert.equal(receiver.requests.length, 1);
  });

  test('the count one process suppressed is carried by the next message of the other', async (t) => {
    const { receiver, instances: [first, second] } = await openInstances(t);

    assert.deepEqual(await first.send(failureOf('payments')), DELIVERED_RESULT);
    assert.deepEqual(await Promise.all([second.send(failureOf('mail')), second.send(failureOf('search'))]), [THROTTLED_RESULT, THROTTLED_RESULT]);

    await sleep(PAST_WINDOW_MS);

    assert.deepEqual(await first.send(failureOf('storage')), DELIVERED_RESULT);
    assert.deepEqual(receiver.requests.map((request) => request.body.suppressedCount), [0, 2]);
  });

  test('identical alerts at the same moment from two processes give exactly one message', async (t) => {
    const { receiver, instances } = await openInstances(t);
    const results = await Promise.all(instances.flatMap((instance) => Array.from({ length: BURST }, () => instance.send(failureOf('payments')))));

    assert.equal(results.filter((result) => isDelivered(result)).length, 1);
    assert.equal(results.filter((result) => result.isDeduped || result.isThrottled).length, results.length - 1);
    assert.equal(receiver.requests.length, 1);
  });

  test('of two alerts of one dedupe key that pass two windows at the same moment in two processes one goes, and no suppressed count is lost', async (t) => {
    const { receiver, instances: [first, second] } = await openInstances(t);

    assert.deepEqual(await Promise.all([first.send(failureOf('mail')), second.send(warningOf('mail'))]), [DELIVERED_RESULT, DELIVERED_RESULT]);
    assert.deepEqual(await Promise.all([second.send(failureOf('search')), first.send(warningOf('search'))]), [THROTTLED_RESULT, THROTTLED_RESULT]);

    await sleep(PAST_WINDOW_MS);

    const raced = await Promise.all([
      first.send(failureOf('payments')),
      second.send({ ...failureOf('payments'), throttleClass: THROTTLE_CLASS.WARNING }),
    ]);

    await sleep(PAST_WINDOW_MS);

    const after = await Promise.all([second.send(failureOf('storage')), first.send(warningOf('storage'))]);

    assert.equal(raced.filter((result) => isDelivered(result)).length, 1);
    assert.equal(raced.filter((result) => result.isDeduped).length, 1);
    assert.deepEqual(after, [DELIVERED_RESULT, DELIVERED_RESULT]);
    assert.equal(receiver.requests.length, 5);
    assert.deepEqual([sumSuppressed(receiver.requests.map((request) => request.body), THROTTLE_CLASS.FAILURE), sumSuppressed(receiver.requests.map((request) => request.body), THROTTLE_CLASS.WARNING)], [1, 1]);
  });

  test('every key it writes lives under the prefix of the app and has a TTL, and no key names the dedupe key itself', async (t) => {
    const { keyPrefix, instances: [instance] } = await openInstances(t, {
      count: 1,
      alert: { throttleWindow: LONG_WINDOW },
      respond: answerOn([2], { status: 503 }),
    });
    const { mark, slot, count } = readTtlRanges(instance.config.alert);
    const marker = uuidv7();
    const payments = { title: 'Payments down', dedupeKey: `upstream:payments:${marker}` };
    const report = { title: 'A page failed', dedupeKey: `report:${marker}`, space: ALERT_SPACE.PUBLIC };
    const paymentsMark = toDedupeName(ALERT_SPACE.INTERNAL, payments.dedupeKey);
    const reportMark = toDedupeName(ALERT_SPACE.PUBLIC, report.dedupeKey);
    const internalSlot = toWindowName('throttle', ALERT_SPACE.INTERNAL);
    const publicSlot = toWindowName('throttle', ALERT_SPACE.PUBLIC);
    const internalCount = toWindowName('suppressed', ALERT_SPACE.INTERNAL);

    assert.deepEqual(await instance.send(payments), DELIVERED_RESULT);
    assertTtls(await readTtls(keyPrefix), { [paymentsMark]: mark, [internalSlot]: slot });

    assert.deepEqual(await instance.send(failureOf('mail')), THROTTLED_RESULT);
    assertTtls(await readTtls(keyPrefix), { [paymentsMark]: mark, [internalSlot]: slot, [internalCount]: count });

    await sleep(PAST_LONG_WINDOW_MS);

    assert.equal(isDelivered(await instance.send(failureOf('search'))), false);
    assertTtls(await readTtls(keyPrefix), { [paymentsMark]: mark, [internalSlot]: slot, [internalCount]: count });
    assert.equal(await testRedis.admin.get(`${keyPrefix}${internalCount}`), '1');

    assert.deepEqual(await instance.send(report), DELIVERED_RESULT);
    assertTtls(await readTtls(keyPrefix), {
      [paymentsMark]: mark,
      [reportMark]: mark,
      [internalSlot]: slot,
      [publicSlot]: slot,
      [internalCount]: count,
    });

    assert.deepEqual(await scanKeys(testRedis.admin, `*${sha256(payments.dedupeKey)}*`), [`${keyPrefix}${paymentsMark}`]);
    assert.deepEqual(await scanKeys(testRedis.admin, `*${marker}*`), []);
  });

  test('a Redis that refuses writes and answers reads still dedupes: the mark goes to memory and isDeduped reads it', async (t) => {
    const account = await createAclUser(testRedis.admin, READ_ONLY_RULES);
    const { receiver, keyPrefix, instances: [instance] } = await openInstances(t, { count: 1, env: account.env });
    const options = failureOf('payments');

    t.after(async () => {
      await instance.redis.close();
      await account.remove();
    });

    assert.deepEqual(await instance.send(options), DELIVERED_RESULT);
    assert.equal(await isDeduped({ redis: instance.redis, space: ALERT_SPACE.INTERNAL, dedupeKey: options.dedupeKey }), true);

    await sleep(PAST_WINDOW_MS);

    const [writeFailure] = findLogLines(instance.sink, WRITE_FAILED_MESSAGE);

    assert.deepEqual(await instance.send(options), DEDUPED_RESULT);
    assert.equal(receiver.requests.length, 1);
    assert.match(writeFailure.err.message, /NOPERM/);
    assert.deepEqual(findLogLines(instance.sink, READ_FAILED_MESSAGE), []);
    assert.deepEqual(await scanKeys(testRedis.admin, toScanPattern(keyPrefix)), []);
  });
});

describe('alert in an app that closes', { skip: testRedis.skip }, () => {
  async function openApp(receiver, keyPrefix) {
    const fastify = await buildTestApp({
      env: receiver.env.webhook,
      redis: { ...FAST_RECONNECT, keyPrefix },
      alert: { ...SHORT_WINDOWS, ...receiver.config.alert },
    });

    fastify.redis.connect();
    await waitUntilReady(fastify.redis);

    return fastify;
  }

  // As the onError hook calls it: nobody awaits it, and the app closes while its first command is on its way.
  test('an alert whose steps still run keeps its state in Redis, so the instances that stop together send one message', async (t) => {
    const receiver = await createAlertReceiver(t);
    const keyPrefix = `${testRedis.keyPrefix}${uuidv7()}:`;
    const options = failureOf('payments');
    const apps = await Promise.all([openApp(receiver, keyPrefix), openApp(receiver, keyPrefix)]);
    const alerts = apps.map((fastify) => runInContext(fastify.context, () => alert(options)));

    await Promise.all(apps.map((fastify) => fastify.close()));

    const results = await Promise.all(alerts);

    assert.equal(results.filter((result) => isDelivered(result)).length, 1);
    assert.equal(receiver.requests.length, 1);
    assert.equal(await testRedis.admin.exists(`${keyPrefix}${toDedupeName(ALERT_SPACE.INTERNAL, options.dedupeKey)}`), 1);
  });

  // The restart of a crash loop would find the mark of the alert that never went out, and stay silent for dedupeTtl.
  test('a delivery that fails while the app closes gives its dedupe mark back: Redis closes after it', async (t) => {
    const receiver = await createAlertReceiver(t, () => ({ isHanging: true }));
    const keyPrefix = `${testRedis.keyPrefix}${uuidv7()}:`;
    const options = failureOf('payments');
    const fastify = await openApp(receiver, keyPrefix);
    const pending = await runInContext(fastify.context, () => alert({ ...options, isDetached: true }));

    await fastify.close();

    const outcome = await pending.delivery;

    assert.equal(outcome.channels[ALERT_CHANNEL.WEBHOOK].reason, 'unreachable');
    assert.equal(await testRedis.admin.exists(`${keyPrefix}${toDedupeName(ALERT_SPACE.INTERNAL, options.dedupeKey)}`), 0);
  });
});
