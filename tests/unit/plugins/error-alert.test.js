import { createOverloadError, DbError } from '#core/db/error.js';
import { handleError } from '#core/error/handler.js';
import { AppError } from '#core/error/index.js';
import { fetchUpstream, toUpstreamAppError, UpstreamError } from '#core/http/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import {
  accept,
  createAlertReceiver,
  NO_THROTTLE,
  readBlock,
  readTitles,
  readUrls,
  TELEGRAM_TEST_ENV,
} from '#root/tests/helper/alert.js';
import { buildTestApp, errorBody, readRequestId } from '#root/tests/helper/app.js';
import { timeIt, waitFor } from '#root/tests/helper/async.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { sendRawRequest } from '#root/tests/helper/socket.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER_ERROR_TITLE = 'Server error (5xx)';
const UPSTREAM_ERROR_TITLE = 'Upstream service failed';
const STATEMENT_TIMEOUT_TITLE = 'Database statement timeout';
const POOL_SATURATED_TITLE = 'Database pool saturated';
const CONNECTIONS_REFUSED_TITLE = 'Database refuses connections';
const DATABASE_CONNECTION_TITLE = 'Database connection failed';

const CHANNELS_MESSAGE = 'Alerts go to their channels';
const NO_CHANNEL_MESSAGE = 'Alerts are off: no channel has its settings (APP_ALERT_*)';
const REPORT_FAILED_MESSAGE = 'The alert of a failed request could not be built';

const SECRET_VALUE = 'anna@example.com';
const QUERY_SECRET = 'query-secret-token';

const UPSTREAM_KEYS = Object.freeze(['type', 'message', 'reason', 'service']);

// fetch() refuses port 1 before the network: a call there fails on the way.
const UNREACHABLE_URL = 'http://127.0.0.1:1';

// Long enough for a sent alert to reach the receiver: what is not there by then was never sent.
const SETTLE_MS = 300;

// Far below the send timeout of a channel (10s): a reply that waited for the channel would take that long.
const PROMPT_REPLY_MS = 2000;

// Requests sent one after another, this far apart: each alert has taken its dedupe mark before the next request.
const GAP_MS = 50;

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

function waitForAlerts(receiver, count) {
  return waitFor(() => receiver.requests.length >= count && receiver.requests, `${count} alert(s) at the receiver`);
}

function injectInTurn(fastify, urls) {
  return urls.reduce(async (previous, url) => {
    const responses = await previous;
    const response = await fastify.inject(url);

    await sleep(GAP_MS);

    return [...responses, response];
  }, Promise.resolve([]));
}

function failWith(error) {
  return async () => {
    throw error;
  };
}

describe('error-alert plugin: start', () => {
  test('is registered under the name "error-alert" and names the enabled channels in one info line, without their secrets', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await buildApp(t, { receiver, env: { ...receiver.env.telegram, ...receiver.env.slack } });
    const lines = findLogLines(sink, CHANNELS_MESSAGE);

    assert.equal(fastify.hasPlugin('error-alert'), true);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, LOG_LEVEL.INFO);
    assert.deepEqual(lines[0].alert, { channels: ['telegram', 'webhook', 'slack'] });
    assert.deepEqual(findLogLines(sink, NO_CHANNEL_MESSAGE), []);
    assert.equal(JSON.stringify(sink.lines).includes(TELEGRAM_TEST_ENV.APP_ALERT_TELEGRAM_BOT_TOKEN), false);
    assert.equal(JSON.stringify(sink.lines).includes(receiver.paths.webhook), false);
  });

  test('says in one info line that alerts are off when no channel has its settings', async (t) => {
    const { sink } = await buildApp(t);
    const lines = findLogLines(sink, NO_CHANNEL_MESSAGE);

    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, LOG_LEVEL.INFO);
    assert.deepEqual(lines[0].alert, { channels: [] });
    assert.deepEqual(findLogLines(sink, CHANNELS_MESSAGE), []);
  });
});

