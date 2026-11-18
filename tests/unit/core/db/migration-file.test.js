import { absPath } from '#config/path.js';
import {
  assertRunnable,
  findDatabaseName,
  formatMigrationId,
  listMigrations,
  makeMigrations,
  MIGRATION_DIRECTORY,
  MIGRATION_NAME_MAX_LENGTH,
  readMigrationFile,
  resolveMigrationDirectory,
  startsWithDefinition,
} from '#core/db/migration-file.js';
import { createMigrationDir, describeQualifiedName, writeMigrationFiles } from '#root/tests/helper/migration.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { describe, test } from 'node:test';

const BYTE_ORDER_MARK = String.fromCharCode(0xFEFF);
const SQL = 'CREATE TABLE users (\n  id INT PRIMARY KEY,\n  note VARCHAR(20) DEFAULT \'two\nlines\'\n);\n';

function listIn(directory, type) {
  return listMigrations({ directory, type });
}

async function readChecksum(directory, name) {
  return (await readMigrationFile(nodePath.join(directory, name))).checksum;
}

describe('MIGRATION_DIRECTORY', () => {
  test('is the folder of the MariaDB migrations in the project root, and the repository can be listed', async () => {
    assert.equal(MIGRATION_DIRECTORY, nodePath.join(absPath.root, 'migrations', 'mariadb'));
    assert.ok(Array.isArray(await listMigrations()));
    assert.ok(Array.isArray(await listMigrations({ type: 'seed' })));
  });
});

describe('formatMigrationId', () => {
  test('pads the version to four digits and leaves a longer one as it is', () => {
    assert.equal(formatMigrationId(1, 'users'), '0001_users');
    assert.equal(formatMigrationId(42, 'add_index'), '0042_add_index');
    assert.equal(formatMigrationId(20261118093000, 'sessions'), '20261118093000_sessions');
  });
});

