import {
  insertReturning,
  now,
  updateReturning,
  upsert,
} from '#core/db/index.js';
import { withTransaction } from '#core/db/transaction.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import {
  before,
  beforeEach,
  describe,
  test,
} from 'node:test';

const CLOCK_TOLERANCE_MS = 5000;

const testDb = await createTestDb();
const { db, run } = testDb;

async function readMembers() {
  const { rows } = await run(() => db.query('SELECT id, email, first_name, is_active, visits FROM members ORDER BY email'));

  return rows;
}

describe('db helpers', { skip: testDb.skip }, () => {
  before(() => run(() => db.query(`
    CREATE TABLE members (
      id UUID PRIMARY KEY DEFAULT UUID_v7(),
      email VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
      first_name VARCHAR(100) COLLATE utf8mb4_uca1400_ai_ci NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      visits INT NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_members_email (email)
    ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin
  `)));

  beforeEach(() => run(() => db.query('DELETE FROM members')));

  describe('insertReturning', () => {
    test('writes a row from camelCase fields and returns it in camelCase, defaults of the table included', async () => {
      const id = uuidv7();
      const member = await run(() => insertReturning('members', { id, email: 'anna@example.com', firstName: 'Anna' }));

      assert.deepEqual(Object.keys(member), ['id', 'email', 'firstName', 'isActive', 'visits', 'createdAt']);
      assert.equal(member.id, id);
      assert.equal(member.firstName, 'Anna');
      assert.equal(member.isActive, true);
      assert.equal(member.visits, 0);
      assert.ok(Math.abs(member.createdAt.getTime() - Date.now()) < CLOCK_TOLERANCE_MS);
    });

    test('returns only the fields that are asked for', async () => {
      const member = await run(() => insertReturning('members', { email: 'anna@example.com' }, { returning: ['id', 'isActive'] }));

      assert.deepEqual(Object.keys(member), ['id', 'isActive']);
      assert.match(member.id, /^[0-9a-f-]{36}$/);
    });

    test('rejects a duplicate with the kind "unique" and the name of the index', async () => {
      await run(() => insertReturning('members', { email: 'anna@example.com' }));

      await assert.rejects(
        run(() => insertReturning('members', { email: 'anna@example.com' })),
        (error) => error.kind === DB_ERROR_KIND.UNIQUE && error.constraint === 'uq_members_email',
      );
    });
  });

  describe('upsert', () => {
    test('writes a new row, and on a duplicate overwrites only the fields named in "update"', async () => {
      const anna = { email: 'anna@example.com', firstName: 'Anna', visits: 1 };
      const firstId = uuidv7();

      const renamed = { ...anna, firstName: 'Hanna', visits: 50 };

      await run(() => upsert('members', { ...anna, id: firstId }, { update: ['firstName'] }));
      await run(() => upsert('members', { ...renamed, id: uuidv7() }, { update: ['firstName'] }));
      await run(() => upsert('members', { ...anna, id: uuidv7(), visits: 7 }, { update: ['firstName', 'visits'] }));
      await run(() => upsert('members', { email: 'borys@example.com', firstName: 'Borys' }, { update: ['firstName'] }));

      const members = await readMembers();

      assert.deepEqual(members.map((member) => [member.email, member.first_name, member.visits]), [
        ['anna@example.com', 'Anna', 7],
        ['borys@example.com', 'Borys', 0],
      ]);
      assert.equal(members[0].id, firstId);
    });

    test('resolves with the result of the statement', async () => {
      const result = await run(() => upsert('members', { email: 'anna@example.com', visits: 1 }, { update: ['visits'] }));

      assert.deepEqual(result, { rows: [], affectedRows: 1, fields: [] });
    });

    test('requires the fields to overwrite: there is no default', async () => {
      const row = { email: 'anna@example.com' };

      await assert.rejects(run(() => upsert('members', row)), /requires at least one field name/);
      await assert.rejects(run(() => upsert('members', row, { update: [] })), TypeError);
      await assert.rejects(run(() => upsert('members', row, { update: ['visits'] })), /requires every field of "update" to be a field of the row/);
      assert.deepEqual(await readMembers(), []);
    });
  });

  describe('updateReturning', () => {
    test('changes the rows it finds and returns them as they are now, in camelCase', async () => {
      const anna = await run(() => insertReturning('members', { email: 'anna@example.com', firstName: 'Anna' }));

      await run(() => insertReturning('members', { email: 'borys@example.com', firstName: 'Borys' }));

      const updated = await run(() => updateReturning('members', { firstName: 'Hanna', visits: 3 }, { where: { id: anna.id } }));

      assert.equal(updated.length, 1);
      assert.deepEqual({ ...updated[0], createdAt: null }, {
        ...anna,
        firstName: 'Hanna',
        visits: 3,
        createdAt: null,
      });
      assert.deepEqual((await readMembers()).map((row) => row.first_name), ['Hanna', 'Borys']);
    });

    test('returns a row it has found also when nothing in it changed, and nothing when it found none', async () => {
      const anna = await run(() => insertReturning('members', { email: 'anna@example.com', firstName: 'Anna' }));

      const unchanged = await run(() => updateReturning('members', { firstName: 'Anna' }, { where: { id: anna.id }, returning: ['id', 'firstName'] }));
      const missing = await run(() => updateReturning('members', { firstName: 'Nobody' }, { where: { id: uuidv7() } }));

      assert.deepEqual(unchanged, [{ id: anna.id, firstName: 'Anna' }]);
      assert.deepEqual(missing, []);
    });

    test('can set a field to NULL and finds rows by several fields', async () => {
      await run(() => insertReturning('members', { email: 'anna@example.com', firstName: 'Anna', visits: 5 }));

      const updated = await run(() => updateReturning(
        'members',
        { firstName: null },
        { where: { email: 'anna@example.com', visits: 5 }, returning: ['firstName'] },
      ));

      assert.deepEqual(updated, [{ firstName: null }]);
    });

    test('runs its two statements in a transaction of its own, or inside the one it is called in', async () => {
      const sink = createLogSink();
      const single = testDb.open({ db: { connectionLimit: 1 }, logger: { level: 'info', stream: sink.stream } });
      const anna = await run(() => insertReturning('members', { email: 'anna@example.com' }));

      // Every START TRANSACTION of the session, as the server counts them.
      async function countBegins() {
        const { rows } = await single.db.query("SELECT variable_value AS count FROM information_schema.session_status WHERE variable_name = 'COM_BEGIN'");

        return Number(rows[0].count);
      }

      async function countBeginsAround(fn) {
        const startCount = await countBegins();

        await fn();

        return (await countBegins()) - startCount;
      }

      const outside = await single.run(() => countBeginsAround(() => updateReturning('members', { visits: 1 }, { where: { id: anna.id } })));
      let inside = null;

      await assert.rejects(single.run(() => withTransaction(async () => {
        inside = await countBeginsAround(() => updateReturning('members', { visits: 99 }, { where: { id: anna.id } }));

        throw new Error('boom');
      })), /boom/);

      assert.equal(outside, 1);
      assert.equal(inside, 0);
      assert.deepEqual(sink.lines.map((line) => line.sql).filter((sql) => sql.includes('`members`')), [
        'UPDATE `members` SET `visits` = :set_visits WHERE `id` = :where_id',
        'SELECT * FROM `members` WHERE `id` = :where_id',
        'UPDATE `members` SET `visits` = :set_visits WHERE `id` = :where_id',
        'SELECT * FROM `members` WHERE `id` = :where_id',
      ]);
      assert.equal((await readMembers())[0].visits, 1);
    });

    test('finds a field of the condition in the patch by its column, not by its spelling', async () => {
      const anna = await run(() => insertReturning('members', { email: 'anna@example.com', firstName: 'Anna' }));

      await assert.rejects(
        run(() => updateReturning('members', { firstName: 'Hanna' }, { where: { first_name: 'Anna' } })),
        /cannot change a field it finds the rows by/,
      );
      await assert.rejects(
        run(() => updateReturning('members', { first_name: 'Hanna' }, { where: { firstName: 'Anna' } })),
        /cannot change a field it finds the rows by/,
      );
      assert.deepEqual((await readMembers()).map((row) => row.first_name), ['Anna']);

      const updated = await run(() => updateReturning('members', { first_name: 'Hanna' }, { where: { id: anna.id }, returning: ['first_name'] }));

      assert.deepEqual(updated, [{ firstName: 'Hanna' }]);
    });

    test('refuses a condition it cannot find the rows by again', async () => {
      const calls = [
        () => updateReturning('members', { visits: 1 }),
        () => updateReturning('members', { visits: 1 }, { where: {} }),
        () => updateReturning('members', {}, { where: { id: uuidv7() } }),
        () => updateReturning('members', { visits: 1 }, { where: { firstName: null } }),
        () => updateReturning('members', { visits: 1 }, { where: { id: [uuidv7()] } }),
        () => updateReturning('members', { visits: 1 }, { where: { visits: 0 } }),
      ];
      const results = await Promise.allSettled(calls.map((call) => run(call)));

      results.forEach((result) => {
        assert.equal(result.status, 'rejected');
        assert.ok(result.reason instanceof TypeError);
      });
      assert.match(results[5].reason.message, /cannot change a field it finds the rows by/);
    });
  });

  describe('names', () => {
    test('refuses a name of a table or a field that is not plain letters, digits and underscores', async () => {
      const row = { email: 'anna@example.com' };
      const calls = [
        () => insertReturning('members; DROP TABLE members', row),
        () => insertReturning('members`', row),
        () => insertReturning('', row),
        () => insertReturning('members', { 'email`, `id': 'x' }),
        () => insertReturning('members', { 'email) VALUES (1) -- ': 'x' }),
        () => insertReturning('members', row, { returning: ['id, email'] }),
        () => insertReturning('members', row, { returning: 'id' }),
        () => upsert('members', { 'visits = 1 --': 1 }, { update: ['visits = 1 --'] }),
        () => updateReturning('members', { 'visits = 99 --': 1 }, { where: { id: uuidv7() } }),
        () => updateReturning('members', { visits: 1 }, { where: { '1 = 1 OR id': uuidv7() } }),
        () => insertReturning('m'.repeat(65), row),
      ];
      const results = await Promise.allSettled(calls.map((call) => run(call)));

      assert.deepEqual(results.map((result) => result.status), calls.map(() => 'rejected'));
      results.forEach((result) => assert.ok(result.reason instanceof TypeError, result.reason.message));
      assert.deepEqual(await readMembers(), []);
    });

    test('requires a row with at least one field', async () => {
      await assert.rejects(run(() => insertReturning('members', {})), /requires a plain object with at least one field/);
      await assert.rejects(run(() => insertReturning('members', null)), TypeError);
      await assert.rejects(run(() => insertReturning('members', [['email', 'x']])), TypeError);
      await assert.rejects(run(() => upsert('members', undefined, { update: ['visits'] })), /requires a plain object with at least one field/);
      await assert.rejects(run(() => upsert('members', {}, { update: ['visits'] })), /requires a plain object with at least one field/);
    });

    test('refuses one column named twice, in whatever spelling, before anything is sent', async () => {
      const anna = await run(() => insertReturning('members', { email: 'anna@example.com', firstName: 'Anna' }));
      const calls = [
        () => updateReturning('members', { firstName: 'Hanna', first_name: 'Ganna' }, { where: { id: anna.id } }),
        () => updateReturning('members', { visits: 1 }, { where: { id: anna.id }, returning: ['id', 'id'] }),
        () => insertReturning('members', { email: 'borys@example.com', firstName: 'Borys', first_name: 'Boris' }),
        () => insertReturning('members', { email: 'borys@example.com' }, { returning: ['firstName', 'first_name'] }),
        () => upsert('members', { email: 'anna@example.com', isActive: false, is_active: true }, { update: ['isActive'] }),
        () => upsert('members', { email: 'anna@example.com', isActive: false }, { update: ['isActive', 'isActive'] }),
      ];
      const results = await Promise.allSettled(calls.map((call) => run(call)));

      results.forEach((result) => {
        assert.equal(result.status, 'rejected');
        assert.match(result.reason.message, /names one column twice/);
      });
      assert.deepEqual((await readMembers()).map((row) => [row.email, row.first_name, row.is_active, row.visits]), [
        ['anna@example.com', 'Anna', true, 0],
      ]);
    });
  });

  describe('now', () => {
    test('reads the clock of the database as a Date', async () => {
      const at = await run(() => now());

      assert.ok(at instanceof Date);
      assert.ok(Math.abs(at.getTime() - Date.now()) < CLOCK_TOLERANCE_MS);
    });
  });
});
