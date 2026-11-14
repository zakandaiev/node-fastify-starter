import { createEnvelope } from '#core/response/index.js';
import { assertRouteContract } from '#core/schema/route.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { errorEnvelope, listEnvelope, successEnvelope } from '#schemas/common/envelope.js';
import { dateTimeUtc, email, uuid } from '#schemas/common/field.js';
import { pagination } from '#schemas/common/pagination.js';
import { PRIMITIVE_TYPES, primitiveOrList, validation } from '#schemas/common/validation.js';
import { uuidv7 } from '#utils/id.js';
import { isArray, isObject } from '#utils/type.js';
import fastJson from 'fast-json-stringify';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const REQUEST_ID = '019a0000-0000-7000-8000-000000000000';
const CANONICAL_ID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b';
const NIL_ID = '00000000-0000-0000-0000-000000000000';

const NON_CANONICAL_IDS = [
  '019A1B2C-3D4E-7F50-8A6B-7C8D9E0F1A2B',
  '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2B',
  '019a1b2c3d4e7f508a6b7c8d9e0f1a2b',
  'urn:uuid:019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b',
  '{019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b}',
  ' 019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b',
  '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b ',
  '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b\n',
  '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2',
  '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2bc',
  '019g1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b',
  '',
];

const PUBLIC = Object.freeze({ auth: false });

const ITEM_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    id: Object.freeze({ type: 'integer' }),
    name: Object.freeze({ type: 'string' }),
  }),
});

const ITEM = Object.freeze({ id: 1, name: 'Anna' });
const ITEM_ROW = Object.freeze({ ...ITEM, passwordHash: '$argon2id$stored-hash' });

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

const FILTER = Object.freeze({
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
});

const VALIDATION = Object.freeze([
  {
    column: 'email',
    columnValue: 'abc',
    operator: 'format',
    operatorValue: 'email',
  },
  {
    column: 'age',
    columnValue: 17,
    operator: 'minimum',
    operatorValue: 18,
  },
  {
    column: 'discount',
    columnValue: -0.5,
    operator: 'minimum',
    operatorValue: 0,
  },
  {
    column: 'isAccepted',
    columnValue: false,
    operator: 'const',
    operatorValue: true,
  },
  {
    column: 'role',
    columnValue: 'guest',
    operator: 'enum',
    operatorValue: ['admin', 'user'],
  },
  {
    column: 'name',
    columnValue: '',
    operator: 'minLength',
    operatorValue: 2,
  },
  {
    column: 'limit',
    columnValue: 'Infinity',
    operator: 'finite',
    operatorValue: null,
  },
  {
    column: 'profile.tags',
    columnValue: null,
    operator: 'type',
    operatorValue: 'array',
  },
  {
    column: 'nickname',
    columnValue: null,
    operator: 'required',
    operatorValue: null,
  },
]);

const UNTYPED_ROOT = Object.freeze({
  column: null,
  columnValue: null,
  operator: 'type',
  operatorValue: 'object',
});

const AJV_ERROR = Object.freeze({
  instancePath: '/role',
  schemaPath: '#/properties/role/enum',
  keyword: 'enum',
  params: { allowedValues: ['admin', 'user'] },
  message: 'must be equal to one of the allowed values',
});

const STACK = 'Error: connect ECONNREFUSED\n    at createUser (file:///app/src/modules/users/users.service.js:12:9)';

const USER_BODY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    id: uuid('User id'),
    email: email('Email'),
    createdAt: dateTimeUtc('Created at'),
  },
});

function serialize(schema, payload) {
  return JSON.parse(fastJson(schema)(payload));
}

function reverseKeys(object) {
  return Object.fromEntries(Object.entries(object).reverse());
}

function collectKeys(schema) {
  if (isArray(schema)) {
    return schema.flatMap((item) => collectKeys(item));
  }

  if (!isObject(schema)) {
    return [];
  }

  return Object.entries(schema).flatMap(([key, value]) => [key, ...collectKeys(value)]);
}

function readTypes(properties) {
  return Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, schema.type]));
}