describe('listMigrations', () => {
  test('pairs the up and down files of a version and orders the migrations by the number, not by the text', async (t) => {
    const directory = await createMigrationDir(t, {
      '10_groups.up.sql': '',
      '0002_sessions.up.sql': '',
      '0002_sessions.down.sql': '',
      '1_users.up.sql': '',
      '1_users.down.sql': '',
    });

    assert.deepEqual(await listIn(directory), [
      {
        type: 'migration',
        version: 1,
        name: 'users',
        id: '0001_users',
        upPath: nodePath.join(directory, '1_users.up.sql'),
        downPath: nodePath.join(directory, '1_users.down.sql'),
      },
      {
        type: 'migration',
        version: 2,
        name: 'sessions',
        id: '0002_sessions',
        upPath: nodePath.join(directory, '0002_sessions.up.sql'),
        downPath: nodePath.join(directory, '0002_sessions.down.sql'),
      },
      {
        type: 'migration',
        version: 10,
        name: 'groups',
        id: '0010_groups',
        upPath: nodePath.join(directory, '10_groups.up.sql'),
        downPath: null,
      },
    ]);
  });

  test('reads seeds from the seed folder, and migrations from beside it', async (t) => {
    const directory = await createMigrationDir(t, {
      '0001_users.up.sql': '',
      'seed/0001_groups.up.sql': '',
      'seed/0001_groups.down.sql': '',
    });
    const seeds = await listIn(directory, 'seed');

    assert.deepEqual((await listIn(directory)).map((migration) => migration.id), ['0001_users']);
    assert.deepEqual(seeds.map((seed) => pick(seed, ['type', 'id', 'upPath'])), [
      { type: 'seed', id: '0001_groups', upPath: nodePath.join(directory, 'seed', '0001_groups.up.sql') },
    ]);
  });

  test('passes over what is not an .sql file and gives an empty list for a folder that is not there', async (t) => {
    const directory = await createMigrationDir(t, {
      '.gitkeep': '',
      'README.md': '# notes',
      '0001_users.up.sql': '',
      'backup/0002_old.up.sql': '',
    });

    assert.deepEqual((await listIn(directory)).map((migration) => migration.id), ['0001_users']);
    assert.deepEqual(await listIn(directory, 'seed'), []);
    assert.deepEqual(await listIn(nodePath.join(directory, 'missing')), []);
  });

  test('accepts a name of digits and underscores, the longest name and the longest version', async (t) => {
    const longName = 'a'.repeat(MIGRATION_NAME_MAX_LENGTH);
    const directory = await createMigrationDir(t, {
      '0001_2fa.up.sql': '',
      '0002__x_.up.sql': '',
      [`0003_${longName}.up.sql`]: '',
      '999999999999999_last.up.sql': '',
    });

    assert.deepEqual(
      (await listIn(directory)).map((migration) => [migration.version, migration.name]),
      [[1, '2fa'], [2, '_x_'], [3, longName], [999999999999999, 'last']],
    );
  });

  test('refuses an .sql file whose name does not fit, instead of never running it', async (t) => {
    const names = [
      'users.up.sql',
      '0001_users.sql',
      '0001-users.up.sql',
      '0001_Users.up.sql',
      '0001_users.UP.sql',
      '0001_users.up.SQL',
      '0001_users.up.SQL.sql',
      '0001_.up.sql',
      '_users.up.sql',
      '0001_users.redo.sql',
      '0001_users name.up.sql',
      `0001_${'a'.repeat(MIGRATION_NAME_MAX_LENGTH + 1)}.up.sql`,
      '1000000000000000_users.up.sql',
    ];

    await Promise.all(names.map(async (name) => {
      const directory = await createMigrationDir(t, { '0001_groups.up.sql': '', [name]: '' });

      await assert.rejects(listIn(directory), new RegExp(`Migration file "${name}" must be named <version>_<name>\\.<up\\|down>\\.sql`), name);
    }));
  });

  test('refuses two migrations of one version, however the number is written', async (t) => {
    const sets = [
      ['0001_users.up.sql', '0001_groups.up.sql'],
      ['0001_users.up.sql', '1_users.up.sql'],
      ['0001_users.up.sql', '0001_users.down.sql', '01_users.down.sql'],
      ['0001_users.up.sql', '0001_groups.down.sql'],
    ];

    await Promise.all(sets.map(async (names) => {
      const directory = await createMigrationDir(t, Object.fromEntries(names.map((name) => [name, ''])));

      await assert.rejects(listIn(directory), /share the version 1: a version belongs to one migration/, names.join(', '));
    }));
  });

  test('refuses a down file that has no up file', async (t) => {
    const directory = await createMigrationDir(t, { '0001_users.up.sql': '', '0002_sessions.down.sql': '' });

    await assert.rejects(listIn(directory), /Migration file "0002_sessions\.down\.sql" has no up file beside it/);
  });

  test('refuses one name under two versions: --names would not tell them apart', async (t) => {
    const directory = await createMigrationDir(t, { '0001_add_index.up.sql': '', '0005_add_index.up.sql': '' });

    await assert.rejects(listIn(directory), /Migrations 0001_add_index and 0005_add_index have one name/);
  });

  test('lets a migration and a seed share a version and a name', async (t) => {
    const directory = await createMigrationDir(t, { '0001_groups.up.sql': '', 'seed/0001_groups.up.sql': '' });

    assert.equal((await listIn(directory)).length, 1);
    assert.equal((await listIn(directory, 'seed')).length, 1);
  });

  test('requires one of the two types', async () => {
    await Promise.all(['seeds', '', null, 1].map((type) => assert.rejects(
      listMigrations({ type }),
      /listMigrations\(\{ directory, type \}\) requires type to be one of: migration, seed/,
    )));
  });
});

