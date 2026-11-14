import { assertRouteContract } from '#core/schema/route.js';
import useSystemRoutes from '#root/src/routes/v1/system/index.js';
import { buildTestApp, readRequestId } from '#root/tests/helper/app.js';
import { createLogSink } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PING_URL = '/api/v1/system/ping';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const OTHER_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const NEIGHBOUR_URLS = ['/api/v1/system', '/api/v1/system/', '/api/v1/system/controller', '/api/v1/ping', '/v1/system/ping'];

function notFoundBody(response) {
  return {
    status: 'error',
    code: 'NOT_FOUND_ERROR',
    message: 'Not found',
    meta: { requestId: readRequestId(response) },
  };
}

describe('GET /api/v1/system/ping', () => {
  test('answers 200 with the envelope and the id of the request, in the body and in X-Request-Id', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const response = await fastify.inject(PING_URL);
    const requestId = readRequestId(response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE);
    assert.deepEqual(response.json(), {
      status: 'success',
      data: { isAlive: true },
      meta: { requestId },
    });
    assert.equal(response.payload, `{"status":"success","data":{"isAlive":true},"meta":{"requestId":"${requestId}"}}`);
  });

  test('answers the same in dev mode', async (t) => {
    const fastify = await buildTestApp({ env: { APP_MODE: 'dev' } });
    t.after(() => fastify.close());

    const response = await fastify.inject(PING_URL);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: 'success',
      data: { isAlive: true },
      meta: { requestId: readRequestId(response) },
    });
  });

  test('answers a HEAD request with 200 and no body', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const response = await fastify.inject({ method: 'HEAD', url: PING_URL });

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload, '');
    assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE);
    readRequestId(response);
  });

  test('is public by contract: security { auth: false } and a typed response, for GET and for its HEAD twin', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const routes = [];

    fastify.addHook('onRoute', (routeOptions) => {
      routes.push(routeOptions);
    });

    await fastify.register(useSystemRoutes, { prefix: '/api/v2/system' });

    const pingRoutes = routes.filter((route) => route.url === '/api/v2/system/ping');

    assert.deepEqual(pingRoutes.map((route) => route.method), ['GET', 'HEAD']);
    pingRoutes.forEach((route) => {
      assert.deepEqual(route.security, { auth: false });
      assert.doesNotThrow(() => assertRouteContract(route));
    });
  });

  test('answers no other method: each gets the 404 envelope', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const responses = await Promise.all(OTHER_METHODS.map((method) => fastify.inject({ method, url: PING_URL })));

    responses.forEach((response) => {
      assert.equal(response.statusCode, 404);
      assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE);
      assert.deepEqual(response.json(), notFoundBody(response));
    });
  });

  test('has no route at the paths around it: its folder, its controller file, the path without the prefix', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const responses = await Promise.all(NEIGHBOUR_URLS.map((url) => fastify.inject(url)));

    responses.forEach((response) => {
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), notFoundBody(response));
    });
  });

  test('moves with the API prefix of the config', async (t) => {
    const fastify = await buildTestApp({ app: { apiPrefix: '/backend' } });
    t.after(() => fastify.close());

    const [moved, old] = await Promise.all([fastify.inject('/backend/v1/system/ping'), fastify.inject(PING_URL)]);

    assert.equal(moved.statusCode, 200);
    assert.deepEqual(moved.json().data, { isAlive: true });
    assert.equal(old.statusCode, 404);
  });

  test('logs the request under its requestId', async (t) => {
    const sink = createLogSink();
    const fastify = await buildTestApp({ logger: { level: 'info', stream: sink.stream } });
    t.after(() => fastify.close());

    const response = await fastify.inject(PING_URL);
    const requestId = readRequestId(response);
    const incoming = sink.lines.find((line) => line.msg === 'incoming request');
    const requestLines = sink.lines.filter((line) => line.req || line.res);

    assert.equal(incoming.requestId, requestId);
    assert.equal(incoming.req.method, 'GET');
    assert.equal(incoming.req.url, PING_URL);
    assert.equal(Object.hasOwn(incoming, 'reqId'), false);
    assert.deepEqual(requestLines.map((line) => line.requestId), requestLines.map(() => requestId));
  });
});
