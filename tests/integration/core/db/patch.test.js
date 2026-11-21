import { updateReturning } from '#core/db/index.js';
import { buildPatch } from '#core/db/patch.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { createTestDb } from '#root/tests/helper/db.js';
import assert from 'node:assert/strict';
import {
  before,
  beforeEach,
  describe,
  test,
} from 'node:test';

const ALLOWED = Object.freeze(['firstName', 'lastName', 'locale']);
const LESYA = Object.freeze({
  id: 1,
  firstName: 'Lesya',
  lastName: 'Ukrainka',
  locale: 'uk',
});

const testDb = await createTestDb();
const { run } = testDb;

function readPerson() {
  return testDb.readRows('SELECT id, first_name, last_name, locale FROM people WHERE id = 1');
}

describe('buildPatch and updateReturning', { skip: testDb.skip }, () => {
  before(() => testDb.readRows(`
    CREATE TABLE people (
      id INT PRIMARY KEY,
      first_name VARCHAR(100) COLLATE utf8mb4_uca1400_ai_ci NULL,
      last_name VARCHAR(100) COLLATE utf8mb4_uca1400_ai_ci NULL,
      locale VARCHAR(10) COLLATE utf8mb4_bin NULL
    ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin
  `));

  beforeEach(async () => {
    await testDb.readRows('DELETE FROM people');
    await testDb.readRows("INSERT INTO people (id, first_name, last_name, locale) VALUES (1, 'Lesya', 'Ukrainka', 'uk')");
  });

  test('a field the body does not have leaves its column alone, and null writes NULL', async () => {
    const patch = buildPatch({ lastName: 'Kosach', locale: null, isAdmin: true }, { allowed: ALLOWED });
    const updated = await run(() => updateReturning('people', patch, { where: { id: LESYA.id } }));

    assert.deepEqual(updated, [{ ...LESYA, lastName: 'Kosach', locale: null }]);
    assert.deepEqual(await readPerson(), [{
      id: 1,
      first_name: 'Lesya',
      last_name: 'Kosach',
      locale: null,
    }]);
  });

  test('a body without an allowed field answers 409 NO_CHANGES, and the row stays as it was', async (t) => {
    const fastify = await testDb.buildApp();

    t.after(() => fastify.close());
    fastify.patch('/people/:id', async (request) => {
      const patch = buildPatch(request.body, { allowed: ALLOWED });

      return updateReturning('people', patch, { where: { id: Number(request.params.id) } });
    });

    const response = await fastify.inject({ method: 'PATCH', url: '/people/1', payload: { isAdmin: true } });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, ERROR_CODE.NO_CHANGES);
    assert.deepEqual(await readPerson(), [{
      id: 1,
      first_name: 'Lesya',
      last_name: 'Ukrainka',
      locale: 'uk',
    }]);
  });
});
