import {
  compareStructures,
  findDisallowedCollations,
  findServerNamedConstraints,
  readDatabaseDefaults,
  readStructure,
} from '#core/db/structure.js';
import { createDownDb } from '#root/tests/helper/db.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const TABLE_CELLS = Object.freeze({
  type: 'BASE TABLE',
  engine: 'InnoDB',
  rowFormat: 'Dynamic',
  defaultCollation: 'utf8mb4_bin',
  options: '',
  comment: 'Users',
});

const COLUMN_CELLS = Object.freeze({
  type: 'varchar(255)',
  nullable: 'NO',
  default: null,
  extra: '',
  collation: 'utf8mb4_bin',
  generationExpression: null,
  comment: '',
});

const INDEX_CELLS = Object.freeze({
  columns: 'email',
  unique: 'NO',
  type: 'BTREE',
  ignored: 'NO',
  comment: '',
});

const FOREIGN_KEY_CELLS = Object.freeze({
  columns: 'group_id',
  references: 'groups.id',
  onUpdate: 'RESTRICT',
  onDelete: 'CASCADE',
});

function column(cells = {}) {
  return { ...COLUMN_CELLS, ...cells };
}

function table({
  cells = {},
  columns = { id: column({ type: 'uuid', collation: null }), email: column() },
  indexes = {},
  checks = {},
  foreignKeys = {},
} = {}) {
  return {
    cells: { ...TABLE_CELLS, ...cells },
    columnOrder: Object.keys(columns),
    columns,
    indexes,
    checks,
    foreignKeys,
  };
}

function structure(tables) {
  return { database: 'app', tables };
}

function compareTables(live, reference) {
  return compareStructures(structure({ users: live }), structure({ users: reference }));
}

