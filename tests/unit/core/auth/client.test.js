import { SCHEMA_LIMITS } from '#config/schema.js';
import { CLIENT_ADDRESS_HEADERS, isLoopbackOnlyRequest, readClient } from '#core/auth/client.js';
import { HEADER } from '#enums/header.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import * as sessionSchema from '#schemas/entity/session.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The length of sessions.user_agent.
const USER_AGENT_LENGTH = 255;
const IP_LENGTH = 45;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0';
const IP = '203.0.113.7';
const PROXY_IP = '10.0.0.5';

const NO_BREAK_SPACE = String.fromCharCode(0xA0);

// Two UTF-16 units of one character.
const PAIR = String.fromCodePoint(0x1F600);

// An address of 45 characters is the longest text of one, and a zone makes it longer.
const LONGEST_IP = 'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255';
const ZONED_IP = `fe80::1%${'z'.repeat(IP_LENGTH)}`;

const LOOPBACK = '127.0.0.1';
const LAN_IP = '192.168.1.20';
const DEV_SERVER_HOST = 'localhost:5173';

// APP_HOST of the tests is "app.test".
const TEST_CONFIG = createTestConfig();

const PROXY_HEADERS = Object.freeze(CLIENT_ADDRESS_HEADERS.filter((name) => name !== HEADER.X_FORWARDED_FOR));

function read({ userAgent = USER_AGENT, ip = IP } = {}) {
  return readClient({ headers: { [HEADER.USER_AGENT]: userAgent }, ip });
}

// A Host of null is a request without one.
function isLocal({
  socket = { remoteAddress: LOOPBACK },
  host = DEV_SERVER_HOST,
  headers = {},
  config = TEST_CONFIG,
} = {}) {
  return isLoopbackOnlyRequest({
    socket,
    headers: host === null
      ? headers
      : { [HEADER.HOST]: host, ...headers },
    server: { config },
  });
}

// The values a check lets in, and those it shuts out: a failure names them.
function listLetIn(values, toOptions) {
  return values.filter((value) => isLocal(toOptions(value)));
}

function listShutOut(values, toOptions) {
  return values.filter((value) => !isLocal(toOptions(value)));
}

async function buildApp(t) {
  const fastify = await buildTestApp({ env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()) } });

  t.after(() => fastify.close());
  fastify.get('/client', (request) => readClient(request));
  fastify.get('/local', (request) => ({
    isLocal: isLoopbackOnlyRequest(request),
    ip: request.ip,
    hostname: request.hostname,
  }));

  return fastify;
}

describe('readClient: the user agent', () => {
  test('is given as it came up to the length of its column', () => {
    const longest = 'a'.repeat(USER_AGENT_LENGTH);

    assert.deepEqual(read(), { userAgent: USER_AGENT, ip: IP });
    assert.deepEqual(read({ userAgent: longest }), { userAgent: longest, ip: IP });
  });

  test('is cut to the length of its column, with nothing put in place of the rest', () => {
    const letters = Array.from({ length: USER_AGENT_LENGTH }, (unused, index) => String(index % 10)).join('');

    [1, USER_AGENT_LENGTH].forEach((excess) => {
      assert.equal(read({ userAgent: `${letters}${'x'.repeat(excess)}` }).userAgent, letters);
    });
  });

  test('is cut before a character that does not fit whole, and keeps one that does', () => {
    const beforeEdge = 'a'.repeat(USER_AGENT_LENGTH - PAIR.length);
    const atEdge = 'a'.repeat(USER_AGENT_LENGTH - 1);

    assert.equal(read({ userAgent: `${beforeEdge}${PAIR}` }).userAgent, `${beforeEdge}${PAIR}`);
    assert.equal(read({ userAgent: `${beforeEdge}${PAIR}${PAIR}` }).userAgent, `${beforeEdge}${PAIR}`);
    assert.equal(read({ userAgent: `${atEdge}${PAIR}` }).userAgent, atEdge);
  });

  test('is null when the header is missing or empty, or when its cut leaves nothing but blanks', () => {
    assert.deepEqual(readClient({ headers: {}, ip: IP }), { userAgent: null, ip: IP });
    assert.deepEqual(read({ userAgent: '' }), { userAgent: null, ip: IP });
    assert.deepEqual(read({ userAgent: NO_BREAK_SPACE.repeat(USER_AGENT_LENGTH + 1) }), { userAgent: null, ip: IP });
  });
});

