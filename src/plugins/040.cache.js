import { alert, isAlertReported } from '#core/alert/index.js';
import { watchCacheOutage } from '#core/cache/index.js';
import { runInContext } from '#core/context/index.js';
import { convertStringToMs, nowUtc } from '#utils/date.js';
import fp from 'fastify-plugin';

const SHARED_MESSAGE = 'Cache lives in the main Redis: it must run with noeviction and memory to spare';
const OWN_MESSAGE = 'Cache uses a Redis of its own';
const OUTAGE_TEXT = 'The cache is off and reads go to the database';

const OUTAGE_KEY = 'cache-redis-down';
const RECOVERY_KEY = 'cache-redis-back';
const KEY_SEPARATOR = ':';

// An outage is named by the stretch of time this process noticed it in: the processes that notice it in the same one
// send one alert while the main Redis keeps the marks, and a later outage is a new one. A process that notices it
// later (a Redis that hangs, no traffic, a start during the outage) sends its own.
function readOutageKey(prefix, redis, outage, stretchMs) {
  return [prefix, redis.address, Math.floor((nowUtc().getTime() - outage.downMs) / stretchMs)].join(KEY_SEPARATOR);
}

// false sends the watchdog back for another try later: the alert was throttled or reached none of the channels
// it tried. A dedupe hit is this very outage already reported, by this process or another one.
async function reportOutage(fastify, redis, outage, stretchMs) {
  fastify.log.warn({ cache: outage }, `${redis.label} is down: the cache is off and reads go to the database`);

  const result = await alert({
    title: `${redis.label} is down`,
    dedupeKey: readOutageKey(OUTAGE_KEY, redis, outage, stretchMs),
    error: { message: OUTAGE_TEXT, ...outage },
  });

  return result.isDeduped || isAlertReported(result);
}

async function reportRecovery(fastify, redis, outage, stretchMs) {
  fastify.log.info({ cache: outage }, `${redis.label} is back after a reported outage`);

  await alert({
    title: `${redis.label} is back`,
    dedupeKey: readOutageKey(RECOVERY_KEY, redis, outage, stretchMs),
    error: outage,
    isSilent: true,
  });

  return true;
}

// One line at the start says where the cache lives. Its Redis is watched in both cases: an outage takes no request
// down, so nothing else would tell of it. The reports run in the context of the app as it is when they fire,
// with the services of the later plugins in it.
async function useCache(fastify) {
  const { redis, cacheRedis, config } = fastify;

  fastify.log.info({ cache: { redis: cacheRedis.address } }, cacheRedis === redis
    ? SHARED_MESSAGE
    : OWN_MESSAGE);

  const stretchMs = convertStringToMs(config.cache.outageAlertAfter);
  const watchdog = watchCacheOutage(cacheRedis, {
    after: config.cache.outageAlertAfter,
    log: fastify.log,
    onOutage: (outage) => runInContext(fastify.context, () => reportOutage(fastify, cacheRedis, outage, stretchMs)),
    onRecovery: (outage) => runInContext(fastify.context, () => reportRecovery(fastify, cacheRedis, outage, stretchMs)),
  });

  fastify.addHook('onClose', () => watchdog.stop());
}

export default fp(useCache, { name: 'cache' });