describe('readMigrationFile', () => {
  test('gives the text of the file and its SHA-256 in hex', async (t) => {
    const directory = await createMigrationDir(t, { '0001_users.up.sql': SQL });
    const { sql, checksum } = await readMigrationFile(nodePath.join(directory, '0001_users.up.sql'));

    assert.equal(sql, SQL);
    assert.match(checksum, /^[0-9a-f]{64}$/);
  });

  test('gives one checksum and one text for LF, CRLF and CR line breaks and with a byte order mark', async (t) => {
    const directory = await createMigrationDir(t, {
      'lf.sql': SQL,
      'crlf.sql': SQL.replaceAll('\n', '\r\n'),
      'cr.sql': SQL.replaceAll('\n', '\r'),
      'bom.sql': `${BYTE_ORDER_MARK}${SQL.replaceAll('\n', '\r\n')}`,
    });
    const files = await Promise.all(['lf.sql', 'crlf.sql', 'cr.sql', 'bom.sql'].map((name) => readMigrationFile(nodePath.join(directory, name))));

    files.forEach((file) => assert.deepEqual(file, files[0]));
    assert.equal(files[0].sql, SQL);
  });

  test('gives another checksum once the text changes, by a space or by a letter in a comment', async (t) => {
    const directory = await createMigrationDir(t, {
      'base.sql': SQL,
      'space.sql': SQL.replace('id INT', 'id  INT'),
      'comment.sql': `-- users\n${SQL}`,
      'tail.sql': `${SQL}\n`,
    });
    const checksums = await Promise.all(['base.sql', 'space.sql', 'comment.sql', 'tail.sql'].map((name) => readChecksum(directory, name)));

    assert.equal(new Set(checksums).size, 4);
  });

  test('refuses a file that is not UTF-8 instead of reading replacement characters out of it', async (t) => {
    const directory = await createMigrationDir(t, {
      '0001_users.up.sql': Buffer.from("INSERT INTO users (name) VALUES ('Zo\xEB');\n", 'latin1'),
      '0002_groups.up.sql': "INSERT INTO groups (name) VALUES ('Зоя 😀');\n",
    });

    await assert.rejects(
      readMigrationFile(nodePath.join(directory, '0001_users.up.sql')),
      /Migration file "0001_users\.up\.sql" is not valid UTF-8/,
    );
    assert.equal((await readMigrationFile(nodePath.join(directory, '0002_groups.up.sql'))).sql, "INSERT INTO groups (name) VALUES ('Зоя 😀');\n");
  });

  test('rejects for a file that is not there', async (t) => {
    const directory = await createMigrationDir(t);

    await assert.rejects(readMigrationFile(nodePath.join(directory, '0001_users.up.sql')), { code: 'ENOENT' });
  });
});

describe('makeMigrations', () => {
  test('creates an empty pair of files under the first version in an empty folder, creating the folder', async (t) => {
    const root = await createMigrationDir(t);
    const directory = nodePath.join(root, 'mariadb');
    const paths = await makeMigrations({ names: ['users'], directory });

    assert.deepEqual(paths, [
      nodePath.join(directory, '0001_users.up.sql'),
      nodePath.join(directory, '0001_users.down.sql'),
    ]);
    assert.deepEqual((await readdir(directory)).toSorted(), ['0001_users.down.sql', '0001_users.up.sql']);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, 'utf8'))), ['', '']);
  });

  test('takes the versions after the highest one there is, one for each name in the order given', async (t) => {
    const directory = await createMigrationDir(t, { '0001_users.up.sql': '', '7_groups.up.sql': '' });
    const paths = await makeMigrations({ names: ['sessions', 'audit_logs'], directory });

    assert.deepEqual(paths.map((path) => nodePath.basename(path)), [
      '0008_sessions.up.sql',
      '0008_sessions.down.sql',
      '0009_audit_logs.up.sql',
      '0009_audit_logs.down.sql',
    ]);
    assert.deepEqual((await listIn(directory)).map((migration) => migration.id), ['0001_users', '0007_groups', '0008_sessions', '0009_audit_logs']);
  });

  test('numbers seeds on their own, in the seed folder', async (t) => {
    const directory = await createMigrationDir(t, { '0001_users.up.sql': '', '0002_sessions.up.sql': '' });
    const paths = await makeMigrations({ names: ['groups'], type: 'seed', directory });

    assert.deepEqual(paths, [
      nodePath.join(directory, 'seed', '0001_groups.up.sql'),
      nodePath.join(directory, 'seed', '0001_groups.down.sql'),
    ]);
    assert.equal((await listIn(directory, 'seed')).length, 1);
  });

  test('names the files and writes nothing on a dry run', async (t) => {
    const root = await createMigrationDir(t);
    const directory = nodePath.join(root, 'mariadb');
    const paths = await makeMigrations({ names: ['users'], directory, isDryRun: true });

    assert.deepEqual(paths.map((path) => nodePath.basename(path)), ['0001_users.up.sql', '0001_users.down.sql']);
    assert.equal(existsSync(directory), false);
  });

  test('refuses a name that would not make a file name, and writes nothing', async (t) => {
    const directory = await createMigrationDir(t);
    const unfit = ['', 'Users', 'add-index', 'add index', 'users.up', '../users', 'a'.repeat(MIGRATION_NAME_MAX_LENGTH + 1)];

    await Promise.all(unfit.map((name) => assert.rejects(
      makeMigrations({ names: ['groups', name], directory }),
      (error) => !(error instanceof TypeError)
        && error.message === `"${name}" is not a name of a migration: a name is 1 to 100 lowercase letters, digits and underscores, such as add_users`,
    )));
    await assert.rejects(makeMigrations({ names: ['add-index'], directory, type: 'seed' }), /^Error: "add-index" is not a name of a seed: /);
    assert.deepEqual(await readdir(directory), []);
  });

  test('requires a list of names: what is no list is a fault of the caller, not a name a person typed', async (t) => {
    const directory = await createMigrationDir(t);
    const lists = [undefined, null, 'users', [], ['users', 5]];

    await Promise.all(lists.map((names) => assert.rejects(
      makeMigrations({ names, directory }),
      /^TypeError: makeMigrations\(\{ names, type, directory, isDryRun \}\) requires a list of names$/,
    )));
    assert.deepEqual(await readdir(directory), []);
  });

  test('refuses a name that is taken in the folder of its type, and one given twice, each in its own words', async (t) => {
    const directory = await createMigrationDir(t, { '0001_users.up.sql': '', 'seed/0001_groups.up.sql': '' });

    await assert.rejects(
      makeMigrations({ names: ['users'], directory }),
      /^Error: A migration named "users" exists already: --names tells migrations apart by it$/,
    );
    await assert.rejects(
      makeMigrations({ names: ['groups'], directory, type: 'seed' }),
      /^Error: A seed named "groups" exists already: --names tells seeds apart by it$/,
    );
    await assert.rejects(
      makeMigrations({ names: ['sessions', 'sessions'], directory }),
      /^Error: The name "sessions" is given twice: --names tells migrations apart by it$/,
    );
    assert.deepEqual((await readdir(directory)).toSorted(), ['0001_users.up.sql', 'seed']);
  });

  test('requires one of the two types and a boolean for the dry run', async (t) => {
    const directory = await createMigrationDir(t);

    await assert.rejects(makeMigrations({ names: ['users'], directory, type: 'schema' }), /requires type to be one of: migration, seed/);
    await assert.rejects(makeMigrations({ names: ['users'], directory, isDryRun: 'yes' }), /requires isDryRun to be a boolean/);
    await assert.rejects(makeMigrations(), /requires a list of names/);
  });

  test('gives a seed the name of a migration: the two are numbered and named apart', async (t) => {
    const directory = await createMigrationDir(t, { '0001_groups.up.sql': '' });

    await writeMigrationFiles(directory, { 'seed/0003_users.up.sql': '' });

    const paths = await makeMigrations({ names: ['groups'], type: 'seed', directory });

    assert.equal(nodePath.basename(paths[0]), '0004_groups.up.sql');
  });
});

