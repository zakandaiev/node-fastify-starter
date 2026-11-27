import { createRateLimitConfig } from '#config/rate-limit.js';
import {
  assertRateLimitConfig,
  assertRouteLimit,
  readAddressKey,
  readLimitKey,
  readLimitTier,
  readRefreshLimitKey,
  toPluginBan,
  toRouteLimit,
} from '#core/rate-limit/index.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import { TEST_ENV } from '#root/tests/helper/config.js';
import { issueFor } from '#root/tests/helper/guard.js';
import { buildDownApp, runInApp, toBearer } from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { nowUtc, toUnixSeconds } from '#utils/date.js';
import { encodeBase64Url } from '#utils/encoding.js';
import { hmac } from '#utils/hash.js';
import { uuidv7 } from '#utils/id.js';
import { mapValues } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const ADDRESS = '8.8.8.8';
const OTHER_ADDRESS = '8.8.4.4';
const IPV6_ADDRESS = '2a00:1450:4001:81a::200e';
const IPV6_NETWORK = '2a00:1450:4001:81a::';

const FOREIGN_SECRET = 'foreign-secret-0123456789-abcdefghij';
const HS256 = Object.freeze({ alg: 'HS256', typ: 'JWT' });
const SIGNATURE = Object.freeze({ algorithm: 'sha256', encoding: 'base64url' });
const TOKEN_LIFETIME_SECONDS = 600;
const EXPIRED_AGO_SECONDS = 60;

const ACCESS = Object.freeze({ secret: TEST_ENV.APP_JWT_ACCESS_SECRET, claims: { tokenType: 'access', scopes: [] } });
const REFRESH = Object.freeze({ secret: TEST_ENV.APP_JWT_REFRESH_SECRET, claims: { tokenType: 'refresh', jti: uuidv7() } });

const LIMITS_URL = '/limit-keys';

const ROUTE_LIMIT_NAME = 'security.rateLimit';

const SECTIONS_MESSAGE = 'assertRateLimitConfig(rateLimitConfig) requires config.rateLimit with tiers and routes, report among them';
const TIER_TAIL = 'takes max, window alone: max a positive integer, window a duration above zero';
const REPORT_MESSAGE = 'config.rateLimit.routes.report takes max, maxWithKey, window alone: max a positive integer, maxWithKey a positive integer, window a duration above zero';
const COUNT_TAIL = 'requires a positive integer';
const BAN_WINDOW_MESSAGE = 'config.rateLimit requires ban to be null or an integer not below zero, and reportWindow a duration above zero';

const DEFAULTS = createRateLimitConfig();

function formMessage(name = ROUTE_LIMIT_NAME) {
  return `${name} requires false, or { max, window } with an optional ban and key`;
}

function unknownKeyMessage(key) {
  return `${ROUTE_LIMIT_NAME} names "${key}", which no limiter reads: it takes max, window, ban, key`;
}

function maxMessage(name = ROUTE_LIMIT_NAME) {
  return `${name} requires max, a positive integer or a function (request, key) that gives one, and window, a duration above zero such as "1m"`;
}

function banMessage(name = ROUTE_LIMIT_NAME) {
  return `${name} requires ban to be null or an integer not below zero, and key a function (request) that gives the key`;
}

function signToken(claims, secret) {
  const input = [HS256, claims].map((part) => encodeBase64Url(JSON.stringify(part))).join('.');

  return `${input}.${hmac(input, secret, SIGNATURE)}`;
}

// A token as the app signs it, unless a test gives it another secret or an end in the past.
function forge(kind, userId, { secret = kind.secret, isExpired = false } = {}) {
  const now = toUnixSeconds(nowUtc());
  const issuedAt = isExpired
    ? now - TOKEN_LIFETIME_SECONDS - EXPIRED_AGO_SECONDS
    : now;

  return signToken({
    ...kind.claims,
    sub: userId,
    sid: uuidv7(),
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
  }, secret);
}

function toCookie(name, value) {
  return { [HEADER.COOKIE]: `${name}=${value}` };
}

function readKey(fastify, read, request = {}) {
  return runInApp(fastify, () => read({ headers: {}, ip: ADDRESS, ...request }));
}

function readKeys(fastify, read, requests) {
  return mapValues(requests, (request) => readKey(fastify, read, request));
}

function sameFor(requests, key) {
  return mapValues(requests, () => key);
}

