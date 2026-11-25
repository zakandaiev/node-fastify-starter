import { SCHEMA_LIMITS } from '#config/schema.js';
import { createSchema } from '#core/schema/create-schema.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { buildTestApp, readRequestId } from '#root/tests/helper/app.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { listEnvelope } from '#schemas/common/envelope.js';
import * as sessionSchema from '#schemas/entity/session.js';
import { toDate } from '#utils/date.js';
import { IP_MAX_LENGTH } from '#utils/validate.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { example, properties } = sessionSchema;

const FIELDS = Object.freeze(['id', 'userAgent', 'ip', 'isDev', 'startedAt', 'rotatedAt', 'expiresAt', 'isCurrent']);
const MOMENTS = Object.freeze(['startedAt', 'rotatedAt', 'expiresAt']);

const LONGEST_IP = '0000:0000:0000:0000:0000:ffff:255.255.255.255';

const UNTOLD = Object.freeze({
  userId: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b',
  refreshTokenHash: 'ab'.repeat(32),
  revokedAt: null,
});

const COSTLY_KEYWORDS = Object.freeze(['pattern', 'format']);
const BODY = Object.freeze({ type: 'object', required: FIELDS, additionalProperties: false });
const PUBLIC = Object.freeze({ auth: false });
const DEVICES_URL = '/api/v1/devices';

async function buildApp(t) {
  const fastify = await buildTestApp({ env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()) } });

  t.after(() => fastify.close());

  return fastify;
}

async function validate(t, payloads) {
  const fastify = await buildApp(t);

  fastify.post('/session', {
    schema: { body: { ...BODY, properties } },
  }, (request) => request.body);

  return Promise.all(payloads.map((payload) => fastify.inject({ method: 'POST', url: '/session', payload })));
}

function readFailures(response) {
  return response.json().validation.map(({ column, operator }) => [column, operator]);
}

function buildListSchema() {
  return createSchema(sessionSchema)
    .response(HTTP_STATUS.OK, { data: FIELDS, format: 'array' })
    .defaultResponses()
    .build();
}

function buildOneSchema() {
  return createSchema(sessionSchema)
    .params(['id'])
    .response(HTTP_STATUS.OK, { data: FIELDS })
    .defaultResponses()
    .build();
}

describe('the entity schema of a session', () => {
  test('is frozen to its leaves', () => {
    assert.deepEqual([isDeepFrozen(properties), isDeepFrozen(example)], [true, true]);
  });

  test('exports its fields and an example, and nothing to filter, to sort or to report a duplicate by', () => {
    assert.deepEqual(Object.keys(sessionSchema), ['example', 'properties']);
  });

  test('has no field for the hash of the refresh token, for the user and for the end of a session', () => {
    assert.deepEqual(Object.keys(properties), FIELDS);
  });

  test('gives a maxLength to every field with a pattern or a format: the gate of a request needs it', () => {
    const costly = Object.entries(properties).filter(([, field]) => COSTLY_KEYWORDS.some((keyword) => field[keyword] !== undefined));

    assert.deepEqual(costly.map(([key]) => key), ['id', ...MOMENTS]);
    assert.ok(costly.every(([, field]) => Number.isSafeInteger(field.maxLength)));
  });

  test('gives an example of every field, in their order, that its own properties let through the validator of the app', async (t) => {
    const [response] = await validate(t, [example]);

    assert.deepEqual(Object.keys(example), FIELDS);
    assert.equal(response.statusCode, HTTP_STATUS.OK, response.body);
    assert.deepEqual(response.json(), example);
  });

  test('lets a session through whose client has told nothing of itself, and one with the longest user agent and address', async (t) => {
    const payloads = [
      {
        ...example, userAgent: null, ip: null, isDev: true, isCurrent: false,
      },
      { ...example, userAgent: 'a'.repeat(SCHEMA_LIMITS.userAgentMaxLength), ip: LONGEST_IP },
    ];
    const responses = await validate(t, payloads);

    assert.equal(LONGEST_IP.length, IP_MAX_LENGTH);
    assert.deepEqual(responses.map((response) => response.statusCode), [HTTP_STATUS.OK, HTTP_STATUS.OK]);
    assert.deepEqual(responses.map((response) => response.json()), payloads);
  });

  test('refuses an id that is not spelled as the database spells one, a text its column does not hold, a flag that is not one and a moment that is not in UTC or is not there', async (t) => {
    const payloads = [
      { ...example, id: example.id.toUpperCase() },
      { ...example, userAgent: 'a'.repeat(SCHEMA_LIMITS.userAgentMaxLength + 1), ip: `${LONGEST_IP}0` },
      { ...example, userAgent: '', ip: '' },
      { ...example, isDev: 'yes', isCurrent: null },
      {
        ...example, startedAt: '2026-11-19T10:00:00.000', rotatedAt: '2026-11-19T10:00:00.000+02:00', expiresAt: null,
      },
    ];
    const responses = await validate(t, payloads);

    assert.deepEqual(responses.map((response) => readFailures(response)), [
      [['id', 'pattern']],
      [['userAgent', 'maxLength'], ['ip', 'maxLength']],
      [['userAgent', 'minLength'], ['ip', 'minLength']],
      [['isDev', 'type'], ['isCurrent', 'type']],
      [['startedAt', 'format'], ['rotatedAt', 'format'], ['expiresAt', 'type']],
    ]);
  });
});

