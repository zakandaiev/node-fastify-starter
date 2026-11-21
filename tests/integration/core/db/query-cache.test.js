import { invalidateCacheTables } from '#core/cache/index.js';
import { createContext, runInContext } from '#core/context/index.js';
import { createQuery } from '#core/db/query.js';
import { withTransaction } from '#core/db/transaction.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { TABLE } from '#enums/table.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import { createTestRedis } from '#root/tests/helper/redis.js';
import * as groupSchema from '#schemas/entity/group.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

const GROUPS_SQL = 'SELECT slug, name, is_system, created_at FROM groups WHERE slug LIKE :prefix ORDER BY slug';
const INSERT_GROUP_SQL = 'INSERT INTO groups (slug, name) VALUES (:slug, :name)';
const RENAME_SQL = 'UPDATE groups SET name = :name WHERE slug = :slug';
const INSERT_USER_SQL = 'INSERT INTO users (id, first_name) VALUES (:id, :firstName)';
const INSERT_IDENTITY_SQL = 'INSERT INTO user_identities (user_id, provider, provider_user_id, profile) VALUES (:userId, :provider, :providerUserId, :profile) RETURNING provider_user_id, profile';
const BAD_FIELD_CODE = 'ER_BAD_FIELD_ERROR';
const UNREADABLE_JSON_CODE = 'UNREADABLE_JSON';

// The JSON check of the server keeps it and JSON.parse refuses it: the driver fails a statement that has run.
const UNREADABLE_PROFILE = '[1e]';

// A hundred million rows: far longer than the limit of the test, which the server checks while it reads them, and
// still over within seconds when a regression drops the limit, instead of holding the run for hours.
const HEAVY_SQL = 'SELECT COUNT(*) AS total FROM seq_1_to_100000 a JOIN seq_1_to_1000 b';
const SLOW_SQL = 'SELECT SLEEP(0.3) AS waited';
const STATEMENT_TIMEOUT = '0.1s';
const RETRY_AFTER = '60';

let markerCount = 0;

// A prefix of slugs no other test of the file uses: the groups of one test, and what is cached of them,
// must not answer the next.
function nextMarker(name) {
  markerCount += 1;

  return `${name}-${markerCount}-`;
}

// The context of a request: a pool of the database of the file and the cache Redis of the file.
function openWithDatabase(pool = testDb) {
  const context = createContext({ ...testRedis.context, db: pool.db });

  function run(fn) {
    return runInContext(context, fn);
  }

  return run;
}

function insertGroup(slug, name) {
  return testDb.readRows(INSERT_GROUP_SQL, { slug, name });
}

// A statement of the pool alone bumps no version: the cache does not learn of this change.
function renameUnseen(slug, name) {
  return testDb.readRows(RENAME_SQL, { slug, name });
}

function readVersion(table) {
  return testRedis.admin.get(`${testRedis.keyPrefix}table-version:${table}`);
}

async function countCacheEntries() {
  const keys = await testRedis.readKeys();

  return keys.filter((key) => key.startsWith(`${testRedis.keyPrefix}cache:`)).length;
}

function listGroups(marker, binding = {}) {
  return createQuery(GROUPS_SQL, { prefix: `${marker}%`, ...binding }).cache({ tables: [TABLE.GROUPS] });
}

function renameGroup(slug, name) {
  return createQuery(RENAME_SQL, { slug, name }).cache({ tables: [TABLE.GROUPS] });
}

