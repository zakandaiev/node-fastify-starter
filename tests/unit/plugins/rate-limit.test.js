import { RATE_LIMIT_DECORATOR } from '#core/schema/route.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import {
  accept,
  createAlertReceiver,
  NO_THROTTLE,
  readBlock,
} from '#root/tests/helper/alert.js';
import { errorBody, readRequestId, successBody } from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { issueFor, NO_STORE } from '#root/tests/helper/guard.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { buildDownApp, toBearer } from '#root/tests/helper/session.js';
import { sortBy } from '#utils/array.js';
import { mapSeries } from '#utils/async.js';
import { convertStringToMs } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PING_URL = '/ping';
const PONG_URL = '/pong';
const LIVE_URL = '/health/live';

const GUEST_MAX = 2;
const USER_MAX = 4;
const WINDOW = '1m';
const WINDOW_SECONDS = 60;

const TIERS = Object.freeze({
  guest: Object.freeze({ max: GUEST_MAX, window: WINDOW }),
  user: Object.freeze({ max: USER_MAX, window: WINDOW }),
});

const SHORT_WINDOW = '0.3s';
const SHORT_WINDOW_MS = convertStringToMs(SHORT_WINDOW);
const SHORT_TIERS = Object.freeze({
  guest: Object.freeze({ max: GUEST_MAX, window: SHORT_WINDOW }),
  user: Object.freeze({ max: USER_MAX, window: SHORT_WINDOW }),
});

// Retry-After is rounded up to a whole second: a window shorter than one still says 1.
const SHORT_WINDOW_SECONDS = 1;

// The dedupe mark of an alert ends before reportWindow does: the alert of the next window is not held back by it.
const SHORT_REPORT_WINDOW = '0.3s';
const SHORT_DEDUPE_TTL = '0.1s';

const BAN = 1;

const EXCEEDED_MESSAGE = 'Rate limit exceeded';
const BANNED_MESSAGE = 'Rate limit ban reached';
const WARNING_CLASS = 'warning';

// inject() comes from loopback with no header that names a client: an internal request, never counted. A client is
// named in X-Forwarded-For, which loopback, a trusted proxy, may write; a socket of its own must have a public address.
const CLIENT = '8.8.8.8';
const NEIGHBOUR = '8.8.4.4';
const PUBLIC_SOCKET = '1.1.1.1';
const PRIVATE_SOCKET = '10.1.2.3';
const IPV6_LOOPBACK = '::1';

const OTHER_ACCESS_SECRET = 'another-access-secret-0123456789-abcdef';

const WHOLE_SECONDS_REGEXP = /^[1-9]\d*$/;
const LIMIT_HEADER_REGEXP = /^(x-)?ratelimit/;
const KEY_FIELD_REGEXP = /key/i;

const TOKEN_SEPARATOR = '.';

function answerDone() {
  return { isDone: true };
}

async function buildLimitedApp(t, { rateLimit = {}, receiver, alert = {} } = {}) {
  const sink = createLogSink();
  const fastify = await buildDownApp(t, {
    env: { ...receiver?.env.webhook },
    rateLimit: { tiers: TIERS, ...rateLimit },
    alert: { ...receiver?.config.alert, throttleWindow: NO_THROTTLE, ...alert },
    logger: { level: 'info', stream: sink.stream },
  });

  fastify.get(PING_URL, answerDone);
  fastify.get(PONG_URL, answerDone);

  return { fastify, sink };
}

function limitRoute(fastify, url, rateLimit) {
  fastify.get(url, { security: { auth: false, rateLimit } }, answerDone);
}

function fromAddress(address, request = {}) {
  return {
    url: PING_URL,
    ...request,
    headers: { [HEADER.X_FORWARDED_FOR]: address, ...request.headers },
  };
}

function repeat(count, item) {
  return Array.from({ length: count }, () => item);
}

