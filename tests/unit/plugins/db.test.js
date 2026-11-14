import { getContext } from '#core/context/index.js';
import { buildTestApp, readRequestId } from '#root/tests/helper/app.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function buildAppWithoutDatabase(t, sections = {}) {
  const fastify = await buildTestApp({ ...sections, env: await createDownEnv() });

  t.after(() => fastify.close());

  return fastify;
}

describe('db plugin', () => {
  test('is registered under the name "db" and puts the database into the context of the app', async (t) => {
    const fastify = await buildAppWithoutDatabase(t);

    assert.equal(fastify.hasPlugin('db'), true);
    assert.equal(fastify.context.db, fastify.db);
    assert.equal(fastify.context.config, fastify.config);
    assert.equal(fastify.context.log, fastify.log);
    assert.ok(Object.isFrozen(fastify.context));
  });

  test('opens no connection while the app is built: a route that needs no database answers without one', async (t) => {
    const fastify = await buildAppWithoutDatabase(t);
    const response = await fastify.inject('/api/v1/system/ping');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(fastify.db.getStats(), {
      connectionLimit: fastify.config.db.connectionLimit,
      queueLimit: fastify.config.db.queueLimit,
      activeCount: 0,
      queueLength: 0,
      rejectedCount: 0,
      timeoutCount: 0,
    });
  });

  test('gives every request the database of the app through its context', async (t) => {
    const fastify = await buildAppWithoutDatabase(t);

    fastify.get('/items', () => ({ isSame: getContext().db === fastify.db }));

    const response = await fastify.inject('/items');

    assert.deepEqual(response.json(), { isSame: true });
  });

  test('a statement against a database that is down answers 500 and is logged as an error, not as an overload', async (t) => {
    const sink = createLogSink();
    const fastify = await buildAppWithoutDatabase(t, { logger: { level: 'info', stream: sink.stream } });

    fastify.get('/items', async (request) => request.server.db.query('SELECT 1'));

    const response = await fastify.inject('/items');
    const failed = sink.lines.find((line) => line.msg === 'Request failed');

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), {
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'Server error',
      meta: { requestId: readRequestId(response) },
    });
    assert.equal(failed.level, 50);
    assert.equal(failed.err.type, 'DbError');
    assert.equal(failed.err.code, 'ECONNREFUSED');
    assert.equal(failed.err.isFatal, true);
  });

  test('ends the pool when the app closes: a statement after that is refused', async (t) => {
    const fastify = await buildAppWithoutDatabase(t);

    await fastify.close();

    await assert.rejects(fastify.db.ping(), /Pool is closed/);
    assert.equal(await fastify.db.close(), false);
  });
});
