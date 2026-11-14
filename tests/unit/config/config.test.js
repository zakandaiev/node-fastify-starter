import { createConfig } from '#config/index.js';
import packageData from '#root/package.json' with { type: 'json' };
import { createTestConfig, createTestEnv } from '#root/tests/helper/config.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('createConfig', () => {
  test('requires the result of initEnv', () => {
    assert.throws(() => createConfig(), TypeError);
    assert.throws(() => createConfig({}), TypeError);
  });

  test('returns a frozen tree', () => {
    const config = createConfig(createTestEnv());

    assert.ok(isDeepFrozen(config));
    assert.throws(() => { config.app.mode = 'dev'; }, TypeError);
  });

  test('carries the app version and name from package.json', () => {
    const config = createConfig(createTestEnv());

    assert.equal(config.app.version, packageData.version);
    assert.equal(config.app.name, packageData.name);
  });

  test('derives the mode flags and the public url from env', () => {
    const prod = createConfig(createTestEnv({ APP_MODE: 'prod', APP_PROTOCOL: 'https', APP_HOST: 'example.com' }));
    const dev = createConfig(createTestEnv({ APP_MODE: 'dev', APP_PROTOCOL: 'http', APP_HOST: '127.0.0.1:4173' }));

    assert.equal(prod.app.isDev, false);
    assert.equal(prod.logger.isPretty, false);
    assert.equal(prod.app.url, 'https://example.com');

    assert.equal(dev.app.isDev, true);
    assert.equal(dev.logger.isPretty, true);
    assert.equal(dev.app.url, 'http://127.0.0.1:4173');
  });

  test('listens on loopback by default', () => {
    const config = createConfig(createTestEnv());

    assert.equal(config.app.listen.host, '127.0.0.1');
    assert.equal(Number.isInteger(config.app.listen.port), true);
  });
});

describe('createTestConfig', () => {
  test('is silent and valid without any .env', () => {
    const config = createTestConfig();

    assert.equal(config.logger.level, 'silent');
    assert.equal(config.logger.isPretty, false);
    assert.equal(config.app.mode, 'prod');
  });

  test('applies env overrides before the config is built and section overrides after', () => {
    const config = createTestConfig({ env: { APP_MODE: 'dev' }, app: { bodyLimit: 10 } });

    assert.equal(config.app.isDev, true);
    assert.equal(config.app.bodyLimit, 10);
    assert.equal(config.logger.isPretty, false);
    assert.ok(isDeepFrozen(config));
  });

  test('merges a section over the defaults of the tests key by key: a log level does not bring the pretty output back', () => {
    const stream = { write() {} };
    const config = createTestConfig({ env: { APP_MODE: 'dev' }, logger: { level: 'info', stream } });

    assert.equal(config.logger.level, 'info');
    assert.equal(config.logger.isPretty, false);
    assert.equal(config.logger.stream, stream);
  });

  test('replaces a nested object of a section whole and still returns a frozen tree', () => {
    const config = createTestConfig({ app: { validation: { maxErrors: 5 } } });

    assert.deepEqual(config.app.validation, { maxErrors: 5 });
    assert.ok(isDeepFrozen(config));
  });

  test('rejects a section the config does not have', () => {
    assert.throws(() => createTestConfig({ unknown: {} }), /no "unknown" section/);
  });
});
