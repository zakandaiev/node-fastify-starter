import {
  addFiniteGuards,
  guardRouteSchema,
  readSchemaTypes,
  useFiniteKeyword,
} from '#core/schema/finite.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { freezeDeep } from '#utils/object.js';
import Ajv from 'ajv';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const AJV_OPTIONS = Object.freeze({ coerceTypes: 'array', allErrors: true });

const FINITE_ERROR = Object.freeze({
  instancePath: '/limit',
  schemaPath: '#/properties/limit/finite',
  keyword: 'finite',
  params: {},
  message: 'must be a finite number',
});

const NON_FINITE = Object.freeze([
  { text: 'Infinity', reflected: 'Infinity' },
  { text: '-Infinity', reflected: '-Infinity' },
  { text: '1e400', reflected: 'Infinity' },
]);
const NON_FINITE_IN_URL = Object.freeze([...NON_FINITE, { text: '%20Infinity', reflected: 'Infinity' }]);

function createRange() {
  return { type: 'integer', minimum: 1, maximum: 100 };
}

function createPart(name = 'limit') {
  return { type: 'object', properties: { [name]: createRange() } };
}

function createGuardedPart(name = 'limit') {
  return { type: 'object', properties: { [name]: { ...createRange(), finite: true } } };
}

function createRichSchema() {
  return {
    type: 'object',
    required: ['limit'],
    properties: {
      limit: createRange(),
      ratio: { type: ['number', 'null'] },
      name: { type: 'string', maxLength: 50 },
      ids: { type: 'array', items: { type: 'integer' } },
      pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }], additionalItems: { type: 'integer' } },
      range: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
      status: { enum: ['active', 1] },
    },
    patternProperties: { '^price_': { type: 'number' } },
    additionalProperties: { type: 'integer' },
    dependencies: {
      limit: ['ratio'],
      ratio: { type: 'object', properties: { precision: { type: 'integer' } } },
    },
    definitions: { count: { type: 'integer' } },
    if: { type: 'object', properties: { limit: { type: 'integer' } } },
    then: { type: 'object', properties: { ratio: { type: 'number' } } },
    else: { type: 'object', properties: { ratio: { type: 'null' } } },
    not: { type: 'object', required: ['forbidden'] },
  };
}

function createAjv() {
  const ajv = new Ajv(AJV_OPTIONS);

  useFiniteKeyword(ajv);

  return ajv;
}

// The value sits in a property: AJV can write a coerced value back only into its parent.
function validateLimit(ajv, limitSchema, limit) {
  const validate = ajv.compile({ type: 'object', properties: { limit: limitSchema } });
  const data = { limit };
  const isValid = validate(data);

  return { isValid, limit: data.limit, errors: validate.errors };
}

async function createApp(t) {
  const fastify = await buildTestApp();

  t.after(() => fastify.close());

  return fastify;
}

function describeRejection(response, column, columnValue) {
  return {
    status: 'error',
    code: 'VALIDATION_ERROR',
    message: 'Validation error',
    validation: [{
      column,
      columnValue,
      operator: 'finite',
      operatorValue: null,
    }],
    meta: { requestId: response.headers['x-request-id'] },
  };
}

function describeNotFound(response) {
  return {
    status: 'error',
    code: 'NOT_FOUND_ERROR',
    message: 'Not found',
    meta: { requestId: response.headers['x-request-id'] },
  };
}

