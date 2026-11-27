import { invalidateCacheTables, wrapCache } from '#core/cache/index.js';
import { createContext, runInContext } from '#core/context/index.js';
import {
  getDb,
  insertReturning,
  invalidateAfterWrite,
  updateReturning,
  upsert,
} from '#core/db/index.js';
import { withTransaction } from '#core/db/transaction.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { SCOPE } from '#enums/scope.js';
import { TABLE } from '#enums/table.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis, REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import {
  before,
  beforeEach,
  describe,
  test,
} from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const MEMBERS = 'members';
const NOTES = 'notes';
const TABLES = Object.freeze([MEMBERS, NOTES]);

// Names an object finds on Object.prototype: a write to a table of such a name must find no dependents there.
const PROTOTYPE_NAMES = Object.freeze(['constructor', '__proto__', 'toString']);
const WATCHED_TABLES = Object.freeze([...Object.values(TABLE), ...TABLES, ...PROTOTYPE_NAMES]);
const USERS_REACH = Object.freeze({
  [TABLE.USERS]: 1,
  [TABLE.USER_IDENTITIES]: 1,
  [TABLE.USER_GROUPS]: 1,
  [TABLE.SESSIONS]: 1,
});
const GROUPS_REACH = Object.freeze({ [TABLE.GROUPS]: 1, [TABLE.GROUP_SCOPES]: 1, [TABLE.USER_GROUPS]: 1 });
const ANNA = Object.freeze({ email: 'anna@example.com', firstName: 'Anna' });
const BORYS = Object.freeze({ email: 'borys@example.com', firstName: 'Borys' });
const BAD_FIELD_CODE = 'ER_BAD_FIELD_ERROR';
const COUNT_KEY = 'members-count';
const CALLED_EMAIL = 'called@example.com';
const UNAWAITED = /fn settled while a statement it had started was still running/;

// The JSON check of the server keeps it and JSON.parse refuses it: the driver fails a statement that has run.
const UNREADABLE_PROFILE = '[1e]';

function isUnreadable(error) {
  return error.code === 'UNREADABLE_JSON' && error.isExecuted === true;
}

function isDuplicateColumn(error) {
  return error.code === 'DUPLICATE_COLUMN' && error.isExecuted === true;
}

function isRefusedColumn(error) {
  return error.code === BAD_FIELD_CODE && !Object.hasOwn(error, 'isExecuted');
}

// The context of a request: the database of the file and a cache Redis, the one of the file unless another is given.
function openWithDatabase(opened = testRedis) {
  const context = createContext({ ...opened.context, db: testDb.db });

  function run(fn) {
    return runInContext(context, fn);
  }

  return run;
}

async function readVersions(tables = TABLES) {
  const values = await testRedis.admin.mget(tables.map((table) => `${testRedis.keyPrefix}table-version:${table}`));

  return Object.fromEntries(tables.map((table, index) => [table, Number(values[index])]));
}

// How far fn has moved the version of each table, read from the cache Redis before and after it.
async function countBumps(fn, tables = TABLES) {
  const start = await readVersions(tables);

  await fn();

  const end = await readVersions(tables);

  return Object.fromEntries(tables.map((table) => [table, end[table] - start[table]]));
}

// Only the tables of WATCHED_TABLES whose version fn has moved, each with how far: the others stayed as they were.
async function listBumped(fn) {
  const bumps = await countBumps(fn, WATCHED_TABLES);

  return Object.fromEntries(Object.entries(bumps).filter(([, count]) => count !== 0));
}

function readMembers() {
  return testDb.readRows('SELECT email, first_name, visits FROM members ORDER BY email');
}

