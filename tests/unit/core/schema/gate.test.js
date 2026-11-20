import { gateExpensiveKeywords, gateRouteSchema } from '#core/schema/gate.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { freezeDeep } from '#utils/object.js';
import Ajv from 'ajv';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const CODE_PATTERN = '^[a-z]+$';
const CODE_MAX_LENGTH = 36;
const EMAIL_MAX_LENGTH = 254;
const IDS_MAX_ITEMS = 20;

const LONG_LENGTH = 100000;
const HOSTILE_ITEMS = 50000;

// A string of the whole body and an array of thousands of items: under the bodyLimit of the app they get 413 first.
const BODY_LIMIT = 1024 * 1024;

const MEDIA_JSON = 'application/json';
const MEDIA_FORM = 'multipart/form-data';

const TEXT_LIMIT_MESSAGE = 'a request string with a pattern or a format needs a length limit';
const ITEMS_LIMIT_MESSAGE = 'a request array compared item by item needs a limit';

function createCode(maxLength = CODE_MAX_LENGTH) {
  return { type: 'string', maxLength, pattern: CODE_PATTERN };
}

function gateCode(maxLength = CODE_MAX_LENGTH) {
  return { type: 'string', maxLength, allOf: [{ if: { maxLength }, then: { maxLength, pattern: CODE_PATTERN } }] };
}

function createEmail() {
  return { type: 'string', maxLength: EMAIL_MAX_LENGTH, format: 'email' };
}

function createIds(maxItems = IDS_MAX_ITEMS) {
  return {
    type: 'array',
    maxItems,
    uniqueItems: true,
    items: { type: 'integer' },
  };
}

function gateIds(maxItems = IDS_MAX_ITEMS) {
  return {
    type: 'array',
    maxItems,
    items: { type: 'integer' },
    allOf: [{ if: { maxItems }, then: { maxItems, uniqueItems: true } }],
  };
}

function createPart(properties) {
  return { type: 'object', properties };
}

function createUngatedCode() {
  return { type: 'string', pattern: CODE_PATTERN };
}

function describeTextError(part, pointer, keywords = '"pattern"') {
  return { name: 'TypeError', message: `"${part}" ${pointer} has ${keywords} without "maxLength": ${TEXT_LIMIT_MESSAGE}` };
}

async function createApp(t, overrides) {
  const fastify = await buildTestApp(overrides);

  t.after(() => fastify.close());

  return fastify;
}

function postItems(fastify, payload) {
  return fastify.inject({ method: 'POST', url: '/items', payload });
}

// The value of a long string is cut in the entry: only what names the error is compared.
function readErrors(response) {
  return response.json().validation.map(({ column, operator, operatorValue }) => ({ column, operator, operatorValue }));
}

