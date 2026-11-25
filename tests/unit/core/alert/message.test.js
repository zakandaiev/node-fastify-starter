import {
  ALERT_BLOCK,
  buildAlertMessage,
  describeRequest,
} from '#core/alert/message.js';
import { ALERT_SPACE } from '#enums/alert-space.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import { buildTestApp, readRequestId } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SUFFIX = '…';
const HIDDEN = '[hidden]';
const TITLE = 'Server error (5xx)';

const SECRET_EMAIL = 'anna@example.com';
const MASKED_DUPLICATE = "Duplicate entry '***' for key 'uq_users_email'";
const STATEMENT_START = 'INSERT INTO';

const REQUEST_SECRETS = Object.freeze(['query-secret', 'fragment-secret', 'cookie-secret', 'header-secret', 'body-secret']);

// The warning sign carries the variation selector U+FE0F, which no editor shows.
const ICONS = Object.freeze({
  [THROTTLE_CLASS.FAILURE]: String.fromCodePoint(0x1F6A8),
  [THROTTLE_CLASS.WARNING]: String.fromCodePoint(0x26A0, 0xFE0F),
  [THROTTLE_CLASS.SILENT]: String.fromCodePoint(0x1F7E2),
});

const APP = createTestConfig().app;

// With what alert() always passes on: a space, a class and the silence.
function build(input = {}, appConfig = APP) {
  return buildAlertMessage({
    title: TITLE,
    space: ALERT_SPACE.INTERNAL,
    throttleClass: THROTTLE_CLASS.FAILURE,
    isSilent: false,
    ...input,
  }, appConfig);
}

function findBlock(message, name) {
  return message.blocks.find((block) => block.name === name);
}

function readBlockNames(message) {
  return message.blocks.map((block) => block.name);
}

// What a request of Fastify holds, and much more than an alert may tell: every secret here must stay out of it.
function createRequest(overrides = {}) {
  return {
    method: 'POST',
    protocol: 'http',
    host: 'evil.test',
    url: '/api/v1/orders/7?token=query-secret#fragment-secret',
    ip: '203.0.113.7',
    id: '019a1b2c-3d4e-7f5a-8b6c-7d8e9f0a1b2c',
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)',
      cookie: 'session=cookie-secret',
      authorization: 'Bearer header-secret',
    },
    body: { password: 'body-secret' },
    query: { token: 'query-secret' },
    cookies: { session: 'cookie-secret' },
    params: { id: '7' },
    user: { id: 7, email: SECRET_EMAIL },
    ...overrides,
  };
}

function createDriverError() {
  const message = `Duplicate entry '${SECRET_EMAIL}' for key 'uq_users_email'`;

  return Object.assign(new Error(message), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    sqlMessage: message,
    sql: `${STATEMENT_START} users (email) VALUES ('${SECRET_EMAIL}')`,
  });
}

describe('ALERT_BLOCK', () => {
  test('names the five blocks of an alert in the order a message carries them', () => {
    assert.deepEqual(Object.values(ALERT_BLOCK), ['App', 'Url', 'Error', 'Request', 'Client']);
    assert.equal(Object.isFrozen(ALERT_BLOCK), true);
  });
});

describe('buildAlertMessage', () => {
  test('carries the App block with the name, the version and the mode of the app, and nothing more, when there is nothing else', () => {
    const message = build();

    assert.deepEqual(message.blocks, [{ name: ALERT_BLOCK.APP, value: { name: APP.name, version: APP.version, mode: APP.mode } }]);
  });

  test('takes the mode of the App block from the config of the app', () => {
    const devApp = createTestConfig({ env: { APP_MODE: 'dev' } }).app;

    assert.deepEqual(findBlock(build({}, devApp), ALERT_BLOCK.APP).value, { name: devApp.name, version: devApp.version, mode: 'dev' });
  });

  test('puts the blocks in the order App, Url, Error, Request, Client, whatever the order of the input', () => {
    const message = buildAlertMessage({
      client: { release: '1.2.3' },
      request: createRequest(),
      error: new Error('Boom'),
      url: 'https://app.test/page',
      title: TITLE,
    }, APP);

    assert.deepEqual(readBlockNames(message), ['App', 'Url', 'Error', 'Request', 'Client']);
  });

  test('leaves out a block without a value', () => {
    assert.deepEqual(readBlockNames(build({ error: null, client: undefined, url: '' })), ['App']);
    assert.deepEqual(readBlockNames(build({ client: { language: 'uk' } })), ['App', 'Client']);
    assert.deepEqual(readBlockNames(build({ error: new Error('Boom') })), ['App', 'Error']);
  });

  test('carries the title, the space, the class and the silence it was given, with no suppressed count yet', () => {
    const message = build({ space: ALERT_SPACE.PUBLIC, throttleClass: THROTTLE_CLASS.WARNING, isSilent: true });

    assert.deepEqual(pick(message, ['title', 'space', 'throttleClass', 'isSilent', 'suppressedCount']), {
      title: TITLE,
      space: ALERT_SPACE.PUBLIC,
      throttleClass: THROTTLE_CLASS.WARNING,
      isSilent: true,
      suppressedCount: 0,
    });
  });

  test('cuts the title to 200 characters', () => {
    const message = build({ title: 'x'.repeat(300) });

    assert.equal(message.title.length, 200);
    assert.equal(message.title, `${'x'.repeat(199)}${SUFFIX}`);
  });

  test('gives each throttle class an icon of its own', () => {
    Object.values(THROTTLE_CLASS).forEach((throttleClass) => {
      assert.equal(build({ throttleClass }).icon, ICONS[throttleClass], throttleClass);
    });
    assert.equal(new Set(Object.values(THROTTLE_CLASS).map((throttleClass) => build({ throttleClass }).icon)).size, 3);
  });
});