describe('db helpers and the versions of the cache', { skip: testRedis.skip || testDb.skip }, () => {
  let run;

  before(async () => {
    run = openWithDatabase();
    await testDb.readRows(`
      CREATE TABLE members (
        id UUID PRIMARY KEY DEFAULT UUID_v7(),
        email VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
        first_name VARCHAR(100) COLLATE utf8mb4_uca1400_ai_ci NULL,
        visits INT NOT NULL DEFAULT 0,
        profile JSON NULL,
        UNIQUE KEY uq_members_email (email)
      ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin
    `);
    await testDb.readRows(`CREATE PROCEDURE add_member_and_select_twice() BEGIN INSERT INTO members (email) VALUES ('${CALLED_EMAIL}'); SELECT 1 AS one; SELECT 2 AS two; END`);
  });

  // The versions are there before each test: the first bump of a table also starts its version.
  beforeEach(async () => {
    await testDb.readRows('DELETE FROM members');
    await run(() => invalidateCacheTables(TABLES));
  });

  test('each helper bumps the version of its own table once its write is done, and no other', async () => {
    const inserted = await countBumps(() => run(() => insertReturning(MEMBERS, ANNA)));
    const upserted = await countBumps(() => run(() => upsert(MEMBERS, { ...ANNA, visits: 2 }, { update: ['visits'] })));
    const updated = await countBumps(() => run(() => updateReturning(MEMBERS, { firstName: 'Hanna' }, { where: { email: ANNA.email } })));

    assert.deepEqual([inserted, upserted, updated], [
      { [MEMBERS]: 1, [NOTES]: 0 },
      { [MEMBERS]: 1, [NOTES]: 0 },
      { [MEMBERS]: 1, [NOTES]: 0 },
    ]);
    assert.deepEqual(await readMembers(), [{ email: ANNA.email, first_name: 'Hanna', visits: 2 }]);
  });

  test('a write the server refuses bumps nothing, also an update whose read fails and is rolled back with it', async () => {
    await run(() => insertReturning(MEMBERS, ANNA));
    await run(() => insertReturning(MEMBERS, BORYS));

    // One after another: two of these updates lock the same row, and side by side they could deadlock.
    const bumps = await countBumps(async () => {
      await assert.rejects(run(() => insertReturning(MEMBERS, ANNA)), (error) => error.kind === DB_ERROR_KIND.UNIQUE);
      await assert.rejects(run(() => upsert(MEMBERS, { email: null, visits: 1 }, { update: ['visits'] })), /cannot be null/);
      await assert.rejects(
        run(() => updateReturning(MEMBERS, { email: BORYS.email }, { where: { firstName: ANNA.firstName } })),
        (error) => error.kind === DB_ERROR_KIND.UNIQUE,
      );
      await assert.rejects(
        run(() => updateReturning(MEMBERS, { visits: 5 }, { where: { email: ANNA.email }, returning: ['missing'] })),
        (error) => error.code === BAD_FIELD_CODE,
      );
    });

    assert.deepEqual(bumps, { [MEMBERS]: 0, [NOTES]: 0 });
    assert.deepEqual((await readMembers()).map((member) => member.visits), [0, 0]);
  });

  test('a write that has run and failed afterwards bumps its table, outside a transaction and in one that goes on to its commit', async () => {
    const outside = await countBumps(() => assert.rejects(run(() => insertReturning(MEMBERS, { ...ANNA, profile: UNREADABLE_PROFILE })), isUnreadable));
    const caught = await countBumps(() => run(() => withTransaction(async () => {
      await assert.rejects(insertReturning(MEMBERS, { ...BORYS, profile: UNREADABLE_PROFILE }), isUnreadable);
    })));

    assert.deepEqual([outside, caught], [{ [MEMBERS]: 1, [NOTES]: 0 }, { [MEMBERS]: 1, [NOTES]: 0 }]);
    assert.deepEqual((await readMembers()).map((member) => member.email), [ANNA.email, BORYS.email]);
  });

  test('the caller gets the error of the write also when its transaction refuses the bump: fn did not wait for the statement', async () => {
    let pending = null;

    const bumps = await countBumps(() => assert.rejects(run(() => withTransaction(async () => {
      pending = rejectionOf(insertReturning(MEMBERS, { ...ANNA, profile: UNREADABLE_PROFILE }));
    })), UNAWAITED));

    assert.ok(isUnreadable(await pending));
    assert.deepEqual(bumps, { [MEMBERS]: 0, [NOTES]: 0 });
    assert.deepEqual(await readMembers(), []);
  });

  test('invalidateAfterWrite bumps its tables after a write and after one the driver failed once it had run, not after one the server refused', async () => {
    const duplicated = await countBumps(() => assert.rejects(
      run(() => invalidateAfterWrite([MEMBERS], () => getDb().query('INSERT INTO members (email) VALUES (:email) RETURNING email, email', { email: ANNA.email }))),
      isDuplicateColumn,
    ));
    const selectedTwice = await countBumps(() => assert.rejects(
      run(() => invalidateAfterWrite([MEMBERS, NOTES], () => getDb().query('CALL add_member_and_select_twice()'))),
      (error) => error.code === 'MULTIPLE_RESULT_SETS' && error.isExecuted === true,
    ));
    const refused = await countBumps(() => assert.rejects(
      run(() => invalidateAfterWrite([MEMBERS], () => getDb().query('INSERT INTO members (nickname) VALUES (:email)', { email: BORYS.email }))),
      isRefusedColumn,
    ));
    const written = await countBumps(async () => {
      assert.equal(await run(() => invalidateAfterWrite([NOTES], async () => 'written')), 'written');
    });

    assert.deepEqual([duplicated, selectedTwice, refused, written], [
      { [MEMBERS]: 1, [NOTES]: 0 },
      { [MEMBERS]: 1, [NOTES]: 1 },
      { [MEMBERS]: 0, [NOTES]: 0 },
      { [MEMBERS]: 0, [NOTES]: 1 },
    ]);
    assert.deepEqual((await readMembers()).map((member) => member.email), [ANNA.email, CALLED_EMAIL]);
  });

  test('inside a transaction the bump waits for the commit, and a rollback of the transaction or of its savepoint drops it', async () => {
    let inside = null;

    const committed = await countBumps(() => run(() => withTransaction(async () => {
      await insertReturning(MEMBERS, ANNA);
      await upsert(MEMBERS, { ...ANNA, visits: 3 }, { update: ['visits'] });
      await updateReturning(MEMBERS, { firstName: 'Hanna' }, { where: { email: ANNA.email } });
      inside = await readVersions();
    })));
    const committedVersions = await readVersions();

    const rolledBack = await countBumps(() => assert.rejects(run(() => withTransaction(async () => {
      await insertReturning(MEMBERS, BORYS);
      await updateReturning(MEMBERS, { visits: 9 }, { where: { email: ANNA.email } });

      throw new Error('rollback');
    })), /rollback/));

    const savepoint = await countBumps(() => run(() => withTransaction(async () => {
      await assert.rejects(withTransaction(async () => {
        await insertReturning(MEMBERS, BORYS);

        throw new Error('savepoint rollback');
      }), /savepoint rollback/);
    })));

    assert.deepEqual(committed, { [MEMBERS]: 3, [NOTES]: 0 });
    assert.equal(inside[MEMBERS], committedVersions[MEMBERS] - 3);
    assert.deepEqual(rolledBack, { [MEMBERS]: 0, [NOTES]: 0 });
    assert.deepEqual(savepoint, { [MEMBERS]: 0, [NOTES]: 0 });
    assert.deepEqual(await readMembers(), [{ email: ANNA.email, first_name: 'Hanna', visits: 3 }]);
  });

  test('updateReturning inside a transaction that goes on after its read failed: the update is committed, and so is its bump', async () => {
    await run(() => insertReturning(MEMBERS, ANNA));

    const bumps = await countBumps(() => run(() => withTransaction(async () => {
      await assert.rejects(
        updateReturning(MEMBERS, { visits: 7 }, { where: { email: ANNA.email }, returning: ['missing'] }),
        (error) => error.code === BAD_FIELD_CODE,
      );
    })));

    assert.deepEqual(bumps, { [MEMBERS]: 1, [NOTES]: 0 });
    assert.deepEqual((await readMembers()).map((member) => member.visits), [7]);
  });

  test('a read the cache keeps of the table is computed again after each write of a helper, and comes from the cache between them', async () => {
    const calls = { count: 0 };

    async function countMembers() {
      calls.count += 1;

      const { rows: [{ total }] } = await getDb().query('SELECT COUNT(*) AS total FROM members');

      return total;
    }

    function readCount() {
      return run(() => wrapCache(COUNT_KEY, countMembers, { tables: [MEMBERS] }));
    }

    const counts = [await readCount(), await readCount()];

    await run(() => insertReturning(MEMBERS, ANNA));
    counts.push(await readCount(), await readCount());
    await run(() => upsert(MEMBERS, BORYS, { update: ['firstName'] }));
    counts.push(await readCount());
    await run(() => updateReturning(MEMBERS, { visits: 1 }, { where: { email: BORYS.email } }));
    counts.push(await readCount(), await readCount());

    assert.deepEqual(counts, [0, 0, 1, 1, 2, 2, 2]);
    assert.equal(calls.count, 4);
  });

  test('a write goes through while the cache Redis is down: the failed bump is not its error', async () => {
    const runDown = openWithDatabase(testRedis.open({ env: REDIS_DOWN_ENV }));

    const member = await runDown(() => insertReturning(MEMBERS, ANNA, { returning: ['email'] }));
    const upserted = await runDown(() => upsert(MEMBERS, { ...ANNA, visits: 4 }, { update: ['visits'] }));
    const updated = await runDown(() => updateReturning(MEMBERS, { firstName: 'Hanna' }, { where: { email: ANNA.email }, returning: ['firstName'] }));

    assert.deepEqual(member, { email: ANNA.email });
    assert.equal(upserted.affectedRows, 2);
    assert.deepEqual(updated, [{ firstName: 'Hanna' }]);
  });
});