function sendInTurn(fastify, requests) {
  return mapSeries(requests, (request) => fastify.inject(request));
}

function readStatuses(responses) {
  return responses.map((response) => response.statusCode);
}

function listLimitHeaders(response) {
  return Object.keys(response.headers).filter((name) => LIMIT_HEADER_REGEXP.test(name));
}

function assertLimited(response, windowSeconds = WINDOW_SECONDS) {
  const retryAfter = response.headers[HEADER.RETRY_AFTER];

  assert.equal(response.statusCode, 429);
  assert.deepEqual(response.json(), errorBody(response, 'RATE_LIMIT_ERROR', 'Rate limit exceeded'));
  assert.equal(response.headers[HEADER.CACHE_CONTROL], NO_STORE);
  assert.match(retryAfter, WHOLE_SECONDS_REGEXP);
  assert.ok(Number(retryAfter) <= windowSeconds, `Retry-After ${retryAfter} is longer than the window`);
}

function reportOf(route, bucket, { max = GUEST_MAX, window = WINDOW } = {}) {
  return {
    route,
    bucket,
    max,
    window,
  };
}

function readReports(sink, message = EXCEEDED_MESSAGE) {
  return findLogLines(sink, message).map((line) => line.rateLimit);
}

function waitForAlerts(receiver, count) {
  return waitFor(() => receiver.requests.length >= count && receiver.requests, `${count} alert(s) at the receiver`);
}

function describeAlert({ body }) {
  return { title: body.title, throttleClass: body.throttleClass, error: readBlock(body, 'Error') };
}

function alertOf(title, report) {
  return { title, throttleClass: WARNING_CLASS, error: { message: title, ...report } };
}

function swapPayload(token, donor) {
  const [header, , signature] = token.split(TOKEN_SEPARATOR);
  const [, payload] = donor.split(TOKEN_SEPARATOR);

  return [header, payload, signature].join(TOKEN_SEPARATOR);
}

function listForgeries({ victim, intruder, other }) {
  const foreignToken = issueFor(other, [], { userId: victim.userId }).accessToken;

  return {
    'an access token of another secret in the cookie': () => ({ cookies: { [COOKIE.ACCESS_TOKEN]: foreignToken } }),
    'an access token of another secret as Bearer': () => ({ headers: toBearer(foreignToken) }),
    'a token of another secret for a new user on every request': () => ({ headers: toBearer(issueFor(other).accessToken) }),
    'the payload of the user under the signature of another token': () => ({ headers: toBearer(swapPayload(intruder.accessToken, victim.accessToken)) }),
    'the access token of the user cut short': () => ({ cookies: { [COOKIE.ACCESS_TOKEN]: victim.accessToken.slice(0, -1) } }),
    'the refresh token of the user in the cookie of the access token': () => ({ cookies: { [COOKIE.ACCESS_TOKEN]: victim.refreshToken } }),
    'the refresh token of the user as Bearer': () => ({ headers: toBearer(victim.refreshToken) }),
    'the refresh cookie of the user alone': () => ({ cookies: { [COOKIE.REFRESH_TOKEN]: victim.refreshToken } }),
    'garbage in the cookie': () => ({ cookies: { [COOKIE.ACCESS_TOKEN]: 'garbage' } }),
    'garbage as Bearer': () => ({ headers: toBearer('garbage') }),
    'a new garbage value on every request': (index) => ({ headers: toBearer(`garbage.${index}.${uuidv7()}`) }),
  };
}

function forgerAddress(index) {
  return `9.9.${index}.1`;
}

describe('rate-limit plugin', () => {
  test('is registered under the name "rate-limit" and marks the requests of what it reaches, as the route hook looks for', async (t) => {
    const fastify = await buildDownApp(t);

    assert.equal(fastify.hasPlugin('rate-limit'), true);
    assert.equal(fastify.hasRequestDecorator(RATE_LIMIT_DECORATOR), true);
  });
});