function withTier(name, preset) {
  return { ...DEFAULTS, tiers: { ...DEFAULTS.tiers, [name]: preset } };
}

function withRoute(name, preset) {
  return { ...DEFAULTS, routes: { ...DEFAULTS.routes, [name]: preset } };
}

function withReport(changes) {
  return withRoute('report', { ...DEFAULTS.routes.report, ...changes });
}

function readMax() {
  return 1;
}

function readOwnKey() {
  return 'own';
}

describe('readAddressKey', () => {
  test('keys an IPv4 address as it is, under "ip:"', () => {
    assert.equal(readAddressKey({ ip: ADDRESS }), 'ip:8.8.8.8');
    assert.equal(readAddressKey({ ip: OTHER_ADDRESS }), 'ip:8.8.4.4');
  });

  test('keys an IPv6 address by its /64: the addresses of one network share a key in any spelling, with a zone too, and another /64 has its own', () => {
    const network = [
      IPV6_ADDRESS,
      '2a00:1450:4001:81a::1',
      '2a00:1450:4001:81a:ffff:ffff:ffff:ffff',
      '2A00:1450:4001:081A:0000:0000:0000:0001',
      '2a00:1450:4001:81a::1%eth0',
    ];

    assert.deepEqual(network.map((ip) => readAddressKey({ ip })), network.map(() => `ip:${IPV6_NETWORK}`));
    assert.equal(readAddressKey({ ip: '2a00:1450:4001:81b::1' }), 'ip:2a00:1450:4001:81b::');
    assert.equal(readAddressKey({ ip: '2a00:1450:4002:81a::1' }), 'ip:2a00:1450:4002:81a::');
  });

  test('reads an IPv4-mapped IPv6 address as its IPv4, in either notation', () => {
    const mapped = ['::ffff:8.8.8.8', '::FFFF:8.8.8.8', '::ffff:808:808'];

    assert.deepEqual(mapped.map((ip) => readAddressKey({ ip })), mapped.map(() => 'ip:8.8.8.8'));
  });

  test('gives "ip:unknown" for a request.ip that is no IP address, which a proxy may write there', () => {
    const notAddresses = {
      missing: undefined,
      null: null,
      empty: '',
      'a name': 'garbage',
      'a number': 42,
      'an address with a port': '8.8.8.8:443',
      'an address in brackets': `[${IPV6_ADDRESS}]`,
      'an address with a blank': `${ADDRESS} `,
      'a list of hops': `${ADDRESS}, ${OTHER_ADDRESS}`,
      'leading zeros': '008.008.008.008',
      'an address longer than any IP': `fe80::1%${'a'.repeat(50)}`,
    };

    assert.deepEqual(mapValues(notAddresses, (ip) => readAddressKey({ ip })), sameFor(notAddresses, 'ip:unknown'));
  });
});

