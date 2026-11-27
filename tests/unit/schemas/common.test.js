import { PAGINATION as PAGINATION_CONFIG } from '#config/pagination.js';
import { SCHEMA_LIMITS } from '#config/schema.js';
import { createEnvelope } from '#core/response/index.js';
import { createSchema } from '#core/schema/create-schema.js';
import { assertRouteContract } from '#core/schema/route.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { SCHEMA_FORMAT } from '#enums/schema-format.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { errorEnvelope, listEnvelope, successEnvelope } from '#schemas/common/envelope.js';
import {
  dateTimeUtc,
  email,
  enumOf,
  isoDate,
  json,
  nullable,
  omitFields,
  personName,
  pickFields,
  text,
  uuid,
  withDescription,
  withoutNull,
} from '#schemas/common/field.js';
import { pagination } from '#schemas/common/pagination.js';
import * as paginationSchema from '#schemas/common/pagination.js';
import { PRIMITIVE_TYPES, primitiveOrList, validation } from '#schemas/common/validation.js';
import { UUID_REGEXP, uuidv7 } from '#utils/id.js';
import { freezeDeep, omit } from '#utils/object.js';
import { PERSON_NAME_MAX_LENGTH } from '#utils/person.js';
import { isArray, isNonEmptyString, isObject } from '#utils/type.js';
import { EMAIL_MAX_LENGTH } from '#utils/validate.js';
import fastJson from 'fast-json-stringify';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const REQUEST_ID = '019a0000-0000-7000-8000-000000000000';
const CANONICAL_ID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b';
const NIL_ID = '00000000-0000-0000-0000-000000000000';

const ISO_DAY = '2026-11-19';
const LONGEST_UTC_DATE_TIME = '2026-11-20T10:00:00.123456789+00:00';
const EMAIL_DOMAIN = '@example.com';

const STATUSES = Object.freeze(['active', 'blocked']);

const NAME_COLUMN_LENGTH = 100;
const PERSON_NAMES = Object.freeze(["Мар'яна", 'Анна-Марія', 'Müller', "O'Connor", 'Ανδρέας', '山田', 'สมชาย', '지민']);
const EMOJI = String.fromCodePoint(0x1F600);

const PERSON_FIELDS = freezeDeep({
  id: uuid('Person id'),
  email: email('Email'),
  firstName: text('First name', { maxLength: 100 }),
  status: enumOf(STATUSES, 'Status'),
});

const PROFILE = Object.freeze({
  theme: 'dark',
  nested: Object.freeze({
    tags: Object.freeze(['a', 'b']),
    counts: Object.freeze({ a: 1 }),
    isSet: false,
    empty: null,
  }),
});

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

// Each payload as the JSON body of a route that echoes it, through the validator of the app.
async function postFields(t, properties, payloads) {
  const fastify = await buildTestApp();

  t.after(() => fastify.close());
  fastify.post('/fields', { schema: { body: { type: 'object', properties } } }, (request) => request.body);

  return Promise.all(payloads.map((payload) => fastify.inject({ method: 'POST', url: '/fields', payload })));
}

function readFailures(response) {
  assert.equal(response.statusCode, 422, response.body);

  return response.json().validation.map(({ column, operator }) => [column, operator]);
}

function readLimits(response) {
  assert.equal(response.statusCode, 422, response.body);

  return response.json().validation.map(({ column, operator, operatorValue }) => [column, operator, operatorValue]);
}

function createEmail(length) {
  return `${'a'.repeat(length - EMAIL_DOMAIN.length)}${EMAIL_DOMAIN}`;
}