describe('useFiniteKeyword', () => {
  test('without the keyword a coerced Infinity passes minimum and maximum', () => {
    const ajv = new Ajv(AJV_OPTIONS);

    assert.deepEqual(validateLimit(ajv, createRange(), 'Infinity'), { isValid: true, limit: Infinity, errors: null });
    assert.deepEqual(validateLimit(ajv, createRange(), '-Infinity'), { isValid: true, limit: -Infinity, errors: null });
    assert.deepEqual(validateLimit(ajv, createRange(), '1e400'), { isValid: true, limit: Infinity, errors: null });
  });

  test('rejects a value that coercion turns into a non-finite number', () => {
    const ajv = createAjv();

    ['Infinity', '-Infinity', '1e400', ' Infinity'].forEach((text) => {
      const result = validateLimit(ajv, { ...createRange(), finite: true }, text);

      assert.equal(result.isValid, false, text);
      assert.deepEqual(result.errors, [FINITE_ERROR], text);
    });
  });

  test('accepts a finite number and leaves the other keywords at work', () => {
    const ajv = createAjv();
    const range = { ...createRange(), finite: true };
    const tooLarge = validateLimit(ajv, range, '500');

    assert.deepEqual(validateLimit(ajv, range, '5'), { isValid: true, limit: 5, errors: null });
    assert.deepEqual(validateLimit(ajv, range, 100), { isValid: true, limit: 100, errors: null });
    assert.equal(tooLarge.isValid, false);
    assert.deepEqual(tooLarge.errors.map((error) => error.keyword), ['maximum']);
  });

  test('is switched off by finite: false', () => {
    const result = validateLimit(createAjv(), { ...createRange(), finite: false }, 'Infinity');

    assert.deepEqual(result, { isValid: true, limit: Infinity, errors: null });
  });

  test('passes a value that is not a number', () => {
    const ajv = createAjv();

    ['Infinity', '1e400', '', true, null, [Infinity], { limit: Infinity }].forEach((value) => {
      assert.equal(validateLimit(ajv, { finite: true }, value).isValid, true, JSON.stringify(value));
    });
  });

  test('rejects Infinity, -Infinity and NaN that arrive as numbers', () => {
    const ajv = createAjv();

    [Infinity, -Infinity, NaN].forEach((value) => {
      const result = validateLimit(ajv, { finite: true }, value);

      assert.equal(result.isValid, false, String(value));
      assert.deepEqual(result.errors, [FINITE_ERROR], String(value));
    });
  });

  test('takes only a boolean for its value', () => {
    const ajv = createAjv();

    assert.throws(() => ajv.compile({ type: 'integer', finite: 'true' }), /finite/);
    assert.throws(() => ajv.compile({ type: 'integer', finite: 1 }), /finite/);
  });

  test('throws when it is registered on the same instance twice', () => {
    const ajv = createAjv();

    assert.throws(() => useFiniteKeyword(ajv), /finite is already defined/);
  });

  test('reads the value that a schema compiled apart has coerced: a $ref to a schema that holds a $ref itself', () => {
    const ajv = createAjv();

    ajv.addSchema({ $id: 'positive', type: 'integer', minimum: 1 });
    ajv.addSchema({ $id: 'alias', $ref: 'positive#' });

    const validate = ajv.compile({ type: 'object', properties: { limit: { $ref: 'alias#', finite: true } } });

    assert.equal(validate({ limit: 'Infinity' }), false);
    assert.equal(validate({ limit: '1e400' }), false);
    assert.equal(validate({ limit: '5' }), true);
  });

  test('reads the value itself where it has no parent: at the root of the data', () => {
    const validate = createAjv().compile({ type: 'number', finite: true });

    assert.equal(validate('Infinity'), false);
    assert.equal(validate('5'), true);
  });

  test('requires an instance of AJV and returns it', () => {
    const ajv = new Ajv(AJV_OPTIONS);

    [undefined, null, {}, { addKeyword: true }].forEach((value) => {
      assert.throws(() => useFiniteKeyword(value), { name: 'TypeError', message: /requires an instance of AJV/ });
    });
    assert.equal(useFiniteKeyword(ajv), ajv);
  });
});

describe('readSchemaTypes', () => {
  test('returns the types of a schema as a list, whichever way it names them', () => {
    assert.deepEqual(readSchemaTypes({ type: 'integer' }), ['integer']);
    assert.deepEqual(readSchemaTypes({ type: ['integer', 'null'] }), ['integer', 'null']);
    assert.deepEqual(readSchemaTypes({ properties: {} }), []);
    assert.deepEqual(readSchemaTypes({ type: null }), []);
  });

  test('does not hand out the list of the schema itself', () => {
    const schema = Object.freeze({ type: Object.freeze(['integer', 'null']) });

    assert.notEqual(readSchemaTypes(schema), schema.type);
  });

  test('requires a schema object', () => {
    [undefined, null, true, 'integer', [{ type: 'integer' }]].forEach((schema) => {
      assert.throws(() => readSchemaTypes(schema), { name: 'TypeError', message: /requires a schema object/ });
    });
  });
});

