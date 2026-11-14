import { createTestDb } from '#root/tests/helper/db.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const testDb = await createTestDb();

test('builds an app and leaves it open', { skip: testDb.skip }, async () => {
  const fastify = await testDb.buildApp();

  assert.match(await fastify.db.verify(), /MariaDB/);
});
