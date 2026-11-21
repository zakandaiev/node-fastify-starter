import { PAGINATION } from '#config/pagination.js';
import { SCHEMA_LIMITS } from '#config/schema.js';
import { createSchema } from '#core/schema/create-schema.js';
import { ERROR_CATALOG, ERROR_CODE } from '#enums/error-code.js';
import { FILTER_OPERATOR, FILTER_TYPE } from '#enums/filter-type.js';
import { HTTP_STATUS } from '#enums/http-status.js';
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
  text,
  uuid,
} from '#schemas/common/field.js';
import * as paginationSchema from '#schemas/common/pagination.js';
import * as groupSchema from '#schemas/entity/group.js';
import * as userSchema from '#schemas/entity/user.js';
import { UUID_LENGTH } from '#utils/id.js';
import { freezeDeep, omit, pick } from '#utils/object.js';
import { EMAIL_MAX_LENGTH } from '#utils/validate.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PUBLIC = Object.freeze({ auth: false });

const USER_ID = userSchema.example.id;
const OTHER_ID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2d';

const STATUS_LIST_PATTERN = '^(?:active|blocked)(?:,(?:active|blocked)){0,1}$';
const STATUS_LIST_MAX_LENGTH = 'active,blocked'.length;
const SORT_DESCRIPTION = 'Order of the rows';

const LEAK = /row-secret/;

// A row as the table gives it: every column of the entity and one the API never shows.
const USER_ROW = Object.freeze({ ...userSchema.example, passwordHash: 'row-secret' });

const LIST_FIELDS = Object.freeze(['id', 'firstName', 'status', 'createdAt']);
const ITEM_FIELDS = Object.freeze(['id', 'firstName', 'status']);

const LIST_USERS_SCHEMA = createSchema(userSchema, paginationSchema)
  .query(['limit', 'offset', 'sort', 'firstName', 'status', 'createdAt'])
  .response(HTTP_STATUS.OK, { data: LIST_FIELDS, format: 'array' })
  .defaultResponses()
  .meta({ tags: ['Users'], summary: 'List users' })
  .build();

const GET_USER_SCHEMA = createSchema(userSchema)
  .params(['id'])
  .response(HTTP_STATUS.OK, { data: ITEM_FIELDS })
  .defaultResponses()
  .build();

const FIELDS = freezeDeep({
  id: uuid('Item id'),
  ownerId: nullable(uuid('Owner id')),
  email: nullable(email('Email')),
  title: nullable(text('Title', { maxLength: 50 })),
  kind: nullable(enumOf(['book', 'film'], 'Kind')),
  level: { type: 'integer', enum: [1, 2, 3], description: 'Level' },
  rating: {
    type: ['integer', 'null'],
    minimum: 0,
    maximum: 10,
    default: 5,
    description: 'Rating',
  },
  price: {
    type: 'number',
    exclusiveMinimum: 0,
    exclusiveMaximum: 1000,
    multipleOf: 0.01,
    examples: [9.99],
    description: 'Price',
  },
  isPublic: { type: 'boolean', description: 'Shown to everyone' },
  releasedOn: isoDate('Released on'),
  seenAt: dateTimeUtc('Seen at'),
});

// build() requires a success response: 204 adds nothing else to the schema.
function buildWithSuccess(builder) {
  return builder.response(HTTP_STATUS.NO_CONTENT).build();
}

function readQuery(keys, ...sources) {
  return buildWithSuccess(createSchema(...sources).query(keys)).querystring;
}

function expandFilter(key, filter, properties = pick(FIELDS, [key])) {
  return readQuery([key], { properties, filters: { [key]: filter } }).properties;
}

function readBody(keys, options, ...sources) {
  return buildWithSuccess(createSchema(...sources).body(keys, options)).body;
}

function readResponse(statusCode, options, ...sources) {
  return createSchema(...sources).response(statusCode, options).build().response[statusCode];
}

function readErrorResponse(statusCode, options) {
  return buildWithSuccess(createSchema(userSchema).response(statusCode, options)).response[statusCode];
}

function assertRefused(run, reason, name) {
  assert.throws(run, { name: 'TypeError', message: reason }, name);
}

// AJV compiles a pattern with the "u" flag.
function toRegExp(schema) {
  return new RegExp(schema.pattern, 'u');
}

function repeatIds(count) {
  return Array.from({ length: count }, () => USER_ID).join(',');
}

async function createApp(t) {
  const fastify = await buildTestApp();

  t.after(() => fastify.close());

  return fastify;
}

function createEntry(column, columnValue, operator, operatorValue) {
  return {
    column,
    columnValue,
    operator,
    operatorValue,
  };
}

describe('createSchema: sources', () => {
  test('requires schema modules: one or more objects that export "properties"', () => {
    const invalid = [[], [null], ['users'], [{}], [{ properties: null }], [{ properties: [] }], [userSchema, { example: {} }]];

    invalid.forEach((sources, index) => {
      assertRefused(() => createSchema(...sources), /requires schema modules: objects that export "properties"/, String(index));
    });
  });

  test('merges the properties and the examples of every source', () => {
    assert.deepEqual(readBody(['firstName', 'limit'], undefined, userSchema, paginationSchema), {
      type: 'object',
      properties: { firstName: userSchema.properties.firstName, limit: paginationSchema.properties.limit },
      additionalProperties: false,
      examples: [{ firstName: userSchema.example.firstName, limit: PAGINATION.defaultLimit }],
    });
  });

  test('merges the filters of every source: a filter of one source reads the field of another', () => {
    const searchSchema = { properties: {}, filters: { lastName: { type: FILTER_TYPE.TEXT, label: 'Last name' } } };

    assert.deepEqual(readQuery(['status', 'lastName'], userSchema, searchSchema).properties, {
      status: {
        type: 'string',
        maxLength: STATUS_LIST_MAX_LENGTH,
        pattern: STATUS_LIST_PATTERN,
        description: 'Status',
      },
      lastName: { type: 'string', maxLength: userSchema.properties.lastName.maxLength, description: 'Last name' },
    });
  });

  test('merges the sort of every source in the order of the sources', () => {
    const first = { properties: {}, sort: [{ value: 'title', orderBy: 'title ASC, id ASC' }] };
    const second = {
      properties: {},
      sort: [
        { value: 'newest', orderBy: 'created_at DESC, id DESC', isDefault: true },
        { value: 'oldest', orderBy: 'created_at ASC, id ASC' },
      ],
    };

    assert.deepEqual(readQuery(['sort'], first, second).properties.sort, {
      type: 'string',
      enum: ['title', 'newest', 'oldest'],
      default: 'newest',
      description: SORT_DESCRIPTION,
    });
  });

  test('refuses a name that two sources give in the same map', () => {
    const titleSchema = { properties: { title: text('Title') }, filters: { q: { type: FILTER_TYPE.TEXT } } };
    const bodySchema = { properties: { body: text('Body') }, filters: { q: { type: FILTER_TYPE.TEXT } } };

    assertRefused(() => createSchema(userSchema, groupSchema), /"id" is in the "properties" of two sources/);
    assertRefused(() => createSchema(titleSchema, bodySchema), /"q" is in the "filters" of two sources/);
    assertRefused(() => createSchema(userSchema, { properties: {}, example: { firstName: 'Olha' } }), /"firstName" is in the "example" of two sources/);
  });

  test('refuses filters or an example that is not a map', () => {
    assertRefused(() => createSchema({ properties: {}, filters: [] }), /requires "filters" of a source to be a map/);
    assertRefused(() => createSchema({ properties: {}, example: 'Anna' }), /requires "example" of a source to be a map/);
  });

  test('requires a value of its own for every entry of sort, across the sources', () => {
    const invalid = [
      [{ properties: {}, sort: [{ label: 'Newest first', orderBy: 'created_at DESC, id DESC' }] }],
      [{ properties: {}, sort: [{ value: '', orderBy: 'created_at DESC, id DESC' }] }],
      [{ properties: {}, sort: ['newest'] }],
      [{ properties: {}, sort: [{ value: 'name', orderBy: 'name ASC, id ASC' }, { value: 'name', orderBy: 'name DESC, id DESC' }] }],
      [userSchema, { properties: {}, sort: [{ value: 'newest', orderBy: 'id DESC' }] }],
    ];

    invalid.forEach((sources, index) => {
      assertRefused(() => createSchema(...sources), /requires every entry of "sort" to have a "value" of its own/, String(index));
    });
  });

  test('refuses more than one default entry of sort, also when two sources give one each', () => {
    const twoDefaults = { properties: {}, sort: [{ value: 'name', isDefault: true }, { value: 'newest', isDefault: true }] };
    const oldestFirst = { properties: {}, sort: [{ value: 'oldest', orderBy: 'created_at ASC, id ASC', isDefault: true }] };

    assertRefused(() => createSchema(twoDefaults), /"sort" has more than one entry with isDefault/);
    assertRefused(() => createSchema(userSchema, oldestFirst), /"sort" has more than one entry with isDefault/);
  });
});