function createRoute(response) {
  return {
    method: 'GET',
    url: '/api/v1/items',
    security: PUBLIC,
    schema: { response: { 200: response } },
  };
}

function createFilterList(value) {
  return createEnvelope({ data: [], filters: [{ ...FILTER, value }] });
}

function withoutRequestId(body) {
  return { ...body, meta: { ...body.meta, requestId: null } };
}

describe('uuid', () => {
  test('describes a string with a pattern', () => {
    const schema = uuid();

    assert.equal(schema.type, 'string');
    assert.equal(typeof schema.pattern, 'string');
  });

  test('accepts the canonical form only: lower case with hyphens', () => {
    const pattern = new RegExp(uuid().pattern);

    [CANONICAL_ID, NIL_ID, uuidv7()].forEach((id) => assert.equal(pattern.test(id), true, id));
    NON_CANONICAL_IDS.forEach((id) => assert.equal(pattern.test(id), false, JSON.stringify(id)));
  });

  test('carries a description only when one is given', () => {
    assert.equal(Object.hasOwn(uuid(), 'description'), false);
    assert.deepEqual(uuid('User id'), { ...uuid(), description: 'User id' });
  });
});

describe('email', () => {
  test('describes a string in the email format', () => {
    const schema = email();

    assert.equal(schema.type, 'string');
    assert.equal(schema.format, 'email');
  });

  test('carries a description only when one is given', () => {
    assert.equal(Object.hasOwn(email(), 'description'), false);
    assert.deepEqual(email('Email'), { ...email(), description: 'Email' });
  });
});

describe('dateTimeUtc', () => {
  test('describes a string in a date-time format', () => {
    const schema = dateTimeUtc();

    assert.equal(schema.type, 'string');
    assert.match(schema.format, /^date-time/);
  });

  test('carries a description only when one is given', () => {
    assert.equal(Object.hasOwn(dateTimeUtc(), 'description'), false);
    assert.deepEqual(dateTimeUtc('Created at'), { ...dateTimeUtc(), description: 'Created at' });
  });
});

describe('fields in a route of the app', () => {
  test('let a valid body through: the validator knows their pattern and formats', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.post('/users', { schema: { body: USER_BODY_SCHEMA } }, (request) => request.body);

    const payload = { id: CANONICAL_ID, email: 'anna@example.com', createdAt: '2026-11-13T10:00:00.000Z' };
    const response = await fastify.inject({ method: 'POST', url: '/users', payload });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), payload);
  });

  test('report an id in upper case, a broken email and a date without a zone as validation entries', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.post('/users', { schema: { body: USER_BODY_SCHEMA } }, (request) => request.body);

    const response = await fastify.inject({
      method: 'POST',
      url: '/users',
      payload: { id: CANONICAL_ID.toUpperCase(), email: 'anna.example.com', createdAt: '2026-11-13T10:00:00' },
    });

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, 'VALIDATION_ERROR');
    assert.deepEqual(response.json().validation, [
      {
        column: 'id',
        columnValue: CANONICAL_ID.toUpperCase(),
        operator: 'pattern',
        operatorValue: uuid().pattern,
      },
      {
        column: 'email',
        columnValue: 'anna.example.com',
        operator: 'format',
        operatorValue: 'email',
      },
      {
        column: 'createdAt',
        columnValue: '2026-11-13T10:00:00',
        operator: 'format',
        operatorValue: dateTimeUtc().format,
      },
    ]);
  });

  test('uuid() in a path parameter answers 404 for an id that is not canonical', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const failedParts = [];

    fastify.addHook('onError', async (request, reply, error) => {
      failedParts.push(error.validationContext);
    });
    fastify.get('/users/:id', {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: uuid('User id'),
          },
        },
      },
    }, (request) => ({ id: request.params.id }));

    const ids = [CANONICAL_ID, CANONICAL_ID.toUpperCase(), CANONICAL_ID.replaceAll('-', ''), `urn:uuid:${CANONICAL_ID}`];
    const responses = await Promise.all(ids.map((id) => fastify.inject(`/users/${id}`)));

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 404, 404, 404]);
    assert.deepEqual(responses[0].json(), { id: CANONICAL_ID });
    assert.deepEqual(responses.slice(1).map((response) => response.json().code), ['NOT_FOUND_ERROR', 'NOT_FOUND_ERROR', 'NOT_FOUND_ERROR']);
    assert.deepEqual(failedParts, ['params', 'params', 'params']);
  });
});

