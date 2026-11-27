import { buildValidator, useSchemaKeywords } from '#core/schema/validator.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { SCHEMA_FORMAT } from '#enums/schema-format.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { PERSON_NAME_MAX_LENGTH } from '#utils/person.js';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const TEXT_PARTS = Object.freeze(['querystring', 'params', 'headers']);

const FORM_MEDIA_TYPES = Object.freeze([
  MEDIA_TYPE.FORM_DATA,
  MEDIA_TYPE.FORM_URLENCODED,
  'Multipart/Form-Data; boundary=----form',
  'application/x-www-form-urlencoded; charset=utf-8',
]);

const OTHER_MEDIA_TYPES = Object.freeze([
  undefined,
  MEDIA_TYPE.JSON,
  'application/vnd.api+json',
  'text/plain',
  MEDIA_TYPE.ANY,
  'not a media type',
]);

const TEXT_VALUES = Object.freeze({ limit: '17', isActive: 'true', ids: '5' });
const TYPED_VALUES = Object.freeze({ limit: 17, isActive: true, ids: [5] });

const JSON_MISMATCHES = Object.freeze([
  [{ type: 'string' }, null],
  [{ type: 'string' }, 17],
  [{ type: 'string' }, false],
  [{ type: 'integer' }, '17'],
  [{ type: 'number' }, '1.5'],
  [{ type: 'boolean' }, 'true'],
  [{ type: 'boolean' }, 0],
  [{ type: 'null' }, ''],
  [{ type: 'array', items: { type: 'integer' } }, 5],
]);

const EMAILS = Object.freeze([
  'anna@example.com',
  'Anna.Koval+news@Example.COM',
  'олена@приклад.укр',
  'josé@exämple.de',
  '用户@例子.中国',
  'anna@mail.example.co.uk',
]);

const NOT_EMAILS = Object.freeze([
  '',
  'anna',
  'anna@',
  '@example.com',
  'anna@example',
  'an na@example.com',
  'anna@@example.com',
  'anna@example..com',
  'anna@.example.com',
  'anna@example.com.',
  'anna\u0000@example.com',
  `${'a'.repeat(250)}@example.com`,
]);

const UTC_DATE_TIMES = Object.freeze([
  '2026-11-20T10:00:00Z',
  '2026-11-20T10:00:00.123Z',
  '2026-11-20T10:00:00.123456789Z',
  '2026-11-20T10:00:00+00:00',
  '2028-02-29T23:59:59Z',
]);

const NOT_UTC_DATE_TIMES = Object.freeze([
  '2026-11-20T10:00:00+03:00',
  '2026-11-20T10:00:00-05:00',
  '2026-11-20T10:00:00-00:00',
  '2026-11-20T10:00:00',
  '2026-11-20',
  '2026-02-30T00:00:00Z',
  '2026-02-29T00:00:00Z',
  '2026-11-20T24:00:00Z',
  '2026-11-20 10:00:00Z',
  '2026-11-20t10:00:00z',
  '2026-11-20T10:00:00.1234567890Z',
  'yesterday',
  '',
]);

const PERSON_NAMES = Object.freeze(["Мар'яна", 'Анна-Марія', 'Müller', "O'Connor", 'Ανδρέας', '山田', 'สมชาย', '지민']);

// Names once trimmed and in plain letters, the form a name is stored in.
const PERSON_NAMES_ONCE_NORMALIZED = Object.freeze(['  Anna  ', '𝕍𝕚𝕣𝕒', 'Ｖｉｒａ']);

const NOT_PERSON_NAMES = Object.freeze([
  '',
  '   ',
  'Anna Maria',
  'Dr. X',
  'Іван2',
  String.fromCodePoint(0x1F600),
  `Anna${String.fromCodePoint(0x1F600)}`,
  'a'.repeat(PERSON_NAME_MAX_LENGTH + 1),
  '-Anna',
  'Anna--Maria',
  '<b>x</b>',
  'anna@example.com',
]);

