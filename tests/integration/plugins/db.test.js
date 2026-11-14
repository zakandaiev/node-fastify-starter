import { getContext } from '#core/context/index.js';
import { afterCommit, withTransaction } from '#core/db/transaction.js';
import { readRequestId } from '#root/tests/helper/app.js';
import { countSessionsLeft, createTestDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testDb = await createTestDb();

describe('db plugin with a database', { skip: testDb.skip }, () => {
  before(() => testDb.run(() => testDb.db.query('CREATE TABLE visits (id INT PRIMARY KEY, path VARCHAR(100) NOT NULL)')));

  test('a handler runs its statements through the context, and their log lines carry the id of the request', async (t) => {
    const sink = createLogSink();
    const fastify = await testDb.buildApp({ logger: { level: 'info', stream: sink.stream } });
    t.after(() => fastify.close());

    fastify.get('/visits', async () => {
      const { rows } = await getContext().db.query('SELECT COUNT(*) AS total FROM visits WHERE path = :path', { path: '/visits' });

      return rows[0];
    });

    const response = await fastify.inject('/visits');
    const statements = sink.lines.filter((line) => line.msg === 'Database query');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { total: 0 });
    assert.equal(statements.length, 1);
    assert.equal(statements[0].requestId, readRequestId(response));
    assert.equal(statements[0].sql, 'SELECT COUNT(*) AS total FROM visits WHERE path = :path');
  });

  test('a handler opens a transaction with no argument: the request carries it', async (t) => {
    const fastify = await testDb.buildApp();
    t.after(() => fastify.close());

    const seen = [];

    fastify.post('/visits/:id', async (request) => {
      await withTransaction(async () => {
        await request.server.db.query('INSERT INTO visits (id, path) VALUES (:id, :path)', { id: Number(request.params.id), path: request.url });
        await afterCommit(() => seen.push(request.params.id));

        if (request.params.id === '2') {
          throw new Error('boom');
        }
      });

      return { isSaved: true };
    });

    const [saved, failed] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/visits/1' }),
      fastify.inject({ method: 'POST', url: '/visits/2' }),
    ]);
    const { rows } = await testDb.run(() => testDb.db.query('SELECT id FROM visits ORDER BY id'));

    assert.equal(saved.statusCode, 200);
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(rows, [{ id: 1 }]);
    assert.deepEqual(seen, ['1']);
  });

  test('the app ends its pool when it closes, and its connections are gone from the server', async () => {
    const fastify = await testDb.buildApp({ db: { connectionLimit: 2 } });

    fastify.get('/session', async (request) => {
      const { rows } = await request.server.db.query('SELECT CONNECTION_ID() AS id, SLEEP(0.05) AS waited');

      return rows[0];
    });

    const responses = await Promise.all([fastify.inject('/session'), fastify.inject('/session')]);
    const ids = responses.map((response) => response.json().id);
    const open = await countSessionsLeft(testDb, ids, 0);

    // close() resolves once the goodbye of every connection is written, a moment before the server drops them.
    await fastify.close();
    await assert.rejects(fastify.db.ping(), /Pool is closed/);

    assert.equal(new Set(ids).size, 2);
    assert.equal(open, 2);
    assert.equal(await countSessionsLeft(testDb, ids), 0);
  });
});