describe('readLimitKey', () => {
  test('gives the user of a valid access token one key "user:<id>", from the cookie or from a Bearer header, whatever the address', async (t) => {
    const fastify = await buildDownApp(t);
    const { userId, accessToken } = issueFor(fastify);
    const cookie = toCookie(COOKIE.ACCESS_TOKEN, accessToken);
    const requests = {
      'the cookie': { headers: cookie },
      'a Bearer header': { headers: toBearer(accessToken) },
      'the cookie from another address': { headers: cookie, ip: OTHER_ADDRESS },
      'a Bearer header from IPv6': { headers: toBearer(accessToken), ip: IPV6_ADDRESS },
      'the cookie from an address that is no IP': { headers: cookie, ip: 'garbage' },
    };

    assert.deepEqual(readKeys(fastify, readLimitKey, requests), sameFor(requests, `user:${userId}`));
  });

  test('gives a token it cannot trust the address key, in the cookie and in a Bearer header: signed with another secret, a refresh token, an expired one, garbage', async (t) => {
    const fastify = await buildDownApp(t);
    const userId = uuidv7();
    const tokens = {
      'signed with another secret': forge(ACCESS, userId, { secret: FOREIGN_SECRET }),
      'a refresh token': issueFor(fastify, [], { userId }).refreshToken,
      'a refresh token signed as one': forge(REFRESH, userId),
      'an access token signed with the refresh secret': forge(ACCESS, userId, { secret: REFRESH.secret }),
      expired: forge(ACCESS, userId, { isExpired: true }),
      garbage: 'garbage',
      'three parts of nothing': 'a.b.c',
    };
    const requests = Object.fromEntries(Object.entries(tokens).flatMap(([name, token]) => [
      [`${name} in the cookie`, { headers: toCookie(COOKIE.ACCESS_TOKEN, token) }],
      [`${name} in a Bearer header`, { headers: toBearer(token) }],
    ]));

    assert.equal(readKey(fastify, readLimitKey, { headers: toCookie(COOKIE.ACCESS_TOKEN, forge(ACCESS, userId)) }), `user:${userId}`);
    assert.deepEqual(readKeys(fastify, readLimitKey, requests), sameFor(requests, 'ip:8.8.8.8'));
  });

  test('takes the Bearer header over the cookie: a token there nobody can use gives the address key beside a valid cookie, a valid one its own user', async (t) => {
    const fastify = await buildDownApp(t);
    const owner = issueFor(fastify);
    const other = issueFor(fastify);
    const cookie = toCookie(COOKIE.ACCESS_TOKEN, owner.accessToken);
    const requests = {
      'a token of garbage': { headers: { ...cookie, [HEADER.AUTHORIZATION]: 'Bearer garbage' } },
      'the scheme alone': { headers: { ...cookie, [HEADER.AUTHORIZATION]: 'Bearer' } },
      'the scheme in lower case with a refresh token': { headers: { ...cookie, [HEADER.AUTHORIZATION]: `bearer ${owner.refreshToken}` } },
    };

    assert.deepEqual(readKeys(fastify, readLimitKey, requests), sameFor(requests, 'ip:8.8.8.8'));
    assert.equal(readKey(fastify, readLimitKey, { headers: { ...cookie, ...toBearer(other.accessToken) } }), `user:${other.userId}`);
  });

  test('reads the cookie beside an Authorization header of another scheme, such as the Basic one of a proxy before a stage', async (t) => {
    const fastify = await buildDownApp(t);
    const { userId, accessToken } = issueFor(fastify);
    const cookie = toCookie(COOKIE.ACCESS_TOKEN, accessToken);
    const requests = {
      Basic: { headers: { ...cookie, [HEADER.AUTHORIZATION]: 'Basic dXNlcjpwYXNzd29yZA==' } },
      'a scheme that only starts like Bearer': { headers: { ...cookie, [HEADER.AUTHORIZATION]: 'Bearerish token' } },
    };

    assert.deepEqual(readKeys(fastify, readLimitKey, requests), sameFor(requests, `user:${userId}`));
  });

  test('keys a guest by the address, also one with a refresh cookie alone: an IPv4 as it is, an IPv6 by its /64, one that is no IP as unknown', async (t) => {
    const fastify = await buildDownApp(t);
    const { refreshToken } = issueFor(fastify);

    assert.deepEqual([
      readKey(fastify, readLimitKey),
      readKey(fastify, readLimitKey, { ip: IPV6_ADDRESS }),
      readKey(fastify, readLimitKey, { ip: undefined }),
      readKey(fastify, readLimitKey, { ip: 'garbage' }),
      readKey(fastify, readLimitKey, { headers: toCookie(COOKIE.REFRESH_TOKEN, refreshToken) }),
    ], ['ip:8.8.8.8', `ip:${IPV6_NETWORK}`, 'ip:unknown', 'ip:unknown', 'ip:8.8.8.8']);
  });
});

