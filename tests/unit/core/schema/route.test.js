import {
  dropSchemaMarkers,
  isJsonField,
  readDocumentedSchema,
  rememberSourceSchema,
} from '#core/schema/docs.js';
import { assertRouteContract, AUTH_DECORATOR, createRouteHook } from '#core/schema/route.js';
import { pingSchema } from '#root/src/routes/v1/system/controller.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { errorEnvelope, listEnvelope, successEnvelope } from '#schemas/common/envelope.js';
import { json, nullable } from '#schemas/common/field.js';
import { freezeDeep } from '#utils/object.js';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import symbols from 'fastify/lib/symbols.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PREFIXES = Object.freeze({ apiPrefix: '/api', healthPrefix: '/health' });
const PUBLIC = Object.freeze({ auth: false });
const GUARDED = Object.freeze({ auth: true });

const NO_SECURITY = /GET \/api\/v1\/items\b.*security/;
const NO_RESPONSE = /GET \/api\/v1\/items\b.*response/;
const NO_TYPED_DATA = /GET \/api\/v1\/items\b.*data/;
const OUT_OF_REACH = 'has security: { auth: true } and is out of reach of the auth plugin, which guards what is declared after it, in scopes opened after it';

// The nested object matters: a schema the serializer merges wrongly filters the row itself and writes what is under it whole.
const ROW = Object.freeze({
  id: 1,
  name: 'Anna',
  passwordHash: 'row-secret',
  owner: Object.freeze({ id: 2, name: 'Olha', passwordHash: 'row-secret' }),
});
const FILTERED_ROW = Object.freeze({ id: 1, name: 'Anna' });
const LEAK = /row-secret/;

const CODE_PATTERN = '^[a-z]+$';
const LONG_CODE = 'A'.repeat(1000);
const TEXT_LIMIT_MESSAGE = 'a request string with a pattern or a format needs a length limit';

// What json() leaves for the API docs once its marker is gone.
const FREE_JSON = Object.freeze({ type: 'object', additionalProperties: true });

function createItem() {
  return { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } };
}

function createCodeQuery() {
  return {
    type: 'object',
    properties: {
      code: { type: 'string', maxLength: 5, pattern: CODE_PATTERN },
      limit: { type: 'integer' },
    },
  };
}

function createUngatedBody() {
  return { type: 'object', properties: { code: { type: 'string', pattern: CODE_PATTERN } } };
}

function readErrors(response) {
  return response.json().validation.map(({ column, operator, operatorValue }) => ({ column, operator, operatorValue }));
}

function createRoute(overrides = {}) {
  return {
    method: 'GET',
    url: '/api/v1/items',
    schema: { response: { 200: successEnvelope(createItem()) } },
    security: PUBLIC,
    ...overrides,
  };
}

function createResponseRoute(response) {
  return createRoute({ schema: { response } });
}

function createDataRoute(data) {
  return createResponseRoute({ 200: successEnvelope(data) });
}

function assertAccepted(responses) {
  Object.entries(responses).forEach(([name, response]) => {
    assert.doesNotThrow(() => assertRouteContract(createResponseRoute(response)), name);
  });
}

function assertRefused(responses, reason) {
  Object.entries(responses).forEach(([name, response]) => {
    assert.throws(() => assertRouteContract(createResponseRoute(response)), reason, name);
  });
}

function assertTyped(shapes) {
  Object.entries(shapes).forEach(([name, data]) => {
    assert.doesNotThrow(() => assertRouteContract(createDataRoute(data)), name);
  });
}

function assertUntyped(shapes) {
  Object.entries(shapes).forEach(([name, data]) => {
    assert.throws(() => assertRouteContract(createDataRoute(data)), NO_TYPED_DATA, name);
  });
}

async function createApp(t, overrides) {
  const fastify = await buildTestApp(overrides);

  t.after(() => fastify.close());

  return fastify;
}

function createAppWithoutPlugins(t) {
  const fastify = Fastify();

  t.after(() => fastify.close());
  fastify.addHook('onRoute', createRouteHook(PREFIXES));

  return fastify;
}

function readRow(request, reply) {
  return reply.ok(ROW);
}

// A route the contract refuses cannot leak anything: null stands for it and counts as filtered.
async function requestRow(t, data) {
  const fastify = await createApp(t);

  try {
    fastify.get('/api/v1/items', { schema: { response: { 200: successEnvelope(data) } }, security: PUBLIC }, readRow);
  } catch {
    return null;
  }

  const response = await fastify.inject('/api/v1/items');

  return response.body;
}