// A JSON body goes to the validator without coercion, a form and a query to the one with it.
const PERSON_NAME_PARTS = Object.freeze([
  Object.freeze({ httpPart: 'body' }),
  Object.freeze({ httpPart: 'body', contentType: MEDIA_TYPE.FORM_URLENCODED }),
  Object.freeze({ httpPart: 'querystring' }),
]);

const PERSON_NAME_FIELD = Object.freeze({ type: 'string', format: SCHEMA_FORMAT.PERSON_NAME });

const compileValidator = buildValidator();

function createTypedPart() {
  return {
    type: 'object',
    properties: {
      limit: { type: 'integer' },
      isActive: { type: 'boolean' },
      ids: { type: 'array', items: { type: 'integer' } },
    },
  };
}

function createAppKeywordsPart() {
  return {
    type: 'object',
    properties: {
      count: { type: 'number', finite: true },
      profile: { type: 'object', additionalProperties: true, json: true },
      email: { type: 'string', format: 'email' },
      createdAt: { type: 'string', format: 'date-time-utc' },
    },
  };
}

function createFormatsPart() {
  const part = createAppKeywordsPart();

  return { ...part, properties: { ...part.properties, birthday: { type: 'string', format: 'date' } } };
}

function readKeywords(validate) {
  return (validate.errors ?? []).map((error) => error.keyword);
}

// The value sits in a property: AJV can write a coerced value back only into its parent.
function validateField(input, field, value) {
  const validate = compileValidator({ ...input, schema: { type: 'object', properties: { field } } });
  const data = { field: value };
  const isValid = validate(data);

  return { isValid, value: data.field, keywords: readKeywords(validate) };
}

function validateText(input) {
  const validate = compileValidator({ ...input, schema: createTypedPart() });
  const data = { ...TEXT_VALUES };
  const isValid = validate(data);

  return { isValid, data, keywords: readKeywords(validate) };
}

async function createApp(t) {
  const fastify = await buildTestApp();

  t.after(() => fastify.close());

  return fastify;
}

// Fastify parses no form by itself: this parser gives every field as text, as a browser sends it.
function useFormParser(fastify) {
  fastify.addContentTypeParser(MEDIA_TYPE.FORM_URLENCODED, { parseAs: 'string' }, (request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });
}

function describeType(column, columnValue, type) {
  return {
    column,
    columnValue,
    operator: 'type',
    operatorValue: type,
  };
}

function echoBody(request) {
  return request.body;
}

function requestSharedRoutes(fastify, name) {
  return Promise.all([
    fastify.inject({ method: 'POST', url: '/first', payload: { name } }),
    fastify.inject({ method: 'POST', url: '/second', payload: { name } }),
    fastify.inject(`/third?name=${name}`),
    fastify.inject({ method: 'HEAD', url: `/third?name=${name}` }),
  ]);
}