describe('rate-limit plugin: the tiers', () => {
  test('refuses the guest of an address past the guest tier while a user from it goes on to the user tier: 429 RATE_LIMIT_ERROR with Retry-After in whole seconds of the window and no-store, and no x-ratelimit-* header on any answer', async (t) => {
    const { fastify } = await buildLimitedApp(t);
    const user = issueFor(fastify);
    const ofGuest = await sendInTurn(fastify, repeat(GUEST_MAX + 1, fromAddress(CLIENT)));
    const ofUser = await sendInTurn(fastify, repeat(USER_MAX + 1, fromAddress(CLIENT, { headers: user.headers })));
    const answered = [...ofGuest.slice(0, -1), ...ofUser.slice(0, -1)];

    assert.deepEqual(readStatuses(ofGuest), [200, 200, 429]);
    assert.deepEqual(readStatuses(ofUser), [200, 200, 200, 200, 429]);
    [ofGuest.at(-1), ofUser.at(-1)].forEach((refusal) => assertLimited(refusal));
    answered.forEach((response) => {
      assert.deepEqual(response.json(), answerDone());
      assert.equal(response.headers[HEADER.RETRY_AFTER], undefined);
    });
    assert.deepEqual([...ofGuest, ...ofUser].flatMap((response) => listLimitHeaders(response)), []);
  });

  test('gives two users behind one address a quota each, by the user and not by the address, and the guests of that address a bucket of their own', async (t) => {
    const { fastify } = await buildLimitedApp(t);
    const [first, second] = [issueFor(fastify), issueFor(fastify)];
    const ofFirst = await sendInTurn(fastify, repeat(USER_MAX + 1, fromAddress(CLIENT, { headers: first.headers })));
    const ofSecond = await sendInTurn(fastify, repeat(USER_MAX + 1, fromAddress(CLIENT, { headers: second.headers })));
    const ofGuests = await sendInTurn(fastify, repeat(GUEST_MAX + 1, fromAddress(CLIENT)));
    const ofFirstElsewhere = await fastify.inject(fromAddress(NEIGHBOUR, { headers: first.headers }));

    assert.deepEqual([ofFirst, ofSecond, ofGuests].map((responses) => readStatuses(responses)), [
      [200, 200, 200, 200, 429],
      [200, 200, 200, 200, 429],
      [200, 200, 429],
    ]);
    assertLimited(ofFirstElsewhere);
  });

  test('counts the cookie and the Bearer header of one user in one bucket', async (t) => {
    const { fastify } = await buildLimitedApp(t);
    const user = issueFor(fastify);
    const byCookie = fromAddress(CLIENT, { cookies: user.cookies });
    const byBearer = fromAddress(CLIENT, { headers: user.headers });
    const responses = await sendInTurn(fastify, [byCookie, byBearer, byCookie, byBearer, byCookie, byBearer]);

    assert.deepEqual(readStatuses(responses), [200, 200, 200, 200, 429, 429]);
  });

  test('counts a request before auth: a guest without a token on a route that needs one is refused 429 past the guest tier, not 401', async (t) => {
    const { fastify } = await buildLimitedApp(t);

    fastify.get('/guarded', { security: { auth: true } }, answerDone);

    const responses = await sendInTurn(fastify, repeat(GUEST_MAX + 1, fromAddress(CLIENT, { url: '/guarded' })));

    assert.deepEqual(readStatuses(responses), [401, 401, 429]);
    assertLimited(responses.at(-1));
  });
});

