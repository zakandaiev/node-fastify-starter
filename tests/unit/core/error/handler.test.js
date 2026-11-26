import { MODE } from '#config/env.js';
import { DbError } from '#core/db/error.js';
import { handleError, handleNotFound } from '#core/error/handler.js';
import { AppError } from '#core/error/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CATALOG, ERROR_CODE } from '#enums/error-code.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createLogSink, forgetLines } from '#root/tests/helper/log.js';
import { sendRawRequest } from '#root/tests/helper/socket.js';
import { errorEnvelope, successEnvelope } from '#schemas/common/envelope.js';
import { uuidVersion } from '#utils/id.js';
import { pick } from '#utils/object.js';
import { truncate } from '#utils/string.js';
import Fastify from 'fastify';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });
const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_VERSION = 7;

const REQUEST_FAILED_MESSAGE = 'Request failed';
const LOG_LEVEL_WARN = 40;
const LOG_LEVEL_ERROR = 50;

const KIBIBYTE = 1024;
const BULK_COUNT = 50000;
const BULK_BODY_LIMIT = KIBIBYTE * KIBIBYTE;
const LOG_LINE_MAX_BYTES = 16 * KIBIBYTE;

const HEAD_SEPARATOR = '\r\n\r\n';
const LINE_SEPARATOR = '\r\n';

const MALFORMED_JSON = '{"name":';

const DUPLICATE_EMAIL = 'anna@example.com';

const FASTIFY_MESSAGE = Object.freeze({
  MALFORMED_JSON: "Body is not valid JSON but content-type is set to 'application/json'",
  EMPTY_JSON: "Body cannot be empty when content-type is set to 'application/json'",
  BODY_TOO_LARGE: 'Request body is too large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported Media Type',
  MALFORMED_URL: "'/%FF' is not a valid url component",
});

const APP_ERROR_STATUSES = Object.freeze({
  BAD_REQUEST_ERROR: 400,
  AUTHENTICATION_ERROR: 401,
  SESSION_REVOKED: 401,
  AUTHORIZATION_ERROR: 403,
  ORIGIN_ERROR: 403,
  NOT_FOUND_ERROR: 404,
  NO_CHANGES: 409,
  CONTACT_TAKEN: 409,
  IDENTITY_TAKEN: 409,
  GROUP_PROTECTED: 409,
  PAYLOAD_TOO_LARGE_ERROR: 413,
  UNSUPPORTED_MEDIA_TYPE_ERROR: 415,
  VALIDATION_ERROR: 422,
  RATE_LIMIT_ERROR: 429,
  SERVER_ERROR: 500,
  UPSTREAM_ERROR: 502,
  SERVICE_UNAVAILABLE_ERROR: 503,
});

const OPERATOR_CASES = [
  ['minimum', { type: 'integer', minimum: 0 }, -1, -1, 0],
  ['maximum', { type: 'integer', maximum: 10 }, 11, 11, 10],
  ['exclusiveMinimum', { type: 'number', exclusiveMinimum: 0 }, 0, 0, 0],
  ['exclusiveMaximum', { type: 'number', exclusiveMaximum: 10 }, 10, 10, 10],
  ['multipleOf', { type: 'number', multipleOf: 0.5 }, 0.3, 0.3, 0.5],
  ['minLength', { type: 'string', minLength: 3 }, 'ab', 'ab', 3],
  ['maxLength', { type: 'string', maxLength: 0 }, 'a', 'a', 0],
  ['minItems', { type: 'array', minItems: 2 }, [1], null, 2],
  ['maxItems', { type: 'array', maxItems: 0 }, [1], null, 0],
  ['minProperties', { type: 'object', minProperties: 1 }, {}, null, 1],
  ['maxProperties', { type: 'object', maxProperties: 0 }, { a: 1 }, null, 0],
  ['format', { type: 'string', format: 'email', maxLength: 254 }, 'abc', 'abc', 'email'],
  ['pattern', { type: 'string', pattern: '^[a-z]+$', maxLength: 10 }, 'A1', 'A1', '^[a-z]+$'],
  ['enum', { type: 'string', enum: ['admin', 'user'] }, 'root', 'root', ['admin', 'user']],
  ['const', { type: 'string', const: 'user' }, 'bot', 'bot', 'user'],
  ['type', { type: 'boolean' }, 'maybe', 'maybe', 'boolean'],
].map(([operator, schema, value, columnValue, operatorValue]) => ({
  field: `${operator}Field`,
  operator,
  schema,
  value,
  columnValue,
  operatorValue,
}));

async function startApp(t, { mode = MODE.PROD, ...sections } = {}) {
  const fastify = await buildTestApp({ ...sections, env: { APP_MODE: mode } });

  t.after(() => fastify.close());

  return fastify;
}

async function startLoggedApp(t, options = {}) {
  const sink = createLogSink();
  const fastify = await startApp(t, { ...options, logger: { level: 'info', stream: sink.stream } });

  return { fastify, lines: forgetLines(sink).lines };
}

function startAppInEveryMode(t) {
  return Promise.all([MODE.PROD, MODE.DEV].map((mode) => startApp(t, { mode })));
}

function createErrorBody(response, code, { message = ERROR_CATALOG[code].message, stack, ...sections } = {}) {
  return {
    status: 'error',
    code,
    message,
    ...sections,
    meta: {
      requestId: response.headers[REQUEST_ID_HEADER],
      ...(stack !== undefined && { stack }),
    },
  };
}

function assertErrorResponse(response, statusCode, code, details) {
  assert.equal(response.statusCode, statusCode);
  assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE);
  assert.equal(uuidVersion(response.headers[REQUEST_ID_HEADER]), REQUEST_ID_VERSION);
  assert.deepEqual(response.json(), createErrorBody(response, code, details));
}

function createEntry(column, columnValue, operator, operatorValue) {
  return {
    column,
    columnValue,
    operator,
    operatorValue,
  };
}

function createObjectSchema(properties, keywords = {}) {
  return { type: 'object', properties, ...keywords };
}

function createItemData() {
  return createObjectSchema({ id: { type: 'integer' } });
}

function declareBodyRoute(fastify, body) {
  fastify.post('/items', { schema: { body } }, async () => ({ isSaved: true }));
}

function declareParameterRoute(fastify) {
  fastify.get('/items/:id', async (request) => ({ id: request.params.id }));
}

function postItem(fastify, payload) {
  return fastify.inject({ method: 'POST', url: '/items', payload });
}

function postText(fastify, url, payload, headers = JSON_HEADERS) {
  return fastify.inject({
    method: 'POST',
    url,
    payload,
    headers,
  });
}

function createForeignError(statusCode, properties = {}) {
  return Object.assign(new Error(`Foreign failure ${statusCode}`), { statusCode, ...properties });
}

// What the driver throws for a row that breaks a unique index: the value in its text is masked already.
function createDuplicate(constraint) {
  return new DbError(`Duplicate entry '***' for key '${constraint}'`, {
    kind: DB_ERROR_KIND.UNIQUE,
    constraint,
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    sqlState: '23000',
  });
}

// Routes that take the body and meet a row that holds one of its values already.
function injectDuplicates(fastify, errors, payload) {
  errors.forEach((error, index) => {
    fastify.post(`/duplicates/${index}`, async () => {
      throw error;
    });
  });

  return Promise.all(errors.map((error, index) => fastify.inject({ method: 'POST', url: `/duplicates/${index}`, payload })));
}

function injectFailures(fastify, errors) {
  errors.forEach((error, index) => {
    fastify.get(`/failures/${index}`, async () => {
      throw error;
    });
  });

  return Promise.all(errors.map((error, index) => fastify.inject(`/failures/${index}`)));
}

// Three arguments make the strategy asynchronous: the router reports its failure through frameworkErrors.
function declareConstrainedRoute(fastify) {
  fastify.addConstraintStrategy({
    name: 'tenant',
    storage() {
      const stores = new Map();

      return {
        get: (tenant) => stores.get(tenant) ?? null,
        set: (tenant, store) => stores.set(tenant, store),
      };
    },
    deriveConstraint(request, context, done) {
      done(new Error('tenant lookup failed'));
    },
  });
  fastify.get('/tenants', { constraints: { tenant: 'acme' } }, async () => ({ isFound: true }));
}

function createLongParameterUrl(fastify, extraLength) {
  return `/items/${'a'.repeat(fastify.config.app.maxParamLength + extraLength)}`;
}

function createOversizedBody(fastify) {
  return JSON.stringify({ name: 'x'.repeat(fastify.config.app.bodyLimit) });
}

function readProblemLines(lines, response) {
  return lines.filter((line) => line.requestId === response.headers[REQUEST_ID_HEADER] && line.level >= LOG_LEVEL_WARN);
}

function assertFailureLogged(lines, response, level) {
  const problems = readProblemLines(lines, response);

  assert.equal(problems.length, 1);
  assert.equal(problems[0].msg, REQUEST_FAILED_MESSAGE);
  assert.equal(problems[0].level, level);

  return problems[0];
}

function withoutRequestId(response) {
  const body = response.json();

  return { ...body, meta: { ...body.meta, requestId: null } };
}

function parseRawResponse(text) {
  const headEnd = text.indexOf(HEAD_SEPARATOR);
  const [statusLine, ...headerLines] = text.slice(0, headEnd).split(LINE_SEPARATOR);
  const headers = Object.fromEntries(headerLines.map((line) => {
    const nameEnd = line.indexOf(':');

    return [line.slice(0, nameEnd).toLowerCase(), line.slice(nameEnd + 1).trim()];
  }));

  return { statusLine, headers, body: text.slice(headEnd + HEAD_SEPARATOR.length) };
}

