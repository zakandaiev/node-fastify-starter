import { createQuery } from '#core/db/query.js';
import { withTransaction } from '#core/db/transaction.js';
import { createSchema } from '#core/schema/create-schema.js';
import { FILTER_TYPE } from '#enums/filter-type.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { USER_STATUS } from '#enums/user-status.js';
import { readRequestId } from '#root/tests/helper/app.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import * as paginationSchema from '#schemas/common/pagination.js';
import * as groupSchema from '#schemas/entity/group.js';
import * as userSchema from '#schemas/entity/user.js';
import { toDate } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const testDb = await createTestDb();
const { up } = bindMigrator(testDb);
const { run } = testDb;

const PUBLIC = Object.freeze({ auth: false });
const QUERY_VALUES_MESSAGE = 'Database query with its values';
const BAD_FIELD_CODE = 'ER_BAD_FIELD_ERROR';

const LIST_SQL = 'SELECT id, first_name, status, created_at FROM users';
const GROUPED_SQL = 'SELECT status, COUNT(*) AS user_count FROM users GROUP BY status ORDER BY user_count DESC';
const INSERT_USER_SQL = 'INSERT INTO users (id, first_name, last_name, status, created_at) VALUES (:id, :firstName, :lastName, :status, :createdAt)';
const INSERT_GROUP_SQL = 'INSERT INTO groups (slug, name) VALUES (:slug, :name)';

// The last name of Oksana ends with a backslash: in SQL its literal is 'Back\\', the first backslash escaping the second.
const BACKSLASH = '\\';
const BACKSLASH_NAME = `Back${BACKSLASH}`;
const BACKSLASH_LITERAL = `'Back${BACKSLASH}${BACKSLASH}'`;

const USERS = Object.freeze([
  {
    firstName: 'Anna',
    lastName: 'Kovalenko',
    status: USER_STATUS.ACTIVE,
    createdAt: '2026-11-01T10:00:00.000Z',
  },
  {
    firstName: 'Andrii',
    lastName: 'Melnyk',
    status: USER_STATUS.BLOCKED,
    createdAt: '2026-11-05T10:00:00.000Z',
  },
  {
    firstName: 'Ivan',
    lastName: 'Shevchenko',
    status: USER_STATUS.ACTIVE,
    createdAt: '2026-11-10T10:00:00.000Z',
  },
  {
    firstName: 'Olha',
    lastName: 'Bondar',
    status: USER_STATUS.ACTIVE,
    createdAt: '2026-11-12T10:00:00.000Z',
  },
  {
    firstName: 'Oksana',
    lastName: BACKSLASH_NAME,
    status: USER_STATUS.ACTIVE,
    createdAt: '2026-11-15T10:00:00.000Z',
  },
  {
    firstName: 'Bohdan',
    lastName: 'Lysenko',
    status: USER_STATUS.ACTIVE,
    createdAt: '2026-11-20T10:00:00.000Z',
  },
]);
const GROUPS = Object.freeze([{ slug: 'editors', name: 'Editors' }, { slug: 'managers', name: 'Managers' }]);

// A filter of the last name, which the entity schema does not offer: a text filter that takes a backslash.
const LAST_NAME_SCHEMA = Object.freeze({
  properties: { lastName: userSchema.properties.lastName },
  filters: { lastName: { type: FILTER_TYPE.TEXT } },
});

// Ivan, Oksana and Bohdan: active, "an" in the first name, created from November 5 on.
const THREE_FILTERS = Object.freeze({ firstName: 'an', status: USER_STATUS.ACTIVE, createdAtFrom: '2026-11-05T00:00:00.000Z' });

const LIST_SCHEMA = createSchema(userSchema, paginationSchema)
  .query(['limit', 'offset', 'sort', 'firstName', 'status', 'createdAt'])
  .response(HTTP_STATUS.OK, { data: ['id', 'firstName', 'status', 'createdAt'], format: 'array' })
  .defaultResponses()
  .build();

async function execute(query, pool = testDb) {
  await pool.run(() => query.execute());

  return query;
}

async function readFirstNames(query) {
  return (await execute(query)).fetchAll().map((row) => row.firstName);
}

function insertUser(user) {
  return testDb.readRows(INSERT_USER_SQL, { ...user, id: uuidv7(), createdAt: toDate(user.createdAt) });
}

