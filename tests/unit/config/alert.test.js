import { createConfig } from '#config/index.js';
import { TELEGRAM_TEST_ENV } from '#root/tests/helper/alert.js';
import { createTestConfig, createTestEnv } from '#root/tests/helper/config.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { convertStringToMs } from '#utils/date.js';
import { readOriginHost } from '#utils/header.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const NO_CHANNELS = Object.freeze({
  telegram: null,
  webhook: null,
  slack: null,
  discord: null,
});
const TELEGRAM_CHANNEL = Object.freeze({
  botToken: TELEGRAM_TEST_ENV.APP_ALERT_TELEGRAM_BOT_TOKEN,
  chatId: TELEGRAM_TEST_ENV.APP_ALERT_TELEGRAM_CHAT_ID,
});

// Never sent anywhere: a config test only reads them.
const WEBHOOK_ENV = Object.freeze({
  APP_ALERT_WEBHOOK_URL: 'https://alerts.example.com/webhook',
  APP_ALERT_SLACK_URL: 'https://alerts.example.com/slack',
  APP_ALERT_DISCORD_URL: 'https://alerts.example.com/discord',
});

const ALERT_DURATION_KEYS = ['dedupeTtl', 'throttleWindow', 'suppressedTtl', 'sendTimeout'];
const INTAKE_BODY_LIMIT = 64 * 1024;

function buildConfig(env) {
  return createConfig(createTestEnv(env));
}

function assertPositiveInteger(value, name) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} is ${value}`);
}

describe('config.alert', () => {
  test('has every channel off without its settings', () => {
    assert.deepEqual(buildConfig().alert.channels, NO_CHANNELS);
    assert.deepEqual(createTestConfig().alert.channels, NO_CHANNELS);
  });

  test('turns Telegram on with the token of the bot and the id of the chat, and no other channel with it', () => {
    assert.deepEqual(buildConfig(TELEGRAM_TEST_ENV).alert.channels, { ...NO_CHANNELS, telegram: TELEGRAM_CHANNEL });
  });

  test('turns a webhook, Slack and Discord on with their addresses, several channels at once', () => {
    const { channels } = buildConfig({ ...TELEGRAM_TEST_ENV, ...WEBHOOK_ENV }).alert;

    assert.deepEqual(channels, {
      telegram: TELEGRAM_CHANNEL,
      webhook: { url: WEBHOOK_ENV.APP_ALERT_WEBHOOK_URL },
      slack: { url: WEBHOOK_ENV.APP_ALERT_SLACK_URL },
      discord: { url: WEBHOOK_ENV.APP_ALERT_DISCORD_URL },
    });
    assert.ok(isDeepFrozen(channels));
  });

  test('has no key for POST /log/error without APP_LOG_API_KEY, and the one it is given', () => {
    assert.equal(buildConfig().alert.logApiKey, null);
    assert.equal(buildConfig({ APP_LOG_API_KEY: 'shared-log-key' }).alert.logApiKey, 'shared-log-key');
  });

  test('keeps its durations as text with a unit, each above zero, and holds a positive number of entries in memory', () => {
    const { alert } = buildConfig();

    ALERT_DURATION_KEYS.forEach((key) => assert.ok(convertStringToMs(alert[key]) > 0, key));
    assertPositiveInteger(alert.memoryMaxEntries, 'memoryMaxEntries');
  });

  test('reads a body of up to 64 KiB at POST /log/error', () => {
    assert.equal(buildConfig().alert.intake.bodyLimit, INTAKE_BODY_LIMIT);
  });

  test('leaves a failing process time to shut down after its alert: a channel is waited for less than the shutdown may take', () => {
    const { alert, app } = buildConfig();

    assert.ok(convertStringToMs(alert.sendTimeout) < convertStringToMs(app.fatalShutdownTimeout));
  });
});

describe('config.http', () => {
  test('keeps its timeouts as text with a unit above zero and its ceilings as positive integers', () => {
    const { http } = buildConfig();

    [http.timeout, http.external.timeout].forEach((value) => assert.ok(convertStringToMs(value) > 0, value));
    assertPositiveInteger(http.maxResponseBytes, 'maxResponseBytes');
    assertPositiveInteger(http.errorBodyMaxLength, 'errorBodyMaxLength');
    assertPositiveInteger(http.echoMinLength, 'echoMinLength');
    assertPositiveInteger(http.external.maxBytes, 'external.maxBytes');
    assertPositiveInteger(http.external.maxRedirects, 'external.maxRedirects');
  });

  test('lets an external fetch reach no private network', () => {
    const { external } = buildConfig().http;

    assert.deepEqual(external.allowedPrivateNetworks, []);
    assert.ok(Object.isFrozen(external.allowedPrivateNetworks));
  });
});

describe('config.app', () => {
  test('allows browser requests from APP_HOST alone, in lower case', () => {
    assert.deepEqual(buildConfig({ APP_HOST: 'App.Example.COM:8443' }).app.allowedHosts, ['app.example.com:8443']);
    assert.deepEqual(createTestConfig().app.allowedHosts, ['app.test']);
  });

  test('allows the Origin a browser sends from the address of the app, a default port written in APP_HOST included', () => {
    [
      { APP_PROTOCOL: 'https', APP_HOST: 'App.Example.COM' },
      { APP_PROTOCOL: 'https', APP_HOST: 'app.example.com:8443' },
      { APP_PROTOCOL: 'https', APP_HOST: 'app.example.com:443' },
      { APP_PROTOCOL: 'http', APP_HOST: 'localhost:80' },
    ].forEach((env) => {
      const { app } = buildConfig(env);
      const host = readOriginHost({ origin: app.url });

      assert.ok(app.allowedHosts.includes(host), `Origin ${app.url} reads as "${host}", not in ${JSON.stringify(app.allowedHosts)}`);
    });
  });

  test('gives a failing process a shutdown timeout above zero', () => {
    assert.ok(convertStringToMs(buildConfig().app.fatalShutdownTimeout) > 0);
  });
});