describe('handleError: schema errors', () => {
  test('answers 422 VALIDATION_ERROR with an entry for every rule the body breaks', async (t) => {
    const fastify = await startApp(t);
    let isHandled = false;

    fastify.post('/items', {
      schema: {
        body: createObjectSchema({
          name: { type: 'string', minLength: 3 },
          email: { type: 'string', format: 'email', maxLength: 254 },
          age: { type: 'integer', minimum: 18 },
          role: { type: 'string', enum: ['admin', 'user'] },
        }),
      },
    }, async () => {
      isHandled = true;

      return { isSaved: true };
    });

    const response = await postItem(fastify, {
      name: 'ab',
      email: 'abc',
      age: 5,
      role: 'root',
    });

    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      message: 'Validation error',
      validation: [
        createEntry('name', 'ab', 'minLength', 3),
        createEntry('email', 'abc', 'format', 'email'),
        createEntry('age', 5, 'minimum', 18),
        createEntry('role', 'root', 'enum', ['admin', 'user']),
      ],
    });
    assert.equal(isHandled, false);
  });

  test('serializes the sections of an error in the order of the response format', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema({ name: { type: 'string', minLength: 3 } }));

    const response = await postItem(fastify, { name: 'ab' });

    assert.deepEqual(Object.keys(response.json()), ['status', 'code', 'message', 'validation', 'meta']);
  });

  test('reflects a query parameter after coercion and a field of a JSON body as it was sent: the body is not coerced', async (t) => {
    const fastify = await startApp(t);

    fastify.get('/items', {
      schema: {
        querystring: createObjectSchema({
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string', enum: ['active', 'blocked'] },
        }),
      },
    }, async () => ({ isFound: true }));
    declareBodyRoute(fastify, createObjectSchema({ age: { type: 'integer', minimum: 18 } }));

    const [byQuery, byText, byNumber] = await Promise.all([
      fastify.inject('/items?limit=0&status=deleted'),
      postItem(fastify, { age: '5' }),
      postItem(fastify, { age: 5 }),
    ]);

    assertErrorResponse(byQuery, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('limit', 0, 'minimum', 1),
        createEntry('status', 'deleted', 'enum', ['active', 'blocked']),
      ],
    });
    assertErrorResponse(byText, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('age', '5', 'type', 'integer')],
    });
    assertErrorResponse(byNumber, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('age', 5, 'minimum', 18)],
    });
  });

  test('answers 404 NOT_FOUND_ERROR without validation to an invalid path parameter, in dev too', async (t) => {
    const apps = await startAppInEveryMode(t);

    apps.forEach((fastify) => {
      fastify.get('/items/:id', {
        schema: { params: createObjectSchema({ id: { type: 'integer' } }) },
      }, async (request) => ({ id: request.params.id }));
    });

    const invalid = await Promise.all(apps.map((fastify) => fastify.inject('/items/abc')));
    const valid = await Promise.all(apps.map((fastify) => fastify.inject('/items/7')));

    invalid.forEach((response) => assertErrorResponse(response, 404, 'NOT_FOUND_ERROR', { message: 'Not found' }));
    valid.forEach((response) => assert.deepEqual(response.json(), { id: 7 }));
  });

  test('reports a headers error under the lower-cased name of the header', async (t) => {
    const fastify = await startApp(t);

    fastify.get('/items', {
      schema: {
        headers: createObjectSchema({ 'x-api-version': { type: 'string', enum: ['1', '2'] } }, { required: ['x-api-version'] }),
      },
    }, async () => ({ isFound: true }));

    const [missing, unknown, known] = await Promise.all([
      fastify.inject('/items'),
      fastify.inject({ url: '/items', headers: { 'X-Api-Version': '9' } }),
      fastify.inject({ url: '/items', headers: { 'X-Api-Version': '2' } }),
    ]);

    assertErrorResponse(missing, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('x-api-version', null, 'required', null)],
    });
    assertErrorResponse(unknown, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('x-api-version', '9', 'enum', ['1', '2'])],
    });
    assert.equal(known.statusCode, 200);
  });

  test('reports only the first failing part: params, then body, then querystring, then headers', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);

    fastify.post('/items/:id', {
      schema: {
        params: createObjectSchema({ id: { type: 'integer' } }),
        body: createObjectSchema({ name: { type: 'string' } }, { required: ['name'] }),
        querystring: createObjectSchema({ limit: { type: 'integer' } }),
        headers: createObjectSchema({}, { required: ['x-api-version'] }),
      },
    }, async () => ({ isSaved: true }));

    const [byParams, byBody, byQuery, byHeaders, passed] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/items/abc?limit=x', payload: {} }),
      fastify.inject({ method: 'POST', url: '/items/1?limit=x', payload: {} }),
      fastify.inject({ method: 'POST', url: '/items/1?limit=x', payload: { name: 'Ann' } }),
      fastify.inject({ method: 'POST', url: '/items/1?limit=5', payload: { name: 'Ann' } }),
      fastify.inject({
        method: 'POST',
        url: '/items/1?limit=5',
        payload: { name: 'Ann' },
        headers: { 'x-api-version': '1' },
      }),
    ]);

    assertErrorResponse(byParams, 404, 'NOT_FOUND_ERROR');
    assertErrorResponse(byBody, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('name', null, 'required', null)],
    });
    assertErrorResponse(byQuery, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('limit', 'x', 'type', 'integer')],
    });
    assertErrorResponse(byHeaders, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('x-api-version', null, 'required', null)],
    });
    assert.equal(passed.statusCode, 200);
    assert.deepEqual(
      [byParams, byBody, byQuery, byHeaders].map((response) => assertFailureLogged(lines, response, LOG_LEVEL_WARN).err.message),
      ['params', 'body', 'querystring', 'headers'].map((part) => `Request ${part} is not valid: 1 schema errors`),
    );
  });

  test('cuts the 50 000 errors of one array down to 20 entries, in the response and in the log', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const { maxErrors } = fastify.config.app.validation;

    fastify.post('/items', {
      bodyLimit: BULK_BODY_LIMIT,
      schema: { body: createObjectSchema({ ids: { type: 'array', items: { type: 'integer' } } }) },
    }, async () => ({ isSaved: true }));

    const response = await postItem(fastify, { ids: Array.from({ length: BULK_COUNT }, () => 'a') });

    assert.equal(maxErrors, 20);
    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      validation: Array.from({ length: maxErrors }, (item, index) => createEntry(`ids.${index}`, 'a', 'type', 'integer')),
    });

    const line = assertFailureLogged(lines, response, LOG_LEVEL_WARN);
    const lineBytes = Buffer.byteLength(JSON.stringify(line));

    assert.equal(line.validation.length, maxErrors);
    assert.deepEqual(line.validation[0], { column: 'ids.0', operator: 'type', operatorValue: 'integer' });
    assert.equal(line.err.validation, undefined);
    assert.equal(line.err.message, `Request body is not valid: ${BULK_COUNT} schema errors`);
    assert.ok(lineBytes < LOG_LINE_MAX_BYTES, `the log line takes ${lineBytes} bytes`);
  });

  // Fastify hands the rejection of an $async validator to the handler as it is: its list is not an array
  // and is never cut, so such a schema is refused when the route is declared.
  test('refuses an asynchronous schema at startup, in a part and in the content form of a body', async (t) => {
    const fastify = await startApp(t);
    const schema = { $async: true, ...createObjectSchema({ ids: { type: 'array', items: { type: 'integer' } } }) };

    assert.throws(
      () => declareBodyRoute(fastify, schema),
      { message: 'Route POST /items has an asynchronous schema ($async) in "body": validate what needs I/O in the handler' },
    );
    assert.throws(
      () => fastify.get('/search', { schema: { querystring: schema } }, async () => ({})),
      { message: 'Route GET /search has an asynchronous schema ($async) in "querystring": validate what needs I/O in the handler' },
    );
    assert.throws(
      () => fastify.post('/upload', { schema: { body: { content: { 'application/json': { schema } } } } }, async () => ({})),
      { message: 'Route POST /upload has an asynchronous schema ($async) in "body": validate what needs I/O in the handler' },
    );
    // AJV reads the keyword by truthiness.
    ['true', 1].forEach(($async) => {
      assert.throws(
        () => fastify.post('/truthy', { schema: { body: { ...schema, $async } } }, async () => ({})),
        { message: 'Route POST /truthy has an asynchronous schema ($async) in "body": validate what needs I/O in the handler' },
      );
    });
    assert.doesNotThrow(() => fastify.post('/falsy', { schema: { body: { ...schema, $async: false } } }, async () => ({})));
    assert.equal(fastify.hasRoute({ method: 'POST', url: '/items' }), false);
  });

  test('takes the ceiling and the length of a reflected value from config.app.validation', async (t) => {
    const { fastify, lines } = await startLoggedApp(t, { app: { validation: { maxErrors: 3, maxValueLength: 9, maxListLength: 2 } } });

    declareBodyRoute(fastify, createObjectSchema({
      title: { type: 'string', maxLength: 1 },
      first: { type: 'integer' },
      second: { type: 'integer' },
      third: { type: 'integer' },
      fourth: { type: 'integer' },
    }));

    const response = await postItem(fastify, {
      title: 'abcdefghijkl',
      first: 'x',
      second: 'x',
      third: 'x',
      fourth: 'x',
    });

    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('title', 'abcdefgh…', 'maxLength', 1),
        createEntry('first', 'x', 'type', 'integer'),
        createEntry('second', 'x', 'type', 'integer'),
      ],
    });
    assert.equal(assertFailureLogged(lines, response, LOG_LEVEL_WARN).validation.length, 3);
  });

  test('cuts the list in the schema error itself: an onError hook sees the ceiling, and the total in the message', async (t) => {
    const fastify = await startApp(t, { app: { validation: { maxErrors: 3, maxValueLength: 8, maxListLength: 2 } } });
    const fields = ['first', 'second', 'third', 'fourth', 'fifth'];
    const seen = [];

    fastify.addHook('onError', async (request, reply, error) => {
      seen.push([error.validation.length, error.validationContext, error.message]);
    });
    declareBodyRoute(fastify, createObjectSchema(Object.fromEntries(fields.map((field) => [field, { type: 'integer' }]))));

    const response = await postItem(fastify, Object.fromEntries(fields.map((field) => [field, 'x'])));

    assert.equal(response.statusCode, 422);
    assert.deepEqual(seen, [[3, 'body', 'Request body is not valid: 5 schema errors']]);
  });

  test('never answers or logs the "if" entry of a gated keyword: the ceiling and the total count the errors it reports', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const { maxErrors } = fastify.config.app.validation;
    const email = { type: 'string', format: 'email', maxLength: 254 };
    const seen = [];

    fastify.addHook('onError', async (request, reply, error) => {
      seen.push(error.validation.map((item) => item.keyword));
    });
    fastify.post('/profiles', {
      schema: {
        body: createObjectSchema({
          email,
          code: { type: 'string', pattern: '^[0-9]+$', maxLength: 6 },
          tags: { type: 'array', uniqueItems: true, maxItems: 5 },
        }),
      },
    }, async () => ({ isSaved: true }));
    fastify.post('/invites', {
      schema: { body: createObjectSchema({ emails: { type: 'array', maxItems: 100, items: email } }) },
    }, async () => ({ isSaved: true }));

    const profile = await fastify.inject({ method: 'POST', url: '/profiles', payload: { email: 'abc', code: 'x1', tags: ['a', 'a'] } });
    const invites = await fastify.inject({ method: 'POST', url: '/invites', payload: { emails: Array.from({ length: 30 }, () => 'abc') } });
    const profileLine = assertFailureLogged(lines, profile, LOG_LEVEL_WARN);
    const invitesLine = assertFailureLogged(lines, invites, LOG_LEVEL_WARN);

    assertErrorResponse(profile, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('email', 'abc', 'format', 'email'),
        createEntry('code', 'x1', 'pattern', '^[0-9]+$'),
        createEntry('tags', null, 'uniqueItems', null),
      ],
    });
    assertErrorResponse(invites, 422, 'VALIDATION_ERROR', {
      validation: Array.from({ length: maxErrors }, (item, index) => createEntry(`emails.${index}`, 'abc', 'format', 'email')),
    });
    assert.deepEqual(seen, [['format', 'pattern', 'uniqueItems'], Array.from({ length: maxErrors }, () => 'format')]);
    assert.deepEqual(profileLine.validation.map(({ operator }) => operator), ['format', 'pattern', 'uniqueItems']);
    assert.equal(profileLine.err.message, 'Request body is not valid: 3 schema errors');
    assert.equal(invitesLine.validation.length, maxErrors);
    assert.equal(invitesLine.err.message, 'Request body is not valid: 30 schema errors');
  });

  test('keeps the value of a sensitive field out of the response and the log, whatever segment of the path names it', async (t) => {
    const apps = await Promise.all([MODE.PROD, MODE.DEV].map((mode) => startLoggedApp(t, { mode })));
    // Nothing a clock, a pid or a request id can spell by chance: those are digits and hex.
    const secrets = ['hunter2', 'tok-123', 'p!n-x', 'k-987'];

    apps.forEach(({ fastify }) => declareBodyRoute(fastify, createObjectSchema({
      login: { type: 'string', minLength: 3 },
      password: { type: 'string', minLength: 12 },
      accessToken: { type: 'string', minLength: 30 },
      credentials: createObjectSchema({ pin: { type: 'string', minLength: 6 } }),
      profile: createObjectSchema({ apiKey: { type: 'string', minLength: 20 } }),
    })));

    const responses = await Promise.all(apps.map(({ fastify }) => postItem(fastify, {
      login: 'ab',
      password: 'hunter2',
      accessToken: 'tok-123',
      credentials: { pin: 'p!n-x' },
      profile: { apiKey: 'k-987' },
    })));

    responses.forEach((response, index) => {
      const reflected = response.json().validation.map(({ column, columnValue }) => [column, columnValue]);
      const log = JSON.stringify(apps[index].lines);

      assert.equal(response.statusCode, 422);
      assert.deepEqual(reflected, [
        ['login', 'ab'],
        ['password', null],
        ['accessToken', null],
        ['credentials.pin', null],
        ['profile.apiKey', null],
      ]);
      secrets.forEach((secret) => {
        assert.equal(response.body.includes(secret), false);
        assert.equal(log.includes(secret), false);
      });
    });
  });

  test('does not reflect a sensitive query parameter or header', async (t) => {
    const fastify = await startApp(t);

    fastify.get('/by-query', {
      schema: { querystring: createObjectSchema({ token: { type: 'string', maxLength: 3 } }) },
    }, async () => ({ isFound: true }));
    fastify.get('/by-header', {
      schema: { headers: createObjectSchema({ authorization: { type: 'string', pattern: '^Bearer ', maxLength: 512 } }) },
    }, async () => ({ isFound: true }));

    const [byQuery, byHeader] = await Promise.all([
      fastify.inject('/by-query?token=abcdef'),
      fastify.inject({ url: '/by-header', headers: { authorization: 'Basic dXNlcjpwYXNz' } }),
    ]);

    assertErrorResponse(byQuery, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('token', null, 'maxLength', 3)],
    });
    assertErrorResponse(byHeader, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('authorization', null, 'pattern', '^Bearer ')],
    });
  });

  // The gate of the route moves a format under allOf/if/then: the raw error names the path in the schema AJV compiled.
  test('adds the raw AJV error to an entry as "schema" in dev only', async (t) => {
    const apps = await startAppInEveryMode(t);

    apps.forEach((fastify) => declareBodyRoute(fastify, createObjectSchema({ email: { type: 'string', format: 'email', maxLength: 254 } })));

    const [prodResponse, devResponse] = await Promise.all(apps.map((fastify) => postItem(fastify, { email: 'abc' })));
    const [{ schema, ...devEntry }, ...devRest] = devResponse.json().validation;
    const { message, ...rawError } = schema;

    assert.deepEqual(prodResponse.json().validation, [createEntry('email', 'abc', 'format', 'email')]);
    assert.deepEqual(devEntry, createEntry('email', 'abc', 'format', 'email'));
    assert.deepEqual(devRest, []);
    assert.deepEqual(rawError, {
      instancePath: '/email',
      schemaPath: '#/properties/email/allOf/0/then/format',
      keyword: 'format',
      params: { format: 'email' },
    });
    assert.equal(typeof message, 'string');
  });

  test('names the missing property of "required" in the column, under its parent', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema({
      address: createObjectSchema({ city: { type: 'string' } }, { required: ['city'] }),
    }, { required: ['name'] }));

    const response = await postItem(fastify, { address: {} });

    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('name', null, 'required', null),
        createEntry('address.city', null, 'required', null),
      ],
    });
  });

  test('decodes the JSON pointer of AJV into a dotted column and reads the value by it', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema({
      address: createObjectSchema({ zip: { type: 'integer' } }),
      tags: { type: 'array', items: { type: 'string', minLength: 2 } },
      'a/b': { type: 'integer' },
      'c~d': { type: 'integer' },
      'e~1f': { type: 'integer' },
    }));

    const response = await postItem(fastify, {
      address: { zip: 'north' },
      tags: ['ok', 'x'],
      'a/b': 'slash',
      'c~d': 'tilde',
      'e~1f': 'both',
    });

    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('address.zip', 'north', 'type', 'integer'),
        createEntry('tags.1', 'x', 'minLength', 2),
        createEntry('a/b', 'slash', 'type', 'integer'),
        createEntry('c~d', 'tilde', 'type', 'integer'),
        createEntry('e~1f', 'both', 'type', 'integer'),
      ],
    });
  });

  test('gives an error of the whole part a null column and a null value', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema({}, { minProperties: 1 }));

    const [wrongType, tooFew] = await Promise.all([
      postText(fastify, '/items', '[1,2]'),
      postItem(fastify, {}),
    ]);

    assertErrorResponse(wrongType, 422, 'VALIDATION_ERROR', {
      validation: [createEntry(null, null, 'type', 'object')],
    });
    assertErrorResponse(tooFew, 422, 'VALIDATION_ERROR', {
      validation: [createEntry(null, null, 'minProperties', 1)],
    });
  });

  test('names the property in the column for propertyNames and dependencies', async (t) => {
    const fastify = await startApp(t);

    fastify.post('/by-name', {
      schema: { body: { type: 'object', propertyNames: { pattern: '^[a-z]+$', maxLength: 32 } } },
    }, async () => ({ isSaved: true }));
    fastify.post('/by-dependency', {
      schema: {
        body: createObjectSchema({ card: { type: 'string' }, billing: { type: 'string' } }, { dependencies: { card: ['billing'] } }),
      },
    }, async () => ({ isSaved: true }));

    const [byName, byDependency] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/by-name', payload: { 'Bad Name': 1 } }),
      fastify.inject({ method: 'POST', url: '/by-dependency', payload: { card: '4111' } }),
    ]);

    // AJV reports a bad key twice: by the keyword the name broke, then by propertyNames. The value is the key itself.
    assertErrorResponse(byName, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('Bad Name', 'Bad Name', 'pattern', '^[a-z]+$'),
        createEntry('Bad Name', 'Bad Name', 'propertyNames', null),
      ],
    });
    assertErrorResponse(byDependency, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('billing', null, 'dependencies', null)],
    });
  });

  test('reflects 0, false and an empty string as they are', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema({
      count: { type: 'integer', minimum: 1 },
      isAgreed: { type: 'boolean', const: true },
      title: { type: 'string', minLength: 1 },
    }));

    const response = await postItem(fastify, { count: 0, isAgreed: false, title: '' });

    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('count', 0, 'minimum', 1),
        createEntry('isAgreed', false, 'const', true),
        createEntry('title', '', 'minLength', 1),
      ],
    });
  });

  test('does not reflect an object or an array', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema({
      name: { type: 'string' },
      tags: { type: 'array', maxItems: 1 },
      meta: { type: 'object', maxProperties: 1 },
    }));

    const response = await postItem(fastify, {
      name: { first: 'Ann' },
      tags: ['a', 'b'],
      meta: { a: 1, b: 2 },
    });

    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('name', null, 'type', 'string'),
        createEntry('tags', null, 'maxItems', 1),
        createEntry('meta', null, 'maxProperties', 1),
      ],
    });
  });

  test('truncates a reflected string that is longer than config.app.validation.maxValueLength', async (t) => {
    const fastify = await startApp(t);
    const { maxValueLength } = fastify.config.app.validation;
    const fitting = 'n'.repeat(maxValueLength);
    const long = 'm'.repeat(maxValueLength + 1);

    declareBodyRoute(fastify, createObjectSchema({
      note: { type: 'string', maxLength: 10 },
      memo: { type: 'string', maxLength: 10 },
    }));

    const response = await postItem(fastify, { note: fitting, memo: long });

    assert.equal(maxValueLength, 256);
    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('note', fitting, 'maxLength', 10),
        createEntry('memo', `${'m'.repeat(maxValueLength - 1)}…`, 'maxLength', 10),
      ],
    });
    assert.equal(response.json().validation[1].columnValue, truncate(long, maxValueLength));
  });

  test('answers 422 to a number that is not finite and reflects it as a string', async (t) => {
    const fastify = await startApp(t);

    fastify.get('/items', {
      schema: { querystring: createObjectSchema({ limit: { type: 'integer', minimum: 1, maximum: 100 } }) },
    }, async () => ({ isFound: true }));

    const [positive, negative, overflow] = await Promise.all(
      ['Infinity', '-Infinity', '1e400'].map((limit) => fastify.inject(`/items?limit=${limit}`)),
    );

    assertErrorResponse(positive, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('limit', 'Infinity', 'finite', null)],
    });
    assertErrorResponse(negative, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('limit', '-Infinity', 'finite', null)],
    });
    assertErrorResponse(overflow, 422, 'VALIDATION_ERROR', {
      validation: [createEntry('limit', 'Infinity', 'finite', null)],
    });
  });

  test('takes operatorValue from the parameter of the keyword and keeps a limit of 0', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema(
      Object.fromEntries(OPERATOR_CASES.map(({ field, schema }) => [field, schema])),
    ));

    const response = await postItem(fastify, Object.fromEntries(OPERATOR_CASES.map(({ field, value }) => [field, value])));

    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      validation: OPERATOR_CASES.map(({
        field,
        columnValue,
        operator,
        operatorValue,
      }) => createEntry(field, columnValue, operator, operatorValue)),
    });
  });

  test('gives null operatorValue to a keyword that has no single value', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema({
      tags: { type: 'array', uniqueItems: true, maxItems: 10 },
      owner: { anyOf: [{ type: 'integer' }, { type: 'boolean' }] },
    }));

    const response = await postItem(fastify, { tags: ['a', 'a'], owner: 'nobody' });

    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('tags', null, 'uniqueItems', null),
        createEntry('owner', 'nobody', 'type', 'integer'),
        createEntry('owner', 'nobody', 'type', 'boolean'),
        createEntry('owner', 'nobody', 'anyOf', null),
      ],
    });
  });

  test('answers 500 SERVER_ERROR, not 422, when the validator itself throws', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);

    fastify.post('/items', {
      schema: { body: createObjectSchema({}) },
      validatorCompiler: () => () => {
        throw new Error('validator exploded');
      },
    }, async () => ({ isSaved: true }));

    const response = await postItem(fastify, {});

    assertErrorResponse(response, 500, 'SERVER_ERROR');
    assertFailureLogged(lines, response, LOG_LEVEL_ERROR);
  });

  test('keeps every section when the route declares the error envelope for the status', async (t) => {
    const fastify = await startApp(t, { mode: MODE.DEV });
    const failure = new Error('exploded inside');

    async function saveItem(request, reply) {
      if (request.body.name === 'broken') {
        throw failure;
      }

      return reply.ok({ id: 1 });
    }

    fastify.post('/api/v1/plain', {
      security: { auth: false },
      schema: {
        body: createObjectSchema({ name: { type: 'string', minLength: 3 } }),
        response: { 200: successEnvelope(createItemData()) },
      },
    }, saveItem);
    fastify.post('/api/v1/typed', {
      security: { auth: false },
      schema: {
        body: createObjectSchema({ name: { type: 'string', minLength: 3 } }),
        response: { 200: successEnvelope(createItemData()), 422: errorEnvelope, 500: errorEnvelope },
      },
    }, saveItem);

    const [plainInvalid, typedInvalid, plainBroken, typedBroken] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/api/v1/plain', payload: { name: 'ab' } }),
      fastify.inject({ method: 'POST', url: '/api/v1/typed', payload: { name: 'ab' } }),
      fastify.inject({ method: 'POST', url: '/api/v1/plain', payload: { name: 'broken' } }),
      fastify.inject({ method: 'POST', url: '/api/v1/typed', payload: { name: 'broken' } }),
    ]);

    assert.equal(typedInvalid.statusCode, 422);
    assert.equal(typeof typedInvalid.json().validation[0].schema, 'object');
    assert.deepEqual(withoutRequestId(typedInvalid), withoutRequestId(plainInvalid));
    assertErrorResponse(typedBroken, 500, 'SERVER_ERROR', { message: failure.message, stack: failure.stack });
    assert.deepEqual(withoutRequestId(typedBroken), withoutRequestId(plainBroken));
  });
});

