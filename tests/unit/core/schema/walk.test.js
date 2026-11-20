import { mapRequestSchemas, REQUEST_PARTS } from '#core/schema/walk.js';
import { freezeDeep } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const MEDIA_JSON = 'application/json';
const MEDIA_FORM = 'multipart/form-data';

function keepSchema(schema) {
  return schema;
}

function createInteger() {
  return { type: 'integer' };
}

function createPart(name = 'limit') {
  return { type: 'object', properties: { [name]: createInteger() } };
}

function createRouteSchema() {
  return {
    body: createPart(),
    querystring: createPart(),
    query: createPart(),
    params: createPart('id'),
    headers: createPart('x-limit'),
  };
}

function recordCalls(calls) {
  return (schema, part, mediaType) => {
    calls.push([schema, part, mediaType]);

    return schema;
  };
}

describe('mapRequestSchemas', () => {
  test('hands transform the schema of every request part with the name of the part', () => {
    const routeSchema = createRouteSchema();
    const calls = [];
    const mapped = mapRequestSchemas(routeSchema, (schema, part, mediaType) => {
      calls.push([schema, part, mediaType]);

      return { part };
    });

    assert.deepEqual(calls.map(([, part, mediaType]) => [part, mediaType]), [
      ['body', undefined],
      ['querystring', undefined],
      ['query', undefined],
      ['params', undefined],
      ['headers', undefined],
    ]);
    calls.forEach(([schema, part]) => assert.equal(schema, routeSchema[part], part));
    assert.deepEqual(mapped, {
      body: { part: 'body' },
      querystring: { part: 'querystring' },
      query: { part: 'query' },
      params: { part: 'params' },
      headers: { part: 'headers' },
    });
  });

  test('hands transform each schema of a body in the content form with its media type, and keeps the rest of the body', () => {
    const jsonSchema = createPart();
    const formSchema = createPart('amount');
    const examples = { small: { value: { limit: 5 } } };
    const routeSchema = {
      body: {
        description: 'Page request',
        content: {
          [MEDIA_JSON]: { schema: jsonSchema, examples },
          [MEDIA_FORM]: { schema: formSchema },
        },
      },
    };
    const calls = [];
    const mapped = mapRequestSchemas(routeSchema, (schema, part, mediaType) => {
      calls.push([schema, part, mediaType]);

      return { mediaType };
    });

    assert.deepEqual(calls.map(([, part, mediaType]) => [part, mediaType]), [['body', MEDIA_JSON], ['body', MEDIA_FORM]]);
    assert.equal(calls[0][0], jsonSchema);
    assert.equal(calls[1][0], formSchema);
    assert.deepEqual(mapped.body, {
      description: 'Page request',
      content: {
        [MEDIA_JSON]: { schema: { mediaType: MEDIA_JSON }, examples },
        [MEDIA_FORM]: { schema: { mediaType: MEDIA_FORM } },
      },
    });
    assert.equal(mapped.body.content[MEDIA_JSON].examples, examples);
  });

  test('hands transform a body that has no object under content as one schema', () => {
    const bodies = [
      true,
      null,
      { type: 'object', content: null },
      { type: 'object', properties: { content: { type: 'string' } } },
    ];

    bodies.forEach((body) => {
      const calls = [];

      mapRequestSchemas({ body }, recordCalls(calls));

      assert.deepEqual(calls, [[body, 'body', undefined]], JSON.stringify(body));
    });
  });

  test('leaves the response and the keys it does not know as they are', () => {
    const response = { 200: createPart('total') };
    const tags = ['Items'];
    const mapped = mapRequestSchemas({
      tags,
      summary: 'List items',
      querystring: createPart(),
      response,
    }, () => ({}));

    assert.deepEqual(Object.keys(mapped).sort(), ['querystring', 'response', 'summary', 'tags']);
    assert.equal(mapped.response, response);
    assert.equal(mapped.tags, tags);
    assert.equal(mapped.summary, 'List items');
  });

  test('always returns a new top-level object and adds no part the route does not declare', () => {
    const empty = {};
    const calls = [];
    const mapped = mapRequestSchemas(empty, recordCalls(calls));

    assert.notEqual(mapped, empty);
    assert.deepEqual(mapped, {});
    assert.deepEqual(calls, []);
    assert.deepEqual(Object.keys(mapRequestSchemas({ params: createPart('id') }, keepSchema)), ['params']);
  });

  test('skips a part that is undefined and hands null to transform', () => {
    const calls = [];

    mapRequestSchemas({ body: undefined, params: null }, recordCalls(calls));

    assert.deepEqual(calls, [[null, 'params', undefined]]);
  });

  test('copies a deep-frozen route schema into objects that can be written to', () => {
    const routeSchema = freezeDeep({
      query: createPart(),
      body: { content: { [MEDIA_JSON]: { schema: createPart() } } },
    });
    const mapped = mapRequestSchemas(routeSchema, keepSchema);

    assert.deepEqual(mapped, routeSchema);
    assert.equal(Object.isFrozen(mapped), false);
    assert.equal(Object.isFrozen(mapped.body), false);
    assert.equal(Object.isFrozen(mapped.body.content), false);
    assert.equal(Object.isFrozen(mapped.body.content[MEDIA_JSON]), false);
  });

  test('requires the schema object of a route and a function', () => {
    const reason = { name: 'TypeError', message: /requires the schema object of a route and a function/ };

    [undefined, null, 'body', [createRouteSchema()]].forEach((routeSchema) => {
      assert.throws(() => mapRequestSchemas(routeSchema, keepSchema), reason, JSON.stringify(routeSchema));
    });
    [undefined, null, 'transform', {}].forEach((transform) => {
      assert.throws(() => mapRequestSchemas({}, transform), reason, String(transform));
    });
  });
});

describe('REQUEST_PARTS', () => {
  test('lists the parts of a request, the query under both of its names', () => {
    assert.deepEqual(REQUEST_PARTS, ['body', 'querystring', 'query', 'params', 'headers']);
    assert.equal(Object.isFrozen(REQUEST_PARTS), true);
  });
});