describe('findDatabaseName', () => {
  test('finds nothing in a script that works in the database it is run in', () => {
    const scripts = [
      'CREATE TABLE users (id INT PRIMARY KEY);\nINSERT INTO users (id) VALUES (1);\n',
      'SELECT u.id, u.name FROM users u FORCE INDEX (users_name) USE INDEX (users_id) WHERE u.id = 1;',
      "INSERT INTO notes (body) VALUES ('USE app; DROP DATABASE app; app.users');",
      '-- USE app;\n/* app.users */\nCREATE TABLE app_users (id INT);\n# DROP DATABASE app\n',
      'CREATE TABLE apps (app INT, application INT);\nSELECT apps.app FROM apps;',
      'CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW BEGIN SET NEW.touched = 1; SET NEW.used = 2; END;',
      'CREATE TABLE `database` (`schema` INT, use_count INT);\nALTER TABLE `database` ADD COLUMN created INT;',
      'SHOW CREATE DATABASE app;\nSHOW CREATE SCHEMA app;',
      'SELECT 5 . 5, 5app, x5app.id FROM numbers;',
      'ALTER TABLE forms ADD schema JSON NULL;\nALTER TABLE forms DROP schema, DROP database;',
      "ALTER ONLINE IGNORE TABLE forms ADD note INT, ALTER schema SET DEFAULT 'public', ALTER database DROP DEFAULT;",
      'CREATE PROCEDURE trim_forms() BEGIN ALTER TABLE forms DROP schema; END;',
      'SELECT app /* .users */ FROM apps app -- .users\n;',
      '',
    ];

    scripts.forEach((sql) => assert.equal(findDatabaseName(sql, 'app'), null, sql));
  });

  test('finds a USE statement, wherever in the script and however it is spelled', () => {
    ['USE app;', 'use other;\nCREATE TABLE t (id INT);', 'CREATE TABLE t (id INT);\n  Use `app` ;', 'SELECT 1; -- note\n/* more */ USE app'].forEach((sql) => {
      assert.equal(findDatabaseName(sql, 'app'), 'a USE statement', sql);
    });
  });

  test('finds a statement that creates, drops or alters a database', () => {
    const scripts = [
      'DROP DATABASE app;',
      'CREATE DATABASE IF NOT EXISTS other CHARACTER SET utf8mb4;',
      'create or replace database app;',
      'CREATE TABLE t (id INT);\nALTER SCHEMA app COLLATE utf8mb4_bin;',
      'DROP SCHEMA IF EXISTS app',
      'BEGIN NOT ATOMIC IF 1 = 1 THEN DROP DATABASE other; END IF; END;',
      'CREATE PROCEDURE reset() BEGIN DROP DATABASE other; END;',
      'BEGIN NOT ATOMIC ALTER TABLE forms ADD note INT; DROP DATABASE other; END;',
      'ALTER TABLE forms DROP schema;\nALTER SCHEMA app COLLATE utf8mb4_bin;',
      'CREATE EVENT sweep ON SCHEDULE EVERY 1 DAY DO DROP DATABASE other;',
    ];

    scripts.forEach((sql) => assert.equal(findDatabaseName(sql, 'app'), 'a statement that creates, drops or alters a database', sql));
  });

  test('finds the name of the database in front of a table, in every spelling, and says what else reads the same', () => {
    const cases = {
      'UPDATE app.users SET id = 1;': 'app.users',
      'UPDATE APP.Users SET id = 1;': 'APP.Users',
      'DROP TABLE IF EXISTS `app`.`legacy`;': '`app`',
      'SELECT * FROM `App` . `users`;': '`App`',
      'SELECT * FROM app.`users`;': 'app',
      'SELECT * FROM app . users;': 'app',
      'INSERT INTO app.users (id) SELECT id FROM other.users;': 'app.users',
      'SELECT app.id FROM users app;': 'app.id',
      'UPDATE app /* the live one */ .counters SET total = 1;': 'app',
      'UPDATE app/**/.counters SET total = 1;': 'app',
      'UPDATE `app` -- the live one\n.counters SET total = 1;': '`app`',
      'UPDATE app # the live one\n /* still */ . counters SET total = 1;': 'app',
    };

    Object.entries(cases).forEach(([sql, found]) => {
      assert.equal(findDatabaseName(sql, 'app'), describeQualifiedName(found), sql);
    });
    assert.equal(findDatabaseName('SELECT * FROM `my-app`.users;', 'my-app'), describeQualifiedName('`my-app`'));
    assert.equal(findDatabaseName('SELECT * FROM other.users;', 'app'), null);
  });

  test('finds a database whose name begins with a digit, which the lexer passes over as it does a number', () => {
    const scripts = [
      'UPDATE 5app.accounts SET balance = balance + 10;',
      'UPDATE 5APP . accounts SET balance = 0;',
      'SELECT * FROM 5app.`accounts`;',
      'INSERT INTO totals (sum) SELECT SUM(balance) FROM\n5app.accounts;',
      'SELECT * FROM 5app /* the live one */ . accounts;',
    ];

    scripts.forEach((sql) => assert.equal(findDatabaseName(sql, '5app'), describeQualifiedName('5app'), sql));
    assert.equal(findDatabaseName('SELECT * FROM `5app`.accounts;', '5app'), describeQualifiedName('`5app`'));
    assert.equal(findDatabaseName("SELECT '5app.accounts', 15app.id, 5apps.id FROM x5app -- 5app.accounts\n;", '5app'), null);
    assert.equal(findDatabaseName('SELECT * FROM 2026_shop.items;', '2026_shop'), describeQualifiedName('2026_shop'));
  });

  test('takes no number for a database whose name is digits alone: such a name is always quoted', () => {
    assert.equal(findDatabaseName('SELECT 2026.5, 2026 . 5 FROM shops;', '2026'), null);
    assert.equal(findDatabaseName('SELECT * FROM `2026`.shops;', '2026'), describeQualifiedName('`2026`'));
  });

  test('throws on a text it cannot read, and requires a script and a name', () => {
    assert.throws(() => findDatabaseName('/*!40101 SET NAMES utf8 */;', 'app'), /unsupported executable comment/);
    assert.throws(() => findDatabaseName("SELECT 'unclosed", 'app'), SyntaxError);
    assert.throws(() => findDatabaseName(null, 'app'), /findDatabaseName\(sql, database\) requires/);
    assert.throws(() => findDatabaseName('SELECT 1', undefined), /findDatabaseName\(sql, database\) requires/);
  });
});