describe('buildValidator', () => {
  test('does not coerce a JSON body: a value of another type is refused and stays as it was sent', () => {
    JSON_MISMATCHES.forEach(([field, value]) => {
      const label = JSON.stringify([field, value]);

      assert.deepEqual(validateField({ httpPart: 'body' }, field, value), { isValid: false, value, keywords: ['type'] }, label);
      assert.deepEqual(validateField({ httpPart: 'body', contentType: MEDIA_TYPE.JSON }, field, value).keywords, ['type'], label);
    });
  });

  test('coerces the query, the path and the headers to the types of the schema', () => {
    TEXT_PARTS.forEach((httpPart) => {
      assert.deepEqual(validateText({ httpPart }), { isValid: true, data: TYPED_VALUES, keywords: [] }, httpPart);
    });
  });

  test('coerces a body of a form media type, in any letter case and with parameters', () => {
    FORM_MEDIA_TYPES.forEach((contentType) => {
      assert.deepEqual(validateText({ httpPart: 'body', contentType }), { isValid: true, data: TYPED_VALUES, keywords: [] }, contentType);
    });
  });

  test('does not coerce a body of any other media type, nor a body without one', () => {
    OTHER_MEDIA_TYPES.forEach((contentType) => {
      const result = validateText({ httpPart: 'body', contentType });

      assert.deepEqual(result, { isValid: false, data: TEXT_VALUES, keywords: ['type', 'type', 'type'] }, String(contentType));
    });
  });

  test('fills defaults, drops what a closed object does not name and reports every error, with and without coercion', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', default: 20 },
        name: { type: 'string', maxLength: 2 },
        age: { type: 'integer', minimum: 18 },
      },
    };

    ['body', 'querystring'].forEach((httpPart) => {
      const validate = compileValidator({ schema, httpPart });
      const data = { name: 'Anna', age: 1, extra: 'dropped' };

      assert.equal(validate(data), false, httpPart);
      assert.deepEqual(readKeywords(validate), ['maxLength', 'minimum'], httpPart);
      assert.deepEqual(data, { name: 'Anna', age: 1, limit: 20 }, httpPart);
    });
  });

  test('compiles the keywords and the formats of the app with and without coercion', () => {
    const valid = {
      count: 1.5,
      profile: { theme: 'dark', nested: { list: [1, 'a'] } },
      email: 'олена@приклад.укр',
      createdAt: '2026-11-20T10:00:00Z',
      birthday: '2000-02-29',
    };
    const invalid = {
      ...valid,
      email: 'olena',
      createdAt: '2026-11-20T10:00:00+03:00',
      birthday: '2001-02-29',
    };

    ['body', 'querystring'].forEach((httpPart) => {
      const validate = compileValidator({ schema: createFormatsPart(), httpPart });

      assert.equal(validate(structuredClone(valid)), true, httpPart);
      assert.equal(validate(structuredClone(invalid)), false, httpPart);
      assert.deepEqual(readKeywords(validate), ['format', 'format', 'format'], httpPart);
    });
  });

  test('takes an e-mail address in any script and refuses what is not one', () => {
    const validate = compileValidator({ schema: { type: 'string', format: 'email' }, httpPart: 'body' });

    EMAILS.forEach((value) => assert.equal(validate(value), true, value));
    NOT_EMAILS.forEach((value) => assert.equal(validate(value), false, value));
  });

  test('takes a date-time in UTC, with Z or +00:00, and refuses another zone, no zone and a day that does not exist', () => {
    const validate = compileValidator({ schema: { type: 'string', format: 'date-time-utc' }, httpPart: 'querystring' });

    UTC_DATE_TIMES.forEach((value) => assert.equal(validate(value), true, value));
    NOT_UTC_DATE_TIMES.forEach((value) => assert.equal(validate(value), false, value));
  });

  test('takes a person name of letters of any script and refuses what is no name, in a JSON body, a form and a query alike', () => {
    PERSON_NAME_PARTS.forEach((input) => {
      const validate = compileValidator({ ...input, schema: PERSON_NAME_FIELD });
      const label = JSON.stringify(input);

      PERSON_NAMES.forEach((value) => assert.equal(validate(value), true, `${label}: ${value}`));
      NOT_PERSON_NAMES.forEach((value) => assert.equal(validate(value), false, `${label}: ${value}`));
    });
  });

  test('checks a person name as it is stored, trimmed and in plain letters, and leaves the value as it came', () => {
    PERSON_NAME_PARTS.forEach((input) => {
      PERSON_NAMES_ONCE_NORMALIZED.forEach((value) => {
        assert.deepEqual(validateField(input, PERSON_NAME_FIELD, value), { isValid: true, value, keywords: [] }, `${JSON.stringify(input)}: ${value}`);
      });
    });
  });

  test('takes only a boolean for the json marker', () => {
    ['body', 'querystring'].forEach((httpPart) => {
      assert.doesNotThrow(() => compileValidator({ schema: { type: 'object', json: false }, httpPart }), httpPart);
      assert.throws(() => compileValidator({ schema: { type: 'object', json: 'yes' }, httpPart }), /json value must be/, httpPart);
    });
  });

  test('adds the shared schemas of a scope to both kinds of part', () => {
    const compile = buildValidator({ limit: { $id: 'limit', type: 'integer', minimum: 1 } });
    const schema = { type: 'object', properties: { limit: { $ref: 'limit#' } } };
    const body = compile({ schema, httpPart: 'body' });
    const query = compile({ schema, httpPart: 'querystring' });
    const text = { limit: '5' };

    assert.equal(body({ limit: '5' }), false);
    assert.equal(body({ limit: 5 }), true);
    assert.equal(body({ limit: 0 }), false);
    assert.equal(query(text), true);
    assert.deepEqual(text, { limit: 5 });
    assert.equal(query({ limit: '0' }), false);
  });

  test('hands back the compiled shared schema for a schema that carries its $id', () => {
    const shared = { $id: 'item', type: 'object', properties: { name: { type: 'string', maxLength: 10 } } };
    const compile = buildValidator({ item: shared });
    const first = compile({ schema: shared, httpPart: 'body' });
    const second = compile({ schema: structuredClone(shared), httpPart: 'body' });

    assert.equal(second, first);
    assert.equal(first({ name: 'Anna' }), true);
    assert.equal(first({ name: 17 }), false);
  });

  test('compiles a schema with an $id no scope shares as often as a route brings it, each time by its own rules', () => {
    const compile = buildValidator();
    const wide = { $id: 'createItem', type: 'object', properties: { name: { type: 'string', maxLength: 10 } } };
    const narrow = { ...wide, properties: { name: { type: 'string', maxLength: 5 } } };
    const validators = [wide, structuredClone(wide), narrow].map((schema) => compile({ schema, httpPart: 'body' }));

    assert.deepEqual(validators.map((validate) => validate({ name: 'Abcdefg' })), [true, true, false]);
  });

  test('compiles a boolean schema', () => {
    assert.equal(compileValidator({ schema: true, httpPart: 'body' })({ any: 1 }), true);
    assert.equal(compileValidator({ schema: false, httpPart: 'querystring' })({}), false);
  });

  test('lets AJV refuse a schema it cannot compile', () => {
    assert.throws(() => compileValidator({ schema: { type: 'text' }, httpPart: 'body' }), /schema is invalid/);
    assert.throws(() => compileValidator({ schema: { type: 'string', format: 'phone' }, httpPart: 'querystring' }), /unknown format "phone"/);
  });

  test('requires the shared schemas of a scope as an object', () => {
    [null, 'limit', 5, [], [{ $id: 'limit', type: 'integer' }]].forEach((externalSchemas) => {
      assert.throws(
        () => buildValidator(externalSchemas),
        { name: 'TypeError', message: /requires the shared schemas of a scope as an object/ },
        JSON.stringify(externalSchemas),
      );
    });
    assert.equal(typeof buildValidator(), 'function');
    assert.equal(typeof buildValidator({}), 'function');
  });
});