describe('uuid', () => {
  test('describes a string with a pattern and the length of the canonical form', () => {
    assert.deepEqual(uuid(), { type: 'string', maxLength: CANONICAL_ID.length, pattern: UUID_REGEXP.source });
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
  test('describes a string in the email format of the app, as long as the longest address it takes', () => {
    assert.deepEqual(email(), { type: 'string', maxLength: EMAIL_MAX_LENGTH, format: 'email' });
  });

  test('carries a description only when one is given', () => {
    assert.equal(Object.hasOwn(email(), 'description'), false);
    assert.deepEqual(email('Email'), { ...email(), description: 'Email' });
  });
});

describe('dateTimeUtc', () => {
  test('describes a string in the UTC date-time format, as long as the longest form it reads', () => {
    assert.deepEqual(dateTimeUtc(), { type: 'string', maxLength: LONGEST_UTC_DATE_TIME.length, format: 'date-time-utc' });
  });

  test('carries a description only when one is given', () => {
    assert.equal(Object.hasOwn(dateTimeUtc(), 'description'), false);
    assert.deepEqual(dateTimeUtc('Created at'), { ...dateTimeUtc(), description: 'Created at' });
  });
});

describe('isoDate', () => {
  test('describes a string in the date format, as long as a date', () => {
    assert.deepEqual(isoDate(), { type: 'string', maxLength: ISO_DAY.length, format: 'date' });
  });

  test('carries a description only when one is given', () => {
    assert.equal(Object.hasOwn(isoDate(), 'description'), false);
    assert.deepEqual(isoDate('Birthday'), { ...isoDate(), description: 'Birthday' });
  });

  test('takes a date of the calendar only, and answers a date-time with the error of the length alone', async (t) => {
    const [leapDay, day, missingDay, dotted, dateTime] = await postFields(t, { day: isoDate() }, [
      { day: '2024-02-29' },
      { day: ISO_DAY },
      { day: '2026-02-29' },
      { day: '19.11.2026' },
      { day: `${ISO_DAY}T10:00:00Z` },
    ]);

    assert.deepEqual([leapDay.statusCode, day.statusCode], [200, 200]);
    assert.deepEqual(day.json(), { day: ISO_DAY });
    assert.deepEqual(readFailures(missingDay), [['day', 'format']]);
    assert.deepEqual(readFailures(dotted), [['day', 'format']]);
    assert.deepEqual(readLimits(dateTime), [['day', 'maxLength', ISO_DAY.length]]);
  });
});

describe('text', () => {
  test('describes a string of 1 to SCHEMA_LIMITS.textMaxLength characters when no lengths are given', () => {
    assert.deepEqual(text(), { type: 'string', minLength: 1, maxLength: SCHEMA_LIMITS.textMaxLength });
  });

  test('takes the lengths of a column, an empty text among them when it is asked for', () => {
    assert.deepEqual(text(undefined, { maxLength: 100 }), { type: 'string', minLength: 1, maxLength: 100 });
    assert.deepEqual(text(undefined, { minLength: 0, maxLength: 10 }), { type: 'string', minLength: 0, maxLength: 10 });
    assert.deepEqual(text(undefined, { minLength: 2, maxLength: 2 }), { type: 'string', minLength: 2, maxLength: 2 });
  });

  test('refuses lengths that are not whole numbers, a maxLength of 0 and a minLength above the maxLength', () => {
    const invalid = [
      { minLength: -1 },
      { minLength: 1.5 },
      { minLength: '1' },
      { minLength: null },
      { minLength: SCHEMA_LIMITS.textMaxLength + 1 },
      { maxLength: 0 },
      { maxLength: 2.5 },
      { maxLength: Infinity },
      { maxLength: '100' },
      { maxLength: null },
      { minLength: 5, maxLength: 4 },
    ];

    invalid.forEach((options) => {
      assert.throws(() => text('Name', options), { name: 'TypeError', message: /^text\(/ }, String(Object.values(options)));
    });
  });

  test('carries a description only when one is given', () => {
    assert.equal(Object.hasOwn(text(), 'description'), false);
    assert.deepEqual(text('Name', { maxLength: 100 }), { ...text(undefined, { maxLength: 100 }), description: 'Name' });
  });

  test('refuses in a request an empty text, one over its maxLength, and null unless the field is nullable', async (t) => {
    const properties = { name: text('Name'), nickname: nullable(text('Nickname', { maxLength: 3 })) };
    const [longest, empty, tooLong, cleared] = await postFields(t, properties, [
      { name: 'a'.repeat(SCHEMA_LIMITS.textMaxLength), nickname: 'abc' },
      { name: '', nickname: '' },
      { name: 'a'.repeat(SCHEMA_LIMITS.textMaxLength + 1), nickname: 'abcd' },
      { name: null, nickname: null },
    ]);

    assert.equal(longest.statusCode, 200);
    assert.deepEqual(readFailures(empty), [['name', 'minLength'], ['nickname', 'minLength']]);
    assert.deepEqual(readLimits(tooLong), [['name', 'maxLength', SCHEMA_LIMITS.textMaxLength], ['nickname', 'maxLength', 3]]);
    assert.deepEqual(readFailures(cleared), [['name', 'type']]);
  });
});

describe('personName', () => {
  test('describes a text of 1 to SCHEMA_LIMITS.textMaxLength characters in the person-name format when no length is given', () => {
    assert.deepEqual(personName(), {
      type: 'string',
      minLength: 1,
      maxLength: SCHEMA_LIMITS.textMaxLength,
      format: SCHEMA_FORMAT.PERSON_NAME,
    });
  });

  test('takes the maxLength of a column, which may be longer than a name', () => {
    assert.deepEqual(personName(undefined, { maxLength: NAME_COLUMN_LENGTH }), { ...personName(), maxLength: NAME_COLUMN_LENGTH });
  });

  test('refuses a maxLength that is not a whole positive number', () => {
    [0, -1, 2.5, Infinity, '100', null].forEach((maxLength) => {
      assert.throws(() => personName('Name', { maxLength }), { name: 'TypeError', message: /maxLength/ }, String(maxLength));
    });
  });

  test('carries a description only when one is given', () => {
    assert.equal(Object.hasOwn(personName(), 'description'), false);
    assert.deepEqual(personName('First name'), { ...personName(), description: 'First name' });
  });

  test('takes in a request one word of letters of any script, checked as it is stored, and keeps it as it came', async (t) => {
    const accepted = [...PERSON_NAMES, '  Anna  ', '𝕍𝕚𝕣𝕒', 'a'.repeat(PERSON_NAME_MAX_LENGTH)];
    const responses = await postFields(t, { name: personName('Name') }, accepted.map((name) => ({ name })));

    assert.deepEqual(responses.map((response) => [response.statusCode, response.json()]), accepted.map((name) => [200, { name }]));
  });

  test('refuses in a request a title with a dot, a word with a digit, an emoji, two words and a name over PERSON_NAME_MAX_LENGTH characters by the format', async (t) => {
    const refused = ['Dr. X', 'Іван2', EMOJI, 'Anna Maria', 'a'.repeat(PERSON_NAME_MAX_LENGTH + 1), '-Anna'];
    const responses = await postFields(t, { name: personName('Name') }, refused.map((name) => ({ name })));

    assert.deepEqual(responses.map((response) => readFailures(response)), refused.map(() => [['name', 'format']]));
  });

  test('answers a value over its maxLength with the error of the length alone, and lets null through a nullable one', async (t) => {
    const properties = { name: personName('Name'), lastName: nullable(personName('Last name', { maxLength: NAME_COLUMN_LENGTH })) };
    const [tooLong, cleared] = await postFields(t, properties, [
      { name: 'a'.repeat(SCHEMA_LIMITS.textMaxLength + 1), lastName: 'a'.repeat(NAME_COLUMN_LENGTH + 1) },
      { name: 'Anna', lastName: null },
    ]);

    assert.deepEqual(readLimits(tooLong), [['name', 'maxLength', SCHEMA_LIMITS.textMaxLength], ['lastName', 'maxLength', NAME_COLUMN_LENGTH]]);
    assert.deepEqual([cleared.statusCode, cleared.json()], [200, { name: 'Anna', lastName: null }]);
  });
});

describe('enumOf', () => {
  test('describes a string out of a list of values', () => {
    assert.deepEqual(enumOf(STATUSES), { type: 'string', enum: ['active', 'blocked'] });
  });

  test('keeps a copy of the list: a change to the list later does not reach the schema', () => {
    const values = [...STATUSES];
    const schema = enumOf(values);

    values.push('deleted');

    assert.deepEqual(schema.enum, STATUSES);
  });

  test('refuses a list that is empty, holds what is not a string or holds a value twice', () => {
    const invalid = [undefined, null, 'active', {}, [], [1], ['active', null], ['active', 'active']];

    invalid.forEach((values) => {
      assert.throws(() => enumOf(values), { name: 'TypeError', message: /^enumOf\(/ }, JSON.stringify(values));
    });
  });

  test('carries a description only when one is given', () => {
    assert.equal(Object.hasOwn(enumOf(STATUSES), 'description'), false);
    assert.deepEqual(enumOf(STATUSES, 'Status'), { ...enumOf(STATUSES), description: 'Status' });
  });

  test('refuses in a request a value outside the list, in another case, and a number in place of one', async (t) => {
    const [active, unknown, upperCase, number] = await postFields(t, { status: enumOf(STATUSES) }, [
      { status: 'active' },
      { status: 'deleted' },
      { status: 'ACTIVE' },
      { status: 1 },
    ]);

    assert.equal(active.statusCode, 200);
    assert.deepEqual(readFailures(unknown), [['status', 'enum']]);
    assert.deepEqual(readFailures(upperCase), [['status', 'enum']]);
    assert.deepEqual(readFailures(number), [['status', 'type'], ['status', 'enum']]);
  });
});

describe('json', () => {
  test('describes an object of any keys, with the marker that AJV and the route contract read', () => {
    assert.deepEqual(json(), { type: 'object', additionalProperties: true, json: true });
  });

  test('carries a description only when one is given', () => {
    assert.equal(Object.hasOwn(json(), 'description'), false);
    assert.deepEqual(json('Profile'), { ...json(), description: 'Profile' });
  });

  test('lets an object of any depth through a request as it is, and refuses what is not an object', async (t) => {
    const [kept, list, word, number, empty] = await postFields(t, { profile: json('Profile') }, [
      { profile: PROFILE },
      { profile: ['dark'] },
      { profile: 'dark' },
      { profile: 1 },
      { profile: null },
    ]);

    assert.equal(kept.statusCode, 200);
    assert.deepEqual(kept.json(), { profile: PROFILE });
    [list, word, number, empty].forEach((response) => assert.deepEqual(readFailures(response), [['profile', 'type']]));
  });

  test('passes the route contract as a named field of data, also a nullable or a nested one, and nowhere else', () => {
    const named = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        profile: json('Profile'),
        settings: nullable(json('Settings')),
        owner: { type: 'object', properties: { profile: json('Profile') } },
      },
    };
    const refused = {
      data: successEnvelope(json()),
      'nullable data': successEnvelope(nullable(json())),
      'the items of data': successEnvelope({ type: 'array', items: json() }),
      'the rows of a list': listEnvelope(json()),
      'a map of any keys': successEnvelope({ type: 'object', additionalProperties: json() }),
      'a map of a pattern': successEnvelope({ type: 'object', patternProperties: { '^meta_': json() } }),
    };

    assert.doesNotThrow(() => assertRouteContract(createRoute(successEnvelope(named))));
    Object.entries(refused).forEach(([name, response]) => {
      assert.throws(() => assertRouteContract(createRoute(response)), /data/, name);
    });
  });

  test('goes out whole as a field of a response, while the fields around it are filtered', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const data = { type: 'object', properties: { id: { type: 'integer' }, profile: json('Profile') } };

    fastify.get('/api/v1/profiles', {
      schema: { response: { 200: successEnvelope(data) } },
      security: PUBLIC,
    }, (request, reply) => reply.ok({ id: 1, profile: PROFILE, passwordHash: '$argon2id$stored-hash' }));

    const response = await fastify.inject('/api/v1/profiles');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { id: 1, profile: PROFILE });
  });
});

