import { assertRouteContract } from '#core/schema/route.js';
import useLogRoutes from '#root/src/routes/v1/log/index.js';
import { accept, createAlertReceiver, readBlock } from '#root/tests/helper/alert.js';
import {
  buildTestApp,
  errorBody,
  readRequestId,
  successBody,
} from '#root/tests/helper/app.js';
import { timeIt, waitFor } from '#root/tests/helper/async.js';
import { TEST_ENV } from '#root/tests/helper/config.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const LOG_URL = '/api/v1/log/error';
const ALLOWED_ORIGIN = `https://${TEST_ENV.APP_HOST}`;
const FOREIGN_ORIGIN = 'https://evil.test';
const LOG_API_KEY = 'test-log-api-key-0123456789';

const FRONTEND_ERROR_TITLE = 'Frontend error';
const NOT_DELIVERED_MESSAGE = 'Alert not delivered';

// fetch() refuses port 1 before the network: a channel that cannot be reached.
const UNREACHABLE_WEBHOOK_URL = 'http://127.0.0.1:1/hook/unreachable';

const SEND_TIMEOUT = '0.5s';
const SEND_TIMEOUT_MS = 500;

const FAILED = Object.freeze({ status: 500 });

const REPORT = Object.freeze({
  url: `${ALLOWED_ORIGIN}/orders/42`,
  error: Object.freeze({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'id')",
    stack: `TypeError: Cannot read properties of undefined (reading 'id')\n    at render (${ALLOWED_ORIGIN}/assets/app.js:10:5)`,
    source: `${ALLOWED_ORIGIN}/assets/app.js`,
    line: 10,
    column: 5,
  }),
  client: Object.freeze({
    release: '1.4.0',
    language: 'uk-UA',
    timezone: 'Europe/Kyiv',
    viewport: '1280x720',
    isOnline: true,
  }),
});

const OTHER_REPORT = Object.freeze({ ...REPORT, error: { ...REPORT.error, message: 'Another error of the page' } });

function fail() {
  return FAILED;
}

async function buildApp(t, { receiver, env = {}, alert = {} } = {}) {
  const sink = createLogSink();
  const fastify = await buildTestApp({
    env: { ...REDIS_DOWN_ENV, ...receiver?.env.webhook, ...env },
    alert: { ...receiver?.config.alert, ...alert },
    logger: { level: 'info', stream: sink.stream },
  });

  t.after(() => fastify.close());

  return { fastify, sink };
}

function postReport(fastify, { headers = { origin: ALLOWED_ORIGIN }, payload = REPORT } = {}) {
  return fastify.inject({
    method: 'POST',
    url: LOG_URL,
    headers,
    payload,
  });
}

// A report, its repeat and another report, one after the other: the flags of the three answers.
async function postRepeats(fastify) {
  const first = await postReport(fastify);
  const repeat = await postReport(fastify);
  const other = await postReport(fastify, { payload: OTHER_REPORT });

  return [first, repeat, other].map((response) => response.json().data);
}

// The route answers before the channels do: an alert reaches the receiver a moment after the answer.
async function waitForAlerts(receiver, count) {
  await waitFor(() => receiver.requests.length >= count, `${count} alert(s) at the receiver`);

  assert.equal(receiver.requests.length, count);

  return receiver.requests;
}

function waitForLogLine(sink, message) {
  return waitFor(() => findLogLines(sink, message)[0], `the line "${message}"`);
}

function assertRefused(responses, code, message) {
  responses.forEach((response) => {
    assert.deepEqual(response.json(), errorBody(response, code, message));
  });
}