describe('useSchemaKeywords', () => {
  test('gives an instance of AJV the keywords and the formats of the app, and returns it', () => {
    const ajv = new Ajv({ allErrors: true, coerceTypes: true });

    assert.equal(useSchemaKeywords(ajv), ajv);

    const validate = ajv.compile(createAppKeywordsPart());

    assert.equal(validate({ count: '1.5', email: 'олена@приклад.укр', createdAt: '2026-11-20T10:00:00+00:00' }), true);
    assert.equal(validate({ count: '1e400', email: 'olena', createdAt: '2026-11-20T10:00:00' }), false);
    assert.deepEqual(readKeywords(validate), ['finite', 'format', 'format']);
  });

  test('puts its e-mail format in place of the ASCII-only one of ajv-formats', () => {
    const schema = { type: 'string', format: 'email' };

    assert.equal(addFormats(new Ajv()).validate(schema, 'олена@приклад.укр'), false);
    assert.equal(useSchemaKeywords(addFormats(new Ajv())).validate(schema, 'олена@приклад.укр'), true);
  });

  test('gives an instance of AJV the person-name format, which ajv-formats does not know', () => {
    assert.throws(() => addFormats(new Ajv()).compile(PERSON_NAME_FIELD), new RegExp(`unknown format "${SCHEMA_FORMAT.PERSON_NAME}"`));

    const validate = useSchemaKeywords(addFormats(new Ajv())).compile(PERSON_NAME_FIELD);

    assert.deepEqual(PERSON_NAMES.map((value) => validate(value)), PERSON_NAMES.map(() => true));
    assert.deepEqual(NOT_PERSON_NAMES.map((value) => validate(value)), NOT_PERSON_NAMES.map(() => false));
  });

  test('requires an instance of AJV', () => {
    [undefined, null, {}, 'ajv', { addKeyword: () => true }, { addFormat: () => true }].forEach((value) => {
      assert.throws(() => useSchemaKeywords(value), { name: 'TypeError', message: /requires an instance of AJV/ }, String(value));
    });
  });

  test('throws when it is given the same instance twice', () => {
    const ajv = useSchemaKeywords(new Ajv());

    assert.throws(() => useSchemaKeywords(ajv), /already defined/);
  });
});

