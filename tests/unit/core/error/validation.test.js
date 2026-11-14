import { classifyError } from '#core/error/classify.js';
import { createSchemaErrorFormatter, formatValidation, normalizeValidation } from '#core/error/validation.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { truncate } from '#utils/string.js';
import Ajv from 'ajv';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

const MAX_ERRORS = 20;
const MAX_VALUE_LENGTH = 256;
const MAX_LIST_LENGTH = 20;
const LIMITS = Object.freeze({ maxErrors: MAX_ERRORS, maxValueLength: MAX_VALUE_LENGTH, maxListLength: MAX_LIST_LENGTH });

const HOSTILE_COUNT = 50000;
const DEEP_LEVELS = 2000;
const FAMILY_EMOJI = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';

const REQUEST_PARTS = Object.freeze([
  ['body', 'body'],
  ['querystring', 'query'],
  ['params', 'params'],
  ['headers', 'headers'],
]);

const INTEGERS_SCHEMA = { type: 'array', items: { type: 'integer' } };
const EMAIL_SCHEMA = { type: 'object', properties: { email: { type: 'string', format: 'email' } } };
const LIMIT_SCHEMA = { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } } };

const BOUNDS = [
  ['minimum', { type: 'integer', minimum: 18 }, 17, 18],
  ['maximum', { type: 'integer', maximum: 100 }, 101, 100],
  ['exclusiveMinimum', { type: 'number', exclusiveMinimum: 1 }, 1, 1],
  ['exclusiveMaximum', { type: 'number', exclusiveMaximum: 10 }, 10, 10],
  ['minLength', { type: 'string', minLength: 3 }, 'ab', 3],
  ['maxLength', { type: 'string', maxLength: 2 }, 'abc', 2],
  ['minItems', { type: 'array', minItems: 2 }, [1], 2],
  ['maxItems', { type: 'array', maxItems: 1 }, [1, 2], 1],
  ['minProperties', { type: 'object', minProperties: 1 }, {}, 1],
  ['maxProperties', { type: 'object', maxProperties: 1 }, { a: 1, b: 2 }, 1],
];

const ZERO_BOUNDS = [
  ['minimum', { type: 'integer', minimum: 0 }, -1],
  ['maximum', { type: 'integer', maximum: 0 }, 1],
  ['exclusiveMinimum', { type: 'number', exclusiveMinimum: 0 }, 0],
  ['exclusiveMaximum', { type: 'number', exclusiveMaximum: 0 }, 0],
  ['maxLength', { type: 'string', maxLength: 0 }, 'x'],
  ['maxItems', { type: 'array', maxItems: 0 }, [1]],
  ['maxProperties', { type: 'object', maxProperties: 0 }, { a: 1 }],
];

const NAMED_VALUES = [
  ['type', { type: 'integer' }, 'abc', 'integer'],
  ['type', { type: ['integer', 'null'] }, 'abc', ['integer', 'null']],
  ['enum', { type: 'string', enum: ['active', 'blocked'] }, 'evil', ['active', 'blocked']],
  ['const', { const: 'user' }, 'admin', 'user'],
  ['format', { type: 'string', format: 'email' }, 'abc', 'email'],
  ['pattern', { type: 'string', pattern: '^\\d+$' }, 'abc', '^\\d+$'],
  ['multipleOf', { type: 'number', multipleOf: 0.5 }, 0.75, 0.5],
];

const FALSY_CONSTANTS = [
  [{ const: 0 }, 1, 0],
  [{ type: 'boolean', const: false }, true, false],
  [{ type: 'string', const: '' }, 'x', ''],
];

const VALUELESS_KEYWORDS = [
  ['required', { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }, {}],
  ['additionalProperties', { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } } }, { role: 'admin' }],
  ['propertyNames', { type: 'object', propertyNames: { maxLength: 3 } }, { color: 'red' }],
  ['dependencies', { type: 'object', dependencies: { card: ['cvv'] } }, { card: '4111' }],
  ['uniqueItems', { type: 'array', uniqueItems: true }, [1, 1]],
  ['contains', { type: 'array', contains: { type: 'integer' } }, ['x']],
  ['anyOf', { anyOf: [{ type: 'integer' }, { type: 'boolean' }] }, 'x'],
  ['oneOf', { oneOf: [{ type: 'integer' }, { type: 'number' }] }, 5],
  ['not', { not: { type: 'string' } }, 'x'],
  ['if', { type: 'object', if: { required: ['card'] }, then: { required: ['cvv'] } }, { card: '4111' }],
  ['false schema', false, 1],
];