describe('handleError: errors of Fastify', () => {
  test('answers 400 BAD_REQUEST_ERROR to malformed JSON', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema({}));

    const response = await postText(fastify, '/items', MALFORMED_JSON);

    assertErrorResponse(response, 400, 'BAD_REQUEST_ERROR', { message: 'Bad request' });
  });

  test('answers 400 BAD_REQUEST_ERROR to an empty body sent as JSON', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema({}));

    const response = await fastify.inject({ method: 'POST', url: '/items', headers: JSON_HEADERS });

    assertErrorResponse(response, 400, 'BAD_REQUEST_ERROR');
  });

  test('answers 413 PAYLOAD_TOO_LARGE_ERROR to a body over the body limit', async (t) => {
    const fastify = await startApp(t, { app: { bodyLimit: KIBIBYTE } });

    declareBodyRoute(fastify, createObjectSchema({}));

    const response = await postText(fastify, '/items', createOversizedBody(fastify));

    assertErrorResponse(response, 413, 'PAYLOAD_TOO_LARGE_ERROR');
  });

  test('answers 415 UNSUPPORTED_MEDIA_TYPE_ERROR to a content type that has no parser', async (t) => {
    const fastify = await startApp(t);

    declareBodyRoute(fastify, createObjectSchema({}));

    const response = await postText(fastify, '/items', '<name>Ann</name>', { 'content-type': 'text/xml' });

    assertErrorResponse(response, 415, 'UNSUPPORTED_MEDIA_TYPE_ERROR');
  });

  test('answers 400 BAD_REQUEST_ERROR with our JSON and X-Request-Id to a malformed URL', async (t) => {
    const fastify = await startApp(t);
    const response = await fastify.inject('/%FF');

    assertErrorResponse(response, 400, 'BAD_REQUEST_ERROR', { message: 'Bad request' });
  });

  test('answers 414 with our JSON and X-Request-Id to a path parameter longer than config.app.maxParamLength', async (t) => {
    const fastify = await startApp(t);

    declareParameterRoute(fastify);

    const [fitting, long] = await Promise.all([
      fastify.inject(createLongParameterUrl(fastify, 0)),
      fastify.inject(createLongParameterUrl(fastify, 1)),
    ]);

    assert.equal(fastify.config.app.maxParamLength, 100);
    assert.equal(fitting.statusCode, 200);
    assertErrorResponse(long, 414, 'BAD_REQUEST_ERROR', { message: 'Bad request' });
  });

  test('answers 500 SERVER_ERROR with our JSON and X-Request-Id to a failed async constraint of the router', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);

    declareConstrainedRoute(fastify);

    const response = await fastify.inject('/tenants');

    assertErrorResponse(response, 500, 'SERVER_ERROR', { message: 'Server error' });
    assertFailureLogged(lines, response, LOG_LEVEL_ERROR);
  });

  test('gives the message of Fastify instead of the catalogue one in dev, and still no stack', async (t) => {
    const fastify = await startApp(t, { mode: MODE.DEV });
    const longUrl = createLongParameterUrl(fastify, 1);

    declareBodyRoute(fastify, createObjectSchema({}));
    declareParameterRoute(fastify);

    const [malformed, empty, oversized, unsupported, malformedUrl, longParameter] = await Promise.all([
      postText(fastify, '/items', MALFORMED_JSON),
      fastify.inject({ method: 'POST', url: '/items', headers: JSON_HEADERS }),
      postText(fastify, '/items', createOversizedBody(fastify)),
      postText(fastify, '/items', '<name>Ann</name>', { 'content-type': 'text/xml' }),
      fastify.inject('/%FF'),
      fastify.inject(longUrl),
    ]);

    assertErrorResponse(malformed, 400, 'BAD_REQUEST_ERROR', { message: FASTIFY_MESSAGE.MALFORMED_JSON });
    assertErrorResponse(empty, 400, 'BAD_REQUEST_ERROR', { message: FASTIFY_MESSAGE.EMPTY_JSON });
    assertErrorResponse(oversized, 413, 'PAYLOAD_TOO_LARGE_ERROR', { message: FASTIFY_MESSAGE.BODY_TOO_LARGE });
    assertErrorResponse(unsupported, 415, 'UNSUPPORTED_MEDIA_TYPE_ERROR', { message: FASTIFY_MESSAGE.UNSUPPORTED_MEDIA_TYPE });
    assertErrorResponse(malformedUrl, 400, 'BAD_REQUEST_ERROR', { message: FASTIFY_MESSAGE.MALFORMED_URL });
    assertErrorResponse(longParameter, 414, 'BAD_REQUEST_ERROR', { message: `'${longUrl}' is exceeding the max param length` });
  });

  test('ignores X-Request-Id of the client, on the path that runs no hook too', async (t) => {
    const fastify = await startApp(t);
    const headers = { 'x-request-id': 'chosen-by-the-client' };
    const responses = await Promise.all(['/%FF', '/nope'].map((url) => fastify.inject({ url, headers })));

    assertErrorResponse(responses[0], 400, 'BAD_REQUEST_ERROR');
    assertErrorResponse(responses[1], 404, 'NOT_FOUND_ERROR');
    assert.notEqual(responses[0].headers[REQUEST_ID_HEADER], responses[1].headers[REQUEST_ID_HEADER]);
  });
});

