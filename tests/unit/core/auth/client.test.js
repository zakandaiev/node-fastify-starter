import { SCHEMA_LIMITS } from '#config/schema.js';
import { readClient } from '#core/auth/client.js';
import { HEADER } from '#enums/header.js';
import { buildTestApp } from '#root/tests/helper/app.js';
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

function read({ userAgent = USER_AGENT, ip = IP } = {}) {
  return readClient({ headers: { [HEADER.USER_AGENT]: userAgent }, ip });
}

async function buildApp(t) {
  const fastify = await buildTestApp({ env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()) } });

  t.after(() => fastify.close());
  fastify.get('/client', (request) => readClient(request));

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