describe('pagination', () => {
  test('declares the six fields of the response format, in its order', () => {
    assert.equal(pagination.type, 'object');
    assert.deepEqual(Object.keys(pagination.properties), ['total', 'limit', 'offset', 'totalPages', 'currentPage', 'canLoadMore']);
    assert.deepEqual(readTypes(pagination.properties), {
      total: 'integer',
      limit: 'integer',
      offset: 'integer',
      totalPages: 'integer',
      currentPage: 'integer',
      canLoadMore: 'boolean',
    });
  });

  test('serializes the first and the last page as they are', () => {
    const emptyPage = {
      total: 0,
      limit: 20,
      offset: 0,
      totalPages: 0,
      currentPage: 1,
      canLoadMore: false,
    };

    assert.deepEqual(serialize(pagination, PAGINATION), PAGINATION);
    assert.deepEqual(serialize(pagination, emptyPage), emptyPage);
  });
});

describe('validation', () => {
  test('declares the four fields of an entry and the schema of dev mode', () => {
    assert.equal(validation.type, 'array');
    assert.deepEqual(Object.keys(validation.items.properties), ['column', 'columnValue', 'operator', 'operatorValue', 'schema']);
  });

  test('keeps an operatorValue in every form the error handler builds: a primitive, null, a list of them', () => {
    const stringify = fastJson(validation);
    const values = ['email', '5', 'true', 18, 0, 1.5, true, false, null, ['admin', 'user'], [1, null, true], []];

    values.forEach((operatorValue) => {
      const entries = [{
        column: 'role',
        columnValue: 'x',
        operator: 'enum',
        operatorValue,
      }];

      assert.deepEqual(JSON.parse(stringify(entries)), entries, JSON.stringify(operatorValue));
    });
  });
});

describe('successEnvelope', () => {
  test('drops the data fields the schema does not declare', () => {
    const body = serialize(successEnvelope(ITEM_SCHEMA), createEnvelope({ data: ITEM_ROW, requestId: REQUEST_ID }));

    assert.deepEqual(body, { status: 'success', data: ITEM, meta: { requestId: REQUEST_ID } });
  });

  test('leaves out the sections that are absent', () => {
    const body = serialize(successEnvelope(ITEM_SCHEMA), createEnvelope({ data: ITEM }));

    assert.deepEqual(body, { status: 'success', data: ITEM });
  });

  test('keeps the message of a success', () => {
    const body = serialize(successEnvelope(ITEM_SCHEMA), createEnvelope({ data: ITEM, message: 'User created', requestId: REQUEST_ID }));

    assert.deepEqual(body, {
      status: 'success',
      message: 'User created',
      data: ITEM,
      meta: { requestId: REQUEST_ID },
    });
  });

  test('lets through neither the code of an error nor the sections of a list', () => {
    const envelope = createEnvelope({
      data: ITEM,
      pagination: PAGINATION,
      sort: SORT,
      filters: [FILTER],
      validation: VALIDATION,
      requestId: REQUEST_ID,
    });
    const body = serialize(successEnvelope(ITEM_SCHEMA), { ...envelope, code: 'NO_CHANGES' });

    assert.deepEqual(body, { status: 'success', data: ITEM, meta: { requestId: REQUEST_ID } });
  });

  test('writes null for data declared as null or as nullable', () => {
    const nullable = { ...ITEM_SCHEMA, type: ['object', 'null'] };

    assert.deepEqual(serialize(successEnvelope({ type: 'null' }), createEnvelope()), { status: 'success', data: null });
    assert.deepEqual(serialize(successEnvelope(nullable), createEnvelope()), { status: 'success', data: null });
    assert.deepEqual(serialize(successEnvelope(nullable), createEnvelope({ data: ITEM_ROW })), { status: 'success', data: ITEM });
  });

  test('takes any typed data: a scalar, an array of rows', () => {
    const rows = { type: 'array', items: ITEM_SCHEMA };

    assert.deepEqual(serialize(successEnvelope({ type: 'integer' }), createEnvelope({ data: 42 })), { status: 'success', data: 42 });
    assert.deepEqual(serialize(successEnvelope(rows), createEnvelope({ data: [ITEM_ROW] })), { status: 'success', data: [ITEM] });
  });

  test('writes the sections in the order of the response format', () => {
    const envelope = createEnvelope({ data: ITEM, message: 'User created', requestId: REQUEST_ID });
    const body = serialize(successEnvelope(ITEM_SCHEMA), reverseKeys(envelope));

    assert.deepEqual(Object.keys(body), ['status', 'message', 'data', 'meta']);
  });
});

