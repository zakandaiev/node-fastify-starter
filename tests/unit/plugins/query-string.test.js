import { buildFilter } from '#core/db/filter.js';
import { createSchema } from '#core/schema/create-schema.js';
import { FILTER_OPERATOR, FILTER_TYPE } from '#enums/filter-type.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import * as paginationSchema from '#schemas/common/pagination.js';
import { freezeDeep, pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const STATUSES = Object.freeze(['active', 'blocked']);

const LIST_QUERY = Object.freeze({
  type: 'object',
  properties: {
    status: { type: 'string', enum: STATUSES },
    tags: { type: 'array', items: { type: 'string', enum: STATUSES } },
    name: { type: 'string', maxLength: 20 },
    page: { type: 'integer', minimum: 0 },
    ids: { type: 'array', items: { type: 'integer' } },
  },
});

const ITEM_SCHEMA = freezeDeep({
  properties: {
    rating: { type: 'integer', minimum: 0, maximum: 10 },
    price: { type: 'number', minimum: 0 },
    name: { type: 'string', maxLength: 50 },
  },
  filters: {
    rating: { type: FILTER_TYPE.NUMBER },
    price: { type: FILTER_TYPE.NUMBER, operator: FILTER_OPERATOR.RANGE },
    name: { type: FILTER_TYPE.TEXT },
  },
});

async function startApp(t) {
  const fastify = await buildTestApp();
  t.after(() => fastify.close());

  return fastify;
}

// What the handler sees, and whether it is still the object the request started with.
function declareEchoRoutes(fastify) {
  const startQueries = new WeakMap();

  function readQuery(request) {
    return { query: { ...request.query }, isSame: request.query === startQueries.get(request) };
  }

  function keepStartQuery(request, reply, done) {
    startQueries.set(request, request.query);
    done();
  }

  fastify.get('/items', { schema: { querystring: LIST_QUERY }, onRequest: keepStartQuery }, readQuery);
  fastify.get('/raw', { onRequest: keepStartQuery }, readQuery);
}

// build() requires a success response: the route takes only the query schema of the result.
function declareFilterRoute(fastify) {
  const { querystring } = createSchema(ITEM_SCHEMA, paginationSchema)
    .query(['rating', 'price', 'name', 'limit'])
    .response(HTTP_STATUS.NO_CONTENT)
    .build();

  fastify.get('/filters', { schema: { querystring } }, (request) => ({
    limit: request.query.limit,
    ...pick(buildFilter(ITEM_SCHEMA, request.query), ['condition', 'binding']),
  }));
}

function injectQueries(fastify, url, queries) {
  return Promise.all(queries.map((query) => fastify.inject(`${url}?${query}`)));
}

describe('query-string plugin', () => {
  test('is registered under the name "query-string"', async (t) => {
    const fastify = await startApp(t);

    assert.equal(fastify.hasPlugin('query-string'), true);
  });

  test('drops a parameter sent without a value before validation: "?status=" is a filter left unused, not a 422', async (t) => {
    const fastify = await startApp(t);

    declareEchoRoutes(fastify);

    const responses = await injectQueries(fastify, '/items', ['status=', 'status', 'status=&name=Anna', 'status=evil']);

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 200, 422]);
    assert.deepEqual(responses.slice(0, 3).map((response) => response.json()), [
      { query: {}, isSame: true },
      { query: {}, isSame: true },
      { query: { name: 'Anna' }, isSame: true },
    ]);
  });

  test('drops the empty values of a repeated parameter, and the parameter when no value is left', async (t) => {
    const fastify = await startApp(t);

    declareEchoRoutes(fastify);

    const responses = await injectQueries(fastify, '/items', [
      'status=&status=active',
      'status=&status=',
      'tags=&tags=active&tags=&tags=blocked',
      'tags=&tags=',
    ]);

    assert.deepEqual(responses.map((response) => response.json()), [
      { query: { status: 'active' }, isSame: true },
      { query: {}, isSame: true },
      { query: { tags: ['active', 'blocked'] }, isSame: true },
      { query: {}, isSame: true },
    ]);
  });

  test('changes request.query in place on a route without a schema too, and keeps every value that is not empty', async (t) => {
    const fastify = await startApp(t);

    declareEchoRoutes(fastify);

    const [response] = await injectQueries(fastify, '/raw', ['status=&name=%20&page=0&flag=false&list=&list=b&list=']);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      query: {
        name: ' ',
        page: '0',
        flag: 'false',
        list: ['b'],
      },
      isSame: true,
    });
  });

  test('drops white space alone sent for a number, as a value and as an item: AJV would read it as 0', async (t) => {
    const fastify = await startApp(t);

    declareEchoRoutes(fastify);

    const responses = await injectQueries(fastify, '/items', [
      'page=%20',
      'page=%09&name=%20',
      'page=%0A&ids=%C2%A0',
      'ids=1&ids=%20&ids=%E2%80%83',
      'page=%207%20&ids=%202',
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 200, 200, 200]);
    assert.deepEqual(responses.map((response) => response.json()), [
      { query: {}, isSame: true },
      { query: { name: ' ' }, isSame: true },
      { query: {}, isSame: true },
      { query: { ids: [1] }, isSame: true },
      { query: { page: 7, ids: [2] }, isSame: true },
    ]);
  });

  test('leaves a number filter sent as white space unused and gives a blank limit its default, while a text search keeps its space', async (t) => {
    const fastify = await startApp(t);

    declareFilterRoute(fastify);

    const responses = await injectQueries(fastify, '/filters', [
      'rating=%20',
      'priceFrom=%20&priceTo=%09',
      'limit=%20',
      'name=%20',
      'rating=%205%20&priceFrom=%C2%A0&priceTo=9.5',
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 200, 200, 200]);
    assert.deepEqual(responses.map((response) => response.json()), [
      { limit: 20, condition: null, binding: {} },
      { limit: 20, condition: null, binding: {} },
      { limit: 20, condition: null, binding: {} },
      { limit: 20, condition: 'name LIKE :filter_name', binding: { filter_name: '% %' } },
      { limit: 20, condition: 'rating = :filter_rating AND price <= :filter_priceTo', binding: { filter_rating: 5, filter_priceTo: 9.5 } },
    ]);
  });
});