describe('db writes and the tables the foreign keys of their table reach', { skip: testRedis.skip || testDb.skip }, () => {
  let run;

  function bumpAfter(tables) {
    return listBumped(() => run(() => invalidateAfterWrite(tables, async () => 'written')));
  }

  before(async () => {
    await up();
    run = openWithDatabase();
  });

  // The versions are there before each test: the first bump of a table also starts its version.
  beforeEach(async () => {
    await run(() => invalidateCacheTables(WATCHED_TABLES));
  });

  test('invalidateAfterWrite bumps with users the versions of user_identities, user_groups and sessions, not that of audit_logs, with groups those of group_scopes and user_groups, and a table both reach once', async () => {
    const users = await bumpAfter([TABLE.USERS]);
    const groups = await bumpAfter([TABLE.GROUPS]);
    const both = await bumpAfter([TABLE.GROUPS, TABLE.USERS]);

    assert.deepEqual([users, groups, both], [USERS_REACH, GROUPS_REACH, { ...USERS_REACH, ...GROUPS_REACH }]);
  });

  test('invalidateAfterWrite bumps its own version alone for a table no foreign key reaches out of, a name TABLE does not know and a name Object.prototype has', async () => {
    const tables = [TABLE.USER_IDENTITIES, TABLE.GROUP_SCOPES, TABLE.USER_GROUPS, TABLE.AUDIT_LOGS, TABLE.SESSIONS, MEMBERS, ...PROTOTYPE_NAMES];
    const bumps = await mapSeries(tables, (table) => bumpAfter([table]));

    assert.deepEqual(bumps, tables.map((table) => ({ [table]: 1 })));
  });

  test('insertReturning, upsert and updateReturning on users and on groups bump the tables their foreign keys reach too, and on a table no key reaches out of that table alone', async () => {
    const userId = uuidv7();
    const groupId = uuidv7();
    const group = { id: groupId, slug: `reach-${groupId}`, name: 'Readers' };

    const userInserted = await listBumped(() => run(() => insertReturning(TABLE.USERS, { id: userId, firstName: 'Anna' })));
    const userUpserted = await listBumped(() => run(() => upsert(TABLE.USERS, { id: userId, firstName: 'Hanna' }, { update: ['firstName'] })));
    const userUpdated = await listBumped(() => run(() => updateReturning(TABLE.USERS, { lastName: 'Koval' }, { where: { id: userId } })));
    const groupInserted = await listBumped(() => run(() => insertReturning(TABLE.GROUPS, group)));
    const groupUpserted = await listBumped(() => run(() => upsert(TABLE.GROUPS, { ...group, name: 'Writers' }, { update: ['name'] })));
    const groupUpdated = await listBumped(() => run(() => updateReturning(TABLE.GROUPS, { description: 'Read only' }, { where: { id: groupId } })));
    const scopeInserted = await listBumped(() => run(() => insertReturning(TABLE.GROUP_SCOPES, { groupId, scope: SCOPE.GROUPS_READ })));
    const memberInserted = await listBumped(() => run(() => insertReturning(TABLE.USER_GROUPS, { userId, groupId })));

    assert.deepEqual(
      [userInserted, userUpserted, userUpdated, groupInserted, groupUpserted, groupUpdated, scopeInserted, memberInserted],
      [USERS_REACH, USERS_REACH, USERS_REACH, GROUPS_REACH, GROUPS_REACH, GROUPS_REACH, { [TABLE.GROUP_SCOPES]: 1 }, { [TABLE.USER_GROUPS]: 1 }],
    );
    assert.deepEqual(await testDb.readRows('SELECT first_name, last_name FROM users WHERE id = :userId', { userId }), [{ first_name: 'Hanna', last_name: 'Koval' }]);
    assert.deepEqual(await testDb.readRows('SELECT name, description FROM groups WHERE id = :groupId', { groupId }), [{ name: 'Writers', description: 'Read only' }]);
  });

  test('inside a transaction the tables the foreign keys reach are bumped with their own table after the commit, and a rollback drops every one of the bumps', async () => {
    const userId = uuidv7();
    const start = await readVersions(WATCHED_TABLES);
    let inside = null;

    const committed = await listBumped(() => run(() => withTransaction(async () => {
      await insertReturning(TABLE.USERS, { id: userId });
      inside = await readVersions(WATCHED_TABLES);
    })));
    const rolledBack = await listBumped(() => assert.rejects(run(() => withTransaction(async () => {
      await updateReturning(TABLE.USERS, { firstName: 'Anna' }, { where: { id: userId } });

      throw new Error('rollback');
    })), /rollback/));

    assert.deepEqual(inside, start);
    assert.deepEqual([committed, rolledBack], [USERS_REACH, {}]);
  });

  test('a write to users or to groups that the server ran and the driver then failed on bumps the tables their foreign keys reach too, and one the server refused bumps none of them', async () => {
    const userId = uuidv7();
    const groupId = uuidv7();
    const group = { groupId, slug: `executed-${groupId}`, name: 'Readers' };

    await testDb.readRows('INSERT INTO users (id) VALUES (:userId)', { userId });
    await testDb.readRows('INSERT INTO user_identities (user_id, provider, provider_user_id) VALUES (:userId, :provider, :providerUserId)', {
      userId,
      provider: 'test',
      providerUserId: userId,
    });

    const deleted = await listBumped(() => assert.rejects(
      run(() => invalidateAfterWrite([TABLE.USERS], () => getDb().query('DELETE FROM users WHERE id = :userId RETURNING id, id', { userId }))),
      isDuplicateColumn,
    ));
    const inserted = await listBumped(() => assert.rejects(
      run(() => invalidateAfterWrite([TABLE.GROUPS], () => getDb().query('INSERT INTO groups (id, slug, name) VALUES (:groupId, :slug, :name) RETURNING slug, slug', group))),
      isDuplicateColumn,
    ));
    const refused = await listBumped(() => assert.rejects(
      run(() => invalidateAfterWrite([TABLE.USERS, TABLE.GROUPS], () => getDb().query('DELETE FROM groups WHERE nickname = :name', { name: group.name }))),
      isRefusedColumn,
    ));
    const duplicated = await listBumped(() => assert.rejects(
      run(() => insertReturning(TABLE.GROUPS, { slug: group.slug, name: group.name })),
      (error) => error.kind === DB_ERROR_KIND.UNIQUE,
    ));

    assert.deepEqual([deleted, inserted, refused, duplicated], [USERS_REACH, GROUPS_REACH, {}, {}]);
    assert.deepEqual(await testDb.readRows('SELECT user_id FROM user_identities WHERE user_id = :userId', { userId }), []);
    assert.deepEqual(await testDb.readRows('SELECT slug FROM groups WHERE id = :groupId', { groupId }), [{ slug: group.slug }]);
  });
});

describe('invalidateAfterWrite', () => {
  test('refuses tables that are not table names by the rule of the cache, and a write that is not a function, before it runs anything', async (t) => {
    const write = t.mock.fn(async () => true);
    const tablesRefusal = { name: 'TypeError', message: 'invalidateAfterWrite(tables, write) requires tables to be a non-empty array of table names' };

    await Promise.all([[], [''], [MEMBERS, 5], MEMBERS, undefined].map((tables) => assert.rejects(invalidateAfterWrite(tables, write), tablesRefusal)));
    await assert.rejects(invalidateAfterWrite([MEMBERS], 'INSERT INTO members (email) VALUES (1)'), {
      name: 'TypeError',
      message: 'invalidateAfterWrite(tables, write) requires write to be a function',
    });
    assert.equal(write.mock.callCount(), 0);
  });
});