describe('readRefreshLimitKey', () => {
  test('gives a valid refresh cookie "user:<id>:<address>": the address is read as the address key reads it, so another address is another key', async (t) => {
    const fastify = await buildDownApp(t);
    const { userId, refreshToken } = issueFor(fastify);
    const other = issueFor(fastify);
    const headers = toCookie(COOKIE.REFRESH_TOKEN, refreshToken);

    assert.deepEqual([
      readKey(fastify, readRefreshLimitKey, { headers }),
      readKey(fastify, readRefreshLimitKey, { headers, ip: OTHER_ADDRESS }),
      readKey(fastify, readRefreshLimitKey, { headers, ip: '::ffff:8.8.8.8' }),
      readKey(fastify, readRefreshLimitKey, { headers, ip: IPV6_ADDRESS }),
      readKey(fastify, readRefreshLimitKey, { headers, ip: '2a00:1450:4001:81a::1' }),
      readKey(fastify, readRefreshLimitKey, { headers, ip: 'garbage' }),
      readKey(fastify, readRefreshLimitKey, { headers: toCookie(COOKIE.REFRESH_TOKEN, other.refreshToken) }),
    ], [
      `user:${userId}:8.8.8.8`,
      `user:${userId}:8.8.4.4`,
      `user:${userId}:8.8.8.8`,
      `user:${userId}:${IPV6_NETWORK}`,
      `user:${userId}:${IPV6_NETWORK}`,
      `user:${userId}:unknown`,
      `user:${other.userId}:8.8.8.8`,
    ]);
  });

  test('gives the address key without a refresh cookie or with one it cannot trust: garbage, an access token, signed with another secret, expired', async (t) => {
    const fastify = await buildDownApp(t);
    const userId = uuidv7();
    const tokens = {
      garbage: 'garbage',
      'an access token': issueFor(fastify, [], { userId }).accessToken,
      'signed with another secret': forge(REFRESH, userId, { secret: FOREIGN_SECRET }),
      'signed with the access secret': forge(REFRESH, userId, { secret: ACCESS.secret }),
      expired: forge(REFRESH, userId, { isExpired: true }),
    };
    const requests = {
      'no cookie': {},
      ...mapValues(tokens, (token) => ({ headers: toCookie(COOKIE.REFRESH_TOKEN, token) })),
    };

    assert.equal(readKey(fastify, readRefreshLimitKey, { headers: toCookie(COOKIE.REFRESH_TOKEN, forge(REFRESH, userId)) }), `user:${userId}:8.8.8.8`);
    assert.deepEqual(readKeys(fastify, readRefreshLimitKey, requests), sameFor(requests, 'ip:8.8.8.8'));
  });

  test('takes a refresh token from its cookie alone: not from a Bearer header, not from the access cookie, and a valid access token does not stand in for it', async (t) => {
    const fastify = await buildDownApp(t);
    const { refreshToken, accessToken } = issueFor(fastify);
    const requests = {
      'a Bearer header': { headers: toBearer(refreshToken) },
      'the access cookie': { headers: toCookie(COOKIE.ACCESS_TOKEN, refreshToken) },
      'a valid access token': { headers: toCookie(COOKIE.ACCESS_TOKEN, accessToken) },
    };

    assert.deepEqual(readKeys(fastify, readRefreshLimitKey, requests), sameFor(requests, 'ip:8.8.8.8'));
  });
});

describe('the keys of a request of the app', () => {
  test('are those of what the request carries: the address a trusted proxy names or that of the socket, and the cookies of the browser', async (t) => {
    const fastify = await buildDownApp(t);
    const { userId, cookies, refreshToken } = issueFor(fastify);

    fastify.get(LIMITS_URL, (request) => ({ key: readLimitKey(request), refreshKey: readRefreshLimitKey(request) }));

    const responses = await mapSeries([
      { headers: { [HEADER.X_FORWARDED_FOR]: ADDRESS }, cookies: { ...cookies, [COOKIE.REFRESH_TOKEN]: refreshToken } },
      { remoteAddress: IPV6_ADDRESS },
      { headers: { [HEADER.X_FORWARDED_FOR]: 'garbage' } },
    ], (request) => fastify.inject({ url: LIMITS_URL, ...request }));

    assert.deepEqual(responses.map((response) => [response.statusCode, response.json()]), [
      [200, { key: `user:${userId}`, refreshKey: `user:${userId}:8.8.8.8` }],
      [200, { key: `ip:${IPV6_NETWORK}`, refreshKey: `ip:${IPV6_NETWORK}` }],
      [200, { key: 'ip:unknown', refreshKey: 'ip:unknown' }],
    ]);
  });
});

describe('readLimitTier', () => {
  test('gives a key of a user the user tier and any other key the guest tier, as the config holds them', () => {
    const userId = uuidv7();
    const keys = {
      [`user:${userId}`]: 'user',
      [`user:${userId}:8.8.8.8`]: 'user',
      'ip:8.8.8.8': 'guest',
      'ip:unknown': 'guest',
      [`ip:user:${userId}`]: 'guest',
      [`USER:${userId}`]: 'guest',
      '': 'guest',
    };

    assert.deepEqual(
      mapValues(keys, (tier, key) => readLimitTier(DEFAULTS, key)),
      mapValues(keys, (tier) => DEFAULTS.tiers[tier]),
    );
    assert.equal(readLimitTier(DEFAULTS, `user:${userId}`), DEFAULTS.tiers.user);
    assert.equal(readLimitTier(DEFAULTS, 'ip:8.8.8.8'), DEFAULTS.tiers.guest);
  });
});