describe('POST /api/v1/log/error: who may send', () => {
  test('takes a report from an allowed Origin: 200 with the flags, and one alert "Frontend error" in the public space', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const response = await postReport(fastify);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), successBody(response, { isDeduped: false, isThrottled: false }));
    await waitForAlerts(receiver, 1);

    const [{ path, body }] = receiver.requests;

    assert.equal(path, receiver.paths.webhook);
    assert.equal(body.title, FRONTEND_ERROR_TITLE);
    assert.equal(body.space, 'public');
    assert.equal(body.throttleClass, 'failure');
    assert.equal(body.isSilent, false);
    assert.deepEqual(body.blocks.map((block) => block.name), ['App', 'Url', 'Error', 'Request', 'Client']);
    assert.equal(readBlock(body, 'Url'), REPORT.url);
    assert.deepEqual(readBlock(body, 'Error'), REPORT.error);
    assert.deepEqual(readBlock(body, 'Client'), REPORT.client);
    assert.deepEqual(readBlock(body, 'Request'), {
      method: 'POST',
      ip: '127.0.0.1',
      userAgent: 'lightMyRequest',
      userId: null,
      requestId: readRequestId(response),
    });
  });

  test('reaches the channel for a report sent over a socket: the body is read outside inject()', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    await fastify.listen({ host: '127.0.0.1', port: 0 });

    const response = await fetch(`http://127.0.0.1:${fastify.server.address().port}${LOG_URL}`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(REPORT),
    });

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { isDeduped: false, isThrottled: false });
    await waitForAlerts(receiver, 1);
    assert.equal(receiver.requests[0].body.title, FRONTEND_ERROR_TITLE);
  });

  test('takes the host of the Referer when there is no Origin', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const response = await postReport(fastify, { headers: { referer: `${ALLOWED_ORIGIN}/orders/42?tab=items` } });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { isDeduped: false, isThrottled: false });
    await waitForAlerts(receiver, 1);
  });

  test('refuses a foreign Origin with 403 ORIGIN_ERROR, also with the key of logs, and "Origin: null" the same way', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, env: { APP_LOG_API_KEY: LOG_API_KEY } });
    const bearer = `Bearer ${LOG_API_KEY}`;
    const responses = await Promise.all([
      postReport(fastify, { headers: { origin: FOREIGN_ORIGIN } }),
      postReport(fastify, { headers: { origin: FOREIGN_ORIGIN, authorization: bearer } }),
      postReport(fastify, { headers: { origin: 'null' } }),
      postReport(fastify, { headers: { origin: 'null', authorization: bearer } }),
      postReport(fastify, { headers: { origin: `${ALLOWED_ORIGIN}:8443` } }),
      postReport(fastify, { headers: { origin: FOREIGN_ORIGIN, referer: `${ALLOWED_ORIGIN}/orders/42` } }),
      postReport(fastify, { headers: { referer: `${FOREIGN_ORIGIN}/page` } }),
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode), [403, 403, 403, 403, 403, 403, 403]);
    assertRefused(responses, 'ORIGIN_ERROR', 'Origin is not allowed');
    assert.deepEqual(receiver.requests, []);
  });

  test('refuses a foreign Origin before it reads the body: 403, not 413', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const response = await postReport(fastify, {
      headers: { origin: FOREIGN_ORIGIN },
      payload: { ...REPORT, storage: 'x'.repeat(fastify.config.alert.intake.bodyLimit) },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'ORIGIN_ERROR');
    assert.deepEqual(receiver.requests, []);
  });

  test('takes a report without Origin and Referer that carries the key of logs as a Bearer token', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, env: { APP_LOG_API_KEY: LOG_API_KEY } });
    const responses = await Promise.all([
      postReport(fastify, { headers: { authorization: `Bearer ${LOG_API_KEY}` } }),
      postReport(fastify, { headers: { authorization: `bearer ${LOG_API_KEY}` }, payload: OTHER_REPORT }),
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    await waitForAlerts(receiver, 1);
    assert.equal(receiver.requests[0].body.title, FRONTEND_ERROR_TITLE);
  });

  test('refuses a report without Origin with 401 when the key is missing or wrong, and any Bearer while the server has no key', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const keyed = await buildApp(t, { receiver, env: { APP_LOG_API_KEY: LOG_API_KEY } });
    const keyless = await buildApp(t, { receiver });
    const responses = await Promise.all([
      postReport(keyed.fastify, { headers: {} }),
      postReport(keyed.fastify, { headers: { authorization: 'Bearer wrong-key' } }),
      postReport(keyed.fastify, { headers: { authorization: `Bearer ${LOG_API_KEY.slice(0, -1)}` } }),
      postReport(keyed.fastify, { headers: { authorization: `Basic ${LOG_API_KEY}` } }),
      postReport(keyed.fastify, { headers: { authorization: LOG_API_KEY } }),
      postReport(keyless.fastify, { headers: {} }),
      postReport(keyless.fastify, { headers: { authorization: `Bearer ${LOG_API_KEY}` } }),
      postReport(keyless.fastify, { headers: { authorization: 'Bearer null' } }),
      postReport(keyless.fastify, { headers: { authorization: 'Bearer undefined' } }),
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode), [401, 401, 401, 401, 401, 401, 401, 401, 401]);
    assertRefused(responses, 'AUTHENTICATION_ERROR', 'Authentication error');
    assert.deepEqual(receiver.requests, []);
  });

  test('is public by contract: POST with security { auth: false }, a typed response and the body limit of the intake', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const routes = [];

    fastify.addHook('onRoute', (routeOptions) => {
      routes.push(routeOptions);
    });

    await fastify.register(useLogRoutes, { prefix: '/api/v2/log' });

    const [route] = routes.filter((options) => options.url === '/api/v2/log/error');

    assert.equal(route.method, 'POST');
    assert.deepEqual(route.security, { auth: false });
    assert.equal(route.bodyLimit, fastify.config.alert.intake.bodyLimit);
    assert.doesNotThrow(() => assertRouteContract(route));
  });
});