describe('createRouteHook', () => {
  test('requires both prefixes, each with a leading slash and without a trailing one', () => {
    const invalid = [
      undefined,
      {},
      { apiPrefix: '/api' },
      { healthPrefix: '/health' },
      { apiPrefix: '', healthPrefix: '/health' },
      { apiPrefix: '/', healthPrefix: '/health' },
      { apiPrefix: 'api', healthPrefix: '/health' },
      { apiPrefix: '/api/', healthPrefix: '/health' },
      { apiPrefix: '/api', healthPrefix: '' },
      { apiPrefix: '/api', healthPrefix: 'health' },
      { apiPrefix: '/api', healthPrefix: '/health/' },
    ];

    invalid.forEach((prefixes) => {
      assert.throws(() => createRouteHook(prefixes), { name: 'TypeError', message: /createRouteHook/ }, JSON.stringify(prefixes));
    });
  });

  test('returns a hook for valid prefixes', () => {
    assert.equal(typeof createRouteHook(PREFIXES), 'function');
  });

  test('the hook replaces the schema of any route with a guarded copy', () => {
    const schema = freezeDeep({ querystring: { type: 'object', properties: { limit: { type: 'integer' } } } });
    const routeOptions = { method: 'GET', url: '/items', schema };

    createRouteHook(PREFIXES)(routeOptions);

    assert.notEqual(routeOptions.schema, schema);
    assert.equal(Object.isFrozen(routeOptions.schema), false);
    assert.deepEqual(routeOptions.schema, { querystring: { type: 'object', properties: { limit: { type: 'integer', finite: true } } } });
    assert.deepEqual(schema, { querystring: { type: 'object', properties: { limit: { type: 'integer' } } } });
  });

  test('the hook leaves a route without a schema alone', () => {
    const routeOptions = { method: 'GET', url: '/items' };

    createRouteHook(PREFIXES)(routeOptions);

    assert.equal(routeOptions.schema, undefined);
  });

  test('the hook checks the contract under a prefix, on the boundary of a path segment', () => {
    const checkRoute = createRouteHook(PREFIXES);
    const checked = ['/api', '/api/', '/api/v1/items', '/api/v1/items/:id', '/health', '/health/ready'];
    const free = ['/', '/items', '/apiary/x', '/api-docs', '/apis', '/healthz', '/health-check', '/v1/api/items', '/docs/health'];

    checked.forEach((url) => assert.throws(() => checkRoute({ method: 'GET', url }), /security/, url));
    free.forEach((url) => assert.doesNotThrow(() => checkRoute({ method: 'GET', url }), url));
  });

  test('the hook accepts a valid route under a prefix and guards its schema as well', () => {
    const response = { 200: successEnvelope(createItem()) };
    const params = { type: 'object', properties: { id: { type: 'integer' } } };
    const routeOptions = createRoute({ url: '/api/v1/items/:id', schema: { params, response } });

    createRouteHook(PREFIXES)(routeOptions);

    assert.deepEqual(routeOptions.schema.params, { type: 'object', properties: { id: { type: 'integer', finite: true } } });
    assert.equal(routeOptions.schema.response, response);
    assert.deepEqual(params, { type: 'object', properties: { id: { type: 'integer' } } });
  });

  test('the hook uses the prefixes it was created with', () => {
    const checkRoute = createRouteHook({ apiPrefix: '/internal', healthPrefix: '/status' });

    assert.throws(() => checkRoute({ method: 'GET', url: '/internal/items' }), /security/);
    assert.throws(() => checkRoute({ method: 'GET', url: '/status' }), /security/);
    assert.doesNotThrow(() => checkRoute({ method: 'GET', url: '/api/items' }));
    assert.doesNotThrow(() => checkRoute({ method: 'GET', url: '/health' }));
  });

  test('the hook refuses a route with security.auth: true on an instance the auth plugin has not reached, under a prefix or not, and names it with every method', (t) => {
    const fastify = createAppWithoutPlugins(t);
    const { schema } = createRoute();

    assert.throws(
      () => fastify.get('/api/v1/items', { schema, security: GUARDED }, readRow),
      { name: 'Error', message: `Route GET /api/v1/items ${OUT_OF_REACH}` },
    );
    assert.throws(
      () => fastify.get('/items', { security: { auth: true, scopes: ['items:read'] } }, readRow),
      { name: 'Error', message: `Route GET /items ${OUT_OF_REACH}` },
    );
    assert.throws(
      () => fastify.route({
        method: ['PUT', 'PATCH'], url: '/items/:id', security: GUARDED, handler: readRow,
      }),
      { name: 'Error', message: `Route PUT,PATCH /items/:id ${OUT_OF_REACH}` },
    );
    assert.deepEqual(['/api/v1/items', '/items'].map((url) => fastify.hasRoute({ method: 'GET', url })), [false, false]);
  });

  test('the hook refuses one beside a plugin that has the name of the auth plugin, and gives requests a user as it does', async (t) => {
    const fastify = createAppWithoutPlugins(t);

    await fastify.register(fp(async (instance) => {
      instance.decorateRequest('user', null);
    }, { name: 'auth' }));

    assert.throws(() => fastify.get('/items', { security: GUARDED }, readRow), { message: `Route GET /items ${OUT_OF_REACH}` });
  });

  test('the hook takes a public route there and one without security outside the prefixes, and one with security.auth: true behind the auth plugin', (t) => {
    const fastify = createAppWithoutPlugins(t);
    const { schema } = createRoute();

    fastify.get('/api/v1/public', { schema, security: PUBLIC }, readRow);
    fastify.get('/public', { security: PUBLIC }, readRow);
    fastify.get('/plain', readRow);
    fastify.decorateRequest(AUTH_DECORATOR, null);
    fastify.get('/api/v1/items', { schema, security: GUARDED }, readRow);
    fastify.get('/items', { security: GUARDED }, readRow);

    const urls = ['/api/v1/public', '/public', '/plain', '/api/v1/items', '/items'];

    assert.deepEqual(urls.filter((url) => ['GET', 'HEAD'].every((method) => fastify.hasRoute({ method, url }))), urls);
  });

  test('the hook called without an instance looks for no auth plugin: it checks the rest of the contract', () => {
    const checkRoute = createRouteHook(PREFIXES);

    assert.doesNotThrow(() => checkRoute(createRoute({ security: GUARDED })));
    assert.throws(() => checkRoute(createRoute({ security: GUARDED, schema: undefined })), NO_RESPONSE);
  });

  test('the hook gates the expensive keywords of a request and guards the gated copy', () => {
    const schema = freezeDeep({ querystring: createCodeQuery() });
    const routeOptions = { method: 'GET', url: '/items', schema };

    createRouteHook(PREFIXES)(routeOptions);

    assert.deepEqual(routeOptions.schema, {
      querystring: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            maxLength: 5,
            allOf: [{ if: { maxLength: 5 }, then: { maxLength: 5, pattern: CODE_PATTERN }, finite: true }],
            finite: true,
          },
          limit: { type: 'integer', finite: true },
        },
      },
    });
    assert.deepEqual(schema, { querystring: createCodeQuery() });
  });

  test('the hook names the route, the part and the pointer when the gate refuses a schema, under a prefix or not', () => {
    const checkRoute = createRouteHook(PREFIXES);
    const body = createUngatedBody();
    const routeOptions = { method: 'POST', url: '/items', schema: { body } };
    const ids = { type: 'array', uniqueItems: true, items: { type: 'integer' } };

    assert.throws(() => checkRoute(routeOptions), (error) => {
      assert.equal(error.name, 'Error');
      assert.equal(error.message, `Route POST /items: "body" #/properties/code has "pattern" without "maxLength": ${TEXT_LIMIT_MESSAGE}`);
      assert.equal(error.cause.name, 'TypeError');

      return true;
    });
    assert.equal(routeOptions.schema.body, body);
    assert.throws(
      () => checkRoute(createRoute({ method: ['GET', 'POST'], schema: { querystring: { type: 'object', properties: { ids } } } })),
      {
        message: 'Route GET,POST /api/v1/items: "querystring" #/properties/ids has "uniqueItems" without "maxItems": '
          + 'a request array compared item by item needs a limit',
      },
    );
  });

  test('refuses a header named in upper case wherever a headers schema names one, with the pointer', () => {
    const checkRoute = createRouteHook(PREFIXES);
    const cases = [
      [{ type: 'object', properties: { 'X-Page': { type: 'integer' } } }, '#', 'X-Page'],
      [{ type: 'object', required: ['X-Page'] }, '#', 'X-Page'],
      [{ type: 'object', dependencies: { 'X-Page': ['x-size'] } }, '#', 'X-Page'],
      [{ type: 'object', dependencies: { 'x-page': ['X-Size'] } }, '#', 'X-Size'],
      [{ type: 'object', anyOf: [{ required: ['X-Api-Key'] }, { required: ['authorization'] }] }, '#/anyOf/0', 'X-Api-Key'],
      [{ type: 'object', propertyNames: { not: { enum: ['X-Forwarded-Host'] } } }, '#/propertyNames/not', 'X-Forwarded-Host'],
      [{ type: 'object', propertyNames: { const: 'X-Only' } }, '#/propertyNames', 'X-Only'],
    ];

    cases.forEach(([headers, pointer, name]) => {
      assert.throws(
        () => checkRoute(createRoute({ schema: { headers } })),
        { message: `Route GET /api/v1/items: "headers" ${pointer} names the header "${name}": write it in lower case, "${name.toLowerCase()}", as Node gives it` },
        name,
      );
    });
  });

  test('takes header names in lower case, and a field named "propertyNames" in a body is not a header', () => {
    const checkRoute = createRouteHook(PREFIXES);
    const headers = {
      type: 'object',
      required: ['x-page'],
      properties: { 'x-page': { type: 'integer' } },
      dependencies: { 'x-page': ['x-size'] },
      propertyNames: { not: { enum: ['x-forwarded-host'] } },
    };
    const body = { type: 'object', properties: { propertyNames: { type: 'string', enum: ['Upper'] } } };

    assert.doesNotThrow(() => checkRoute(createRoute({ schema: { ...createRoute().schema, headers, body } })));
  });

  test('refuses a media type of a body in the content form that Fastify would never match: upper case or parameters', () => {
    const checkRoute = createRouteHook(PREFIXES);
    const schema = { type: 'object', properties: { name: { type: 'string', maxLength: 10 } } };

    ['Application/JSON', 'application/json; charset=utf-8', 'multipart/form-data; boundary=x'].forEach((mediaType) => {
      assert.throws(
        () => checkRoute(createRoute({ method: 'POST', schema: { body: { content: { [mediaType]: { schema } } } } })),
        { message: `Route POST /api/v1/items: "body" names the media type "${mediaType}": write it as Fastify matches it, in lower case and without parameters` },
        mediaType,
      );
    });
  });
});