describe('validator in the app', () => {
  test('answers 422 with a type entry to a JSON body of other types, and never reaches the handler', async (t) => {
    const fastify = await createApp(t);
    const received = [];
    const body = {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 50 },
        age: { type: 'integer' },
        isActive: { type: 'boolean' },
      },
    };

    fastify.post('/items', { schema: { body } }, (request) => {
      received.push(request.body);

      return { isReached: true };
    });

    const [nulled, numbered] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/items', payload: { name: null, age: '17', isActive: 'true' } }),
      fastify.inject({ method: 'POST', url: '/items', payload: { name: 17 } }),
    ]);

    assert.equal(nulled.statusCode, 422);
    assert.deepEqual(nulled.json().validation, [
      describeType('name', null, 'string'),
      describeType('age', '17', 'integer'),
      describeType('isActive', 'true', 'boolean'),
    ]);
    assert.equal(numbered.statusCode, 422);
    assert.deepEqual(numbered.json().validation, [describeType('name', 17, 'string')]);
    assert.deepEqual(received, []);
  });

  test('passes a JSON body of the declared types to the handler as it came', async (t) => {
    const fastify = await createApp(t);
    const payload = { name: 'Anna', age: 17, isActive: false };
    const body = {
      type: 'object',
      properties: {
        name: { type: ['string', 'null'], maxLength: 50 },
        age: { type: 'integer' },
        isActive: { type: 'boolean' },
      },
    };

    fastify.post('/items', { schema: { body } }, echoBody);

    const [typed, nulled] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/items', payload }),
      fastify.inject({ method: 'POST', url: '/items', payload: { ...payload, name: null } }),
    ]);

    assert.deepEqual([typed.statusCode, typed.json()], [200, payload]);
    assert.deepEqual([nulled.statusCode, nulled.json()], [200, { ...payload, name: null }]);
  });

  test('coerces the query, the path and the headers', async (t) => {
    const fastify = await createApp(t);
    const schema = {
      params: { type: 'object', properties: { id: { type: 'integer' } } },
      querystring: createTypedPart(),
      headers: { type: 'object', properties: { 'x-page': { type: 'integer' } } },
    };

    fastify.get('/items/:id', { schema }, (request) => ({
      id: request.params.id,
      ...request.query,
      page: request.headers['x-page'],
    }));

    const response = await fastify.inject({ url: '/items/17?limit=5&isActive=true&ids=3', headers: { 'x-page': '2' } });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      id: 17,
      limit: 5,
      isActive: true,
      ids: [3],
      page: 2,
    });
  });

  // Fastify lowers the names of a headers schema only for its own compiler, and Node gives every name in lower case.
  test('refuses at startup a header that the schema names in capitals, and matches one named in lower case', async (t) => {
    const fastify = await createApp(t);
    const lower = { type: 'object', required: ['x-page'], properties: { 'x-page': { type: 'integer' } } };
    const named = { type: 'object', properties: { 'X-Page': { type: 'integer' } } };
    const required = { type: 'object', required: ['X-Page'] };

    fastify.get('/items', { schema: { headers: lower } }, (request) => ({ page: request.headers['x-page'] }));

    assert.throws(() => fastify.get('/named', { schema: { headers: named } }, echoBody), /names the header "X-Page": write it in lower case, "x-page"/);
    assert.throws(() => fastify.get('/required', { schema: { headers: required } }, echoBody), /Route GET \/required: "headers" # names the header "X-Page"/);

    const response = await fastify.inject({ url: '/items', headers: { 'X-Page': '2' } });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { page: 2 });
  });

  test('coerces a form body declared by media type and leaves the JSON entry of the same body as it came', async (t) => {
    const fastify = await createApp(t);
    const body = {
      content: {
        [MEDIA_TYPE.FORM_URLENCODED]: { schema: createTypedPart() },
        [MEDIA_TYPE.JSON]: { schema: createTypedPart() },
      },
    };

    useFormParser(fastify);
    fastify.post('/items', { schema: { body } }, echoBody);

    const [form, textJson, typedJson] = await Promise.all([
      fastify.inject({
        method: 'POST',
        url: '/items',
        payload: new URLSearchParams(TEXT_VALUES).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      }),
      fastify.inject({ method: 'POST', url: '/items', payload: TEXT_VALUES }),
      fastify.inject({ method: 'POST', url: '/items', payload: TYPED_VALUES }),
    ]);

    assert.deepEqual([form.statusCode, form.json()], [200, TYPED_VALUES]);
    assert.equal(textJson.statusCode, 422);
    assert.deepEqual(textJson.json().validation, [
      describeType('limit', '17', 'integer'),
      describeType('isActive', 'true', 'boolean'),
      describeType('ids', '5', 'array'),
    ]);
    assert.deepEqual([typedJson.statusCode, typedJson.json()], [200, TYPED_VALUES]);
  });

  test('validates a body and a query through a shared schema of fastify.addSchema', async (t) => {
    const fastify = await createApp(t);
    const part = { type: 'object', properties: { limit: { $ref: 'limit#' } } };

    fastify.addSchema({
      $id: 'limit',
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
    fastify.post('/items', { schema: { body: part } }, echoBody);
    fastify.get('/items', { schema: { querystring: part } }, (request) => request.query);

    const [textBody, typedBody, query, largeQuery] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/items', payload: { limit: '5' } }),
      fastify.inject({ method: 'POST', url: '/items', payload: { limit: 5 } }),
      fastify.inject('/items?limit=5'),
      fastify.inject('/items?limit=500'),
    ]);

    assert.equal(textBody.statusCode, 422);
    assert.deepEqual(textBody.json().validation, [describeType('limit', '5', 'integer')]);
    assert.deepEqual([typedBody.statusCode, typedBody.json()], [200, { limit: 5 }]);
    assert.deepEqual([query.statusCode, query.json()], [200, { limit: 5 }]);
    assert.equal(largeQuery.statusCode, 422);
    assert.deepEqual(largeQuery.json().validation, [{
      column: 'limit',
      columnValue: 500,
      operator: 'maximum',
      operatorValue: 100,
    }]);
  });

  test('compiles every route that brings one schema with an $id, in a body and in a query alike', async (t) => {
    const fastify = await createApp(t);
    const shared = { $id: 'itemFilter', type: 'object', properties: { name: { type: 'string', maxLength: 5 } } };

    fastify.post('/first', { schema: { body: shared } }, echoBody);
    fastify.post('/second', { schema: { body: shared } }, echoBody);
    fastify.get('/third', { schema: { querystring: shared } }, (request) => request.query);

    await fastify.ready();

    const [rejected, accepted] = await Promise.all([requestSharedRoutes(fastify, 'Anastasia'), requestSharedRoutes(fastify, 'Anna')]);

    assert.deepEqual(rejected.map((response) => response.statusCode), [422, 422, 422, 422]);
    assert.deepEqual(accepted.map((response) => response.statusCode), [200, 200, 200, 200]);
  });

  test('keeps the gate and the finite guard of a route whose part is itself a shared schema', async (t) => {
    const fastify = await createApp(t);
    const page = {
      $id: 'page',
      type: 'object',
      properties: {
        limit: { type: 'integer', maximum: 100 },
        code: { type: 'string', maxLength: 5, pattern: '^[a-z]+$' },
      },
    };

    fastify.addSchema(page);
    fastify.get('/items', { schema: { querystring: page } }, (request) => ({ limit: String(request.query.limit) }));

    const response = await fastify.inject(`/items?limit=Infinity&code=${'A'.repeat(1000)}`);

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json().validation.map(({ column, operator }) => [column, operator]), [['limit', 'finite'], ['code', 'maxLength']]);
  });

  test('gates a shared schema that a JSON body reaches by $ref: a value over the limit gets the limit alone', async (t) => {
    const fastify = await createApp(t);

    fastify.addSchema({
      $id: 'code', type: 'string', maxLength: 5, pattern: '^[a-z]+$',
    });
    fastify.post('/items', {
      schema: { body: { type: 'object', properties: { code: { $ref: 'code#' } } } },
    }, (request) => ({ code: request.body.code }));

    const [long, short] = await Promise.all([
      fastify.inject({ method: 'POST', url: '/items', payload: { code: 'A'.repeat(1000) } }),
      fastify.inject({ method: 'POST', url: '/items', payload: { code: 'AB' } }),
    ]);

    assert.equal(long.statusCode, 422);
    assert.deepEqual(long.json().validation.map(({ column, operator }) => [column, operator]), [['code', 'maxLength']]);
    assert.equal(short.statusCode, 422);
    assert.deepEqual(short.json().validation.map(({ column, operator }) => [column, operator]), [['code', 'pattern']]);
  });

  // A shared schema may serve a response only, where a format without a length limit is common.
  test('starts with a shared schema that has a pattern, a format or uniqueItems without a limit, and leaves it ungated', async (t) => {
    const fastify = await createApp(t);

    fastify.addSchema({
      $id: 'loose',
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^[a-z]+$' },
        at: { type: 'string', format: 'date' },
        tags: { type: 'array', uniqueItems: true, items: { type: 'string', maxLength: 10 } },
      },
    });
    fastify.post('/items', {
      schema: { body: { type: 'object', properties: { item: { $ref: 'loose#' } } } },
    }, (request) => request.body);

    await fastify.ready();

    const response = await fastify.inject({ method: 'POST', url: '/items', payload: { item: { code: 'A1' } } });

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json().validation.map(({ column, operator }) => [column, operator]), [['item.code', 'pattern']]);
  });

  test('answers 422 with a format entry to what is no person name in a JSON body, a form and a query, and passes a name of any script as it came', async (t) => {
    const fastify = await createApp(t);
    const part = { type: 'object', properties: { firstName: { ...PERSON_NAME_FIELD, maxLength: PERSON_NAME_MAX_LENGTH } } };
    const body = { content: { [MEDIA_TYPE.JSON]: { schema: part }, [MEDIA_TYPE.FORM_URLENCODED]: { schema: part } } };

    useFormParser(fastify);
    fastify.post('/people', { schema: { body } }, echoBody);
    fastify.get('/people', { schema: { querystring: part } }, (request) => request.query);

    function send(firstName) {
      return Promise.all([
        fastify.inject({ method: 'POST', url: '/people', payload: { firstName } }),
        fastify.inject({
          method: 'POST',
          url: '/people',
          payload: new URLSearchParams({ firstName }).toString(),
          headers: { 'content-type': MEDIA_TYPE.FORM_URLENCODED },
        }),
        fastify.inject({ url: '/people', query: { firstName } }),
      ]);
    }

    const [taken, refused] = await Promise.all([send('Ольга'), send('Dr. X')]);
    const entry = {
      column: 'firstName',
      columnValue: 'Dr. X',
      operator: 'format',
      operatorValue: SCHEMA_FORMAT.PERSON_NAME,
    };

    assert.deepEqual(taken.map((response) => [response.statusCode, response.json()]), taken.map(() => [200, { firstName: 'Ольга' }]));
    assert.deepEqual(refused.map((response) => [response.statusCode, response.json().validation]), refused.map(() => [422, [entry]]));
  });
});
