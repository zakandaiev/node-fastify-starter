import { createConfig } from '#config/index.js';
import packageData from '#root/package.json' with { type: 'json' };
import { createTestConfig, createTestEnv } from '#root/tests/helper/config.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { convertStringToMs } from '#utils/date.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const REDIS_DURATION_KEYS = ['connectTimeout', 'commandTimeout', 'socketTimeout', 'reconnectStep', 'reconnectMaxDelay'];
const CACHE_DURATION_KEYS = ['defaultTtl', 'outageAlertAfter'];

describe('config.redis', () => {
  test('takes where Redis is and who connects from env, and holds no credentials it was not given', () => {
    const given = createConfig(createTestEnv({
      APP_REDIS_HOST: 'redis.internal',
      APP_REDIS_PORT: '6390',
      APP_REDIS_USER: 'app',
      APP_REDIS_PASSWORD: 'app-password',
    }));
    const anonymous = createConfig(createTestEnv({ APP_REDIS_USER: '', APP_REDIS_PASSWORD: '' }));

    assert.equal(given.redis.host, 'redis.internal');
    assert.equal(given.redis.port, 6390);
    assert.equal(given.redis.username, 'app');
    assert.equal(given.redis.password, 'app-password');
    assert.equal(anonymous.redis.username, null);
    assert.equal(anonymous.redis.password, null);
  });

  test('has no cache Redis of its own without APP_CACHE_REDIS_HOST, and one with it', () => {
    const shared = createConfig(createTestEnv());
    const own = createConfig(createTestEnv({
      APP_CACHE_REDIS_HOST: 'cache.internal',
      APP_CACHE_REDIS_PORT: '6391',
      APP_CACHE_REDIS_PASSWORD: 'cache-password',
    }));

    assert.equal(shared.redis.cache, null);
    assert.deepEqual(own.redis.cache, {
      host: 'cache.internal',
      port: 6391,
      username: null,
      password: 'cache-password',
    });
  });

  test('prefixes the keys with the name of the app and the name of its database', () => {
    const { redis } = createConfig(createTestEnv({ APP_DATABASE_NAME: 'shop' }));

    assert.equal(redis.keyPrefix, `${packageData.name}:shop:`);
  });

  test('keeps the durations in the code, as text with a unit, a command failing by its own deadline before the socket', () => {
    const { redis, cache } = createConfig(createTestEnv());

    REDIS_DURATION_KEYS.forEach((key) => assert.ok(convertStringToMs(redis[key]) > 0, key));
    CACHE_DURATION_KEYS.forEach((key) => assert.ok(convertStringToMs(cache[key]) > 0, key));
    assert.ok(convertStringToMs(redis.socketTimeout) >= convertStringToMs(redis.commandTimeout));
    assert.ok(convertStringToMs(redis.reconnectStep) <= convertStringToMs(redis.reconnectMaxDelay));
  });

  test('is frozen, and a test replaces one value of it', () => {
    const { redis, cache } = createConfig(createTestEnv());
    const overridden = createTestConfig({ redis: { commandTimeout: '0.2s' }, cache: { defaultTtl: '1s' } });

    assert.ok(isDeepFrozen(redis));
    assert.ok(isDeepFrozen(cache));
    assert.equal(overridden.redis.commandTimeout, '0.2s');
    assert.equal(overridden.redis.socketTimeout, redis.socketTimeout);
    assert.equal(overridden.cache.defaultTtl, '1s');
    assert.equal(overridden.cache.outageAlertAfter, cache.outageAlertAfter);
  });
});