describe('buildAlertMessage: the Url block', () => {
  test('is the address of the app with the path of the request, without the query, the fragment and the host the request names', () => {
    assert.equal(findBlock(build({ request: createRequest() }), ALERT_BLOCK.URL).value, 'https://app.test/api/v1/orders/7');
  });

  test('is the same whatever host the client names, in Host, in X-Forwarded-Host or in both, from an address that is trusted or not', async (t) => {
    const fastify = await buildTestApp();
    const seen = [];

    t.after(() => fastify.close());
    fastify.get('/capture', async (request, reply) => {
      seen.push({ host: request.host, url: findBlock(build({ request }, fastify.config.app), ALERT_BLOCK.URL).value });

      return reply.noContent();
    });

    const requests = [
      { host: 'evil.test' },
      { 'x-forwarded-host': 'evil.test/login?from=' },
      { host: 'evil.test', 'x-forwarded-host': 'app.test, evil.test', 'x-forwarded-proto': 'ftp' },
    ].flatMap((headers) => ['127.0.0.1', '203.0.113.7'].map((remoteAddress) => ({ url: '/capture', headers, remoteAddress })));

    await Promise.all(requests.map((request) => fastify.inject(request)));

    assert.deepEqual(new Set(seen.map(({ host }) => host)), new Set(['evil.test', 'evil.test/login?from=', 'localhost:80']));
    assert.deepEqual(seen.map(({ url }) => url), requests.map(() => 'https://app.test/capture'));
  });

  test('is the path alone behind our host, whatever a request line names in front of it', () => {
    const cases = [
      ['http://evil.test/orders/7', '/orders/7'],
      ['HTTPS://user:pass@evil.test:81/orders/7?token=query-secret', '/orders/7'],
      ['ftp://evil.test/orders/7', '/orders/7'],
      ['x-1.0+evil://evil.test/orders/7', '/orders/7'],
      ['http://evil.test', ''],
      ['http://evil.test?token=query-secret', ''],
      ['*@evil.test/orders/7', '/orders/7'],
      ['*', ''],
      ['//evil.test/orders/7', '//evil.test/orders/7'],
      ['/orders/http://evil.test/7', '/orders/http://evil.test/7'],
    ];

    assert.deepEqual(
      cases.map(([url]) => findBlock(build({ request: createRequest({ url }) }), ALERT_BLOCK.URL).value),
      cases.map(([, path]) => `https://app.test${path}`),
    );
  });

  test('is the url option when there is one, before the request and without its query and fragment', () => {
    const url = 'https://shop.test/cart?session=query-secret#initData';

    assert.equal(findBlock(build({ url, request: createRequest() }), ALERT_BLOCK.URL).value, 'https://shop.test/cart');
    assert.equal(findBlock(build({ url }), ALERT_BLOCK.URL).value, 'https://shop.test/cart');
  });

  test('is cut to 2048 characters, the address of a request too', () => {
    const path = `/${'a'.repeat(3000)}`;

    [{ url: `https://app.test${path}` }, { request: createRequest({ url: path }) }].forEach((input) => {
      const { value } = findBlock(build(input), ALERT_BLOCK.URL);

      assert.equal(value.length, 2048);
      assert.equal(value.endsWith(SUFFIX), true);
    });
  });
});