describe('error-alert plugin: its settings', () => {
  test('refuses to start on a duration nobody can read and on one of zero', async () => {
    await assert.rejects(buildTestApp({ alert: { throttleWindow: '1 minute' } }), TypeError);
    await assert.rejects(buildTestApp({ alert: { dedupeTtl: '0s' } }), { name: 'TypeError', message: /config\.alert requires/ });
  });
});

describe('error-alert plugin: server errors', () => {
  test('answers a route that throws with 500 and sends one alert "Server error (5xx)": the address without its query, the request and the error masked', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const error = Object.assign(new Error(`The value "${SECRET_VALUE}" cannot be converted to an integer.`), { token: 'own-secret-of-the-error' });

    fastify.get('/orders/:id', failWith(error));

    const response = await fastify.inject({
      url: `/orders/42?token=${QUERY_SECRET}&page=2`,
      headers: { 'user-agent': 'alert-test-agent' },
    });
    const [alert] = await waitForAlerts(receiver, 1);

    await sleep(SETTLE_MS);

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), errorBody(response, 'SERVER_ERROR', 'Server error'));
    assert.equal(receiver.requests.length, 1);
    assert.equal(alert.path, receiver.paths.webhook);
    assert.equal(alert.body.title, SERVER_ERROR_TITLE);
    assert.equal(alert.body.space, 'internal');
    assert.equal(alert.body.throttleClass, 'failure');
    assert.equal(alert.body.isSilent, false);
    assert.deepEqual(alert.body.blocks.map((block) => block.name), ['App', 'Url', 'Error', 'Request']);
    assert.deepEqual(readBlock(alert.body, 'App'), { name: fastify.config.app.name, version: fastify.config.app.version, mode: 'prod' });
    assert.equal(readBlock(alert.body, 'Url'), 'https://app.test/orders/42');
    assert.deepEqual(readBlock(alert.body, 'Request'), {
      method: 'GET',
      ip: '127.0.0.1',
      userAgent: 'alert-test-agent',
      userId: null,
      requestId: readRequestId(response),
    });

    const errorBlock = readBlock(alert.body, 'Error');

    assert.equal(errorBlock.type, 'Error');
    assert.equal(errorBlock.message, 'The value "***" cannot be converted to an integer.');
    assert.match(errorBlock.stack, /^Error: The value "\*\*\*" cannot be converted to an integer\.\n {4}at /);
    assert.equal(errorBlock.token, '[hidden]');
    assert.equal(JSON.stringify(alert.body).includes(SECRET_VALUE), false);
    assert.equal(JSON.stringify(alert.body).includes(QUERY_SECRET), false);
    assert.equal(JSON.stringify(alert.body).includes('own-secret-of-the-error'), false);
  });

  test('alerts on a route that fails after reading a body over a socket: the alert keeps the context of its request', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    fastify.post('/orders', failWith(new Error('Route failed after the body')));
    await fastify.listen({ host: '127.0.0.1', port: 0 });

    const response = await fetch(`http://127.0.0.1:${fastify.server.address().port}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [1, 2, 3] }),
    });
    const [alert] = await waitForAlerts(receiver, 1);

    assert.equal(response.status, 500);
    assert.equal(alert.body.title, SERVER_ERROR_TITLE);
    assert.equal(readBlock(alert.body, 'Request').requestId, response.headers.get('x-request-id'));
  });

  test('names our host also for a request line that names another in front of its path', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    fastify.get('/boom', failWith(new Error('Route failed')));
    await fastify.listen({ host: '127.0.0.1', port: 0 });

    const received = await sendRawRequest(fastify.server.address().port, `GET http://evil.test/boom?token=${QUERY_SECRET} HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n`);

    await waitForAlerts(receiver, 1);

    assert.match(received, /^HTTP\/1\.1 500 /);
    assert.deepEqual(readUrls(receiver), ['https://app.test/boom']);
  });

  test('does not hold the response for a channel that hangs: the 500 comes at once', async (t) => {
    const receiver = await createAlertReceiver(t, () => ({ isHanging: true }));
    const { fastify } = await buildApp(t, { receiver });

    fastify.get('/boom', failWith(new Error('Route failed')));
    await fastify.ready();

    const { result: response, durationMs } = await timeIt(() => fastify.inject('/boom'));

    await waitForAlerts(receiver, 1);

    assert.equal(response.statusCode, 500);
    assert.ok(durationMs < PROMPT_REPLY_MS, `The reply took ${durationMs} ms`);
  });

  test('reads the error as the route threw it, before the error handler runs, and leaves the response to the error handler', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    fastify.register(async (scope) => {
      scope.setErrorHandler((error, request, reply) => {
        error.message = 'Rewritten by the error handler';
        handleError(error, request, reply);
      });
      scope.get('/rewritten', failWith(new Error('Thrown by the route')));
    });

    const response = await fastify.inject('/rewritten');
    const [alert] = await waitForAlerts(receiver, 1);

    assert.equal(readBlock(alert.body, 'Error').message, 'Thrown by the route');
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), errorBody(response, 'SERVER_ERROR', 'Server error'));
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  test('sends no alert for a 503 or for any 4xx: only the 500 after them reaches the receiver', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    fastify.get('/unavailable', failWith(new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR)));
    fastify.get('/missing', failWith(new AppError(ERROR_CODE.NOT_FOUND_ERROR)));
    fastify.get('/forbidden', failWith(new AppError(ERROR_CODE.AUTHORIZATION_ERROR)));
    fastify.get('/conflict', failWith(Object.assign(new Error('Taken'), { statusCode: 409 })));
    fastify.get('/limited', failWith(Object.assign(new Error('Slow down'), { statusCode: 429 })));
    fastify.post('/validated', {
      schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
    }, async () => ({}));
    fastify.get('/boom', failWith(new Error('Route failed')));

    const responses = await Promise.all([
      fastify.inject('/unavailable'),
      fastify.inject('/missing'),
      fastify.inject('/forbidden'),
      fastify.inject('/conflict'),
      fastify.inject('/limited'),
      fastify.inject({ method: 'POST', url: '/validated', payload: {} }),
      fastify.inject({
        method: 'POST',
        url: '/validated',
        headers: { 'content-type': 'application/json' },
        payload: '{"name":',
      }),
      fastify.inject({ method: 'POST', url: '/validated', payload: { name: 'x'.repeat(fastify.config.app.bodyLimit) } }),
      fastify.inject('/no-such-route'),
    ]);

    await sleep(SETTLE_MS);

    assert.deepEqual(responses.map((response) => response.statusCode), [503, 404, 403, 409, 429, 422, 400, 413, 404]);
    assert.deepEqual(receiver.requests, []);

    await fastify.inject('/boom');

    const [alert] = await waitForAlerts(receiver, 1);

    await sleep(SETTLE_MS);

    assert.equal(receiver.requests.length, 1);
    assert.equal(readBlock(alert.body, 'Url'), 'https://app.test/boom');
  });

  test('gives one bug one alert: the same route and the same masked cause whatever ids and values the requests carry', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });

    function failOnUser(request) {
      if (request.params.id === 'typo') {
        throw new TypeError("Cannot read properties of undefined (reading 'email')");
      }

      throw new Error(`Duplicate entry 'user-${request.params.id}@example.com' for key 'uq_users_email'`);
    }

    fastify.get('/orders/:id', async (request) => failOnUser(request));
    fastify.get('/users/:id', async (request) => failOnUser(request));

    const responses = await injectInTurn(fastify, ['/orders/1', '/orders/2', '/orders/typo', '/users/3']);

    await waitForAlerts(receiver, 3);
    await sleep(SETTLE_MS);

    assert.deepEqual(responses.map((response) => response.statusCode), [500, 500, 500, 500]);
    assert.deepEqual(readTitles(receiver), [SERVER_ERROR_TITLE, SERVER_ERROR_TITLE, SERVER_ERROR_TITLE]);
    assert.deepEqual(readUrls(receiver), [
      'https://app.test/orders/1',
      'https://app.test/orders/typo',
      'https://app.test/users/3',
    ]);
    assert.equal(readBlock(receiver.requests[0].body, 'Error').message, "Duplicate entry '***' for key 'uq_users_email'");
  });
});

