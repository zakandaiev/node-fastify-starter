import { readUserScopes } from '#core/authz/scope.js';
import { withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { connectAdmin, createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  connectAppRedis,
  createUser,
  grantScopes,
  runInApp,
} from '#root/tests/helper/session.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import {
  after,
  before,
  describe,
  test,
} from 'node:test';
import { inspect } from 'node:util';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const JOIN_SQL = 'INSERT INTO user_groups (user_id, group_id) VALUES (:userId, :groupId)';

const CONNECTION_LIMIT = 2;

const STATEMENT_TIMEOUT = '0.2s';
const HANG_TIMEOUT_MS = 10_000;

let fastify = null;

function read(userId) {
  return runInApp(fastify, () => readUserScopes(userId));
}

describe('readUserScopes', { skip: testRedis.skip || testDb.skip }, () => {
  before(async () => {
    await up();

    fastify = await testDb.buildApp({ db: { connectionLimit: CONNECTION_LIMIT } });
    await connectAppRedis(fastify);
  });

  after(() => fastify?.close());

  test('gives none to a user in no group and to one who is not there, whatever the groups of others grant', async () => {
    const [userId, memberId] = await Promise.all([createUser(fastify), createUser(fastify)]);

    await grantScopes(fastify, memberId, ['users:read']);
    await grantScopes(fastify, memberId, [], { isSuperadmin: true });

    assert.deepEqual([await read(userId), await read(uuidv7())], [[], []]);
  });

  test('gives what the groups of the user grant together, sorted and each scope once', async () => {
    const userId = await createUser(fastify);

    await grantScopes(fastify, userId, ['users:write', 'groups:read', 'audit:read']);
    await grantScopes(fastify, userId, ['users:read', 'groups:read']);
    await grantScopes(fastify, userId, ['groups:manage', 'users:write']);

    assert.deepEqual(await read(userId), ['audit:read', 'groups:manage', 'groups:read', 'users:read', 'users:write']);
  });

  test('gives full access alone to a member of a group that has it, whatever that group and the others grant and whichever of them comes first', async () => {
    const [first, last, only] = await Promise.all([createUser(fastify), createUser(fastify), createUser(fastify)]);

    await grantScopes(fastify, first, ['audit:read'], { isSuperadmin: true });
    await grantScopes(fastify, first, ['users:read']);

    await grantScopes(fastify, last, ['users:read']);
    await grantScopes(fastify, last, []);
    await grantScopes(fastify, last, [], { isSuperadmin: true });

    await grantScopes(fastify, only, [], { isSuperadmin: true });

    assert.deepEqual(await Promise.all([first, last, only].map((userId) => read(userId))), [[SCOPE_ALL], [SCOPE_ALL], [SCOPE_ALL]]);
  });

  test('takes nothing from a group without scopes, and loses nothing of the others by it', async () => {
    const [bare, userId] = await Promise.all([createUser(fastify), createUser(fastify)]);

    await grantScopes(fastify, bare, []);
    await grantScopes(fastify, userId, []);
    await grantScopes(fastify, userId, ['users:read']);

    assert.deepEqual([await read(bare), await read(userId)], [[], ['users:read']]);
  });

  test('gives every member of a group the same', async () => {
    const [userId, memberId] = await Promise.all([createUser(fastify), createUser(fastify)]);
    const groupId = await grantScopes(fastify, userId, ['users:read', 'users:write']);

    await testDb.readRows(JOIN_SQL, { userId: memberId, groupId });

    assert.deepEqual([await read(userId), await read(memberId)], [['users:read', 'users:write'], ['users:read', 'users:write']]);
  });

  // By statements that move no version of a table: a read that was cached would not learn of them.
  test('is read anew each time: a scope and a group that are taken away are gone at once', async () => {
    const userId = await createUser(fastify);
    const groupId = await grantScopes(fastify, userId, ['users:read', 'users:write']);
    const granted = await read(userId);

    await testDb.readRows("DELETE FROM group_scopes WHERE group_id = :groupId AND scope = 'users:write'", { groupId });

    const reduced = await read(userId);

    await testDb.readRows('DELETE FROM user_groups WHERE group_id = :groupId', { groupId });

    assert.deepEqual([granted, reduced, await read(userId)], [['users:read', 'users:write'], ['users:read'], []]);
  });

  test('sees inside a transaction what that transaction has granted, before anybody else does', async () => {
    const [userId, memberId] = await Promise.all([createUser(fastify), createUser(fastify)]);
    const groupId = await grantScopes(fastify, memberId, ['users:read']);
    const { inside, outside } = await runInApp(fastify, () => withTransaction(async () => {
      await fastify.db.query(JOIN_SQL, { userId, groupId });

      return { inside: await readUserScopes(userId), outside: await read(userId) };
    }));

    assert.deepEqual([inside, outside, await read(userId)], [['users:read'], [], ['users:read']]);
  });

  test('gives up with 503 at the time limit of a statement', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const locker = await connectAdmin();

    t.after(() => locker.end());
    await locker.query(`LOCK TABLES ${testDb.name}.group_scopes WRITE`);

    // After the hook above: the pool closes only once the table is free, also when the read waits for it.
    const limited = testDb.open({ db: { statementTimeout: STATEMENT_TIMEOUT } }, t);
    const error = await rejectionOf(limited.run(() => readUserScopes(uuidv7())));

    assert.ok(error instanceof AppError, inspect(error));
    assert.deepEqual([error.code, error.cause?.kind], [ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, DB_ERROR_KIND.TIMEOUT]);
  });
});
