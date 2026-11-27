import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { buildTestApp, readRequestId } from '#root/tests/helper/app.js';
import { createLogSink, forgetLines } from '#root/tests/helper/log.js';
import { listEnvelope, successEnvelope } from '#schemas/common/envelope.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const HOOK_DELAY_MS = 5;
const DECORATOR_NAMES = ['ok', 'created', 'list', 'noContent', 'fail'];

const PUBLIC = Object.freeze({ auth: false });

const USER_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    id: { type: 'integer' },
    firstName: { type: 'string' },
  },
});

const USER = Object.freeze({ id: 1, firstName: 'Anna' });
const USER_ROW = Object.freeze({ ...USER, passwordHash: '$argon2id$stored-hash' });

const PAGINATION = Object.freeze({
  total: 250,
  limit: 20,
  offset: 40,
  totalPages: 13,
  currentPage: 3,
  canLoadMore: true,
});

const SORT = Object.freeze([{
  label: 'Newest first',
  value: 'newest',
  isChecked: true,
  isDefault: true,
}]);

const FILTERS = Object.freeze([{
  type: 'options',
  name: 'status',
  label: 'Status',
  isMultiple: true,
  isDisabled: false,
  value: null,
  options: [{
    label: 'Active',
    value: 'active',
    isChecked: false,
    isDisabled: false,
  }],
}]);

const UNIQUE_EMAIL = Object.freeze({
  column: 'email',
  columnValue: 'anna@example.com',
  operator: 'unique',
  operatorValue: null,
});

function readMeta(response) {
  return { requestId: readRequestId(response) };
}

function serverErrorBody(response) {
  return {
    status: 'error',
    code: 'SERVER_ERROR',
    message: 'Server error',
    meta: readMeta(response),
  };
}

function injectAll(fastify, urls) {
  return Promise.all(urls.map((url) => fastify.inject(url)));
}

async function buildWarnLoggedApp(t) {
  const sink = createLogSink();
  const fastify = await buildTestApp({ logger: { level: 'warn', stream: sink.stream } });

  t.after(() => fastify.close());
  forgetLines(sink);

  return { fastify, sink };
}

async function useShop(fastify) {
  fastify.get('/items', async (request, reply) => reply.list({ data: [USER], pagination: PAGINATION }));
}

describe('reply.ok', () => {
  test('answers 200 with the data in the envelope and the id of the request in meta', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/users/1', (request, reply) => reply.ok(USER));

    const response = await fastify.inject('/users/1');

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE);
    assert.deepEqual(response.json(), { status: 'success', data: USER, meta: readMeta(response) });
    assert.deepEqual(Object.keys(response.json()), ['status', 'data', 'meta']);
  });

  test('answers data: null when it is given no data', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/nothing', (request, reply) => reply.ok());
    fastify.get('/undefined', (request, reply) => reply.ok(undefined));
    fastify.get('/null', (request, reply) => reply.ok(null));

    const responses = await injectAll(fastify, ['/nothing', '/undefined', '/null']);

    responses.forEach((response) => {
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: 'success', data: null, meta: readMeta(response) });
    });
  });

  test('keeps falsy data as it is', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const values = [0, false, '', []];

    values.forEach((value, index) => fastify.get(`/values/${index}`, (request, reply) => reply.ok(value)));

    const responses = await injectAll(fastify, values.map((value, index) => `/values/${index}`));

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 200, 200]);
    assert.deepEqual(responses.map((response) => response.json().data), values);
  });

  test('sends nothing the response schema of the route does not declare', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/api/users/1', {
      schema: { response: { 200: successEnvelope(USER_SCHEMA) } },
      security: PUBLIC,
    }, (request, reply) => reply.ok(USER_ROW));

    const response = await fastify.inject('/api/users/1');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'success', data: USER, meta: readMeta(response) });
    assert.equal(response.payload.includes('passwordHash'), false);
  });

  test('answers data: null through a schema that declares data as null', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.post('/api/users/1/logout', {
      schema: { response: { 200: successEnvelope({ type: 'null' }) } },
      security: PUBLIC,
    }, (request, reply) => reply.ok());

    const response = await fastify.inject({ method: 'POST', url: '/api/users/1/logout' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'success', data: null, meta: readMeta(response) });
  });
});