describe('body in the content form', () => {
  const BODY = Object.freeze({
    content: {
      'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 10 } } } },
    },
  });

  async function createBodyApp(t) {
    const fastify = await createApp(t);
    const received = [];

    fastify.post('/items', { schema: { body: BODY } }, (request) => {
      received.push(request.body);

      return { isReceived: true };
    });

    return { fastify, received };
  }

  test('answers 415 to a media type the body does not name, and to a request without a body, before the handler', async (t) => {
    const { fastify, received } = await createBodyApp(t);
    const [text, empty] = await Promise.all([
      fastify.inject({
        method: 'POST', url: '/items', payload: 'name', headers: { 'content-type': 'text/plain' },
      }),
      fastify.inject({ method: 'POST', url: '/items' }),
    ]);

    [text, empty].forEach((response) => {
      assert.equal(response.statusCode, 415);
      assert.equal(response.json().code, 'UNSUPPORTED_MEDIA_TYPE_ERROR');
    });
    assert.deepEqual(received, []);
  });

  test('validates a body under a media type it names, with or without parameters in the request', async (t) => {
    const { fastify, received } = await createBodyApp(t);
    const [valid, withCharset, invalid] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/items', payload: { name: 'Anna' } }),
      fastify.inject({
        method: 'POST', url: '/items', payload: '{"name":"Anna"}', headers: { 'content-type': 'Application/JSON; charset=utf-8' },
      }),
      fastify.inject({ method: 'POST', url: '/items', payload: {} }),
    ]);

    assert.deepEqual([valid.statusCode, withCharset.statusCode, invalid.statusCode], [200, 200, 422]);
    assert.deepEqual(invalid.json().validation.map(({ column, operator }) => ({ column, operator })), [{ column: 'name', operator: 'required' }]);
    assert.deepEqual(received, [{ name: 'Anna' }, { name: 'Anna' }]);
  });

  test('keeps the preValidation hooks the route brings, after its own check', async (t) => {
    const fastify = await createApp(t);
    const calls = [];

    fastify.post('/items', {
      schema: { body: BODY },
      preValidation: async () => {
        calls.push('route');
      },
    }, () => ({ isReceived: true }));

    const [declared, undeclared] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/items', payload: { name: 'Anna' } }),
      fastify.inject({
        method: 'POST', url: '/items', payload: 'name', headers: { 'content-type': 'text/plain' },
      }),
    ]);

    assert.deepEqual([declared.statusCode, undeclared.statusCode], [200, 415]);
    assert.deepEqual(calls, ['route']);
  });
});

describe('assertRouteContract: security', () => {
  test('accepts a route that says whether it needs authentication', () => {
    assert.doesNotThrow(() => assertRouteContract(createRoute({ security: { auth: false } })));
    assert.doesNotThrow(() => assertRouteContract(createRoute({ security: { auth: true } })));
    assert.doesNotThrow(() => assertRouteContract(createRoute({ security: { auth: true, scopes: ['items:read'] } })));
  });

  test('refuses a route that does not have the security option at all', () => {
    const routeOptions = {
      method: 'GET',
      url: '/api/v1/items',
      schema: { response: { 200: successEnvelope(createItem()) } },
    };

    assert.throws(() => assertRouteContract(routeOptions), NO_SECURITY);
  });

  test('refuses security that is not a plain object with a boolean auth', () => {
    const invalid = [undefined, null, true, false, 'none', [], [{ auth: false }], {}, { scopes: ['items:read'] }, { auth: 'no' }, { auth: 1 }, { auth: null }];

    invalid.forEach((security) => {
      assert.throws(() => assertRouteContract(createRoute({ security })), NO_SECURITY, JSON.stringify(security));
    });
  });

  test('names the route in the message, with every method of a route declared for several', () => {
    const routeOptions = createRoute({ method: ['GET', 'POST'], url: '/api/v1/orders/:id' });

    assert.throws(() => assertRouteContract({ ...routeOptions, security: undefined }), /GET\W+POST \/api\/v1\/orders\/:id\b.*security/);
    assert.throws(() => assertRouteContract({ ...routeOptions, schema: undefined }), /GET\W+POST \/api\/v1\/orders\/:id\b.*response/);
    assert.throws(() => assertRouteContract({ ...routeOptions, schema: { response: { 201: successEnvelope({}) } } }), /GET\W+POST \/api\/v1\/orders\/:id\b.*data/);
  });
});

describe('assertRouteContract: response', () => {
  test('refuses a route without a schema, without a response or with an empty one', () => {
    const schemas = [undefined, null, {}, { response: undefined }, { response: null }, { response: {} }];

    schemas.forEach((schema) => {
      assert.throws(() => assertRouteContract(createRoute({ schema })), NO_RESPONSE, JSON.stringify(schema));
    });
  });

  test('does not take default or an error status for a response of the route', () => {
    const typed = successEnvelope(createItem());

    assertRefused({
      'default only': { default: typed },
      '404 only': { 404: typed },
      '4xx and 500': { '4xx': typed, 500: typed },
      'default and 422': { default: typed, 422: typed },
      '1xx only': { 101: typed },
    }, NO_RESPONSE);
  });

  test('accepts a route that only redirects', () => {
    assertAccepted({
      302: { 302: {} },
      '3xx': { '3xx': {} },
      '3XX': { '3XX': { type: 'null' } },
      'a redirect next to an error': { 302: {}, 404: errorEnvelope },
    });
  });

  test('accepts a route that only answers 204', () => {
    assertAccepted({
      'an empty schema': { 204: {} },
      null: { 204: { type: 'null' } },
    });
  });

  test('checks 200 and not 204 when a route declares both', () => {
    assertAccepted({ 'typed 200': { 200: successEnvelope(createItem()), 204: {} } });
    assertRefused({ 'untyped 200': { 200: successEnvelope({}), 204: { type: 'null' } } }, NO_TYPED_DATA);
  });

  test("takes '2xx' in either case for a success entry", () => {
    assertAccepted({
      '2xx': { '2xx': successEnvelope(createItem()) },
      '2XX': { '2XX': successEnvelope(createItem()) },
    });
    assertRefused({
      '2xx': { '2xx': successEnvelope({}) },
      '2XX': { '2XX': successEnvelope({}) },
    }, NO_TYPED_DATA);
  });

  test('checks every success entry, not only the first one', () => {
    const typed = successEnvelope(createItem());
    const untyped = successEnvelope({});

    assertRefused({
      '201 after 200': { 200: typed, 201: untyped },
      '200 before 2xx': { 200: untyped, '2xx': typed },
      '2xx after 200': { 200: typed, '2xx': untyped },
      '200 next to a redirect': { 200: untyped, 302: {} },
    }, NO_TYPED_DATA);
  });

  test('does not look at what other statuses declare next to a typed success', () => {
    assertAccepted({
      'error statuses': { 200: successEnvelope(createItem()), 404: errorEnvelope, 422: errorEnvelope },
      'an untyped default': { 200: successEnvelope(createItem()), default: {} },
      'a redirect': { 201: successEnvelope(createItem()), 303: {} },
    });
  });
});