describe('startsWithDefinition', () => {
  test('is true for a script whose first statement creates, alters, drops, renames or truncates, whatever comes before and after', () => {
    const scripts = [
      'CREATE TABLE users (id INT);',
      'create table if not exists users (id INT);\nINSERT INTO users VALUES (1);',
      '-- Widens the name\n/* by a lot */\nALTER TABLE users MODIFY name VARCHAR(200);',
      'DROP TABLE sessions, tokens;',
      'RENAME TABLE users TO people;',
      'TRUNCATE users;',
      'CREATE PROCEDURE widen() BEGIN ALTER TABLE users ADD note INT; END;',
    ];

    scripts.forEach((sql) => assert.equal(startsWithDefinition(sql), true, sql));
  });

  test('is false for a block, a call, a prepared statement, a plain write and CREATE OR REPLACE: any of them may have done a part of its work', () => {
    const scripts = [
      'BEGIN NOT ATOMIC\n  CREATE TABLE names (id INT);\n  ALTER TABLE users ADD name INT;\nEND;',
      'CREATE OR REPLACE TABLE users AS SELECT id FROM people;',
      'create or replace view names AS SELECT name FROM users;',
      'CALL widen();',
      "EXECUTE IMMEDIATE 'ALTER TABLE users ADD name INT';",
      'INSERT INTO users VALUES (1);',
      'SET FOREIGN_KEY_CHECKS = 0;\nDROP TABLE users;',
      "SELECT 'CREATE';",
      '`CREATE` TABLE users (id INT);',
      '-- CREATE TABLE users (id INT);',
      '',
    ];

    scripts.forEach((sql) => assert.equal(startsWithDefinition(sql), false, sql));
  });

  test('throws on a text it cannot read, and requires a script', () => {
    assert.throws(() => startsWithDefinition("CREATE TABLE users (note VARCHAR(9) DEFAULT 'unclosed);"), SyntaxError);
    assert.throws(() => startsWithDefinition(null), /startsWithDefinition\(sql\) requires the text of a script/);
  });
});

