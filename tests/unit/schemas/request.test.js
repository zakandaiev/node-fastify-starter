import { PAGINATION } from '#config/pagination.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import {
  enumOf,
  json,
  nullable,
  text,
  uuid,
} from '#schemas/common/field.js';
import { properties as paginationProperties } from '#schemas/common/pagination.js';
import {
  idParam,
  listQuery,
  patchBody,
  pathParams,
  queryParams,
} from '#schemas/common/request.js';
import { freezeDeep } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const CANONICAL_ID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b';

const NON_CANONICAL_IDS = Object.freeze([
  CANONICAL_ID.toUpperCase(),
  CANONICAL_ID.replaceAll('-', ''),
  `urn:uuid:${CANONICAL_ID}`,
  `${CANONICAL_ID}0`,
  CANONICAL_ID.slice(0, -1),
]);

const STATUSES = Object.freeze(['active', 'blocked']);
const DEFAULT_STATUS = 'active';

const FIELDS = freezeDeep({
  name: text('Name', { maxLength: 100 }),
  description: nullable(text('Description')),
  status: { ...enumOf(STATUSES, 'Status'), default: DEFAULT_STATUS },
  profile: nullable(json('Profile')),
});

async function createApp(t) {
  const fastify = await buildTestApp();

  t.after(() => fastify.close());

  return fastify;
}

// The body as the handler gets it: after the validator has dropped, checked and filled what it does.
async function patchAll(t, body, payloads) {
  const fastify = await createApp(t);

  fastify.patch('/items/:id', { schema: { params: idParam('Item id'), body } }, (request) => request.body);

  return Promise.all(payloads.map((payload) => fastify.inject({ method: 'PATCH', url: `/items/${CANONICAL_ID}`, payload })));
}

async function listAll(t, querystring, urls) {
  const fastify = await createApp(t);

  fastify.get('/items', { schema: { querystring } }, (request) => request.query);

  return Promise.all(urls.map((url) => fastify.inject(url)));
}

function readFailures(response) {
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json().code, 'VALIDATION_ERROR');

  return response.json().validation.map(({ column, operator }) => [column, operator]);
}

describe('patchBody', () => {
  test('drops a default at any depth of a field, and keeps a field that is named "default"', () => {
    const settings = {
      type: 'object',
      properties: {
        theme: { type: 'string', maxLength: 10, default: 'light' },
        default: { type: 'boolean', default: false },
        tags: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 10, default: 'new' } },
      },
      default: {},
    };
    const { properties } = patchBody({ settings });

    assert.deepEqual(properties.settings, {
      type: 'object',
      properties: {
        theme: { type: 'string', maxLength: 10 },
        default: { type: 'boolean' },
        tags: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 10 } },
      },
    });
  });

  test('makes every field optional, drops its default and closes the body', () => {
    assert.deepEqual(patchBody(FIELDS), {
      type: 'object',
      properties: {
        name: FIELDS.name,
        description: FIELDS.description,
        status: enumOf(STATUSES, 'Status'),
        profile: FIELDS.profile,
      },
      additionalProperties: false,
    });
  });

  test('takes the fields it is given the names of, in the order of the names', () => {
    const body = patchBody(FIELDS, ['status', 'name']);

    assert.deepEqual(Object.keys(body.properties), ['status', 'name']);
    assert.deepEqual(body.properties.status, enumOf(STATUSES, 'Status'));
  });

  test('leaves the fields it is given as they were', () => {
    const body = patchBody(FIELDS);

    assert.notEqual(body.properties.status, FIELDS.status);
    assert.equal(FIELDS.status.default, DEFAULT_STATUS);
  });

  test('refuses a name that is not a field and a name given twice', () => {
    assert.throws(() => patchBody(FIELDS, ['name', 'nickname']), { name: 'TypeError', message: /"nickname"/ });
    assert.throws(() => patchBody(FIELDS, ['name', 'name']), { name: 'TypeError', message: /twice/ });
  });

  test('refuses fields that are not a map', () => {
    [undefined, null, 'name', ['name']].forEach((properties) => {
      assert.throws(() => patchBody(properties), TypeError, JSON.stringify(properties));
    });
  });
});

