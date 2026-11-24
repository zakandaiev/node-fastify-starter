import { createAlertReceiver } from '#root/tests/helper/alert.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createTestRedis, FAST_RECONNECT, waitUntilReady } from '#root/tests/helper/redis.js';
import { convertStringToMs } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const OUTAGE_TITLE = 'Cache Redis is down';

// Nothing listens on port 1: a cache Redis that stays down.
const CACHE_REDIS_DOWN_ENV = Object.freeze({ APP_CACHE_REDIS_HOST: '127.0.0.1', APP_CACHE_REDIS_PORT: '1' });

const OUTAGE_ALERT_AFTER = '0.3s';

// The key of the alert names the stretch a process noticed the outage in: far from both ends of one, two clients that
// connect a few milliseconds apart notice it in the same.
const STRETCH_MS = convertStringToMs(OUTAGE_ALERT_AFTER);
const STRETCH_START_MS = 20;
const STRETCH_END_MS = 150;

// A dedupe mark that ends long before the outage does: a watchdog that took a dedupe hit for a failure would try
// again and send the same outage a second time once the mark is gone.
const SHORT_DEDUPE = Object.freeze({ dedupeTtl: '1s', throttleWindow: '0.2s' });
const OUTLASTING_MS = 2500;

const testRedis = await createTestRedis();

async function openApp(t, { receiver, keyPrefix }) {
  const fastify = await buildTestApp({
    env: { ...CACHE_REDIS_DOWN_ENV, ...receiver.env.webhook },
    redis: { ...FAST_RECONNECT, keyPrefix },
    cache: { outageAlertAfter: OUTAGE_ALERT_AFTER },
    alert: { ...SHORT_DEDUPE, ...receiver.config.alert },
  });

  t.after(() => fastify.close());
  fastify.redis.connect();
  await waitUntilReady(fastify.redis);

  return fastify;
}

async function waitInsideStretch() {
  const phase = Date.now() % STRETCH_MS;

  if (phase >= STRETCH_START_MS && phase <= STRETCH_END_MS) {
    return true;
  }

  await sleep((STRETCH_MS - phase + STRETCH_START_MS) % STRETCH_MS);

  return waitInsideStretch();
}

describe('cache plugin on a Redis shared by processes', { skip: testRedis.skip }, () => {
  test('sends one alert for one outage of the cache Redis that two processes see, also once the dedupe mark is gone', async (t) => {
    const receiver = await createAlertReceiver(t);
    const keyPrefix = `${testRedis.keyPrefix}${uuidv7()}:`;

    const apps = await Promise.all([openApp(t, { receiver, keyPrefix }), openApp(t, { receiver, keyPrefix })]);

    await waitInsideStretch();
    apps.forEach((fastify) => fastify.cacheRedis.connect());
    await sleep(OUTLASTING_MS);

    assert.deepEqual(receiver.requests.map((request) => request.body.title), [OUTAGE_TITLE]);
  });
});