// AJV knows no format by itself, Fastify adds ajv-formats: a schema with an unknown format does not compile.
const ajv = new Ajv({
  allErrors: true,
  coerceTypes: 'array',
  formats: { email: /^[^@\s]+@[^@\s]+$/ },
});

// The marks Fastify puts on what schemaErrorFormatter returns: the list and the part always, the rest when empty.
function markSchemaError(error, errors, part) {
  return Object.assign(error, {
    statusCode: error.statusCode || 400,
    code: error.code || 'FST_ERR_VALIDATION',
    validation: errors,
    validationContext: part,
  });
}

// AJV coerces the data in place and leaves it coerced when the validation fails.
function failPart(part, schema, data) {
  const validate = ajv.compile(schema);

  assert.equal(validate(data), false, 'the fixture has to fail its schema');

  return markSchemaError(new Error('Request is not valid'), validate.errors, part);
}

function formatBody(schema, body, options = {}) {
  return formatValidation(failPart('body', schema, body), { body }, { ...LIMITS, ...options });
}

function formatField(fieldSchema, value) {
  return formatBody({ type: 'object', properties: { field: fieldSchema } }, { field: value });
}

function createEntry(column, columnValue, operator, operatorValue = null) {
  return {
    column,
    columnValue,
    operator,
    operatorValue,
  };
}

function readOperators(entries) {
  return entries.map(({ operator, operatorValue }) => [operator, operatorValue]);
}

function createErrors(count) {
  return failPart('body', INTEGERS_SCHEMA, Array.from({ length: count }, () => 'x')).validation;
}

// request.query and request.params of Fastify: a dictionary on a prototype that has no prototype itself.
function createDictionary(entries) {
  return Object.assign(Object.create(Object.create(null)), entries);
}

// Numeric keys on purpose: JSON.stringify overflows the stack on them long before it does on nested arrays.
function nestUnderNumericKeys(levels, leaf) {
  return Array.from({ length: levels }).reduce((inner) => ({ 1: inner }), leaf);
}

describe('createSchemaErrorFormatter', () => {
  test('requires a positive integer for the ceiling', () => {
    [0, -1, 1.5, 2 ** 53, '20', NaN, Infinity, null, undefined].forEach((maxErrors) => {
      assert.throws(() => createSchemaErrorFormatter(maxErrors), /requires a positive integer/, inspect(maxErrors));
    });

    assert.equal(typeof createSchemaErrorFormatter(1), 'function');
  });

  test('cuts the list of AJV in place to the ceiling and reports how many errors there were', () => {
    const errors = createErrors(HOSTILE_COUNT);
    const kept = errors.slice(0, MAX_ERRORS);
    const error = createSchemaErrorFormatter(MAX_ERRORS)(errors, 'body');

    assert.equal(kept.length, MAX_ERRORS);
    assert.equal(error.message, 'Request body is not valid: 50000 schema errors');
    assert.equal(errors.length, MAX_ERRORS);
    kept.forEach((item, index) => assert.equal(errors[index], item));
  });

  test('cuts to the ceiling it was created with', () => {
    [1, 3, 49].forEach((maxErrors) => {
      const errors = createErrors(50);
      const error = createSchemaErrorFormatter(maxErrors)(errors, 'body');

      assert.equal(errors.length, maxErrors);
      assert.equal(error.message, 'Request body is not valid: 50 schema errors');
    });
  });

  test('leaves a list within the ceiling as it is', () => {
    const formatSchemaErrors = createSchemaErrorFormatter(MAX_ERRORS);

    [1, 19, 20].forEach((count) => {
      const errors = createErrors(count);
      const snapshot = [...errors];
      const error = formatSchemaErrors(errors, 'querystring');

      assert.equal(error.message, `Request querystring is not valid: ${count} schema errors`);
      assert.equal(errors.length, count);
      snapshot.forEach((item, index) => assert.equal(errors[index], item));
    });
  });

  test('does not throw on a list that refuses the cut: frozen, sealed, with a read-only length, with a locked item', () => {
    const formatSchemaErrors = createSchemaErrorFormatter(MAX_ERRORS);
    const count = MAX_ERRORS + 5;
    const lists = [
      Object.freeze(createErrors(count)),
      Object.seal(createErrors(count)),
      Object.defineProperty(createErrors(count), 'length', { writable: false }),
      Object.defineProperty(createErrors(count), count - 1, { configurable: false }),
    ];

    lists.forEach((errors) => {
      assert.equal(formatSchemaErrors(errors, 'body').message, 'Request body is not valid: 25 schema errors');
      assert.equal(errors.length, count);
      assert.equal(formatValidation(markSchemaError(new Error('Request is not valid'), errors, 'body'), {}, LIMITS).length, MAX_ERRORS);
    });
  });

  test('counts no errors in what is not a list, and does not throw', () => {
    const formatSchemaErrors = createSchemaErrorFormatter(MAX_ERRORS);

    [undefined, null, 'must be object', 5, { message: 'must be object' }].forEach((errors) => {
      assert.equal(formatSchemaErrors(errors, 'params').message, 'Request params is not valid: 0 schema errors', inspect(errors));
    });
  });

  test('returns an Error that is classified by the failed part once Fastify has marked it', () => {
    const formatSchemaErrors = createSchemaErrorFormatter(MAX_ERRORS);
    const errors = createErrors(3);

    assert.ok(formatSchemaErrors(errors, 'headers') instanceof Error);
    assert.deepEqual(
      classifyError(markSchemaError(formatSchemaErrors(errors, 'body'), errors, 'body')),
      { code: 'VALIDATION_ERROR', statusCode: 422 },
    );
    assert.deepEqual(
      classifyError(markSchemaError(formatSchemaErrors(errors, 'params'), errors, 'params')),
      { code: 'NOT_FOUND_ERROR', statusCode: 404 },
    );
  });
});