describe('assertRouteLimit', () => {
  test('passes false and every valid form: a max of its own or of a function, a window, a ban of null, of zero or above, a key of a function', () => {
    const limits = [
      false,
      { max: 5, window: '1m' },
      { max: readMax, window: '10s' },
      { max: 1, window: '0.5s' },
      { max: 5, window: '1h', ban: null },
      { max: 5, window: '1m', ban: 0 },
      { max: 5, window: '1m', ban: 3 },
      { max: 5, window: '1m', key: readOwnKey },
      {
        max: readMax,
        window: '1d',
        ban: null,
        key: readOwnKey,
      },
      { max: 5, window: '1m', ban: undefined },
    ];

    assert.deepEqual(limits.map((limit) => assertRouteLimit(limit)), limits.map(() => true));
  });

  test('passes the presets of config.rateLimit.routes the routes name, with a key or a max of their own', () => {
    const { auth, publicRead, report } = DEFAULTS.routes;
    const limits = [auth, publicRead, { ...auth, key: readOwnKey }, { max: readMax, window: report.window }];

    assert.deepEqual(limits.map((limit) => assertRouteLimit(limit)), limits.map(() => true));
  });

  test('refuses with a TypeError what is neither false nor an object', () => {
    const wrong = {
      true: true,
      null: null,
      undefined,
      zero: 0,
      'a text': 'strict',
      'a list': [{ max: 5, window: '1m' }],
      'a function': readMax,
      'a map': new Map([['max', 5]]),
    };

    Object.entries(wrong).forEach(([name, limit]) => {
      assert.throws(() => assertRouteLimit(limit), { name: 'TypeError', message: formMessage() }, name);
    });
  });

  test('refuses a key no limiter reads, and names it', () => {
    const unknown = ['timeWindow', 'maxWithKey', 'keyGenerator', 'Max', 'scope'];

    unknown.forEach((key) => {
      assert.throws(() => assertRouteLimit({ max: 5, window: '1m', [key]: 1 }), { name: 'TypeError', message: unknownKeyMessage(key) }, key);
    });
  });

  test('refuses a max that is no positive integer nor a function, and a window that is no duration above zero', () => {
    const wrong = {
      'no max': { window: '1m' },
      'max 0': { max: 0, window: '1m' },
      'max -1': { max: -1, window: '1m' },
      'max 1.5': { max: 1.5, window: '1m' },
      'max "5"': { max: '5', window: '1m' },
      'max NaN': { max: Number.NaN, window: '1m' },
      'max Infinity': { max: Infinity, window: '1m' },
      'max null': { max: null, window: '1m' },
      'no window': { max: 5 },
      'window "1x"': { max: 5, window: '1x' },
      'window 0': { max: 5, window: 0 },
      'window in ms as a number': { max: 5, window: 60000 },
      'window "-1m"': { max: 5, window: '-1m' },
      'window "0s"': { max: 5, window: '0s' },
      'window ""': { max: 5, window: '' },
      'window "100ms"': { max: 5, window: '100ms' },
    };

    Object.entries(wrong).forEach(([name, limit]) => {
      assert.throws(() => assertRouteLimit(limit), { name: 'TypeError', message: maxMessage() }, name);
    });
  });

  test('refuses a ban below zero or not whole, and a key that is no function', () => {
    const wrong = {
      'ban -1': { ban: -1 },
      'ban 1.5': { ban: 1.5 },
      'ban "3"': { ban: '3' },
      'ban false': { ban: false },
      'ban NaN': { ban: Number.NaN },
      'key "ip"': { key: 'ip' },
      'key {}': { key: {} },
      'key null': { key: null },
    };

    Object.entries(wrong).forEach(([name, changes]) => {
      assert.throws(() => assertRouteLimit({ max: 5, window: '1m', ...changes }), { name: 'TypeError', message: banMessage() }, name);
    });
  });

  test('names in its message what it is told the limit is', () => {
    const name = 'config.rateLimit of a test';

    assert.throws(() => assertRouteLimit(true, name), { name: 'TypeError', message: formMessage(name) });
    assert.throws(() => assertRouteLimit({ max: 0, window: '1m' }, name), { name: 'TypeError', message: maxMessage(name) });
    assert.throws(() => assertRouteLimit({ max: 5, window: '1m', ban: -1 }, name), { name: 'TypeError', message: banMessage(name) });
  });
});