describe('rate-limit plugin: a forged token', () => {
  test('is counted as the guest of its address and leaves the whole quota to the user it names: another secret, a new user on every request, a swapped payload, a cut token, a refresh token, garbage, a new garbage value on every request', async (t) => {
    const { fastify, sink } = await buildLimitedApp(t);
    const other = await buildDownApp(t, { env: { APP_JWT_ACCESS_SECRET: OTHER_ACCESS_SECRET } });
    const victim = issueFor(fastify);
    const forgeries = listForgeries({ victim, intruder: issueFor(fastify), other });
    const names = Object.keys(forgeries);
    const ofForgers = await mapSeries(names, async (name, index) => {
      const forged = repeat(GUEST_MAX + 1, null).map((value, at) => fromAddress(forgerAddress(index), forgeries[name](at)));
      const responses = await sendInTurn(fastify, [...forged, fromAddress(forgerAddress(index))]);

      return [name, readStatuses(responses)];
    });
    const reportsOfForgers = readReports(sink);
    const ofVictim = await sendInTurn(fastify, repeat(USER_MAX + 1, fromAddress(CLIENT, { cookies: victim.cookies })));

    assert.deepEqual(ofForgers, names.map((name) => [name, [200, 200, 429, 429]]));
    assert.deepEqual(reportsOfForgers.map((report) => report.bucket), names.map((name, index) => `ip:${forgerAddress(index)}`));
    assert.deepEqual(readStatuses(ofVictim), [200, 200, 200, 200, 429]);
    assert.deepEqual(readReports(sink).at(-1), reportOf(`GET ${PING_URL}`, `user:${victim.userId}`, { max: USER_MAX }));
  });
});

describe('rate-limit plugin: a ban', () => {
  test('answers a client above max + ban within one window with the same 429 RATE_LIMIT_ERROR, never 403, and tells it in one line and one alert of its own besides those of the excess', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await buildLimitedApp(t, { receiver, rateLimit: { ban: BAN } });
    const request = fromAddress(CLIENT);
    const beforeBan = await sendInTurn(fastify, repeat(GUEST_MAX + BAN, request));
    const bansBefore = readReports(sink, BANNED_MESSAGE);
    const banned = await sendInTurn(fastify, repeat(3, request));
    const report = reportOf(`GET ${PING_URL}`, `ip:${CLIENT}`);

    assert.deepEqual(readStatuses([...beforeBan, ...banned]), [200, 200, 429, 429, 429, 429]);
    [...beforeBan.slice(GUEST_MAX), ...banned].forEach((response) => assertLimited(response));
    assert.deepEqual(bansBefore, []);
    assert.deepEqual(readReports(sink, EXCEEDED_MESSAGE), [report]);
    assert.deepEqual(readReports(sink, BANNED_MESSAGE), [report]);
    assert.deepEqual(findLogLines(sink, BANNED_MESSAGE).map((line) => line.level), [LOG_LEVEL.WARN]);

    const alerts = await waitForAlerts(receiver, 2);

    assert.equal(alerts.length, 2);
    assert.deepEqual(sortBy(alerts.map((alert) => describeAlert(alert)), 'title'), [
      alertOf(BANNED_MESSAGE, report),
      alertOf(EXCEEDED_MESSAGE, report),
    ]);
  });

  test('takes the ban a route names: null never bans, 0 bans at the first refusal, and none named takes that of config.rateLimit', async (t) => {
    const { fastify, sink } = await buildLimitedApp(t, { rateLimit: { ban: BAN } });

    limitRoute(fastify, '/never', { max: 1, window: WINDOW, ban: null });
    limitRoute(fastify, '/at-once', { max: 1, window: WINDOW, ban: 0 });
    limitRoute(fastify, '/inherited', { max: 1, window: WINDOW });

    const responses = await mapSeries(['/never', '/at-once', '/inherited'], (url) => sendInTurn(fastify, repeat(5, fromAddress(CLIENT, { url }))));

    assert.deepEqual(responses.map((series) => readStatuses(series)), repeat(3, [200, 429, 429, 429, 429]));
    responses.flatMap((series) => series.slice(1)).forEach((response) => assertLimited(response));
    assert.deepEqual(readReports(sink, BANNED_MESSAGE), ['/at-once', '/inherited'].map((url) => reportOf(`GET ${url}`, `ip:${CLIENT}`, { max: 1 })));
  });
});

