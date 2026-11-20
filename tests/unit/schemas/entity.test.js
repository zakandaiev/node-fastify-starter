import { PAGINATION } from '#config/pagination.js';
import { createSchema } from '#core/schema/create-schema.js';
import { FILTER_TYPE } from '#enums/filter-type.js';
import { USER_STATUS } from '#enums/user-status.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import * as paginationSchema from '#schemas/common/pagination.js';
import * as groupSchema from '#schemas/entity/group.js';
import * as userSchema from '#schemas/entity/user.js';
import { pick } from '#utils/object.js';
import { isNonEmptyString } from '#utils/type.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const MOMENT = '2026-11-19T10:00:00.000Z';

const USER = Object.freeze({
  id: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b',
  email: 'anna@example.com',
  emailVerifiedAt: MOMENT,
  firstName: 'Anna',
  lastName: 'Kovalenko',
  locale: 'uk',
  timezone: 'Europe/Kyiv',
  status: USER_STATUS.ACTIVE,
  createdAt: MOMENT,
  updatedAt: MOMENT,
});

// A user as sign-in leaves one: every column that takes NULL holds it.
const BARE_USER = Object.freeze({
  ...USER,
  email: null,
  emailVerifiedAt: null,
  firstName: null,
  lastName: null,
  locale: null,
  timezone: null,
});

const GROUP = Object.freeze({
  id: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2c',
  slug: 'admin',
  name: 'Administrators',
  description: null,
  isSuperadmin: true,
  isSystem: true,
  createdAt: MOMENT,
  updatedAt: MOMENT,
});

const ENTITIES = Object.freeze({ user: userSchema, group: groupSchema });

const EXPORTS = Object.freeze(['example', 'filters', 'properties', 'sort', 'unique']);

const LIST_KEYS = Object.freeze(['sort', 'limit', 'offset']);

// The query parameters each list takes: a range filter comes as two of them.
const LIST_PARAMETERS = Object.freeze({
  user: Object.freeze(['firstName', 'status', 'createdAtFrom', 'createdAtTo', 'sort', 'limit', 'offset']),
  group: Object.freeze(['name', 'sort', 'limit', 'offset']),
});

// Written by the database: an update of a row takes every other field.
const GENERATED_FIELDS = Object.freeze(['id', 'createdAt', 'updatedAt']);

const TIE_BREAKER_REGEXP = /(?:^|,\s*)id (?:ASC|DESC)$/;
const COSTLY_KEYWORDS = Object.freeze(['pattern', 'format']);

const PUBLIC = Object.freeze({ auth: false });

function forEachEntity(check) {
  Object.entries(ENTITIES).forEach(([name, schema]) => check(schema, name));
}

// Each payload through the validator of the app, as the body of a route that echoes it.
async function validate(t, properties, payloads) {
  const fastify = await buildTestApp();

  t.after(() => fastify.close());
  fastify.post('/entity', {
    schema: { body: { type: 'object', properties, additionalProperties: false } },
  }, (request) => request.body);

  return Promise.all(payloads.map((payload) => fastify.inject({ method: 'POST', url: '/entity', payload })));
}

function readFailures(response) {
  return response.json().validation.map(({ column, operator }) => [column, operator]);
}

function readUpdatedFields(schema) {
  return Object.keys(schema.properties).filter((key) => !GENERATED_FIELDS.includes(key));
}

function buildListSchema(schema) {
  return createSchema(schema, paginationSchema)
    .query([...Object.keys(schema.filters), ...LIST_KEYS])
    .response(200, { data: Object.keys(schema.properties), format: 'array' })
    .defaultResponses()
    .build();
}

function buildUpdateSchema(schema) {
  return createSchema(schema)
    .params(['id'])
    .body(readUpdatedFields(schema), { isPatch: true })
    .response(200, { data: Object.keys(schema.properties) })
    .defaultResponses()
    .build();
}