describe('listEnvelope', () => {
  test('serializes the rows with pagination, sort and filters', () => {
    const envelope = createEnvelope({
      data: [ITEM],
      pagination: PAGINATION,
      sort: SORT,
      filters: [FILTER],
      requestId: REQUEST_ID,
    });

    assert.deepEqual(serialize(listEnvelope(ITEM_SCHEMA), envelope), {
      status: 'success',
      data: [ITEM],
      pagination: PAGINATION,
      sort: SORT,
      filters: [FILTER],
      meta: { requestId: REQUEST_ID },
    });
  });

  test('drops what the schema does not declare, in the rows and in every section', () => {
    const envelope = createEnvelope({
      data: [ITEM_ROW],
      pagination: { ...PAGINATION, countSql: 'SELECT COUNT(*) FROM users' },
      sort: SORT.map((entry) => ({ ...entry, orderBy: 'created_at DESC, id DESC' })),
      filters: [{
        ...FILTER,
        column: 'u.status',
        options: FILTER.options.map((option) => ({ ...option, rowsCount: 7 })),
      }],
      requestId: REQUEST_ID,
    });

    assert.deepEqual(serialize(listEnvelope(ITEM_SCHEMA), envelope), {
      status: 'success',
      data: [ITEM],
      pagination: PAGINATION,
      sort: SORT,
      filters: [FILTER],
      meta: { requestId: REQUEST_ID },
    });
  });

  test('leaves out the sections that are absent, never the rows', () => {
    assert.deepEqual(serialize(listEnvelope(ITEM_SCHEMA), createEnvelope({ data: [] })), { status: 'success', data: [] });
  });

  test('keeps a filter value of every primitive type', () => {
    const stringify = fastJson(listEnvelope(ITEM_SCHEMA));
    const values = ['active', '', '42', 'true', 'null', 42, 0, 1.5, true, false, null];

    values.forEach((value) => {
      const envelope = createFilterList(value);

      assert.deepEqual(JSON.parse(stringify(envelope)), envelope, JSON.stringify(value));
    });
  });

  test('keeps the values of a multiple filter an array', () => {
    const stringify = fastJson(listEnvelope(ITEM_SCHEMA));
    const values = [['active', 'blocked'], [1, 2], [true, null], []];

    values.forEach((value) => {
      const envelope = createFilterList(value);

      assert.deepEqual(JSON.parse(stringify(envelope)), envelope, JSON.stringify(value));
    });
  });

  test('refuses a filter value that holds an object instead of writing its fields', () => {
    const stringify = fastJson(listEnvelope(ITEM_SCHEMA));

    assert.throws(() => stringify(createFilterList([{ id: 1 }])), TypeError);
  });

  test('keeps an option value of every primitive type', () => {
    const stringify = fastJson(listEnvelope(ITEM_SCHEMA));
    const values = ['active', '42', 42, 0, true, false, null];
    const envelope = createEnvelope({
      data: [],
      filters: [{
        ...FILTER,
        options: values.map((value) => ({
          label: String(value),
          value,
          isChecked: false,
          isDisabled: false,
        })),
      }],
    });

    assert.deepEqual(JSON.parse(stringify(envelope)), envelope);
  });

  test('serializes a filter that has no options', () => {
    const filter = {
      type: 'text',
      name: 'firstName',
      label: 'Name',
      isMultiple: false,
      isDisabled: false,
      value: 'Ann',
    };
    const envelope = createEnvelope({ data: [], filters: [filter] });

    assert.deepEqual(serialize(listEnvelope(ITEM_SCHEMA), envelope), envelope);
  });

  test('writes the sections in the order of the response format', () => {
    const envelope = createEnvelope({
      data: [ITEM],
      message: 'Users',
      pagination: PAGINATION,
      sort: SORT,
      filters: [FILTER],
      requestId: REQUEST_ID,
    });
    const body = serialize(listEnvelope(ITEM_SCHEMA), reverseKeys(envelope));

    assert.deepEqual(Object.keys(body), ['status', 'message', 'data', 'pagination', 'sort', 'filters', 'meta']);
  });
});

