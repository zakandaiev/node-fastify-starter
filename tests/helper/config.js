import { parseEnv, readEnv } from '#config/env.js';
import { createConfig } from '#config/index.js';
import { freezeDeep } from '#utils/object.js';

// Addresses of the local wdt modules; a real environment (.env, CI) overrides them.
const SERVICE_ENV = Object.freeze({
  APP_DATABASE_HOST: '127.0.0.1',
  APP_DATABASE_PORT: '3307',
  APP_DATABASE_USER: 'root',
  APP_DATABASE_PASSWORD: 'root',
  APP_REDIS_HOST: '127.0.0.1',
  APP_REDIS_PORT: '6380',
  APP_REDIS_USER: 'admin',
  APP_REDIS_PASSWORD: 'admin',
});

export const TEST_ENV = Object.freeze({
  APP_HOST: 'app.test',
  APP_DATABASE_NAME: 'nfs_test',
  APP_JWT_ACCESS_SECRET: 'test-access-secret-0123456789-abcdef',
  APP_JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789-abcdef',
  ...SERVICE_ENV,
});

const TEST_CONFIG = Object.freeze({
  logger: { level: 'silent', isPretty: false },
});

function readServiceEnv() {
  const env = readEnv();

  return Object.fromEntries(
    Object.keys(SERVICE_ENV)
      .filter((key) => env[key])
      .map((key) => [key, env[key]]),
  );
}

export function createTestEnv(overrides = {}) {
  return parseEnv({
    ...TEST_ENV,
    ...readServiceEnv(),
    ...overrides,
  });
}

// A section is merged key by key over the defaults of the tests: an override of the log level
// must not bring back the pretty output of the dev config. One level only: a nested object of a section,
// such as app.validation, is replaced whole.
export function createTestConfig({ env = {}, ...sections } = {}) {
  const config = createConfig(createTestEnv(env));
  const names = [...new Set([...Object.keys(TEST_CONFIG), ...Object.keys(sections)])];
  const unknownName = names.find((name) => !Object.hasOwn(config, name));

  if (unknownName) {
    throw new Error(`createTestConfig(): config has no "${unknownName}" section`);
  }

  return freezeDeep({
    ...config,
    ...Object.fromEntries(
      names.map((name) => [name, { ...config[name], ...TEST_CONFIG[name], ...sections[name] }]),
    ),
  });
}
