import { findDisallowedCollations, readStructure } from '#core/db/structure.js';
import { COLLATION } from '#enums/collation.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { USER_STATUS } from '#enums/user-status.js';
import { createTestDb } from '#root/tests/helper/db.js';
import {
  bindMigrator,
  listTableNames,
  REPOSITORY_MIGRATIONS,
  REPOSITORY_SEEDS,
} from '#root/tests/helper/migration.js';
import { parseStrictUtc } from '#utils/date.js';
import { uuidv7, uuidVersion } from '#utils/id.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const { MACHINE, HUMAN } = COLLATION;
const { SEED } = MIGRATION_TYPE;

const TABLES = Object.freeze(['users', 'user_identities', 'groups', 'group_scopes', 'user_groups', 'audit_logs']);

// Every text column of these tables: a name and a description are a text for a person, everything else
// a machine string or a contact.
const TEXT_COLLATIONS = Object.freeze({
  'users.email': MACHINE,
  'users.first_name': HUMAN,
  'users.last_name': HUMAN,
  'users.locale': MACHINE,
  'users.timezone': MACHINE,
  'users.status': MACHINE,
  'user_identities.provider': MACHINE,
  'user_identities.provider_user_id': MACHINE,
  'user_identities.email': MACHINE,
  'user_identities.profile': MACHINE,
  'groups.slug': MACHINE,
  'groups.name': HUMAN,
  'groups.description': HUMAN,
  'group_scopes.scope': MACHINE,
  'audit_logs.action': MACHINE,
  'audit_logs.entity_type': MACHINE,
  'audit_logs.meta': MACHINE,
  'audit_logs.ip': MACHINE,
});

const ADMIN_GROUP = Object.freeze({
  slug: 'admin',
  name: 'Administrators',
  description: 'Full access to everything',
  is_superadmin: true,
  is_system: true,
});

// The table of the migrator keeps applied_at of its own.
const MIGRATOR_TABLE = '_migrations';
const MOMENT_CELLS = Object.freeze({ type: 'datetime(3)', nullable: 'NO', default: 'current_timestamp(3)' });
const TIMESTAMPS = Object.freeze({
  created_at: { ...MOMENT_CELLS, extra: '' },
  updated_at: { ...MOMENT_CELLS, extra: 'on update current_timestamp(3)' },
});

const LONG_AGO = '2000-01-01 00:00:00.000';
const LONG_AGO_UTC = '2000-01-01T00:00:00.000Z';

const UNIQUE_EMAIL = Object.freeze({ kind: 'unique', constraint: 'uq_users_email' });
const FAILED_CHECK = Object.freeze({ name: 'DbError', code: 'ER_CONSTRAINT_FAILED' });

const testDb = await createTestDb();
const { up, down, verify } = bindMigrator(testDb);

async function createUser(email = null) {
  const id = uuidv7();

  await testDb.readRows('INSERT INTO users (id, email) VALUES (:id, :email)', { id, email });

  return id;
}

async function createGroup(slug) {
  const id = uuidv7();

  await testDb.readRows('INSERT INTO groups (id, slug, name) VALUES (:id, :slug, :slug)', { id, slug });

  return id;
}

function readGroups() {
  return testDb.readRows('SELECT slug, name, description, is_superadmin, is_system FROM groups ORDER BY slug');
}

async function readEmails(email) {
  const rows = await testDb.readRows('SELECT email FROM users WHERE email = :email', { email });

  return rows.map((row) => row.email);
}

function readOwnStructure() {
  return testDb.run(() => readStructure(testDb.name));
}

function readTextCollations({ tables }) {
  return Object.fromEntries(TABLES.flatMap((table) => Object.entries(tables[table].columns)
    .filter(([, cells]) => cells.collation !== null)
    .map(([column, cells]) => [`${table}.${column}`, cells.collation])));
}