describe('formatValidation: column', () => {
  test('joins nested objects and array indexes of the pointer with dots', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string', minLength: 2 } } },
        },
      },
    };

    assert.deepEqual(formatBody(schema, { items: [{ name: 'a' }] }), [createEntry('items.0.name', 'a', 'minLength', 2)]);
    assert.deepEqual(
      formatBody(schema, { items: [{ name: 'ab' }, { name: 'abc' }, { name: 'b' }] }),
      [createEntry('items.2.name', 'b', 'minLength', 2)],
    );
  });

  test('names a missing property by the path of its parent plus its own name', () => {
    const address = { type: 'object', required: ['city'], properties: { city: { type: 'string' } } };
    const schema = {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string' },
        address,
        offices: { type: 'array', items: address },
      },
    };
    const email = 'anna@example.com';

    assert.deepEqual(formatBody(schema, {}), [createEntry('email', null, 'required')]);
    assert.deepEqual(formatBody(schema, { email, address: {} }), [createEntry('address.city', null, 'required')]);
    assert.deepEqual(
      formatBody(schema, { email, offices: [{ city: 'Kyiv' }, {}] }),
      [createEntry('offices.1.city', null, 'required')],
    );
  });

  test('names the property that additionalProperties and dependencies point at', () => {
    const profile = { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } } };
    const payment = { type: 'object', dependencies: { card: ['cvv'] } };

    assert.deepEqual(
      formatBody({ type: 'object', properties: { profile } }, { profile: { name: 'Anna', role: 'admin' } }),
      [createEntry('profile.role', 'admin', 'additionalProperties')],
    );
    assert.deepEqual(
      formatBody({ type: 'object', properties: { payment } }, { payment: { card: '4111' } }),
      [createEntry('payment.cvv', null, 'dependencies')],
    );
  });

  test('reports a bad key against the key itself, in both errors AJV gives for it', () => {
    const labels = { type: 'object', propertyNames: { maxLength: 3 } };

    assert.deepEqual(
      formatBody({ type: 'object', properties: { labels } }, { labels: { color: 'red' } }),
      [
        createEntry('labels.color', 'color', 'maxLength', 3),
        createEntry('labels.color', 'color', 'propertyNames'),
      ],
    );
  });

  test('does not reflect a bad key that is a sensitive one', () => {
    const body = { type: 'object', propertyNames: { maxLength: 3 } };

    assert.deepEqual(
      formatBody(body, { accessToken: 'abc' }),
      [
        createEntry('accessToken', null, 'maxLength', 3),
        createEntry('accessToken', null, 'propertyNames'),
      ],
    );
  });

  test('decodes the escapes of the pointer: "~1" is a slash and "~0" is a tilde', () => {
    const body = { 'a/b': 'x', 'c~d': 'y' };
    const schema = { type: 'object', properties: { 'a/b': { type: 'integer' }, 'c~d': { type: 'integer' } } };
    const error = failPart('body', schema, body);

    assert.deepEqual(error.validation.map((item) => item.instancePath), ['/a~1b', '/c~0d']);
    assert.deepEqual(formatValidation(error, { body }, LIMITS), [
      createEntry('a/b', 'x', 'type', 'integer'),
      createEntry('c~d', 'y', 'type', 'integer'),
    ]);
  });

  test('decodes "~1" before "~0": the key "~1" is not taken for a slash', () => {
    const body = { '~1': 'x', '~01': 'y', 'a~/b': 'z' };
    const error = failPart('body', { type: 'object', additionalProperties: { type: 'integer' } }, body);

    assert.deepEqual(error.validation.map((item) => item.instancePath), ['/~01', '/~001', '/a~0~1b']);
    assert.deepEqual(formatValidation(error, { body }, LIMITS), [
      createEntry('~1', 'x', 'type', 'integer'),
      createEntry('~01', 'y', 'type', 'integer'),
      createEntry('a~/b', 'z', 'type', 'integer'),
    ]);
  });

  test('has no column for an error of the part itself', () => {
    assert.deepEqual(formatBody({ type: 'object' }, 'a body that is a string'), [createEntry(null, null, 'type', 'object')]);
    assert.deepEqual(formatBody({ type: 'object', minProperties: 1 }, {}), [createEntry(null, null, 'minProperties', 1)]);
  });

  test('has no column for a missing body, which Fastify validates as null', () => {
    const error = failPart('body', { type: 'object' }, null);

    assert.deepEqual(formatValidation(error, {}, LIMITS), [createEntry(null, null, 'type', 'object')]);
  });
});