describe('readClient: the address', () => {
  test('is given as it is when it is one, of either family', () => {
    [IP, '127.0.0.1', '::1', '2001:db8::7', '::ffff:203.0.113.7', LONGEST_IP].forEach((ip) => {
      assert.deepEqual(read({ ip }), { userAgent: USER_AGENT, ip });
    });
  });

  test('is null when it is a text a client has put in its place, or longer than its column', () => {
    ['unknown', '', ' 203.0.113.7', '203.0.113.7:443', '203.0.113', 'localhost', '<script>', 'a'.repeat(USER_AGENT_LENGTH), ZONED_IP].forEach((ip) => {
      assert.deepEqual(read({ ip }), { userAgent: USER_AGENT, ip: null });
    });
    assert.deepEqual(readClient({ headers: {} }), { userAgent: null, ip: null });
  });
});

describe('readClient: a request of the app', () => {
  test('gives the address the proxy names, and none when the client wrote a text there', async (t) => {
    const fastify = await buildApp(t);
    const headers = { [HEADER.USER_AGENT]: USER_AGENT };
    const responses = await Promise.all([
      fastify.inject({ url: '/client', headers, remoteAddress: IP }),
      fastify.inject({ url: '/client', headers: { ...headers, 'x-forwarded-for': IP }, remoteAddress: PROXY_IP }),
      fastify.inject({ url: '/client', headers: { ...headers, 'x-forwarded-for': 'not-an-address' }, remoteAddress: PROXY_IP }),
    ]);

    assert.deepEqual(responses.map((response) => response.json()), [
      { userAgent: USER_AGENT, ip: IP },
      { userAgent: USER_AGENT, ip: IP },
      { userAgent: USER_AGENT, ip: null },
    ]);
  });

  test('gives what the columns of a session hold and its schema says, whatever the client sends', async (t) => {
    const fastify = await buildApp(t);
    const response = await fastify.inject({
      url: '/client',
      headers: { [HEADER.USER_AGENT]: 'x'.repeat(USER_AGENT_LENGTH * 2), 'x-forwarded-for': LONGEST_IP },
      remoteAddress: PROXY_IP,
    });
    const { userAgent, ip } = response.json();

    assert.deepEqual([userAgent.length, ip.length], [USER_AGENT_LENGTH, IP_LENGTH]);
    assert.equal(SCHEMA_LIMITS.userAgentMaxLength, USER_AGENT_LENGTH);
    assert.deepEqual(
      [sessionSchema.properties.userAgent.maxLength, sessionSchema.properties.ip.maxLength],
      [USER_AGENT_LENGTH, IP_LENGTH],
    );
  });
});

