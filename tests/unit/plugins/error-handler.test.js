import { loadUniqueFields } from '#core/schema/unique.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('error-handler plugin', () => {
  test('is registered under the name "error-handler" and decorates the app with the unique fields of the entity schemas', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    assert.equal(fastify.hasPlugin('error-handler'), true);
    assert.deepEqual(fastify.uniqueFields, await loadUniqueFields());
    assert.equal(fastify.uniqueFields.uq_users_email, 'email');
    assert.equal(Object.isFrozen(fastify.uniqueFields), true);
  });

  test('gives the routes of an encapsulated plugin the same map', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.register(async (instance) => {
      instance.get('/fields', async (request) => ({ isSame: request.server.uniqueFields === fastify.uniqueFields }));
    }, { prefix: '/scoped' });

    const response = await fastify.inject('/scoped/fields');

    assert.deepEqual(response.json(), { isSame: true });
  });
});
