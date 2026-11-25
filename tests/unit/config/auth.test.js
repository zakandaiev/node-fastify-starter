import { createConfig } from '#config/index.js';
import { createTestConfig, createTestEnv } from '#root/tests/helper/config.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { convertStringToMs, convertStringToSeconds } from '#utils/date.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SECRET_KEYS = ['accessSecret', 'refreshSecret', 'accessSecretPrevious', 'refreshSecretPrevious'];
const LIFETIME_KEYS = ['accessTtl', 'refreshTtl', 'sessionMaxAge'];

const MINUTE_SECONDS = 60;
const DAY_SECONDS = 24 * 60 * MINUTE_SECONDS;

const MEMORY_TTL_MIN_SECONDS = 1;
const MEMORY_TTL_MAX_SECONDS = 3;

const SECRETS = Object.freeze({
  APP_JWT_ACCESS_SECRET: 'config-access-secret-0123456789-abcdef',
  APP_JWT_REFRESH_SECRET: 'config-refresh-secret-0123456789-abcdef',
});
const PREVIOUS_ACCESS_SECRET = 'config-previous-access-secret-0123456789';
const PREVIOUS_REFRESH_SECRET = 'config-previous-refresh-secret-0123456789';

const CURRENT = Object.freeze({
  accessSecret: SECRETS.APP_JWT_ACCESS_SECRET,
  refreshSecret: SECRETS.APP_JWT_REFRESH_SECRET,
});

function readSecrets(env = {}) {
  const { auth } = createConfig(createTestEnv({ ...SECRETS, ...env }));

  return pick(auth, SECRET_KEYS);
}

describe('config.auth', () => {
  test('takes the secret of each kind of token from env, and has no previous ones unless env names them', () => {
    assert.deepEqual(readSecrets(), { ...CURRENT, accessSecretPrevious: null, refreshSecretPrevious: null });
  });

  test('takes the previous secret of each kind on its own, and a blank one for none', () => {
    assert.deepEqual(
      readSecrets({ APP_JWT_ACCESS_SECRET_PREVIOUS: PREVIOUS_ACCESS_SECRET }),
      { ...CURRENT, accessSecretPrevious: PREVIOUS_ACCESS_SECRET, refreshSecretPrevious: null },
    );
    assert.deepEqual(
      readSecrets({ APP_JWT_ACCESS_SECRET_PREVIOUS: '', APP_JWT_REFRESH_SECRET_PREVIOUS: PREVIOUS_REFRESH_SECRET }),
      { ...CURRENT, accessSecretPrevious: null, refreshSecretPrevious: PREVIOUS_REFRESH_SECRET },
    );
  });

  test('gives an access token ten minutes, a refresh token thirty days and a session ninety days, as text with a unit that is a whole number of seconds', () => {
    const { auth } = createConfig(createTestEnv());
    const lifetimes = LIFETIME_KEYS.map((key) => convertStringToSeconds(auth[key]));

    assert.deepEqual(lifetimes, [10 * MINUTE_SECONDS, 30 * DAY_SECONDS, 90 * DAY_SECONDS]);
  });

  test('limits the sessions of a user, the bytes of an access token and what a process keeps in its memory', () => {
    const { auth } = createConfig(createTestEnv());
    const memoryTtl = convertStringToSeconds(auth.registryMemoryTtl);

    assert.deepEqual(pick(auth, ['maxSessions', 'accessTokenMaxBytes']), { maxSessions: 5, accessTokenMaxBytes: 4000 });
    assert.ok(memoryTtl >= MEMORY_TTL_MIN_SECONDS && memoryTtl <= MEMORY_TTL_MAX_SECONDS, auth.registryMemoryTtl);
    assert.ok(Number.isSafeInteger(auth.registryMemoryMaxEntries) && auth.registryMemoryMaxEntries > 0);
  });

  test('sends the refresh cookie to the refresh route under the prefix of the API, and to no other', () => {
    const { app, auth } = createConfig(createTestEnv());

    assert.equal(`${app.apiPrefix}${auth.refreshRoute}`, '/api/v1/auth/refresh');
  });

  test('gives the read of a session a deadline above the one of its statement: the server answers first', () => {
    const { auth, db } = createConfig(createTestEnv());

    assert.ok(convertStringToMs(auth.readTimeout) > convertStringToMs(db.statementTimeout));
  });

  test('gives the read of a session a deadline above the one of a connection: a database that does not answer is told as a connection that failed', () => {
    const { auth, db } = createConfig(createTestEnv());

    assert.ok(convertStringToMs(auth.readTimeout) > convertStringToMs(db.connectTimeout));
  });

  test('is one flat frozen section: a test replaces a single value of it', () => {
    const { auth } = createConfig(createTestEnv());
    const overridden = createTestConfig({ auth: { accessTtl: '1m' } });

    assert.ok(isDeepFrozen(auth));
    assert.equal(Object.values(auth).every((value) => value === null || typeof value !== 'object'), true);
    assert.deepEqual(overridden.auth, { ...createTestConfig().auth, accessTtl: '1m' });
  });
});