describe('the entity schema of a session as a source of createSchema', () => {
  test('builds a list of its fields, with its example', () => {
    const { response } = buildListSchema();
    const list = listEnvelope({ type: 'object', properties });

    assert.deepEqual(response[HTTP_STATUS.OK].properties, list.properties);
    assert.deepEqual(response[HTTP_STATUS.OK].examples, [{ status: 'success', data: [example] }]);
  });

  test('builds the parameters of a path to one session: its id, required', () => {
    const { params, response } = buildOneSchema();

    assert.deepEqual(params, {
      type: 'object',
      properties: { id: properties.id },
      required: ['id'],
      additionalProperties: false,
    });
    assert.deepEqual(response[HTTP_STATUS.OK].examples, [{ status: 'success', data: example }]);
  });

  test('gives routes the app starts with: they write the moments of a row in UTC, its NULL as null, and nothing that is no field', async (t) => {
    const fastify = await buildApp(t);
    const moments = Object.fromEntries(MOMENTS.map((key) => [key, toDate(example[key])]));
    const row = {
      ...example, ...moments, ...UNTOLD, userAgent: null, ip: null,
    };
    const told = { ...example, userAgent: null, ip: null };

    fastify.get(DEVICES_URL, { schema: buildListSchema(), security: PUBLIC }, (request, reply) => reply.list({ data: [row] }));
    fastify.get(`${DEVICES_URL}/:id`, { schema: buildOneSchema(), security: PUBLIC }, (request, reply) => reply.ok({ ...row, id: request.params.id }));

    const [list, one] = await Promise.all([fastify.inject(DEVICES_URL), fastify.inject(`${DEVICES_URL}/${UNTOLD.userId}`)]);

    assert.equal(list.statusCode, HTTP_STATUS.OK, list.body);
    assert.deepEqual(list.json(), { status: 'success', data: [told], meta: { requestId: readRequestId(list) } });
    assert.equal(one.statusCode, HTTP_STATUS.OK, one.body);
    assert.deepEqual(one.json(), { status: 'success', data: { ...told, id: UNTOLD.userId }, meta: { requestId: readRequestId(one) } });
  });

  test('answers 404 to a path whose id is not spelled as the database spells one', async (t) => {
    const fastify = await buildApp(t);

    fastify.get(`${DEVICES_URL}/:id`, { schema: buildOneSchema(), security: PUBLIC }, (request, reply) => reply.ok({ ...example, id: request.params.id }));

    const ids = [example.id, example.id.toUpperCase(), 'current', '1'];
    const responses = await Promise.all(ids.map((id) => fastify.inject(`${DEVICES_URL}/${id}`)));

    assert.deepEqual(
      responses.map((response) => response.statusCode),
      [HTTP_STATUS.OK, HTTP_STATUS.NOT_FOUND, HTTP_STATUS.NOT_FOUND, HTTP_STATUS.NOT_FOUND],
    );
  });
});