describe('createQuery and the cache', { skip: testRedis.skip || testDb.skip }, () => {
  let run;

  async function execute(query, runIn = run) {
    await runIn(() => query.execute());

    return query;
  }

  async function readNames(query, runIn = run) {
    return (await execute(query, runIn)).fetchAll().map((row) => row.name);
  }

  // The versions are there before the first read: a read of a table that has none yet goes to the database uncached.
  before(async () => {
    await up();
    run = openWithDatabase();
    await run(() => invalidateCacheTables([TABLE.USERS, TABLE.USER_IDENTITIES, TABLE.GROUPS]));
  });

  test('a repeated read comes from the cache, and the read after a write through createQuery does not', async () => {
    const marker = nextMarker('repeat');

    await insertGroup(`${marker}a`, 'A');

    assert.deepEqual(await readNames(listGroups(marker)), ['A']);

    await insertGroup(`${marker}b`, 'B');

    assert.deepEqual(await readNames(listGroups(marker)), ['A']);

    const write = await execute(renameGroup(`${marker}a`, 'A2'));

    assert.equal(write.affectedRows(), 1);
    assert.deepEqual(await readNames(listGroups(marker)), ['A2', 'B']);
  });

  test('a write in a rolled-back transaction leaves the version as it was, a failed one bumps nothing, a committed one bumps it once after the commit', async () => {
    const slug = `${nextMarker('rollback')}a`;

    await insertGroup(slug, 'A');

    const versionBefore = Number(await readVersion(TABLE.GROUPS));
    let versionInside = null;

    await assert.rejects(run(() => withTransaction(async () => {
      await renameGroup(slug, 'rolled back').execute();

      throw new Error('rollback');
    })), /rollback/);

    assert.equal(Number(await readVersion(TABLE.GROUPS)), versionBefore);

    await assert.rejects(
      run(() => createQuery('UPDATE groups SET missing_column = 1 WHERE slug = :slug', { slug }).cache({ tables: [TABLE.GROUPS] }).execute()),
      (error) => error.code === BAD_FIELD_CODE,
    );

    assert.equal(Number(await readVersion(TABLE.GROUPS)), versionBefore);

    await run(() => withTransaction(async () => {
      await renameGroup(slug, 'committed').execute();
      versionInside = Number(await readVersion(TABLE.GROUPS));
    }));

    assert.equal(versionInside, versionBefore);
    assert.equal(Number(await readVersion(TABLE.GROUPS)), versionBefore + 1);
    assert.deepEqual(await testDb.readRows('SELECT name FROM groups WHERE slug = :slug', { slug }), [{ name: 'committed' }]);
  });

  test('a write that has run and failed afterwards bumps its tables: a RETURNING row of unreadable JSON, and two columns that are one name in camelCase', async () => {
    const marker = nextMarker('executed');
    const userId = uuidv7();
    const identity = {
      userId,
      provider: 'test',
      providerUserId: `${marker}a`,
      profile: UNREADABLE_PROFILE,
    };
    const group = { slug: `${marker}a`, name: 'A' };

    await testDb.readRows(INSERT_USER_SQL, { id: userId, firstName: 'Anna' });

    assert.deepEqual(await readNames(listGroups(marker)), []);

    const versionsBefore = [Number(await readVersion(TABLE.USER_IDENTITIES)), Number(await readVersion(TABLE.GROUPS))];
    const unreadable = await rejectionOf(run(() => createQuery(INSERT_IDENTITY_SQL, identity).cache({ tables: [TABLE.USER_IDENTITIES] }).execute()));
    const clash = await rejectionOf(run(() => createQuery(`${INSERT_GROUP_SQL} RETURNING slug AS group_slug, name AS groupSlug`, group).cache({ tables: [TABLE.GROUPS] }).execute()));

    assert.deepEqual([unreadable.code, unreadable.isExecuted], [UNREADABLE_JSON_CODE, true]);
    assert.match(clash.message, /: the column "group_slug" and the column "groupSlug" are one name in camelCase/);
    assert.deepEqual(
      [Number(await readVersion(TABLE.USER_IDENTITIES)), Number(await readVersion(TABLE.GROUPS))],
      versionsBefore.map((version) => version + 1),
    );
    assert.deepEqual(await testDb.readRows('SELECT provider_user_id FROM user_identities WHERE user_id = :userId', identity), [{ provider_user_id: identity.providerUserId }]);
    assert.deepEqual(await readNames(listGroups(marker)), [group.name]);
  });

  test('a read inside a transaction goes past the cache: it sees what the cache does not, and leaves the entry as it was', async () => {
    const marker = nextMarker('transaction');

    await insertGroup(`${marker}a`, 'A');

    assert.deepEqual(await readNames(listGroups(marker)), ['A']);

    await insertGroup(`${marker}b`, 'B');

    const inside = await run(() => withTransaction(async () => {
      const query = listGroups(marker);

      await query.execute();

      return query.fetchAll().map((row) => row.name);
    }));

    assert.deepEqual(inside, ['A', 'B']);
    assert.deepEqual(await readNames(listGroups(marker)), ['A']);
  });

  test('a hit gives back a Date and a boolean just as the miss does', async () => {
    const marker = nextMarker('date');
    const slug = `${marker}a`;

    await insertGroup(slug, 'A');

    const miss = await execute(listGroups(marker));

    await renameUnseen(slug, 'changed');

    const hit = await execute(listGroups(marker));

    assert.equal(hit.fetch().name, 'A');
    assert.ok(miss.fetch().createdAt instanceof Date);
    assert.ok(hit.fetch().createdAt instanceof Date);
    assert.equal(hit.fetchColumn(2), false);
    assert.deepEqual(hit.fetchAll(), miss.fetchAll());
  });

  test('the key does not depend on keys of the binding that the statement does not use', async () => {
    const marker = nextMarker('unused');

    await insertGroup(`${marker}a`, 'A');

    const entriesBefore = await countCacheEntries();

    assert.deepEqual(await readNames(listGroups(marker)), ['A']);

    await insertGroup(`${marker}b`, 'B');

    assert.deepEqual(await readNames(listGroups(marker, { unused: 'x', other: 1 })), ['A']);
    assert.equal(await countCacheEntries(), entriesBefore + 1);
  });

  test('a text filter in effect leaves the cache aside', async () => {
    const marker = nextMarker('text');

    await insertGroup(`${marker}a`, 'Alpha');

    const entriesBefore = await countCacheEntries();

    assert.deepEqual(await readNames(listGroups(marker).filter(groupSchema, { name: 'Al' })), ['Alpha']);

    await insertGroup(`${marker}b`, 'Altair');

    assert.deepEqual(await readNames(listGroups(marker).filter(groupSchema, { name: 'Al' })), ['Alpha', 'Altair']);
    assert.equal(await countCacheEntries(), entriesBefore);
  });

  test('a page is cached with its total', async () => {
    const marker = nextMarker('page');

    await Promise.all([insertGroup(`${marker}a`, 'A'), insertGroup(`${marker}b`, 'B')]);

    const first = await execute(listGroups(marker).paginate({ limit: 1 }));

    await insertGroup(`${marker}0`, 'Zero');

    const second = await execute(listGroups(marker).paginate({ limit: 1 }));

    assert.deepEqual([first.getPagination().total, second.getPagination().total], [2, 2]);
    assert.deepEqual(second.fetchAll(), first.fetchAll());
  });

  test('a heavy SELECT with .cache() is cut by the time limit, as is a SELECT that asks for it; inside withTransaction there is no limit', async (t) => {
    const limited = testDb.open({ db: { statementTimeout: STATEMENT_TIMEOUT } }, t);
    const runLimited = openWithDatabase(limited);
    const cached = await rejectionOf(runLimited(() => createQuery(HEAVY_SQL).cache({ tables: [TABLE.USERS] }).execute()));
    const asked = await rejectionOf(runLimited(() => createQuery(HEAVY_SQL, {}, { isTimeLimited: true }).execute()));

    [cached, asked].forEach((error) => {
      assert.equal(error.statusCode, HTTP_STATUS.SERVICE_UNAVAILABLE);
      assert.equal(error.code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
      assert.equal(error.cause.kind, DB_ERROR_KIND.TIMEOUT);
    });

    const waited = await runLimited(() => withTransaction(async () => {
      const query = createQuery(SLOW_SQL, {}, { isTimeLimited: true }).cache({ tables: [TABLE.USERS] });

      await query.execute();

      return query.fetchColumn();
    }));

    assert.equal(waited, 0);
    await assert.rejects(runLimited(() => createQuery(SLOW_SQL, {}, { isTimeLimited: true }).execute()), (error) => error.cause?.kind === DB_ERROR_KIND.TIMEOUT);
    assert.equal(limited.db.getStats().timeoutCount, 3);
  });

  test('over HTTP a heavy SELECT with .cache() answers 503 with Retry-After', async (t) => {
    const fastify = await testDb.buildApp({ db: { statementTimeout: STATEMENT_TIMEOUT } });

    t.after(() => fastify.close());
    fastify.get('/report', async () => {
      const query = createQuery(HEAVY_SQL).cache({ tables: [TABLE.USERS], ttl: '1m' });

      await query.execute();

      return query.fetch();
    });

    const response = await fastify.inject('/report');

    assert.equal(response.statusCode, HTTP_STATUS.SERVICE_UNAVAILABLE);
    assert.equal(response.headers['retry-after'], RETRY_AFTER);
    assert.equal(response.json().code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
  });
});
