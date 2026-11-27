import { lockUsers } from '#core/auth/user.js';
import { assertActorHolds, readUserScopes } from '#core/authz/scope.js';
import { AppError } from '#core/error/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { SCOPE, SCOPE_ALL, SCOPE_CODES } from '#enums/scope.js';
import { USER_STATUS } from '#enums/user-status.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { connectAdmin, createTestDb, SMALL_POOL } from '#root/tests/helper/db.js';
import { appErrorOf, REFUSAL } from '#root/tests/helper/error.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createHoled } from '#root/tests/helper/object.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import {
  connectAppRedis,
  createUser,
  grantScopes,
  joinGroup,
  runInApp,
  runInTransaction,
} from '#root/tests/helper/session.js';
import { uuidv7 } from '#utils/id.js';
import { freezeDeep } from '#utils/object.js';
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

const STATEMENT_TIMEOUT = '0.2s';
const HANG_TIMEOUT_MS = 10_000;

const HOLDS_SIGNATURE = 'assertActorHolds(actor, { requirement, scopes })';
const ACTOR_REFUSAL = Object.freeze({
  name: 'TypeError',
  message: `${HOLDS_SIGNATURE} requires the locked row of the actor { id, status }, or null for one who is there no more`,
});
const REQUIREMENT_REFUSAL = Object.freeze({
  name: 'TypeError',
  message: /^assertActorHolds\(actor, \{ requirement, scopes \}\) (?:requires a non-empty list of scopes: |names ")/,
});
const SCOPES_REFUSAL = Object.freeze({
  name: 'TypeError',
  message: `${HOLDS_SIGNATURE} requires the scopes to look for as a list of strings`,
});
const OUTSIDE_TRANSACTION = Object.freeze({
  name: 'Error',
  message: `${HOLDS_SIGNATURE} judges under the lock of the row of the actor: it runs inside withTransaction()`,
});

const MANAGE_ONLY = freezeDeep({ requirement: [SCOPE.USERS_MANAGE], scopes: [] });
const READ_ONLY = freezeDeep({ requirement: [SCOPE.USERS_READ], scopes: [] });

const NOT_ACTORS = Object.freeze([
  undefined,
  false,
  uuidv7(),
  {},
  { status: USER_STATUS.ACTIVE },
  { id: 'user-1', status: USER_STATUS.ACTIVE },
  { id: uuidv7().toUpperCase(), status: USER_STATUS.ACTIVE },
  [{ id: uuidv7(), status: USER_STATUS.ACTIVE }],
]);

const NOT_REQUIREMENTS = Object.freeze([
  undefined,
  [],
  SCOPE.USERS_MANAGE,
  ['users:write'],
  [SCOPE.USERS_ALL],
  [SCOPE_ALL],
]);

// No literal holds a hole: the linter refuses a sparse array.
const NOT_SCOPE_LISTS = Object.freeze([
  undefined,
  null,
  SCOPE.USERS_READ,
  [1],
  createHoled(2, { 0: SCOPE.USERS_READ }),
]);

const MALFORMED_CALLS = Object.freeze([
  ...NOT_ACTORS.map((actor) => [inspect(actor), () => assertActorHolds(actor, MANAGE_ONLY), ACTOR_REFUSAL]),
  ...NOT_REQUIREMENTS.map((requirement) => [inspect(requirement), () => assertActorHolds(null, { requirement, scopes: [] }), REQUIREMENT_REFUSAL]),
  ['no terms at all', () => assertActorHolds(null), REQUIREMENT_REFUSAL],
  ...NOT_SCOPE_LISTS.map((scopes) => [inspect(scopes), () => assertActorHolds(null, { requirement: [SCOPE.USERS_MANAGE], scopes }), SCOPES_REFUSAL]),
  ['no scopes at all', () => assertActorHolds(null, { requirement: [SCOPE.USERS_MANAGE] }), SCOPES_REFUSAL],
]);

const FORBIDDEN = appErrorOf(REFUSAL.FORBIDDEN);

let fastify = null;

function read(userId) {
  return runInApp(fastify, () => readUserScopes(userId));
}

// As a flow judges its actor: the row of the actor locked first, in the transaction of the action.
function judge(actorId, terms) {
  return runInTransaction(fastify, async () => {
    const [actor = null] = await lockUsers([actorId]);

    return assertActorHolds(actor, terms);
  });
}

function judgeNobody(terms) {
  return runInTransaction(fastify, () => assertActorHolds(null, terms));
}

function assertMalformedRefused() {
  return Promise.all(MALFORMED_CALLS.map(([label, call, refusal]) => assert.rejects(call(), refusal, label)));
}

describe('readUserScopes', { skip: testRedis.skip || testDb.skip }, () => {
  before(async () => {
    await up();

    fastify = await testDb.buildApp({ db: SMALL_POOL });
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

    await joinGroup(testDb, { userId: memberId, groupId });

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
    const { inside, outside } = await runInTransaction(fastify, async () => {
      await fastify.db.query(JOIN_SQL, { userId, groupId });

      return { inside: await readUserScopes(userId), outside: await read(userId) };
    });

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

describe('assertActorHolds', { skip: testRedis.skip || testDb.skip }, () => {
  before(async () => {
    await up();

    fastify = await testDb.buildApp({ db: SMALL_POOL });
    await connectAppRedis(fastify);
  });

  after(() => fastify?.close());

  test('refuses with a TypeError an actor that is neither null nor a row with the UUID of a user, a requirement that is no list of actions and scopes that are no list of strings, before any statement and before it looks for a transaction: also where there is no context at all', async () => {
    await assertMalformedRefused();
    await runInTransaction(fastify, () => assertMalformedRefused());
  });

  test('throws outside withTransaction() before it judges, also for an actor who is there no more', async () => {
    const actorId = await createUser(fastify);

    await grantScopes(fastify, actorId, [SCOPE.USERS_MANAGE]);

    await assert.rejects(runInApp(fastify, () => assertActorHolds({ id: actorId, status: USER_STATUS.ACTIVE }, MANAGE_ONLY)), OUTSIDE_TRANSACTION);
    await assert.rejects(runInApp(fastify, () => assertActorHolds(null, MANAGE_ONLY)), OUTSIDE_TRANSACTION);
  });

  test('refuses with AUTHORIZATION_ERROR an actor who is there no more, however little is required', async () => {
    await assert.rejects(judgeNobody(READ_ONLY), FORBIDDEN);
    await assert.rejects(judge(uuidv7(), READ_ONLY), FORBIDDEN);
  });

  test('refuses with AUTHORIZATION_ERROR a blocked actor, whatever their groups grant: full access and every scope of the catalog among them', async () => {
    const actorId = await createUser(fastify, { status: USER_STATUS.BLOCKED });

    await grantScopes(fastify, actorId, SCOPE_CODES);
    await grantScopes(fastify, actorId, [], { isSuperadmin: true });

    await assert.rejects(judge(actorId, MANAGE_ONLY), FORBIDDEN);
    await assert.rejects(judge(actorId, READ_ONLY), FORBIDDEN);
  });

  test('passes an active actor whose groups meet the requirement and grant every scope listed, also when each group grants a part of them', async () => {
    const actorId = await createUser(fastify);

    await grantScopes(fastify, actorId, [SCOPE.USERS_MANAGE]);
    await grantScopes(fastify, actorId, [SCOPE.GROUPS_READ, SCOPE.USERS_READ]);

    assert.equal(await judge(actorId, { requirement: [SCOPE.USERS_MANAGE], scopes: [SCOPE.USERS_READ, SCOPE.GROUPS_READ, SCOPE.USERS_MANAGE] }), true);
  });

  test('refuses with AUTHORIZATION_ERROR an active actor who misses the requirement while holding the scopes listed, and one who misses a single scope of them', async () => {
    const [reader, manager] = await Promise.all([createUser(fastify), createUser(fastify)]);

    await grantScopes(fastify, reader, [SCOPE.USERS_READ, SCOPE.GROUPS_READ]);
    await grantScopes(fastify, manager, [SCOPE.USERS_MANAGE, SCOPE.USERS_READ]);

    await assert.rejects(judge(reader, { requirement: [SCOPE.USERS_MANAGE], scopes: [SCOPE.USERS_READ] }), FORBIDDEN);
    await assert.rejects(judge(manager, { requirement: [SCOPE.USERS_MANAGE], scopes: [SCOPE.USERS_READ, SCOPE.GROUPS_READ] }), FORBIDDEN);
    assert.equal(await judge(manager, { requirement: [SCOPE.USERS_MANAGE], scopes: [SCOPE.USERS_READ] }), true);
  });

  test('passes a member of a group of full access whatever is required and listed, full access among the scopes', async () => {
    const actorId = await createUser(fastify);

    await grantScopes(fastify, actorId, [], { isSuperadmin: true });

    assert.equal(await judge(actorId, { requirement: [[SCOPE.GROUPS_MANAGE, SCOPE.USERS_MANAGE]], scopes: [SCOPE_ALL, ...SCOPE_CODES] }), true);
  });

  test('refuses full access among the scopes to an actor who holds every scope of the catalog and not full access', async () => {
    const actorId = await createUser(fastify);

    await grantScopes(fastify, actorId, SCOPE_CODES);

    assert.equal(await judge(actorId, { requirement: [SCOPE.USERS_MANAGE], scopes: SCOPE_CODES }), true);
    await assert.rejects(judge(actorId, { requirement: [SCOPE.USERS_MANAGE], scopes: [SCOPE_ALL] }), FORBIDDEN);
  });

  test('takes users:* for users:read, users:manage and users:* itself, and for no scope of groups; the actions of users one by one are no users:*', async () => {
    const [wildcard, actions] = await Promise.all([createUser(fastify), createUser(fastify)]);

    await grantScopes(fastify, wildcard, [SCOPE.USERS_ALL]);
    await grantScopes(fastify, actions, [SCOPE.USERS_READ, SCOPE.USERS_MANAGE]);

    assert.equal(await judge(wildcard, { requirement: [SCOPE.USERS_MANAGE], scopes: [SCOPE.USERS_READ, SCOPE.USERS_MANAGE, SCOPE.USERS_ALL] }), true);
    await assert.rejects(judge(wildcard, { requirement: [SCOPE.USERS_MANAGE], scopes: [SCOPE.GROUPS_READ] }), FORBIDDEN);
    await assert.rejects(judge(actions, { requirement: [SCOPE.USERS_MANAGE], scopes: [SCOPE.USERS_ALL] }), FORBIDDEN);
  });

  test('needs the requirement alone when no scope is listed', async () => {
    const [manager, bare] = await Promise.all([createUser(fastify), createUser(fastify)]);

    await grantScopes(fastify, manager, [SCOPE.USERS_MANAGE]);

    assert.equal(await judge(manager, MANAGE_ONLY), true);
    await assert.rejects(judge(bare, MANAGE_ONLY), FORBIDDEN);
  });
});