describe('formatValidation: columnValue', () => {
  test('reads the value from the part of the request that failed, as AJV coerced it there', () => {
    const schema = { type: 'object', properties: { limit: { type: 'integer', minimum: 100 } } };
    const request = {
      body: { limit: '1' },
      query: { limit: '2' },
      params: { limit: '3' },
      headers: { limit: '4' },
    };

    REQUEST_PARTS.forEach(([part, key], index) => {
      const error = failPart(part, schema, request[key]);

      assert.deepEqual(formatValidation(error, request, LIMITS), [createEntry('limit', index + 1, 'minimum', 100)], part);
    });
  });

  test('reflects the value as AJV left it after coercion', () => {
    const query = { limit: '0', isActive: 'false', tags: 'a' };
    const error = failPart('querystring', {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1 },
        isActive: { type: 'boolean', const: true },
        tags: { type: 'array', items: { type: 'string', minLength: 2 } },
      },
    }, query);

    assert.deepEqual(formatValidation(error, { query }, LIMITS), [
      createEntry('limit', 0, 'minimum', 1),
      createEntry('isActive', false, 'const', true),
      createEntry('tags.0', 'a', 'minLength', 2),
    ]);
    assert.deepEqual(formatField({ type: 'string', minLength: 5 }, 123), [createEntry('field', '123', 'minLength', 5)]);
  });

  test('reads a query string and path parameters built the way Fastify builds them', () => {
    const query = createDictionary({ limit: '0' });
    const params = createDictionary({ id: 'abc' });
    const idSchema = { type: 'object', properties: { id: { type: 'string', pattern: '^\\d+$' } } };

    assert.deepEqual(
      formatValidation(failPart('querystring', LIMIT_SCHEMA, query), { query }, LIMITS),
      [createEntry('limit', 0, 'minimum', 1)],
    );
    assert.deepEqual(
      formatValidation(failPart('params', idSchema, params), { params }, LIMITS),
      [createEntry('id', 'abc', 'pattern', '^\\d+$')],
    );
  });

  test('keeps false, 0 and an empty string as they are', () => {
    const body = { isActive: false, count: 0, name: '' };
    const schema = {
      type: 'object',
      properties: {
        isActive: { type: 'boolean', const: true },
        count: { type: 'integer', minimum: 1 },
        name: { type: 'string', minLength: 1 },
      },
    };

    assert.deepEqual(formatBody(schema, body), [
      createEntry('isActive', false, 'const', true),
      createEntry('count', 0, 'minimum', 1),
      createEntry('name', '', 'minLength', 1),
    ]);
  });

  test('cuts a string that is longer than the ceiling and ends it with an ellipsis', () => {
    const text = { type: 'string', maxLength: 10 };
    const body = {
      exact: 'a'.repeat(MAX_VALUE_LENGTH),
      longer: 'b'.repeat(MAX_VALUE_LENGTH + 1),
      huge: 'c'.repeat(100000),
    };
    const entries = formatBody({ type: 'object', properties: { exact: text, longer: text, huge: text } }, body);

    assert.deepEqual(entries.map((item) => item.columnValue), [
      'a'.repeat(MAX_VALUE_LENGTH),
      `${'b'.repeat(MAX_VALUE_LENGTH - 1)}…`,
      `${'c'.repeat(MAX_VALUE_LENGTH - 1)}…`,
    ]);
  });

  test('cuts at the ceiling it is given', () => {
    const schema = { type: 'object', properties: { name: { type: 'string', maxLength: 3 } } };

    assert.deepEqual(
      formatBody(schema, { name: 'abcdefghij' }, { maxValueLength: 9 }),
      [createEntry('name', 'abcdefgh…', 'maxLength', 3)],
    );
    assert.deepEqual(
      formatBody(schema, { name: 'abcdefghi' }, { maxValueLength: 9 }),
      [createEntry('name', 'abcdefghi', 'maxLength', 3)],
    );
  });

  test('cuts with truncate() of the project, which does not split a grapheme', () => {
    const value = `${'a'.repeat(MAX_VALUE_LENGTH - 2)}${FAMILY_EMOJI}${'b'.repeat(50)}`;
    const [{ columnValue }] = formatField({ type: 'string', maxLength: 10 }, value);

    assert.equal(columnValue, truncate(value, MAX_VALUE_LENGTH));
    assert.equal(columnValue, `${'a'.repeat(MAX_VALUE_LENGTH - 2)}…`);
  });

  test('reflects a number that is not finite as a string', () => {
    const query = { limit: 'Infinity', offset: '-Infinity' };
    const steps = { type: 'number', enum: [10, 20] };
    const error = failPart('querystring', { type: 'object', properties: { limit: steps, offset: steps } }, query);

    assert.deepEqual(query, { limit: Infinity, offset: -Infinity });
    assert.deepEqual(formatValidation(error, { query }, LIMITS), [
      createEntry('limit', 'Infinity', 'enum', [10, 20]),
      createEntry('offset', '-Infinity', 'enum', [10, 20]),
    ]);
  });

  test('never reflects an object or an array', () => {
    assert.deepEqual(formatField({ type: 'string' }, { first: 'Anna' }), [createEntry('field', null, 'type', 'string')]);
    assert.deepEqual(formatField({ type: 'string' }, ['Anna', 'Maria']), [createEntry('field', null, 'type', 'string')]);
    assert.deepEqual(formatField({ type: 'array', minItems: 2 }, ['Anna']), [createEntry('field', null, 'minItems', 2)]);
    assert.deepEqual(formatField({ type: 'object', minProperties: 1 }, {}), [createEntry('field', null, 'minProperties', 1)]);
  });

  test('answers null for a value nested deeper than JSON.stringify can go', () => {
    const schema = { type: 'object', properties: { field: { type: 'string' } } };
    const body = { field: nestUnderNumericKeys(DEEP_LEVELS, 'leaf') };
    const entries = formatBody(schema, body);

    assert.deepEqual(entries, [createEntry('field', null, 'type', 'string')]);
    assert.deepEqual(JSON.parse(JSON.stringify(entries)), entries);
    assert.doesNotThrow(() => JSON.stringify(formatBody(schema, body, { isDev: true })));
  });

  test('does not reflect the whole part for an error without a column', () => {
    assert.deepEqual(formatBody({ type: 'object' }, 'hunter2'), [createEntry(null, null, 'type', 'object')]);
    assert.deepEqual(formatBody({ type: 'object' }, 5), [createEntry(null, null, 'type', 'object')]);
  });

  test('does not reflect the value of a sensitive field', () => {
    const secret = { type: 'string', minLength: 12 };
    const schema = {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' }, password: secret, accessToken: secret },
    };

    assert.deepEqual(formatBody(schema, { email: 'abc', password: 'hunter2', accessToken: 'abc' }), [
      createEntry('email', 'abc', 'format', 'email'),
      createEntry('password', null, 'minLength', 12),
      createEntry('accessToken', null, 'minLength', 12),
    ]);
  });

  test('does not reflect a value when any segment of its path is a sensitive key', () => {
    const text = { type: 'string', minLength: 3 };
    const session = { type: 'object', properties: { device: text } };
    const schema = {
      type: 'object',
      properties: {
        credentials: { type: 'object', properties: { login: text } },
        tokens: { type: 'array', items: text },
        users: { type: 'array', items: { type: 'object', properties: { session } } },
        profile: { type: 'object', properties: { apiKey: text, name: text } },
      },
    };
    const body = {
      credentials: { login: 'x' },
      tokens: ['a'],
      users: [{ session: { device: 'y' } }],
      profile: { apiKey: 'z', name: 'w' },
    };

    assert.deepEqual(formatBody(schema, body), [
      createEntry('credentials.login', null, 'minLength', 3),
      createEntry('tokens.0', null, 'minLength', 3),
      createEntry('users.0.session.device', null, 'minLength', 3),
      createEntry('profile.apiKey', null, 'minLength', 3),
      createEntry('profile.name', 'w', 'minLength', 3),
    ]);
  });

  test('does not reflect a credential sent in a header', () => {
    const headers = { authorization: 'Basic YWJj', 'x-api-version': '7' };
    const error = failPart('headers', {
      type: 'object',
      properties: {
        authorization: { type: 'string', pattern: '^Bearer ' },
        'x-api-version': { type: 'string', enum: ['1', '2'] },
      },
    }, headers);

    assert.deepEqual(formatValidation(error, { headers }, LIMITS), [
      createEntry('authorization', null, 'pattern', '^Bearer '),
      createEntry('x-api-version', '7', 'enum', ['1', '2']),
    ]);
  });

  test('does not take a dot inside a key for a level of nesting', () => {
    const schema = { type: 'object', properties: { 'a.b': { type: 'string', minLength: 3 }, a: { type: 'object' } } };

    assert.deepEqual(formatBody(schema, { 'a.b': 'x', a: { b: 'nested' } }), [createEntry('a.b', 'x', 'minLength', 3)]);
  });

  test('has nothing to reflect when the request does not have the failed part', () => {
    const error = failPart('querystring', LIMIT_SCHEMA, { limit: '0' });

    [{}, { query: undefined }, { query: null }, { body: { limit: 5 } }].forEach((request) => {
      assert.deepEqual(formatValidation(error, request, LIMITS), [createEntry('limit', null, 'minimum', 1)], inspect(request));
    });
  });
});