describe('addFiniteGuards', () => {
  test('marks a number and an integer', () => {
    assert.deepEqual(addFiniteGuards({ type: 'number' }), { type: 'number', finite: true });
    assert.deepEqual(addFiniteGuards({ type: 'integer', minimum: 1 }), { type: 'integer', minimum: 1, finite: true });
  });

  test('marks a list of types that holds a numeric one', () => {
    assert.deepEqual(addFiniteGuards({ type: ['integer', 'null'] }), { type: ['integer', 'null'], finite: true });
    assert.deepEqual(addFiniteGuards({ type: ['null', 'number'] }), { type: ['null', 'number'], finite: true });
    assert.deepEqual(addFiniteGuards({ type: ['string', 'null'] }), { type: ['string', 'null'] });
  });

  test('leaves a schema that holds no number as it is', () => {
    const schemas = [
      {},
      { type: 'string', maxLength: 5 },
      { type: 'boolean' },
      { type: 'null' },
      { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      { type: 'array', items: { type: 'string' } },
    ];

    schemas.forEach((schema) => assert.deepEqual(addFiniteGuards(schema), structuredClone(schema)));
  });

  test('walks properties, patternProperties and additionalProperties', () => {
    const guarded = addFiniteGuards({
      type: 'object',
      properties: { limit: { type: 'integer' }, name: { type: 'string' } },
      patternProperties: { '^price_': { type: 'number' } },
      additionalProperties: { type: 'integer' },
    });

    assert.deepEqual(guarded, {
      type: 'object',
      properties: { limit: { type: 'integer', finite: true }, name: { type: 'string' } },
      patternProperties: { '^price_': { type: 'number', finite: true } },
      additionalProperties: { type: 'integer', finite: true },
    });
  });

  test('keeps a boolean in the place of a subschema', () => {
    const schema = {
      type: 'object',
      properties: { any: true, none: false },
      additionalProperties: false,
    };

    assert.deepEqual(addFiniteGuards(schema), structuredClone(schema));
    assert.deepEqual(addFiniteGuards({ type: 'array', items: true }), { type: 'array', items: true });
  });

  test('walks items in the object and in the tuple form, additionalItems and contains', () => {
    assert.deepEqual(
      addFiniteGuards({ type: 'array', items: { type: 'integer' } }),
      { type: 'array', items: { type: 'integer', finite: true } },
    );
    assert.deepEqual(
      addFiniteGuards({ type: 'array', items: [{ type: 'string' }, { type: 'number' }], additionalItems: { type: 'integer' } }),
      { type: 'array', items: [{ type: 'string' }, { type: 'number', finite: true }], additionalItems: { type: 'integer', finite: true } },
    );
    assert.deepEqual(
      addFiniteGuards({ type: 'array', contains: { type: 'number' } }),
      { type: 'array', contains: { type: 'number', finite: true } },
    );
  });

  test('walks arrays nested in arrays', () => {
    const guarded = addFiniteGuards({ type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'number' } } } });

    assert.deepEqual(guarded, { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'number', finite: true } } } });
  });

  test('walks anyOf, oneOf and allOf and marks the schema that holds them', () => {
    ['anyOf', 'oneOf', 'allOf'].forEach((keyword) => {
      assert.deepEqual(
        addFiniteGuards({ [keyword]: [{ type: 'integer' }, { type: 'string' }] }),
        { [keyword]: [{ type: 'integer', finite: true }, { type: 'string' }], finite: true },
        keyword,
      );
    });
  });

  test('marks the schema that holds a $ref: the schema it points to is out of sight', () => {
    assert.deepEqual(addFiniteGuards({ $ref: 'limit#' }), { $ref: 'limit#', finite: true });
    assert.deepEqual(
      addFiniteGuards({ type: 'object', properties: { limit: { $ref: 'limit#' } } }),
      { type: 'object', properties: { limit: { $ref: 'limit#', finite: true } } },
    );
  });

  test('walks not and marks the schema that holds it', () => {
    assert.deepEqual(addFiniteGuards({ not: { type: 'integer' } }), { not: { type: 'integer', finite: true }, finite: true });
    assert.deepEqual(addFiniteGuards({ not: { type: 'string' } }), { not: { type: 'string' }, finite: true });
  });

  test('walks if, then and else and marks the schema that holds them', () => {
    const guarded = addFiniteGuards({
      if: { type: 'integer' },
      then: { type: 'integer', minimum: 1 },
      else: { type: 'number' },
    });

    assert.deepEqual(guarded, {
      if: { type: 'integer', finite: true },
      then: { type: 'integer', minimum: 1, finite: true },
      else: { type: 'number', finite: true },
      finite: true,
    });
  });

  test('marks a holder that sits deep inside another schema', () => {
    const guarded = addFiniteGuards({
      type: 'object',
      properties: { range: { type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'null' }] } } },
    });

    assert.deepEqual(guarded, {
      type: 'object',
      properties: {
        range: { type: 'array', items: { anyOf: [{ type: 'number', finite: true }, { type: 'null' }], finite: true } },
      },
    });
  });

  test('walks definitions and $defs', () => {
    const guarded = addFiniteGuards({
      type: 'object',
      definitions: { count: { type: 'integer' }, label: { type: 'string' } },
      $defs: { price: { type: 'number' } },
    });

    assert.deepEqual(guarded, {
      type: 'object',
      definitions: { count: { type: 'integer', finite: true }, label: { type: 'string' } },
      $defs: { price: { type: 'number', finite: true } },
    });
  });

  test('walks the schema form of dependencies and keeps a list of names as it is', () => {
    const guarded = addFiniteGuards({
      type: 'object',
      dependencies: {
        card: ['cvv', 'expiry'],
        amount: { type: 'object', properties: { fee: { type: 'number' } } },
      },
    });

    assert.deepEqual(guarded, {
      type: 'object',
      dependencies: {
        card: ['cvv', 'expiry'],
        amount: { type: 'object', properties: { fee: { type: 'number', finite: true } } },
      },
    });
  });

  test('takes a key of properties or definitions for a name, even one spelled like a keyword', () => {
    const guarded = addFiniteGuards({
      type: 'object',
      properties: {
        type: { type: 'integer' },
        items: { type: 'number' },
        not: { type: 'string' },
        anyOf: { type: 'boolean' },
        properties: { type: 'integer' },
      },
      definitions: { if: { type: 'number' } },
    });

    assert.deepEqual(guarded, {
      type: 'object',
      properties: {
        type: { type: 'integer', finite: true },
        items: { type: 'number', finite: true },
        not: { type: 'string' },
        anyOf: { type: 'boolean' },
        properties: { type: 'integer', finite: true },
      },
      definitions: { if: { type: 'number', finite: true } },
    });
  });

  test('does not walk the values of enum, const, default and examples', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { enum: [{ type: 'integer' }, 'auto'] },
        fixed: { const: { type: 'number', not: {} } },
        page: { type: 'object', default: { type: 'integer' }, examples: [{ type: 'number' }] },
      },
    };

    assert.deepEqual(addFiniteGuards(schema), structuredClone(schema));
  });

  test('returns what is not a schema object as it is', () => {
    ['text', '', true, false, null, undefined, 5].forEach((value) => assert.equal(addFiniteGuards(value), value));
  });

  test('keeps a mark that is already there, an explicit finite: false included', () => {
    assert.deepEqual(addFiniteGuards({ type: 'integer', finite: false }), { type: 'integer', finite: false });
    assert.deepEqual(addFiniteGuards({ type: 'integer', finite: true }), { type: 'integer', finite: true });
    assert.deepEqual(
      addFiniteGuards({ not: { type: 'integer' }, finite: false }),
      { not: { type: 'integer', finite: true }, finite: false },
    );
  });

  test('preserves the keys it does not know', () => {
    const schema = {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
      description: 'Page size',
      examples: [20, 50],
    };

    assert.deepEqual(addFiniteGuards(schema), { ...schema, finite: true });
  });

  test('returns a copy and never mutates its input', () => {
    const schema = createRichSchema();
    const guarded = addFiniteGuards(schema);

    assert.deepEqual(schema, createRichSchema());
    assert.notEqual(guarded, schema);
    assert.notEqual(guarded.properties, schema.properties);
    assert.notEqual(guarded.properties.limit, schema.properties.limit);
    assert.equal(guarded.properties.limit.finite, true);
    assert.equal(guarded.finite, true);
  });

  test('works on a deep-frozen schema', () => {
    const frozen = freezeDeep(createRichSchema());

    assert.deepEqual(addFiniteGuards(frozen), addFiniteGuards(createRichSchema()));
    assert.deepEqual(frozen, createRichSchema());
  });

  test('is idempotent', () => {
    const once = addFiniteGuards(createRichSchema());

    assert.deepEqual(addFiniteGuards(once), once);
  });

  test('closes the hole in every place of a schema where a number can be coerced', () => {
    const ajv = createAjv();
    const pair = {
      type: 'array',
      items: [{ type: 'string' }, { type: 'integer' }],
      minItems: 2,
      maxItems: 2,
    };
    const cases = [
      [{ type: ['integer', 'null'] }, '1e400', '3'],
      [{ type: 'array', items: { type: 'number' } }, ['1', '-Infinity'], ['1', '2.5']],
      [pair, ['a', 'Infinity'], ['a', '3']],
      [{ type: 'array', contains: { type: 'integer' } }, ['Infinity'], ['3']],
      [{ type: 'object', properties: { size: { type: 'integer', maximum: 10 } } }, { size: 'Infinity' }, { size: '3' }],
      [{ type: 'object', additionalProperties: { type: 'number' } }, { any: 'Infinity' }, { any: '3' }],
      [{ type: 'object', patternProperties: { '^n': { type: 'integer' } } }, { n1: '-Infinity' }, { n1: '3' }],
      [{ anyOf: [{ type: 'integer', maximum: 5 }, { type: 'boolean' }] }, 'Infinity', '3'],
      [{ oneOf: [{ type: 'integer', maximum: 5 }, { type: 'boolean' }] }, 'Infinity', '3'],
      [{ allOf: [{ type: 'integer' }] }, '1e400', '3'],
    ];

    cases.forEach(([schema, nonFinite, finite]) => {
      const label = JSON.stringify(schema);

      assert.equal(validateLimit(new Ajv(AJV_OPTIONS), schema, structuredClone(nonFinite)).isValid, true, label);
      assert.equal(validateLimit(ajv, addFiniteGuards(schema), structuredClone(nonFinite)).isValid, false, label);
      assert.equal(validateLimit(ajv, addFiniteGuards(schema), structuredClone(finite)).isValid, true, label);
    });
  });

  test('rejects a non-finite number behind a local $ref and inside the schema form of dependencies', () => {
    const ajv = createAjv();
    const withReference = addFiniteGuards({
      type: 'object',
      properties: { count: { $ref: '#/definitions/count' } },
      definitions: { count: { type: 'integer' } },
    });
    const withDependency = addFiniteGuards({
      type: 'object',
      properties: { currency: { type: 'string' } },
      dependencies: { currency: { type: 'object', properties: { amount: { type: 'number' } } } },
    });

    assert.equal(ajv.validate(withReference, { count: 'Infinity' }), false);
    assert.equal(ajv.validate(withReference, { count: '3' }), true);
    assert.equal(ajv.validate(withDependency, { currency: 'UAH', amount: '1e400' }), false);
    assert.equal(ajv.validate(withDependency, { currency: 'UAH', amount: '10.5' }), true);
  });

  test('the mark on the holder is what stops a number coerced inside a failed not or if', () => {
    const ajv = createAjv();
    const holders = [
      { not: { type: 'integer' } },
      { if: { type: 'integer' }, then: { type: 'integer', minimum: 1 } },
    ];

    holders.forEach((holder) => {
      const guarded = validateLimit(ajv, addFiniteGuards(holder), 'Infinity');
      // With the mark on the numeric subschema alone the branch fails, the holder passes
      // and the handler gets the number the branch has already written into the request.
      const unmarked = validateLimit(ajv, addFiniteGuards({ ...holder, finite: false }), 'Infinity');

      assert.equal(guarded.isValid, false);
      assert.deepEqual(guarded.errors.at(-1), FINITE_ERROR);
      assert.deepEqual(unmarked, { isValid: true, limit: Infinity, errors: null });
    });
  });
});

