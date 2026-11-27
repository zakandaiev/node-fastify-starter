import { createConfig } from '#config/index.js';
import { createTestConfig, createTestEnv } from '#root/tests/helper/config.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { convertStringToWholeSeconds } from '#utils/date.js';
import { readRequestOrigin } from '#utils/header.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function buildConfig(env) {
  return createConfig(createTestEnv(env));
}

function readError(env) {
  try {
    buildConfig(env);
  } catch (error) {
    return error.message;
  }

  return '';
}

describe('config.cors', () => {
  test('allows the origin of the app alone without APP_CORS_ORIGINS, in lower case and frozen', () => {
    const { cors } = buildConfig({ APP_HOST: 'App.Example.COM:8443' });

    assert.deepEqual(cors.allowedOrigins, ['https://app.example.com:8443']);
    assert.deepEqual(createTestConfig().cors.allowedOrigins, ['https://app.test']);
    assert.ok(isDeepFrozen(cors));
  });

  test('allows the Origin a browser sends from the address of the app, a default port written in APP_HOST included', () => {
    [
      { APP_PROTOCOL: 'https', APP_HOST: 'App.Example.COM' },
      { APP_PROTOCOL: 'https', APP_HOST: 'app.example.com:8443' },
      { APP_PROTOCOL: 'https', APP_HOST: 'app.example.com:443' },
      { APP_PROTOCOL: 'http', APP_HOST: 'localhost:80' },
    ].forEach((env) => {
      const { app, cors } = buildConfig(env);
      const origin = readRequestOrigin({ origin: app.url });

      assert.ok(cors.allowedOrigins.includes(origin), `Origin ${app.url} reads as "${origin}", not in ${JSON.stringify(cors.allowedOrigins)}`);
    });
  });

  test('adds the origins of APP_CORS_ORIGINS as a browser writes them, once each, after that of the app', () => {
    const { cors } = buildConfig({
      APP_PROTOCOL: 'http',
      APP_HOST: 'localhost:4173',
      APP_CORS_ORIGINS: ' HTTP://Localhost:5173/ , https://admin.example.com:443,http://localhost:4173,, http://[::1]:5173',
    });

    assert.deepEqual(cors.allowedOrigins, [
      'http://localhost:4173',
      'http://localhost:5173',
      'https://admin.example.com',
      'http://[::1]:5173',
    ]);
  });

  test('refuses an item of APP_CORS_ORIGINS that is no origin: a path, a query, a fragment, credentials, another scheme, a bare host', () => {
    [
      'http://localhost:5173/app',
      'http://localhost:5173/?a=1',
      'http://localhost:5173/#top',
      'http://user:pass@localhost:5173',
      'ftp://localhost:5173',
      'localhost:5173',
      'https://app.example.com, null',
    ].forEach((value) => {
      assert.match(readError({ APP_CORS_ORIGINS: value }), /APP_CORS_ORIGINS must match format "origin-list"/, value);
    });
  });

  test('gives a preflight a lifetime of whole seconds above zero', () => {
    assert.ok(convertStringToWholeSeconds(buildConfig().cors.preflightMaxAge) > 0);
  });
});
