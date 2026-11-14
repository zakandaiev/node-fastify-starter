import { createTestDb } from '#root/tests/helper/db.js';
import { describe, test } from 'node:test';

const testDb = await createTestDb();

describe('a suite that needs the database', { skip: testDb.skip }, () => {
  test('runs only with one', () => {});
});
