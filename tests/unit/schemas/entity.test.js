import { PAGINATION } from '#config/pagination.js';
import { createSchema } from '#core/schema/create-schema.js';
import { FILTER_TYPE } from '#enums/filter-type.js';
import { SCHEMA_FORMAT } from '#enums/schema-format.js';
import { SCOPE_ALL, SCOPE_CATALOG } from '#enums/scope.js';
import { USER_STATUS } from '#enums/user-status.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import * as paginationSchema from '#schemas/common/pagination.js';
import * as groupSchema from '#schemas/entity/group.js';
import * as userSchema from '#schemas/entity/user.js';
import { pick } from '#utils/object.js';
import { PERSON_NAME_MAX_LENGTH } from '#utils/person.js';
import { isNonEmptyString } from '#utils/type.js';
import { URL_MAX_LENGTH } from '#utils/validate.js';
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
  avatarUrl: 'https://app.test/upload/019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2d.webp',
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
  avatarUrl: null,
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
  scopes: ['groups:read', 'users:read'],
});

const SCOPE_CODES = Object.freeze(SCOPE_CATALOG.map((entry) => entry.code));

const SLUGS = Object.freeze(['admin', 'content-editors', 'team-2', '2fa', 'a', 'a'.repeat(64)]);
const BAD_SLUGS = Object.freeze([
  'Admin',
  'content_editors',
  'content editors',
  'content--editors',
  '-admin',
  'admin-',
  'admin.',
  'admin\n',
  `ukr-${String.fromCharCode(0x043a)}`,
]);

// The length of the columns first_name and last_name.
const NAME_COLUMN_LENGTH = 100;

// A character outside the basic plane counts as one: PERSON_NAME_MAX_LENGTH of them are a name, one more is not.
const FAR_IDEOGRAPH = String.fromCodePoint(0x20BB7);
const EMOJI = String.fromCodePoint(0x1F600);

const PERSON_NAMES = Object.freeze([
  "Мар'яна",
  'Анна-Марія',
  'Müller',
  "O'Connor",
  'Ανδρέας',
  '山田',
  'สมชาย',
  '지민',
  FAR_IDEOGRAPH.repeat(PERSON_NAME_MAX_LENGTH),
]);
const NOT_PERSON_NAMES = Object.freeze([
  'Dr. X',
  'Іван2',
  EMOJI,
  'a'.repeat(PERSON_NAME_MAX_LENGTH + 1),
  FAR_IDEOGRAPH.repeat(PERSON_NAME_MAX_LENGTH + 1),
]);

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