describe('rate-limit plugin: the window', () => {
  test('is not extended by the refused requests: once the window the first request opened has passed, requests pass again with a whole quota', async (t) => {
    const { fastify } = await buildLimitedApp(t, { rateLimit: { tiers: SHORT_TIERS } });
    const request = fromAddress(CLIENT);

    // By the clock the store of the plugin measures its window with.
    const openedAt = Date.now();
    const opened = await sendInTurn(fastify, repeat(GUEST_MAX, request));
    const refusals = [];
    const passed = await waitFor(async () => {
      const response = await fastify.inject(request);

      if (response.statusCode === 429) {
        refusals.push(response);
      }

      return response.statusCode === 200 && response;
    }, 'a request that passes once the window is over');
    const passedAfterMs = Date.now() - openedAt;
    const next = await sendInTurn(fastify, repeat(GUEST_MAX, request));

    assert.deepEqual(readStatuses(opened), [200, 200]);
    assert.ok(refusals.length > 0, 'no request was refused within the window');
    assert.ok(passedAfterMs >= SHORT_WINDOW_MS, `a request passed ${passedAfterMs} ms after the window opened`);
    refusals.forEach((refusal) => assertLimited(refusal, SHORT_WINDOW_SECONDS));
    assert.deepEqual(refusals.map((refusal) => refusal.headers[HEADER.RETRY_AFTER]), repeat(refusals.length, String(SHORT_WINDOW_SECONDS)));
    assert.deepEqual(passed.json(), answerDone());
    assert.deepEqual(readStatuses(next), [200, 429]);
  });
});

describe('rate-limit plugin: the reports', () => {
  test('writes one warn line "Rate limit exceeded" and sends one warning alert for each route and key within reportWindow, with the route, the bucket, max and window and no field named after a key', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await buildLimitedApp(t, { receiver });
    const user = issueFor(fastify);

    await sendInTurn(fastify, [
      ...repeat(GUEST_MAX + 3, fromAddress(CLIENT)),
      ...repeat(2, fromAddress(CLIENT, { url: PONG_URL })),
      ...repeat(GUEST_MAX + 2, fromAddress(NEIGHBOUR)),
      ...repeat(USER_MAX + 2, fromAddress(CLIENT, { headers: user.headers })),
    ]);

    const lines = findLogLines(sink, EXCEEDED_MESSAGE);
    const reports = [
      reportOf(`GET ${PING_URL}`, `ip:${CLIENT}`),
      reportOf(`GET ${PONG_URL}`, `ip:${CLIENT}`),
      reportOf(`GET ${PING_URL}`, `ip:${NEIGHBOUR}`),
      reportOf(`GET ${PING_URL}`, `user:${user.userId}`, { max: USER_MAX }),
    ];

    assert.deepEqual(lines.map((line) => [line.level, line.rateLimit]), reports.map((report) => [LOG_LEVEL.WARN, report]));
    assert.deepEqual(lines.flatMap((line) => [...Object.keys(line), ...Object.keys(line.rateLimit)]).filter((name) => KEY_FIELD_REGEXP.test(name)), []);

    const alerts = await waitForAlerts(receiver, reports.length);

    assert.equal(alerts.length, reports.length);
    assert.deepEqual(
      sortBy(alerts.map((alert) => describeAlert(alert)), (alert) => `${alert.error.route} ${alert.error.bucket}`),
      sortBy(reports, (report) => `${report.route} ${report.bucket}`).map((report) => alertOf(EXCEEDED_MESSAGE, report)),
    );
  });

  test('reports a route and a key again, in a line and an alert, once reportWindow has passed', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await buildLimitedApp(t, {
      receiver,
      rateLimit: { reportWindow: SHORT_REPORT_WINDOW },
      alert: { dedupeTtl: SHORT_DEDUPE_TTL },
    });
    const request = fromAddress(CLIENT);

    await sendInTurn(fastify, repeat(GUEST_MAX + 3, request));

    const firstReports = readReports(sink);

    await waitForAlerts(receiver, 1);
    await waitFor(async () => {
      await fastify.inject(request);

      return readReports(sink).length > 1;
    }, 'the report of the next window');

    const report = reportOf(`GET ${PING_URL}`, `ip:${CLIENT}`);
    const alerts = await waitForAlerts(receiver, 2);

    assert.deepEqual(firstReports, [report]);
    assert.deepEqual(readReports(sink), [report, report]);
    assert.equal(alerts.length, 2);
    assert.deepEqual(alerts.map((alert) => describeAlert(alert)), repeat(2, alertOf(EXCEEDED_MESSAGE, report)));
  });
});