describe('guardRouteSchema', () => {
  test('requires the schema object of a route', () => {
    [undefined, null, 'body', [{ body: createPart() }]].forEach((routeSchema) => {
      assert.throws(() => guardRouteSchema(routeSchema), { name: 'TypeError', message: /requires the schema object of a route/ });
    });
  });

  test('guards body, querystring, query, params and headers', () => {
    const guarded = guardRouteSchema({
      body: createPart(),
      querystring: createPart(),
      query: createPart(),
      params: createPart('id'),
      headers: createPart('x-limit'),
    });

    assert.deepEqual(guarded, {
      body: createGuardedPart(),
      querystring: createGuardedPart(),
      query: createGuardedPart(),
      params: createGuardedPart('id'),
      headers: createGuardedPart('x-limit'),
    });
  });

  test('guards the schema of every media type of a body in the content form', () => {
    const guarded = guardRouteSchema({
      body: {
        content: {
          'application/json': { schema: createPart() },
          'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { amount: { type: 'number' } } } },
        },
      },
    });

    assert.deepEqual(guarded, {
      body: {
        content: {
          'application/json': { schema: createGuardedPart() },
          'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { amount: { type: 'number', finite: true } } } },
        },
      },
    });
  });

  test('keeps what a body in the content form says besides its schemas', () => {
    const examples = { small: { value: { limit: 5 } } };
    const guarded = guardRouteSchema({
      body: {
        description: 'Page request',
        content: { 'application/json': { schema: createPart(), examples } },
      },
    });

    assert.deepEqual(guarded.body, {
      description: 'Page request',
      content: { 'application/json': { schema: createGuardedPart(), examples: { small: { value: { limit: 5 } } } } },
    });
    assert.equal(guarded.body.content['application/json'].examples, examples);
  });

  test('leaves response and the keys it does not know untouched', () => {
    const response = { 200: { type: 'object', properties: { total: { type: 'integer' } } } };
    const tags = ['Items'];
    const guarded = guardRouteSchema({
      tags,
      summary: 'List items',
      querystring: createPart(),
      response,
    });

    assert.deepEqual(Object.keys(guarded).sort(), ['querystring', 'response', 'summary', 'tags']);
    assert.equal(guarded.response, response);
    assert.equal(guarded.tags, tags);
    assert.equal(guarded.summary, 'List items');
    assert.deepEqual(response, { 200: { type: 'object', properties: { total: { type: 'integer' } } } });
  });

  test('always returns a new top-level object, also when there is nothing to guard', () => {
    const empty = {};
    const withoutParts = { tags: ['Items'], response: { 204: { type: 'null' } } };
    const guarded = guardRouteSchema(withoutParts);

    assert.notEqual(guardRouteSchema(empty), empty);
    assert.deepEqual(guardRouteSchema(empty), {});
    assert.notEqual(guarded, withoutParts);
    assert.deepEqual(guarded, withoutParts);
    assert.equal(guarded.response, withoutParts.response);
  });

  test('adds no key for a part the route does not declare', () => {
    assert.deepEqual(Object.keys(guardRouteSchema({ params: createPart('id') })), ['params']);
  });

  test('copies a deep-frozen route schema into an object that can be written to', () => {
    const routeSchema = freezeDeep({
      query: createPart(),
      body: { content: { 'application/json': { schema: createPart() } } },
      response: { 200: { type: 'object', properties: { total: { type: 'integer' } } } },
    });
    const guarded = guardRouteSchema(routeSchema);

    assert.equal(Object.isFrozen(guarded), false);
    assert.equal(Object.isExtensible(guarded), true);
    assert.deepEqual(guarded.query, createGuardedPart());
    assert.deepEqual(guarded.body, { content: { 'application/json': { schema: createGuardedPart() } } });
    assert.deepEqual(routeSchema.query, createPart());
    assert.deepEqual(routeSchema.body, { content: { 'application/json': { schema: createPart() } } });
  });
});