describe('error-alert plugin: upstreams and the database', () => {
  test('sends "Upstream service failed" for a 502, and one alert for each failing service whatever route calls it', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });

    fastify.get('/invoices', failWith(toUpstreamAppError(new UpstreamError('network', { service: 'billing' }))));
    fastify.get('/payments', failWith(toUpstreamAppError(new UpstreamError('network', { service: 'billing' }))));
    fastify.get('/stock', failWith(toUpstreamAppError(new UpstreamError('network', { service: 'inventory' }))));

    const responses = await injectInTurn(fastify, ['/invoices', '/payments', '/stock']);

    await waitForAlerts(receiver, 2);
    await sleep(SETTLE_MS);

    assert.deepEqual(responses.map((response) => response.statusCode), [502, 502, 502]);
    assert.deepEqual(responses[0].json(), errorBody(responses[0], 'UPSTREAM_ERROR', 'Upstream error'));
    assert.deepEqual(readTitles(receiver), [UPSTREAM_ERROR_TITLE, UPSTREAM_ERROR_TITLE]);
    assert.deepEqual(readUrls(receiver), ['https://app.test/invoices', 'https://app.test/stock']);
    assert.deepEqual(receiver.requests.map((request) => pick(readBlock(request.body, 'Error').cause, UPSTREAM_KEYS)), [
      {
        type: 'UpstreamError',
        message: 'The upstream could not be reached',
        reason: 'network',
        service: 'billing',
      },
      {
        type: 'UpstreamError',
        message: 'The upstream could not be reached',
        reason: 'network',
        service: 'inventory',
      },
    ]);
  });

  test('reports a call of fetchUpstream that fails on the way: 502, "Upstream service failed", the address masked', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    fastify.get('/sync', async () => fetchUpstream(`${UNREACHABLE_URL}/v1/sync?api_token=${QUERY_SECRET}`, { service: 'crm' }));

    const response = await fastify.inject('/sync');
    const [alert] = await waitForAlerts(receiver, 1);
    const { cause } = readBlock(alert.body, 'Error');

    assert.equal(response.statusCode, 502);
    assert.equal(alert.body.title, UPSTREAM_ERROR_TITLE);
    assert.deepEqual(pick(cause, ['service', 'reason', 'url']), {
      service: 'crm',
      reason: 'network',
      url: `${UNREACHABLE_URL}/v1/sync?api_token=***`,
    });
    assert.equal(JSON.stringify(alert.body).includes(QUERY_SECRET), false);
  });

  test('gives each status of a refusing service an alert of its own: a 422 of one route does not mute its 503', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });

    function refuse(status) {
      return failWith(toUpstreamAppError(new UpstreamError('status', { service: 'billing', status })));
    }

    fastify.get('/invoices', refuse(422));
    fastify.get('/payments', refuse(503));
    fastify.get('/refunds', refuse(503));

    await injectInTurn(fastify, ['/invoices', '/payments', '/refunds']);
    await waitForAlerts(receiver, 2);
    await sleep(SETTLE_MS);

    assert.deepEqual(receiver.requests.map((request) => readBlock(request.body, 'Error').cause.status), [422, 503]);
  });

  test('sends one "Database connection failed" for a database it cannot connect to whatever route meets it, and one for each code', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });

    function refuse(code) {
      return failWith(new DbError('The database does not let the app in', { code, isConnectFailure: true }));
    }

    fastify.get('/orders', refuse('ECONNREFUSED'));
    fastify.get('/users', refuse('ECONNREFUSED'));
    fastify.get('/reports', refuse('ER_ACCESS_DENIED_ERROR'));

    const responses = await injectInTurn(fastify, ['/orders', '/users', '/reports']);

    await waitForAlerts(receiver, 2);
    await sleep(SETTLE_MS);

    assert.deepEqual(responses.map((response) => response.statusCode), [500, 500, 500]);
    assert.deepEqual(readTitles(receiver), [DATABASE_CONNECTION_TITLE, DATABASE_CONNECTION_TITLE]);
    assert.deepEqual(readUrls(receiver), ['https://app.test/orders', 'https://app.test/reports']);
  });

  test('keeps the route of a session that is lost in the middle of a statement: the database may be well', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });

    function lose() {
      return failWith(new DbError('Connection lost: The server closed the connection.', { code: 'PROTOCOL_CONNECTION_LOST', isFatal: true }));
    }

    fastify.get('/orders', lose());
    fastify.get('/users', lose());

    await injectInTurn(fastify, ['/orders', '/users']);
    await waitForAlerts(receiver, 2);

    assert.deepEqual(readTitles(receiver), [SERVER_ERROR_TITLE, SERVER_ERROR_TITLE]);
    assert.deepEqual(readUrls(receiver), ['https://app.test/orders', 'https://app.test/users']);
  });

  test('tells a server that refuses connections from a full pool: a title and an alert of its own', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });
    const refusal = new DbError('Too many connections', { kind: DB_ERROR_KIND.OVERLOAD, code: 'ER_CON_COUNT_ERROR', errno: 1040 });

    fastify.get('/orders', failWith(new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause: refusal })));
    fastify.get('/users', failWith(createOverloadError()));

    await injectInTurn(fastify, ['/orders', '/users', '/orders']);
    await waitForAlerts(receiver, 2);
    await sleep(SETTLE_MS);

    assert.deepEqual(readTitles(receiver), [CONNECTIONS_REFUSED_TITLE, POOL_SATURATED_TITLE]);
    assert.deepEqual(receiver.requests.map((request) => readBlock(request.body, 'Error').code), ['ER_CON_COUNT_ERROR', 'POOL_QUEUE_FULL']);
  });

  test('leaves the window of failures to bugs: an overload a guest causes holds no "Server error" back', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    fastify.get('/busy', failWith(createOverloadError()));
    fastify.get('/boom', failWith(new Error('Route failed')));

    await injectInTurn(fastify, ['/busy', '/boom']);
    await waitForAlerts(receiver, 2);

    assert.deepEqual(readTitles(receiver), [POOL_SATURATED_TITLE, SERVER_ERROR_TITLE]);
  });

  test('sends "Database statement timeout" for a 503 whose cause is a statement that ran out of time', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });
    const timeout = new DbError('Query execution was interrupted (max_statement_time exceeded)', {
      kind: DB_ERROR_KIND.TIMEOUT,
      code: 'ER_STATEMENT_TIMEOUT',
      errno: 1969,
    });

    fastify.get('/report', failWith(new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause: timeout })));

    const response = await fastify.inject('/report');
    const [alert] = await waitForAlerts(receiver, 1);

    await sleep(SETTLE_MS);

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '60');
    assert.equal(receiver.requests.length, 1);
    assert.equal(alert.body.title, STATEMENT_TIMEOUT_TITLE);
    assert.equal(alert.body.throttleClass, 'warning');
    assert.equal(readBlock(alert.body, 'Url'), 'https://app.test/report');

    const errorBlock = readBlock(alert.body, 'Error');

    assert.equal(errorBlock.code, 'SERVICE_UNAVAILABLE_ERROR');
    assert.equal(errorBlock.cause.type, 'DbError');
    assert.equal(errorBlock.cause.kind, 'timeout');
    assert.equal(errorBlock.cause.errno, 1969);
  });

  test('sends "Database pool saturated" for a full pool, with the counters of the pool', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    fastify.get('/busy', failWith(createOverloadError()));

    const response = await fastify.inject('/busy');
    const [alert] = await waitForAlerts(receiver, 1);

    await sleep(SETTLE_MS);

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), errorBody(response, 'SERVICE_UNAVAILABLE_ERROR', 'Service unavailable'));
    assert.equal(receiver.requests.length, 1);
    assert.equal(alert.body.title, POOL_SATURATED_TITLE);
    assert.equal(alert.body.throttleClass, 'warning');
    assert.deepEqual(readBlock(alert.body, 'Error'), {
      message: 'The queue of the database pool is full',
      code: 'POOL_QUEUE_FULL',
      pool: fastify.db.getStats(),
    });
    assert.equal(Object.keys(fastify.db.getStats()).length > 0, true);
  });

  test('gives a full pool one alert whatever route meets it, and a statement timeout one alert for each route', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });

    function failWithTimeout() {
      const timeout = new DbError('Query execution was interrupted (max_statement_time exceeded)', { kind: DB_ERROR_KIND.TIMEOUT });

      throw new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause: timeout });
    }

    fastify.get('/orders', async () => {
      throw createOverloadError();
    });
    fastify.get('/users', async () => {
      throw createOverloadError();
    });
    fastify.get('/reports/daily', async () => failWithTimeout());
    fastify.get('/reports/weekly', async () => failWithTimeout());

    await injectInTurn(fastify, ['/orders', '/users', '/reports/daily', '/reports/daily', '/reports/weekly']);
    await waitForAlerts(receiver, 3);
    await sleep(SETTLE_MS);

    assert.deepEqual(readTitles(receiver), [POOL_SATURATED_TITLE, STATEMENT_TIMEOUT_TITLE, STATEMENT_TIMEOUT_TITLE]);
    assert.deepEqual(readUrls(receiver), [
      'https://app.test/orders',
      'https://app.test/reports/daily',
      'https://app.test/reports/weekly',
    ]);
  });
});

