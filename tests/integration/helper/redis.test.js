import { PROCESS_KEY_PREFIX, REDIS_TEST_PREFIX } from '#root/tests/helper/config.js';
import { createDatabaseName } from '#root/tests/helper/db.js';
import { createWorkDir, runNode } from '#root/tests/helper/process.js';
import {
  createAclUser,
  createKeyPrefix,
  createTestRedis,
  readRedisEnv,
  removeStaleKeys,
  removeStaleUsers,
  scanKeys,
  toScanPattern,
} from '#root/tests/helper/redis.js';
import { uuidv7 } from '#utils/id.js';
import { Redis } from 'ioredis';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const testRedis = await createTestRedis();

const LEAVE_REDIS_KEYS = 'tests/fixture/leave-redis-keys.js';

const MS_IN_MINUTE = 60000;
const STALE_MINUTES = 61;
const YOUNG_MINUTES = 59;
const HEX_RADIX = 16;
const MOMENT_DIGITS = 12;
const MOMENT_HIGH_DIGITS = 8;

const PREFIX_REGEXP = /^nfs-test:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}:$/;

// A UUIDv7 that says it was made "minutes" ago.
function createAgedId(minutes) {
  const moment = (Date.now() - minutes * MS_IN_MINUTE).toString(HEX_RADIX).padStart(MOMENT_DIGITS, '0');
  const id = uuidv7();

  return `${moment.slice(0, MOMENT_HIGH_DIGITS)}-${moment.slice(MOMENT_HIGH_DIGITS)}${id.slice(MOMENT_DIGITS + 1)}`;
}

describe('createTestRedis', { skip: testRedis.skip }, () => {
  test('gives the file the key prefix of its process, the one every config of the tests carries', () => {
    assert.match(testRedis.keyPrefix, PREFIX_REGEXP);
    assert.equal(testRedis.keyPrefix, PROCESS_KEY_PREFIX);
    assert.equal(testRedis.config.redis.keyPrefix, testRedis.keyPrefix);
    assert.equal(testRedis.redis.keyPrefix, testRedis.keyPrefix);
  });

  test('removes the keys of a file after its last test', async (t) => {
    const { code, stdout } = await runNode(LEAVE_REDIS_KEYS, { cwd: await createWorkDir(t, readRedisEnv()) });
    const prefix = /prefix=(\S+)/.exec(stdout)?.[1];

    assert.equal(code, 0, stdout);
    assert.match(prefix, PREFIX_REGEXP);
    assert.notEqual(prefix, testRedis.keyPrefix);
    assert.deepEqual(await scanKeys(testRedis.admin, toScanPattern(prefix)), []);
  });

  test('removes the keys a killed run left behind once they are an hour old, and only those', async (t) => {
    const appName = testRedis.config.app.name;
    const stale = `${createKeyPrefix(createAgedId(STALE_MINUTES))}left`;
    const staleOfDatabase = `${appName}:${createDatabaseName(createAgedId(STALE_MINUTES))}:session:1`;
    const kept = [
      `${createKeyPrefix(createAgedId(YOUNG_MINUTES))}left`,
      `${appName}:${createDatabaseName(createAgedId(YOUNG_MINUTES))}:session:1`,
      `${REDIS_TEST_PREFIX}not-a-uuid:left`,
      `nfs-testx:${createAgedId(STALE_MINUTES)}:left`,
      `${appName}:nfs_dev:left-${uuidv7()}`,
      `${testRedis.keyPrefix}own`,
    ];
    const keys = [stale, staleOfDatabase, ...kept];

    t.after(() => testRedis.admin.unlink(...keys));
    await Promise.all(keys.map((key) => testRedis.admin.set(key, '1', 'PX', MS_IN_MINUTE)));

    await removeStaleKeys(testRedis.admin);

    assert.deepEqual(await Promise.all([stale, staleOfDatabase].map((key) => testRedis.admin.exists(key))), [0, 0]);
    assert.deepEqual(await Promise.all(kept.map((key) => testRedis.admin.exists(key))), kept.map(() => 1));
  });

  test('removes the accounts of the tests a killed run left behind once they are an hour old', async (t) => {
    const stale = `nfs-test-${createAgedId(STALE_MINUTES)}`;
    const young = `nfs-test-${createAgedId(YOUNG_MINUTES)}`;
    const users = [stale, young];

    t.after(() => Promise.allSettled(users.map((user) => testRedis.admin.acl('DELUSER', user))));
    await Promise.all(users.map((user) => testRedis.admin.acl('SETUSER', user, 'off')));

    await removeStaleUsers(testRedis.admin);

    const listed = await testRedis.admin.acl('USERS');

    assert.equal(listed.includes(stale), false);
    assert.equal(listed.includes(young), true);
  });

  test('creates an account that sees the keys of the file only, and removes it', async () => {
    const account = await createAclUser(testRedis.admin, ['+@all']);
    const client = new Redis({
      host: testRedis.config.redis.host,
      port: testRedis.config.redis.port,
      username: account.env.APP_REDIS_USER,
      password: account.env.APP_REDIS_PASSWORD,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });

    try {
      await client.connect();
      assert.equal(await client.set(`${testRedis.keyPrefix}acl`, '1', 'PX', MS_IN_MINUTE), 'OK');
      await assert.rejects(client.get('not-of-this-file'), /NOPERM/);
    } finally {
      client.disconnect();
      await account.remove();
    }

    assert.equal((await testRedis.admin.acl('USERS')).includes(account.env.APP_REDIS_USER), false);
  });
});