describe('POST /api/v1/log/error: what it takes', () => {
  test('refuses a body over the limit of the intake with 413 and sends nothing, and takes one above the limit of the app', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const tooLarge = await postReport(fastify, { payload: { ...REPORT, storage: 'x'.repeat(fastify.config.alert.intake.bodyLimit) } });

    assert.equal(tooLarge.statusCode, 413);
    assert.deepEqual(tooLarge.json(), errorBody(tooLarge, 'PAYLOAD_TOO_LARGE_ERROR', 'Payload too large'));
    assert.deepEqual(receiver.requests, []);

    const large = await postReport(fastify, { payload: { ...REPORT, storage: 'x'.repeat(fastify.config.app.bodyLimit) } });

    assert.equal(large.statusCode, 200);
    await waitForAlerts(receiver, 1);
  });

  test('drops every field it does not name: none reaches the alert, and the title and the space are the server\'s', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const response = await postReport(fastify, {
      payload: {
        ...REPORT,
        error: { ...REPORT.error, injected: 'error-extra' },
        client: { ...REPORT.client, injected: 'client-extra' },
        storage: { token: 'storage-token', note: 'storage-note' },
        title: 'Injected title',
        isSilent: true,
        footer: 'Injected footer',
        request: { ip: '10.9.8.7', userId: 'injected-user' },
        space: 'internal',
        throttleClass: 'silent',
        blocks: [{ name: 'Injected', value: 'injected-block' }],
      },
    });

    assert.equal(response.statusCode, 200);
    await waitForAlerts(receiver, 1);

    const [{ body }] = receiver.requests;
    const text = JSON.stringify(body);

    assert.equal(body.title, FRONTEND_ERROR_TITLE);
    assert.equal(body.space, 'public');
    assert.equal(body.throttleClass, 'failure');
    assert.equal(body.isSilent, false);
    assert.deepEqual(body.blocks.map((block) => block.name), ['App', 'Url', 'Error', 'Request', 'Client']);
    assert.deepEqual(readBlock(body, 'Error'), REPORT.error);
    assert.deepEqual(readBlock(body, 'Client'), REPORT.client);
    assert.equal(readBlock(body, 'Request').ip, '127.0.0.1');
    assert.equal(readBlock(body, 'Request').userId, null);
    ['error-extra', 'client-extra', 'storage-token', 'storage-note', 'Injected', 'injected-user', '10.9.8.7', 'injected-block'].forEach((marker) => {
      assert.equal(text.includes(marker), false, `"${marker}" reached the alert`);
    });
  });

  test('cuts the query and the fragment off the address of the page and of the script', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const response = await postReport(fastify, {
      payload: {
        ...REPORT,
        url: `${ALLOWED_ORIGIN}/auth/callback?token=url-token&code=oauth-code#tgWebAppData=fragment-data`,
        error: { ...REPORT.error, source: `${ALLOWED_ORIGIN}/assets/app.js?v=source-token#source-fragment` },
      },
    });

    assert.equal(response.statusCode, 200);

    const [{ body }] = await waitForAlerts(receiver, 1);
    const text = JSON.stringify(body);

    assert.equal(readBlock(body, 'Url'), `${ALLOWED_ORIGIN}/auth/callback`);
    assert.equal(readBlock(body, 'Error').source, `${ALLOWED_ORIGIN}/assets/app.js`);
    ['url-token', 'oauth-code', 'tgWebAppData', 'fragment-data', 'source-token', 'source-fragment'].forEach((marker) => {
      assert.equal(text.includes(marker), false, `"${marker}" reached the alert`);
    });
  });

  test('cuts a fragment alone off the address of the page, as the initData of a Mini App rides there', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const response = await postReport(fastify, { payload: { ...REPORT, url: `${ALLOWED_ORIGIN}/app#tgWebAppData=user%3D42%26hash%3Dabc` } });

    assert.equal(response.statusCode, 200);
    const [{ body }] = await waitForAlerts(receiver, 1);

    assert.equal(readBlock(body, 'Url'), `${ALLOWED_ORIGIN}/app`);
  });

  test('cuts the query and the fragment of every address in the stack and the message: a browser writes the page there', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const page = `${ALLOWED_ORIGIN}/oauth/callback?code=OAUTH-CODE-SECRET&state=STATE-SECRET#tgWebAppData=FRAGMENT-SECRET`;
    const response = await postReport(fastify, {
      payload: {
        ...REPORT,
        url: page,
        error: {
          ...REPORT.error,
          message: `Failed to load ${page}`,
          stack: `TypeError: boom\n    at render (${page}:12:7)`,
          source: page,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    const [{ body }] = await waitForAlerts(receiver, 1);
    const error = readBlock(body, 'Error');

    assert.equal(error.message, `Failed to load ${ALLOWED_ORIGIN}/oauth/callback`);
    assert.equal(error.stack, `TypeError: boom\n    at render (${ALLOWED_ORIGIN}/oauth/callback:12:7)`);
    ['OAUTH-CODE-SECRET', 'STATE-SECRET', 'FRAGMENT-SECRET', 'tgWebAppData'].forEach((marker) => {
      assert.equal(JSON.stringify(body).includes(marker), false, `"${marker}" reached the alert`);
    });
  });

  test('cuts the whole tail of an address that holds ( ) \' or `, which a browser leaves raw, and of a wss or a file address', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const page = `${ALLOWED_ORIGIN}/oauth/callback?state=%2Finbox(popup%3Acompose)&code=OAUTH-CODE-SECRET#a=it's&b=\`FRAGMENT-SECRET`;
    const response = await postReport(fastify, {
      payload: {
        ...REPORT,
        url: page,
        error: {
          ...REPORT.error,
          message: `Failed to load ${page} and 'wss://app.test/ws?token=SOCKET-SECRET'`,
          stack: [
            'TypeError: boom',
            `    at render (${ALLOWED_ORIGIN}/inbox(popup:compose)?code=OAUTH-CODE-SECRET:12:7)`,
            '    at file:///C:/app/index.html?code=FILE-SECRET:1:5',
          ].join('\n'),
          source: page,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    const [{ body }] = await waitForAlerts(receiver, 1);
    const error = readBlock(body, 'Error');

    assert.equal(error.message, `Failed to load ${ALLOWED_ORIGIN}/oauth/callback and 'wss://app.test/ws'`);
    assert.equal(error.stack, [
      'TypeError: boom',
      `    at render (${ALLOWED_ORIGIN}/inbox(popup:compose):12:7)`,
      '    at file:///C:/app/index.html:1:5',
    ].join('\n'));
    ['OAUTH-CODE-SECRET', 'FRAGMENT-SECRET', 'SOCKET-SECRET', 'FILE-SECRET'].forEach((marker) => {
      assert.equal(JSON.stringify(body).includes(marker), false, `"${marker}" reached the alert`);
    });
  });

  test('cuts a path in quotes off its query too: ofetch and a router name the address of a failed call that way', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const response = await postReport(fastify, {
      payload: { ...REPORT, error: { ...REPORT.error, message: '[GET] "/api/v1/auth/google/callback?code=OAUTH-CODE-SECRET": 400 Bad Request' } },
    });

    assert.equal(response.statusCode, 200);

    const [{ body }] = await waitForAlerts(receiver, 1);

    assert.equal(readBlock(body, 'Error').message, '[GET] "/api/v1/auth/google/callback": 400 Bad Request');
    assert.equal(JSON.stringify(body).includes('OAUTH-CODE-SECRET'), false);
  });

  test('takes a report whose texts are long only by the query of their addresses: every frame repeats it', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const page = `${ALLOWED_ORIGIN}/oauth/callback?code=${'OAUTH-CODE-SECRET'.repeat(200)}`;
    const frames = Array.from({ length: 10 }, (_, index) => `    at step${index} (${page}:12:${index + 1})`);
    const response = await postReport(fastify, {
      payload: {
        ...REPORT,
        url: page,
        error: {
          ...REPORT.error,
          message: `Failed to load ${page}`,
          stack: ['TypeError: boom', ...frames].join('\n'),
          source: page,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    const [{ body }] = await waitForAlerts(receiver, 1);
    const error = readBlock(body, 'Error');

    assert.equal(readBlock(body, 'Url'), `${ALLOWED_ORIGIN}/oauth/callback`);
    assert.equal(error.message, `Failed to load ${ALLOWED_ORIGIN}/oauth/callback`);
    assert.equal(error.stack.split('\n').at(-1), `    at step9 (${ALLOWED_ORIGIN}/oauth/callback:12:10)`);
    assert.equal(JSON.stringify(body).includes('OAUTH-CODE-SECRET'), false);
  });

  test('masks the value an error of the server repeats before it cuts the text, which could leave its lines', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const letter = Array.from({ length: 170 }, (_, index) => `PRIVATE-LINE-${index} of the letter`).join('\n');
    const message = `The value "${letter}" cannot be converted to an integer.`;
    const response = await postReport(fastify, {
      payload: { ...REPORT, error: { ...REPORT.error, message, stack: `Error: ${message}\n    at first (app.js:1:1)\nCaused by: ${message}\n    at second (app.js:2:2)` } },
    });

    assert.equal(response.statusCode, 200);

    const [{ body }] = await waitForAlerts(receiver, 1);

    assert.equal(readBlock(body, 'Error').message, 'The value "***" cannot be converted to an integer.');
    assert.equal(JSON.stringify(body).includes('PRIVATE-LINE'), false);
  });

  test('cuts the texts that stay long without the query of their addresses, and takes the report', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const response = await postReport(fastify, {
      payload: {
        ...REPORT,
        error: {
          ...REPORT.error,
          message: 'm'.repeat(5000),
          stack: 's'.repeat(20000),
          source: `${ALLOWED_ORIGIN}/${'p'.repeat(5000)}`,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    const [{ body }] = await waitForAlerts(receiver, 1);
    const error = readBlock(body, 'Error');

    assert.deepEqual([error.message.length, error.stack.length, error.source.length], [1024, 4096, 2048]);
  });

  test('sends a report without the address of its page with no Url block: the address of the intake is no page', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const response = await postReport(fastify, { payload: { error: REPORT.error, client: REPORT.client } });

    assert.equal(response.statusCode, 200);

    const [{ body }] = await waitForAlerts(receiver, 1);

    assert.deepEqual(body.blocks.map((block) => block.name), ['App', 'Error', 'Request', 'Client']);
  });

  test('refuses a report without error.message with 422 and sends nothing', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const responses = await Promise.all([
      postReport(fastify, { payload: { ...REPORT, error: { name: 'TypeError', source: REPORT.error.source } } }),
      postReport(fastify, { payload: { ...REPORT, error: { ...REPORT.error, message: '' } } }),
      postReport(fastify, { payload: { url: REPORT.url, client: REPORT.client } }),
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode), [422, 422, 422]);
    responses.forEach((response) => {
      assert.equal(response.json().code, 'VALIDATION_ERROR');
    });
    assert.deepEqual(receiver.requests, []);
  });
});

describe('POST /api/v1/log/error: what the page learns', () => {
  test('answers the same 200 with the same flags whether the channel delivered, failed or could not be reached', async (t) => {
    const delivering = await createAlertReceiver(t, accept);
    const failing = await createAlertReceiver(t, fail);
    const [delivered, failed, unreachable] = await Promise.all([
      buildApp(t, { receiver: delivering }),
      buildApp(t, { receiver: failing }),
      buildApp(t, { env: { APP_ALERT_WEBHOOK_URL: UNREACHABLE_WEBHOOK_URL } }),
    ]);
    const responses = await Promise.all([delivered, failed, unreachable].map((app) => postReport(app.fastify)));

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 200]);
    responses.forEach((response) => {
      assert.deepEqual(response.json(), successBody(response, { isDeduped: false, isThrottled: false }));
    });
    await waitForAlerts(delivering, 1);
    await waitForAlerts(failing, 1);
    assert.equal((await waitForLogLine(failed.sink, NOT_DELIVERED_MESSAGE)).alert.reason, 'failed');
    assert.equal((await waitForLogLine(unreachable.sink, NOT_DELIVERED_MESSAGE)).alert.reason, 'unreachable');
    assert.deepEqual(findLogLines(delivered.sink, NOT_DELIVERED_MESSAGE), []);
  });

  test('answers without waiting for a channel that hangs: the time of the answer tells nothing of the channels', async (t) => {
    const receiver = await createAlertReceiver(t, () => ({ isHanging: true }));
    const { fastify, sink } = await buildApp(t, { receiver, alert: { sendTimeout: SEND_TIMEOUT } });
    const { result: response, durationMs } = await timeIt(() => postReport(fastify));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { isDeduped: false, isThrottled: false });
    assert.ok(durationMs < SEND_TIMEOUT_MS, `${durationMs} ms`);
    assert.equal((await waitForLogLine(sink, NOT_DELIVERED_MESSAGE)).alert.reason, 'unreachable');
  });

  test('answers a repeat of the report the same way whether its first delivery went out or failed', async (t) => {
    const delivering = await createAlertReceiver(t, accept);
    const failing = await createAlertReceiver(t, fail);
    const [delivered, failed] = await Promise.all([buildApp(t, { receiver: delivering }), buildApp(t, { receiver: failing })]);

    await Promise.all([postReport(delivered.fastify), postReport(failed.fastify)]);

    const [afterDelivery, afterFailure] = await Promise.all([postReport(delivered.fastify), postReport(failed.fastify)]);

    assert.deepEqual([afterDelivery.statusCode, afterFailure.statusCode], [200, 200]);
    await Promise.all([waitForAlerts(delivering, 1), waitForAlerts(failing, 1)]);
    assert.deepEqual(afterFailure.json().data, afterDelivery.json().data);
  });

  test('answers with the same flags when no channel is on: they do not tell whether the admins hear anything', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const [withChannel, withoutChannel] = await Promise.all([buildApp(t, { receiver }), buildApp(t)]);
    const flags = [
      { isDeduped: false, isThrottled: false },
      { isDeduped: true, isThrottled: false },
      { isDeduped: false, isThrottled: true },
    ];

    assert.deepEqual(await postRepeats(withChannel.fastify), flags);
    assert.deepEqual(await postRepeats(withoutChannel.fastify), flags);
    await waitForAlerts(receiver, 1);
  });

  test('flags the same report sent twice as deduped, and sends it once', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const first = await postReport(fastify);
    const second = await postReport(fastify);

    assert.deepEqual(first.json().data, { isDeduped: false, isThrottled: false });
    assert.deepEqual(second.json().data, { isDeduped: true, isThrottled: false });
    await waitForAlerts(receiver, 1);
  });

  test('flags another report within the window as throttled, and leaves the window of the server\'s own alerts alone', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    fastify.get('/boom', async () => {
      throw new Error('Route failed');
    });

    const first = await postReport(fastify);
    const second = await postReport(fastify, { payload: OTHER_REPORT });
    const failure = await fastify.inject('/boom');

    await waitFor(() => receiver.requests.length === 2, 'the alert of the server');

    assert.deepEqual(first.json().data, { isDeduped: false, isThrottled: false });
    assert.deepEqual(second.json().data, { isDeduped: false, isThrottled: true });
    assert.equal(failure.statusCode, 500);
    assert.deepEqual(receiver.requests.map((request) => [request.body.space, request.body.title]), [
      ['public', FRONTEND_ERROR_TITLE],
      ['internal', 'Server error (5xx)'],
    ]);
  });
});