describe('handleError: headers of the error', () => {
  test('answers 416 with Content-Range and our JSON to an error that brings a Content-Type and a Content-Length', async (t) => {
    const fastify = await startApp(t);
    const [response] = await injectFailures(fastify, [createForeignError(416, {
      headers: { 'Content-Range': 'bytes */100', 'Content-Type': 'text/html', 'Content-Length': 5 },
    })]);

    assertErrorResponse(response, 416, 'BAD_REQUEST_ERROR', { message: 'Bad request' });
    assert.equal(response.headers['content-range'], 'bytes */100');
    assert.equal(response.headers['content-length'], String(response.rawPayload.length));
  });

  // Fastify corrects a wrong Content-Length itself, except on a HEAD route of its own: there a copied one goes out as it is.
  test('does not hand the Content-Length of the error to a HEAD request', async (t) => {
    const fastify = await startApp(t);

    fastify.head('/items', async () => {
      throw createForeignError(416, { headers: { 'Content-Range': 'bytes */100', 'Content-Length': 5 } });
    });

    const response = await fastify.inject({ method: 'HEAD', url: '/items' });
    const envelope = JSON.stringify(createErrorBody(response, 'BAD_REQUEST_ERROR'));

    assert.equal(response.statusCode, 416);
    assert.equal(response.headers['content-range'], 'bytes */100');
    assert.equal(response.headers['content-length'], String(Buffer.byteLength(envelope)));
  });

  test('does not copy Content-Encoding and Transfer-Encoding of the error', async (t) => {
    const fastify = await startApp(t);
    const [response] = await injectFailures(fastify, [createForeignError(400, {
      headers: { 'Content-Encoding': 'gzip', 'Transfer-Encoding': 'chunked', 'X-Reason': 'kept' },
    })]);

    assertErrorResponse(response, 400, 'BAD_REQUEST_ERROR');
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.headers['transfer-encoding'], undefined);
    assert.equal(response.headers['x-reason'], 'kept');
    assert.equal(response.headers['content-length'], String(response.rawPayload.length));
  });

  test('skips a header with an invalid name or value and still answers', async (t) => {
    const fastify = await startApp(t);
    const [response] = await injectFailures(fastify, [createForeignError(409, {
      headers: {
        'X-Broken-Value': 'first\r\nsecond',
        'broken name': 'value',
        'X-Missing-Value': undefined,
        'X-Reason': 'kept',
      },
    })]);

    assertErrorResponse(response, 409, 'BAD_REQUEST_ERROR');
    assert.equal(response.headers['x-broken-value'], undefined);
    assert.equal(response.headers['broken name'], undefined);
    assert.equal(response.headers['x-missing-value'], undefined);
    assert.equal(response.headers['x-reason'], 'kept');
  });

  test('removes Content-Encoding and Transfer-Encoding the route set before it failed', async (t) => {
    const fastify = await startApp(t);

    fastify.get('/items', async (request, reply) => {
      reply.header('content-encoding', 'gzip');
      reply.header('transfer-encoding', 'chunked');
      reply.type('text/csv');

      throw new AppError(ERROR_CODE.NO_CHANGES);
    });

    const response = await fastify.inject('/items');

    assertErrorResponse(response, 409, 'NO_CHANGES');
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.headers['transfer-encoding'], undefined);
    assert.equal(response.headers['content-length'], String(response.rawPayload.length));
  });

  test('does not copy the headers of a foreign server fault', async (t) => {
    const fastify = await startApp(t);
    const headers = { 'X-Database-Host': 'db-1.internal' };
    const responses = await injectFailures(fastify, [500, 502].map((statusCode) => createForeignError(statusCode, { headers })));

    responses.forEach((response) => {
      assertErrorResponse(response, 500, 'SERVER_ERROR');
      assert.equal(response.headers['x-database-host'], undefined);
    });
  });

  test('keeps the id of the request when the error brings an X-Request-Id of its own', async (t) => {
    const fastify = await startApp(t);
    const [response] = await injectFailures(fastify, [createForeignError(400, { headers: { 'X-Request-Id': 'chosen-by-the-error' } })]);

    assertErrorResponse(response, 400, 'BAD_REQUEST_ERROR');
  });
});