describe('patchBody in a route of the app', () => {
  test('drops a key the body does not declare instead of refusing the request', async (t) => {
    const [response] = await patchAll(t, patchBody(FIELDS), [{ name: 'Anna', passwordHash: 'stolen', isSuperadmin: true }]);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { name: 'Anna' });
  });

  test('answers 422 "type" to null for a field that is not nullable, and lets null through for a nullable one', async (t) => {
    const [refused, cleared] = await patchAll(t, patchBody(FIELDS), [{ name: null }, { description: null, profile: null }]);

    assert.equal(refused.statusCode, 422);
    assert.deepEqual(refused.json().validation, [{
      column: 'name',
      columnValue: null,
      operator: 'type',
      operatorValue: 'string',
    }]);
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(cleared.json(), { description: null, profile: null });
  });

  test('answers 422 to a value its field refuses, a number in place of a text among them', async (t) => {
    const [empty, number, unknown] = await patchAll(t, patchBody(FIELDS), [{ name: '' }, { name: 1 }, { status: 'deleted' }]);

    assert.deepEqual(readFailures(empty), [['name', 'minLength']]);
    assert.deepEqual(readFailures(number), [['name', 'type']]);
    assert.deepEqual(readFailures(unknown), [['status', 'enum']]);
  });

  test('applies no default, where a body of the same fields would', async (t) => {
    const fastify = await createApp(t);

    fastify.patch('/items/:id', { schema: { params: idParam(), body: patchBody(FIELDS) } }, (request) => request.body);
    fastify.put('/items/:id', { schema: { params: idParam(), body: { type: 'object', properties: FIELDS } } }, (request) => request.body);

    const [patched, replaced] = await Promise.all(['PATCH', 'PUT'].map((method) => fastify.inject({
      method,
      url: `/items/${CANONICAL_ID}`,
      payload: { name: 'Anna' },
    })));

    assert.deepEqual(patched.json(), { name: 'Anna' });
    assert.deepEqual(replaced.json(), { name: 'Anna', status: DEFAULT_STATUS });
  });
});

describe('idParam', () => {
  test('describes a required canonical id and nothing else', () => {
    assert.deepEqual(idParam(), {
      type: 'object',
      properties: { id: uuid() },
      required: ['id'],
      additionalProperties: false,
    });
  });

  test('gives its description to the id', () => {
    assert.deepEqual(idParam('User id').properties.id, uuid('User id'));
  });

  test('answers 404 to an id that is not canonical, a longer and a shorter one among them, and lets a canonical one through', async (t) => {
    const fastify = await createApp(t);
    const failedParts = [];

    fastify.addHook('onError', async (request, reply, error) => {
      failedParts.push(error.validationContext);
    });
    fastify.get('/items/:id', { schema: { params: idParam('Item id') } }, (request) => request.params);

    const [found, ...missing] = await Promise.all([CANONICAL_ID, ...NON_CANONICAL_IDS].map((id) => fastify.inject(`/items/${id}`)));

    assert.equal(found.statusCode, 200);
    assert.deepEqual(found.json(), { id: CANONICAL_ID });
    assert.deepEqual(missing.map((response) => [response.statusCode, response.json().code]), NON_CANONICAL_IDS.map(() => [404, 'NOT_FOUND_ERROR']));
    assert.deepEqual(failedParts, NON_CANONICAL_IDS.map(() => 'params'));
  });
});

describe('pathParams', () => {
  test('requires every field it gets and closes the path', () => {
    assert.deepEqual(pathParams({ id: uuid('Id'), slug: text('Slug', { maxLength: 64 }) }), {
      type: 'object',
      properties: { id: uuid('Id'), slug: text('Slug', { maxLength: 64 }) },
      required: ['id', 'slug'],
      additionalProperties: false,
    });
  });

  test('refuses what is not a map of fields', () => {
    [undefined, null, [], 'id'].forEach((fields, index) => {
      assert.throws(() => pathParams(fields), { name: 'TypeError', message: /pathParams\(fields\) requires a map of fields/ }, String(index));
    });
  });
});

describe('queryParams', () => {
  test('takes null out of the types and the enum of every field: a query parameter is text', () => {
    const query = queryParams({
      age: nullable({ type: 'integer', minimum: 0 }),
      status: nullable(enumOf(STATUSES)),
      name: text('Name'),
    });

    assert.deepEqual(query, {
      type: 'object',
      properties: {
        age: { type: 'integer', minimum: 0 },
        status: enumOf(STATUSES),
        name: text('Name'),
      },
      additionalProperties: false,
    });
  });

  test('keeps an empty value of a nullable number an error instead of null, in a route of the app', async (t) => {
    const fastify = await createApp(t);

    fastify.get('/items', { schema: { querystring: queryParams({ age: nullable({ type: 'integer' }) }) } }, (request) => request.query);

    const response = await fastify.inject('/items?age=');

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json().validation.map(({ column, operator }) => [column, operator]), [['age', 'type']]);
  });

  test('refuses what is not a map of fields', () => {
    assert.throws(() => queryParams(null), { name: 'TypeError', message: /queryParams\(fields\) requires a map of fields/ });
  });
});