describe('errorEnvelope', () => {
  test('lists every code of the catalogue and nothing else', () => {
    assert.deepEqual([...errorEnvelope.properties.code.enum].sort(), Object.values(ERROR_CODE).sort());
  });

  test('serializes a 422 as the error handler builds it', () => {
    const envelope = createEnvelope({
      code: ERROR_CODE.VALIDATION_ERROR,
      message: 'Validation error',
      validation: [...VALIDATION, UNTYPED_ROOT],
      requestId: REQUEST_ID,
    });

    assert.deepEqual(serialize(errorEnvelope, envelope), envelope);
  });

  test('keeps the raw schema error that dev mode adds to an entry', () => {
    const envelope = createEnvelope({
      code: ERROR_CODE.VALIDATION_ERROR,
      message: 'Validation error',
      validation: [
        ...VALIDATION.map((entry) => ({ ...entry, schema: AJV_ERROR })),
        { ...UNTYPED_ROOT, schema: { ...AJV_ERROR, params: {} } },
      ],
      requestId: REQUEST_ID,
    });

    assert.deepEqual(serialize(errorEnvelope, envelope), envelope);
  });

  test('keeps a limit of 0 and a text that looks like a number or a boolean', () => {
    const envelope = createEnvelope({
      code: ERROR_CODE.VALIDATION_ERROR,
      validation: ['0', '42', 'true', 'null', 0].map((columnValue) => ({
        column: 'amount',
        columnValue,
        operator: 'exclusiveMinimum',
        operatorValue: 0,
      })),
    });

    assert.deepEqual(serialize(errorEnvelope, envelope), envelope);
  });

  test('serializes a 500 with the stack that dev mode puts into meta', () => {
    const envelope = createEnvelope({
      code: ERROR_CODE.SERVER_ERROR,
      message: 'connect ECONNREFUSED',
      requestId: REQUEST_ID,
      stack: STACK,
    });

    assert.deepEqual(serialize(errorEnvelope, envelope), envelope);
    assert.deepEqual(envelope.meta, { requestId: REQUEST_ID, stack: STACK });
  });

  test('leaves out the sections that are absent', () => {
    const envelope = createEnvelope({ code: ERROR_CODE.NOT_FOUND_ERROR, message: 'Not found' });

    assert.deepEqual(serialize(errorEnvelope, envelope), { status: 'error', code: 'NOT_FOUND_ERROR', message: 'Not found' });
  });

  test('writes the sections in the order of the response format', () => {
    const envelope = createEnvelope({
      code: ERROR_CODE.VALIDATION_ERROR,
      message: 'Validation error',
      validation: VALIDATION,
      requestId: REQUEST_ID,
    });
    const body = serialize(errorEnvelope, reverseKeys(envelope));

    assert.deepEqual(Object.keys(body), ['status', 'code', 'message', 'validation', 'meta']);
    assert.deepEqual(Object.keys(body.validation[0]), ['column', 'columnValue', 'operator', 'operatorValue']);
  });

  test('changes nothing in what the error handler sends when a route declares it', async (t) => {
    const fastify = await buildTestApp({ env: { APP_MODE: 'dev' } });
    t.after(() => fastify.close());

    const body = {
      type: 'object',
      required: ['email', 'nickname'],
      properties: {
        email: email(),
        age: { type: 'integer', minimum: 18 },
        role: { type: 'string', enum: ['admin', 'user'] },
        isAccepted: { type: 'boolean', const: true },
        password: { type: 'string', minLength: 8 },
        tags: { type: 'array', items: { type: 'string' } },
      },
    };
    const invalid = {
      email: 'abc',
      age: 17,
      role: 'guest',
      isAccepted: false,
      password: 'short',
      tags: { first: 'x' },
    };

    async function createUser(request, reply) {
      if (request.body.role === 'admin') {
        throw new Error('connect ECONNREFUSED');
      }

      return reply.created(ITEM);
    }

    fastify.post('/api/plain', {
      schema: { body, response: { 201: successEnvelope(ITEM_SCHEMA) } },
      security: PUBLIC,
    }, createUser);
    fastify.post('/api/declared', {
      schema: { body, response: { 201: successEnvelope(ITEM_SCHEMA), 422: errorEnvelope, 500: errorEnvelope } },
      security: PUBLIC,
    }, createUser);

    function post(url, payload) {
      return fastify.inject({ method: 'POST', url, payload });
    }

    const [plainInvalid, declaredInvalid, plainBroken, declaredBroken] = await Promise.all([
      post('/api/plain', invalid),
      post('/api/declared', invalid),
      post('/api/plain', { email: 'anna@example.com', nickname: 'anna', role: 'admin' }),
      post('/api/declared', { email: 'anna@example.com', nickname: 'anna', role: 'admin' }),
    ]);

    const operators = declaredInvalid.json().validation.map((entry) => entry.operator);

    assert.equal(declaredInvalid.statusCode, 422);
    assert.deepEqual(operators.sort(), ['const', 'enum', 'format', 'minLength', 'minimum', 'required', 'type']);
    assert.equal(typeof declaredInvalid.json().validation[0].schema.schemaPath, 'string');
    assert.deepEqual(withoutRequestId(declaredInvalid.json()), withoutRequestId(plainInvalid.json()));

    assert.equal(declaredBroken.statusCode, 500);
    assert.match(declaredBroken.json().meta.stack, /connect ECONNREFUSED/);
    assert.deepEqual(withoutRequestId(declaredBroken.json()), withoutRequestId(plainBroken.json()));
  });
});