describe('handleError: AppError', () => {
  test('answers with the status, the code and the message of the catalogue', async (t) => {
    const fastify = await startApp(t);
    const [response] = await injectFailures(fastify, [new AppError(ERROR_CODE.NOT_FOUND_ERROR)]);

    assertErrorResponse(response, 404, 'NOT_FOUND_ERROR', { message: 'Not found' });
  });

  test('answers every code of the catalogue with its own status, 401 and 403 included', async (t) => {
    const fastify = await startApp(t);
    const codes = Object.keys(APP_ERROR_STATUSES);
    const responses = await injectFailures(fastify, codes.map((code) => new AppError(code)));

    assert.deepEqual(codes.toSorted(), Object.keys(ERROR_CATALOG).toSorted());
    responses.forEach((response, index) => assertErrorResponse(response, APP_ERROR_STATUSES[codes[index]], codes[index]));
  });

  test('keeps the message the error was created with, in prod as in dev', async (t) => {
    const apps = await startAppInEveryMode(t);
    const errors = [
      new AppError(ERROR_CODE.NO_CHANGES, { message: 'Nothing to update' }),
      new AppError(ERROR_CODE.UPSTREAM_ERROR, { message: 'Mail provider is down' }),
    ];
    const [prodResponses, devResponses] = await Promise.all(apps.map((fastify) => injectFailures(fastify, errors)));

    assertErrorResponse(prodResponses[0], 409, 'NO_CHANGES', { message: 'Nothing to update' });
    assertErrorResponse(prodResponses[1], 502, 'UPSTREAM_ERROR', { message: 'Mail provider is down' });
    assertErrorResponse(devResponses[0], 409, 'NO_CHANGES', { message: 'Nothing to update' });
    assertErrorResponse(devResponses[1], 502, 'UPSTREAM_ERROR', { message: 'Mail provider is down', stack: errors[1].stack });
  });

  test('copies the headers of the error, also of a server fault', async (t) => {
    const fastify = await startApp(t);
    const [limited, upstream, broken] = await injectFailures(fastify, [
      new AppError(ERROR_CODE.RATE_LIMIT_ERROR, { headers: { 'Retry-After': '30' } }),
      new AppError(ERROR_CODE.UPSTREAM_ERROR, { headers: { 'X-Upstream': 'mail' } }),
      new AppError(ERROR_CODE.SERVER_ERROR, { headers: { 'X-Incident': 'INC-1', 'Content-Type': 'text/plain' } }),
    ]);

    assertErrorResponse(limited, 429, 'RATE_LIMIT_ERROR');
    assert.equal(limited.headers['retry-after'], '30');
    assertErrorResponse(upstream, 502, 'UPSTREAM_ERROR');
    assert.equal(upstream.headers['x-upstream'], 'mail');
    assertErrorResponse(broken, 500, 'SERVER_ERROR');
    assert.equal(broken.headers['x-incident'], 'INC-1');
  });

  test('passes the validation of the error through to the body', async (t) => {
    const apps = await startAppInEveryMode(t);
    const validation = [
      createEntry('email', 'john@example.com', 'unique', null),
      createEntry('phone', null, 'required', null),
    ];
    const responses = await Promise.all(apps.map((fastify) => injectFailures(fastify, [
      new AppError(ERROR_CODE.VALIDATION_ERROR, { validation }),
    ])));

    responses.forEach(([response]) => assertErrorResponse(response, 422, 'VALIDATION_ERROR', { validation }));
  });

  test('answers reply.fail(error) exactly as a thrown error, under the response schema of the route', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);

    function createRefusal() {
      return new AppError(ERROR_CODE.AUTHORIZATION_ERROR, { message: 'Admins only', headers: { 'X-Reason': 'role' } });
    }

    function createRouteOptions() {
      return {
        security: { auth: false },
        schema: { response: { 200: successEnvelope(createItemData()) } },
      };
    }

    fastify.get('/api/v1/items/thrown', createRouteOptions(), async () => {
      throw createRefusal();
    });
    fastify.get('/api/v1/items/failed', createRouteOptions(), (request, reply) => reply.fail(createRefusal()));

    const responses = await Promise.all(['/api/v1/items/thrown', '/api/v1/items/failed'].map((url) => fastify.inject(url)));

    responses.forEach((response) => {
      assertErrorResponse(response, 403, 'AUTHORIZATION_ERROR', { message: 'Admins only' });
      assert.equal(response.headers['x-reason'], 'role');
      assertFailureLogged(lines, response, LOG_LEVEL_WARN);
    });
  });
});