describe('assertRateLimitConfig', () => {
  test('passes the default config, and one with no ban, a ban of zero and a preset of its own', () => {
    const configs = [
      DEFAULTS,
      { ...DEFAULTS, ban: null },
      { ...DEFAULTS, ban: 0 },
      withRoute('search', { max: 50, window: '10s', ban: null }),
      withRoute('plan', { max: readMax, window: '1h', key: readKey }),
      withTier('user', { max: 1000, window: '1h' }),
    ];

    assert.deepEqual(configs.map((config) => assertRateLimitConfig(config)), configs.map(() => true));
  });

  test('refuses a config without tiers or routes, or without the quota of POST /log/error', () => {
    const { tiers, routes, ...rest } = DEFAULTS;
    const { report, ...otherRoutes } = routes;
    const wrong = {
      'no config': undefined,
      null: null,
      'an empty one': {},
      'no tiers': { ...rest, routes },
      'no routes': { ...rest, tiers },
      'tiers as a list': { ...DEFAULTS, tiers: [tiers.guest, tiers.user] },
      'routes as a text': { ...DEFAULTS, routes: 'auth' },
      'no report preset': { ...DEFAULTS, routes: otherRoutes },
      'a report preset that is no object': withRoute('report', [report.max, report.window]),
    };

    Object.entries(wrong).forEach(([name, config]) => {
      assert.throws(() => assertRateLimitConfig(config), { name: 'TypeError', message: SECTIONS_MESSAGE }, name);
    });
  });

  test('refuses a tier that is missing or broken, and one with a key no limiter reads, a ban of its own among them, and names it', () => {
    const { guest } = DEFAULTS.tiers;
    const wrong = [
      ['guest', undefined],
      ['user', { max: 0, window: '1m' }],
      ['guest', { ...guest, max: '100' }],
      ['guest', { ...guest, max: readMax }],
      ['user', { max: 300, window: '1x' }],
      ['guest', { ...guest, window: undefined }],
      ['user', { max: 300, window: '1m', ban: 5 }],
      ['user', { max: 300, window: '1m', ban: null }],
      ['guest', { ...guest, key: readKey }],
      ['guest', 'strict'],
    ];

    wrong.forEach(([tier, preset], index) => {
      assert.throws(() => assertRateLimitConfig(withTier(tier, preset)), { name: 'TypeError', message: `config.rateLimit.tiers.${tier} ${TIER_TAIL}` }, String(index));
    });
  });

  test('refuses a route preset that is broken as security.rateLimit would be, and names it', () => {
    const { auth, publicRead } = DEFAULTS.routes;
    const wrong = [
      ['auth', { ...auth, max: '10' }, maxMessage('config.rateLimit.routes.auth')],
      ['auth', { ...auth, window: 0 }, maxMessage('config.rateLimit.routes.auth')],
      ['publicRead', { ...publicRead, ban: -1 }, banMessage('config.rateLimit.routes.publicRead')],
      ['publicRead', { ...publicRead, ban: 1.5 }, banMessage('config.rateLimit.routes.publicRead')],
      ['search', 'strict', formMessage('config.rateLimit.routes.search')],
      ['search', { max: 5 }, maxMessage('config.rateLimit.routes.search')],
      ['search', { max: 5, window: '1m', hook: 'preValidation' }, 'config.rateLimit.routes.search names "hook", which no limiter reads: it takes max, window, ban, key'],
    ];

    wrong.forEach(([route, preset, message], index) => {
      assert.throws(() => assertRateLimitConfig(withRoute(route, preset)), { name: 'TypeError', message }, String(index));
    });
  });

  test('refuses ceilings of counters that are no positive integers', () => {
    const wrong = [
      ['memoryMaxEntries', 0],
      ['memoryMaxEntries', 1.5],
      ['memoryMaxEntries', undefined],
      ['reportMaxEntries', '1000'],
      ['reportMaxEntries', -1],
    ];

    wrong.forEach(([key, value]) => {
      assert.throws(() => assertRateLimitConfig({ ...DEFAULTS, [key]: value }), { name: 'TypeError', message: `config.rateLimit.${key} ${COUNT_TAIL}` }, `${key} ${value}`);
    });
  });

  test('refuses a ban below zero or not whole, and a reportWindow that is no duration above zero', () => {
    const wrong = {
      'ban -1': { ban: -1 },
      'ban 1.5': { ban: 1.5 },
      'ban "30"': { ban: '30' },
      'reportWindow "0s"': { reportWindow: '0s' },
      'reportWindow "1x"': { reportWindow: '1x' },
      'reportWindow in ms as a number': { reportWindow: 60000 },
      'no reportWindow': { reportWindow: undefined },
    };

    Object.entries(wrong).forEach(([name, changes]) => {
      assert.throws(() => assertRateLimitConfig({ ...DEFAULTS, ...changes }), { name: 'TypeError', message: BAN_WINDOW_MESSAGE }, name);
    });
  });

  test('refuses routes.report without a maxWithKey that is a positive integer, which the intake of logs reads for a sender with the key, and one with a ban of its own, which it takes from config.rateLimit', () => {
    const { report } = DEFAULTS.routes;
    const wrong = {
      'no maxWithKey': withRoute('report', { max: report.max, window: report.window }),
      'maxWithKey 0': withReport({ maxWithKey: 0 }),
      'maxWithKey "100"': withReport({ maxWithKey: '100' }),
      'maxWithKey 1.5': withReport({ maxWithKey: 1.5 }),
      'max 0': withReport({ max: 0 }),
      'window "1x"': withReport({ window: '1x' }),
      'a ban of its own': withReport({ ban: null }),
    };

    Object.entries(wrong).forEach(([name, config]) => {
      assert.throws(() => assertRateLimitConfig(config), { name: 'TypeError', message: REPORT_MESSAGE }, name);
    });
  });
});