describe('createSchema: query', () => {
  test('expands the list query of the users: a closed object of the pagination, the sort and the filters', () => {
    assert.deepEqual(LIST_USERS_SCHEMA.querystring, {
      type: 'object',
      properties: {
        limit: paginationSchema.properties.limit,
        offset: paginationSchema.properties.offset,
        sort: {
          type: 'string',
          enum: ['newest', 'name'],
          default: 'newest',
          description: SORT_DESCRIPTION,
        },
        firstName: { type: 'string', maxLength: userSchema.properties.firstName.maxLength, description: 'First name' },
        status: {
          type: 'string',
          maxLength: STATUS_LIST_MAX_LENGTH,
          pattern: STATUS_LIST_PATTERN,
          description: 'Status',
        },
        createdAtFrom: dateTimeUtc('Created'),
        createdAtTo: dateTimeUtc('Created'),
      },
      additionalProperties: false,
    });
  });

  test('gives a text filter a plain string with the maxLength of its field: a fragment would fail its pattern, its format and its minLength', () => {
    assert.deepEqual(expandFilter('title', { type: FILTER_TYPE.TEXT }), { title: { type: 'string', maxLength: 50, description: 'Title' } });
    assert.deepEqual(expandFilter('id', { type: FILTER_TYPE.TEXT }), { id: { type: 'string', maxLength: UUID_LENGTH, description: 'Item id' } });
    assert.deepEqual(expandFilter('email', { type: FILTER_TYPE.TEXT }), { email: { type: 'string', maxLength: EMAIL_MAX_LENGTH, description: 'Email' } });
  });

  test('gives a text filter without a field, or on a field without a length, the default length of a text', () => {
    assert.deepEqual(expandFilter('search', { type: FILTER_TYPE.TEXT, label: 'Search' }), {
      search: { type: 'string', maxLength: SCHEMA_LIMITS.textMaxLength, description: 'Search' },
    });
    assert.deepEqual(expandFilter('note', { type: FILTER_TYPE.TEXT }, { note: { type: 'string' } }), {
      note: { type: 'string', maxLength: SCHEMA_LIMITS.textMaxLength },
    });
  });

  test('gives an exact text filter its field as it is, without null, and a plain string without a field', () => {
    assert.deepEqual(expandFilter('title', { type: FILTER_TYPE.TEXT, isExact: true }), { title: text('Title', { maxLength: 50 }) });
    assert.deepEqual(expandFilter('ownerId', { type: FILTER_TYPE.TEXT, isExact: true }), { ownerId: uuid('Owner id') });
    assert.deepEqual(expandFilter('search', { type: FILTER_TYPE.TEXT, isExact: true }), {
      search: { type: 'string', maxLength: SCHEMA_LIMITS.textMaxLength },
    });
  });

  test('refuses an exact text filter on a field that is not text: the query would give it a number, a boolean or an object', () => {
    const fields = {
      rating: FIELDS.rating,
      isPublic: FIELDS.isPublic,
      code: { type: ['string', 'integer'], maxLength: 8 },
      meta: json('Meta'),
    };

    Object.keys(fields).forEach((key) => {
      assertRefused(
        () => expandFilter(key, { type: FILTER_TYPE.TEXT, isExact: true }, fields),
        new RegExp(`the exact text filter "${key}" is on a field that is not text: its type, null aside, must be string$`),
        key,
      );
    });
    assert.deepEqual(expandFilter('rating', { type: FILTER_TYPE.TEXT }, fields), { rating: { type: 'string', maxLength: SCHEMA_LIMITS.textMaxLength, description: 'Rating' } });
  });

  test('refuses an exact text filter on a field that names no type but null: the query would take any value for it', () => {
    const fields = {
      code: {},
      kind: { enum: ['a', 'b'] },
      gone: { type: 'null' },
    };

    Object.keys(fields).forEach((key) => {
      assertRefused(
        () => expandFilter(key, { type: FILTER_TYPE.TEXT, isExact: true }, fields),
        new RegExp(`the exact text filter "${key}" is on a field that is not text: its type, null aside, must be string$`),
        key,
      );
    });
  });

  test('gives a boolean filter a boolean', () => {
    assert.deepEqual(expandFilter('isPublic', { type: FILTER_TYPE.BOOLEAN }), { isPublic: { type: 'boolean', description: 'Shown to everyone' } });
    assert.deepEqual(expandFilter('isArchived', { type: FILTER_TYPE.BOOLEAN }), { isArchived: { type: 'boolean' } });
  });

  test('gives a number filter the type and the bounds of its field without null, its default and the rest, and a plain number without a field', () => {
    assert.deepEqual(expandFilter('rating', { type: FILTER_TYPE.NUMBER }), {
      rating: {
        type: 'integer',
        minimum: 0,
        maximum: 10,
        description: 'Rating',
      },
    });
    assert.deepEqual(expandFilter('price', { type: FILTER_TYPE.NUMBER, label: 'Price, UAH' }), {
      price: {
        type: 'number',
        exclusiveMinimum: 0,
        exclusiveMaximum: 1000,
        multipleOf: 0.01,
        description: 'Price, UAH',
      },
    });
    assert.deepEqual(expandFilter('amount', { type: FILTER_TYPE.NUMBER }), { amount: { type: 'number' } });
  });

  test('refuses a number filter on a field that is not a number', () => {
    assertRefused(() => expandFilter('title', { type: FILTER_TYPE.NUMBER }), /the number filter "title" is on a field that is not a number/);
    [{ enum: [1, 2, 3] }, {}, { type: 'null' }].forEach((level, index) => {
      assertRefused(() => expandFilter('level', { type: FILTER_TYPE.NUMBER }, { level }), /the number filter "level" is on a field that is not a number/, String(index));
    });
  });

  test('refuses a number filter on a field that takes another type next to a number: the query would leave a value text', () => {
    const fields = {
      code: { type: ['integer', 'string'] },
      score: { type: ['number', 'boolean', 'null'] },
    };

    Object.keys(fields).forEach((key) => {
      [{ type: FILTER_TYPE.NUMBER }, { type: FILTER_TYPE.NUMBER, operator: FILTER_OPERATOR.RANGE }].forEach((filter) => {
        assertRefused(
          () => expandFilter(key, filter, fields),
          new RegExp(`the number filter "${key}" is on a field that is not a number: its types, null aside, must be number or integer$`),
          `${key} ${filter.operator}`,
        );
      });
    });
    assert.deepEqual(expandFilter('amount', { type: FILTER_TYPE.NUMBER }, { amount: { type: ['integer', 'number', 'null'] } }), { amount: { type: ['integer', 'number'] } });
  });

  test('gives a date filter an ISO date and a datetime filter a UTC date-time, whatever its field is', () => {
    assert.deepEqual(expandFilter('releasedOn', { type: FILTER_TYPE.DATE }), { releasedOn: isoDate('Released on') });
    assert.deepEqual(expandFilter('seenAt', { type: FILTER_TYPE.DATETIME }), { seenAt: dateTimeUtc('Seen at') });
    assert.deepEqual(expandFilter('seenAt', { type: FILTER_TYPE.DATE, label: 'Seen on' }), { seenAt: isoDate('Seen on') });
    assert.deepEqual(expandFilter('publishedAt', { type: FILTER_TYPE.DATETIME }), { publishedAt: dateTimeUtc() });
  });

  test('splits a range into <key>From and <key>To, each optional and each the value of the filter', () => {
    const query = readQuery(['rating', 'releasedOn', 'seenAt'], {
      properties: FIELDS,
      filters: {
        rating: { type: FILTER_TYPE.NUMBER, operator: FILTER_OPERATOR.RANGE },
        releasedOn: { type: FILTER_TYPE.DATE, operator: FILTER_OPERATOR.RANGE },
        seenAt: { type: FILTER_TYPE.DATETIME, label: 'Seen', operator: FILTER_OPERATOR.RANGE },
      },
    });
    const rating = {
      type: 'integer',
      minimum: 0,
      maximum: 10,
      description: 'Rating',
    };

    assert.deepEqual(query.properties, {
      ratingFrom: rating,
      ratingTo: rating,
      releasedOnFrom: isoDate('Released on'),
      releasedOnTo: isoDate('Released on'),
      seenAtFrom: dateTimeUtc('Seen'),
      seenAtTo: dateTimeUtc('Seen'),
    });
    assert.equal(Object.hasOwn(query, 'required'), false);
  });

  test('gives an options filter of one value the enum of its options, or of its field without null', () => {
    const options = [{ value: 'book', label: 'Book' }, { value: 'film', label: 'Film' }];

    assert.deepEqual(expandFilter('kind', { type: FILTER_TYPE.OPTIONS, options }), { kind: { type: 'string', enum: ['book', 'film'], description: 'Kind' } });
    assert.deepEqual(expandFilter('kind', { type: FILTER_TYPE.OPTIONS, options: [options[0]] }), { kind: { type: 'string', enum: ['book'], description: 'Kind' } });
    assert.deepEqual(expandFilter('kind', { type: FILTER_TYPE.OPTIONS }), { kind: { type: 'string', enum: ['book', 'film'], description: 'Kind' } });
    assert.deepEqual(expandFilter('level', { type: FILTER_TYPE.OPTIONS, isMultiple: false }), { level: { type: 'string', enum: ['1', '2', '3'], description: 'Level' } });
  });

  test('takes options of a string, a number or a boolean and lists them as text: a query parameter is text', () => {
    const options = [{ value: 1, label: 'One' }, { value: true, label: 'Yes' }, { value: 'none', label: 'None' }];

    assert.deepEqual(expandFilter('flag', { type: FILTER_TYPE.OPTIONS, options }), { flag: { type: 'string', enum: ['1', 'true', 'none'] } });
  });

  test('gives an options filter of one value without options or an enum its field without null: its options come from the database', () => {
    assert.deepEqual(expandFilter('ownerId', { type: FILTER_TYPE.OPTIONS, label: 'Owner' }), { ownerId: uuid('Owner') });
    assert.deepEqual(expandFilter('rating', { type: FILTER_TYPE.OPTIONS }), {
      rating: {
        type: 'integer',
        minimum: 0,
        maximum: 10,
        default: 5,
        description: 'Rating',
      },
    });
    assert.deepEqual(expandFilter('isPublic', { type: FILTER_TYPE.OPTIONS }), { isPublic: FIELDS.isPublic });
  });

  test('refuses an options filter of one value that reads it from a field of another type than a string, a number or a boolean', () => {
    const fields = {
      ownerIds: { type: 'array', items: uuid('Owner id'), maxItems: 5 },
      meta: json('Meta'),
      code: { type: ['string', 'object'] },
    };

    Object.keys(fields).forEach((key) => {
      assertRefused(
        () => expandFilter(key, { type: FILTER_TYPE.OPTIONS }, fields),
        new RegExp(`the options filter "${key}" reads its value from a field that is not a string, a number or a boolean$`),
        key,
      );
    });
  });

  test('refuses an options filter of one value that reads it from a field that names no type but null', () => {
    const fields = {
      code: {},
      level: { const: 5 },
      gone: { type: 'null' },
    };

    Object.keys(fields).forEach((key) => {
      assertRefused(
        () => expandFilter(key, { type: FILTER_TYPE.OPTIONS }, fields),
        new RegExp(`the options filter "${key}" reads its value from a field that is not a string, a number or a boolean$`),
        key,
      );
    });
  });

  test('gives an options filter of several values a comma list of its options, as long as each option once', () => {
    const { status } = readQuery(['status'], userSchema).properties;
    const pattern = toRegExp(status);

    assert.deepEqual(status, {
      type: 'string',
      maxLength: STATUS_LIST_MAX_LENGTH,
      pattern: STATUS_LIST_PATTERN,
      description: 'Status',
    });
    ['active', 'blocked', 'active,blocked', 'blocked,active'].forEach((value) => assert.match(value, pattern));
    ['', 'evil', 'ACTIVE', 'active,', ',active', 'active,,blocked', 'active blocked', 'active;blocked', 'activeblocked'].forEach((value) => {
      assert.doesNotMatch(value, pattern);
    });
  });

  test('builds the comma list from the enum of the field when the filter has no options', () => {
    assert.deepEqual(expandFilter('kind', { type: FILTER_TYPE.OPTIONS, isMultiple: true }), {
      kind: {
        type: 'string',
        maxLength: 'book,film'.length,
        pattern: '^(?:book|film)(?:,(?:book|film)){0,1}$',
        description: 'Kind',
      },
    });
    assert.deepEqual(expandFilter('level', { type: FILTER_TYPE.OPTIONS, isMultiple: true }), {
      level: {
        type: 'string',
        maxLength: '1,2,3'.length,
        pattern: '^(?:1|2|3)(?:,(?:1|2|3)){0,2}$',
        description: 'Level',
      },
    });
  });

  test('escapes the options in the pattern of the comma list', () => {
    const options = [{ value: 'a.b', label: 'A' }, { value: 'c++', label: 'C' }, { value: '(x)|y', label: 'X' }];
    const { code } = expandFilter('code', { type: FILTER_TYPE.OPTIONS, isMultiple: true, options });
    const pattern = toRegExp(code);

    ['a.b', 'c++', '(x)|y', 'a.b,c++,(x)|y'].forEach((value) => assert.match(value, pattern));
    ['axb', 'c', 'ccc', 'x', 'y', '(x)'].forEach((value) => assert.doesNotMatch(value, pattern));
  });

  test('builds the comma list from a uuid() field when its options come from the database, with listMaxValues ids at most', () => {
    const { ownerId } = expandFilter('ownerId', { type: FILTER_TYPE.OPTIONS, isMultiple: true });
    const pattern = toRegExp(ownerId);
    const { listMaxValues } = SCHEMA_LIMITS;

    assert.deepEqual(omit(ownerId, ['pattern']), { type: 'string', maxLength: UUID_LENGTH * listMaxValues + listMaxValues - 1, description: 'Owner id' });
    assert.equal(repeatIds(listMaxValues).length, ownerId.maxLength);
    assert.ok(repeatIds(listMaxValues + 1).length > ownerId.maxLength);
    [USER_ID, `${USER_ID},${OTHER_ID}`, repeatIds(listMaxValues)].forEach((value) => assert.match(value, pattern));
    assert.doesNotMatch(repeatIds(listMaxValues + 1), pattern);
    ['', `${USER_ID},`, `,${USER_ID}`, USER_ID.toUpperCase(), USER_ID.replaceAll('-', ''), `${USER_ID};${OTHER_ID}`].forEach((value) => {
      assert.doesNotMatch(value, pattern);
    });
  });

  test('refuses options that are not a list of { value, label } with a string, a number or a boolean value', () => {
    const invalid = [[], 'book', {}, [null], [{ label: 'Book' }], [{ value: null, label: 'None' }], [{ value: {}, label: 'Object' }], [{ value: ['book'], label: 'List' }], [{ value: Infinity, label: 'All' }]];

    invalid.forEach((options, index) => {
      assertRefused(() => expandFilter('kind', { type: FILTER_TYPE.OPTIONS, options }), /the options of the filter "kind" must be a list of \{ value, label \}/, String(index));
    });
  });

  test('refuses an option outside the enum of the field and an option given twice', () => {
    const outside = [{ value: 'music', label: 'Music' }];
    const twice = [{ value: 'book', label: 'Book' }, { value: 'book', label: 'Novel' }];
    const twiceAsText = [{ value: 1, label: 'One' }, { value: '1', label: 'Uno' }];

    assertRefused(() => expandFilter('kind', { type: FILTER_TYPE.OPTIONS, options: outside }), /the options of the filter "kind" must be values of the enum of its field: "music" is not one$/);
    assertRefused(() => expandFilter('level', { type: FILTER_TYPE.OPTIONS, options: [{ value: 1 }, { value: 4 }] }), /the options of the filter "level" must be values of the enum of its field: "4" is not one$/);
    assertRefused(() => expandFilter('kind', { type: FILTER_TYPE.OPTIONS, options: twice }), /the options of the filter "kind" must be distinct values/);
    assertRefused(() => expandFilter('code', { type: FILTER_TYPE.OPTIONS, options: twiceAsText }), /the options of the filter "code" must be distinct values/);
  });

  test('refuses an option that holds the comma in a list of several values, and takes it in a filter of one', () => {
    const options = [{ value: 'a,b', label: 'A and B' }];

    assertRefused(() => expandFilter('code', { type: FILTER_TYPE.OPTIONS, isMultiple: true, options }), /an option of the filter "code" holds ",", which separates the values of the list/);
    assert.deepEqual(expandFilter('code', { type: FILTER_TYPE.OPTIONS, options }), { code: { type: 'string', enum: ['a,b'] } });
  });

  test('refuses an options filter that has nothing to read its values from', () => {
    const fields = [
      undefined,
      text('Code'),
      { type: 'string', maxLength: 10, pattern: '[a-z]+' },
      { type: 'string', pattern: '^[a-z]+$' },
      { type: 'string', maxLength: 8, pattern: '^[0-9]{1,8}$' },
      { type: 'string', maxLength: 64, pattern: '^\\S+$' },
    ];

    assertRefused(() => expandFilter('code', { type: FILTER_TYPE.OPTIONS }), /the filter "code" needs options, an enum or a field to read its value from/);
    fields.forEach((field, index) => {
      const properties = field === undefined
        ? {}
        : { code: field };

      assertRefused(
        () => expandFilter('code', { type: FILTER_TYPE.OPTIONS, isMultiple: true }, properties),
        /the filter "code" of several values needs options, an enum or a uuid\(\) field for the ids of its rows/,
        String(index),
      );
    });
  });

  test('refuses a filter that is not an object or has a type outside FILTER_TYPE', () => {
    [null, 'text', [], [{ type: FILTER_TYPE.TEXT }]].forEach((filter, index) => {
      assertRefused(() => expandFilter('title', filter), /the filter "title" must be an object/, String(index));
    });
    assertRefused(() => expandFilter('title', { type: 'fuzzy' }), /the filter "title" has the type "fuzzy", which is not one of text, boolean, number, date, datetime, options/);
    assertRefused(() => expandFilter('title', { label: 'Title' }), /the filter "title" has the type "undefined"/);
  });

  test('takes the operator "range" only on a number, a date or a datetime filter', () => {
    [FILTER_TYPE.TEXT, FILTER_TYPE.BOOLEAN, FILTER_TYPE.OPTIONS].forEach((type) => {
      assertRefused(
        () => expandFilter('kind', { type, operator: FILTER_OPERATOR.RANGE }),
        /the filter "kind" may take the operator "range" only as a number, date, datetime filter/,
        type,
      );
    });
    assertRefused(() => expandFilter('rating', { type: FILTER_TYPE.NUMBER, operator: 'between' }), /the filter "rating" may take the operator "range" only/);
  });

  test('takes isMultiple only on an options filter, and only as a boolean', () => {
    assertRefused(() => expandFilter('title', { type: FILTER_TYPE.TEXT, isMultiple: true }), /the filter "title" takes isMultiple only as an options filter, and as a boolean/);
    assertRefused(() => expandFilter('kind', { type: FILTER_TYPE.OPTIONS, isMultiple: 'yes' }), /the filter "kind" takes isMultiple only as an options filter/);
  });

  test('describes a parameter by the label of its filter, then by the description of its field', () => {
    assert.equal(expandFilter('title', { type: FILTER_TYPE.TEXT, label: 'Search' }).title.description, 'Search');
    assert.equal(expandFilter('title', { type: FILTER_TYPE.TEXT }).title.description, 'Title');
    assert.equal(Object.hasOwn(expandFilter('search', { type: FILTER_TYPE.TEXT }).search, 'description'), false);
  });

  test('gives sort the enum of its codes with the default entry, and no default when no entry has isDefault', () => {
    const nameOnly = { properties: {}, sort: [{ value: 'name', orderBy: 'name ASC, id ASC' }] };

    assert.deepEqual(readQuery(['sort'], userSchema).properties.sort, {
      type: 'string',
      enum: ['newest', 'name'],
      default: 'newest',
      description: SORT_DESCRIPTION,
    });
    assert.deepEqual(readQuery(['sort'], nameOnly).properties.sort, { type: 'string', enum: ['name'], description: SORT_DESCRIPTION });
  });

  test('refuses sort when no source has one', () => {
    assertRefused(() => createSchema(paginationSchema).query(['limit', 'sort']), /the query asks for "sort", and no source has a "sort"/);
  });

  test('takes a field that is not a filter as it is', () => {
    assert.deepEqual(readQuery(['limit', 'offset'], paginationSchema).properties, paginationSchema.properties);
  });

  test('drops null from the types of a field that is not a filter, as it does for a filter: a query parameter is text', () => {
    assert.deepEqual(readQuery(['rating', 'kind'], { properties: FIELDS }).properties, {
      rating: {
        type: 'integer',
        minimum: 0,
        maximum: 10,
        default: 5,
        description: 'Rating',
      },
      kind: enumOf(['book', 'film'], 'Kind'),
    });
  });

  test('refuses a name that is neither a field, a filter nor sort, the halves of a range among them', () => {
    assertRefused(() => createSchema(userSchema).query(['passwordHash']), /the query names "passwordHash", which is neither a field, a filter nor "sort"/);
    assertRefused(() => createSchema(userSchema).query(['createdAtFrom']), /the query names "createdAtFrom"/);
  });

  test('requires a list of names, and refuses a parameter given twice', () => {
    [undefined, [], 'status', [1], ['status', null]].forEach((keys, index) => {
      assertRefused(() => createSchema(userSchema).query(keys), /\.query\(keys\) requires a list of names/, String(index));
    });
    assertRefused(() => createSchema(userSchema, paginationSchema).query(['limit', 'status', 'limit']), /\.query\(keys\) gives the parameter "limit" twice/);
    assertRefused(
      () => createSchema(userSchema, { properties: { createdAtFrom: dateTimeUtc('Since') } }).query(['createdAt', 'createdAtFrom']),
      /\.query\(keys\) gives the parameter "createdAtFrom" twice/,
    );
  });
});