describe('compareStructures', () => {
  test('finds nothing between two structures that are the same', () => {
    const users = table({
      indexes: { users_email_unique: { ...INDEX_CELLS, unique: 'YES' } },
      checks: { status: { level: 'Column', clause: "`status` in ('active','blocked')" } },
      foreignKeys: { users_group_fk: FOREIGN_KEY_CELLS },
    });

    assert.deepEqual(compareStructures(structure({ users }), structure({ users: structuredClone(users) })), []);
    assert.deepEqual(compareStructures(structure({}), structure({})), []);
  });

  test('tells a table that only one side has, in the order of the names', () => {
    assert.deepEqual(
      compareStructures(structure({ users: table(), legacy: table() }), structure({ users: table(), sessions: table() })),
      [
        'table legacy: exists in the live database, the migrations do not create it',
        'table sessions: missing in the live database, the migrations create it',
      ],
    );
  });

  test('tells every cell of a table and of a column that differs, with both values and in plain words', () => {
    const live = table({
      cells: {
        comment: 'People', engine: 'Aria', rowFormat: 'Page', defaultCollation: 'utf8mb4_uca1400_ai_ci',
      },
      columns: {
        id: column({ type: 'uuid', collation: null }),
        email: column({
          type: 'varchar(100)', nullable: 'YES', default: 'NULL', generationExpression: 'lcase(`name`)',
        }),
      },
    });

    assert.deepEqual(compareTables(live, table()), [
      'table users: engine is "Aria" in the live database, "InnoDB" by the migrations',
      'table users: row format is "Page" in the live database, "Dynamic" by the migrations',
      'table users: default collation is "utf8mb4_uca1400_ai_ci" in the live database, "utf8mb4_bin" by the migrations',
      'table users: comment is "People" in the live database, "Users" by the migrations',
      'column users.email: type is "varchar(100)" in the live database, "varchar(255)" by the migrations',
      'column users.email: nullable is "YES" in the live database, "NO" by the migrations',
      'column users.email: default is "NULL" in the live database, null by the migrations',
      'column users.email: generation expression is "lcase(`name`)" in the live database, null by the migrations',
    ]);
  });

  test('keeps apart no default, DEFAULT NULL and a default of the text NULL', () => {
    const defaults = [null, 'NULL', "'NULL'"];
    const differences = defaults.flatMap((live) => defaults.map((reference) => compareTables(
      table({ columns: { note: column({ default: live }) } }),
      table({ columns: { note: column({ default: reference }) } }),
    ).length));

    assert.deepEqual(differences, [0, 1, 1, 1, 0, 1, 1, 1, 0]);
  });

  test('tells a column, an index, a check and a foreign key that only one side has', () => {
    const live = table({
      columns: { id: column(), email: column(), note: column() },
      indexes: { users_email: INDEX_CELLS },
      checks: { CONSTRAINT_1: { level: 'Table', clause: '`id` > 0' } },
    });
    const reference = table({
      columns: { id: column(), email: column(), avatar_key: column() },
      foreignKeys: { users_group_fk: FOREIGN_KEY_CELLS },
    });

    assert.deepEqual(compareTables(live, reference), [
      'column users.avatar_key: missing in the live database, the migrations create it',
      'column users.note: exists in the live database, the migrations do not create it',
      'index users.users_email: exists in the live database, the migrations do not create it',
      'check users.CONSTRAINT_1: exists in the live database, the migrations do not create it',
      'foreign key users.users_group_fk: missing in the live database, the migrations create it',
    ]);
  });

  test('tells what differs inside an index, a check and a foreign key', () => {
    const live = table({
      indexes: { users_email: { ...INDEX_CELLS, columns: 'email(10) DESC', unique: 'YES' } },
      checks: { status: { level: 'Column', clause: "`status` in ('active')" } },
      foreignKeys: { users_group_fk: { ...FOREIGN_KEY_CELLS, references: 'other.groups.id' } },
    });
    const reference = table({
      indexes: { users_email: INDEX_CELLS },
      checks: { status: { level: 'Column', clause: "`status` in ('active','blocked')" } },
      foreignKeys: { users_group_fk: { ...FOREIGN_KEY_CELLS, onDelete: 'SET NULL' } },
    });

    assert.deepEqual(compareTables(live, reference), [
      'index users.users_email: columns is "email(10) DESC" in the live database, "email" by the migrations',
      'index users.users_email: unique is "YES" in the live database, "NO" by the migrations',
      'check users.status: clause is "`status` in (\'active\')" in the live database, "`status` in (\'active\',\'blocked\')" by the migrations',
      'foreign key users.users_group_fk: references is "other.groups.id" in the live database, "groups.id" by the migrations',
      'foreign key users.users_group_fk: on delete is "CASCADE" in the live database, "SET NULL" by the migrations',
    ]);
  });

  test('tells a changed order of the columns once, and not for a column that only one side has', () => {
    const moved = table({ columns: { id: column(), name: column(), email: column() } });
    const original = table({ columns: { id: column(), email: column(), name: column() } });
    const extended = table({
      columns: {
        id: column(), note: column(), email: column(), name: column(),
      },
    });

    assert.deepEqual(compareTables(moved, original), [
      'table users: the columns stand as id, name, email in the live database, as id, email, name by the migrations',
    ]);
    assert.deepEqual(compareTables(extended, original), [
      'column users.note: exists in the live database, the migrations do not create it',
    ]);
  });

  test('compares a view by its kind alone, and tells a table that became one, or the reverse, in one line', () => {
    const view = { ...table({ columns: { id: column() } }), cells: { type: 'VIEW' } };
    const base = table({ columns: { id: column(), email: column() }, indexes: { PRIMARY: { ...INDEX_CELLS, columns: 'id' } } });

    assert.deepEqual(compareTables(view, structuredClone(view)), []);
    assert.deepEqual(compareTables(view, base), [
      'table users: type is "VIEW" in the live database, "BASE TABLE" by the migrations',
    ]);
    assert.deepEqual(compareTables(base, view), [
      'table users: type is "BASE TABLE" in the live database, "VIEW" by the migrations',
    ]);
  });
});

describe('findServerNamedConstraints', () => {
  test('finds nothing where every table check and foreign key has a name of its own, and in a check named after its column', () => {
    const users = table({
      checks: { users_status_check: { level: 'Table', clause: "`status` in ('active')" }, status: { level: 'Column', clause: '`status` <> 1' } },
      foreignKeys: { users_group_fk: FOREIGN_KEY_CELLS, fk_2: FOREIGN_KEY_CELLS },
    });

    assert.deepEqual(findServerNamedConstraints(structure({ users })), []);
    assert.deepEqual(findServerNamedConstraints(structure({})), []);
  });

  test('names every table check and foreign key the server has numbered, table by table', () => {
    const users = table({
      checks: { CONSTRAINT_2: { level: 'Table', clause: '`b` > 0' }, CONSTRAINT_1: { level: 'Table', clause: '`a` > 0' }, CONSTRAINT_x: { level: 'Table', clause: '`c` > 0' } },
      foreignKeys: { 1: FOREIGN_KEY_CELLS },
    });
    const groups = table({ foreignKeys: { 12: FOREIGN_KEY_CELLS, groups_owner_fk: FOREIGN_KEY_CELLS } });

    assert.deepEqual(findServerNamedConstraints(structure({ users, groups })), [
      'foreign key groups.12: the server has named it, give it a name in the migration (CONSTRAINT <name> ...)',
      'check users.CONSTRAINT_1: the server has named it, give it a name in the migration (CONSTRAINT <name> ...)',
      'check users.CONSTRAINT_2: the server has named it, give it a name in the migration (CONSTRAINT <name> ...)',
      'foreign key users.1: the server has named it, give it a name in the migration (CONSTRAINT <name> ...)',
    ]);
  });
});