describe('envelopes', () => {
  test('mark no field as required: a missing section must not fail the serializer', () => {
    const schemas = [successEnvelope(ITEM_SCHEMA), listEnvelope(ITEM_SCHEMA), errorEnvelope, pagination, validation];

    schemas.forEach((schema) => assert.equal(collectKeys(schema).includes('required'), false));
    assert.deepEqual(serialize(successEnvelope(ITEM_SCHEMA), {}), {});
    assert.deepEqual(serialize(listEnvelope(ITEM_SCHEMA), {}), {});
    assert.deepEqual(serialize(errorEnvelope, {}), {});
  });

  test('are deep-frozen wherever routes share them: a route that writes into one must not change the others', () => {
    const list = listEnvelope(ITEM_SCHEMA).properties;
    const shared = [
      errorEnvelope,
      pagination,
      validation,
      primitiveOrList,
      PRIMITIVE_TYPES,
      successEnvelope(ITEM_SCHEMA).properties.meta,
      list.pagination,
      list.sort,
      list.filters,
      list.meta,
    ];

    shared.forEach((schema) => assert.equal(isDeepFrozen(schema), true, JSON.stringify(schema)));
  });

  test('pass the route contract when their data is typed', () => {
    const responses = [successEnvelope(ITEM_SCHEMA), successEnvelope({ type: 'null' }), listEnvelope(ITEM_SCHEMA)];

    responses.forEach((response) => assert.doesNotThrow(() => assertRouteContract(createRoute(response))));
  });

  test('fail the route contract when their data is not typed', () => {
    const responses = [successEnvelope(), successEnvelope({}), successEnvelope({ type: 'object' }), listEnvelope(), listEnvelope({}), errorEnvelope];

    responses.forEach((response) => assert.throws(() => assertRouteContract(createRoute(response)), /data/));
  });
});