describe('gateExpensiveKeywords', () => {
  test('moves the pattern of a string under an "if" on its maxLength', () => {
    assert.deepEqual(gateExpensiveKeywords(createCode()), gateCode());
  });

  test('moves a format, and a pattern together with a format, under one "if"', () => {
    assert.deepEqual(gateExpensiveKeywords(createEmail()), {
      type: 'string',
      maxLength: EMAIL_MAX_LENGTH,
      allOf: [{ if: { maxLength: EMAIL_MAX_LENGTH }, then: { maxLength: EMAIL_MAX_LENGTH, format: 'email' } }],
    });
    assert.deepEqual(gateExpensiveKeywords({
      type: 'string',
      maxLength: 10,
      pattern: '^\\d',
      format: 'date',
    }), {
      type: 'string',
      maxLength: 10,
      allOf: [{ if: { maxLength: 10 }, then: { maxLength: 10, pattern: '^\\d', format: 'date' } }],
    });
  });

  test('moves the format limits of ajv-formats together with the format they depend on', () => {
    const gated = gateExpensiveKeywords({
      type: 'string',
      maxLength: 10,
      format: 'date',
      formatMinimum: '2020-01-01',
      formatExclusiveMaximum: '2030-01-01',
    });

    assert.deepEqual(gated, {
      type: 'string',
      maxLength: 10,
      allOf: [{
        if: { maxLength: 10 },
        then: {
          maxLength: 10, format: 'date', formatMinimum: '2020-01-01', formatExclusiveMaximum: '2030-01-01',
        },
      }],
    });
  });

  test('gates a schema that names no type and a string that may be null', () => {
    const then = { maxLength: 5, pattern: CODE_PATTERN };

    assert.deepEqual(gateExpensiveKeywords({ maxLength: 5, pattern: CODE_PATTERN }), { maxLength: 5, allOf: [{ if: { maxLength: 5 }, then }] });
    [['string', 'null'], ['null', 'string']].forEach((type) => {
      assert.deepEqual(
        gateExpensiveKeywords({ type, maxLength: 5, pattern: CODE_PATTERN }),
        { type, maxLength: 5, allOf: [{ if: { maxLength: 5 }, then }] },
        JSON.stringify(type),
      );
    });
  });

  test('keeps the other keywords of the string where they were', () => {
    const gated = gateExpensiveKeywords({
      ...createCode(),
      minLength: 1,
      description: 'Code of the item',
      default: 'abc',
      examples: ['abc'],
    });

    assert.deepEqual(gated, {
      ...gateCode(),
      minLength: 1,
      description: 'Code of the item',
      default: 'abc',
      examples: ['abc'],
    });
  });

  test('appends the gate to an allOf that is already there', () => {
    const gated = gateExpensiveKeywords({ ...createCode(), allOf: [{ minLength: 2 }] });

    assert.deepEqual(gated, {
      type: 'string',
      maxLength: CODE_MAX_LENGTH,
      allOf: [{ minLength: 2 }, { if: { maxLength: CODE_MAX_LENGTH }, then: { maxLength: CODE_MAX_LENGTH, pattern: CODE_PATTERN } }],
    });
  });

  test('leaves a format or a pattern of a schema that cannot hold a string alone, and asks for no maxLength', () => {
    const schemas = [
      { type: 'integer', format: 'int32' },
      { type: ['number', 'null'], format: 'double' },
      { type: 'boolean', format: 'flag' },
      { type: 'object', pattern: CODE_PATTERN },
    ];

    schemas.forEach((schema) => assert.deepEqual(gateExpensiveKeywords(schema), structuredClone(schema), JSON.stringify(schema)));
  });

  test('moves uniqueItems of an array under an "if" on its maxItems', () => {
    const then = { maxItems: 3, uniqueItems: true };

    assert.deepEqual(gateExpensiveKeywords(createIds()), gateIds());
    assert.deepEqual(gateExpensiveKeywords({ maxItems: 3, uniqueItems: true }), { maxItems: 3, allOf: [{ if: { maxItems: 3 }, then }] });
    assert.deepEqual(
      gateExpensiveKeywords({ type: ['array', 'null'], maxItems: 3, uniqueItems: true }),
      { type: ['array', 'null'], maxItems: 3, allOf: [{ if: { maxItems: 3 }, then }] },
    );
  });

  test('leaves uniqueItems: false alone, and uniqueItems of a schema that cannot hold an array', () => {
    const schemas = [
      { type: 'array', uniqueItems: false, items: { type: 'integer' } },
      { type: 'string', maxLength: 5, uniqueItems: true },
      { type: 'object', uniqueItems: true },
    ];

    schemas.forEach((schema) => assert.deepEqual(gateExpensiveKeywords(schema), structuredClone(schema), JSON.stringify(schema)));
  });

  test('gives each kind its own "if" on a schema that names no type', () => {
    const gated = gateExpensiveKeywords({
      maxLength: 5,
      pattern: CODE_PATTERN,
      maxItems: 3,
      uniqueItems: true,
    });

    assert.deepEqual(gated, {
      maxLength: 5,
      maxItems: 3,
      allOf: [
        { if: { maxLength: 5 }, then: { maxLength: 5, pattern: CODE_PATTERN } },
        { if: { maxItems: 3 }, then: { maxItems: 3, uniqueItems: true } },
      ],
    });
  });

  test('gates a string and an array wherever they sit in the schema', () => {
    const gated = gateExpensiveKeywords({
      type: 'object',
      properties: {
        owner: createPart({ code: createCode() }),
        tags: { type: 'array', maxItems: 5, items: createCode() },
        matrix: { type: 'array', maxItems: 2, items: createIds() },
      },
      patternProperties: { '^code_': createCode() },
      additionalProperties: createCode(),
      anyOf: [createPart({ ids: createIds() })],
      definitions: { code: createCode() },
      dependencies: { owner: createPart({ email: createEmail() }) },
    });

    assert.deepEqual(gated, {
      type: 'object',
      properties: {
        owner: createPart({ code: gateCode() }),
        tags: { type: 'array', maxItems: 5, items: gateCode() },
        matrix: { type: 'array', maxItems: 2, items: gateIds() },
      },
      patternProperties: { '^code_': gateCode() },
      additionalProperties: gateCode(),
      anyOf: [createPart({ ids: gateIds() })],
      definitions: { code: gateCode() },
      dependencies: {
        owner: createPart({
          email: {
            type: 'string',
            maxLength: EMAIL_MAX_LENGTH,
            allOf: [{ if: { maxLength: EMAIL_MAX_LENGTH }, then: { maxLength: EMAIL_MAX_LENGTH, format: 'email' } }],
          },
        }),
      },
    });
  });

  test('gates propertyNames: a key is a string the client chooses', () => {
    assert.deepEqual(
      gateExpensiveKeywords({ type: 'object', propertyNames: { maxLength: 30, pattern: CODE_PATTERN } }),
      { type: 'object', propertyNames: { maxLength: 30, allOf: [{ if: { maxLength: 30 }, then: { maxLength: 30, pattern: CODE_PATTERN } }] } },
    );
    assert.throws(
      () => gateExpensiveKeywords({ type: 'object', propertyNames: { pattern: CODE_PATTERN } }, { label: '"body"' }),
      describeTextError('body', '#/propertyNames'),
    );
  });

  test('gates a branch on its own: the branch runs whatever the maxLength of the schema that holds it says', () => {
    assert.throws(
      () => gateExpensiveKeywords({ type: 'string', maxLength: 10, anyOf: [{ pattern: '^a' }, { pattern: '^b' }] }, { label: '"body"' }),
      describeTextError('body', '#/anyOf/0'),
    );
    assert.deepEqual(
      gateExpensiveKeywords({ type: 'string', maxLength: 10, anyOf: [{ maxLength: 10, pattern: '^a' }] }),
      { type: 'string', maxLength: 10, anyOf: [{ maxLength: 10, allOf: [{ if: { maxLength: 10 }, then: { maxLength: 10, pattern: '^a' } }] }] },
    );
  });

  test('refuses a pattern or a format without maxLength, and names the part and the pointer', () => {
    const cases = [
      [createPart({ code: createUngatedCode() }), 'body', '#/properties/code', '"pattern"'],
      [createPart({ from: { type: 'string', format: 'date-time-utc' } }), 'querystring', '#/properties/from', '"format"'],
      [{ type: 'array', items: { type: ['string', 'null'], pattern: '^\\d+$', format: 'date' } }, 'headers', '#/items', '"pattern" and "format"'],
    ];

    cases.forEach(([schema, part, pointer, keywords]) => {
      assert.throws(() => gateExpensiveKeywords(schema, { label: `"${part}"` }), describeTextError(part, pointer, keywords), pointer);
    });
  });

  test('refuses uniqueItems without maxItems, and names the part and the pointer', () => {
    const ids = { type: 'array', uniqueItems: true, items: { type: 'integer' } };

    assert.throws(() => gateExpensiveKeywords(createPart({ ids }), { label: '"body"' }), {
      name: 'TypeError',
      message: `"body" #/properties/ids has "uniqueItems" without "maxItems": ${ITEMS_LIMIT_MESSAGE}`,
    });
  });

  test('calls the part "schema" when it is not given, and writes the root as "#"', () => {
    assert.throws(() => gateExpensiveKeywords({ type: 'string', format: 'email' }), describeTextError('schema', '#', '"format"'));
  });

  test('escapes a name in the pointer as AJV does', () => {
    assert.throws(
      () => gateExpensiveKeywords(createPart({ 'a/b~c': createUngatedCode() }), { label: '"body"' }),
      describeTextError('body', '#/properties/a~1b~0c'),
    );
  });

  test('takes only a whole number that is not negative for the limit', () => {
    [-1, 1.5, '10', null, Infinity, true].forEach((limit) => {
      assert.throws(() => gateExpensiveKeywords({ ...createCode(), maxLength: limit }), { name: 'TypeError', message: /without "maxLength"/ }, String(limit));
      assert.throws(() => gateExpensiveKeywords({ ...createIds(), maxItems: limit }), { name: 'TypeError', message: /without "maxItems"/ }, String(limit));
    });
    assert.deepEqual(gateExpensiveKeywords(createCode(0)), gateCode(0));
    assert.deepEqual(gateExpensiveKeywords(createIds(0)), gateIds(0));
  });

  test('leaves a schema with nothing to gate as it was', () => {
    const schemas = [
      {},
      { type: 'string', maxLength: 5 },
      { type: 'string', enum: ['active', 'blocked'] },
      { type: 'array', maxItems: 3, items: { type: 'string' } },
      createPart({ name: { type: 'string', minLength: 1, maxLength: 50 }, limit: { type: 'integer', minimum: 1 } }),
      { type: 'object', properties: { any: true }, additionalProperties: false },
    ];

    schemas.forEach((schema) => assert.deepEqual(gateExpensiveKeywords(schema), structuredClone(schema), JSON.stringify(schema)));
  });

  test('returns what is not a schema object as it is', () => {
    ['text', '', true, false, null, undefined, 5].forEach((value) => assert.equal(gateExpensiveKeywords(value), value));
  });

  test('never writes to its input: a deep-frozen schema gives a gated copy', () => {
    const frozen = freezeDeep(createPart({ code: createCode(), ids: createIds() }));

    assert.deepEqual(gateExpensiveKeywords(frozen), createPart({ code: gateCode(), ids: gateIds() }));
    assert.deepEqual(frozen, createPart({ code: createCode(), ids: createIds() }));
  });

  test('keeps the verdict of AJV on every value: only the moment the costly keywords run changes', () => {
    const ajv = new Ajv({ allErrors: true });
    const schema = createPart({ code: createCode(5), ids: createIds(3) });
    const plain = ajv.compile(schema);
    const gated = ajv.compile(gateExpensiveKeywords(schema));
    const values = [
      { code: 'abc' },
      { code: 'ABC' },
      { code: 'abcdef' },
      { code: 'ABCDEF' },
      { ids: [1, 2] },
      { ids: [1, 1] },
      { ids: [1, 2, 3, 4] },
      { ids: [1, 1, 1, 1] },
    ];

    values.forEach((value) => assert.equal(gated(value), plain(value), JSON.stringify(value)));
  });

  // With allErrors AJV runs a format even on a value that has failed maxLength: the first call below
  // is the one the gate takes away.
  test('runs a format only on a value within the limit', () => {
    const lengths = [];
    const ajv = new Ajv({ allErrors: true });

    ajv.addFormat('counted', (value) => {
      lengths.push(value.length);

      return true;
    });

    const schema = { type: 'string', maxLength: 5, format: 'counted' };
    const plain = ajv.compile(schema);
    const gated = ajv.compile(gateExpensiveKeywords(schema));

    assert.equal(plain('x'.repeat(LONG_LENGTH)), false);
    assert.equal(gated('x'.repeat(LONG_LENGTH)), false);
    assert.equal(gated('abc'), true);
    assert.deepEqual(lengths, [LONG_LENGTH, 3]);
  });
});