describe('buildAlertMessage: the Error block', () => {
  test('masks the value the database repeats in its message, and drops the statement', () => {
    const message = build({ error: createDriverError() });
    const { value } = findBlock(message, ALERT_BLOCK.ERROR);

    assert.equal(value.type, 'Error');
    assert.equal(value.message, MASKED_DUPLICATE);
    assert.equal(value.sqlMessage, MASKED_DUPLICATE);
    assert.equal(value.code, 'ER_DUP_ENTRY');
    assert.equal(Object.hasOwn(value, 'sql'), false);
    assert.equal(JSON.stringify(message).includes(SECRET_EMAIL), false);
    assert.equal(JSON.stringify(message).includes(STATEMENT_START), false);
  });

  test('masks the value the response serializer repeats in its message', () => {
    const message = build({ error: new Error(`The value "${SECRET_EMAIL}" cannot be converted to an integer.`) });

    assert.equal(findBlock(message, ALERT_BLOCK.ERROR).value.message, 'The value "***" cannot be converted to an integer.');
    assert.equal(JSON.stringify(message).includes(SECRET_EMAIL), false);
  });

  test('hides a sensitive key at any depth and keeps the rest', () => {
    const error = Object.assign(new Error('Upstream refused'), {
      token: 'token-secret',
      details: { headers: { authorization: 'Bearer header-secret' }, password: 'body-secret', status: 401 },
    });
    const { value } = findBlock(build({ error }), ALERT_BLOCK.ERROR);

    assert.equal(value.token, HIDDEN);
    assert.equal(value.details.headers.authorization, HIDDEN);
    assert.equal(value.details.password, HIDDEN);
    assert.equal(value.details.status, 401);
  });

  test('flattens an Error with its cause into plain objects, the cause cleaned the same way', () => {
    const error = new TypeError('Saving the order failed', { cause: createDriverError() });
    const { value } = findBlock(build({ error }), ALERT_BLOCK.ERROR);

    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(Object.getPrototypeOf(value.cause), Object.prototype);
    assert.deepEqual(pick(value, ['type', 'message']), { type: 'TypeError', message: 'Saving the order failed' });
    assert.deepEqual(pick(value.cause, ['type', 'message', 'code']), { type: 'Error', message: MASKED_DUPLICATE, code: 'ER_DUP_ENTRY' });
    assert.equal(typeof value.stack, 'string');
    assert.equal(typeof value.cause.stack, 'string');
    assert.equal(Object.hasOwn(value.cause, 'sql'), false);
  });

  test('writes a BigInt anywhere as its text, so that every channel can send the message as JSON', () => {
    const error = Object.assign(new Error('Row failed', { cause: Object.assign(new Error('Inner'), { rowId: 12n }) }), {
      affectedRows: 0n,
      ids: [1n, 2n],
    });
    const message = build({
      error,
      client: { release: 3n },
      request: createRequest({ user: { id: 9007199254740993n } }),
    });
    const { value } = findBlock(message, ALERT_BLOCK.ERROR);

    assert.equal(value.affectedRows, '0');
    assert.deepEqual(value.ids, ['1', '2']);
    assert.equal(value.cause.rowId, '12');
    assert.deepEqual(findBlock(message, ALERT_BLOCK.CLIENT).value, { release: '3' });
    assert.equal(findBlock(message, ALERT_BLOCK.REQUEST).value.userId, '9007199254740993');
    assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
    assert.equal(findBlock(build({ error: 5n }), ALERT_BLOCK.ERROR).value, '5');
  });
});

describe('describeRequest', () => {
  test('tells who sent the request by its method, IP, user agent, user and id, and nothing else', () => {
    const request = createRequest();
    const described = describeRequest(request);

    assert.deepEqual(described, {
      method: 'POST',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      userId: 7,
      requestId: request.id,
    });
    REQUEST_SECRETS.forEach((secret) => assert.equal(JSON.stringify(described).includes(secret), false, secret));
  });

  test('cuts the user agent to 256 characters', () => {
    const userAgent = `Mozilla/5.0 ${'x'.repeat(500)}`;
    const described = describeRequest(createRequest({ headers: { 'user-agent': userAgent } }));

    assert.equal(described.userAgent.length, 256);
    assert.equal(described.userAgent, `${userAgent.slice(0, 255)}${SUFFIX}`);
  });

  test('gives null for a user agent that is absent and for a request without a user', () => {
    const described = describeRequest(createRequest({ headers: {}, user: undefined }));

    assert.equal(described.userAgent, null);
    assert.equal(described.userId, null);
  });

  test('is the Request block of a message', () => {
    const request = createRequest();

    assert.deepEqual(findBlock(build({ request }), ALERT_BLOCK.REQUEST).value, describeRequest(request));
  });

  test('describes a request of Fastify the same way, without its headers, body, query or cookies', async (t) => {
    const fastify = await buildTestApp();
    const userAgent = `Mozilla/5.0 ${'x'.repeat(500)}`;
    let message = null;

    t.after(() => fastify.close());
    fastify.post('/capture', async (request, reply) => {
      message = buildAlertMessage({ title: TITLE, request, throttleClass: THROTTLE_CLASS.FAILURE }, fastify.config.app);

      return reply.noContent();
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/capture?token=query-secret',
      headers: {
        host: 'evil.test',
        'x-forwarded-host': 'evil.test',
        'user-agent': userAgent,
        cookie: 'session=cookie-secret',
        authorization: 'Bearer header-secret',
      },
      payload: { password: 'body-secret' },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(findBlock(message, ALERT_BLOCK.URL).value, 'https://app.test/capture');
    assert.deepEqual(findBlock(message, ALERT_BLOCK.REQUEST).value, {
      method: 'POST',
      ip: '127.0.0.1',
      userAgent: `${userAgent.slice(0, 255)}${SUFFIX}`,
      userId: null,
      requestId: readRequestId(response),
    });
    REQUEST_SECRETS.forEach((secret) => assert.equal(JSON.stringify(message).includes(secret), false, secret));
  });
});