describe('finite guard in a request', () => {
  test('answers 422 to a non-finite number in the query', async (t) => {
    const fastify = await createApp(t);
    const received = [];

    fastify.get('/items', { schema: { querystring: createPart() } }, (request) => {
      received.push(request.query.limit);

      return { limit: request.query.limit };
    });

    await Promise.all(NON_FINITE_IN_URL.map(async ({ text, reflected }) => {
      const response = await fastify.inject(`/items?limit=${text}`);

      assert.equal(response.statusCode, 422, text);
      assert.deepEqual(response.json(), describeRejection(response, 'limit', reflected), text);
    }));

    assert.deepEqual(received, []);
  });

  test('answers 422 to a non-finite number in a property that refers to a shared schema', async (t) => {
    const fastify = await createApp(t);
    const received = [];

    fastify.addSchema({ $id: 'limit', ...createRange() });
    fastify.get('/items', { schema: { querystring: { type: 'object', properties: { limit: { $ref: 'limit#' } } } } }, (request) => {
      received.push(request.query.limit);

      return { limit: request.query.limit };
    });

    await Promise.all(NON_FINITE_IN_URL.map(async ({ text, reflected }) => {
      const response = await fastify.inject(`/items?limit=${text}`);

      assert.equal(response.statusCode, 422, text);
      assert.deepEqual(response.json(), describeRejection(response, 'limit', reflected), text);
    }));

    const response = await fastify.inject('/items?limit=5');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(received, [5]);
  });

  // AJV compiles a shared schema that holds a $ref apart from its caller: the coerced number is written
  // into the parent object, and the variable the keyword is handed still holds the text.
  test('answers 422 to a non-finite number behind a shared schema that is built on another shared schema', async (t) => {
    const fastify = await createApp(t);
    const received = [];
    const names = ['limit', 'pageSize'];

    fastify.addSchema({ $id: 'positive', type: 'integer', minimum: 1 });
    fastify.addSchema({ $id: 'limit', $ref: 'positive#' });
    fastify.addSchema({ $id: 'pageSize', allOf: [{ $ref: 'positive#' }], maximum: 100 });
    fastify.get('/items', {
      schema: { querystring: { type: 'object', properties: { limit: { $ref: 'limit#' }, pageSize: { $ref: 'pageSize#' } } } },
    }, (request) => {
      received.push({ ...request.query });

      return { isReached: true };
    });

    await Promise.all(NON_FINITE_IN_URL.flatMap(({ text }) => names.map(async (name) => {
      const response = await fastify.inject(`/items?${name}=${text}`);

      assert.equal(response.statusCode, 422, `${name}=${text}`);
      assert.equal(response.json().validation.some(({ column, operator }) => column === name && operator === 'finite'), true);
    })));

    const response = await fastify.inject('/items?limit=5&pageSize=7');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(received, [{ limit: 5, pageSize: 7 }]);
  });

  test('answers 404 to a non-finite number in a path parameter', async (t) => {
    const fastify = await createApp(t);
    const received = [];

    fastify.get('/items/:id', { schema: { params: createPart('id') } }, (request) => {
      received.push(request.params.id);

      return { id: request.params.id };
    });

    await Promise.all(NON_FINITE_IN_URL.map(async ({ text }) => {
      const response = await fastify.inject(`/items/${text}`);

      assert.equal(response.statusCode, 404, text);
      assert.deepEqual(response.json(), describeNotFound(response), text);
    }));

    assert.deepEqual(received, []);
  });

  test('lets the number in when the schema of the route says finite: false', async (t) => {
    const fastify = await createApp(t);
    const params = { type: 'object', properties: { id: { ...createRange(), finite: false } } };

    fastify.get('/items/:id', { schema: { params } }, (request) => ({ id: String(request.params.id), type: typeof request.params.id }));

    const response = await fastify.inject('/items/1e400');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { id: 'Infinity', type: 'number' });
  });

  test('answers 422 to a non-finite number in a header', async (t) => {
    const fastify = await createApp(t);
    const received = [];

    fastify.get('/items', { schema: { headers: createPart('x-limit') } }, (request) => {
      received.push(request.headers['x-limit']);

      return { limit: request.headers['x-limit'] };
    });

    await Promise.all(NON_FINITE.map(async ({ text, reflected }) => {
      const response = await fastify.inject({ url: '/items', headers: { 'x-limit': text } });

      assert.equal(response.statusCode, 422, text);
      assert.deepEqual(response.json(), describeRejection(response, 'x-limit', reflected), text);
    }));

    assert.deepEqual(received, []);
  });

  test('answers 422 to a JSON string that coerces to a non-finite number in the body', async (t) => {
    const fastify = await createApp(t);
    const received = [];

    fastify.post('/items', { schema: { body: createPart() } }, (request) => {
      received.push(request.body.limit);

      return { limit: request.body.limit };
    });

    await Promise.all(NON_FINITE.map(async ({ text, reflected }) => {
      const response = await fastify.inject({ method: 'POST', url: '/items', payload: { limit: text } });

      assert.equal(response.statusCode, 422, text);
      assert.deepEqual(response.json(), describeRejection(response, 'limit', reflected), text);
    }));

    assert.deepEqual(received, []);
  });

  test('never lets the JSON number 1e400 reach the handler either', async (t) => {
    const fastify = await createApp(t);
    const received = [];

    fastify.post('/items', { schema: { body: createPart() } }, (request) => {
      received.push(request.body.limit);

      return { limit: request.body.limit };
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/items',
      payload: '{"limit":1e400}',
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, 'VALIDATION_ERROR');
    assert.deepEqual(received, []);
  });

  test('guards a body that is declared by media type', async (t) => {
    const fastify = await createApp(t);
    const body = { content: { 'application/json': { schema: createPart() } } };

    fastify.post('/items', { schema: { body } }, (request) => ({ limit: request.body.limit }));

    const [rejected, accepted] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/items', payload: { limit: '1e400' } }),
      fastify.inject({ method: 'POST', url: '/items', payload: { limit: '7' } }),
    ]);

    assert.equal(rejected.statusCode, 422);
    assert.deepEqual(rejected.json(), describeRejection(rejected, 'limit', 'Infinity'));
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), { limit: 7 });
  });

  test('guards a number nested in an array, an object or a dictionary', async (t) => {
    const fastify = await createApp(t);
    const querystring = { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } } } };
    const body = {
      type: 'object',
      properties: {
        page: { type: 'object', properties: { size: createRange() } },
        prices: { type: 'object', additionalProperties: { type: 'number' } },
      },
    };

    fastify.get('/items', { schema: { querystring } }, (request) => ({ ids: request.query.ids }));
    fastify.post('/items', { schema: { body } }, (request) => request.body);

    const [inArray, inObject, inDictionary, finite] = await Promise.all([
      fastify.inject('/items?ids=1&ids=Infinity'),
      fastify.inject({ method: 'POST', url: '/items', payload: { page: { size: '1e400' } } }),
      fastify.inject({ method: 'POST', url: '/items', payload: { prices: { apple: '-Infinity' } } }),
      fastify.inject('/items?ids=1&ids=2'),
    ]);

    assert.equal(inArray.statusCode, 422);
    assert.deepEqual(inArray.json(), describeRejection(inArray, 'ids.1', 'Infinity'));
    assert.equal(inObject.statusCode, 422);
    assert.deepEqual(inObject.json(), describeRejection(inObject, 'page.size', 'Infinity'));
    assert.equal(inDictionary.statusCode, 422);
    assert.deepEqual(inDictionary.json(), describeRejection(inDictionary, 'prices.apple', '-Infinity'));
    assert.equal(finite.statusCode, 200);
    assert.deepEqual(finite.json(), { ids: [1, 2] });
  });

  test('rejects a number that a failed not has already coerced', async (t) => {
    const fastify = await createApp(t);
    const received = [];
    const querystring = { type: 'object', properties: { code: { not: { type: 'integer' } } } };

    fastify.get('/items', { schema: { querystring } }, (request) => {
      received.push(request.query.code);

      return { code: request.query.code };
    });

    const [rejected, accepted] = await Promise.all([
      fastify.inject('/items?code=Infinity'),
      fastify.inject('/items?code=abc'),
    ]);

    assert.equal(rejected.statusCode, 422);
    assert.deepEqual(rejected.json(), describeRejection(rejected, 'code', 'Infinity'));
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), { code: 'abc' });
    assert.deepEqual(received, ['abc']);
  });

  test('passes a finite value to the handler as a number', async (t) => {
    const fastify = await createApp(t);

    fastify.get('/query', { schema: { querystring: createPart() } }, (request) => ({ limit: request.query.limit }));
    fastify.get('/params/:limit', { schema: { params: createPart() } }, (request) => ({ limit: request.params.limit }));
    fastify.get('/headers', { schema: { headers: createPart('x-limit') } }, (request) => ({ limit: request.headers['x-limit'] }));
    fastify.post('/body', { schema: { body: createPart() } }, (request) => ({ limit: request.body.limit }));

    const responses = await Promise.all([
      fastify.inject('/query?limit=5'),
      fastify.inject('/params/5'),
      fastify.inject({ url: '/headers', headers: { 'x-limit': '5' } }),
      fastify.inject({ method: 'POST', url: '/body', payload: { limit: '5' } }),
    ]);

    responses.forEach((response) => {
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { limit: 5 });
    });
  });

  test('keeps minimum and maximum at work next to the guard', async (t) => {
    const fastify = await createApp(t);

    fastify.get('/items', { schema: { querystring: createPart() } }, (request) => ({ limit: request.query.limit }));

    const response = await fastify.inject('/items?limit=500');

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json().validation, [{
      column: 'limit',
      columnValue: 500,
      operator: 'maximum',
      operatorValue: 100,
    }]);
  });

  test('guards a route whose schema object is deep-frozen, with querystring and with its alias query', async (t) => {
    const fastify = await createApp(t);
    const withQuerystring = freezeDeep({ querystring: createPart() });
    const withQuery = freezeDeep({ query: createPart() });

    fastify.get('/frozen', { schema: withQuerystring }, (request) => ({ limit: request.query.limit }));
    fastify.get('/alias', { schema: withQuery }, (request) => ({ limit: request.query.limit }));

    const [frozen, alias, frozenFinite, aliasFinite] = await Promise.all([
      fastify.inject('/frozen?limit=Infinity'),
      fastify.inject('/alias?limit=1e400'),
      fastify.inject('/frozen?limit=5'),
      fastify.inject('/alias?limit=5'),
    ]);

    assert.equal(frozen.statusCode, 422);
    assert.deepEqual(frozen.json(), describeRejection(frozen, 'limit', 'Infinity'));
    assert.equal(alias.statusCode, 422);
    assert.deepEqual(alias.json(), describeRejection(alias, 'limit', 'Infinity'));
    assert.deepEqual(frozenFinite.json(), { limit: 5 });
    assert.deepEqual(aliasFinite.json(), { limit: 5 });
    assert.deepEqual(withQuerystring, { querystring: createPart() });
    assert.deepEqual(withQuery, { query: createPart() });
  });

  test('guards every route that shares one schema object and leaves that object as it was', async (t) => {
    const fastify = await createApp(t);
    const shared = { querystring: createPart() };

    fastify.get('/first', { schema: shared }, (request) => ({ limit: request.query.limit }));
    fastify.get('/second', { schema: shared }, (request) => ({ limit: request.query.limit }));

    const [first, second, finite] = await Promise.all([
      fastify.inject('/first?limit=Infinity'),
      fastify.inject('/second?limit=-Infinity'),
      fastify.inject('/second?limit=5'),
    ]);

    assert.equal(first.statusCode, 422);
    assert.deepEqual(first.json(), describeRejection(first, 'limit', 'Infinity'));
    assert.equal(second.statusCode, 422);
    assert.deepEqual(second.json(), describeRejection(second, 'limit', '-Infinity'));
    assert.deepEqual(finite.json(), { limit: 5 });
    assert.deepEqual(Reflect.ownKeys(shared), ['querystring']);
    assert.deepEqual(shared, { querystring: createPart() });
  });

  test('guards the automatic HEAD twin of a GET route', async (t) => {
    const fastify = await createApp(t);
    const received = [];

    fastify.get('/items', { schema: { querystring: createPart() } }, (request) => {
      received.push(request.query.limit);

      return { limit: request.query.limit };
    });

    const [rejected, accepted] = await Promise.all([
      fastify.inject({ method: 'HEAD', url: '/items?limit=Infinity' }),
      fastify.inject({ method: 'HEAD', url: '/items?limit=5' }),
    ]);

    assert.equal(rejected.statusCode, 422);
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(received, [5]);
  });

  test('guards every method of a route declared for several', async (t) => {
    const fastify = await createApp(t);

    fastify.route({
      method: ['GET', 'POST'],
      url: '/items',
      schema: { querystring: createPart() },
      handler: (request) => ({ limit: request.query.limit }),
    });

    const responses = await Promise.all(['GET', 'POST'].map((method) => fastify.inject({ method, url: '/items?limit=Infinity' })));

    responses.forEach((response) => {
      assert.equal(response.statusCode, 422);
      assert.deepEqual(response.json(), describeRejection(response, 'limit', 'Infinity'));
    });
  });

  test('guards a route that a plugin declares after the app is built', async (t) => {
    const fastify = await createApp(t);

    fastify.register(async (instance) => {
      instance.get('/items', { schema: { querystring: createPart() } }, (request) => ({ limit: request.query.limit }));
    }, { prefix: '/shop' });

    const [rejected, accepted] = await Promise.all([
      fastify.inject('/shop/items?limit=Infinity'),
      fastify.inject('/shop/items?limit=5'),
    ]);

    assert.equal(rejected.statusCode, 422);
    assert.deepEqual(rejected.json(), describeRejection(rejected, 'limit', 'Infinity'));
    assert.deepEqual(accepted.json(), { limit: 5 });
  });
});