describe('reply.created', () => {
  test('answers 201 with the data in the envelope', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.post('/users', (request, reply) => reply.created(USER));

    const response = await fastify.inject({ method: 'POST', url: '/users' });

    assert.equal(response.statusCode, 201);
    assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE);
    assert.deepEqual(response.json(), { status: 'success', data: USER, meta: readMeta(response) });
  });

  test('answers data: null when it is given no data', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.post('/users', (request, reply) => reply.created());

    const response = await fastify.inject({ method: 'POST', url: '/users' });

    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json(), { status: 'success', data: null, meta: readMeta(response) });
  });

  test('is filtered by the 201 schema of the route', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.post('/api/users', {
      schema: { response: { 201: successEnvelope(USER_SCHEMA) } },
      security: PUBLIC,
    }, (request, reply) => reply.created(USER_ROW));

    const response = await fastify.inject({ method: 'POST', url: '/api/users' });

    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json(), { status: 'success', data: USER, meta: readMeta(response) });
  });
});

describe('reply.list', () => {
  test('answers 200 with the rows, pagination, sort and filters of the result', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/users', (request, reply) => reply.list({
      data: [USER],
      filters: FILTERS,
      sort: SORT,
      pagination: PAGINATION,
    }));

    const response = await fastify.inject('/users');

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE);
    assert.deepEqual(response.json(), {
      status: 'success',
      data: [USER],
      pagination: PAGINATION,
      sort: SORT,
      filters: FILTERS,
      meta: readMeta(response),
    });
    assert.deepEqual(Object.keys(response.json()), ['status', 'data', 'pagination', 'sort', 'filters', 'meta']);
  });

  test('leaves out a section that is empty or missing, never the rows', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/empty', (request, reply) => reply.list({ data: [], sort: [], filters: [] }));
    fastify.get('/bare', (request, reply) => reply.list({ data: [USER] }));
    fastify.get('/api/empty', {
      schema: { response: { 200: listEnvelope(USER_SCHEMA) } },
      security: PUBLIC,
    }, (request, reply) => reply.list({ data: [], sort: [], filters: [] }));

    const [empty, bare, typed] = await injectAll(fastify, ['/empty', '/bare', '/api/empty']);

    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { status: 'success', data: [], meta: readMeta(empty) });
    assert.deepEqual(bare.json(), { status: 'success', data: [USER], meta: readMeta(bare) });
    assert.deepEqual(typed.json(), { status: 'success', data: [], meta: readMeta(typed) });
  });

  test('sends only the four sections of the result', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/users', (request, reply) => reply.list({
      data: [USER],
      pagination: PAGINATION,
      sql: 'SELECT * FROM users',
      code: 'NO_CHANGES',
    }));

    const response = await fastify.inject('/users');

    assert.deepEqual(response.json(), {
      status: 'success',
      data: [USER],
      pagination: PAGINATION,
      meta: readMeta(response),
    });
  });

  test('is filtered by the list schema of the route, in the rows and in every section', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/api/users', {
      schema: { response: { 200: listEnvelope(USER_SCHEMA) } },
      security: PUBLIC,
    }, (request, reply) => reply.list({
      data: [USER_ROW],
      pagination: { ...PAGINATION, countSql: 'SELECT COUNT(*) FROM users' },
      sort: SORT.map((entry) => ({ ...entry, orderBy: 'created_at DESC, id DESC' })),
      filters: FILTERS.map((entry) => ({ ...entry, column: 'u.status' })),
    }));

    const response = await fastify.inject('/api/users');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: 'success',
      data: [USER],
      pagination: PAGINATION,
      sort: SORT,
      filters: FILTERS,
      meta: readMeta(response),
    });
  });

  test('throws a TypeError unless it is given an object with an array in data: the answer is 500', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const errors = [];
    const results = [undefined, null, [USER], 'users', { data: 'x' }, { data: { 0: USER } }, {}];

    fastify.addHook('onError', async (request, reply, error) => {
      errors.push(error);
    });
    results.forEach((result, index) => fastify.get(`/results/${index}`, (request, reply) => reply.list(result)));

    const responses = await injectAll(fastify, results.map((result, index) => `/results/${index}`));

    responses.forEach((response) => {
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), serverErrorBody(response));
    });
    assert.equal(errors.length, results.length);
    errors.forEach((error) => assert.ok(error instanceof TypeError));
  });
});

