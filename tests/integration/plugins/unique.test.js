import { MODE } from '#config/env.js';
import { readRequestId } from '#root/tests/helper/app.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const INSERT_USER_SQL = 'INSERT INTO users (id, email) VALUES (:id, :email)';
const COUNT_USERS_SQL = Object.freeze({
  email: 'SELECT COUNT(*) AS total FROM users WHERE email = :value',
  id: 'SELECT COUNT(*) AS total FROM users WHERE id = :value',
});

const REQUEST_FAILED_MESSAGE = 'Request failed';
const LOG_LEVEL_WARN = 40;

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

// A sign-up that writes what the client sent, through the pool of the app.
async function startApp(t, { mode = MODE.PROD, ...sections } = {}) {
  const fastify = await testDb.buildApp({ ...sections, env: { APP_MODE: mode } });
  t.after(() => fastify.close());

  fastify.post('/users', async (request) => {
    await request.server.db.query(INSERT_USER_SQL, { id: request.body.id, email: request.body.email });

    return { isSaved: true };
  });

  return fastify;
}

// The first write goes through, the second meets the row of the first.
async function signUpTwice(fastify, first, second) {
  const created = await fastify.inject({ method: 'POST', url: '/users', payload: first });
  const refused = await fastify.inject({ method: 'POST', url: '/users', payload: second });

  assert.equal(created.statusCode, 200, created.body);

  return refused;
}

function readFailure(response) {
  return pick(response.json(), ['status', 'code', 'message', 'validation', 'meta']);
}

function createFailure(response, message, column, columnValue) {
  return {
    status: 'error',
    code: 'VALIDATION_ERROR',
    message,
    validation: [{
      column,
      columnValue,
      operator: 'unique',
      operatorValue: null,
    }],
    meta: { requestId: readRequestId(response) },
  };
}

async function countUsers(field, value) {
  const [{ total }] = await testDb.readRows(COUNT_USERS_SQL[field], { value });

  return total;
}

describe('a duplicate written through the app', { skip: testDb.skip }, () => {
  before(() => up());

  test('answers 422 VALIDATION_ERROR on the field of the unique index, without the index or the text of the database in prod', async (t) => {
    const fastify = await startApp(t);
    const email = 'anna@example.com';
    const response = await signUpTwice(fastify, { id: uuidv7(), email }, { id: uuidv7(), email });

    assert.equal(response.statusCode, 422);
    assert.deepEqual(readFailure(response), createFailure(response, 'Validation error', 'email', email));
    assert.doesNotMatch(response.body, /uq_users_email|Duplicate entry/);
    assert.equal(await countUsers('email', email), 1);
  });

  test('gives a developer the text of the database: it names the index and masks the value', async (t) => {
    const fastify = await startApp(t, { mode: MODE.DEV });
    const email = 'borys@example.com';
    const response = await signUpTwice(fastify, { id: uuidv7(), email }, { id: uuidv7(), email });

    assert.equal(response.statusCode, 422);
    assert.deepEqual(readFailure(response), createFailure(response, "Duplicate entry '***' for key 'uq_users_email'", 'email', email));
  });

  test('answers a duplicate of an index no schema names, the primary key, with a null column', async (t) => {
    const [prod, dev] = await Promise.all([startApp(t), startApp(t, { mode: MODE.DEV })]);
    const ids = [uuidv7(), uuidv7()];
    const responses = await Promise.all([prod, dev].map((fastify, index) => signUpTwice(
      fastify,
      { id: ids[index], email: `first-${index}@example.com` },
      { id: ids[index], email: `second-${index}@example.com` },
    )));

    assert.deepEqual(responses.map((response) => response.statusCode), [422, 422]);
    assert.deepEqual(readFailure(responses[0]), createFailure(responses[0], 'Validation error', null, null));
    assert.deepEqual(readFailure(responses[1]), createFailure(responses[1], "Duplicate entry '***' for key 'PRIMARY'", null, null));
    assert.deepEqual(await Promise.all(ids.map((id) => countUsers('id', id))), [1, 1]);
  });

  test('logs the duplicate once, as a warning that names the index and never the value', async (t) => {
    const sink = createLogSink();
    const fastify = await startApp(t, { logger: { level: 'info', stream: sink.stream } });
    const email = 'chris@example.com';
    const response = await signUpTwice(fastify, { id: uuidv7(), email }, { id: uuidv7(), email });
    const failures = sink.lines.filter((line) => line.msg === REQUEST_FAILED_MESSAGE);

    assert.equal(response.statusCode, 422);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].level, LOG_LEVEL_WARN);
    assert.deepEqual(pick(failures[0].err, ['type', 'kind', 'constraint']), { type: 'DbError', kind: 'unique', constraint: 'uq_users_email' });
    assert.deepEqual(failures[0].validation, [{ column: 'email', operator: 'unique', operatorValue: null }]);
    assert.equal(JSON.stringify(sink.lines).includes(email), false);
  });
});
