import { createSchema } from '#core/schema/create-schema.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { SCOPE_ALL, SCOPE_CATALOG } from '#enums/scope.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import * as scopeSchema from '#schemas/entity/scope.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { example, properties } = scopeSchema;

const FIELDS = Object.freeze(['code', 'name', 'description']);
const CODES = Object.freeze(SCOPE_CATALOG.map((entry) => entry.code));
const WILDCARDS = Object.freeze(['groups:*', 'users:*']);

const BODY = Object.freeze({ type: 'object', required: FIELDS, additionalProperties: false });

async function validate(t, payloads) {
  const fastify = await buildTestApp();

  t.after(() => fastify.close());
  fastify.post('/scope', {
    schema: { body: { ...BODY, properties } },
  }, (request) => request.body);

  return Promise.all(payloads.map((payload) => fastify.inject({ method: 'POST', url: '/scope', payload })));
}

function readFailures(response) {
  return response.json().validation.map(({ column, operator }) => [column, operator]);
}

describe('the entity schema of a scope', () => {
  test('is frozen to its leaves', () => {
    assert.deepEqual([isDeepFrozen(properties), isDeepFrozen(example)], [true, true]);
  });

  test('exports its fields and an example, and nothing to filter, to sort or to report a duplicate by: the catalog lives in the code', () => {
    assert.deepEqual(Object.keys(scopeSchema), ['example', 'properties']);
    assert.deepEqual(Object.keys(properties), FIELDS);
  });

  test('describes every entry of the catalog: each has exactly its fields and passes through the validator of the app as it is', async (t) => {
    const responses = await validate(t, SCOPE_CATALOG);

    assert.deepEqual(SCOPE_CATALOG.map((entry) => Object.keys(entry)), SCOPE_CATALOG.map(() => FIELDS));
    assert.deepEqual(responses.map((response) => response.statusCode), SCOPE_CATALOG.map(() => HTTP_STATUS.OK));
    assert.deepEqual(responses.map((response) => response.json()), SCOPE_CATALOG);
  });

  test('takes as a code exactly the codes of the catalog in its order, the wildcards of a resource among them and full access not', () => {
    assert.deepEqual(properties.code.enum, CODES);
    assert.deepEqual(WILDCARDS.filter((code) => CODES.includes(code)), WILDCARDS);
    assert.equal(CODES.includes(SCOPE_ALL), false);
  });

  test('gives an example that is an entry of the catalog, with every field in their order', async (t) => {
    const [response] = await validate(t, [example]);

    assert.deepEqual(Object.keys(example), FIELDS);
    assert.deepEqual(SCOPE_CATALOG.filter((entry) => entry.code === example.code), [example]);
    assert.equal(response.statusCode, HTTP_STATUS.OK, response.body);
  });

  test('refuses full access, a code outside the catalog, an empty name and a missing description', async (t) => {
    const responses = await validate(t, [
      { ...example, code: SCOPE_ALL },
      { ...example, code: 'groups:write' },
      { ...example, name: '' },
      { code: example.code, name: example.name },
    ]);

    assert.deepEqual(responses.map((response) => readFailures(response)), [
      [['code', 'enum']],
      [['code', 'enum']],
      [['name', 'minLength']],
      [['description', 'required']],
    ]);
  });

  test('as a source of createSchema builds the list of the catalog with its example row', () => {
    const { response } = createSchema(scopeSchema).response(HTTP_STATUS.OK, { data: FIELDS, format: 'array' }).build();

    assert.deepEqual(response[HTTP_STATUS.OK].properties.data.items, { type: 'object', properties });
    assert.deepEqual(response[HTTP_STATUS.OK].examples, [{ status: 'success', data: [example] }]);
  });
});