describe('assertRouteContract: typed data', () => {
  test('refuses a success entry that does not declare data', () => {
    assertRefused({
      'no data among the properties': { 200: { type: 'object', properties: { status: { type: 'string' } } } },
      'no properties': { 200: { type: 'object' } },
      'an empty schema': { 200: {} },
      true: { 200: true },
    }, NO_TYPED_DATA);
  });

  test('refuses data that is an empty schema, true or not a schema', () => {
    assertUntyped({
      'an empty schema': {},
      true: true,
      null: null,
      'a type name': 'object',
    });
  });

  test('refuses an object that does not list its properties', () => {
    assertUntyped({
      'no properties': { type: 'object' },
      'nullable, no properties': { type: ['object', 'null'] },
      'closed, no properties': { type: 'object', additionalProperties: false },
      'an open dictionary': { type: 'object', additionalProperties: true },
      'properties left open': { type: 'object', properties: { id: { type: 'integer' } }, additionalProperties: true },
      'a dictionary of anything': { type: 'object', additionalProperties: {} },
      'a pattern of anything': { type: 'object', patternProperties: { '^meta_': {} } },
    });
  });

  test('refuses an array without typed items', () => {
    assertUntyped({
      'no items': { type: 'array' },
      'nullable, no items': { type: ['array', 'null'] },
      'items of anything': { type: 'array', items: {} },
      'items: true': { type: 'array', items: true },
      'items that do not list their properties': { type: 'array', items: { type: 'object' } },
    });
  });

  test('refuses an untyped schema however deep it is nested', () => {
    assertUntyped({
      'a property': { type: 'object', properties: { id: { type: 'integer' }, details: {} } },
      'a property of a property': { type: 'object', properties: { owner: { type: 'object', properties: { settings: { type: 'object' } } } } },
      'the items of a property': { type: 'object', properties: { tags: { type: 'array' } } },
      'a property of an item': { type: 'array', items: { type: 'object', properties: { payload: {} } } },
      'a value of a dictionary': { type: 'object', additionalProperties: { type: 'object', additionalProperties: true } },
      'a branch of a property': { type: 'object', properties: { owner: { anyOf: [{ type: 'null' }, {}] } } },
    });
  });

  test('refuses a $ref: the hook does not see what it points to', () => {
    assertUntyped({
      data: { $ref: 'item#' },
      'a property': { type: 'object', properties: { owner: { $ref: 'user#' } } },
      'the items': { type: 'array', items: { $ref: '#/definitions/item' } },
    });
  });

  test('refuses anyOf, oneOf and allOf with an untyped branch or without branches', () => {
    ['anyOf', 'oneOf', 'allOf'].forEach((keyword) => {
      assertUntyped({
        [`${keyword} with an empty branch`]: { [keyword]: [createItem(), {}] },
        [`${keyword} with a branch that lists no properties`]: { [keyword]: [createItem(), { type: 'object' }] },
        [`${keyword} without branches`]: { [keyword]: [] },
        [`${keyword} that is not a list`]: { [keyword]: createItem() },
      });
    });
  });

  test('accepts an object that lists its properties', () => {
    assertTyped({
      flat: createItem(),
      nested: { type: 'object', properties: { id: { type: 'integer' }, owner: { type: 'object', properties: { settings: createItem() } } } },
      nullable: { type: ['object', 'null'], properties: { id: { type: 'integer' } } },
      closed: { type: 'object', properties: { id: { type: 'integer' } }, additionalProperties: false },
      'with required': { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    });
  });

  test('accepts an array with typed items', () => {
    assertTyped({
      'of objects': { type: 'array', items: createItem() },
      'of scalars': { type: 'array', items: { type: 'string' } },
      'of arrays': { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
      nullable: { type: ['array', 'null'], items: createItem() },
    });
  });

  test('accepts a scalar and null', () => {
    assertTyped({
      string: { type: 'string' },
      integer: { type: 'integer' },
      number: { type: 'number' },
      boolean: { type: 'boolean' },
      null: { type: 'null' },
      'a nullable string': { type: ['string', 'null'] },
      'a string with a format': { type: 'string', format: 'date-time' },
      'a string with an enum': { type: 'string', enum: ['active', 'blocked'] },
    });
  });

  test('accepts a const without a type, and an enum only next to a type', () => {
    assertTyped({
      const: { const: 'active' },
      'enum of strings': { type: 'string', enum: ['active', 'blocked'] },
    });
    assertUntyped({
      'enum without a type, which is written as it is': { enum: ['active', 'blocked'] },
    });
  });

  test('refuses an object whose list of properties is empty', () => {
    assertUntyped({
      'no property at all': { type: 'object', properties: {} },
      'no pattern at all': { type: 'object', patternProperties: {} },
    });
  });

  test('accepts anyOf, oneOf and allOf of typed branches', () => {
    const total = { type: 'object', properties: { total: { type: 'integer' } } };

    ['anyOf', 'oneOf', 'allOf'].forEach((keyword) => {
      assertTyped({
        [`${keyword} of two objects`]: { [keyword]: [createItem(), total] },
        [`${keyword} inside a property`]: { type: 'object', properties: { owner: { [keyword]: [createItem(), total] } } },
        [`${keyword} inside the items`]: { type: 'array', items: { [keyword]: [createItem(), total] } },
      });
    });
    assertTyped({
      'anyOf of an object and null': { anyOf: [createItem(), { type: 'null' }] },
      'oneOf of an object and an array of objects': { oneOf: [createItem(), { type: 'array', items: createItem() }] },
    });
  });

  test('accepts a dictionary with typed values and typed patternProperties as a named field, at any depth', () => {
    const labels = { type: 'object', additionalProperties: { type: 'string' } };
    const prices = { type: 'object', patternProperties: { '^price_': { type: 'number' } } };

    assertTyped({
      'a dictionary of strings': { type: 'object', properties: { labels } },
      'a dictionary of objects': { type: 'object', properties: { owners: { type: 'object', additionalProperties: createItem() } } },
      'a pattern': { type: 'object', properties: { prices } },
      'a dictionary in a row of a list': { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, labels } } },
      'a dictionary in a branch': { anyOf: [{ type: 'object', properties: { labels } }, { type: 'null' }] },
    });
  });

  test('refuses a dictionary as data itself, as a row of a list and as a branch of either: it would let every column of its type out', () => {
    assertUntyped({
      'a dictionary of strings': { type: 'object', additionalProperties: { type: 'string' } },
      'a dictionary of objects': { type: 'object', additionalProperties: createItem() },
      'a pattern': { type: 'object', patternProperties: { '^price_': { type: 'number' } } },
      'properties with a typed rest': { type: 'object', properties: { id: { type: 'integer' } }, additionalProperties: { type: 'string' } },
      'a list of dictionaries': { type: 'array', items: { type: 'object', additionalProperties: { type: 'string' } } },
      'a list of lists of patterns': { type: 'array', items: { type: 'array', items: { type: 'object', patternProperties: { '^id$': { type: 'integer' } } } } },
      'a dictionary in a branch': { anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'null' }] },
      'a dictionary under then': { ...createItem(), if: { required: ['id'] }, then: { type: 'object', additionalProperties: { type: 'string' } } },
    });
  });

  test('refuses a dictionary under a named field everywhere json() is refused: as the rows of its list, its branch or a value of a map', () => {
    const labels = { type: 'object', additionalProperties: { type: 'string' } };

    assertUntyped({
      'the rows of a named list': { type: 'object', properties: { rows: { type: 'array', items: labels } } },
      'the rows of a named list of lists': { type: 'object', properties: { rows: { type: 'array', items: { type: 'array', items: labels } } } },
      'a branch of a named field': { type: 'object', properties: { labels: { anyOf: [labels, { type: 'null' }] } } },
      'a value of a map': { type: 'object', properties: { groups: { type: 'object', additionalProperties: labels } } },
      'a row of a list of the data list': listEnvelope({ type: 'object', properties: { children: { type: 'array', items: labels } } }).properties.data,
    });
  });

  test('takes a nullable dictionary as a named field, and refuses a rest that is not a plain object: the serializer reads any value there as a schema', () => {
    class Rest {}
    const rest = Object.assign(new Rest(), { type: 'string' });

    assertTyped({ 'a nullable dictionary': { type: 'object', properties: { labels: { type: ['object', 'null'], additionalProperties: { type: 'string' } } } } });
    assertUntyped({
      'a rest of a class': { type: 'object', properties: { id: { type: 'integer' } }, additionalProperties: rest },
      'a rest of a class in a named field': { type: 'object', properties: { labels: { type: 'object', additionalProperties: rest } } },
    });
  });

  test('accepts the envelopes of schemas/common around typed data and refuses them around untyped', () => {
    assertAccepted({
      successEnvelope: { 200: successEnvelope(createItem()) },
      listEnvelope: { 200: listEnvelope(createItem()) },
    });
    assertRefused({
      'successEnvelope without data': { 200: successEnvelope() },
      'listEnvelope of anything': { 200: listEnvelope({}) },
    }, NO_TYPED_DATA);
  });

  test('checks the schema that holds anyOf, oneOf or allOf, not only its branches', () => {
    assertUntyped({
      'open next to anyOf': { type: 'object', additionalProperties: true, anyOf: [createItem()] },
      'open next to oneOf': { type: 'object', additionalProperties: true, oneOf: [createItem()] },
      'open next to allOf': { type: 'object', additionalProperties: true, allOf: [createItem()] },
      'an untyped property next to anyOf': { type: 'object', properties: { details: {} }, anyOf: [createItem()] },
      'an open pattern next to anyOf': { anyOf: [createItem()], patternProperties: { '^pass': {} } },
      'an open pattern next to oneOf': { oneOf: [createItem()], patternProperties: { '^pass': {} } },
      'a pattern of true next to allOf': { allOf: [createItem()], patternProperties: { '^pass': true } },
      'a dictionary of anything next to allOf': { allOf: [createItem()], additionalProperties: {} },
      'open items next to anyOf': { anyOf: [{ type: 'array', items: createItem() }], items: { type: 'object', additionalProperties: true } },
    });
  });

  test('refuses if, then and else on a schema that is not typed itself: it writes the value alone on one of the roads', () => {
    const condition = { type: 'object', properties: { kind: { const: 'user' } }, required: ['kind'] };

    assertUntyped({
      'if alone': { if: createItem() },
      'then alone': { then: createItem() },
      'else alone': { else: createItem() },
      'if and then': { if: condition, then: createItem() },
      'if and else': { if: createItem(), else: createItem() },
      'then and else without if': { then: createItem(), else: createItem() },
      'all three, each one typed': { if: createItem(), then: createItem(), else: createItem() },
      'a branch that is only if': { allOf: [{ if: createItem() }] },
      'a branch that is only then': { anyOf: [{ then: createItem() }] },
      'a property that is only if': { type: 'object', properties: { owner: { if: createItem() } } },
      'a typed schema with an open then': { ...createItem(), if: condition, then: { type: 'object', additionalProperties: true } },
      'a typed schema with an open else': { ...createItem(), if: condition, else: { type: 'object' } },
    });
  });

  test('accepts a schema that names a type next to its branches, and an "if" that is only a condition', () => {
    const total = { type: 'object', properties: { total: { type: 'integer' } } };

    assertTyped({
      'a type next to allOf': { type: 'object', allOf: [createItem(), total] },
      'a type next to anyOf': { type: 'object', anyOf: [createItem(), total] },
      'typed properties next to oneOf': { type: 'object', properties: { id: { type: 'integer' } }, oneOf: [createItem(), total] },
      'if with required only': { ...createItem(), if: { type: 'object', required: ['id'] }, then: total },
      'if without a type': { ...createItem(), if: { required: ['id'] }, then: total },
      'a typed schema with typed then and else': {
        ...createItem(), if: createItem(), then: total, else: createItem(),
      },
      'a condition next to a list of branches': { anyOf: [createItem()], if: { required: ['id'] }, then: total },
    });
  });

  test('reads data only from an envelope nothing is merged into', () => {
    const open = { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } };
    const envelope = successEnvelope(createItem());

    assertRefused({
      'allOf on the envelope': { 200: { ...envelope, allOf: [open] } },
      'anyOf on the envelope': { 200: { ...envelope, anyOf: [open] } },
      'oneOf on the envelope': { 200: { ...envelope, oneOf: [open] } },
      'then on the envelope': { 200: { ...envelope, if: { type: 'object' }, then: open } },
      'else on the envelope': { 200: { ...envelope, if: { type: 'string' }, else: open } },
      'a $ref next to the properties': { 200: { $ref: 'open-envelope#', properties: { data: createItem() } } },
      'an envelope inside allOf': { 200: { allOf: [envelope] } },
      'allOf inside a media type': { 200: { content: { 'application/json': { schema: { ...envelope, allOf: [open] } } } } },
    }, NO_TYPED_DATA);
    assertAccepted({
      'if alone, which the serializer never merges': { 200: { ...envelope, if: { type: 'object' } } },
    });
  });

  // The closed side of a merge gives "false" for every property only the other side names, and the serializer
  // writes a value under the schema "false" as it is.
  test('refuses additionalProperties: false on or under a schema the serializer merges', () => {
    const closedItem = { ...createItem(), additionalProperties: false };
    const extension = { type: 'object', properties: { owner: createItem() } };

    assertUntyped({
      'allOf of a closed base and an extension': { allOf: [closedItem, extension] },
      'allOf of an extension and a closed base': { allOf: [extension, closedItem] },
      'a closed holder of allOf': { type: 'object', additionalProperties: false, allOf: [createItem()] },
      'a closed holder of anyOf': { type: 'object', additionalProperties: false, anyOf: [extension] },
      'a closed holder of oneOf': { type: 'object', additionalProperties: false, oneOf: [extension] },
      'a closed object with then': { ...closedItem, if: { required: ['id'] }, then: extension },
      'a closed object with else': { ...closedItem, if: { required: ['missing'] }, else: extension },
      'a closed object nested in a branch': { allOf: [{ type: 'object', properties: { owner: closedItem } }, extension] },
      'closed items inside a branch': { anyOf: [{ type: 'array', items: closedItem }] },
      'a nullable closed entity': { anyOf: [closedItem, { type: 'null' }] },
      'a closed dictionary value under a merge': { allOf: [{ type: 'object', additionalProperties: closedItem }] },
    });
    assertTyped({
      'a closed object': closedItem,
      'a closed object above a merge': { ...closedItem, properties: { owner: { anyOf: [createItem(), { type: 'null' }] } } },
      'closed items of a plain array': { type: 'array', items: closedItem },
      'a closed condition, which is never merged': { ...createItem(), if: { type: 'object', additionalProperties: false }, then: createItem() },
    });
  });

  test('says what counts as typed', () => {
    assert.throws(() => assertRouteContract(createDataRoute({ type: 'array' })), {
      name: 'Error',
      message: 'Route GET /api/v1/items has no typed "data" in the response schema of 200: every schema needs a "type", '
        + 'an object also "properties", an array "items"; $ref, {} and additionalProperties: true are not accepted, '
        + 'nor additionalProperties: false on or under anyOf, oneOf, allOf, then and else; '
        + 'a field of free JSON is declared with json(), and json() and a map of keys (patternProperties, a typed additionalProperties) '
        + 'are taken only as the value of a named field',
    });
  });

  test('accepts json() as a named field, in the properties of the items of a list too, and nullable(json())', () => {
    assertTyped({
      'a property': { type: 'object', properties: { id: { type: 'integer' }, profile: json() } },
      'a property with a description': { type: 'object', properties: { meta: json('Free settings') } },
      'a nullable property': { type: 'object', properties: { profile: nullable(json()) } },
      'a property of the items of a list': { type: 'array', items: { type: 'object', properties: { payload: json() } } },
      'a property of a nested object': { type: 'object', properties: { owner: { type: 'object', properties: { settings: json() } } } },
    });
    assertAccepted({ 'a list of items with a json() field': { 200: listEnvelope({ type: 'object', properties: { id: { type: 'integer' }, meta: json() } }) } });
  });

  test('refuses json() as data itself, as the items of a list, as a map of any keys and as a branch', () => {
    assertUntyped({
      'data itself': json(),
      'nullable data itself': nullable(json()),
      'the items of a list': { type: 'array', items: json() },
      additionalProperties: { type: 'object', additionalProperties: json() },
      'additionalProperties next to properties': { type: 'object', properties: { id: { type: 'integer' } }, additionalProperties: json() },
      patternProperties: { type: 'object', patternProperties: { '^meta_': json() } },
      'a branch of data': { anyOf: [json(), { type: 'null' }] },
      'a branch of a property': { type: 'object', properties: { profile: { anyOf: [json(), { type: 'null' }] } } },
    });
    assertRefused({ 'a list of json()': { 200: listEnvelope(json()) } }, NO_TYPED_DATA);
  });

  test('requires the options of a route', () => {
    [undefined, null, 'GET /api/v1/items', [createRoute()]].forEach((routeOptions) => {
      assert.throws(() => assertRouteContract(routeOptions), { name: 'TypeError', message: /requires the options of a route/ });
    });
  });

  test('refuses a $ref whatever stands next to it', () => {
    assertUntyped({
      'a $ref next to a type and properties': { $ref: 'item#', type: 'object', properties: { id: { type: 'integer' } } },
    });
  });
});