describe('gateRouteSchema', () => {
  test('gates body, querystring, query, params and headers', () => {
    const gated = gateRouteSchema({
      body: createPart({ code: createCode() }),
      querystring: createPart({ ids: createIds() }),
      query: createPart({ email: createEmail() }),
      params: createPart({ id: createCode() }),
      headers: createPart({ 'x-code': createCode() }),
    });

    assert.deepEqual(gated, {
      body: createPart({ code: gateCode() }),
      querystring: createPart({ ids: gateIds() }),
      query: createPart({ email: gateExpensiveKeywords(createEmail()) }),
      params: createPart({ id: gateCode() }),
      headers: createPart({ 'x-code': gateCode() }),
    });
  });

  test('gates every schema of a body in the content form and keeps the rest of the body', () => {
    const examples = { small: { value: { code: 'abc' } } };
    const gated = gateRouteSchema({
      body: {
        description: 'New item',
        content: {
          [MEDIA_JSON]: { schema: createPart({ code: createCode() }), examples },
          [MEDIA_FORM]: { schema: createPart({ ids: createIds() }) },
        },
      },
    });

    assert.deepEqual(gated.body, {
      description: 'New item',
      content: {
        [MEDIA_JSON]: { schema: createPart({ code: gateCode() }), examples },
        [MEDIA_FORM]: { schema: createPart({ ids: gateIds() }) },
      },
    });
    assert.equal(gated.body.content[MEDIA_JSON].examples, examples);
  });

  test('names the part in the error, the query under the name the route gave it, and the media type of a body in the content form', () => {
    ['body', 'querystring', 'query', 'params', 'headers'].forEach((part) => {
      assert.throws(
        () => gateRouteSchema({ [part]: createPart({ code: createUngatedCode() }) }),
        describeTextError(part, '#/properties/code'),
        part,
      );
    });
    assert.throws(
      () => gateRouteSchema({ body: { content: { [MEDIA_FORM]: { schema: createPart({ code: createUngatedCode() }) } } } }),
      { name: 'TypeError', message: `"body" (${MEDIA_FORM}) #/properties/code has "pattern" without "maxLength": ${TEXT_LIMIT_MESSAGE}` },
    );
  });

  test('gates its own output again without an error: the branch it wrote carries the limit', () => {
    const once = gateExpensiveKeywords(createPart({ code: createCode(), ids: createIds() }));
    const twice = gateExpensiveKeywords(once);

    assert.equal(twice.properties.code.maxLength, CODE_MAX_LENGTH);
    assert.equal(twice.properties.code.allOf[0].then.allOf[0].then.pattern, CODE_PATTERN);
    assert.equal(twice.properties.ids.allOf[0].then.allOf[0].then.uniqueItems, true);
  });

  test('leaves a schema without its limit as it is when it is not strict, as for a shared schema', () => {
    const ungated = createPart({ code: createUngatedCode(), ids: { type: 'array', uniqueItems: true } });

    assert.deepEqual(gateExpensiveKeywords(ungated, { isStrict: false }), ungated);
    assert.deepEqual(gateExpensiveKeywords(createPart({ code: createCode() }), { isStrict: false }), createPart({ code: gateCode() }));
  });

  test('leaves the response alone: the gate is for what a client sends', () => {
    const response = { 200: createPart({ code: createUngatedCode() }) };
    const gated = gateRouteSchema({ querystring: createPart({ code: createCode() }), response });

    assert.equal(gated.response, response);
    assert.deepEqual(gated.querystring, createPart({ code: gateCode() }));
  });

  test('always returns a new top-level object that can be written to', () => {
    const routeSchema = freezeDeep({ querystring: createPart({ code: createCode() }), response: { 204: { type: 'null' } } });
    const gated = gateRouteSchema(routeSchema);

    assert.notEqual(gated, routeSchema);
    assert.equal(Object.isFrozen(gated), false);
    assert.deepEqual(gated.querystring, createPart({ code: gateCode() }));
    assert.deepEqual(routeSchema.querystring, createPart({ code: createCode() }));
  });

  test('requires the schema object of a route', () => {
    [undefined, null, 'body', [{ body: createPart({ code: createCode() }) }]].forEach((routeSchema) => {
      assert.throws(() => gateRouteSchema(routeSchema), { name: 'TypeError', message: /requires the schema object of a route/ });
    });
  });
});

