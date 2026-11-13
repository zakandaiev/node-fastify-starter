import { ENV_SCHEMA, isCi, parseEnv } from '#config/env.js';
import { resolvePath } from '#config/path.js';
import packageData from '#root/package.json' with { type: 'json' };
import { TEST_ENV, createTestEnv } from '#root/tests/helper/config.js';
import { createWorkDir, runNode } from '#root/tests/helper/process.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { describe, test } from 'node:test';

const PRINT_ENV = 'tests/fixture/print-env.js';
const SECRET = 'a'.repeat(32);
const TOO_SHORT = 'must be at least 32 characters long: generate it with "npm run keygen"';

function getErrorLines(values) {
  try {
    parseEnv(values);
  } catch (error) {
    return error.message.split('\n');
  }

  return [];
}

describe('parseEnv', () => {
  test('returns a frozen object with defaults and coerced types', () => {
    const env = parseEnv(TEST_ENV);

    assert.ok(Object.isFrozen(env));
    assert.equal(env.APP_MODE, 'prod');
    assert.equal(env.APP_PROTOCOL, 'https');
    assert.equal(env.APP_DATABASE_PORT, Number(TEST_ENV.APP_DATABASE_PORT));
    assert.equal(env.APP_REDIS_PORT, Number(TEST_ENV.APP_REDIS_PORT));
  });

  test('takes the app metadata from package.json', () => {
    const env = parseEnv(TEST_ENV);

    assert.equal(env.APP_NAME, packageData.name);
    assert.equal(env.APP_NAME_FORMATTED, 'Node Fastify Starter');
    assert.equal(env.APP_VERSION, packageData.version);
    assert.equal(env.APP_AUTHOR, packageData.author);
    assert.equal(env.APP_REPOSITORY, packageData.repository.url);
    assert.equal(env.APP_DESCRIPTION, packageData.description);
  });

  test('lets a variable override the metadata from package.json', () => {
    const env = parseEnv({ ...TEST_ENV, APP_VERSION: '9.9.9' });

    assert.equal(env.APP_VERSION, '9.9.9');
  });

  test('lists every missing required variable at once', () => {
    const lines = getErrorLines({});

    assert.equal(lines[0], 'Invalid environment variables:');
    assert.deepEqual(
      lines.slice(1, -1),
      ENV_SCHEMA.required.map((name) => `  - ${name} is required`),
    );
  });

  test('treats an empty or blank value as not set', () => {
    const lines = getErrorLines({ ...TEST_ENV, APP_HOST: '', APP_REDIS_HOST: '   ' });
    const env = parseEnv({ ...TEST_ENV, APP_MODE: '', APP_REDIS_PASSWORD: '' });

    assert.ok(lines.includes('  - APP_HOST is required'));
    assert.ok(lines.includes('  - APP_REDIS_HOST is required'));
    assert.equal(env.APP_MODE, 'prod');
    assert.equal(Object.hasOwn(env, 'APP_REDIS_PASSWORD'), false);
  });

  test('rejects a secret shorter than 32 characters and says how to make one', () => {
    const lines = getErrorLines({ ...TEST_ENV, APP_JWT_ACCESS_SECRET: 'a'.repeat(31) });

    assert.ok(lines.includes(`  - APP_JWT_ACCESS_SECRET ${TOO_SHORT}`));
    assert.deepEqual(getErrorLines({ ...TEST_ENV, APP_JWT_ACCESS_SECRET: SECRET }), []);
  });

  test('rejects a secret with characters outside base64url', () => {
    const lines = getErrorLines({ ...TEST_ENV, APP_JWT_REFRESH_SECRET: `${SECRET}$` });

    assert.ok(lines.includes('  - APP_JWT_REFRESH_SECRET must match format "base64url"'));
  });

  test('checks the previous signing keys only when they are set', () => {
    const lines = getErrorLines({
      ...TEST_ENV,
      APP_JWT_ACCESS_SECRET_PREVIOUS: 'short',
      APP_JWT_REFRESH_SECRET_PREVIOUS: 'short',
    });

    assert.ok(lines.includes(`  - APP_JWT_ACCESS_SECRET_PREVIOUS ${TOO_SHORT}`));
    assert.ok(lines.includes(`  - APP_JWT_REFRESH_SECRET_PREVIOUS ${TOO_SHORT}`));
  });

  test('holds only signing keys to the length rule', () => {
    const env = parseEnv({
      ...TEST_ENV,
      APP_LOG_API_KEY: 'shared-key',
      APP_DATABASE_PASSWORD: 'root',
      APP_REDIS_PASSWORD: 'admin',
    });

    assert.equal(env.APP_LOG_API_KEY, 'shared-key');
    assert.equal(env.APP_DATABASE_PASSWORD, 'root');
  });

  test('reports a value that swallowed the next line of .env', () => {
    ['APP_REDIS_PASSWORD=admin', 'export APP_REDIS_PASSWORD=admin'].forEach((value) => {
      const lines = getErrorLines({ ...TEST_ENV, APP_REDIS_USER: value });

      assert.ok(lines.includes('  - APP_REDIS_USER swallowed the next line of .env: remove the whitespace after "APP_REDIS_USER="'));
    });

    assert.deepEqual(getErrorLines({ ...TEST_ENV, APP_REDIS_PASSWORD: 'TOKEN=abc', APP_LOG_API_KEY: 'QUJD=' }), []);
  });

  test('never prints a value in the error', () => {
    const secret = 'short-secret-value';
    const lines = getErrorLines({ ...TEST_ENV, APP_JWT_ACCESS_SECRET: secret, APP_DATABASE_PORT: 'not-a-port' });

    assert.equal(lines.join('\n').includes(secret), false);
    assert.equal(lines.join('\n').includes('not-a-port'), false);
  });

  test('rejects an unknown mode and protocol', () => {
    const lines = getErrorLines({ ...TEST_ENV, APP_MODE: 'test', APP_PROTOCOL: 'ftp' });

    assert.ok(lines.includes('  - APP_MODE must be one of: dev, prod'));
    assert.ok(lines.includes('  - APP_PROTOCOL must be one of: http, https'));
  });

  test('accepts a port only as a plain integer between 1 and 65535', () => {
    ['abc', '0x10', '1e3', '3307.0', '+80', '-1', 'Infinity', ' 3307'].forEach((value) => {
      assert.ok(getErrorLines({ ...TEST_ENV, APP_REDIS_PORT: value }).includes('  - APP_REDIS_PORT must be integer'), value);
    });

    assert.ok(getErrorLines({ ...TEST_ENV, APP_DATABASE_PORT: '0' }).includes('  - APP_DATABASE_PORT must be >= 1'));
    assert.ok(getErrorLines({ ...TEST_ENV, APP_DATABASE_PORT: '65536' }).includes('  - APP_DATABASE_PORT must be <= 65535'));
    assert.equal(parseEnv({ ...TEST_ENV, APP_HEALTH_PORT: '65535' }).APP_HEALTH_PORT, 65535);
    assert.equal(parseEnv({ ...TEST_ENV, APP_HEALTH_PORT: 8080 }).APP_HEALTH_PORT, 8080);
  });

  test('accepts a public host with an optional valid port', () => {
    ['example.com', 'localhost', '127.0.0.1:4173', 'example.com:65535'].forEach((value) => {
      assert.equal(parseEnv({ ...TEST_ENV, APP_HOST: value }).APP_HOST, value);
    });

    ['https://example.com', 'example.com/api', 'example.com:65536', 'example.com:'].forEach((value) => {
      assert.ok(getErrorLines({ ...TEST_ENV, APP_HOST: value }).includes('  - APP_HOST must match format "host[:port]"'), value);
    });
  });

  test('keeps a variable the schema does not describe, such as the credentials of an OAuth provider', () => {
    const env = parseEnv({
      ...TEST_ENV,
      APP_OAUTH_GITHUB_CLIENT_ID: 'id',
      APP_OAUTH_GITHUB_CLIENT_SECRET: 'secret',
    });

    assert.equal(env.APP_OAUTH_GITHUB_CLIENT_ID, 'id');
    assert.equal(env.APP_OAUTH_GITHUB_CLIENT_SECRET, 'secret');
  });
});