describe('reply.noContent', () => {
  test('answers 204 without a body, a content type or a content length', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.delete('/users/1', (request, reply) => reply.noContent());

    const response = await fastify.inject({ method: 'DELETE', url: '/users/1' });

    assert.equal(response.statusCode, 204);
    assert.equal(response.payload, '');
    assert.equal(Object.hasOwn(response.headers, 'content-type'), false);
    assert.equal(Object.hasOwn(response.headers, 'content-length'), false);
    readRequestId(response);
  });

  test('is the whole answer of a route that declares only 204', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.delete('/api/users/1', {
      schema: { response: { 204: { type: 'null' } } },
      security: PUBLIC,
    }, (request, reply) => reply.noContent());

    const response = await fastify.inject({ method: 'DELETE', url: '/api/users/1' });

    assert.equal(response.statusCode, 204);
    assert.equal(response.payload, '');
    assert.equal(Object.hasOwn(response.headers, 'content-type'), false);
  });
});

describe('reply.fail', () => {
  test('answers with the status, the code and the message of an AppError', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/conflict', (request, reply) => reply.fail(new AppError(ERROR_CODE.NO_CHANGES)));
    fastify.get('/missing-user', (request, reply) => reply.fail(new AppError(ERROR_CODE.NOT_FOUND_ERROR, { message: 'User not found' })));

    const [conflict, missingUser] = await injectAll(fastify, ['/conflict', '/missing-user']);

    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.headers['content-type'], JSON_CONTENT_TYPE);
    assert.deepEqual(conflict.json(), {
      status: 'error',
      code: 'NO_CHANGES',
      message: 'No changes',
      meta: readMeta(conflict),
    });
    assert.equal(missingUser.statusCode, 404);
    assert.deepEqual(missingUser.json(), {
      status: 'error',
      code: 'NOT_FOUND_ERROR',
      message: 'User not found',
      meta: readMeta(missingUser),
    });
  });

  test('carries the validation and the headers of an AppError', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/taken', (request, reply) => reply.fail(new AppError(ERROR_CODE.VALIDATION_ERROR, { validation: [UNIQUE_EMAIL] })));
    fastify.get('/limited', (request, reply) => reply.fail(new AppError(ERROR_CODE.RATE_LIMIT_ERROR, { headers: { 'Retry-After': '30' } })));

    const [taken, limited] = await injectAll(fastify, ['/taken', '/limited']);

    assert.equal(taken.statusCode, 422);
    assert.deepEqual(taken.json(), {
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: 'Validation error',
      validation: [UNIQUE_EMAIL],
      meta: readMeta(taken),
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['retry-after'], '30');
    assert.equal(limited.json().code, 'RATE_LIMIT_ERROR');
  });

  test('is not cut down by the success schema of a typed route, and neither is the 500 of a misused decorator', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/api/users/1', {
      schema: { response: { 200: successEnvelope(USER_SCHEMA) } },
      security: PUBLIC,
    }, (request, reply) => reply.fail(new AppError(ERROR_CODE.VALIDATION_ERROR, { validation: [UNIQUE_EMAIL] })));
    fastify.get('/api/users', {
      schema: { response: { 200: listEnvelope(USER_SCHEMA) } },
      security: PUBLIC,
    }, (request, reply) => reply.list([USER]));

    const [taken, misused] = await injectAll(fastify, ['/api/users/1', '/api/users']);

    assert.equal(taken.statusCode, 422);
    assert.deepEqual(taken.json(), {
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: 'Validation error',
      validation: [UNIQUE_EMAIL],
      meta: readMeta(taken),
    });
    assert.equal(misused.statusCode, 500);
    assert.deepEqual(misused.json(), serverErrorBody(misused));
  });

  test('takes the road of a thrown error: onError hooks get the very error', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const error = new AppError(ERROR_CODE.NO_CHANGES);
    const seen = [];

    fastify.addHook('onError', async (request, reply, hookError) => {
      seen.push(hookError);
    });
    fastify.get('/conflict', (request, reply) => reply.fail(error));

    const response = await fastify.inject('/conflict');

    assert.equal(response.statusCode, 409);
    assert.deepEqual(seen, [error]);
    assert.equal(seen[0], error);
  });

  test('answers 500 for a foreign error and keeps its message to itself', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/broken', (request, reply) => reply.fail(new Error('connect ECONNREFUSED 10.0.0.5:3306')));

    const response = await fastify.inject('/broken');

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), serverErrorBody(response));
  });

  test('throws a TypeError unless it is given an Error: the answer is 500', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const errors = [];
    const values = ['text', undefined, null, { statusCode: 404, message: 'Not found' }, ERROR_CODE.NOT_FOUND_ERROR];

    fastify.addHook('onError', async (request, reply, error) => {
      errors.push(error);
    });
    values.forEach((value, index) => fastify.get(`/values/${index}`, (request, reply) => reply.fail(value)));

    const responses = await injectAll(fastify, values.map((value, index) => `/values/${index}`));

    responses.forEach((response) => {
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), serverErrorBody(response));
    });
    assert.equal(errors.length, values.length);
    errors.forEach((error) => assert.ok(error instanceof TypeError));
  });
});