describe('findDisallowedCollations', () => {
  test('finds nothing where every table defaults to the machine collation and every text column has one of the two', () => {
    const users = table({
      columns: {
        id: column({ type: 'uuid', collation: null }),
        email: column({ collation: 'utf8mb4_bin' }),
        name: column({ collation: 'utf8mb4_uca1400_ai_ci' }),
        age: column({ type: 'int(11)', collation: null }),
      },
    });

    assert.deepEqual(findDisallowedCollations(structure({ users })), []);
    assert.deepEqual(findDisallowedCollations(structure({})), []);
  });

  test('tells every column with another collation, in the order of the tables', () => {
    const users = table({ columns: { email: column({ collation: 'ascii_bin' }), name: column({ collation: 'utf8mb4_general_ci' }) } });
    const groups = table({ columns: { slug: column({ collation: 'latin1_swedish_ci' }) } });

    assert.deepEqual(findDisallowedCollations(structure({ users, groups })), [
      'column groups.slug: the collation latin1_swedish_ci is not allowed, only utf8mb4_bin and utf8mb4_uca1400_ai_ci are',
      'column users.email: the collation ascii_bin is not allowed, only utf8mb4_bin and utf8mb4_uca1400_ai_ci are',
      'column users.name: the collation utf8mb4_general_ci is not allowed, only utf8mb4_bin and utf8mb4_uca1400_ai_ci are',
    ]);
  });

  test('tells a table that does not default to the machine collation: a column that names none would take the looser one', () => {
    const users = table({ cells: { defaultCollation: 'utf8mb4_uca1400_ai_ci' }, columns: { email: column({ collation: 'utf8mb4_uca1400_ai_ci' }) } });
    const legacy = table({ cells: { defaultCollation: 'latin1_swedish_ci' }, columns: {} });

    assert.deepEqual(findDisallowedCollations(structure({ users, legacy })), [
      'table legacy: the default collation is latin1_swedish_ci, it must be utf8mb4_bin',
      'table users: the default collation is utf8mb4_uca1400_ai_ci, it must be utf8mb4_bin',
    ]);
  });

  test('passes over a view and a sequence: no migration has chosen the collations of their columns', () => {
    const view = { ...table({ columns: { name: column({ collation: 'utf8mb4_general_ci' }) } }), cells: { type: 'VIEW' } };
    const sequence = table({ cells: { type: 'SEQUENCE', defaultCollation: null }, columns: {} });
    const versioned = table({ cells: { type: 'SYSTEM VERSIONED' }, columns: { name: column({ collation: 'latin1_bin' }) } });

    assert.deepEqual(findDisallowedCollations(structure({ view, sequence, versioned })), [
      'column versioned.name: the collation latin1_bin is not allowed, only utf8mb4_bin and utf8mb4_uca1400_ai_ci are',
    ]);
  });
});

describe('readStructure and readDatabaseDefaults', () => {
  test('require the name of a database and a function to read with, before anything is asked', async (t) => {
    const down = await createDownDb(t);

    await Promise.all([undefined, null, '', 5].map((name) => assert.rejects(
      down.run(() => readStructure(name)),
      /readStructure\(database, \{ query, except \}\) requires the name of a database/,
    )));
    await assert.rejects(down.run(() => readStructure('app', { query: 'db.query' })), /requires the name of a database, and a function when "query" is given/);
    await assert.rejects(down.run(() => readStructure('app', { except: 'users' })), /requires "except" to be a list of table names/);
    await assert.rejects(down.run(() => readDatabaseDefaults('')), /readDatabaseDefaults\(database, \{ query \}\) requires the name of a database/);
    await assert.rejects(readStructure('app'), /No active context/);
    assert.equal(down.db.getStats().activeCount, 0);
  });

  test('read with the function they are given, and refuse a database that function does not find', async (t) => {
    const down = await createDownDb(t);
    const asked = [];

    async function query(sql, binding) {
      asked.push(binding);

      return { rows: [] };
    }

    await assert.rejects(down.run(() => readStructure('app', { query })), /Database "app" does not exist/);
    await assert.rejects(down.run(() => readDatabaseDefaults('app', { query })), /Database "app" does not exist/);
    assert.deepEqual(asked, [{ database: 'app' }, { database: 'app' }]);
  });
});
