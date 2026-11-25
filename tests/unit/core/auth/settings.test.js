import { assertAuthConfig, readLifetimes } from '#core/auth/settings.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const LIFETIME_KEYS = ['accessTtl', 'refreshTtl', 'sessionMaxAge'];
const DURATION_KEYS = [...LIFETIME_KEYS, 'registryMemoryTtl', 'readTimeout'];
const LIMIT_KEYS = ['accessTokenMaxBytes', 'maxSessions', 'registryMemoryMaxEntries'];

const UNREADABLE_MESSAGE = /convertStringToMs\(value\) requires a number with a unit s, m, h, d or w/;
const NOT_ABOVE_ZERO_MESSAGE = /^config\.auth requires accessTtl, refreshTtl, sessionMaxAge, registryMemoryTtl, readTimeout to be above zero$/;
const NOT_WHOLE_MESSAGE = /^config\.auth requires accessTtl, refreshTtl and sessionMaxAge to be whole seconds$/;
const ORDER_MESSAGE = /^config\.auth requires accessTtl not to be above refreshTtl, and refreshTtl not to be above sessionMaxAge$/;
const LIMIT_MESSAGE = /^config\.auth requires accessTokenMaxBytes, maxSessions, registryMemoryMaxEntries to be positive integers$/;
const ROUTE_MESSAGE = /^config\.auth requires refreshRoute: the route the refresh cookie rides to$/;

const LIFETIMES = Object.freeze({ accessTtl: '10m', refreshTtl: '30d', sessionMaxAge: '90d' });

const ABOVE_SAFE_INTEGER = 2 ** 53;

const UNREADABLE = [undefined, null, '', 600, '10', '10ms', '10 m', '1 minute', ['10m']];
const NOT_ABOVE_ZERO = ['0s', '0m', '-1s', '-90d', '0.0001s'];
const NOT_WHOLE = ['0.5s', '1.5s', '600.001s', '0.01m'];
const NOT_LIMITS = [undefined, null, 0, -1, 1.5, '5', Number.NaN, Infinity, ABOVE_SAFE_INTEGER];
const NOT_ROUTES = [undefined, null, '', 42, ['/v1/auth/refresh']];

const WRONG_ORDERS = [
  { accessTtl: '31d' },
  { accessTtl: '2592001s' },
  { refreshTtl: '599s' },
  { refreshTtl: '91d' },
  { refreshTtl: '7776001s' },
  { sessionMaxAge: '29d' },
  { sessionMaxAge: '1h', refreshTtl: '2h', accessTtl: '1h' },
];

function createSection(overrides = {}) {
  return { ...createTestConfig().auth, ...LIFETIMES, ...overrides };
}

function cross(keys, values) {
  return keys.flatMap((key) => values.map((value) => ({ [key]: value })));
}

function assertRefused(cases, message) {
  cases.forEach((overrides) => {
    assert.throws(() => assertAuthConfig(createSection(overrides)), { name: 'TypeError', message });
  });
}

describe('readLifetimes', () => {
  test('gives the three lifetimes of the config in seconds', () => {
    assert.deepEqual(readLifetimes(createSection()), { accessTtl: 600, refreshTtl: 2592000, sessionMaxAge: 7776000 });
  });
});

describe('assertAuthConfig', () => {
  test('accepts the section of the config', () => {
    assert.equal(assertAuthConfig(createTestConfig().auth), true);
  });

  test('accepts lifetimes that are equal, limits of one, and a part of a second where no token and no cookie counts it', () => {
    assert.equal(assertAuthConfig(createSection({
      accessTtl: '1s',
      refreshTtl: '1s',
      sessionMaxAge: '1s',
      registryMemoryTtl: '0.5s',
      readTimeout: '0.25s',
      accessTokenMaxBytes: 1,
      maxSessions: 1,
      registryMemoryMaxEntries: 1,
    })), true);
  });

  test('refuses a duration nobody can read', () => {
    assertRefused(cross(DURATION_KEYS, UNREADABLE), UNREADABLE_MESSAGE);
  });

  test('refuses a duration of zero or below it', () => {
    assertRefused(cross(DURATION_KEYS, NOT_ABOVE_ZERO), NOT_ABOVE_ZERO_MESSAGE);
  });

  test('refuses a lifetime with a part of a second: its cookies could not be written after the rotation that made them', () => {
    assertRefused(cross(LIFETIME_KEYS, NOT_WHOLE), NOT_WHOLE_MESSAGE);
  });

  test('refuses an access token that outlives its refresh token, and a refresh token that outlives its session', () => {
    assertRefused(WRONG_ORDERS, ORDER_MESSAGE);
  });

  test('refuses a limit that is not a positive integer', () => {
    assertRefused(cross(LIMIT_KEYS, NOT_LIMITS), LIMIT_MESSAGE);
  });

  test('refuses a refresh cookie that rides to no route', () => {
    assertRefused(cross(['refreshRoute'], NOT_ROUTES), ROUTE_MESSAGE);
  });
});

describe('the start of the app', () => {
  test('fails with the same error on a section that is refused', async () => {
    const env = { ...REDIS_DOWN_ENV, ...(await createDownEnv()) };
    const cases = [
      ...cross(DURATION_KEYS, ['10 minutes']).map((auth) => [auth, UNREADABLE_MESSAGE]),
      ...cross(DURATION_KEYS, ['0s']).map((auth) => [auth, NOT_ABOVE_ZERO_MESSAGE]),
      ...cross(LIFETIME_KEYS, ['1.5s']).map((auth) => [auth, NOT_WHOLE_MESSAGE]),
      ...cross(LIMIT_KEYS, [0]).map((auth) => [auth, LIMIT_MESSAGE]),
      [{ accessTtl: '31d' }, ORDER_MESSAGE],
      [{ refreshTtl: '91d' }, ORDER_MESSAGE],
      [{ refreshRoute: '' }, ROUTE_MESSAGE],
    ];

    await Promise.all(cases.map(([auth, message]) => assert.rejects(
      buildTestApp({ env, auth: { ...LIFETIMES, ...auth } }),
      { name: 'TypeError', message },
    )));
  });

  test('succeeds on a section that is accepted', async (t) => {
    const env = { ...REDIS_DOWN_ENV, ...(await createDownEnv()) };
    const fastify = await buildTestApp({ env, auth: { accessTtl: '1s', refreshTtl: '1s', sessionMaxAge: '1s' } });

    t.after(() => fastify.close());

    assert.equal(fastify.hasPlugin('jwt'), true);
  });
});