describe('reply decorators', () => {
  test('return the reply, so a handler can return the call', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const returned = {};

    fastify.get('/ok', (request, reply) => {
      returned.ok = reply.ok(USER) === reply;
    });
    fastify.get('/created', (request, reply) => {
      returned.created = reply.created(USER) === reply;
    });
    fastify.get('/list', (request, reply) => {
      returned.list = reply.list({ data: [USER] }) === reply;
    });
    fastify.get('/no-content', (request, reply) => {
      returned.noContent = reply.noContent() === reply;
    });

    const responses = await injectAll(fastify, ['/ok', '/created', '/list', '/no-content']);

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 201, 200, 204]);
    assert.deepEqual(returned, {
      ok: true,
      created: true,
      list: true,
      noContent: true,
    });
  });

  test('fail() throws its error: nothing after the call runs, with or without a return', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    let isReached = false;

    fastify.get('/fail', (request, reply) => {
      reply.fail(new AppError(ERROR_CODE.NO_CHANGES));
      isReached = true;
    });

    const response = await fastify.inject('/fail');

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'NO_CHANGES');
    assert.equal(isReached, false);
  });

  // With reply.send(error) inside fail(), the handler below answered a second time while the hook was awaited:
  // an unhandled rejection, and the process was gone.
  test('fail() without a return in an async handler answers once while an onError hook is awaited', async (t) => {
    const { fastify, sink } = await buildWarnLoggedApp(t);

    fastify.addHook('onError', async () => {
      await sleep(HOOK_DELAY_MS);
    });
    fastify.get('/fail', async (request, reply) => {
      reply.fail(new AppError(ERROR_CODE.NOT_FOUND_ERROR));
    });

    const response = await fastify.inject('/fail');

    await sleep(HOOK_DELAY_MS);

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'NOT_FOUND_ERROR');
    assert.deepEqual(sink.lines.map((line) => line.msg), ['Request failed']);
  });

  // fail() is a throw: in a callback that runs after the handler returned nothing catches it.
  test('an error of a later callback is answered through reply.send(error), with the same envelope', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.addHook('onError', async () => {
      await sleep(HOOK_DELAY_MS);
    });
    fastify.addHook('onSend', async (request, reply, payload) => {
      await sleep(HOOK_DELAY_MS);

      return payload;
    });
    fastify.get('/later', (request, reply) => {
      setImmediate(() => reply.send(new AppError(ERROR_CODE.NOT_FOUND_ERROR)));
    });

    const response = await fastify.inject('/later');

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      status: 'error',
      code: 'NOT_FOUND_ERROR',
      message: 'Not found',
      meta: readMeta(response),
    });
  });

  test('answer once when an async handler returns them, also while async hooks hold the response', async (t) => {
    const { fastify, sink } = await buildWarnLoggedApp(t);

    fastify.addHook('onSend', async (request, reply, payload) => {
      await sleep(HOOK_DELAY_MS);

      return payload;
    });
    fastify.addHook('onError', async () => {
      await sleep(HOOK_DELAY_MS);
    });
    fastify.get('/ok', async (request, reply) => reply.ok(USER));
    fastify.get('/created', async (request, reply) => reply.created(USER));
    fastify.get('/list', async (request, reply) => reply.list({ data: [USER] }));
    fastify.get('/no-content', async (request, reply) => reply.noContent());
    fastify.get('/fail', async (request, reply) => reply.fail(new AppError(ERROR_CODE.NO_CHANGES)));

    const responses = await injectAll(fastify, ['/ok', '/created', '/list', '/no-content', '/fail']);

    await sleep(HOOK_DELAY_MS);

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 201, 200, 204, 409]);
    assert.deepEqual(responses[0].json(), { status: 'success', data: USER, meta: readMeta(responses[0]) });
    assert.deepEqual(sink.lines.map((line) => line.msg), ['Request failed']);
  });

  test('are on the reply of an unknown URL too: a hook can answer it with the envelope', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    let types = null;

    fastify.addHook('onRequest', async (request, reply) => {
      types = DECORATOR_NAMES.map((name) => typeof reply[name]);

      return reply.ok({ isAnsweredByHook: true });
    });

    const response = await fastify.inject('/missing');

    assert.deepEqual(types, DECORATOR_NAMES.map(() => 'function'));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: 'success',
      data: { isAnsweredByHook: true },
      meta: readMeta(response),
    });
  });

  test('are on the reply inside an encapsulated plugin', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    await fastify.register(useShop, { prefix: '/shop' });

    const response = await fastify.inject('/shop/items');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: 'success',
      data: [USER],
      pagination: PAGINATION,
      meta: readMeta(response),
    });
  });
});