describe('error-alert plugin: a 503 of a database that cannot be reached', () => {
  function refuse(details) {
    const cause = new DbError('The database does not let the app in', { isConnectFailure: true, ...details });

    return failWith(new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause }));
  }

  test('sends one "Database connection failed" whatever route meets the outage, and one for each code: the class is "failure"', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });

    fastify.get('/orders', refuse({ code: 'ECONNREFUSED' }));
    fastify.get('/users', refuse({ code: 'ECONNREFUSED' }));
    fastify.get('/reports', refuse({ code: 'ER_ACCESS_DENIED_ERROR' }));

    const responses = await injectInTurn(fastify, ['/orders', '/users', '/reports']);

    await waitForAlerts(receiver, 2);
    await sleep(SETTLE_MS);

    assert.deepEqual(responses.map((response) => response.statusCode), [503, 503, 503]);
    assert.deepEqual(responses[0].json(), errorBody(responses[0], 'SERVICE_UNAVAILABLE_ERROR', 'Service unavailable'));
    assert.equal(responses[0].headers['retry-after'], '60');
    assert.deepEqual(readTitles(receiver), [DATABASE_CONNECTION_TITLE, DATABASE_CONNECTION_TITLE]);
    assert.deepEqual(readUrls(receiver), ['https://app.test/orders', 'https://app.test/reports']);
    assert.deepEqual(receiver.requests.map((request) => request.body.throttleClass), ['failure', 'failure']);
    assert.deepEqual(receiver.requests.map((request) => readBlock(request.body, 'Error').cause.code), ['ECONNREFUSED', 'ER_ACCESS_DENIED_ERROR']);
  });

  test('is the same outage as behind a 500: whichever a request meets first is the one alert', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });

    function fail(code) {
      return failWith(new DbError('The database does not let the app in', { code, isConnectFailure: true }));
    }

    fastify.get('/orders', fail('ECONNREFUSED'));
    fastify.get('/users', refuse({ code: 'ECONNREFUSED' }));
    fastify.get('/reports', refuse({ code: 'ETIMEDOUT' }));
    fastify.get('/stock', fail('ETIMEDOUT'));

    const responses = await injectInTurn(fastify, ['/orders', '/users', '/reports', '/stock']);

    await waitForAlerts(receiver, 2);
    await sleep(SETTLE_MS);

    assert.deepEqual(responses.map((response) => response.statusCode), [500, 503, 503, 500]);
    assert.deepEqual(readTitles(receiver), [DATABASE_CONNECTION_TITLE, DATABASE_CONNECTION_TITLE]);
    assert.deepEqual(readUrls(receiver), ['https://app.test/orders', 'https://app.test/reports']);
  });

  test('stays "Database refuses connections" of the class "warning" for a server out of connections, which opens none either', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    fastify.get('/orders', refuse({ kind: DB_ERROR_KIND.OVERLOAD, code: 'ER_USER_LIMIT_REACHED', errno: 1226 }));

    const response = await fastify.inject('/orders');
    const [alert] = await waitForAlerts(receiver, 1);

    await sleep(SETTLE_MS);

    assert.equal(response.statusCode, 503);
    assert.equal(receiver.requests.length, 1);
    assert.equal(alert.body.title, CONNECTIONS_REFUSED_TITLE);
    assert.equal(alert.body.throttleClass, 'warning');
    assert.deepEqual(readBlock(alert.body, 'Error'), {
      message: 'The database does not let the app in',
      code: 'ER_USER_LIMIT_REACHED',
      pool: fastify.db.getStats(),
    });
  });

  test('stays "Database statement timeout" of the class "warning" for a connection whose session could not be set in time', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify } = await buildApp(t, { receiver });

    fastify.get('/report', refuse({ kind: DB_ERROR_KIND.TIMEOUT, code: 'ER_STATEMENT_TIMEOUT', errno: 1969 }));

    await fastify.inject('/report');

    const [alert] = await waitForAlerts(receiver, 1);

    assert.equal(alert.body.title, STATEMENT_TIMEOUT_TITLE);
    assert.equal(alert.body.throttleClass, 'warning');
  });

  test('sends nothing for a 503 with no connection that failed to open behind it: only the 500 after them reaches the receiver', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });
    const causes = {
      none: undefined,
      other: new Error('Another service is away'),
      timeout: new DOMException('The operation timed out after 5000 ms', 'TimeoutError'),
      upstream: new UpstreamError('network', { service: 'billing' }),
      lost: new DbError('Connection lost: The server closed the connection.', { code: 'PROTOCOL_CONNECTION_LOST', isFatal: true }),
      conflict: new DbError('Lock wait timeout exceeded', { kind: DB_ERROR_KIND.DEADLOCK, code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 }),
    };

    Object.entries(causes).forEach(([name, cause]) => {
      fastify.get(`/${name}`, failWith(new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { cause })));
    });
    fastify.get('/pressure', failWith(Object.assign(new Error('Service Unavailable'), { statusCode: 503 })));
    fastify.get('/boom', failWith(new Error('Route failed')));

    const urls = [...Object.keys(causes).map((name) => `/${name}`), '/pressure'];
    const responses = await Promise.all(urls.map((url) => fastify.inject(url)));

    await sleep(SETTLE_MS);

    assert.deepEqual(responses.map((response) => response.statusCode), urls.map(() => 503));
    assert.deepEqual(receiver.requests, []);
    assert.deepEqual(findLogLines(sink, REPORT_FAILED_MESSAGE), []);

    await fastify.inject('/boom');
    await waitForAlerts(receiver, 1);
    await sleep(SETTLE_MS);

    assert.deepEqual(readTitles(receiver), [SERVER_ERROR_TITLE]);
    assert.deepEqual(readUrls(receiver), ['https://app.test/boom']);
  });
});