describe('listQuery', () => {
  test('takes null out of the types of the fields it adds, as queryParams does', () => {
    const query = listQuery({ age: nullable({ type: 'integer' }) });

    assert.deepEqual(query.properties.age, { type: 'integer' });
  });

  test('gives the limit and the offset of the pagination schema, and closes the query', () => {
    assert.deepEqual(listQuery(), {
      type: 'object',
      properties: { limit: paginationProperties.limit, offset: paginationProperties.offset },
      additionalProperties: false,
    });
  });

  test('adds the fields of the list after the limit and the offset', () => {
    const query = listQuery({ status: enumOf(STATUSES), name: text('Name') });

    assert.deepEqual(Object.keys(query.properties), ['limit', 'offset', 'status', 'name']);
    assert.deepEqual(query.properties.status, enumOf(STATUSES));
  });

  test('refuses a field that would redefine the limit or the offset', () => {
    ['limit', 'offset'].forEach((name) => {
      assert.throws(() => listQuery({ [name]: { type: 'integer' } }), { name: 'TypeError', message: new RegExp(`"${name}"`) }, name);
    });
  });

  test('refuses fields that are not a map', () => {
    [null, 'status', ['status']].forEach((properties) => {
      assert.throws(() => listQuery(properties), { name: 'TypeError', message: /^listQuery\(/ }, JSON.stringify(properties));
    });
  });
});

describe('listQuery in a route of the app', () => {
  test('fills the limit and the offset with their defaults when the query has neither', async (t) => {
    const [empty, filtered] = await listAll(t, listQuery({ status: enumOf(STATUSES) }), ['/items', '/items?status=blocked']);

    assert.deepEqual(empty.json(), { limit: PAGINATION.defaultLimit, offset: 0 });
    assert.deepEqual(filtered.json(), { status: 'blocked', limit: PAGINATION.defaultLimit, offset: 0 });
  });

  test('reads the limit and the offset as numbers, and drops a parameter the list does not declare', async (t) => {
    const [response] = await listAll(t, listQuery(), ['/items?limit=5&offset=40&sort=name']);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { limit: 5, offset: 40 });
  });

  test('answers 422 to a limit above PAGINATION.maxLimit and to an offset above PAGINATION.maxOffset, and takes both bounds', async (t) => {
    const [limit, offset, bounds] = await listAll(t, listQuery(), [
      `/items?limit=${PAGINATION.maxLimit + 1}`,
      `/items?offset=${PAGINATION.maxOffset + 1}`,
      `/items?limit=${PAGINATION.maxLimit}&offset=${PAGINATION.maxOffset}`,
    ]);

    assert.deepEqual([limit.statusCode, offset.statusCode], [422, 422]);
    assert.deepEqual(limit.json().validation, [{
      column: 'limit',
      columnValue: PAGINATION.maxLimit + 1,
      operator: 'maximum',
      operatorValue: PAGINATION.maxLimit,
    }]);
    assert.deepEqual(offset.json().validation, [{
      column: 'offset',
      columnValue: PAGINATION.maxOffset + 1,
      operator: 'maximum',
      operatorValue: PAGINATION.maxOffset,
    }]);
    assert.deepEqual(bounds.json(), { limit: PAGINATION.maxLimit, offset: PAGINATION.maxOffset });
  });

  test('answers 422 to a limit below 1, a negative offset, a fraction, a word and an infinite number', async (t) => {
    const urls = ['/items?limit=0', '/items?offset=-1', '/items?limit=2.5', '/items?offset=ten', '/items?limit=Infinity', '/items?offset=1e400'];
    const responses = await listAll(t, listQuery(), urls);

    assert.deepEqual(responses.map((response) => readFailures(response)), [
      [['limit', 'minimum']],
      [['offset', 'minimum']],
      [['limit', 'type']],
      [['offset', 'type']],
      [['limit', 'finite']],
      [['offset', 'finite']],
    ]);
  });
});