describe('the migrations of the repository', { skip: testDb.skip }, () => {
  beforeEach(async () => {
    await testDb.reset();
    // A test database defaults to the machine collation: a table that names none would take it and pass the guard.
    await testDb.alterDatabase(`COLLATE ${HUMAN}`);
    await up();
  });

  test('build the tables of users and groups, and "verify" finds the database as they make it: every check and foreign key named, every collation allowed', async () => {
    assert.deepEqual(await listTableNames(testDb), ['_migrations', ...TABLES].toSorted());
    assert.deepEqual(await verify(), {
      database: testDb.name,
      tableCount: TABLES.length,
      differences: [],
      notes: [],
    });
  });

  test('pass the guard of collations: every text column has one of the two, every table defaults to the one of a machine string, a UUID column has none and a JSON column is text in that one', async () => {
    const structure = await readOwnStructure();
    const identities = structure.tables.user_identities;

    assert.deepEqual(findDisallowedCollations(structure), []);
    assert.deepEqual(pick(structure.tables.users.columns.id, ['type', 'collation']), { type: 'uuid', collation: null });
    assert.deepEqual(pick(identities.columns.profile, ['type', 'collation']), { type: 'longtext', collation: MACHINE });
    assert.deepEqual(identities.checks.profile, { level: 'Column', clause: 'json_valid(`profile`)' });
  });

  test('give every table created_at and updated_at, the second moved by the server on every change of the row', async () => {
    const { tables } = await readOwnStructure();

    Object.keys(tables).filter((table) => table !== MIGRATOR_TABLE).forEach((table) => {
      Object.entries(TIMESTAMPS).forEach(([column, cells]) => {
        const found = tables[table].columns[column];

        assert.deepEqual(found && pick(found, Object.keys(cells)), cells, `${table}.${column}`);
      });
    });
  });

  test('give a name and a description the collation of a text for a person, and every other text column the one of a machine string', async () => {
    assert.deepEqual(readTextCollations(await readOwnStructure()), TEXT_COLLATIONS);
  });

  test('keep josé@example.com and jose@example.com apart: both are written and each finds itself alone, the same one twice is refused, two users without an email are not', async () => {
    await createUser('jose@example.com');
    await createUser('josé@example.com');
    await createUser();
    await createUser();

    assert.deepEqual(await readEmails('jose@example.com'), ['jose@example.com']);
    assert.deepEqual(await readEmails('josé@example.com'), ['josé@example.com']);
    await assert.rejects(createUser('josé@example.com'), UNIQUE_EMAIL);
    assert.deepEqual(await testDb.readRows('SELECT COUNT(*) AS total FROM users WHERE email IS NULL'), [{ total: 2 }]);
  });

  test('find a person by a name in any case and without its accents, and a group by its slug only as it is spelled', async () => {
    const id = await createUser();

    await testDb.readRows('UPDATE users SET first_name = :firstName, last_name = :lastName WHERE id = :id', { id, firstName: 'José', lastName: 'Їжак' });
    await createGroup('editors');

    assert.deepEqual(
      await testDb.readRows('SELECT first_name, last_name FROM users WHERE first_name = :firstName AND last_name = :lastName', { firstName: 'JOSE', lastName: 'іжак' }),
      [{ first_name: 'José', last_name: 'Їжак' }],
    );
    assert.deepEqual(await testDb.readRows('SELECT slug FROM groups WHERE slug = :slug', { slug: 'Editors' }), []);
  });

  test('take a status only as active or blocked, spelled so: ACTIVE and an unknown one are refused by the check, and a new user is active', async () => {
    const id = await createUser();

    function setStatus(status) {
      return testDb.readRows('UPDATE users SET status = :status WHERE id = :id', { id, status });
    }

    assert.deepEqual(await testDb.readRows('SELECT status FROM users'), [{ status: USER_STATUS.ACTIVE }]);

    await setStatus(USER_STATUS.BLOCKED);

    await assert.rejects(setStatus('ACTIVE'), FAILED_CHECK);
    await assert.rejects(setStatus('active '), FAILED_CHECK);
    await assert.rejects(setStatus('deleted'), FAILED_CHECK);
    await assert.rejects(testDb.readRows("INSERT INTO users (id, status) VALUES (:id, 'ACTIVE')", { id: uuidv7() }), FAILED_CHECK);
    assert.deepEqual(await testDb.readRows('SELECT status FROM users'), [{ status: USER_STATUS.BLOCKED }]);
  });

  test('let an account of a provider belong to one user: a user may have several, and the provider with the id there is unique', async () => {
    const [first, second] = await Promise.all([createUser(), createUser()]);

    function link(userId, provider) {
      return testDb.readRows("INSERT INTO user_identities (user_id, provider, provider_user_id) VALUES (:userId, :provider, '1001')", { userId, provider });
    }

    await link(first, 'google');
    await link(first, 'telegram');

    await assert.rejects(link(second, 'google'), { kind: 'unique', constraint: 'uq_user_identities_provider_user' });
    assert.deepEqual(await testDb.readRows('SELECT COUNT(*) AS total FROM user_identities WHERE user_id = :first', { first }), [{ total: 2 }]);
  });

  test('delete a user for real with their identities and memberships, and leave a membership they have granted with no one as its granter: the cascade does not move its updated_at', async () => {
    const [admin, member] = await Promise.all([createUser(), createUser()]);
    const group = await createGroup('editors');

    await testDb.readRows("INSERT INTO user_identities (user_id, provider, provider_user_id) VALUES (:admin, 'google', 'sub-1')", { admin });
    await testDb.readRows('INSERT INTO user_groups (user_id, group_id, granted_by) VALUES (:admin, :group, NULL), (:member, :group, :admin)', { admin, member, group });
    await testDb.readRows('UPDATE user_groups SET updated_at = :moment', { moment: LONG_AGO });
    await testDb.readRows('DELETE FROM users WHERE id = :admin', { admin });

    assert.deepEqual(await testDb.readRows('SELECT COUNT(*) AS total FROM user_identities'), [{ total: 0 }]);
    assert.deepEqual(await testDb.readRows('SELECT user_id, group_id, granted_by, updated_at FROM user_groups'), [{
      user_id: member, group_id: group, granted_by: null, updated_at: parseStrictUtc(LONG_AGO_UTC),
    }]);
  });

  test('keep the audit of a deleted user, with no one as its actor: the cascade does not move its updated_at', async () => {
    const actor = await createUser();

    await testDb.readRows("INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (:actor, 'user.block', 'users', :actor)", { actor });
    await testDb.readRows('UPDATE audit_logs SET updated_at = :moment', { moment: LONG_AGO });
    await testDb.readRows('DELETE FROM users WHERE id = :actor', { actor });

    assert.deepEqual(await testDb.readRows('SELECT actor_id, action, entity_id, updated_at FROM audit_logs'), [{
      actor_id: null, action: 'user.block', entity_id: actor, updated_at: parseStrictUtc(LONG_AGO_UTC),
    }]);
  });

  test('delete a group with its scopes and memberships, and leave its members', async () => {
    const user = await createUser();
    const group = await createGroup('editors');

    await testDb.readRows("INSERT INTO group_scopes (group_id, scope) VALUES (:group, 'users:read'), (:group, 'users:write')", { group });
    await testDb.readRows('INSERT INTO user_groups (user_id, group_id) VALUES (:user, :group)', { user, group });
    await testDb.readRows('DELETE FROM groups WHERE id = :group', { group });

    assert.deepEqual(
      await testDb.readRows('SELECT (SELECT COUNT(*) FROM group_scopes) AS scopes, (SELECT COUNT(*) FROM user_groups) AS memberships, (SELECT COUNT(*) FROM users) AS users'),
      [{ scopes: 0, memberships: 0, users: 1 }],
    );
  });

  test('give a row written without an id a UUIDv7 and the moment of its writing, and move updated_at when the row changes', async () => {
    await testDb.readRows("INSERT INTO groups (slug, name) VALUES ('editors', 'Editors')");

    const [created] = await testDb.readRows('SELECT id, created_at, updated_at FROM groups');

    await testDb.readRows('UPDATE groups SET updated_at = :moment', { moment: LONG_AGO });
    await testDb.readRows("UPDATE groups SET name = 'Editors of the site'");

    const [changed] = await testDb.readRows('SELECT updated_at FROM groups');

    assert.equal(uuidVersion(created.id), 7);
    assert.ok(created.created_at instanceof Date);
    assert.deepEqual(created.updated_at, created.created_at);
    assert.ok(changed.updated_at >= created.created_at, 'updated_at is the moment of the change');
  });
});