describe('createSchema: body and params', () => {
  test('builds a closed body of the named fields, none of them required, with their example', () => {
    const keys = ['firstName', 'status'];

    assert.deepEqual(readBody(keys, undefined, userSchema), {
      type: 'object',
      properties: pick(userSchema.properties, keys),
      additionalProperties: false,
      examples: [pick(userSchema.example, keys)],
    });
  });

  test('lists the required fields of a body', () => {
    assert.deepEqual(readBody(['email', 'firstName'], { required: ['email'] }, userSchema).required, ['email']);
    assert.equal(Object.hasOwn(readBody(['email', 'firstName'], { required: [] }, userSchema), 'required'), false);
  });

  test('refuses required that is not a list of the keys of the body', () => {
    [['status'], 'email', [1], null].forEach((required, index) => {
      assertRefused(
        () => createSchema(userSchema).body(['email', 'firstName'], { required }),
        /\.body\(keys, \{ required \}\) requires "required" to be a list of the keys of the body/,
        String(index),
      );
    });
  });

  test('refuses a body that names a field not in the sources, a field twice or no list of names', () => {
    assertRefused(() => createSchema(userSchema).body(['firstName', 'passwordHash']), /names a field that is not there: "passwordHash"/);
    assertRefused(() => createSchema(userSchema).body(['firstName', 'firstName']), /names a field twice/);
    assertRefused(() => createSchema(userSchema).body('firstName'), /requires a map of fields and a list of their names/);
  });

  test('builds a PATCH body: every field optional and without its default, closed, with its example', () => {
    assert.deepEqual(readBody(['firstName', 'limit'], { isPatch: true }, userSchema, paginationSchema), {
      type: 'object',
      properties: { firstName: userSchema.properties.firstName, limit: omit(paginationSchema.properties.limit, ['default']) },
      additionalProperties: false,
      examples: [{ firstName: userSchema.example.firstName, limit: PAGINATION.defaultLimit }],
    });
    assert.deepEqual(readBody(['firstName'], { isPatch: true, required: [] }, userSchema), readBody(['firstName'], { isPatch: true }, userSchema));
  });

  test('refuses required next to isPatch: every field of a PATCH is optional', () => {
    [['firstName'], 'firstName'].forEach((required, index) => {
      assertRefused(
        () => createSchema(userSchema).body(['firstName'], { isPatch: true, required }),
        /\.body\(keys, \{ isPatch: true \}\) takes no "required"/,
        String(index),
      );
    });
  });

  test('leaves out the example of a body when no source gives one for its fields', () => {
    const noteSchema = { properties: { note: text('Note') } };

    assert.deepEqual(readBody(['note'], undefined, noteSchema), {
      type: 'object',
      properties: noteSchema.properties,
      additionalProperties: false,
    });
  });

  test('builds closed params of the named fields, every one of them required', () => {
    assert.deepEqual(GET_USER_SCHEMA.params, {
      type: 'object',
      properties: { id: userSchema.properties.id },
      required: ['id'],
      additionalProperties: false,
    });
  });

  test('refuses params that name a field not in the sources', () => {
    assertRefused(() => createSchema(userSchema).params(['userId']), /names a field that is not there: "userId"/);
  });
});