describe('handleError: foreign errors', () => {
  test('turns a foreign 401 and 403 into 400 BAD_REQUEST_ERROR: only an AppError ends a session', async (t) => {
    const fastify = await startApp(t);
    const responses = await injectFailures(fastify, [401, 403].map((statusCode) => createForeignError(statusCode)));

    responses.forEach((response) => assertErrorResponse(response, 400, 'BAD_REQUEST_ERROR', { message: 'Bad request' }));
  });

  test('gives a foreign 404, 413, 415 and 429 the code of the status', async (t) => {
    const fastify = await startApp(t);
    const cases = [
      [404, 'NOT_FOUND_ERROR'],
      [413, 'PAYLOAD_TOO_LARGE_ERROR'],
      [415, 'UNSUPPORTED_MEDIA_TYPE_ERROR'],
      [429, 'RATE_LIMIT_ERROR'],
    ];
    const responses = await injectFailures(fastify, cases.map(([statusCode]) => createForeignError(statusCode)));

    responses.forEach((response, index) => assertErrorResponse(response, ...cases[index]));
  });

  test('keeps Retry-After a foreign 429 brings in its headers', async (t) => {
    const fastify = await startApp(t);
    const [response] = await injectFailures(fastify, [createForeignError(429, { headers: { 'Retry-After': '7' } })]);

    assertErrorResponse(response, 429, 'RATE_LIMIT_ERROR');
    assert.equal(response.headers['retry-after'], '7');
  });

  test('keeps the status of any other foreign 4xx under BAD_REQUEST_ERROR', async (t) => {
    const fastify = await startApp(t);
    const statusCodes = [400, 402, 405, 409, 414, 416, 418, 451];
    const responses = await injectFailures(fastify, statusCodes.map((statusCode) => createForeignError(statusCode)));

    responses.forEach((response, index) => assertErrorResponse(response, statusCodes[index], 'BAD_REQUEST_ERROR'));
  });

  test('reads the status from error.status when error.statusCode is not an error status', async (t) => {
    const fastify = await startApp(t);
    const [statusOnly, invalidCode, bothValid] = await injectFailures(fastify, [
      Object.assign(new Error('status only'), { status: 409 }),
      Object.assign(new Error('invalid statusCode'), { statusCode: 99, status: 404 }),
      Object.assign(new Error('both'), { statusCode: 418, status: 404 }),
    ]);

    assertErrorResponse(statusOnly, 409, 'BAD_REQUEST_ERROR');
    assertErrorResponse(invalidCode, 404, 'NOT_FOUND_ERROR');
    assertErrorResponse(bothValid, 418, 'BAD_REQUEST_ERROR');
  });

  test('does not take a foreign error with a validation list but no validationContext for a schema error', async (t) => {
    const fastify = await startApp(t);
    const [response] = await injectFailures(fastify, [createForeignError(409, {
      validation: [{ instancePath: '/name', keyword: 'minLength', params: { limit: 3 } }],
    })]);

    assertErrorResponse(response, 409, 'BAD_REQUEST_ERROR');
  });

  test('answers 500 SERVER_ERROR to a foreign 5xx other than 503', async (t) => {
    const fastify = await startApp(t);
    const responses = await injectFailures(fastify, [500, 501, 502, 504, 599].map((statusCode) => createForeignError(statusCode)));

    responses.forEach((response) => assertErrorResponse(response, 500, 'SERVER_ERROR'));
  });

  test('answers 500 SERVER_ERROR to a status that is not an integer from 400 to 599', async (t) => {
    const fastify = await startApp(t);
    const statusCodes = [99, 200, 302, 399, 600, '404', 404.5, Number.NaN, Number.POSITIVE_INFINITY, null];
    const responses = await injectFailures(fastify, statusCodes.map((statusCode) => createForeignError(statusCode)));

    responses.forEach((response) => assertErrorResponse(response, 500, 'SERVER_ERROR', { message: 'Server error' }));
  });

  test('answers 500 SERVER_ERROR to a thrown null, undefined, string, number or plain object', async (t) => {
    const fastify = await startApp(t);
    const responses = await injectFailures(fastify, [null, undefined, 'just a string', 42, {}, []]);

    responses.forEach((response) => assertErrorResponse(response, 500, 'SERVER_ERROR'));
  });

  test('answers 500 to a thrown value that is not an error in dev as well', async (t) => {
    const fastify = await startApp(t, { mode: MODE.DEV });
    const [fromNull, fromUndefined, fromString] = await injectFailures(fastify, [null, undefined, 'just a string']);

    assertErrorResponse(fromNull, 500, 'SERVER_ERROR');
    assertErrorResponse(fromUndefined, 500, 'SERVER_ERROR');
    assert.equal(fromString.statusCode, 500);
    assert.equal(fromString.json().code, 'SERVER_ERROR');
    assert.equal(fromString.json().meta.requestId, fromString.headers[REQUEST_ID_HEADER]);
  });

  test('answers 500 SERVER_ERROR without the text or the stack of the error in prod', async (t) => {
    const fastify = await startApp(t);
    const [response] = await injectFailures(fastify, [new Error('connect ECONNREFUSED 10.0.0.5:3306')]);

    assertErrorResponse(response, 500, 'SERVER_ERROR', { message: 'Server error' });
    assert.equal(response.body.includes('ECONNREFUSED'), false);
    assert.equal(response.body.includes('stack'), false);
  });

  test('shows the message and the stack of a server fault in dev', async (t) => {
    const fastify = await startApp(t, { mode: MODE.DEV });
    const errors = [
      new Error('connect ECONNREFUSED 10.0.0.5:3306'),
      createForeignError(502),
      new AppError(ERROR_CODE.SERVER_ERROR),
    ];
    const [unknown, foreign, known] = await injectFailures(fastify, errors);

    assertErrorResponse(unknown, 500, 'SERVER_ERROR', { message: 'connect ECONNREFUSED 10.0.0.5:3306', stack: errors[0].stack });
    assertErrorResponse(foreign, 500, 'SERVER_ERROR', { message: 'Foreign failure 502', stack: errors[1].stack });
    assertErrorResponse(known, 500, 'SERVER_ERROR', { stack: errors[2].stack });
  });

  test('gives the message of a foreign 4xx or 503 in dev, and never its stack', async (t) => {
    const fastify = await startApp(t, { mode: MODE.DEV });
    const [badRequest, teapot, missing, overloaded, unavailable] = await injectFailures(fastify, [
      createForeignError(401),
      createForeignError(418),
      new AppError(ERROR_CODE.NOT_FOUND_ERROR),
      createForeignError(503),
      new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR),
    ]);

    assertErrorResponse(badRequest, 400, 'BAD_REQUEST_ERROR', { message: 'Foreign failure 401' });
    assertErrorResponse(teapot, 418, 'BAD_REQUEST_ERROR', { message: 'Foreign failure 418' });
    assertErrorResponse(missing, 404, 'NOT_FOUND_ERROR');
    assertErrorResponse(overloaded, 503, 'SERVICE_UNAVAILABLE_ERROR', { message: 'Foreign failure 503' });
    assertErrorResponse(unavailable, 503, 'SERVICE_UNAVAILABLE_ERROR');
  });
});

describe('handleError: 503', () => {
  test('answers 503 SERVICE_UNAVAILABLE_ERROR with Retry-After from config.app.unavailableRetryAfter', async (t) => {
    const fastify = await startApp(t);
    const responses = await injectFailures(fastify, [
      createForeignError(503),
      new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR),
    ]);

    assert.equal(fastify.config.app.unavailableRetryAfter, '1m');
    responses.forEach((response) => {
      assertErrorResponse(response, 503, 'SERVICE_UNAVAILABLE_ERROR', { message: 'Service unavailable' });
      assert.equal(response.headers['retry-after'], '60');
    });
  });

  test('keeps Retry-After the error brings in its headers', async (t) => {
    const fastify = await startApp(t);
    const [foreign, known] = await injectFailures(fastify, [
      createForeignError(503, { headers: { 'Retry-After': '10' } }),
      new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { headers: { 'retry-after': '5' } }),
    ]);

    assertErrorResponse(foreign, 503, 'SERVICE_UNAVAILABLE_ERROR');
    assert.equal(foreign.headers['retry-after'], '10');
    assertErrorResponse(known, 503, 'SERVICE_UNAVAILABLE_ERROR');
    assert.equal(known.headers['retry-after'], '5');
  });

  test('keeps Retry-After the route set before it failed', async (t) => {
    const fastify = await startApp(t);

    fastify.get('/items', async (request, reply) => {
      reply.header('retry-after', '120');

      throw createForeignError(503);
    });

    const response = await fastify.inject('/items');

    assertErrorResponse(response, 503, 'SERVICE_UNAVAILABLE_ERROR');
    assert.equal(response.headers['retry-after'], '120');
  });

  test('falls back to the configured Retry-After when the one of the error cannot be sent', async (t) => {
    const fastify = await startApp(t);
    const [response] = await injectFailures(fastify, [createForeignError(503, { headers: { 'Retry-After': '10\r\nX-Injected: 1' } })]);

    assertErrorResponse(response, 503, 'SERVICE_UNAVAILABLE_ERROR');
    assert.equal(response.headers['retry-after'], '60');
    assert.equal(response.headers['x-injected'], undefined);
  });

  test('follows a change of config.app.unavailableRetryAfter', async (t) => {
    const fastify = await startApp(t, { app: { unavailableRetryAfter: '5s' } });
    const responses = await injectFailures(fastify, [
      createForeignError(503),
      new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR),
    ]);

    responses.forEach((response) => assert.equal(response.headers['retry-after'], '5'));
  });

  test('adds no Retry-After of its own to an error that is not a 503', async (t) => {
    const fastify = await startApp(t);
    const responses = await injectFailures(fastify, [
      createForeignError(400),
      createForeignError(500),
      new AppError(ERROR_CODE.NO_CHANGES),
      new AppError(ERROR_CODE.UPSTREAM_ERROR),
    ]);
    const missing = await fastify.inject('/nope');

    [...responses, missing].forEach((response) => assert.equal(response.headers['retry-after'], undefined));
  });
});

describe('handleError: log', () => {
  test('logs a 4xx once, as a warning with the error and the id of the request', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const errors = [createForeignError(418), new AppError(ERROR_CODE.NOT_FOUND_ERROR)];
    const responses = await injectFailures(fastify, errors);

    responses.forEach((response, index) => {
      const line = assertFailureLogged(lines, response, LOG_LEVEL_WARN);

      assert.equal(line.err.message, errors[index].message);
      assert.equal(line.err.stack, errors[index].stack);
    });
  });

  test('logs a server fault once, as an error that keeps the text the response hides', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const errors = [
      new Error('connect ECONNREFUSED 10.0.0.5:3306'),
      createForeignError(502),
      new AppError(ERROR_CODE.SERVER_ERROR),
      new AppError(ERROR_CODE.UPSTREAM_ERROR),
    ];
    const responses = await injectFailures(fastify, errors);

    responses.forEach((response, index) => {
      const line = assertFailureLogged(lines, response, LOG_LEVEL_ERROR);

      assert.equal(line.err.message, errors[index].message);
      assert.equal(line.err.stack, errors[index].stack);
    });
  });

  test('logs a 503 as a warning: an overload is not a fault of the code', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const responses = await injectFailures(fastify, [
      createForeignError(503),
      new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR),
    ]);

    responses.forEach((response) => {
      assert.equal(response.statusCode, 503);
      assertFailureLogged(lines, response, LOG_LEVEL_WARN);
    });
  });

  test('logs every AppError at the level of its status: an error for a 5xx other than 503, a warning otherwise', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const codes = Object.keys(APP_ERROR_STATUSES);
    const responses = await injectFailures(fastify, codes.map((code) => new AppError(code)));

    responses.forEach((response, index) => {
      const statusCode = APP_ERROR_STATUSES[codes[index]];
      const level = statusCode >= 500 && statusCode !== 503
        ? LOG_LEVEL_ERROR
        : LOG_LEVEL_WARN;

      assert.equal(assertFailureLogged(lines, response, level).err.code, codes[index]);
    });
  });

  test('logs an error of Fastify as a warning, on the path that runs no hook too', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const longUrl = createLongParameterUrl(fastify, 1);

    declareBodyRoute(fastify, createObjectSchema({}));
    declareParameterRoute(fastify);

    const [malformed, malformedUrl, longParameter] = await Promise.all([
      postText(fastify, '/items', MALFORMED_JSON),
      fastify.inject('/%FF'),
      fastify.inject(longUrl),
    ]);

    assert.equal(assertFailureLogged(lines, malformed, LOG_LEVEL_WARN).err.message, FASTIFY_MESSAGE.MALFORMED_JSON);
    assert.equal(assertFailureLogged(lines, malformedUrl, LOG_LEVEL_WARN).err.message, FASTIFY_MESSAGE.MALFORMED_URL);
    assert.equal(assertFailureLogged(lines, longParameter, LOG_LEVEL_WARN).err.message, `'${longUrl}' is exceeding the max param length`);
  });
});