// The startup contract proves a typed schema for some 2xx status. Without one for the status that is sent,
// Fastify writes the envelope as it is, and every column of the row goes to the client.
describe('reply decorators and the response schema of the route', () => {
  function declare(fastify, url, response, handler) {
    fastify.get(url, { security: PUBLIC, schema: { response } }, handler);
  }

  function sendCreated(request, reply) {
    return reply.created(USER_ROW);
  }

  function sendOk(request, reply) {
    return reply.ok(USER_ROW);
  }

  function sendList(request, reply) {
    return reply.list({ data: [USER_ROW] });
  }

  test('refuse a status the route declares no schema for, instead of sending the row unfiltered', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declare(fastify, '/api/v1/declares-200', { 200: successEnvelope(USER_SCHEMA) }, sendCreated);
    declare(fastify, '/api/v1/declares-201', { 201: successEnvelope(USER_SCHEMA) }, sendOk);
    declare(fastify, '/api/v1/declares-201-list', { 201: listEnvelope(USER_SCHEMA) }, sendList);
    declare(fastify, '/api/v1/declares-204', { 204: { type: 'null' } }, sendOk);
    declare(fastify, '/api/v1/declares-302', { 302: { type: 'null' } }, sendOk);

    const responses = await injectAll(fastify, [
      '/api/v1/declares-200',
      '/api/v1/declares-201',
      '/api/v1/declares-201-list',
      '/api/v1/declares-204',
      '/api/v1/declares-302',
    ]);

    responses.forEach((response) => {
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), serverErrorBody(response));
      assert.equal(response.payload.includes('stored-hash'), false);
    });
  });

  test('do not take the "default" entry for a schema of a success: it would cut the data out', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declare(fastify, '/api/v1/reply-probe/users', { 200: successEnvelope(USER_SCHEMA), default: successEnvelope({ type: 'null' }) }, sendCreated);

    const response = await fastify.inject('/api/v1/reply-probe/users');

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), serverErrorBody(response));
  });

  test('refuse a response in the content form that has no JSON media type', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declare(fastify, '/api/v1/report', { 200: { content: { 'text/csv': { schema: { type: 'string' } } } } }, sendOk);

    const response = await fastify.inject('/api/v1/report');

    assert.equal(response.statusCode, 500);
    assert.equal(response.payload.includes('stored-hash'), false);
  });

  test('say in the log which status has no schema', async (t) => {
    const { fastify, sink } = await buildWarnLoggedApp(t);

    declare(fastify, '/api/v1/reply-probe/users', { 200: successEnvelope(USER_SCHEMA) }, sendCreated);

    await fastify.inject('/api/v1/reply-probe/users');

    assert.equal(sink.lines.length, 1);
    assert.equal(sink.lines[0].level, 50);
    assert.match(sink.lines[0].err.message, /^The route answers 201, and its response schema has no JSON entry for that status/);
  });

  test('send through the schema of the exact status, of its class, and of a JSON media type', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declare(fastify, '/api/v1/exact', { 201: successEnvelope(USER_SCHEMA) }, sendCreated);
    declare(fastify, '/api/v1/class', { '2xx': successEnvelope(USER_SCHEMA) }, sendCreated);
    declare(fastify, '/api/v1/upper-class', { '2XX': successEnvelope(USER_SCHEMA) }, sendOk);
    declare(fastify, '/api/v1/media', { 200: { content: { 'application/json': { schema: successEnvelope(USER_SCHEMA) } } } }, sendOk);
    declare(fastify, '/api/v1/any-media', { 200: { content: { '*/*': { schema: successEnvelope(USER_SCHEMA) } } } }, sendOk);

    const responses = await injectAll(fastify, [
      '/api/v1/exact',
      '/api/v1/class',
      '/api/v1/upper-class',
      '/api/v1/media',
      '/api/v1/any-media',
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode), [201, 201, 200, 200, 200]);
    responses.forEach((response) => {
      assert.deepEqual(response.json(), { status: 'success', data: USER, meta: readMeta(response) });
    });
  });

  test('look for the serializer of the media type the reply carries, the way Fastify picks it', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const vendorType = 'application/vnd.api+json';
    const schema = successEnvelope(USER_SCHEMA);

    function sendVendor(request, reply) {
      return reply.type(vendorType).ok(USER_ROW);
    }

    function sendUpperCase(request, reply) {
      return reply.type('Application/JSON; charset=utf-8').ok(USER_ROW);
    }

    declare(fastify, '/api/v1/json-only', { 200: { content: { 'application/json': { schema } } } }, sendVendor);
    declare(fastify, '/api/v1/vendor-only', { 200: { content: { [vendorType]: { schema } } } }, sendVendor);
    declare(fastify, '/api/v1/vendor-not-set', { 200: { content: { [vendorType]: { schema } } } }, sendOk);
    declare(fastify, '/api/v1/any-media', { 200: { content: { '*/*': { schema } } } }, sendVendor);
    declare(fastify, '/api/v1/upper-case', { 200: { content: { 'application/json': { schema } } } }, sendUpperCase);

    const [jsonOnly, vendorOnly, vendorNotSet, anyMedia, upperCase] = await injectAll(fastify, [
      '/api/v1/json-only',
      '/api/v1/vendor-only',
      '/api/v1/vendor-not-set',
      '/api/v1/any-media',
      '/api/v1/upper-case',
    ]);

    [jsonOnly, vendorNotSet].forEach((response) => {
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), serverErrorBody(response));
    });
    [vendorOnly, anyMedia, upperCase].forEach((response) => {
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: 'success', data: USER, meta: readMeta(response) });
    });
  });

  test('leave a route that declares no response schema alone', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.get('/internal/users', sendCreated);
    fastify.get('/internal/validated', { schema: { querystring: { type: 'object' } } }, sendOk);

    const responses = await injectAll(fastify, ['/internal/users', '/internal/validated']);

    assert.deepEqual(responses.map((response) => response.statusCode), [201, 200]);
    responses.forEach((response) => assert.deepEqual(response.json().data, USER_ROW));
  });

  test('check the automatic HEAD twin of a route the same way', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    declare(fastify, '/api/v1/reply-probe/users', { 200: successEnvelope(USER_SCHEMA) }, sendOk);
    declare(fastify, '/api/v1/created', { 200: successEnvelope(USER_SCHEMA) }, sendCreated);

    const [found, mismatched] = await Promise.all([
      fastify.inject({ method: 'HEAD', url: '/api/v1/reply-probe/users' }),
      fastify.inject({ method: 'HEAD', url: '/api/v1/created' }),
    ]);

    assert.equal(found.statusCode, 200);
    assert.equal(mismatched.statusCode, 500);
  });
});