describe('error-alert plugin: anything can be thrown', () => {
  test('answers a thrown value whose getters throw and goes on serving: an unreadable message is still alerted, a value that throws on every read is logged instead', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await buildApp(t, { receiver });
    const unreadable = new Error('Unreadable');
    const trap = new Proxy({}, {
      get() {
        throw new Error('Every read of this value fails');
      },
    });

    Object.defineProperty(unreadable, 'message', {
      get() {
        throw new Error('The getter of the message fails');
      },
    });

    fastify.get('/unreadable', failWith(unreadable));
    fastify.get('/trap', failWith(trap));
    fastify.get('/alive', async () => ({ isAlive: true }));

    const [first, second] = await Promise.all([fastify.inject('/unreadable'), fastify.inject('/trap')]);
    const alive = await fastify.inject('/alive');

    await sleep(SETTLE_MS);

    assert.equal(first.statusCode, 500);
    assert.deepEqual(first.json(), errorBody(first, 'SERVER_ERROR', 'Server error'));
    assert.equal(second.statusCode, 500);
    assert.equal(second.json().code, 'SERVER_ERROR');
    assert.equal(alive.statusCode, 200);
    assert.deepEqual(alive.json(), { isAlive: true });

    const failures = findLogLines(sink, REPORT_FAILED_MESSAGE);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].level, LOG_LEVEL.ERROR);
    assert.equal(failures[0].err.message, 'Every read of this value fails');
    assert.deepEqual(readTitles(receiver), [SERVER_ERROR_TITLE]);
  });

  test('alerts on a thrown value that is not an error: a text, null, a number', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await buildApp(t, { receiver, alert: { throttleWindow: NO_THROTTLE } });

    fastify.get('/text', failWith(`Duplicate entry '${SECRET_VALUE}' for key 'uq_users_email'`));
    fastify.get('/null', failWith(null));
    fastify.get('/number', failWith(42));

    const responses = await injectInTurn(fastify, ['/text', '/null', '/number']);

    await waitForAlerts(receiver, 3);
    await sleep(SETTLE_MS);

    assert.deepEqual(responses.map((response) => response.statusCode), [500, 500, 500]);
    assert.deepEqual(readTitles(receiver), [SERVER_ERROR_TITLE, SERVER_ERROR_TITLE, SERVER_ERROR_TITLE]);
    assert.deepEqual(readUrls(receiver), ['https://app.test/text', 'https://app.test/null', 'https://app.test/number']);
    assert.deepEqual(receiver.requests.map((request) => readBlock(request.body, 'Error')), [
      "Duplicate entry '***' for key 'uq_users_email'",
      undefined,
      42,
    ]);
    assert.equal(JSON.stringify(receiver.requests).includes(SECRET_VALUE), false);
    assert.deepEqual(findLogLines(sink, REPORT_FAILED_MESSAGE), []);
  });

  test('still alerts on a value whose status getter throws: the status is read under a guard', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const { fastify, sink } = await buildApp(t, { receiver });
    const error = new Error('Status cannot be read');

    Object.defineProperty(error, 'statusCode', {
      enumerable: true,
      get() {
        throw new Error('The getter of the status fails');
      },
    });

    fastify.get('/status', failWith(error));

    const response = await fastify.inject('/status');
    const [alert] = await waitForAlerts(receiver, 1);

    assert.equal(response.statusCode, 500);
    assert.equal(alert.body.title, SERVER_ERROR_TITLE);
    assert.equal(readBlock(alert.body, 'Error').message, 'Status cannot be read');
    assert.equal(readBlock(alert.body, 'Error').statusCode, '[unreadable]');
    assert.deepEqual(findLogLines(sink, REPORT_FAILED_MESSAGE), []);
  });
});