describe('rate-limit plugin: the address', () => {
  test('counts the addresses of one IPv6 /64 in one bucket and those of another /64 in another, and an IPv4-mapped address with its IPv4 one', async (t) => {
    const { fastify, sink } = await buildLimitedApp(t);
    const responses = await sendInTurn(fastify, [
      '2a00:1450:4001:81a::1',
      '2A00:1450:4001:81A:FFFF:FFFF:FFFF:FFFE',
      '2a00:1450:4001:81a::abcd',
      '2a00:1450:4001:81b::1',
      '::ffff:8.8.8.8',
      '8.8.8.8',
      '::ffff:8.8.8.8',
    ].map((address) => fromAddress(address)));

    assert.deepEqual(readStatuses(responses), [200, 200, 429, 200, 200, 200, 429]);
    assert.deepEqual(readReports(sink).map((report) => report.bucket), ['ip:2a00:1450:4001:81a::', 'ip:8.8.8.8']);
  });

  test('never counts an internal request, from loopback or a private socket without a header that names a client, and counts the same socket by the address X-Forwarded-For names, and by its own with another such header', async (t) => {
    const { fastify, sink } = await buildLimitedApp(t);
    const internal = await sendInTurn(fastify, [
      ...repeat(GUEST_MAX * 3, { url: PING_URL }),
      ...repeat(GUEST_MAX * 3, { url: PING_URL, remoteAddress: IPV6_LOOPBACK }),
      ...repeat(GUEST_MAX * 3, { url: PING_URL, remoteAddress: PRIVATE_SOCKET }),
    ]);
    const forwarded = await sendInTurn(fastify, [
      ...repeat(GUEST_MAX + 1, fromAddress(CLIENT, { remoteAddress: PRIVATE_SOCKET })),
      fromAddress(CLIENT),
    ]);
    const named = await sendInTurn(fastify, repeat(GUEST_MAX + 1, { url: PING_URL, remoteAddress: PRIVATE_SOCKET, headers: { [HEADER.X_REAL_IP]: NEIGHBOUR } }));
    const ofPublicSocket = await sendInTurn(fastify, repeat(GUEST_MAX + 1, { url: PING_URL, remoteAddress: PUBLIC_SOCKET }));

    assert.deepEqual(readStatuses(internal), repeat(internal.length, 200));
    assert.deepEqual([forwarded, named, ofPublicSocket].map((responses) => readStatuses(responses)), [
      [200, 200, 429, 429],
      [200, 200, 429],
      [200, 200, 429],
    ]);
    assert.deepEqual(readReports(sink).map((report) => report.bucket), [`ip:${CLIENT}`, `ip:${PRIVATE_SOCKET}`, `ip:${PUBLIC_SOCKET}`]);
  });

  test('leaves /health/live outside the limiter: many probes from one public address are all answered, and they take nothing of its quota', async (t) => {
    const { fastify } = await buildLimitedApp(t);
    const probes = await sendInTurn(fastify, repeat(GUEST_MAX * 3, { url: LIVE_URL, remoteAddress: PUBLIC_SOCKET }));
    const headProbes = await sendInTurn(fastify, repeat(GUEST_MAX * 3, { method: 'HEAD', url: LIVE_URL, remoteAddress: PUBLIC_SOCKET }));
    const pings = await sendInTurn(fastify, repeat(GUEST_MAX + 1, { url: PING_URL, remoteAddress: PUBLIC_SOCKET }));

    assert.deepEqual(readStatuses([...probes, ...headProbes]), repeat(probes.length + headProbes.length, 200));
    probes.forEach((response) => {
      assert.deepEqual(response.json(), successBody(response, { isAlive: true }));
    });
    assert.deepEqual(readStatuses(pings), [200, 200, 429]);
  });
});