describe('assertRouteContract: response by media type', () => {
  test('checks the JSON media type of a response in the content form', () => {
    assertAccepted({
      'typed application/json': { 200: { content: { 'application/json': { schema: successEnvelope(createItem()) } } } },
      'typed */*': { 200: { content: { '*/*': { schema: successEnvelope(createItem()) } } } },
    });
    assertRefused({
      'untyped application/json': { 200: { content: { 'application/json': { schema: successEnvelope({}) } } } },
      'untyped +json': { 200: { content: { 'application/vnd.api+json': { schema: successEnvelope({}) } } } },
      'untyped */*, which Fastify serializes a JSON reply with': { 200: { content: { '*/*': { schema: successEnvelope({}) } } } },
      'untyped application/json next to a file': {
        200: { content: { 'text/csv': { schema: { type: 'string' } }, 'application/json': { schema: successEnvelope({}) } } },
      },
    }, NO_TYPED_DATA);
  });

  test('exempts a response that has no JSON media type: it is a file or a stream', () => {
    assertAccepted({
      'text/csv': { 200: { content: { 'text/csv': { schema: { type: 'string' } } } } },
      'application/octet-stream': { 200: { content: { 'application/octet-stream': { schema: { type: 'string' } } } } },
    });
  });

  test('refuses a content form that names no media type, and reads a JSON media type in any letter case', () => {
    assertRefused({
      'no media type': { 200: { content: {} } },
      'untyped Application/JSON': { 200: { content: { 'Application/JSON': { schema: successEnvelope({}) } } } },
    }, NO_TYPED_DATA);
  });
});