describe('formatValidation: operator and operatorValue', () => {
  test('carries the limit of a bound', () => {
    BOUNDS.forEach(([operator, fieldSchema, value, limit]) => {
      assert.deepEqual(readOperators(formatField(fieldSchema, value)), [[operator, limit]]);
    });
  });

  test('keeps a limit of 0', () => {
    ZERO_BOUNDS.forEach(([operator, fieldSchema, value]) => {
      assert.deepEqual(readOperators(formatField(fieldSchema, value)), [[operator, 0]]);
    });
  });

  test('carries the type, the allowed values, the constant, the format, the pattern and the divisor', () => {
    NAMED_VALUES.forEach(([operator, fieldSchema, value, operatorValue]) => {
      assert.deepEqual(formatField(fieldSchema, value), [createEntry('field', value, operator, operatorValue)]);
    });
  });

  test('cuts the allowed values of a long enum at maxListLength', () => {
    const zones = Array.from({ length: MAX_LIST_LENGTH * 3 }, (unused, index) => `zone${index}`);
    const [entry] = formatField({ type: 'string', enum: zones }, 'nowhere');

    assert.equal(entry.operator, 'enum');
    assert.deepEqual(entry.operatorValue, zones.slice(0, MAX_LIST_LENGTH));
  });

  test('keeps a constant that is falsy', () => {
    FALSY_CONSTANTS.forEach(([fieldSchema, value, constant]) => {
      assert.deepEqual(formatField(fieldSchema, value), [createEntry('field', value, 'const', constant)]);
    });
  });

  test('has no value for a keyword that has nothing to compare with', () => {
    VALUELESS_KEYWORDS.forEach(([operator, fieldSchema, value]) => {
      const entry = formatField(fieldSchema, value).find((item) => item.operator === operator);

      assert.notEqual(entry, undefined, operator);
      assert.equal(entry.operatorValue, null, operator);
    });
  });

  test('takes the keyword of a plugin as the operator, without a value', () => {
    const query = { limit: Infinity, page: NaN };
    const error = markSchemaError(new Error('Request is not valid'), [
      {
        instancePath: '/limit',
        schemaPath: '#/properties/limit/finite',
        keyword: 'finite',
        params: {},
        message: 'must be a finite number',
      },
      {
        instancePath: '/page',
        schemaPath: '#/properties/page/finite',
        keyword: 'finite',
        params: {},
        message: 'must be a finite number',
      },
    ], 'querystring');

    assert.deepEqual(formatValidation(error, { query }, LIMITS), [
      createEntry('limit', 'Infinity', 'finite'),
      createEntry('page', 'NaN', 'finite'),
    ]);
  });
});