// A path no route of src/routes takes: the same path there would fail these tests on a duplicate route.
const PROBE_URL = '/api/v1/entity-probe';

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

  test('describe the avatar of a user as an absolute URL of its file, as long as a URL may be, or null: a path or a key alone is none', async (t) => {
    const [relative, keyOnly] = await validate(t, userSchema.properties, [
      { ...USER, avatarUrl: '/upload/019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2d.webp' },
      { ...USER, avatarUrl: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2d.webp' },
    ]);

    assert.deepEqual(pick(userSchema.properties.avatarUrl, ['type', 'format', 'maxLength']), { type: ['string', 'null'], format: 'uri', maxLength: URL_MAX_LENGTH });
    assert.deepEqual(readFailures(relative), [['avatarUrl', 'format']]);
    assert.deepEqual(readFailures(keyOnly), [['avatarUrl', 'format']]);
  });

  test('let a group through as the API gives one, with its scopes, and refuse a slug longer than its column and a flag that is not a boolean', async (t) => {
    const [group, refused] = await validate(t, groupSchema.properties, [GROUP, { ...GROUP, slug: 'a'.repeat(65), isSystem: 'yes' }]);

    assert.equal(group.statusCode, 200);
    assert.deepEqual(group.json(), GROUP);
    assert.deepEqual(readFailures(refused), [['slug', 'maxLength'], ['isSystem', 'type']]);
  });

  test('take a slug of words of lower-case Latin letters and digits joined by single hyphens, and refuse any other by its pattern', async (t) => {
    const responses = await validate(t, groupSchema.properties, [...SLUGS, ...BAD_SLUGS].map((slug) => ({ ...GROUP, slug })));
    const taken = responses.slice(0, SLUGS.length);
    const refused = responses.slice(SLUGS.length);

    assert.deepEqual(taken.map((response) => response.statusCode), SLUGS.map(() => 200));
    assert.deepEqual(taken.map((response) => response.json().slug), SLUGS);
    assert.deepEqual(
      refused.map((response, index) => [BAD_SLUGS[index], readFailures(response)]),
      BAD_SLUGS.map((slug) => [slug, [['slug', 'pattern']]]),
    );
  });

  test('take as scopes distinct codes of the catalog, and refuse full access, an unknown code, a code twice, a list longer than the catalog and a code that is no list', async (t) => {
    const lists = [[], SCOPE_CODES, ['users:read', 'groups:*']];
    const responses = await validate(t, groupSchema.properties, [
      ...lists.map((scopes) => ({ ...GROUP, scopes })),
      { ...GROUP, scopes: [SCOPE_ALL] },
      { ...GROUP, scopes: ['groups:read', 'groups:write'] },
      { ...GROUP, scopes: ['groups:read', 'groups:read'] },
      { ...GROUP, scopes: [...SCOPE_CODES, SCOPE_CODES[0]] },
      { ...GROUP, scopes: 'groups:read' },
    ]);
    const taken = responses.slice(0, lists.length);

    assert.deepEqual(taken.map((response) => [response.statusCode, response.json().scopes]), lists.map((scopes) => [200, scopes]));
    assert.deepEqual(responses.slice(lists.length).map((response) => readFailures(response)), [
      [['scopes.0', 'enum']],
      [['scopes.1', 'enum']],
      [['scopes', 'uniqueItems']],
      [['scopes', 'maxItems']],
      [['scopes', 'type']],
    ]);
  });

  test('describe the scopes of a group as a list of the codes of the catalog, the wildcards among them and full access not, each once', () => {
    const { scopes } = groupSchema.properties;

    assert.deepEqual(scopes.items.enum, SCOPE_CODES);
    assert.equal(scopes.items.enum.includes(SCOPE_ALL), false);
    assert.deepEqual([scopes.type, scopes.uniqueItems, scopes.maxItems], ['array', true, SCOPE_CATALOG.length]);
  });

  test('describe a first and a last name as nullable text in the person-name format, as long as their column', () => {
    [userSchema.properties.firstName, userSchema.properties.lastName].forEach((field) => {
      assert.deepEqual([field.type, field.format, field.maxLength], [['string', 'null'], SCHEMA_FORMAT.PERSON_NAME, NAME_COLUMN_LENGTH]);
    });
  });

  test('take as a first and a last name one word of letters of any script, with a hyphen or an apostrophe inside it, of up to PERSON_NAME_MAX_LENGTH characters', async (t) => {
    const responses = await validate(t, userSchema.properties, PERSON_NAMES.map((name) => ({ ...USER, firstName: name, lastName: name })));

    assert.deepEqual(
      responses.map((response) => [response.statusCode, response.json().firstName, response.json().lastName]),
      PERSON_NAMES.map((name) => [200, name, name]),
    );
  });

  test('refuse as a first and a last name a title with a dot, a word with a digit, an emoji and a word over PERSON_NAME_MAX_LENGTH characters, by the format', async (t) => {
    const responses = await validate(t, userSchema.properties, NOT_PERSON_NAMES.map((name) => ({ ...USER, firstName: name, lastName: name })));

    assert.deepEqual(
      responses.map((response) => readFailures(response)),
      NOT_PERSON_NAMES.map(() => [['firstName', 'format'], ['lastName', 'format']]),
    );
  });

  test('still refuse a first and a last name longer than their column by the length alone', async (t) => {
    const [tooLong] = await validate(t, userSchema.properties, [{
      ...USER,
      firstName: 'a'.repeat(NAME_COLUMN_LENGTH + 1),
      lastName: 'b'.repeat(NAME_COLUMN_LENGTH + 1),
    }]);

    assert.deepEqual(readFailures(tooLong), [['firstName', 'maxLength'], ['lastName', 'maxLength']]);
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

  test('give a maxItems to every list whose items are compared with each other: the gate of a request needs it', () => {
    forEachEntity((schema, name) => {
      Object.entries(schema.properties)
        .filter(([, field]) => field.uniqueItems === true)
        .forEach(([key, field]) => assert.ok(Number.isSafeInteger(field.maxItems), `${name}.${key}`));
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
      fastify.get(`${PROBE_URL}/${name}s`, { schema: buildListSchema(schema), security: PUBLIC }, (request, reply) => {
        queries[name] = { ...request.query };

        return reply.list({ data: [schema.example] });
      });
      fastify.patch(`${PROBE_URL}/${name}s/:id`, { schema: buildUpdateSchema(schema), security: PUBLIC }, (request, reply) => reply.ok({
        ...schema.example,
        ...request.body,
      }));
    });

    const names = Object.keys(ENTITIES);
    const [lists, updates] = await Promise.all([
      Promise.all(names.map((name) => fastify.inject(`${PROBE_URL}/${name}s`))),
      Promise.all(names.map((name) => fastify.inject({
        method: 'PATCH',
        url: `${PROBE_URL}/${name}s/${ENTITIES[name].example.id}`,
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