describe('isJsonField and rememberSourceSchema', () => {
  test('isJsonField tells the field of json() from any other schema', () => {
    assert.equal(isJsonField(json()), true);
    assert.equal(isJsonField(nullable(json('Meta'))), true);
    [FREE_JSON, { json: 'true' }, null, undefined, 'json', [json()]].forEach((value, index) => assert.equal(isJsonField(value), false, String(index)));
  });

  test('rememberSourceSchema returns the route schema and makes readDocumentedSchema show the source', () => {
    const source = { querystring: { type: 'object', properties: { code: { type: 'string', maxLength: 5, pattern: CODE_PATTERN } } } };
    const prepared = { querystring: { type: 'object', properties: { code: { type: 'string', maxLength: 5 } } } };

    assert.equal(rememberSourceSchema(prepared, source), prepared);
    assert.deepEqual(readDocumentedSchema(prepared), source);
  });

  test('rememberSourceSchema refuses what is not a schema object', () => {
    [[null, {}], [{}, null], ['schema', {}]].forEach(([routeSchema, source], index) => {
      assert.throws(() => rememberSourceSchema(routeSchema, source), { name: 'TypeError', message: /rememberSourceSchema/ }, String(index));
    });
  });
});

describe('dropSchemaMarkers', () => {
  test('takes the json marker off every field at any depth and keeps a field named "json"', () => {
    const schema = freezeDeep({
      type: 'object',
      properties: {
        profile: json('Profile'),
        json: { type: 'string', maxLength: 10 },
        items: { type: 'array', items: { type: 'object', properties: { meta: nullable(json()) } } },
      },
    });

    assert.deepEqual(dropSchemaMarkers(schema), {
      type: 'object',
      properties: {
        profile: { type: 'object', additionalProperties: true, description: 'Profile' },
        json: { type: 'string', maxLength: 10 },
        items: { type: 'array', items: { type: 'object', properties: { meta: { type: ['object', 'null'], additionalProperties: true } } } },
      },
    });
  });

  test('leaves a schema without the marker equal to what it was, and what is not a schema as it is', () => {
    const schema = { type: 'object', properties: { name: { type: 'string', maxLength: 10 } } };

    assert.deepEqual(dropSchemaMarkers(schema), schema);
    [true, false, null, undefined].forEach((value) => assert.equal(dropSchemaMarkers(value), value));
  });
});

describe('readDocumentedSchema', () => {
  test('returns the schema the author wrote, before the gate and the finite guards', () => {
    const querystring = createCodeQuery();
    const response = { 200: successEnvelope(createItem()) };
    const routeOptions = createRoute({ schema: freezeDeep({ querystring, response }) });

    createRouteHook(PREFIXES)(routeOptions);

    assert.notDeepEqual(routeOptions.schema.querystring, querystring);
    assert.deepEqual(readDocumentedSchema(routeOptions.schema), { querystring: createCodeQuery(), response });
  });

  test('drops the json marker in every request part and every response, wherever it sits', () => {
    const routeOptions = createRoute({
      schema: {
        body: {
          type: 'object',
          properties: {
            profile: json(),
            tags: { type: 'array', items: json() },
            extra: { type: 'object', additionalProperties: json() },
          },
        },
        headers: { type: 'object', properties: { 'x-meta': json() } },
        response: {
          200: successEnvelope({ type: 'object', properties: { id: { type: 'integer' }, profile: nullable(json('Free settings')) } }),
        },
      },
    });

    createRouteHook(PREFIXES)(routeOptions);

    assert.deepEqual(readDocumentedSchema(routeOptions.schema), {
      body: {
        type: 'object',
        properties: {
          profile: FREE_JSON,
          tags: { type: 'array', items: FREE_JSON },
          extra: { type: 'object', additionalProperties: FREE_JSON },
        },
      },
      headers: { type: 'object', properties: { 'x-meta': FREE_JSON } },
      response: {
        200: successEnvelope({
          type: 'object',
          properties: {
            id: { type: 'integer' },
            profile: { type: ['object', 'null'], additionalProperties: true, description: 'Free settings' },
          },
        }),
      },
    });
  });

  test('drops the json marker in a body and a response in the content form, and keeps what a media type says besides', () => {
    const examples = { sample: { value: { profile: { theme: 'dark' } } } };
    const routeOptions = createRoute({
      schema: {
        body: { content: { 'application/json': { schema: { type: 'object', properties: { profile: json() } }, examples } } },
        response: {
          200: {
            description: 'The item',
            content: { 'application/json': { schema: successEnvelope({ type: 'object', properties: { profile: json() } }), examples } },
          },
          204: { type: 'null' },
        },
      },
    });

    createRouteHook(PREFIXES)(routeOptions);

    const documented = readDocumentedSchema(routeOptions.schema);

    assert.deepEqual(documented, {
      body: { content: { 'application/json': { schema: { type: 'object', properties: { profile: FREE_JSON } }, examples } } },
      response: {
        200: {
          description: 'The item',
          content: { 'application/json': { schema: successEnvelope({ type: 'object', properties: { profile: FREE_JSON } }), examples } },
        },
        204: { type: 'null' },
      },
    });
    assert.equal(documented.body.content['application/json'].examples, examples);
    assert.equal(documented.response[200].content['application/json'].examples, examples);
  });

  test('names the query querystring, as Fastify does at ready()', () => {
    const query = createCodeQuery();
    const routeOptions = createRoute({ schema: { query, response: { 200: successEnvelope(createItem()) } } });

    createRouteHook(PREFIXES)(routeOptions);

    const documented = readDocumentedSchema(routeOptions.schema);

    assert.deepEqual(documented.querystring, query);
    assert.equal(Object.hasOwn(documented, 'query'), false);
    assert.deepEqual(readDocumentedSchema({ querystring: query }), { querystring: query });
  });

  test('reads a schema the hook has not seen as it is, without the json marker and without writing to it', () => {
    const routeSchema = freezeDeep({ tags: ['Items'], body: { type: 'object', properties: { profile: json() } } });

    assert.deepEqual(readDocumentedSchema(routeSchema), { tags: ['Items'], body: { type: 'object', properties: { profile: FREE_JSON } } });
    assert.deepEqual(routeSchema.body.properties.profile, json());
  });

  test('requires the schema object of a route', () => {
    [undefined, null, 'schema', [{ body: createItem() }]].forEach((routeSchema) => {
      assert.throws(() => readDocumentedSchema(routeSchema), { name: 'TypeError', message: /requires the schema object of a route/ });
    });
  });

  // Fastify writes the querystring alias and a mark of its own into the schema object of a route at ready():
  // the source is still found by that object.
  test('reads the source of a route the app registered, also after ready() and for its HEAD twin', async (t) => {
    const fastify = await createApp(t);
    const routes = [];
    const response = { 200: successEnvelope({ type: 'object', properties: { id: { type: 'integer' }, profile: json() } }) };

    fastify.addHook('onRoute', (routeOptions) => {
      routes.push(routeOptions);
    });
    fastify.get('/api/v1/items', { schema: { query: createCodeQuery(), response }, security: PUBLIC }, readRow);
    await fastify.ready();

    assert.deepEqual(routes.map(({ method }) => method), ['GET', 'HEAD']);
    routes.forEach((routeOptions) => {
      assert.deepEqual(readDocumentedSchema(routeOptions.schema), {
        querystring: createCodeQuery(),
        response: { 200: successEnvelope({ type: 'object', properties: { id: { type: 'integer' }, profile: FREE_JSON } }) },
      }, routeOptions.method);
    });
  });
});