describe('createQuery on MariaDB', { skip: testDb.skip }, () => {
  before(async () => {
    await up();
    await Promise.all(USERS.map((user) => insertUser(user)));
    await Promise.all(GROUPS.map((group) => testDb.readRows(INSERT_GROUP_SQL, group)));
  });

  test('pagination, sort and three filters work together: the page, its total, filters[] and sort[]', async () => {
    function listPage(offset) {
      return execute(createQuery(LIST_SQL)
        .filter(userSchema, THREE_FILTERS)
        .sort(userSchema, { sort: 'name' })
        .paginate({ limit: 2, offset }));
    }

    const [first, second] = await Promise.all([listPage(0), listPage(2)]);

    assert.deepEqual(first.fetchAll().map((row) => row.firstName), ['Bohdan', 'Ivan']);
    assert.deepEqual(second.fetchAll().map((row) => row.firstName), ['Oksana']);
    assert.deepEqual(first.getPagination(), {
      total: 3,
      limit: 2,
      offset: 0,
      totalPages: 2,
      currentPage: 1,
      canLoadMore: true,
    });
    assert.deepEqual([second.getPagination().currentPage, second.getPagination().canLoadMore], [2, false]);
    assert.deepEqual(first.getFilters().map((filter) => [filter.name, filter.value]), [
      ['firstName', 'an'],
      ['status', [USER_STATUS.ACTIVE]],
      ['createdAt', [THREE_FILTERS.createdAtFrom, null]],
    ]);
    assert.deepEqual(first.getSort().map((entry) => [entry.value, entry.isChecked]), [['newest', false], ['name', true]]);
    assert.ok(first.fetch().createdAt instanceof Date);
  });

  test('a filter on a statement with WHERE a OR b applies to both branches', async () => {
    const sql = "SELECT first_name FROM users WHERE first_name = 'Andrii' OR status = 'active'";
    const [all, filtered] = await Promise.all([
      readFirstNames(createQuery(sql)),
      readFirstNames(createQuery(sql).filter(userSchema, { status: USER_STATUS.ACTIVE })),
    ]);

    assert.equal(all.length, USERS.length);
    assert.deepEqual(filtered.toSorted(), ['Anna', 'Bohdan', 'Ivan', 'Oksana', 'Olha']);
  });

  test('the total of a page is right on GROUP BY, DISTINCT, UNION and a CTE, also with a filter on the columns of the result', async () => {
    const cases = [
      { sql: 'SELECT status, COUNT(*) AS user_count FROM users GROUP BY status', total: 2 },
      {
        sql: 'SELECT status, COUNT(*) AS user_count FROM users GROUP BY status',
        filter: [userSchema, { status: USER_STATUS.ACTIVE }],
        total: 1,
      },
      { sql: 'SELECT DISTINCT status FROM users', total: 2 },
      { sql: 'SELECT DISTINCT status FROM users', filter: [userSchema, { status: USER_STATUS.BLOCKED }], total: 1 },
      { sql: 'SELECT first_name AS name FROM users UNION ALL SELECT name FROM groups', total: USERS.length + GROUPS.length },
      { sql: 'SELECT first_name AS name FROM users UNION ALL SELECT name FROM groups', filter: [groupSchema, { name: 'an' }], total: 6 },
      { sql: "WITH active AS (SELECT id, first_name FROM users WHERE status = 'active') SELECT id, first_name FROM active", total: 5 },
      {
        sql: "WITH active AS (SELECT id, first_name FROM users WHERE status = 'active') SELECT id, first_name FROM active",
        filter: [userSchema, { firstName: 'an' }],
        total: 4,
      },
    ];

    await Promise.all(cases.map(async ({ sql, filter, total }) => {
      const page = createQuery(sql);
      const all = createQuery(sql);

      if (filter) {
        page.filter(...filter);
        all.filter(...filter);
      }

      await Promise.all([execute(page.paginate({ limit: 1 })), execute(all)]);

      assert.equal(page.getPagination().total, total, sql);
      assert.equal(all.fetchAll().length, total, sql);
      assert.equal(page.fetchAll().length, 1, sql);
    }));
  });

  test('filter() puts a grouping into a derived table also without a value in effect: the rows, their order and the total are those of a value that keeps every row', async () => {
    const byCount = {
      sort: [{
        value: 'count',
        label: 'Count',
        orderBy: 'user_count DESC, status ASC',
        isDefault: true,
      }],
    };
    const queries = [{}, { status: `${USER_STATUS.ACTIVE},${USER_STATUS.BLOCKED}` }].flatMap((payload) => [
      createQuery(GROUPED_SQL).filter(userSchema, payload).paginate({}),
      createQuery(GROUPED_SQL).filter(userSchema, payload).sort(byCount, {}).paginate({}),
    ]);
    const pages = await Promise.all(queries.map((query) => execute(query)));

    pages.forEach((page) => {
      assert.deepEqual(page.fetchAll(), [{ status: USER_STATUS.ACTIVE, userCount: 5 }, { status: USER_STATUS.BLOCKED, userCount: 1 }]);
      assert.equal(page.getPagination().total, 2);
    });
  });

  test('a string literal that ends with a backslash does not break the filter, nor does a filter value that ends with one', async () => {
    const sql = `SELECT first_name FROM users WHERE last_name <> ${BACKSLASH_LITERAL}`;
    const [all, filtered, byLastName] = await Promise.all([
      readFirstNames(createQuery(sql)),
      readFirstNames(createQuery(sql).filter(userSchema, { status: USER_STATUS.ACTIVE }).sort(userSchema, { sort: 'name' }).paginate({})),
      readFirstNames(createQuery('SELECT first_name FROM users').filter(LAST_NAME_SCHEMA, { lastName: `k${BACKSLASH}` })),
    ]);

    assert.equal(all.length, USERS.length - 1);
    assert.equal(all.includes('Oksana'), false);
    assert.deepEqual(filtered, ['Anna', 'Bohdan', 'Ivan', 'Olha']);
    assert.deepEqual(byLastName, ['Oksana']);
  });

  test('paginate() and filter() on a query with FOR UPDATE or LOCK IN SHARE MODE are an error before anything runs; sort() is not', async () => {
    const locking = ['SELECT id FROM users FOR UPDATE', 'SELECT id FROM users LOCK IN SHARE MODE'];

    locking.forEach((sql) => {
      assert.throws(() => createQuery(sql).paginate({}), /\.paginate\(\) cannot take a locking read/, sql);
      assert.throws(() => createQuery(sql).filter(userSchema, { status: USER_STATUS.ACTIVE }), /\.filter\(\) cannot take a locking read/, sql);
    });

    const rows = await run(() => withTransaction(async () => {
      const query = createQuery('SELECT first_name FROM users WHERE status = :status FOR UPDATE', { status: USER_STATUS.BLOCKED })
        .sort(userSchema, { sort: 'name' });

      await query.execute();

      return query.fetchAll();
    }));

    assert.deepEqual(rows, [{ firstName: 'Andrii' }]);
  });

  test('inside withTransaction a page whose statement fails waits for its count: the caller catches the error and the transaction commits', async (t) => {
    const group = { slug: 'kept-after-failed-page', name: 'Kept' };
    const byMembers = { sort: [{ value: 'members', label: 'Members', orderBy: 'member_count DESC' }] };

    t.after(() => testDb.readRows('DELETE FROM groups WHERE slug = :slug', group));

    const code = await run(() => withTransaction(async () => {
      await createQuery(INSERT_GROUP_SQL, group).execute();

      const error = await rejectionOf(createQuery('SELECT slug FROM groups').sort(byMembers, { sort: 'members' }).paginate({}).execute());

      return error.code;
    }));

    assert.equal(code, BAD_FIELD_CODE);
    assert.deepEqual(await testDb.readRows('SELECT name FROM groups WHERE slug = :slug', group), [{ name: group.name }]);
  });

  test('a total in the payload of the client is ignored: the server counts the rows', async () => {
    const query = await execute(createQuery(LIST_SQL).paginate({ limit: 2, offset: 0, total: 999 }));

    assert.equal(query.getPagination().total, USERS.length);
    assert.equal(query.fetchAll().length, 2);
  });

  test('request.query goes straight in: the filters, the sort and the page of a route act, an empty value is no filter, and a total is dropped', async (t) => {
    const fastify = await testDb.buildApp();

    t.after(() => fastify.close());
    fastify.get('/api/v1/query-probe/users', { schema: LIST_SCHEMA, security: PUBLIC }, async (request, reply) => {
      const query = createQuery(LIST_SQL).filter(userSchema, request.query).sort(userSchema, request.query).paginate(request.query);

      await query.execute();

      return reply.list(query.getAll());
    });

    const response = await fastify.inject({
      url: '/api/v1/query-probe/users',
      query: {
        ...THREE_FILTERS,
        sort: 'name',
        limit: '2',
        total: '999',
      },
    });
    const empty = await fastify.inject({ url: '/api/v1/query-probe/users', query: { firstName: '', status: '', createdAtTo: '' } });
    const body = response.json();

    assert.equal(response.statusCode, HTTP_STATUS.OK, response.body);
    assert.deepEqual(body.data.map((row) => [row.firstName, row.status]), [['Bohdan', USER_STATUS.ACTIVE], ['Ivan', USER_STATUS.ACTIVE]]);
    assert.equal(body.data[0].createdAt, '2026-11-20T10:00:00.000Z');
    assert.deepEqual(body.pagination, {
      total: 3,
      limit: 2,
      offset: 0,
      totalPages: 2,
      currentPage: 1,
      canLoadMore: true,
    });
    assert.deepEqual(body.filters.map((filter) => [filter.name, filter.value]), [
      ['firstName', 'an'],
      ['status', [USER_STATUS.ACTIVE]],
      ['createdAt', [THREE_FILTERS.createdAtFrom, null]],
    ]);
    assert.equal(body.filters[2].operator, 'range');
    assert.deepEqual(body.meta, { requestId: readRequestId(response) });

    assert.equal(empty.statusCode, HTTP_STATUS.OK, empty.body);
    assert.equal(empty.json().data.length, USERS.length);
    assert.ok(empty.json().filters.every((filter) => filter.value === null));
    assert.equal(empty.json().sort.find((entry) => entry.isChecked).value, 'newest');
  });

  test('the value of a disabled filter or option never reaches SQL, and filters[] returns it with isDisabled: true', async (t) => {
    const sink = createLogSink();
    const pool = testDb.open({ logger: { level: 'debug', stream: sink.stream } }, t);
    const statuses = [{ value: USER_STATUS.ACTIVE, label: 'Active' }, { value: USER_STATUS.BLOCKED, label: 'Blocked', isDisabled: true }];
    const disabledInSchema = {
      ...userSchema,
      filters: { ...userSchema.filters, status: { ...userSchema.filters.status, isDisabled: true } },
    };
    const [runtime, schema] = await Promise.all([
      execute(createQuery(LIST_SQL).filter(userSchema, { firstName: 'Andrii', status: USER_STATUS.BLOCKED }, { options: { status: statuses }, disabled: ['firstName'] }), pool),
      execute(createQuery(LIST_SQL).filter(disabledInSchema, { status: USER_STATUS.ACTIVE }), pool),
    ]);
    const [firstName, status] = runtime.getFilters();

    assert.deepEqual(findLogLines(sink, QUERY_VALUES_MESSAGE).map((line) => line.sql), [LIST_SQL, LIST_SQL]);
    assert.deepEqual([runtime.fetchAll().length, schema.fetchAll().length], [USERS.length, USERS.length]);
    assert.deepEqual(firstName, {
      type: FILTER_TYPE.TEXT,
      name: 'firstName',
      label: 'First name',
      isDisabled: true,
      value: null,
    });
    assert.deepEqual([status.isDisabled, status.value], [false, null]);
    assert.deepEqual(status.options[1], {
      label: 'Blocked',
      value: USER_STATUS.BLOCKED,
      isChecked: false,
      isDisabled: true,
    });
    assert.deepEqual(schema.getFilters()[1].isDisabled, true);
    assert.deepEqual(schema.getFilters()[1].value, null);
  });

  test('fetch() and fetchAll() give the right thing in any order, and changing what they give changes nothing kept', async () => {
    const sql = 'SELECT first_name, created_at FROM users ORDER BY first_name';
    const [allFirst, oneFirst] = await Promise.all([execute(createQuery(sql)), execute(createQuery(sql))]);
    const all = allFirst.fetchAll();
    const one = oneFirst.fetch();

    assert.deepEqual(allFirst.fetch(), all[0]);
    assert.deepEqual(oneFirst.fetchAll()[0], one);
    assert.deepEqual(all.map((row) => row.firstName), USERS.map((user) => user.firstName).toSorted());

    all[0].firstName = 'changed';
    all.reverse();
    one.createdAt = null;

    assert.equal(allFirst.fetch().firstName, 'Andrii');
    assert.equal(allFirst.fetchAll()[0].firstName, 'Andrii');
    assert.ok(oneFirst.fetch().createdAt instanceof Date);
    assert.deepEqual(oneFirst.fetchColumn(1), oneFirst.fetch().createdAt);
  });
});
