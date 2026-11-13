import { buildApp } from '#root/src/app.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import assert from 'node:assert/strict';
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
});
