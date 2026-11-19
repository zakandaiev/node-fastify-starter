import { USER_STATUS } from '#enums/user-status.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { properties as groupProperties } from '#schemas/entity/group.js';
import { properties as userProperties } from '#schemas/entity/user.js';
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

describe('entity schemas', () => {
  test('are frozen to their leaves', () => {
    assert.ok(isDeepFrozen(userProperties));
    assert.ok(isDeepFrozen(groupProperties));
  });

  test('let a user through as the table gives one, also with null in every column that takes NULL', async (t) => {
    const responses = await validate(t, userProperties, [USER, BARE_USER]);

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    assert.deepEqual(responses.map((response) => response.json()), [USER, BARE_USER]);
  });

  test('refuse a status outside USER_STATUS, ACTIVE among them, and a text longer than its column', async (t) => {
    const [upperCase, unknown, tooLong] = await validate(t, userProperties, [
      { ...USER, status: 'ACTIVE' },
      { ...USER, status: 'deleted' },
      { ...USER, firstName: 'a'.repeat(101), locale: 'a'.repeat(36) },
    ]);

    assert.deepEqual(readFailures(upperCase), [['status', 'enum']]);
    assert.deepEqual(readFailures(unknown), [['status', 'enum']]);
    assert.deepEqual(readFailures(tooLong), [['firstName', 'maxLength'], ['locale', 'maxLength']]);
  });

  test('let a group through as the table gives one, and refuse a slug longer than its column and a flag that is not a boolean', async (t) => {
    const [group, refused] = await validate(t, groupProperties, [GROUP, { ...GROUP, slug: 'a'.repeat(65), isSystem: 'yes' }]);

    assert.equal(group.statusCode, 200);
    assert.deepEqual(group.json(), GROUP);
    assert.deepEqual(readFailures(refused), [['slug', 'maxLength'], ['isSystem', 'type']]);
  });
});