describe('initEnv in a process of its own', () => {
  test('fails with the list of variables when there is no .env', async (t) => {
    const cwd = await createWorkDir(t);
    const { code, stdout, stderr } = await runNode(PRINT_ENV, { cwd });

    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Invalid environment variables:/);
    ENV_SCHEMA.required.forEach((name) => assert.ok(stderr.includes(`  - ${name} is required`)));
  });

  test('reads .env from the working directory and forces UTC', async (t) => {
    const cwd = await createWorkDir(t, { ...TEST_ENV, APP_MODE: 'dev' });
    const { code, stdout } = await runNode(PRINT_ENV, { cwd, env: { TZ: 'America/New_York' } });
    const { env, timeZone } = JSON.parse(stdout);

    assert.equal(code, 0);
    assert.equal(env.APP_MODE, 'dev');
    assert.equal(env.APP_HOST, TEST_ENV.APP_HOST);
    assert.equal(env.APP_VERSION, packageData.version);
    assert.equal(timeZone, 'UTC');
  });

  test('fails on an invalid .env and names the variables', async (t) => {
    const cwd = await createWorkDir(t, { ...TEST_ENV, APP_JWT_ACCESS_SECRET: 'short', APP_DATABASE_PORT: 'abc' });
    const { code, stderr } = await runNode(PRINT_ENV, { cwd });

    assert.equal(code, 1);
    assert.match(stderr, /APP_JWT_ACCESS_SECRET must be at least 32 characters long/);
    assert.match(stderr, /APP_DATABASE_PORT must be integer/);
  });

  test('treats an empty value in .env as not set', async (t) => {
    const cwd = await createWorkDir(t, { ...TEST_ENV, APP_HOST: '', APP_MODE: '' });
    const { code, stderr } = await runNode(PRINT_ENV, { cwd });

    assert.equal(code, 1);
    assert.match(stderr, /APP_HOST is required/);
    assert.doesNotMatch(stderr, /APP_MODE/);
  });

  test('lets a variable of the environment win over .env and keeps APP_* apart from system variables', async (t) => {
    const cwd = await createWorkDir(t, { ...TEST_ENV, APP_HOST: 'from-file.test' });
    const { stdout } = await runNode(PRINT_ENV, { cwd, env: { APP_HOST: 'from-env.test' } });
    const { env, systemKeys } = JSON.parse(stdout);

    assert.equal(env.APP_HOST, 'from-env.test');
    assert.equal(env.APP_DATABASE_NAME, TEST_ENV.APP_DATABASE_NAME);
    assert.ok(systemKeys.length > 0);
    assert.deepEqual(systemKeys.filter((key) => key.startsWith('APP_')), []);
  });

  test('names the .env it looked for', async (t) => {
    const cwd = await createWorkDir(t);
    const { stderr } = await runNode(PRINT_ENV, { cwd });

    assert.ok(stderr.includes(nodePath.join(cwd, '.env')));
  });

  test('fails on whitespace after an empty value instead of losing the next variable', async (t) => {
    const cwd = await createWorkDir(t, { ...TEST_ENV, APP_REDIS_USER: '   ' });
    const { code, stderr } = await runNode(PRINT_ENV, { cwd });

    assert.equal(code, 1);
    assert.match(stderr, /APP_REDIS_USER swallowed the next line of \.env/);
  });

  test('fails on a .env saved with a byte order mark', async (t) => {
    const cwd = await createWorkDir(t, `${String.fromCharCode(0xFEFF)}APP_MODE=dev\n`);
    const { code, stderr } = await runNode(PRINT_ENV, { cwd });

    assert.equal(code, 1);
    assert.match(stderr, /starts with a UTF-8 byte order mark/);
  });
});