describe('handleNotFound', () => {
  test('answers 404 NOT_FOUND_ERROR with X-Request-Id to an unknown URL', async (t) => {
    const fastify = await startApp(t);
    const response = await fastify.inject('/nope?x=1');

    assertErrorResponse(response, 404, 'NOT_FOUND_ERROR', { message: 'Not found' });
  });

  test('names the method and the URL in dev', async (t) => {
    const fastify = await startApp(t, { mode: MODE.DEV });
    const response = await fastify.inject('/nope?x=1');

    assertErrorResponse(response, 404, 'NOT_FOUND_ERROR', { message: 'Route GET /nope?x=1 not found' });
  });

  test('answers 404 to a method the known path does not serve', async (t) => {
    const apps = await startAppInEveryMode(t);
    const [known, ...unknown] = await Promise.all([
      apps[0].inject('/api/v1/system/ping'),
      ...apps.map((fastify) => fastify.inject({ method: 'DELETE', url: '/api/v1/system/ping' })),
    ]);

    assert.equal(known.statusCode, 200);
    assertErrorResponse(unknown[0], 404, 'NOT_FOUND_ERROR', { message: 'Not found' });
    assertErrorResponse(unknown[1], 404, 'NOT_FOUND_ERROR', { message: 'Route DELETE /api/v1/system/ping not found' });
  });

  test('answers HEAD to an unknown URL with the headers of the envelope and no body', async (t) => {
    const fastify = await startApp(t);

    await fastify.listen({ host: '127.0.0.1', port: 0 });

    const text = await sendRawRequest(fastify.server.address().port, 'HEAD /nope HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    const { statusLine, headers, body } = parseRawResponse(text);
    const envelope = JSON.stringify({
      status: 'error',
      code: 'NOT_FOUND_ERROR',
      message: 'Not found',
      meta: { requestId: headers[REQUEST_ID_HEADER] },
    });

    assert.equal(statusLine, 'HTTP/1.1 404 Not Found');
    assert.equal(headers['content-type'], JSON_CONTENT_TYPE);
    assert.equal(uuidVersion(headers[REQUEST_ID_HEADER]), REQUEST_ID_VERSION);
    assert.equal(headers['content-length'], String(Buffer.byteLength(envelope)));
    assert.equal(body, '');
  });

  test('answers 400 to an unknown URL with malformed JSON: Fastify parses the body before the 404 handler', async (t) => {
    const fastify = await startApp(t);
    const [malformed, wellFormed] = await Promise.all(
      [MALFORMED_JSON, '{"name":"Ann"}'].map((payload) => postText(fastify, '/nope', payload)),
    );

    assertErrorResponse(malformed, 400, 'BAD_REQUEST_ERROR');
    assertErrorResponse(wellFormed, 404, 'NOT_FOUND_ERROR');
  });

  test('writes no line of its own to the log', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const response = await fastify.inject('/nope');

    assertErrorResponse(response, 404, 'NOT_FOUND_ERROR');
    assert.deepEqual(readProblemLines(lines, response), []);
    assert.deepEqual(lines.filter((line) => line.msg === REQUEST_FAILED_MESSAGE), []);
  });
});

describe('handleError: scope', () => {
  test('answers for the routes of an encapsulated plugin registered after buildApp', async (t) => {
    const fastify = await startApp(t);

    fastify.register(async (instance) => {
      instance.get('/broken', async () => {
        throw new Error('scoped failure');
      });
      instance.get('/refused', async () => {
        throw new AppError(ERROR_CODE.NO_CHANGES);
      });
    }, { prefix: '/scoped' });

    const [broken, refused, missing] = await Promise.all(
      ['/scoped/broken', '/scoped/refused', '/scoped/nope'].map((url) => fastify.inject(url)),
    );

    assertErrorResponse(broken, 500, 'SERVER_ERROR');
    assertErrorResponse(refused, 409, 'NO_CHANGES');
    assertErrorResponse(missing, 404, 'NOT_FOUND_ERROR');
  });

  test('answers for an error of a hook: thrown from onRequest or passed to done()', async (t) => {
    const fastify = await startApp(t);

    fastify.addHook('onRequest', async (request) => {
      if (request.headers['x-client'] === 'banned') {
        throw new AppError(ERROR_CODE.RATE_LIMIT_ERROR, { headers: { 'Retry-After': '3' } });
      }
    });
    fastify.addHook('onRequest', (request, reply, done) => {
      done(request.headers['x-client'] === 'broken' ? new Error('hook failure') : undefined);
    });
    fastify.get('/items', async () => ({ isFound: true }));

    const [passed, banned, bannedOnUnknownUrl, broken] = await Promise.all([
      fastify.inject('/items'),
      fastify.inject({ url: '/items', headers: { 'x-client': 'banned' } }),
      fastify.inject({ url: '/nope', headers: { 'x-client': 'banned' } }),
      fastify.inject({ url: '/items', headers: { 'x-client': 'broken' } }),
    ]);

    assert.equal(passed.statusCode, 200);
    assertErrorResponse(banned, 429, 'RATE_LIMIT_ERROR');
    assert.equal(banned.headers['retry-after'], '3');
    assertErrorResponse(bannedOnUnknownUrl, 429, 'RATE_LIMIT_ERROR');
    assertErrorResponse(broken, 500, 'SERVER_ERROR');
  });

  test('answers for a handler that throws synchronously', async (t) => {
    const fastify = await startApp(t);

    fastify.get('/items', () => {
      throw new AppError(ERROR_CODE.NO_CHANGES);
    });

    assertErrorResponse(await fastify.inject('/items'), 409, 'NO_CHANGES');
  });

  test('returns nothing: Fastify would send a returned value as the body', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const returned = [];

    fastify.get('/items', {
      errorHandler(error, request, reply) {
        returned.push(handleError(error, request, reply));
      },
    }, async () => {
      throw new AppError(ERROR_CODE.NO_CHANGES);
    });
    fastify.register(async (instance) => {
      instance.setNotFoundHandler((request, reply) => {
        returned.push(handleNotFound(request, reply));
      });
    }, { prefix: '/scoped' });

    const [failed, missing] = await Promise.all(['/items', '/scoped/nope'].map((url) => fastify.inject(url)));

    assert.deepEqual(returned, [undefined, undefined]);
    assertErrorResponse(failed, 409, 'NO_CHANGES');
    assertErrorResponse(missing, 404, 'NOT_FOUND_ERROR');
    assert.deepEqual(lines.filter((line) => line.level >= LOG_LEVEL_WARN).map((line) => line.msg), [REQUEST_FAILED_MESSAGE]);
  });
});

describe('handleError: the validation of an AppError', () => {
  test('goes out by the rules of a schema error: a primitive, cut to length, nothing under a sensitive column', async (t) => {
    const fastify = await startApp(t);
    const { maxValueLength } = fastify.config.app.validation;
    const long = 'x'.repeat(maxValueLength + 50);
    const longColumn = 'c'.repeat(maxValueLength + 50);
    const validation = [
      createEntry('email', 'john@example.com', 'unique', null),
      createEntry('profile', { theme: 'dark' }, 'type', 'object'),
      createEntry('tags', ['a', 'b'], 'maxItems', 1),
      createEntry('bio', long, 'maxLength', 100),
      createEntry('password', 'hunter2', 'minLength', 8),
      createEntry(longColumn, 1, 'minimum', 2),
      { columnValue: 'orphan', operator: 'custom' },
      'not an entry',
    ];
    const [response] = await injectFailures(fastify, [new AppError(ERROR_CODE.VALIDATION_ERROR, { validation })]);

    assertErrorResponse(response, 422, 'VALIDATION_ERROR', {
      validation: [
        createEntry('email', 'john@example.com', 'unique', null),
        createEntry('profile', null, 'type', 'object'),
        createEntry('tags', null, 'maxItems', 1),
        createEntry('bio', truncate(long, maxValueLength), 'maxLength', 100),
        createEntry('password', null, 'minLength', 8),
        createEntry(truncate(longColumn, maxValueLength), 1, 'minimum', 2),
        createEntry(null, null, 'custom', null),
      ],
    });
  });

  test('is capped at the ceiling by a copy: the list of the thrower stays whole, frozen or sealed too', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const { maxErrors } = fastify.config.app.validation;
    const entries = Array.from({ length: maxErrors + 5 }, (item, index) => createEntry(`field${index}`, index, 'unique', null));
    const lists = [entries, Object.freeze([...entries]), Object.seal([...entries])];
    const responses = await injectFailures(fastify, lists.map((validation) => new AppError(ERROR_CODE.VALIDATION_ERROR, { validation })));

    responses.forEach((response) => {
      assert.equal(response.statusCode, 422);
      assert.equal(response.json().validation.length, maxErrors);
      assert.equal(assertFailureLogged(lines, response, LOG_LEVEL_WARN).validation.length, maxErrors);
    });
    lists.forEach((list) => assert.equal(list.length, maxErrors + 5));
  });

  test('is logged without the values, next to the error and not inside it', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const validation = [createEntry('email', 'john@example.com', 'unique', null)];
    const [response] = await injectFailures(fastify, [new AppError(ERROR_CODE.VALIDATION_ERROR, { validation })]);
    const line = assertFailureLogged(lines, response, LOG_LEVEL_WARN);

    assert.deepEqual(line.validation, [{ column: 'email', operator: 'unique', operatorValue: null }]);
    assert.equal(Object.hasOwn(line.err, 'validation'), false);
    assert.equal(JSON.stringify(line).includes('john@example.com'), false);
  });
});