describe('entity schemas', () => {
  test('are frozen to their leaves, every export of them', () => {
    forEachEntity((schema, name) => {
      EXPORTS.forEach((key) => assert.ok(isDeepFrozen(schema[key]), `${name}.${key}`));
    });
  });

  test('let a user through as the table gives one, also with null in every column that takes NULL', async (t) => {
    const responses = await validate(t, userSchema.properties, [USER, BARE_USER]);

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    assert.deepEqual(responses.map((response) => response.json()), [USER, BARE_USER]);
  });

  test('refuse a status outside USER_STATUS, ACTIVE among them, and a text longer than its column', async (t) => {
    const [upperCase, unknown, tooLong] = await validate(t, userSchema.properties, [
      { ...USER, status: 'ACTIVE' },
      { ...USER, status: 'deleted' },
      { ...USER, firstName: 'a'.repeat(101), locale: 'a'.repeat(36) },
    ]);

    assert.deepEqual(readFailures(upperCase), [['status', 'enum']]);
    assert.deepEqual(readFailures(unknown), [['status', 'enum']]);
    assert.deepEqual(readFailures(tooLong), [['firstName', 'maxLength'], ['locale', 'maxLength']]);
  });

  test('let a group through as the table gives one, and refuse a slug longer than its column and a flag that is not a boolean', async (t) => {
    const [group, refused] = await validate(t, groupSchema.properties, [GROUP, { ...GROUP, slug: 'a'.repeat(65), isSystem: 'yes' }]);

    assert.equal(group.statusCode, 200);
    assert.deepEqual(group.json(), GROUP);
    assert.deepEqual(readFailures(refused), [['slug', 'maxLength'], ['isSystem', 'type']]);
  });
});

describe('the exports of an entity schema', () => {
  test('are properties, filters, sort, unique and an example', () => {
    forEachEntity((schema, name) => assert.deepEqual(Object.keys(schema), EXPORTS, name));
  });

  test('give a maxLength to every field with a pattern or a format: the gate of a request needs it', () => {
    forEachEntity((schema, name) => {
      Object.entries(schema.properties)
        .filter(([, field]) => COSTLY_KEYWORDS.some((keyword) => field[keyword] !== undefined))
        .forEach(([key, field]) => assert.ok(Number.isSafeInteger(field.maxLength), `${name}.${key}`));
    });
  });

  test('filter only by their own fields, each filter with a type of FILTER_TYPE and a label', () => {
    forEachEntity((schema, name) => {
      Object.entries(schema.filters).forEach(([key, filter]) => {
        assert.ok(Object.hasOwn(schema.properties, key), `${name}.filters.${key} is not a field`);
        assert.ok(Object.values(FILTER_TYPE).includes(filter.type), `${name}.filters.${key}`);
        assert.ok(isNonEmptyString(filter.label), `${name}.filters.${key}`);
      });
    });
  });

  test('offer as options only values of the enum of the field, each once and with a label', () => {
    forEachEntity((schema, name) => {
      Object.entries(schema.filters)
        .filter(([, filter]) => filter.options !== undefined)
        .forEach(([key, { options }]) => {
          const values = options.map((option) => option.value);

          assert.deepEqual(values.filter((value) => !schema.properties[key].enum.includes(value)), [], `${name}.filters.${key}`);
          assert.equal(new Set(values).size, values.length, `${name}.filters.${key}`);
          options.forEach((option) => assert.ok(isNonEmptyString(option.label), `${name}.filters.${key}: ${option.value}`));
        });
    });
  });

  test('mark exactly one entry of sort as the default, each entry with a value of its own and a label', () => {
    forEachEntity((schema, name) => {
      const values = schema.sort.map((entry) => entry.value);

      assert.equal(schema.sort.filter((entry) => entry.isDefault === true).length, 1, name);
      assert.equal(new Set(values).size, values.length, name);
      schema.sort.forEach((entry) => {
        assert.ok(isNonEmptyString(entry.value) && isNonEmptyString(entry.label), `${name}.sort: ${entry.value}`);
      });
    });
  });

  test('end every order with the id, so rows that tie keep one order from page to page', () => {
    forEachEntity((schema, name) => {
      schema.sort.forEach((entry) => assert.match(entry.orderBy, TIE_BREAKER_REGEXP, `${name}.sort: ${entry.value}`));
    });
  });

  test('report a duplicate of an index under one of their own fields', () => {
    forEachEntity((schema, name) => {
      assert.ok(Object.keys(schema.unique).length > 0, name);
      Object.entries(schema.unique).forEach(([index, field]) => {
        assert.ok(Object.hasOwn(schema.properties, field), `${name}.unique.${index}: "${field}" is not a field`);
      });
    });
  });

  test('give an example of every field, in their order, that their own properties let through the validator of the app', async (t) => {
    const [[user], [group]] = await Promise.all([
      validate(t, userSchema.properties, [userSchema.example]),
      validate(t, groupSchema.properties, [groupSchema.example]),
    ]);

    forEachEntity((schema, name) => assert.deepEqual(Object.keys(schema.example), Object.keys(schema.properties), name));
    assert.equal(user.statusCode, 200, user.body);
    assert.deepEqual(user.json(), userSchema.example);
    assert.equal(group.statusCode, 200, group.body);
    assert.deepEqual(group.json(), groupSchema.example);
  });
});