describe('createSchema: response', () => {
  test('puts the named fields in the success envelope, with an example from the same list of keys', () => {
    const keys = ['id', 'firstName'];

    assert.deepEqual(readResponse(HTTP_STATUS.OK, { data: keys }, userSchema), {
      ...successEnvelope({ type: 'object', properties: pick(userSchema.properties, keys) }),
      description: 'OK',
      examples: [{ status: 'success', data: pick(userSchema.example, keys) }],
    });
  });

  test('puts them in the list envelope for the array format, with an example row', () => {
    const keys = ['id', 'firstName'];

    assert.deepEqual(readResponse(HTTP_STATUS.OK, { data: keys, format: 'array' }, userSchema), {
      ...listEnvelope({ type: 'object', properties: pick(userSchema.properties, keys) }),
      description: 'OK',
      examples: [{ status: 'success', data: [pick(userSchema.example, keys)] }],
    });
  });

  test('answers data: null when no data is named', () => {
    [undefined, {}, { format: 'object' }].forEach((options, index) => {
      assert.deepEqual(readResponse(HTTP_STATUS.OK, options, userSchema), {
        ...successEnvelope({ type: 'null' }),
        description: 'OK',
        examples: [{ status: 'success', data: null }],
      }, String(index));
    });
  });

  test('describes a success by its status, unless a description is given', () => {
    assert.equal(readResponse(HTTP_STATUS.CREATED, { data: ['id'] }, userSchema).description, 'Created');
    assert.equal(readResponse(HTTP_STATUS.CREATED, { data: ['id'], description: 'The new user' }, userSchema).description, 'The new user');
  });

  test('takes the example only from the fields that have one, and leaves it out when none has', () => {
    const scoreSchema = { properties: { score: { type: 'integer', description: 'Score' } } };

    assert.deepEqual(readResponse(HTTP_STATUS.OK, { data: ['id', 'score'] }, userSchema, scoreSchema).examples, [{ status: 'success', data: { id: USER_ID } }]);
    assert.deepEqual(readResponse(HTTP_STATUS.OK, { data: ['score'] }, scoreSchema), {
      ...successEnvelope({ type: 'object', properties: scoreSchema.properties }),
      description: 'OK',
    });
  });

  test('describes 204 and a redirect as a response without a body', () => {
    const descriptions = {
      204: 'No Content',
      301: 'Moved Permanently',
      302: 'Found',
      303: 'See Other',
      304: 'Not Modified',
      307: 'Temporary Redirect',
      308: 'Permanent Redirect',
    };

    Object.entries(descriptions).forEach(([statusCode, description]) => {
      assert.deepEqual(readResponse(Number(statusCode), undefined, userSchema), { type: 'null', description }, statusCode);
    });
    assert.deepEqual(readResponse(HTTP_STATUS.NO_CONTENT, { description: 'Signed out' }, userSchema), { type: 'null', description: 'Signed out' });
  });

  test('refuses data or a format on a status without a body', () => {
    assertRefused(() => createSchema(userSchema).response(HTTP_STATUS.NO_CONTENT, { data: ['id'] }), /\.response\(204\) has no body: it takes no "data" or "format"/);
    assertRefused(() => createSchema(userSchema).response(302, { format: 'object' }), /\.response\(302\) has no body/);
  });

  test('describes an error status by the error envelope, with its codes and an example of the first one', () => {
    assert.deepEqual(readErrorResponse(HTTP_STATUS.NOT_FOUND), {
      ...errorEnvelope,
      description: 'Not Found: NOT_FOUND_ERROR',
      examples: [{ status: 'error', code: ERROR_CODE.NOT_FOUND_ERROR, message: ERROR_CATALOG.NOT_FOUND_ERROR.message }],
    });
    assert.deepEqual(readErrorResponse(HTTP_STATUS.UNAUTHORIZED), {
      ...errorEnvelope,
      description: 'Unauthorized: AUTHENTICATION_ERROR, SESSION_REVOKED',
      examples: [{ status: 'error', code: ERROR_CODE.AUTHENTICATION_ERROR, message: ERROR_CATALOG.AUTHENTICATION_ERROR.message }],
    });
    assert.equal(readErrorResponse(HTTP_STATUS.CONFLICT).description, 'Conflict: NO_CHANGES');
    assert.equal(readErrorResponse(HTTP_STATUS.BAD_GATEWAY).description, 'Bad Gateway: UPSTREAM_ERROR');
    assert.equal(readErrorResponse(HTTP_STATUS.NOT_FOUND, { description: 'No such user' }).description, 'No such user');
  });

  test('gives the example of 422 an entry of validation', () => {
    assert.deepEqual(readErrorResponse(HTTP_STATUS.UNPROCESSABLE_ENTITY).examples, [{
      status: 'error',
      code: ERROR_CODE.VALIDATION_ERROR,
      message: ERROR_CATALOG.VALIDATION_ERROR.message,
      validation: [createEntry('email', 'anna.example.com', 'format', 'email')],
    }]);
  });

  test('refuses data or a format on an error status: its body is the error envelope', () => {
    assertRefused(() => createSchema(userSchema).response(HTTP_STATUS.NOT_FOUND, { data: ['id'] }), /\.response\(404\) is an error: its body is the error envelope, without "data"/);
    assertRefused(() => createSchema(userSchema).response(HTTP_STATUS.UNPROCESSABLE_ENTITY, { format: 'object' }), /\.response\(422\) is an error/);
  });

  test('refuses an error status that no code of the catalog answers with', () => {
    [405, 408, 418, 501, 504].forEach((statusCode) => {
      assertRefused(() => createSchema(userSchema).response(statusCode), /no code of src\/enums\/error-code\.js answers with this status/, String(statusCode));
    });
  });

  test('refuses a status outside 200 to 599 and options that are not an object', () => {
    ['200', 100, 199, 600, 200.5, NaN, null, undefined].forEach((statusCode) => {
      assertRefused(() => createSchema(userSchema).response(statusCode), /\.response\(code\) requires an HTTP status from 200 to 599/, String(statusCode));
    });
    [null, [], 'id', ['id']].forEach((options, index) => {
      assertRefused(() => createSchema(userSchema).response(HTTP_STATUS.OK, options), /\.response\(code, options\) requires options to be an object/, String(index));
    });
  });

  test('refuses an unknown format, the array format without data, data that is not a list of names and a field not in the sources', () => {
    assertRefused(() => createSchema(userSchema).response(HTTP_STATUS.OK, { data: ['id'], format: 'list' }), /requires the format "object" or "array"/);
    assertRefused(() => createSchema(userSchema).response(HTTP_STATUS.OK, { format: 'array' }), /\{ format: "array" \}\) requires "data": the fields of a row/);
    [null, [], 'id', {}].forEach((data, index) => {
      assertRefused(() => createSchema(userSchema).response(HTTP_STATUS.OK, { data }), /\.response\(code, \{ data \}\) requires "data" to be a list of field names/, String(index));
    });
    assertRefused(() => createSchema(userSchema).response(HTTP_STATUS.OK, { data: ['id', 'passwordHash'] }), /names a field that is not there: "passwordHash"/);
  });
});