describe('handleError: a duplicate in the database', () => {
  test('answers 422 VALIDATION_ERROR on the field the entity schema maps the index to, with the value the client sent', async (t) => {
    const fastify = await startApp(t);

    fastify.post('/groups', async () => {
      throw createDuplicate('uq_groups_slug');
    });

    const [[user], group] = await Promise.all([
      injectDuplicates(fastify, [createDuplicate('uq_users_email')], { email: DUPLICATE_EMAIL, firstName: 'Anna' }),
      fastify.inject({ method: 'POST', url: '/groups', payload: { slug: 'admin', name: 'Admins' } }),
    ]);

    assertErrorResponse(user, 422, 'VALIDATION_ERROR', { validation: [createEntry('email', DUPLICATE_EMAIL, 'unique', null)] });
    assertErrorResponse(group, 422, 'VALIDATION_ERROR', { validation: [createEntry('slug', 'admin', 'unique', null)] });
    [user, group].forEach((response) => assert.doesNotMatch(response.body, /uq_|Duplicate entry/));
  });

  test('gives a developer the text of the database, which names the index and masks the value, and no stack', async (t) => {
    const fastify = await startApp(t, { mode: MODE.DEV });
    const [named, silent] = await injectDuplicates(fastify, [
      createDuplicate('uq_users_email'),
      new DbError('', { kind: DB_ERROR_KIND.UNIQUE, constraint: 'uq_users_email' }),
    ], { email: DUPLICATE_EMAIL });
    const validation = [createEntry('email', DUPLICATE_EMAIL, 'unique', null)];

    assertErrorResponse(named, 422, 'VALIDATION_ERROR', { message: "Duplicate entry '***' for key 'uq_users_email'", validation });
    assertErrorResponse(silent, 422, 'VALIDATION_ERROR', { validation });
  });

  test('gives a null column to an index no schema names, a missing one and one named like a property of every object', async (t) => {
    const fastify = await startApp(t);
    const constraints = ['PRIMARY', 'uq_people_email', 'constructor', 'toString', 'hasOwnProperty', '__proto__'];
    const errors = [...constraints.map((constraint) => createDuplicate(constraint)), new DbError('Database error', { kind: DB_ERROR_KIND.UNIQUE })];
    const payload = Object.fromEntries([...constraints.filter((key) => key !== '__proto__'), 'email'].map((key) => [key, DUPLICATE_EMAIL]));
    const responses = await injectDuplicates(fastify, errors, payload);

    responses.forEach((response) => {
      assertErrorResponse(response, 422, 'VALIDATION_ERROR', { validation: [createEntry(null, null, 'unique', null)] });
    });
  });

  test('reflects the value by the rules of every entry: a primitive of the body, cut to length, null when there is none', async (t) => {
    const fastify = await startApp(t);
    const { maxValueLength } = fastify.config.app.validation;
    const long = `${'a'.repeat(maxValueLength)}@example.com`;
    const payloads = [{}, { email: null }, { email: { address: DUPLICATE_EMAIL } }, { email: [DUPLICATE_EMAIL] }, { email: long }, { email: 7 }];
    const requests = [
      ...payloads.map((payload) => ({ method: 'POST', url: '/users', payload })),
      {
        method: 'POST',
        url: '/users',
        payload: DUPLICATE_EMAIL,
        headers: { 'content-type': 'text/plain' },
      },
      { method: 'GET', url: '/users' },
    ];
    const columnValues = [null, null, null, null, truncate(long, maxValueLength), 7, null, null];
    const error = createDuplicate('uq_users_email');

    fastify.post('/users', async () => {
      throw error;
    });
    fastify.get('/users', async () => {
      throw error;
    });

    const responses = await Promise.all(requests.map((request) => fastify.inject(request)));

    responses.forEach((response, index) => {
      assertErrorResponse(response, 422, 'VALIDATION_ERROR', { validation: [createEntry('email', columnValues[index], 'unique', null)] });
    });
  });

  test('logs a duplicate once, as a warning that names the index and not the value', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const [response] = await injectDuplicates(fastify, [createDuplicate('uq_users_email')], { email: DUPLICATE_EMAIL });
    const line = assertFailureLogged(lines, response, LOG_LEVEL_WARN);

    assert.deepEqual(pick(line.err, ['type', 'kind', 'constraint']), { type: 'DbError', kind: 'unique', constraint: 'uq_users_email' });
    assert.deepEqual(line.validation, [{ column: 'email', operator: 'unique', operatorValue: null }]);
    assert.equal(JSON.stringify(lines).includes(DUPLICATE_EMAIL), false);
  });

  test('answers under a null column on an instance without the map of unique fields', async (t) => {
    const fastify = Fastify();
    t.after(() => fastify.close());

    fastify.decorate('config', createTestConfig());
    fastify.setErrorHandler(handleError);

    const [response] = await injectDuplicates(fastify, [createDuplicate('uq_users_email')], { email: DUPLICATE_EMAIL });

    assert.equal(fastify.hasDecorator('uniqueFields'), false);
    assert.equal(response.statusCode, 422);
    assert.deepEqual(pick(response.json(), ['code', 'validation']), {
      code: 'VALIDATION_ERROR',
      validation: [createEntry(null, null, 'unique', null)],
    });
  });

  test('keeps the answer of an AppError whose cause is a duplicate, and of an error of the database of another kind', async (t) => {
    const fastify = await startApp(t);
    const [refused, deadlock] = await injectDuplicates(fastify, [
      new AppError(ERROR_CODE.NO_CHANGES, { cause: createDuplicate('uq_users_email') }),
      new DbError('Deadlock found when trying to get lock', { kind: DB_ERROR_KIND.DEADLOCK }),
    ], { email: DUPLICATE_EMAIL });

    assertErrorResponse(refused, 409, 'NO_CHANGES');
    assertErrorResponse(deadlock, 500, 'SERVER_ERROR');
  });

  test('answers an AppError whose code was changed after it was built by its status and its own message, a duplicate for its cause too', async (t) => {
    const fastify = await startApp(t);
    const renamed = Object.assign(new AppError(ERROR_CODE.NOT_FOUND_ERROR, {
      message: 'No such group',
      cause: createDuplicate('uq_groups_slug'),
    }), { code: 'NOPE' });
    const [response] = await injectDuplicates(fastify, [renamed], { slug: 'admin' });

    assertErrorResponse(response, 404, 'NOT_FOUND_ERROR', { message: 'No such group' });
  });
});

describe('handleError: the log of a schema error', () => {
  test('names the column and the rule of each error, without the value and without the raw error of AJV', async (t) => {
    const { fastify, lines } = await startLoggedApp(t, { mode: MODE.DEV });

    declareBodyRoute(fastify, createObjectSchema({ email: { type: 'string', format: 'email', maxLength: 254 }, age: { type: 'integer', minimum: 18 } }));

    const response = await postItem(fastify, { email: 'person-at-example', age: 7 });
    const line = assertFailureLogged(lines, response, LOG_LEVEL_WARN);

    assert.equal(typeof response.json().validation[0].schema, 'object');
    assert.deepEqual(line.validation, [
      { column: 'email', operator: 'format', operatorValue: 'email' },
      { column: 'age', operator: 'minimum', operatorValue: 18 },
    ]);
    assert.equal(Object.hasOwn(line.err, 'validation'), false);
    assert.equal(JSON.stringify(line).includes('person-at-example'), false);
  });

  test('cuts the column of a client that names its own keys: twenty long keys do not multiply the answer', async (t) => {
    const { fastify, lines } = await startLoggedApp(t);
    const { maxValueLength } = fastify.config.app.validation;
    const key = 'k'.repeat(5000);

    declareBodyRoute(fastify, { type: 'object', additionalProperties: { type: 'array', items: { type: 'integer' } } });

    const response = await postItem(fastify, { [key]: Array.from({ length: 30 }, () => 'a') });
    const line = assertFailureLogged(lines, response, LOG_LEVEL_WARN);

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().validation.length, 20);
    assert.equal(response.json().validation[0].column, truncate(`${key}.0`, maxValueLength));
    assert.ok(response.rawPayload.length < LOG_LINE_MAX_BYTES, `the response takes ${response.rawPayload.length} bytes`);
    assert.ok(Buffer.byteLength(JSON.stringify(line)) < LOG_LINE_MAX_BYTES);
  });
});

describe('handleError: what the route left on the reply', () => {
  test('never lets an error be stored: no-store replaces the caching policy of the route', async (t) => {
    const fastify = await startApp(t);

    fastify.get('/cached', async (request, reply) => {
      reply.header('cache-control', 'public, max-age=3600');

      throw new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
    });
    fastify.get('/plain', async () => {
      throw new Error('boom');
    });

    const [cached, plain, missing] = await Promise.all(['/cached', '/plain', '/nope'].map((url) => fastify.inject(url)));

    assert.equal(cached.statusCode, 503);
    assert.equal(cached.headers['retry-after'], '60');
    assert.deepEqual([cached, plain, missing].map((response) => response.headers['cache-control']), ['no-store', 'no-store', 'no-store']);
  });

  test('keeps the caching policy the error itself brings', async (t) => {
    const fastify = await startApp(t);
    const [response] = await injectFailures(fastify, [
      new AppError(ERROR_CODE.NOT_FOUND_ERROR, { headers: { 'Cache-Control': 'max-age=60' } }),
    ]);

    assertErrorResponse(response, 404, 'NOT_FOUND_ERROR');
    assert.equal(response.headers['cache-control'], 'max-age=60');
  });

  test('sends the envelope whatever serializer the route had set on the reply', async (t) => {
    const fastify = await startApp(t);

    fastify.get('/export', async (request, reply) => {
      reply.serializer(() => 'id;name');

      throw new AppError(ERROR_CODE.NO_CHANGES);
    });

    assertErrorResponse(await fastify.inject('/export'), 409, 'NO_CHANGES');
  });

  test('sends the envelope whole through a response schema of that status that would cut it or break it', async (t) => {
    const fastify = await startApp(t);
    const narrow = { type: 'object', properties: { status: { type: 'string' } } };
    const strict = { type: 'object', required: ['details'], properties: { details: { type: 'string' } } };

    fastify.get('/narrow', { schema: { response: { 409: narrow } } }, async () => {
      throw new AppError(ERROR_CODE.NO_CHANGES);
    });
    fastify.get('/strict', { schema: { response: { '4xx': strict } } }, async () => {
      throw new AppError(ERROR_CODE.NO_CHANGES);
    });

    const [cut, broken] = await Promise.all(['/narrow', '/strict'].map((url) => fastify.inject(url)));

    assertErrorResponse(cut, 409, 'NO_CHANGES');
    assertErrorResponse(broken, 409, 'NO_CHANGES');
  });
});
