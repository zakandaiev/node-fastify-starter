import {
  createAlertReceiver,
  NO_THROTTLE,
  readBlock,
  readTitles,
  readUrls,
} from '#root/tests/helper/alert.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createGate, createTestDb, killSession } from '#root/tests/helper/db.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const testDb = await createTestDb();

const SERVER_ERROR_TITLE = 'Server error (5xx)';
const DATABASE_CONNECTION_TITLE = 'Database connection failed';

// An alert that should not go out has this long to reach the receiver.
const SETTLE_MS = 300;

async function openApp(t, { receiver, env = {} }) {
  const fastify = await testDb.buildApp({
    env: { ...REDIS_DOWN_ENV, ...receiver.env.webhook, ...env },
    alert: { ...receiver.config.alert, throttleWindow: NO_THROTTLE },
  });

  t.after(() => fastify.close());

  return fastify;
}

function injectInTurn(fastify, urls) {
  return urls.reduce(async (previous, url) => {
    const statuses = await previous;
    const response = await fastify.inject(url);

    return [...statuses, response.statusCode];
  }, Promise.resolve([]));
}

describe('error-alert plugin with a database', { skip: testDb.skip }, () => {
  test('keeps the route of a lost session in its alert: a statement killed on one route mutes no other', async (t) => {
    // A gate for each: the server may still list the killed session at the one it waited at.
    const [firstGate, secondGate] = await Promise.all([createGate(t), createGate(t)]);
    const receiver = await createAlertReceiver(t);
    const fastify = await openApp(t, { receiver });

    async function runAndKill(url, gate) {
      const response = fastify.inject(url);

      await killSession(testDb, await gate.findWaiter(testDb));

      return (await response).statusCode;
    }

    fastify.get('/first', async (request) => request.server.db.query(firstGate.statement));
    fastify.get('/second', async (request) => request.server.db.query(secondGate.statement));

    const statuses = [await runAndKill('/first', firstGate), await runAndKill('/second', secondGate)];

    await waitFor(() => receiver.requests.length === 2, 'the alerts of both routes');

    assert.deepEqual(statuses, [500, 500]);
    assert.deepEqual(readTitles(receiver), [SERVER_ERROR_TITLE, SERVER_ERROR_TITLE]);
    assert.deepEqual(readUrls(receiver), ['http://localhost:80/first', 'http://localhost:80/second']);
  });

  test('sends one "Database connection failed" for a database that refuses the account, whatever route meets it', async (t) => {
    const receiver = await createAlertReceiver(t);
    const fastify = await openApp(t, { receiver, env: { APP_DATABASE_PASSWORD: 'a-password-nobody-set' } });

    fastify.get('/first', async (request) => request.server.db.query('SELECT 1 AS one'));
    fastify.get('/second', async (request) => request.server.db.query('SELECT 2 AS two'));

    assert.deepEqual(await injectInTurn(fastify, ['/first', '/second', '/first']), [500, 500, 500]);

    await waitFor(() => receiver.requests.length > 0, 'the alert of the database');
    await sleep(SETTLE_MS);

    const [{ body }] = receiver.requests;

    assert.equal(receiver.requests.length, 1);
    assert.equal(body.title, DATABASE_CONNECTION_TITLE);
    assert.equal(body.throttleClass, 'failure');
    assert.equal(readBlock(body, 'Error').code, 'ER_ACCESS_DENIED_ERROR');
  });
});