describe('the seed of the repository', { skip: testDb.skip }, () => {
  beforeEach(async () => {
    await testDb.reset();
    await up();
  });

  test('makes the system group admin with full access, and neither a user nor a scope', async () => {
    assert.deepEqual(await up({ type: SEED }), { files: REPOSITORY_SEEDS.map((id) => `${id}.up.sql`), isDryRun: false, ahead: [] });
    assert.deepEqual(await readGroups(), [ADMIN_GROUP]);
    assert.deepEqual(
      await testDb.readRows('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM group_scopes) AS scopes'),
      [{ users: 0, scopes: 0 }],
    );
  });

  test('may run again over its own group: one group stays, its full access comes back, and its name and description stay as they were changed', async () => {
    await up({ type: SEED });
    await testDb.readRows("UPDATE groups SET name = 'Адміністратори', description = NULL, is_superadmin = FALSE, is_system = FALSE WHERE slug = 'admin'");
    await testDb.readRows("DELETE FROM _migrations WHERE type = 'seed'");
    await up({ type: SEED });

    assert.deepEqual(await readGroups(), [{ ...ADMIN_GROUP, name: 'Адміністратори', description: null }]);
  });

  test('is rolled back with its group, after which the migrations roll back to an empty database', async () => {
    await up({ type: SEED });

    assert.deepEqual(await down({ type: SEED }), { files: REPOSITORY_SEEDS.map((id) => `${id}.down.sql`), isDryRun: false });
    assert.deepEqual(await readGroups(), []);
    assert.deepEqual((await down()).files, REPOSITORY_MIGRATIONS.toReversed().map((id) => `${id}.down.sql`));
    assert.deepEqual(await listTableNames(testDb), ['_migrations']);
  });
});