describe('formatValidation: entries', () => {
  test('builds the entry of the response format', () => {
    assert.deepEqual(formatBody(EMAIL_SCHEMA, { email: 'abc' }), [{
      column: 'email',
      columnValue: 'abc',
      operator: 'format',
      operatorValue: 'email',
    }]);
  });

  test('adds the raw error of AJV as "schema" in dev, and only there', () => {
    const body = { email: 'abc' };
    const error = failPart('body', EMAIL_SCHEMA, body);
    const [ajvError] = error.validation;
    const entry = createEntry('email', 'abc', 'format', 'email');

    assert.deepEqual(Object.keys(ajvError).sort(), ['instancePath', 'keyword', 'message', 'params', 'schemaPath']);
    assert.deepEqual(formatValidation(error, { body }, LIMITS), [entry]);
    assert.deepEqual(formatValidation(error, { body }, { ...LIMITS, isDev: false }), [entry]);
    assert.deepEqual(formatValidation(error, { body }, { ...LIMITS, isDev: true }), [{ ...entry, schema: ajvError }]);
  });

  test('returns no more than maxErrors entries, the first ones', () => {
    const body = Array.from({ length: 50 }, () => 'x');
    const error = failPart('body', INTEGERS_SCHEMA, body);

    assert.equal(error.validation.length, 50);
    assert.deepEqual(
      formatValidation(error, { body }, LIMITS).map((item) => item.column),
      Array.from({ length: MAX_ERRORS }, (unused, index) => String(index)),
    );
    assert.deepEqual(
      formatValidation(error, { body }, { ...LIMITS, maxErrors: 3 }),
      ['0', '1', '2'].map((column) => createEntry(column, 'x', 'type', 'integer')),
    );
  });

  test('skips an item of the list that is not an error object', () => {
    const body = { email: 'abc' };
    const error = failPart('body', EMAIL_SCHEMA, body);
    const [ajvError] = error.validation;

    error.validation = [null, undefined, 'must match format "email"', 5, true, ajvError];

    assert.deepEqual(formatValidation(error, { body }, LIMITS), [createEntry('email', 'abc', 'format', 'email')]);
  });
});