describe('resolveMigrationDirectory', () => {
  test('is the directory itself for migrations and its "seed" directory for seeds', () => {
    const directory = nodePath.join('app', 'migrations');

    assert.equal(resolveMigrationDirectory(directory, 'migration'), directory);
    assert.equal(resolveMigrationDirectory(directory, 'seed'), nodePath.join(directory, 'seed'));
  });
});

describe('assertRunnable', () => {
  const path = nodePath.join('migrations', '0002_sessions.up.sql');

  test('lets a file with statements through, and one that is only a comment', () => {
    assert.doesNotThrow(() => assertRunnable({ path, sql: 'CREATE TABLE sessions (id INT);\n', database: 'app' }));
    assert.doesNotThrow(() => assertRunnable({ path, sql: '-- Nothing to undo\n', database: 'app' }));
  });

  test('refuses an empty file: one that was made and never written', () => {
    ['', ' \n\t\n'].forEach((sql) => {
      assert.throws(
        () => assertRunnable({ path, sql, database: 'app' }),
        /^Error: 0002_sessions\.up\.sql is empty: write its statements, or a comment if there is nothing to do$/,
      );
    });
  });

  test('refuses a file that names a database, and one it cannot read, with what it has found', () => {
    assert.throws(
      () => assertRunnable({ path, sql: 'USE app;\nCREATE TABLE sessions (id INT);', database: 'app' }),
      /^Error: 0002_sessions\.up\.sql holds a USE statement: a migration file works in the database it is applied to and never names one$/,
    );
    assert.throws(
      () => assertRunnable({ path, sql: 'UPDATE app.users SET id = 1', database: 'app' }),
      /^Error: 0002_sessions\.up\.sql holds the name of the database in front of a table \(app\.users; a table or an alias of that name reads the same and needs another alias\): a migration file works in the database it is applied to and never names one$/,
    );
  });

  test('refuses a file it cannot read in words of its own: nothing in them sends a person to look for a database', () => {
    assert.throws(
      () => assertRunnable({ path, sql: '/*!50100 CREATE TABLE sessions (id INT) */', database: 'app' }),
      /^Error: 0002_sessions\.up\.sql cannot be read as SQL, and what cannot be read is not sent: SQL has an unsupported executable comment at position 0: /,
    );
    assert.throws(
      () => assertRunnable({ path, sql: "INSERT INTO notes (body) VALUES ('unclosed);", database: 'app' }),
      (error) => error.cause instanceof SyntaxError && /^0002_sessions\.up\.sql cannot be read as SQL, .*: SQL has an unclosed ' at position 33/.test(error.message),
    );
  });
});
