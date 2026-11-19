import { absPath } from '#config/path.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { buildApp } from '#root/src/app.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { uuidVersion } from '#utils/id.js';
import { PromisePool } from 'mysql2/promise';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { describe, test } from 'node:test';

describe('buildApp', () => {
  test('requires config', async () => {
    await assert.rejects(buildApp(), /requires the result of createConfig/);
    await assert.rejects(buildApp({}), /requires the result of createConfig/);
  });

  test('returns an instance that does not listen', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    assert.equal(fastify.server.listening, false);
  });

  test('exposes config and the base context', async (t) => {
    const config = createTestConfig();
    const fastify = await buildApp({ config });
    t.after(() => fastify.close());

    assert.equal(fastify.config, config);
    assert.equal(fastify.context.config, config);
    assert.equal(fastify.context.log, fastify.log);
    assert.equal(fastify.log.level, 'silent');
  });

  test('keeps two apps with different config apart in one process', async (t) => {
    const prod = await buildTestApp({ env: { APP_MODE: 'prod' } });
    const dev = await buildTestApp({ env: { APP_MODE: 'dev' }, app: { bodyLimit: 16 } });
    t.after(() => Promise.all([prod.close(), dev.close()]));

    assert.equal(prod.config.app.isDev, false);
    assert.equal(dev.config.app.isDev, true);
    assert.notEqual(prod.context, dev.context);
    assert.notEqual(prod.log, dev.log);

    const payload = JSON.stringify({ text: 'x'.repeat(32) });
    const headers = { 'content-type': 'application/json' };

    [prod, dev].forEach((fastify) => fastify.post('/echo', (request) => request.body));

    const [prodResponse, devResponse] = await Promise.all([
      prod.inject({
        method: 'POST',
        url: '/echo',
        payload,
        headers,
      }),
      dev.inject({
        method: 'POST',
        url: '/echo',
        payload,
        headers,
      }),
    ]);

    assert.equal(prodResponse.statusCode, 200);
    assert.equal(devResponse.statusCode, 413);
  });

  test('rejects a body over the small default limit before the handler runs', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    let isHandled = false;

    fastify.post('/echo', (request) => {
      isHandled = true;

      return request.body;
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/echo',
      payload: JSON.stringify({ text: 'x'.repeat(fastify.config.app.bodyLimit) }),
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(response.statusCode, 413);
    assert.equal(isHandled, false);
  });

  test('uses no deprecated Fastify option', async (t) => {
    const warnings = [];

    function collect(warning) {
      warnings.push(warning.code);
    }

    process.on('warning', collect);
    t.after(() => process.off('warning', collect));

    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    await fastify.ready();
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.deepEqual(warnings.filter((code) => String(code).startsWith('FSTDEP')), []);
  });

  test('trusts X-Forwarded-For only from a loopback or private proxy', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/ip', (request) => ({ ip: request.ip }));

    const headers = { 'x-forwarded-for': '203.0.113.7' };
    const [viaLoopback, viaPrivate, viaDocker, viaPublic] = await Promise.all(
      ['127.0.0.1', '10.0.0.5', '172.23.0.2', '198.51.100.9'].map((remoteAddress) => fastify.inject({ url: '/ip', remoteAddress, headers })),
    );

    assert.equal(viaLoopback.json().ip, '203.0.113.7');
    assert.equal(viaPrivate.json().ip, '203.0.113.7');
    assert.equal(viaDocker.json().ip, '203.0.113.7');
    assert.equal(viaPublic.json().ip, '198.51.100.9');
  });

  test('loads the plugins of src/plugins under their names', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    assert.deepEqual(
      ['error-handler', 'context', 'redis', 'db', 'cache', 'response'].map((name) => fastify.hasPlugin(name)),
      [true, true, true, true, true, true],
    );
  });

  // The routes fail to load after the db plugin has registered its onClose hook. A pool that never opened
  // a connection cannot fail to end by itself, so the failure is put into the driver's own end().
  test('rejects with the error that stopped the start, also when closing the instance fails', async (t) => {
    const sink = createLogSink();
    const end = t.mock.method(PromisePool.prototype, 'end', async () => {
      throw new Error('The pool refused to close');
    });

    await assert.rejects(
      buildTestApp({ app: { apiPrefix: '/*/x' }, logger: { level: 'error', stream: sink.stream } }),
      /Wildcard must be the last character in the route/,
    );

    const closeFailures = sink.lines.filter((line) => line.msg === 'Failed to close the app after a failed start');

    assert.equal(end.mock.callCount(), 1);
    assert.equal(closeFailures.length, 1);
    assert.equal(closeFailures[0].err.message, 'The pool refused to close');
  });

  // A route keeps the error handler its scope had when its plugin was loaded: a plugin that declares a route
  // and is loaded before the handler would answer with the body of Fastify.
  // Autoload registers the files of the directory in the order of their names and every folder after all of them:
  // the numeric prefix is the load order only while a plugin is a file.
  test('loads the error handler before every other plugin: a plugin is a file, a folder there starts with "_"', async () => {
    const entries = (await readdir(absPath.plugin, { withFileTypes: true })).filter((entry) => !entry.name.startsWith('_'));
    const [first, ...rest] = entries.map((entry) => entry.name).sort();

    assert.equal(first, '000.error-handler.js');
    assert.ok(rest.length > 0);
    assert.deepEqual(entries.filter((entry) => !entry.isFile()).map((entry) => entry.name), []);
  });

  test('does not start with limits of the error path that are not positive integers', async () => {
    const sections = [
      { validation: { maxErrors: 0, maxValueLength: 256, maxListLength: 20 } },
      { validation: { maxErrors: 20, maxValueLength: '256', maxListLength: 20 } },
      { validation: { maxErrors: 20, maxValueLength: 1.5, maxListLength: 20 } },
      { validation: { maxErrors: 20, maxValueLength: 2 ** 53, maxListLength: 20 } },
      { validation: { maxErrors: Infinity, maxValueLength: 256, maxListLength: 20 } },
      { validation: { maxErrors: 20, maxValueLength: 256, maxListLength: 0 } },
      { validation: { maxErrors: 20, maxValueLength: 256 } },
      { validation: { maxErrors: 20 } },
      { validation: null },
    ];
    const results = await Promise.allSettled(sections.map((app) => buildTestApp({ app })));

    results.forEach((result) => {
      assert.equal(result.status, 'rejected');
      assert.match(
        result.reason.message,
        /config\.app\.validation requires maxErrors, maxValueLength and maxListLength to be positive integers/,
      );
    });
  });

  test('does not start with a Retry-After of a 503 that is not a duration', async () => {
    await assert.rejects(buildTestApp({ app: { unavailableRetryAfter: '1 min' } }), /convertStringToSeconds/);
  });

  test('does not start with a Retry-After of a 503 that is not a whole number of seconds, zero or more', async () => {
    const durations = ['1.5s', '-30s', '0.5s'];
    const results = await Promise.allSettled(durations.map((unavailableRetryAfter) => buildTestApp({ app: { unavailableRetryAfter } })));

    results.forEach((result) => {
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.message, /config\.app\.unavailableRetryAfter requires a whole number of seconds that is not negative/);
    });
  });

  test('starts with a Retry-After of zero seconds and sends it with a 503', async (t) => {
    const fastify = await buildTestApp({ app: { unavailableRetryAfter: '0s' } });
    t.after(() => fastify.close());

    fastify.get('/busy', async () => {
      throw new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
    });

    const response = await fastify.inject('/busy');

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '0');
  });

  // The hook is created before the instance and its logger: a config both refuse is refused by the hook.
  test('refuses a bad prefix before it creates the instance', async () => {
    await assert.rejects(buildTestApp({ app: { apiPrefix: '/api/' }, logger: { level: '' } }), /createRouteHook/);
  });

  test('rejects with the error that stopped the start', async () => {
    await assert.rejects(buildTestApp({ app: { apiPrefix: '/*/x' } }), /Wildcard must be the last character in the route/);
  });

  test('gives every request an id of its own making, a UUIDv7', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/id', (request) => ({ id: request.id }));

    const [first, second] = await Promise.all([
      fastify.inject({ url: '/id', headers: { 'x-request-id': 'chosen-by-the-client' } }),
      fastify.inject('/id'),
    ]);

    assert.equal(uuidVersion(first.json().id), 7);
    assert.equal(uuidVersion(second.json().id), 7);
    assert.notEqual(first.json().id, second.json().id);
  });
});