describe('normalizeValidation', () => {
  test('gives the entries of an application the shape of the response format', () => {
    const validation = [{
      column: 'email', columnValue: 'abc', operator: 'unique', operatorValue: 'users', extra: 1,
    }];

    assert.deepEqual(normalizeValidation(validation, LIMITS), [createEntry('email', 'abc', 'unique', 'users')]);
  });

  test('leaves the list of the thrower as it was and returns no more than maxErrors entries, the first ones', () => {
    const validation = Object.freeze(Array.from({ length: 50 }, (unused, index) => Object.freeze({ column: `field${index}`, operator: 'required' })));
    const entries = normalizeValidation(validation, LIMITS);

    assert.equal(validation.length, 50);
    assert.equal(entries.length, MAX_ERRORS);
    assert.deepEqual(entries.at(-1), createEntry('field19', null, 'required'));
  });

  test('skips an item that is not an object', () => {
    const validation = [null, undefined, 'email is taken', 5, ['email'], { column: 'email', operator: 'unique' }];

    assert.deepEqual(normalizeValidation(validation, LIMITS), [createEntry('email', null, 'unique')]);
  });

  test('cuts the column, the value and the operator at the ceiling, and never reflects the value of a sensitive column', () => {
    const long = 'x'.repeat(MAX_VALUE_LENGTH * 2);
    const [entry, secret] = normalizeValidation([
      {
        column: long, columnValue: long, operator: long, operatorValue: long,
      },
      {
        column: 'password', columnValue: 'hunter2', operator: 'minLength', operatorValue: 8,
      },
    ], LIMITS);

    Object.values(entry).forEach((value) => assert.equal(value, truncate(long, MAX_VALUE_LENGTH)));
    assert.deepEqual(secret, createEntry('password', null, 'minLength', 8));
  });

  test('cuts a long item of an operatorValue list like a value of its own', () => {
    const long = 'x'.repeat(MAX_VALUE_LENGTH * 2);
    const [entry] = normalizeValidation([{ column: 'role', operator: 'enum', operatorValue: [long, 5] }], LIMITS);

    assert.deepEqual(entry.operatorValue, [truncate(long, MAX_VALUE_LENGTH), 5]);
  });

  test('keeps no more than maxListLength items of an operatorValue list, the first ones', () => {
    const values = Array.from({ length: MAX_LIST_LENGTH + 10 }, (unused, index) => `value${index}`);
    const [long, fitting] = normalizeValidation([
      { column: 'zone', operator: 'enum', operatorValue: values },
      { column: 'role', operator: 'enum', operatorValue: values.slice(0, MAX_LIST_LENGTH) },
    ], LIMITS);
    const [short] = normalizeValidation([{ column: 'zone', operator: 'enum', operatorValue: values }], { ...LIMITS, maxListLength: 3 });

    assert.deepEqual(long.operatorValue, values.slice(0, MAX_LIST_LENGTH));
    assert.deepEqual(fitting.operatorValue, values.slice(0, MAX_LIST_LENGTH));
    assert.deepEqual(short.operatorValue, ['value0', 'value1', 'value2']);
    assert.equal(values.length, MAX_LIST_LENGTH + 10);
  });

  test('has no operator for what is not a string', () => {
    [5, null, undefined, true, ['min'], { name: 'min' }].forEach((operator) => {
      assert.equal(normalizeValidation([{ column: 'age', operator }], LIMITS)[0].operator, null, inspect(operator));
    });
  });

  test('keeps an operatorValue JSON can write and turns the rest into text or null', () => {
    const circular = {};

    circular.self = circular;

    const cases = [
      [18, 18],
      [0, 0],
      [false, false],
      ['', ''],
      [9007199254740993n, '9007199254740993'],
      [Infinity, 'Infinity'],
      [NaN, 'NaN'],
      [undefined, null],
      [null, null],
      [{ min: 1 }, null],
      [circular, null],
      [nestUnderNumericKeys(DEEP_LEVELS, 1), null],
      [() => 18, null],
      [Symbol('limit'), null],
      [['active', 5, true, null, 10n, { a: 1 }, [1]], ['active', 5, true, null, '10', null, null]],
    ];

    cases.forEach(([operatorValue, expected]) => {
      const [entry] = normalizeValidation([{ column: 'age', operator: 'minimum', operatorValue }], LIMITS);

      assert.deepEqual(entry.operatorValue, expected, inspect(operatorValue, { depth: 0 }));
      assert.doesNotThrow(() => JSON.stringify(entry));
    });
  });

  test('reflects a columnValue the way a schema error does: a primitive, a number JSON has no form for as text', () => {
    const cases = [['abc', 'abc'], [0, 0], [false, false], [10n, '10'], [-Infinity, '-Infinity'], [{ a: 1 }, null], [[1], null]];

    cases.forEach(([columnValue, expected]) => {
      assert.equal(normalizeValidation([{ column: 'age', columnValue }], LIMITS)[0].columnValue, expected, inspect(columnValue));
    });
  });
});

describe('config.app.validation', () => {
  test('caps a response at 20 schema errors and a reflected value at 256 characters', () => {
    const { validation } = createTestConfig().app;
    const body = Array.from({ length: 50 }, () => 'x'.repeat(300));
    const error = failPart('body', INTEGERS_SCHEMA, body);
    const entries = formatValidation(error, { body }, validation);

    assert.equal(entries.length, 20);
    assert.equal(entries[0].columnValue.length, 256);
    assert.equal(validation.maxListLength, 20);

    createSchemaErrorFormatter(validation.maxErrors)(error.validation, 'body');

    assert.equal(error.validation.length, 20);
  });
});