describe('isLoopbackOnlyRequest: the socket', () => {
  test('lets in a socket of loopback, of either family and in the IPv4-mapped form', () => {
    const addresses = [LOOPBACK, '127.10.20.30', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1'];

    assert.deepEqual(listShutOut(addresses, (remoteAddress) => ({ socket: { remoteAddress } })), []);
  });

  // A socket that has closed has no address.
  test('shuts out a socket of the network, of the internet or of no host, and one that has closed', () => {
    const addresses = [LAN_IP, PROXY_IP, IP, '::ffff:192.168.1.20', '2001:db8::7', 'fe80::1', '0.0.0.0', '::', 'localhost', '', undefined];

    assert.deepEqual(listLetIn(addresses, (remoteAddress) => ({ socket: { remoteAddress } })), []);
  });
});

describe('isLoopbackOnlyRequest: the headers of a proxy', () => {
  test('lets in a dev proxy on this machine, whose X-Forwarded-For holds loopback hops only', () => {
    const hops = [LOOPBACK, '::1', '::ffff:127.0.0.1', '127.0.0.1, ::1', ' 127.0.0.1 ,127.0.0.2 '];

    assert.deepEqual(listShutOut(hops, (hop) => ({ headers: { [HEADER.X_FORWARDED_FOR]: hop } })), []);
  });

  test('shuts out X-Forwarded-For with a hop of another machine, an empty hop or a hop that is no address', () => {
    const hops = [
      IP,
      LAN_IP,
      `${LOOPBACK}, ${IP}`,
      `${LAN_IP}, ${LOOPBACK}`,
      '',
      ' ',
      `${LOOPBACK},`,
      `,${LOOPBACK}`,
      `${LOOPBACK},,::1`,
      `${LOOPBACK}:5173`,
      '[::1]',
      'localhost',
      'unknown',
    ];

    assert.deepEqual(listLetIn(hops, (hop) => ({ headers: { [HEADER.X_FORWARDED_FOR]: hop } })), []);
  });

  test('shuts out every other header that names a client, whatever it holds and whatever comes beside it', () => {
    const values = [LOOPBACK, 'for=127.0.0.1', ''];
    const cases = PROXY_HEADERS.flatMap((name) => values.flatMap((value) => [
      { [name]: value },
      { [name]: value, [HEADER.X_FORWARDED_FOR]: LOOPBACK },
    ]));

    assert.equal(PROXY_HEADERS.length, 4);
    assert.deepEqual(listLetIn(cases, (headers) => ({ headers })), []);
  });

  test('come from one frozen list', () => {
    assert.deepEqual(CLIENT_ADDRESS_HEADERS, ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']);
    assert.ok(Object.isFrozen(CLIENT_ADDRESS_HEADERS));
  });
});

describe('isLoopbackOnlyRequest: the Host', () => {
  test('lets in a name a browser on this machine writes, a loopback address and the host of the app', () => {
    const hosts = [
      'localhost',
      DEV_SERVER_HOST,
      'LocalHost:80',
      'app.localhost',
      'app.localhost:3000',
      'a.b.localhost',
      LOOPBACK,
      '127.0.0.1:4173',
      '127.1.2.3:4173',
      '[::1]:4173',
      '[::ffff:127.0.0.1]',
      'app.test',
      'app.test:8443',
      'APP.TEST',
    ];

    assert.deepEqual(listShutOut(hosts, (host) => ({ host })), []);
  });

  test('shuts out another name, as a page whose DNS points at 127.0.0.1 sends it, and a Host that is none', () => {
    const hosts = [
      'evil.com',
      'evil.com:5173',
      'localhost.evil.com',
      'evillocalhost',
      'localhost.',
      LAN_IP,
      `${LAN_IP}:5173`,
      'app.test.evil.com',
      'evil.com@localhost',
      'user:secret@localhost',
      'local host',
      '',
      null,
    ];

    assert.deepEqual(listLetIn(hosts, (host) => ({ host })), []);
  });

  test('compares the name of APP_HOST, whatever port either names', () => {
    const config = createTestConfig({ env: { APP_HOST: 'nfs.local:4173' } });

    assert.deepEqual(listShutOut(['nfs.local', 'nfs.local:9000'], (host) => ({ host, config })), []);
    assert.deepEqual(listLetIn(['nfs.local.evil.com', 'app.test'], (host) => ({ host, config })), []);
  });
});

describe('isLoopbackOnlyRequest: a request of the app', () => {
  test('reads the socket and the raw Host, not the address and the name trustProxy takes from the headers', async (t) => {
    const fastify = await buildApp(t);
    const responses = await Promise.all([
      fastify.inject({ url: '/local' }),
      fastify.inject({ url: '/local', headers: { [HEADER.X_FORWARDED_FOR]: LOOPBACK }, remoteAddress: LOOPBACK }),
      fastify.inject({ url: '/local', headers: { [HEADER.X_FORWARDED_FOR]: LOOPBACK }, remoteAddress: LAN_IP }),
      fastify.inject({ url: '/local', headers: { [HEADER.X_FORWARDED_FOR]: IP }, remoteAddress: LOOPBACK }),
      fastify.inject({ url: '/local', headers: { [HEADER.HOST]: 'evil.com', 'x-forwarded-host': 'localhost' } }),
    ]);

    assert.deepEqual(responses.map((response) => response.json()), [
      { isLocal: true, ip: LOOPBACK, hostname: 'localhost' },
      { isLocal: true, ip: LOOPBACK, hostname: 'localhost' },
      { isLocal: false, ip: LOOPBACK, hostname: 'localhost' },
      { isLocal: false, ip: IP, hostname: 'localhost' },
      { isLocal: false, ip: LOOPBACK, hostname: 'localhost' },
    ]);
  });
});