describe('withoutNull', () => {
  test('takes "null" out of the type and null out of the enum, the reverse of nullable()', () => {
    const status = enumOf(['active', 'blocked'], 'Status');

    assert.deepEqual(withoutNull(nullable(status)), status);
    assert.deepEqual(withoutNull({ type: ['integer', 'null'], minimum: 0 }), { type: 'integer', minimum: 0 });
    assert.deepEqual(withoutNull({ type: ['string', 'integer', 'null'] }), { type: ['string', 'integer'] });
    assert.deepEqual(withoutNull(text('Name')), text('Name'));
  });

  test('leaves a field without a type as it is and does not change a frozen input', () => {
    const typeless = freezeDeep({ minimum: 0 });
    const frozen = freezeDeep(nullable(text('Name')));

    assert.deepEqual(withoutNull(typeless), typeless);
    assert.deepEqual(withoutNull(frozen), text('Name'));
    assert.deepEqual(frozen.type, ['string', 'null']);
  });

  test('refuses what is not the schema of a field', () => {
    [undefined, null, 'string', ['string']].forEach((field, index) => {
      assert.throws(() => withoutNull(field), { name: 'TypeError', message: /withoutNull\(field\) requires the schema of a field/ }, String(index));
    });
  });
});

describe('nullable', () => {
  test('adds null to the type of a field and keeps the rest of it', () => {
    assert.deepEqual(nullable(text('Name', { maxLength: 100 })), { ...text('Name', { maxLength: 100 }), type: ['string', 'null'] });
    assert.deepEqual(nullable({ type: ['string', 'integer'] }), { type: ['string', 'integer', 'null'] });
  });

  test('adds null to an enum as well: AJV checks the list after the type', () => {
    assert.deepEqual(nullable(enumOf(STATUSES, 'Status')), { type: ['string', 'null'], enum: ['active', 'blocked', null], description: 'Status' });
  });

  test('changes nothing in a field that takes null already', () => {
    const field = nullable(enumOf(STATUSES));
    const openObject = { type: ['null', 'object'], additionalProperties: true };

    assert.deepEqual(nullable(field), field);
    assert.deepEqual(nullable(openObject), openObject);
  });

  test(
    'adds null to the enum of a field whose type takes null already',
    () => {
      assert.deepEqual(nullable({ type: ['string', 'null'], enum: STATUSES }), { type: ['string', 'null'], enum: ['active', 'blocked', null] });
    },
  );

  test(
    'lists null once in an enum that holds it already',
    () => {
      assert.deepEqual(nullable({ type: 'string', enum: ['active', null] }), { type: ['string', 'null'], enum: ['active', null] });
    },
  );

  test('leaves the field it is given as it was', () => {
    const field = freezeDeep(enumOf(STATUSES));

    assert.notEqual(nullable(field), field);
    assert.deepEqual(field, enumOf(STATUSES));
  });

  test('refuses what is not the schema of a field that names its type', () => {
    const invalid = [undefined, null, 'string', ['string'], {}, { enum: STATUSES }];

    invalid.forEach((field) => {
      assert.throws(() => nullable(field), { name: 'TypeError', message: /^nullable\(/ }, JSON.stringify(field));
    });
  });

  test('lets null through a request, and still refuses what the field refuses', async (t) => {
    const properties = { status: nullable(enumOf(STATUSES)), nickname: nullable(text('Nickname')) };
    const [cleared, refused] = await postFields(t, properties, [
      { status: null, nickname: null },
      { status: 'deleted', nickname: '' },
    ]);

    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(cleared.json(), { status: null, nickname: null });
    assert.deepEqual(readFailures(refused), [['status', 'enum'], ['nickname', 'minLength']]);
  });
});

describe('withDescription', () => {
  test('returns the schema itself when no description is given', () => {
    const schema = { type: 'string' };

    assert.equal(withDescription(schema), schema);
  });

  test('returns a copy with the description, and leaves the schema as it was', () => {
    const schema = Object.freeze({ type: 'string' });

    assert.deepEqual(withDescription(schema, 'Name'), { type: 'string', description: 'Name' });
    assert.deepEqual(schema, { type: 'string' });
  });

  test('replaces the description the schema has', () => {
    assert.deepEqual(withDescription({ type: 'string', description: 'Name' }, 'First name'), { type: 'string', description: 'First name' });
  });
});

describe('pickFields', () => {
  test('takes the named fields, in the order of the names', () => {
    const picked = pickFields(PERSON_FIELDS, ['status', 'id']);

    assert.deepEqual(picked, { status: PERSON_FIELDS.status, id: PERSON_FIELDS.id });
    assert.deepEqual(Object.keys(picked), ['status', 'id']);
  });

  test('takes no field for an empty list of names', () => {
    assert.deepEqual(pickFields(PERSON_FIELDS, []), {});
  });
});

describe('omitFields', () => {
  test('leaves out the named fields and keeps the rest in their order', () => {
    const rest = omitFields(PERSON_FIELDS, ['email']);

    assert.deepEqual(rest, { id: PERSON_FIELDS.id, firstName: PERSON_FIELDS.firstName, status: PERSON_FIELDS.status });
    assert.deepEqual(Object.keys(rest), ['id', 'firstName', 'status']);
  });

  test('keeps every field for an empty list of names', () => {
    assert.deepEqual(omitFields(PERSON_FIELDS, []), PERSON_FIELDS);
  });
});

describe('pickFields and omitFields', () => {
  const selectors = [pickFields, omitFields];

  test('throw on a name that is not a field, one that only the prototype has among them', () => {
    selectors.forEach((selectFields) => {
      ['nickname', 'toString', 'constructor', '__proto__'].forEach((name) => {
        assert.throws(
          () => selectFields(PERSON_FIELDS, ['id', name]),
          { name: 'TypeError', message: new RegExp(`names a field that is not there: "${name}"`) },
          `${selectFields.name}: ${name}`,
        );
      });
    });
  });

  test('throw on a name given twice', () => {
    selectors.forEach((selectFields) => {
      assert.throws(() => selectFields(PERSON_FIELDS, ['id', 'email', 'id']), { name: 'TypeError', message: /names a field twice/ }, selectFields.name);
    });
  });

  test('throw on fields that are not a map, and on names that are not a list of strings', () => {
    const invalid = [
      [undefined, []],
      [null, ['id']],
      [[], []],
      ['id', ['id']],
      [PERSON_FIELDS, undefined],
      [PERSON_FIELDS, 'id'],
      [PERSON_FIELDS, [1]],
    ];

    selectors.forEach((selectFields) => {
      invalid.forEach(([properties, keys]) => {
        assert.throws(() => selectFields(properties, keys), { name: 'TypeError', message: /requires a map of fields and a list of their names/ }, selectFields.name);
      });
    });
  });

  test('leave the map they are given as it was', () => {
    selectors.forEach((selectFields) => {
      assert.notEqual(selectFields(PERSON_FIELDS, ['id']), PERSON_FIELDS);
      assert.deepEqual(Object.keys(PERSON_FIELDS), ['id', 'email', 'firstName', 'status']);
    });
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

  test('answer a value over the length of its field with the error of the length alone, never with its pattern or format', async (t) => {
    const [longest, tooLong] = await postFields(t, USER_BODY_SCHEMA.properties, [
      { id: NIL_ID, email: createEmail(EMAIL_MAX_LENGTH), createdAt: LONGEST_UTC_DATE_TIME },
      { id: `${CANONICAL_ID}0`, email: createEmail(EMAIL_MAX_LENGTH + 1), createdAt: '2026-11-20T10:00:00.1234567890+00:00' },
    ]);

    assert.equal(longest.statusCode, 200);
    assert.deepEqual(readLimits(tooLong), [
      ['id', 'maxLength', CANONICAL_ID.length],
      ['email', 'maxLength', EMAIL_MAX_LENGTH],
      ['createdAt', 'maxLength', LONGEST_UTC_DATE_TIME.length],
    ]);
  });

  test('take a date-time in UTC only: with Z or +00:00, down to nanoseconds', async (t) => {
    const accepted = ['2026-11-13T10:00:00Z', '2026-11-13T10:00:00.000Z', '2026-11-13T10:00:00+00:00', LONGEST_UTC_DATE_TIME];
    const refused = [
      '2026-11-13T12:00:00+02:00',
      '2026-11-13T10:00:00-00:00',
      '2026-11-13T10:00:00',
      '2026-11-13T10:00:00z',
      '2026-11-13 10:00:00Z',
      '2026-11-13',
      '2026-02-30T10:00:00Z',
      '2026-11-13T24:00:00Z',
    ];
    const responses = await postFields(t, { createdAt: dateTimeUtc() }, [...accepted, ...refused].map((createdAt) => ({ createdAt })));

    assert.deepEqual(responses.slice(0, accepted.length).map((response) => response.json()), accepted.map((createdAt) => ({ createdAt })));
    responses.slice(accepted.length).forEach((response, index) => {
      assert.deepEqual(readFailures(response), [['createdAt', 'format']], refused[index]);
    });
  });

  test('take an email in any script, checked as it is stored: trimmed and in lower case, and keep it as it came', async (t) => {
    const accepted = ['anna@example.com', 'анна@приклад.укр', 'anna+news@mail.example.com', ' Anna@Example.COM '];
    const refused = ['anna.example.com', 'anna@example', 'anna@@example.com', 'anna kovalenko@example.com', '@example.com', 'anna@'];
    const responses = await postFields(t, { email: email() }, [...accepted, ...refused].map((address) => ({ email: address })));

    assert.deepEqual(responses.slice(0, accepted.length).map((response) => response.json()), accepted.map((address) => ({ email: address })));
    responses.slice(accepted.length).forEach((response, index) => {
      assert.deepEqual(readFailures(response), [['email', 'format']], refused[index]);
    });
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

  test('gives a list query its limit and offset, within the bounds of the config and with their defaults', () => {
    const { properties } = paginationSchema;

    assert.deepEqual(Object.keys(properties), ['limit', 'offset']);
    assert.deepEqual(omit(properties.limit, ['description']), {
      type: 'integer',
      minimum: 1,
      maximum: PAGINATION_CONFIG.maxLimit,
      default: PAGINATION_CONFIG.defaultLimit,
    });
    assert.deepEqual(omit(properties.offset, ['description']), {
      type: 'integer',
      minimum: 0,
      maximum: PAGINATION_CONFIG.maxOffset,
      default: 0,
    });
    Object.values(properties).forEach((field) => assert.ok(isNonEmptyString(field.description)));
  });

  test('gives an example of its fields that the validator of the app lets through as it is', async (t) => {
    const [response] = await postFields(t, paginationSchema.properties, [paginationSchema.example]);

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), paginationSchema.example);
    assert.deepEqual(Object.keys(paginationSchema.example), Object.keys(paginationSchema.properties));
  });

  test('is a source of createSchema as an entity schema is: the module itself, imported whole', () => {
    const schema = createSchema(paginationSchema).query(['limit', 'offset']).response(204).build();

    assert.deepEqual(schema.querystring, {
      type: 'object',
      properties: { limit: paginationSchema.properties.limit, offset: paginationSchema.properties.offset },
      additionalProperties: false,
    });
  });

  test('freezes the fields of the query and the example to their leaves: every list shares them', () => {
    assert.ok(isDeepFrozen(paginationSchema.properties));
    assert.ok(isDeepFrozen(paginationSchema.example));
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
    const nullableItem = { ...ITEM_SCHEMA, type: ['object', 'null'] };

    assert.deepEqual(serialize(successEnvelope({ type: 'null' }), createEnvelope()), { status: 'success', data: null });
    assert.deepEqual(serialize(successEnvelope(nullableItem), createEnvelope()), { status: 'success', data: null });
    assert.deepEqual(serialize(successEnvelope(nullableItem), createEnvelope({ data: ITEM_ROW })), { status: 'success', data: ITEM });
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

  test('keeps the operator of a range filter', () => {
    const filter = {
      type: 'datetime',
      name: 'createdAt',
      label: 'Created',
      operator: 'range',
      isDisabled: false,
      value: ['2026-11-01T00:00:00.000Z', null],
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
