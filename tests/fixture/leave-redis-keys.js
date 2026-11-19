import { createTestRedis } from '#root/tests/helper/redis.js';
import assert from 'node:assert/strict';
import { stdout } from 'node:process';
import { test } from 'node:test';

const testRedis = await createTestRedis();

test('writes keys and leaves them for the helper to remove', { skip: testRedis.skip }, async () => {
  await testRedis.admin.set(`${testRedis.keyPrefix}left`, '1');
  await testRedis.admin.set(`${testRedis.keyPrefix}table-version:users`, '3');

  assert.equal((await testRedis.readKeys()).length, 2);
  stdout.write(`prefix=${testRedis.keyPrefix}\n`);
});