describe('isCi', () => {
  test('follows the CI variable', async (t) => {
    const cwd = await createWorkDir(t, TEST_ENV);
    const results = await Promise.all(
      ['true', '1', 'false', '0', ''].map((CI) => runNode(PRINT_ENV, { cwd, env: { CI } })),
    );

    assert.deepEqual(
      results.map(({ stdout }) => JSON.parse(stdout).isCi),
      [true, true, false, false, false],
    );
    assert.equal(typeof isCi(), 'boolean');
  });
});

describe('.env.example', () => {
  test('lists exactly the variables of the manifest', async () => {
    const content = await readFile(resolvePath('.env.example'), 'utf8');
    const listed = content.match(/^APP_[A-Z0-9_]+(?==)/gm);
    const packageKeys = ['APP_NAME', 'APP_NAME_FORMATTED', 'APP_VERSION', 'APP_AUTHOR', 'APP_REPOSITORY', 'APP_DESCRIPTION'];
    const oauthKeys = listed.filter((key) => key.startsWith('APP_OAUTH_'));
    const expected = Object.keys(ENV_SCHEMA.properties).filter((key) => !packageKeys.includes(key));

    assert.deepEqual(listed.filter((key) => !oauthKeys.includes(key)).sort(), expected.sort());
    assert.ok(oauthKeys.length > 0);
    assert.equal(new Set(listed).size, listed.length);
  });

  test('holds only values the manifest accepts', async () => {
    const content = await readFile(resolvePath('.env.example'), 'utf8');
    const values = Object.fromEntries(
      content
        .match(/^APP_[A-Z0-9_]+=.+$/gm)
        .map((line) => line.split(/=(.*)/).slice(0, 2)),
    );

    assert.equal(values.APP_MODE, 'prod');
    assert.equal(values.APP_PROTOCOL, 'https');
    assert.doesNotThrow(() => createTestEnv(values));
  });
});