describe('toPluginBan', () => {
  test('gives -1, what the plugin reads as no ban, for null, and any ban as it is', () => {
    assert.deepEqual([null, 0, 1, 30].map((ban) => toPluginBan(ban)), [-1, 0, 1, 30]);
  });
});

describe('toRouteLimit', () => {
  test('keeps false: a route without a limit', () => {
    assert.equal(toRouteLimit(false, DEFAULTS), false);
  });

  test('gives max, the window as it is written and timeWindow in milliseconds, with the ban of the config when the route names none', () => {
    assert.deepEqual(toRouteLimit({ max: 10, window: '1m' }, DEFAULTS), {
      max: 10,
      window: '1m',
      timeWindow: 60000,
      ban: 30,
    });
    assert.deepEqual(['0.5s', '10s', '1.5h', '1d'].map((window) => toRouteLimit({ max: 1, window }, DEFAULTS).timeWindow), [500, 10000, 5400000, 86400000]);
  });

  test('gives -1 for a ban of null in the route or in the config, and keeps a ban the route names over that of the config', () => {
    const noBan = { ...DEFAULTS, ban: null };

    assert.deepEqual([
      toRouteLimit({ max: 10, window: '1m' }, noBan).ban,
      toRouteLimit({ max: 10, window: '1m', ban: null }, DEFAULTS).ban,
      toRouteLimit({ max: 10, window: '1m', ban: 0 }, DEFAULTS).ban,
      toRouteLimit({ max: 10, window: '1m', ban: 5 }, noBan).ban,
      toRouteLimit(DEFAULTS.routes.publicRead, DEFAULTS).ban,
      toRouteLimit(DEFAULTS.routes.auth, DEFAULTS).ban,
    ], [-1, -1, 0, 5, -1, 30]);
  });

  test('passes a max of a function on as it is', () => {
    assert.equal(toRouteLimit({ max: readMax, window: '1m' }, DEFAULTS).max, readMax);
  });

  test('gives keyGenerator only for a key the route names: no key that is undefined would override the key of the plugin', () => {
    const plugin = {
      max: 100,
      timeWindow: 60000,
      ban: 30,
      keyGenerator: readOwnKey,
    };
    const withKey = toRouteLimit({ max: 10, window: '1m', key: readMax }, DEFAULTS);
    const withoutKey = toRouteLimit({ max: 10, window: '1m' }, DEFAULTS);
    const withUndefinedKey = toRouteLimit({ max: 10, window: '1m', key: undefined }, DEFAULTS);

    assert.equal(withKey.keyGenerator, readMax);
    assert.deepEqual([withoutKey, withUndefinedKey].map((limit) => Object.hasOwn(limit, 'keyGenerator')), [false, false]);
    assert.equal({ ...plugin, ...withoutKey }.keyGenerator, readOwnKey);
    assert.equal({ ...plugin, ...withKey }.keyGenerator, readMax);
  });
});