describe('gate in a request', () => {
  test('answers a 100 000-character string against a pattern or a format with the maxLength entry alone', async (t) => {
    const fastify = await createApp(t, { app: { bodyLimit: BODY_LIMIT } });
    const received = [];
    const long = 'A'.repeat(LONG_LENGTH);

    fastify.post('/items', { schema: { body: createPart({ code: createCode(), email: createEmail() }) } }, (request) => {
      received.push(request.body);

      return { isReached: true };
    });

    const response = await postItems(fastify, { code: long, email: long });

    assert.equal(response.statusCode, 422);
    assert.deepEqual(readErrors(response), [
      { column: 'code', operator: 'maxLength', operatorValue: CODE_MAX_LENGTH },
      { column: 'email', operator: 'maxLength', operatorValue: EMAIL_MAX_LENGTH },
    ]);
    assert.deepEqual(received, []);
  });

  test('answers an array over maxItems with uniqueItems by the maxItems entry alone, in the body and in the query', async (t) => {
    const fastify = await createApp(t, { app: { bodyLimit: BODY_LIMIT } });
    const ids = new URLSearchParams(Array.from({ length: IDS_MAX_ITEMS + 1 }, () => ['ids', '7']));

    fastify.post('/items', { schema: { body: createPart({ ids: createIds() }) } }, () => ({ isReached: true }));
    fastify.get('/items', { schema: { querystring: createPart({ ids: createIds() }) } }, () => ({ isReached: true }));

    const responses = await Promise.all([
      postItems(fastify, { ids: Array.from({ length: HOSTILE_ITEMS }, () => 7) }),
      fastify.inject(`/items?${ids}`),
    ]);

    responses.forEach((response) => {
      assert.equal(response.statusCode, 422);
      assert.deepEqual(response.json().validation, [{
        column: 'ids',
        columnValue: null,
        operator: 'maxItems',
        operatorValue: IDS_MAX_ITEMS,
      }]);
    });
  });

  test('answers a value within the limit that breaks a gated keyword with its own entry and no "if" entry', async (t) => {
    const body = createPart({ code: createCode(), email: createEmail(), ids: createIds() });
    const [fastify, devFastify] = await Promise.all([createApp(t), createApp(t, { app: { isDev: true } })]);

    [fastify, devFastify].forEach((instance) => {
      instance.post('/items', { schema: { body } }, () => ({ isReached: true }));
    });

    const payload = { code: 'ABC', email: 'not-an-email', ids: [7, 7] };
    const [response, devResponse] = await Promise.all([postItems(fastify, payload), postItems(devFastify, payload)]);

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json().validation, [
      {
        column: 'code',
        columnValue: 'ABC',
        operator: 'pattern',
        operatorValue: CODE_PATTERN,
      },
      {
        column: 'email',
        columnValue: 'not-an-email',
        operator: 'format',
        operatorValue: 'email',
      },
      {
        column: 'ids',
        columnValue: null,
        operator: 'uniqueItems',
        operatorValue: null,
      },
    ]);
    assert.deepEqual(devResponse.json().validation.map(({ schema }) => [schema.keyword, schema.schemaPath]), [
      ['pattern', '#/properties/code/allOf/0/then/pattern'],
      ['format', '#/properties/email/allOf/0/then/format'],
      ['uniqueItems', '#/properties/ids/allOf/0/then/uniqueItems'],
    ]);
  });

  test('builds a route whose format carries a limit of ajv-formats, and applies the limit', async (t) => {
    const fastify = await createApp(t);
    const from = {
      type: 'string',
      maxLength: 10,
      format: 'date',
      formatMinimum: '2020-01-01',
    };
    const querystring = createPart({ from });

    fastify.get('/items', { schema: { querystring } }, (request) => request.query);
    await fastify.ready();

    const [early, late] = await Promise.all([fastify.inject('/items?from=2019-01-01'), fastify.inject('/items?from=2021-01-01')]);

    assert.equal(early.statusCode, 422);
    assert.deepEqual(early.json().validation, [{
      column: 'from',
      columnValue: '2019-01-01',
      operator: 'formatMinimum',
      operatorValue: '2020-01-01',
    }]);
    assert.deepEqual([late.statusCode, late.json()], [200, { from: '2021-01-01' }]);
  });

  test('passes a value within the limit that keeps every gated keyword to the handler', async (t) => {
    const fastify = await createApp(t);
    const payload = { code: 'abc', email: 'anna@example.com', ids: [1, 2, 3] };

    fastify.post('/items', { schema: { body: createPart({ code: createCode(), email: createEmail(), ids: createIds() }) } }, (request) => request.body);

    const response = await postItems(fastify, payload);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), payload);
  });
});