describe('route contract in the app', () => {
  test('a root route under /api without security makes fastify.get() throw and is not registered', async (t) => {
    const fastify = await createApp(t);

    assert.throws(
      () => fastify.get('/api/v1/items', { schema: { response: { 200: successEnvelope(createItem()) } } }, readRow),
      NO_SECURITY,
    );
    assert.equal(fastify.hasRoute({ method: 'GET', url: '/api/v1/items' }), false);

    const response = await fastify.inject('/api/v1/items');

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'NOT_FOUND_ERROR');
  });

  test('a root route under /api without a typed response makes fastify.get() throw and is not registered', async (t) => {
    const fastify = await createApp(t);

    assert.throws(() => fastify.get('/api/v1/items', { security: PUBLIC }, readRow), NO_RESPONSE);
    assert.throws(
      () => fastify.get('/api/v1/items', { schema: { response: { 200: successEnvelope({}) } }, security: PUBLIC }, readRow),
      NO_TYPED_DATA,
    );
    assert.equal(fastify.hasRoute({ method: 'GET', url: '/api/v1/items' }), false);

    const response = await fastify.inject('/api/v1/items');

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'NOT_FOUND_ERROR');
  });

  test('names every method when fastify.route() declares several', async (t) => {
    const fastify = await createApp(t);

    assert.throws(
      () => fastify.route({ method: ['GET', 'POST'], url: '/api/v1/items', handler: readRow }),
      /GET\W+POST \/api\/v1\/items\b.*security/,
    );
  });

  test('the same route inside an async plugin under /api makes ready() reject with the route in the message', async (t) => {
    const routes = [
      [{ schema: { response: { 200: successEnvelope(createItem()) } } }, /GET \/api\/v2\/items\b.*security/],
      [{ security: PUBLIC }, /GET \/api\/v2\/items\b.*response/],
      [{ schema: { response: { 200: successEnvelope({}) } }, security: PUBLIC }, /GET \/api\/v2\/items\b.*data/],
    ];

    await Promise.all(routes.map(async ([options, reason]) => {
      const fastify = await createApp(t);

      fastify.register(async (instance) => {
        instance.get('/items', options, readRow);
      }, { prefix: '/api/v2' });

      await assert.rejects(fastify.ready(), reason);
    }));
  });

  test('checks /health and the routes under it', async (t) => {
    const fastify = await createApp(t);

    assert.throws(() => fastify.get('/health', readRow), /GET \/health\b.*security/);
    assert.throws(() => fastify.get('/health/ready', { security: PUBLIC }, readRow), /GET \/health\/ready\b.*response/);

    fastify.get('/health/live', { schema: { response: { 200: successEnvelope(createItem()) } }, security: PUBLIC }, readRow);

    const [live, health, ready] = await Promise.all(['/health/live', '/health', '/health/ready'].map((url) => fastify.inject(url)));

    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json().data, FILTERED_ROW);
    assert.equal(health.statusCode, 404);
    assert.equal(ready.statusCode, 404);
  });

  test('does not check a route outside the prefixes, whatever its path starts with', async (t) => {
    const fastify = await createApp(t);
    const urls = ['/', '/items', '/apiary/x', '/api-docs', '/healthz'];

    urls.forEach((url) => fastify.get(url, () => ({ url })));
    await fastify.ready();

    const responses = await Promise.all(urls.map((url) => fastify.inject(url)));

    responses.forEach((response, index) => {
      assert.equal(response.statusCode, 200, urls[index]);
      assert.deepEqual(response.json(), { url: urls[index] });
    });
  });

  test('serves a valid route under /api and filters its response by the schema', async (t) => {
    const fastify = await createApp(t);

    fastify.get('/api/v1/items/first', { schema: { response: { 200: successEnvelope(createItem()) } }, security: PUBLIC }, readRow);
    fastify.get('/api/v1/items', { schema: { response: { 200: listEnvelope(createItem()) } }, security: PUBLIC }, (request, reply) => reply.list({ data: [ROW] }));

    const [one, list] = await Promise.all(['/api/v1/items/first', '/api/v1/items'].map((url) => fastify.inject(url)));

    assert.equal(one.statusCode, 200);
    assert.deepEqual(one.json(), {
      status: 'success',
      data: FILTERED_ROW,
      meta: { requestId: one.headers['x-request-id'] },
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), {
      status: 'success',
      data: [FILTERED_ROW],
      meta: { requestId: list.headers['x-request-id'] },
    });
  });

  test('serves a valid route that an async plugin declares under /api', async (t) => {
    const fastify = await createApp(t);

    fastify.register(async (instance) => {
      instance.get('/items', { schema: { response: { 200: successEnvelope(createItem()) } }, security: PUBLIC }, readRow);
    }, { prefix: '/api/v2' });

    const response = await fastify.inject('/api/v2/items');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, FILTERED_ROW);
  });

  test('serves a file route whose response declares no JSON media type', async (t) => {
    const fastify = await createApp(t);
    const response = { 200: { content: { 'text/csv': { schema: { type: 'string' } } } } };

    fastify.get('/api/v1/items/export', { schema: { response }, security: PUBLIC }, (request, reply) => reply.type('text/csv').send('id\n1\n'));

    const exported = await fastify.inject('/api/v1/items/export');

    assert.equal(exported.statusCode, 200);
    assert.equal(exported.headers['content-type'], 'text/csv');
    assert.equal(exported.body, 'id\n1\n');
  });

  test('a request string with a pattern and no maxLength makes fastify.post() throw and is not registered', async (t) => {
    const fastify = await createApp(t);

    assert.throws(
      () => fastify.post('/api/v1/items', { schema: { body: createUngatedBody(), response: { 200: successEnvelope(createItem()) } }, security: PUBLIC }, readRow),
      { message: `Route POST /api/v1/items: "body" #/properties/code has "pattern" without "maxLength": ${TEXT_LIMIT_MESSAGE}` },
    );
    assert.throws(() => fastify.post('/items', { schema: { body: createUngatedBody() } }, readRow), /^Error: Route POST \/items: "body" #\/properties\/code/);
    assert.equal(fastify.hasRoute({ method: 'POST', url: '/api/v1/items' }), false);
    assert.equal(fastify.hasRoute({ method: 'POST', url: '/items' }), false);
  });

  test('answers a gated string over its limit with the maxLength entry alone, and one within it by the pattern', async (t) => {
    const fastify = await createApp(t);

    fastify.get('/api/v1/items', { schema: { querystring: createCodeQuery(), response: { 200: successEnvelope(createItem()) } }, security: PUBLIC }, readRow);

    const [long, wrong, valid] = await Promise.all([
      fastify.inject(`/api/v1/items?code=${LONG_CODE}`),
      fastify.inject('/api/v1/items?code=ABC'),
      fastify.inject('/api/v1/items?code=abc'),
    ]);

    assert.equal(long.statusCode, 422);
    assert.deepEqual(readErrors(long), [{ column: 'code', operator: 'maxLength', operatorValue: 5 }]);
    assert.equal(wrong.statusCode, 422);
    assert.deepEqual(readErrors(wrong), [{ column: 'code', operator: 'pattern', operatorValue: CODE_PATTERN }]);
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(valid.json().data, FILTERED_ROW);
  });

  test('registers the HEAD twin of a GET route with a gated querystring, and the twin answers', async (t) => {
    const fastify = await createApp(t);

    fastify.get('/api/v1/items', { schema: { querystring: createCodeQuery(), response: { 200: successEnvelope(createItem()) } }, security: PUBLIC }, readRow);

    const [valid, long, wrong] = await Promise.all([
      fastify.inject({ method: 'HEAD', url: '/api/v1/items?code=abc' }),
      fastify.inject({ method: 'HEAD', url: `/api/v1/items?code=${LONG_CODE}` }),
      fastify.inject({ method: 'HEAD', url: '/api/v1/items?code=ABC' }),
    ]);

    assert.equal(fastify.hasRoute({ method: 'HEAD', url: '/api/v1/items' }), true);
    assert.equal(valid.statusCode, 200);
    assert.equal(valid.body, '');
    assert.equal(long.statusCode, 422);
    assert.equal(wrong.statusCode, 422);
  });

  test('lets a json() field out whole as the free JSON of its column, and still filters the fields next to it', async (t) => {
    const fastify = await createApp(t);
    const data = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        owner: json(),
        profile: nullable(json()),
      },
    };

    fastify.get('/api/v1/items', { schema: { response: { 200: successEnvelope(data) } }, security: PUBLIC }, (request, reply) => reply.ok({ ...ROW, profile: null }));

    const response = await fastify.inject('/api/v1/items');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { id: 1, owner: ROW.owner, profile: null });
  });

  test('registers the HEAD twin of a valid GET route', async (t) => {
    const fastify = await createApp(t);

    fastify.get('/api/v1/items', { schema: { response: { 200: successEnvelope(createItem()) } }, security: PUBLIC }, readRow);

    const response = await fastify.inject({ method: 'HEAD', url: '/api/v1/items' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '');
    assert.equal(fastify.hasRoute({ method: 'HEAD', url: '/api/v1/items' }), true);
  });

  test('does not mutate the schema and the security object of the caller', async (t) => {
    const fastify = await createApp(t);
    const schema = {
      querystring: { type: 'object', properties: { limit: { type: 'integer' } } },
      response: { 200: successEnvelope(createItem()) },
    };
    const security = { auth: false };
    const snapshot = structuredClone(schema);

    fastify.get('/api/v1/items', { schema, security }, readRow);
    await fastify.ready();

    assert.deepEqual(Reflect.ownKeys(schema), ['querystring', 'response']);
    assert.deepEqual(schema, snapshot);
    assert.deepEqual(security, { auth: false });
  });

  test('accepts a deep-frozen schema and a frozen security object', async (t) => {
    const fastify = await createApp(t);
    const schema = freezeDeep({
      query: { type: 'object', properties: { limit: { type: 'integer' } } },
      response: { 200: successEnvelope(createItem()) },
    });

    fastify.get('/api/v1/items', { schema, security: PUBLIC }, readRow);

    const [accepted, rejected] = await Promise.all(['/api/v1/items?limit=5', '/api/v1/items?limit=Infinity'].map((url) => fastify.inject(url)));

    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json().data, FILTERED_ROW);
    assert.equal(rejected.statusCode, 422);
    assert.equal(rejected.json().code, 'VALIDATION_ERROR');
  });

  test('takes the prefixes from config.app', async (t) => {
    const fastify = await createApp(t, { app: { apiPrefix: '/internal', healthPrefix: '/status' } });

    assert.throws(() => fastify.get('/internal/items', readRow), /GET \/internal\/items\b.*security/);
    assert.throws(() => fastify.get('/status', readRow), /GET \/status\b.*security/);

    fastify.get('/api/items', () => ({ isChecked: false }));
    fastify.get('/health', () => ({ isChecked: false }));

    const responses = await Promise.all(['/api/items', '/health'].map((url) => fastify.inject(url)));

    responses.forEach((response) => {
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { isChecked: false });
    });
  });

  test('does not build an app whose prefix could never match a route', async () => {
    await assert.rejects(buildTestApp({ app: { apiPrefix: '/api/' } }), /prefix/i);
    await assert.rejects(buildTestApp({ app: { healthPrefix: 'health' } }), /prefix/i);
  });

  // Through the private list of Fastify: no plugin of the app declares a route under a prefix to look at instead.
  test('is installed before the first plugin of the app: a route of any of them is checked', async (t) => {
    const fastify = await createApp(t);
    const [first] = fastify[symbols.kHooks].onRoute;

    assert.throws(() => first.call(fastify, { method: 'GET', url: '/api/v1/items' }), NO_SECURITY);
  });

  test('is installed before buildApp loads its own routes: Fastify gets a copy of their schema', async (t) => {
    const fastify = await createApp(t);

    await fastify.ready();

    // Fastify marks the schema object it compiles with a symbol: a mark on pingSchema itself would mean
    // that the route was declared before the hook existed, so it was neither guarded nor checked.
    assert.deepEqual(Object.getOwnPropertySymbols(pingSchema), []);
  });

  test('what the contract accepts is a filter: an undeclared field of the row does not reach the client', async (t) => {
    const total = { type: 'object', properties: { total: { type: 'integer' } } };
    const shapes = [
      createItem(),
      { type: ['object', 'null'], properties: { id: { type: 'integer' } } },
      { anyOf: [createItem(), { type: 'null' }] },
      { type: 'string' },
      { const: 'fixed' },
      { type: 'object', allOf: [createItem(), total] },
      { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' }, owner: { anyOf: [createItem(), { type: 'null' }] } } },
      { type: 'object', properties: { owner: createItem() }, allOf: [createItem()] },
      { ...createItem(), if: { required: ['id'] }, then: total },
      {
        ...createItem(), if: { required: ['missing'] }, then: total, else: createItem(),
      },
      { anyOf: [createItem()], if: { required: ['id'] }, then: total },
    ];
    const bodies = await Promise.all(shapes.map((data) => requestRow(t, data)));

    bodies.forEach((body, index) => {
      assert.equal(typeof body, 'string', JSON.stringify(shapes[index]));
      assert.doesNotMatch(body, LEAK, JSON.stringify(shapes[index]));
    });
  });

  test('does not let an undeclared field out through then or else of a data schema', async (t) => {
    const openedByThen = {
      ...createItem(),
      if: { type: 'object', properties: { id: { type: 'integer' } } },
      then: { type: 'object', additionalProperties: true },
    };
    const openedByElse = {
      ...createItem(),
      if: { type: 'object', required: ['missing'] },
      then: { type: 'object' },
      else: { type: 'object', additionalProperties: true },
    };
    const bodies = await Promise.all([openedByThen, openedByElse].map((data) => requestRow(t, data)));

    bodies.forEach((body) => assert.doesNotMatch(String(body), LEAK));
  });

  test('does not let an object out through a data schema that is only an enum', async (t) => {
    const body = await requestRow(t, { enum: ['active', 'blocked'] });

    assert.doesNotMatch(String(body), LEAK);
  });

  test('does not let an undeclared field out through a schema the serializer writes with alone', async (t) => {
    const condition = { type: 'object', properties: { kind: { const: 'user' } }, required: ['kind'] };
    const shapes = [
      { if: createItem() },
      { then: createItem() },
      { if: condition, then: createItem() },
      { if: createItem(), else: createItem() },
      { anyOf: [createItem(), { type: 'null' }], patternProperties: { Hash$: {} } },
      { allOf: [createItem()], patternProperties: { '^pass': true } },
      { allOf: [{ if: createItem() }] },
      { anyOf: [{ then: createItem() }] },
    ];
    const bodies = await Promise.all(shapes.map((data) => requestRow(t, data)));

    bodies.forEach((body, index) => assert.doesNotMatch(String(body), LEAK, JSON.stringify(shapes[index])));
  });

  test('does not let a nested object out whole through the closed side of a merge', async (t) => {
    const closedItem = { ...createItem(), additionalProperties: false };
    const extension = { type: 'object', properties: { owner: createItem() } };
    const shapes = [
      { allOf: [closedItem, extension] },
      { allOf: [extension, closedItem] },
      { type: 'object', additionalProperties: false, anyOf: [extension] },
      { ...closedItem, if: { required: ['id'] }, then: extension },
      { type: 'object', additionalProperties: false, allOf: [extension, { anyOf: [createItem()] }] },
      { allOf: [{ type: 'object', properties: { owner: closedItem } }, { type: 'object', properties: { owner: extension } }] },
    ];
    const bodies = await Promise.all(shapes.map((data) => requestRow(t, data)));

    bodies.forEach((body, index) => assert.doesNotMatch(String(body), LEAK, JSON.stringify(shapes[index])));
  });

  test('does not let an undeclared field out through what is merged into the envelope', async (t) => {
    const open = { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } };
    const envelope = successEnvelope(createItem());
    const responses = [
      { ...envelope, allOf: [open] },
      { ...envelope, anyOf: [open] },
      { ...envelope, if: { type: 'object' }, then: open },
    ];
    const bodies = await Promise.all(responses.map(async (response) => {
      const fastify = await createApp(t);

      try {
        fastify.get('/api/v1/items', { schema: { response: { 200: response } }, security: PUBLIC }, readRow);
      } catch {
        return null;
      }

      return (await fastify.inject('/api/v1/items')).body;
    }));

    bodies.forEach((body) => assert.doesNotMatch(String(body), LEAK));
  });
});