describe('createSchema: defaultResponses, meta and build', () => {
  test('defaultResponses() adds the error statuses any route can answer with, each from the catalog', () => {
    const { response } = createSchema(userSchema).response(HTTP_STATUS.OK, { data: ['id'] }).defaultResponses().build();

    assert.deepEqual(Object.keys(response), ['200', '400', '401', '403', '404', '413', '415', '422', '429', '500', '503']);
    Object.entries(response).slice(1).forEach(([statusCode, schema]) => {
      assert.deepEqual(schema.properties, errorEnvelope.properties, statusCode);
      assert.equal(ERROR_CATALOG[schema.examples[0].code].statusCode, Number(statusCode), statusCode);
    });
  });

  test('defaultResponses() keeps a status declared before it', () => {
    const { response } = createSchema(userSchema)
      .response(HTTP_STATUS.OK, { data: ['id'] })
      .response(HTTP_STATUS.NOT_FOUND, { description: 'No such user' })
      .response(HTTP_STATUS.CONFLICT)
      .defaultResponses()
      .build();

    assert.equal(response[HTTP_STATUS.NOT_FOUND].description, 'No such user');
    assert.equal(response[HTTP_STATUS.CONFLICT].description, 'Conflict: NO_CHANGES');
  });

  test('defaultResponses() keeps a status declared after it: the steps of the chain come in any order', () => {
    const declaredFirst = createSchema(userSchema)
      .response(HTTP_STATUS.OK, { data: ['id'] })
      .response(HTTP_STATUS.NOT_FOUND, { description: 'No such user' })
      .defaultResponses()
      .build();
    const declaredLast = createSchema(userSchema)
      .response(HTTP_STATUS.OK, { data: ['id'] })
      .defaultResponses()
      .response(HTTP_STATUS.NOT_FOUND, { description: 'No such user' })
      .build();

    assert.deepEqual(declaredLast, declaredFirst);
  });

  test('meta() puts its fields on the route schema', () => {
    const fields = {
      tags: ['Users'],
      summary: 'Sign out',
      description: 'Ends the session of the caller',
      operationId: 'signOut',
    };
    const built = createSchema(userSchema).response(HTTP_STATUS.NO_CONTENT).meta(fields).build();

    assert.deepEqual(omit(built, ['response']), fields);
  });

  test('meta() refuses the request parts and the response', () => {
    ['body', 'querystring', 'query', 'params', 'headers', 'response'].forEach((key) => {
      assertRefused(() => createSchema(userSchema).meta({ summary: 'List users', [key]: {} }), new RegExp(`\\.meta\\(fields\\) cannot set "${key}"`), key);
    });
  });

  test('meta() refuses fields that are not an object', () => {
    [undefined, null, [], 'Users', ['Users']].forEach((fields, index) => {
      assertRefused(() => createSchema(userSchema).meta(fields), /\.meta\(fields\) requires an object/, String(index));
    });
  });

  test('build() freezes the route schema to its leaves', () => {
    const built = createSchema(userSchema, paginationSchema)
      .params(['id'])
      .query(['limit', 'status', 'createdAt'])
      .body(['firstName', 'lastName'], { required: ['firstName'] })
      .response(HTTP_STATUS.OK, { data: ['id', 'firstName'] })
      .defaultResponses()
      .meta({ tags: ['Users'] })
      .build();

    assert.ok(isDeepFrozen(built));
    assert.deepEqual(Object.keys(built).sort(), ['body', 'params', 'querystring', 'response', 'tags']);
  });

  test('build() gives the same schema whatever order the steps come in', () => {
    const forward = createSchema(userSchema, paginationSchema)
      .params(['id'])
      .query(['limit', 'status'])
      .body(['firstName'])
      .response(HTTP_STATUS.OK, { data: ['id'] })
      .response(HTTP_STATUS.NOT_FOUND)
      .meta({ tags: ['Users'] })
      .build();
    const backward = createSchema(userSchema, paginationSchema)
      .meta({ tags: ['Users'] })
      .response(HTTP_STATUS.NOT_FOUND)
      .response(HTTP_STATUS.OK, { data: ['id'] })
      .body(['firstName'])
      .query(['limit', 'status'])
      .params(['id'])
      .build();

    assert.deepEqual(backward, forward);
  });

  test('build() requires a success response: an error status or the defaults alone are not one', () => {
    const builders = [
      createSchema(userSchema),
      createSchema(userSchema).body(['firstName']),
      createSchema(userSchema).response(HTTP_STATUS.NOT_FOUND),
      createSchema(userSchema).defaultResponses(),
    ];

    builders.forEach((builder, index) => {
      assertRefused(() => builder.build(), /\.build\(\) requires a success response, such as \.response\(200, \{ data \}\)/, String(index));
    });
    [HTTP_STATUS.NO_CONTENT, 302].forEach((statusCode) => {
      assert.doesNotThrow(() => createSchema(userSchema).response(statusCode).build(), String(statusCode));
    });
  });

  test('refuses a step given twice, and a response given twice for one status', () => {
    assertRefused(() => createSchema(userSchema).body(['firstName']).body(['lastName']), /\.body\(\) is given twice/);
    assertRefused(() => createSchema(userSchema).query(['status']).query(['firstName']), /\.query\(\) is given twice/);
    assertRefused(() => createSchema(userSchema).params(['id']).params(['id']), /\.params\(\) is given twice/);
    assertRefused(() => createSchema(userSchema).response(HTTP_STATUS.OK, { data: ['id'] }).response(HTTP_STATUS.OK), /\.response\(200\) is given twice/);
    assertRefused(() => createSchema(userSchema).meta({ tags: ['Users'] }).meta({ summary: 'List users' }), /\.meta\(\) is given twice/);
    assertRefused(() => createSchema(userSchema).defaultResponses().defaultResponses(), /\.defaultResponses\(\) is given twice/);
    assert.doesNotThrow(() => createSchema(userSchema).response(HTTP_STATUS.OK, { data: ['id'] }).response(HTTP_STATUS.CREATED, { data: ['id'] }));
  });

  test('build() freezes a copy: the keys, the lists and the fields the caller passed stay as they were', () => {
    const keys = ['id'];
    const required = ['firstName'];
    const tags = ['Users'];
    const source = { properties: { id: { type: 'string', maxLength: 36 }, firstName: { type: 'string', maxLength: 100 } } };
    const built = createSchema(source)
      .params(keys)
      .body(['firstName'], { required })
      .response(HTTP_STATUS.OK, { data: keys })
      .meta({ tags })
      .build();

    [keys, required, tags, source.properties.id, source.properties.firstName].forEach((value, index) => {
      assert.equal(Object.isFrozen(value), false, String(index));
    });
    assert.ok(isDeepFrozen(built));
    assert.deepEqual(built.params.required, keys);
    assert.deepEqual(built.tags, tags);
  });
});