describe('entity schemas as sources of createSchema', () => {
  test('build a list of every filter, the sort and the pagination, with the default sort and the example of the entity', () => {
    forEachEntity((schema, name) => {
      const { querystring, response } = buildListSchema(schema);
      const defaultSort = schema.sort.find((entry) => entry.isDefault === true);

      assert.deepEqual(Object.keys(querystring.properties), LIST_PARAMETERS[name], name);
      assert.equal(querystring.properties.sort.default, defaultSort.value, name);
      assert.deepEqual(response[200].examples, [{ status: 'success', data: [schema.example] }], name);
    });
  });

  test('build an update of every field the database does not write, with the example of those fields', () => {
    forEachEntity((schema, name) => {
      const { params, body } = buildUpdateSchema(schema);

      assert.deepEqual(params.required, ['id'], name);
      assert.deepEqual(Object.keys(body.properties), readUpdatedFields(schema), name);
      assert.equal(body.required, undefined, name);
      assert.deepEqual(body.examples, [pick(schema.example, readUpdatedFields(schema))], name);
    });
  });

  test('give routes the app starts with, which take the example and answer with it whole', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    const queries = {};

    forEachEntity((schema, name) => {
      fastify.get(`/api/v1/${name}s`, { schema: buildListSchema(schema), security: PUBLIC }, (request, reply) => {
        queries[name] = { ...request.query };

        return reply.list({ data: [schema.example] });
      });
      fastify.patch(`/api/v1/${name}s/:id`, { schema: buildUpdateSchema(schema), security: PUBLIC }, (request, reply) => reply.ok({
        ...schema.example,
        ...request.body,
      }));
    });

    const names = Object.keys(ENTITIES);
    const [lists, updates] = await Promise.all([
      Promise.all(names.map((name) => fastify.inject(`/api/v1/${name}s`))),
      Promise.all(names.map((name) => fastify.inject({
        method: 'PATCH',
        url: `/api/v1/${name}s/${ENTITIES[name].example.id}`,
        payload: pick(ENTITIES[name].example, readUpdatedFields(ENTITIES[name])),
      }))),
    ]);

    names.forEach((name, index) => {
      const schema = ENTITIES[name];
      const defaultSort = schema.sort.find((entry) => entry.isDefault === true);

      assert.equal(lists[index].statusCode, 200, lists[index].body);
      assert.deepEqual(lists[index].json().data, [schema.example], name);
      assert.deepEqual(queries[name], { sort: defaultSort.value, limit: PAGINATION.defaultLimit, offset: 0 }, name);
      assert.equal(updates[index].statusCode, 200, updates[index].body);
      assert.deepEqual(updates[index].json().data, schema.example, name);
    });
  });
});