describe('rate-limit plugin: security.rateLimit of a route', () => {
  test('counts a limit of its own apart from the tiers: it neither takes from the global quota of a client nor is taken from it, and a user gets its max too', async (t) => {
    const { fastify, sink } = await buildLimitedApp(t);
    const user = issueFor(fastify);

    limitRoute(fastify, '/own', { max: 1, window: WINDOW });

    const ofClient = await sendInTurn(fastify, [
      ...repeat(GUEST_MAX + 1, fromAddress(CLIENT)),
      ...repeat(2, fromAddress(CLIENT, { url: '/own' })),
    ]);
    const ofNeighbour = await sendInTurn(fastify, [
      ...repeat(2, fromAddress(NEIGHBOUR, { url: '/own' })),
      ...repeat(GUEST_MAX + 1, fromAddress(NEIGHBOUR)),
    ]);
    const ofUser = await sendInTurn(fastify, repeat(2, fromAddress(CLIENT, { url: '/own', headers: user.headers })));

    assert.deepEqual([ofClient, ofNeighbour, ofUser].map((responses) => readStatuses(responses)), [
      [200, 200, 429, 200, 429],
      [200, 429, 200, 200, 429],
      [200, 429],
    ]);
    assert.deepEqual(readReports(sink).filter((report) => report.route === 'GET /own'), [
      reportOf('GET /own', `ip:${CLIENT}`, { max: 1 }),
      reportOf('GET /own', `ip:${NEIGHBOUR}`, { max: 1 }),
      reportOf('GET /own', `user:${user.userId}`, { max: 1 }),
    ]);
  });

  test('asks a function max on every counted request with the request and the key, limits by what it gives and reports that max', async (t) => {
    const { fastify, sink } = await buildLimitedApp(t);
    const user = issueFor(fastify);
    const asked = [];

    function readPlanMax(request, key) {
      asked.push([request.id, key]);

      return key.startsWith('user:')
        ? 3
        : 1;
    }

    limitRoute(fastify, '/plan', { max: readPlanMax, window: WINDOW });

    const ofGuest = await sendInTurn(fastify, repeat(2, fromAddress(CLIENT, { url: '/plan' })));
    const ofUser = await sendInTurn(fastify, repeat(4, fromAddress(CLIENT, { url: '/plan', headers: user.headers })));
    const internal = await fastify.inject('/plan');
    const keys = new Map(asked);

    assert.deepEqual([readStatuses(ofGuest), readStatuses(ofUser), internal.statusCode], [[200, 429], [200, 200, 200, 429], 200]);
    assert.deepEqual([...ofGuest, ...ofUser].map((response) => keys.get(readRequestId(response))), [
      ...repeat(2, `ip:${CLIENT}`),
      ...repeat(4, `user:${user.userId}`),
    ]);
    assert.equal(keys.has(readRequestId(internal)), false);
    assert.deepEqual(readReports(sink), [
      reportOf('GET /plan', `ip:${CLIENT}`, { max: 1 }),
      reportOf('GET /plan', `user:${user.userId}`, { max: 3 }),
    ]);
  });

  test('counts by the key a function of the route gives, whatever the address or the user, and still never counts an internal request', async (t) => {
    const { fastify, sink } = await buildLimitedApp(t);
    const user = issueFor(fastify);

    function readTeamKey(request) {
      return `team:${request.headers['x-team']}`;
    }

    limitRoute(fastify, '/team', { max: 1, window: WINDOW, key: readTeamKey });

    const responses = await sendInTurn(fastify, [
      fromAddress(CLIENT, { url: '/team', headers: { 'x-team': 'red' } }),
      fromAddress(NEIGHBOUR, { url: '/team', headers: { 'x-team': 'red' } }),
      fromAddress(NEIGHBOUR, { url: '/team', headers: { 'x-team': 'blue' } }),
      fromAddress(CLIENT, { url: '/team', headers: { 'x-team': 'blue', ...user.headers } }),
      { url: '/team', headers: { 'x-team': 'red' } },
    ]);

    assert.deepEqual(readStatuses(responses), [200, 429, 200, 429, 200]);
    assert.deepEqual(readReports(sink).map((report) => report.bucket), ['team:red', 'team:blue']);
  });

  test('never limits a route with security.rateLimit: false, and its requests take nothing of the global quota', async (t) => {
    const { fastify, sink } = await buildLimitedApp(t);

    limitRoute(fastify, '/free', false);

    const free = await sendInTurn(fastify, repeat(GUEST_MAX * 3, fromAddress(CLIENT, { url: '/free' })));
    const pings = await sendInTurn(fastify, repeat(GUEST_MAX + 1, fromAddress(CLIENT)));

    assert.deepEqual(readStatuses(free), repeat(free.length, 200));
    assert.deepEqual(readStatuses(pings), [200, 200, 429]);
    assert.deepEqual(readReports(sink).map((report) => report.route), [`GET ${PING_URL}`]);
  });

  test('counts a GET and its HEAD twin in the one counter of the route', async (t) => {
    const { fastify } = await buildLimitedApp(t);

    limitRoute(fastify, '/twin', { max: 2, window: WINDOW });

    const responses = await sendInTurn(fastify, ['GET', 'HEAD', 'GET', 'HEAD'].map((method) => fromAddress(CLIENT, { method, url: '/twin' })));

    assert.deepEqual(readStatuses(responses), [200, 200, 429, 429]);
  });

  test('counts the "/" of a prefix in one counter whatever the spelling: the GET, its HEAD twin, and both with the slash', async (t) => {
    const { fastify } = await buildLimitedApp(t);

    await fastify.register(async (scope) => {
      scope.get('/', { security: { auth: false, rateLimit: { max: 2, window: WINDOW } } }, answerDone);
    }, { prefix: '/things' });

    const responses = await sendInTurn(fastify, [
      ['GET', '/things'],
      ['HEAD', '/things/'],
      ['GET', '/things/'],
      ['HEAD', '/things'],
    ].map(([method, url]) => fromAddress(CLIENT, { method, url })));

    assert.deepEqual(readStatuses(responses), [200, 200, 429, 429]);
  });

  test('asks an async max once for each counted request and reports the max it gave, not a second call of it', async (t) => {
    const { fastify, sink } = await buildLimitedApp(t);
    let callCount = 0;

    async function readStoredMax() {
      callCount += 1;

      if (callCount > 2) {
        throw new Error('a store that fails on a third call');
      }

      return 1;
    }

    limitRoute(fastify, '/stored', { max: readStoredMax, window: WINDOW });

    const responses = await sendInTurn(fastify, repeat(2, fromAddress(CLIENT, { url: '/stored' })));

    assert.deepEqual(readStatuses(responses), [200, 429]);
    assert.equal(callCount, 2);
    assert.deepEqual(readReports(sink), [reportOf('GET /stored', `ip:${CLIENT}`, { max: 1 })]);
  });
});