describe('createSchema in a route of the app', () => {
  test('lets out of reply.ok() and reply.list() only the fields that .response() names', async (t) => {
    const fastify = await createApp(t);

    fastify.get('/api/v1/users', { schema: LIST_USERS_SCHEMA, security: PUBLIC }, (request, reply) => reply.list({ data: [USER_ROW, USER_ROW] }));
    fastify.get('/api/v1/users/:id', { schema: GET_USER_SCHEMA, security: PUBLIC }, (request, reply) => reply.ok(USER_ROW));

    const [list, one] = await Promise.all(['/api/v1/users', `/api/v1/users/${USER_ID}`].map((url) => fastify.inject(url)));

    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().data, [pick(USER_ROW, LIST_FIELDS), pick(USER_ROW, LIST_FIELDS)]);
    assert.equal(one.statusCode, 200);
    assert.deepEqual(one.json().data, pick(USER_ROW, ITEM_FIELDS));
    [list, one].forEach((response) => assert.doesNotMatch(response.body, LEAK));
  });

  test('takes status=active,blocked and answers status=evil with 422 and an entry of the pattern', async (t) => {
    const fastify = await createApp(t);
    const queries = [];

    fastify.get('/api/v1/users', { schema: LIST_USERS_SCHEMA, security: PUBLIC }, (request, reply) => {
      queries.push({ ...request.query });

      return reply.list({ data: [] });
    });

    const statuses = ['evil', 'active,evil', 'ACTIVE', 'active,'];
    const accepted = await fastify.inject('/api/v1/users?status=active,blocked');
    const refused = await Promise.all(statuses.map((status) => fastify.inject(`/api/v1/users?status=${status}`)));

    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(queries, [{
      status: 'active,blocked',
      limit: PAGINATION.defaultLimit,
      offset: 0,
      sort: 'newest',
    }]);
    refused.forEach((response, index) => {
      const status = statuses[index];

      assert.equal(response.statusCode, 422, status);
      assert.equal(response.json().code, ERROR_CODE.VALIDATION_ERROR, status);
      assert.deepEqual(response.json().validation, [createEntry('status', status, 'pattern', STATUS_LIST_PATTERN)], status);
    });
  });

  test('answers a list of options longer than each option once with an entry of maxLength alone', async (t) => {
    const fastify = await createApp(t);

    fastify.get('/api/v1/users', { schema: LIST_USERS_SCHEMA, security: PUBLIC }, (request, reply) => reply.list({ data: [] }));

    const response = await fastify.inject('/api/v1/users?status=active,blocked,active');

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json().validation, [createEntry('status', 'active,blocked,active', 'maxLength', STATUS_LIST_MAX_LENGTH)]);
  });

  test('takes createdAtFrom and createdAtTo as a range, and checks each as a UTC date-time', async (t) => {
    const fastify = await createApp(t);
    const queries = [];

    fastify.get('/api/v1/users', { schema: LIST_USERS_SCHEMA, security: PUBLIC }, (request, reply) => {
      queries.push({ ...request.query });

      return reply.list({ data: [] });
    });

    const accepted = await fastify.inject({
      url: '/api/v1/users',
      query: { createdAtFrom: '2026-11-01T00:00:00Z', createdAtTo: '2026-11-20T10:00:00.000+00:00', createdAt: '2026-11-01T00:00:00Z' },
    });
    const refused = await fastify.inject({
      url: '/api/v1/users',
      query: { createdAtFrom: '2026-11-01T00:00:00', createdAtTo: '2026-11-20T12:00:00+02:00' },
    });

    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(queries, [{
      createdAtFrom: '2026-11-01T00:00:00Z',
      createdAtTo: '2026-11-20T10:00:00.000+00:00',
      limit: PAGINATION.defaultLimit,
      offset: 0,
      sort: 'newest',
    }]);
    assert.equal(refused.statusCode, 422);
    assert.deepEqual(refused.json().validation, [
      createEntry('createdAtFrom', '2026-11-01T00:00:00', 'format', 'date-time-utc'),
      createEntry('createdAtTo', '2026-11-20T12:00:00+02:00', 'format', 'date-time-utc'),
    ]);
  });

  test('answers 404 for an id in upper case or without hyphens in the path', async (t) => {
    const fastify = await createApp(t);

    fastify.get('/api/v1/users/:id', { schema: GET_USER_SCHEMA, security: PUBLIC }, (request, reply) => reply.ok(USER_ROW));

    const ids = [USER_ID, USER_ID.toUpperCase(), USER_ID.replaceAll('-', '')];
    const responses = await Promise.all(ids.map((id) => fastify.inject(`/api/v1/users/${id}`)));

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 404, 404]);
    assert.deepEqual(responses.slice(1).map((response) => response.json().code), [ERROR_CODE.NOT_FOUND_ERROR, ERROR_CODE.NOT_FOUND_ERROR]);
  });

  test('answers 422 with an entry of the format for a date-time of a JSON body without a zone or in a zone other than UTC', async (t) => {
    const fastify = await createApp(t);
    const schema = createSchema(userSchema).body(['emailVerifiedAt'], { isPatch: true }).response(HTTP_STATUS.NO_CONTENT).build();

    fastify.patch('/api/v1/users/me', { schema, security: PUBLIC }, (request, reply) => reply.noContent());

    const send = (emailVerifiedAt) => fastify.inject({ method: 'PATCH', url: '/api/v1/users/me', payload: { emailVerifiedAt } });
    const refusedValues = ['2026-11-19T10:00:00', '2026-11-19T12:00:00+02:00'];
    const acceptedValues = ['2026-11-19T10:00:00Z', '2026-11-19T10:00:00.000+00:00', null];
    const refused = await Promise.all(refusedValues.map(send));
    const accepted = await Promise.all(acceptedValues.map(send));

    refused.forEach((response, index) => {
      assert.equal(response.statusCode, 422, refusedValues[index]);
      assert.deepEqual(response.json().validation, [createEntry('emailVerifiedAt', refusedValues[index], 'format', 'date-time-utc')]);
    });
    assert.deepEqual(accepted.map((response) => response.statusCode), [204, 204, 204]);
  });

  // After a UNION MariaDB no longer reports the column as TINYINT(1), and the driver gives its 1 and 0 as numbers.
  test('writes 1 and 0 of a boolean field as true and false', async (t) => {
    const fastify = await createApp(t);
    const fields = ['id', 'slug', 'isSuperadmin', 'isSystem'];
    const rows = [
      { ...groupSchema.example, isSuperadmin: 1, isSystem: 0 },
      {
        ...groupSchema.example,
        id: OTHER_ID,
        isSuperadmin: 0,
        isSystem: 1,
      },
    ];
    const listSchema = createSchema(groupSchema).response(HTTP_STATUS.OK, { data: fields, format: 'array' }).build();
    const itemSchema = createSchema(groupSchema).params(['id']).response(HTTP_STATUS.OK, { data: fields }).build();

    fastify.get('/api/v1/groups', { schema: listSchema, security: PUBLIC }, (request, reply) => reply.list({ data: rows }));
    fastify.get('/api/v1/groups/:id', { schema: itemSchema, security: PUBLIC }, (request, reply) => reply.ok(rows[0]));

    const [list, one] = await Promise.all(['/api/v1/groups', `/api/v1/groups/${groupSchema.example.id}`].map((url) => fastify.inject(url)));
    const first = {
      ...pick(groupSchema.example, ['id', 'slug']),
      isSuperadmin: true,
      isSystem: false,
    };

    assert.deepEqual(list.json().data, [first, {
      ...first,
      id: OTHER_ID,
      isSuperadmin: false,
      isSystem: true,
    }]);
    assert.deepEqual(one.json().data, first);
  });

  test('refuses a number and null for a text field of a JSON body as a wrong type, and takes null for a nullable one', async (t) => {
    const fastify = await createApp(t);
    const schema = createSchema(groupSchema)
      .body(['slug', 'name', 'description'], { required: ['slug', 'name'] })
      .response(HTTP_STATUS.CREATED, { data: ['id', 'slug', 'name', 'description'] })
      .defaultResponses()
      .build();

    fastify.post('/api/v1/groups', { schema, security: PUBLIC }, (request, reply) => reply.created({ id: groupSchema.example.id, ...request.body }));

    const payloads = [
      { slug: 'admin', name: 42 },
      { slug: 'admin', name: null },
      { slug: 'admin', name: 'Administrators', description: null },
    ];
    const [number, nullName, nullDescription] = await Promise.all(payloads.map((payload) => fastify.inject({ method: 'POST', url: '/api/v1/groups', payload })));

    assert.equal(number.statusCode, 422);
    assert.deepEqual(number.json().validation, [createEntry('name', 42, 'type', 'string')]);
    assert.equal(nullName.statusCode, 422);
    assert.deepEqual(nullName.json().validation, [createEntry('name', null, 'type', 'string')]);
    assert.equal(nullDescription.statusCode, 201);
    assert.deepEqual(nullDescription.json().data, {
      id: groupSchema.example.id,
      slug: 'admin',
      name: 'Administrators',
      description: null,
    });
  });

  // limit is the field of the real schema modules that carries a default.
  test('drops the unknown keys of a PATCH body and fills no default, where a plain body fills it', async (t) => {
    const fastify = await createApp(t);
    const bodies = {};
    const keys = ['firstName', 'limit'];
    const plainSchema = createSchema(userSchema, paginationSchema).body(keys).response(HTTP_STATUS.NO_CONTENT).build();
    const patchSchema = createSchema(userSchema, paginationSchema).body(keys, { isPatch: true }).response(HTTP_STATUS.NO_CONTENT).build();

    function readBodyOf(request, reply) {
      bodies[request.method] = { ...request.body };

      return reply.noContent();
    }

    fastify.post('/api/v1/items', { schema: plainSchema, security: PUBLIC }, readBodyOf);
    fastify.patch('/api/v1/items', { schema: patchSchema, security: PUBLIC }, readBodyOf);

    const payload = { firstName: 'Anna', passwordHash: 'row-secret', isAdmin: true };
    const responses = await Promise.all(['POST', 'PATCH'].map((method) => fastify.inject({ method, url: '/api/v1/items', payload })));

    assert.deepEqual(responses.map((response) => response.statusCode), [204, 204]);
    assert.deepEqual(bodies, {
      POST: { firstName: 'Anna', limit: PAGINATION.defaultLimit },
      PATCH: { firstName: 'Anna' },
    });
  });
});
