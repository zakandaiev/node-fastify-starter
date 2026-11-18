import { findDbError } from '#core/db/error.js';
import { readDatabaseDefaults, readStructure } from '#core/db/structure.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import {
  ACCOUNT_HOST,
  createTestDb,
  killSession,
  toLikePattern,
} from '#root/tests/helper/db.js';
import {
  bindMigrator,
  createMigrationDir,
  createMigrationEvents,
  describeQualifiedName,
  listReferenceNames,
  listTableNames,
  MIGRATION_TEXT,
  removeMigrationFiles,
  writeMigrationFiles,
} from '#root/tests/helper/migration.js';
import { isUuid } from '#utils/id.js';
import { mapValues } from '#utils/object.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

// A run that asks a pool of one connection for a second one never ends: the limit turns it into a failure.
const HANG_TIMEOUT_MS = 10000;

// The longest prefix a pool takes: a UUID follows it in the name of a database, and a name holds 64 characters.
const REFERENCE_PREFIX_MAX_LENGTH = 28;

const TEAMS = Object.freeze({
  '0001_teams.up.sql': `
    CREATE TABLE teams (
      id INT NOT NULL,
      slug VARCHAR(50) NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY teams_slug_unique (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Teams';
  `,
  '0001_teams.down.sql': 'DROP TABLE teams;\n',
});
const MEMBERS = Object.freeze({
  '0002_members.up.sql': `
    CREATE TABLE members (
      id INT NOT NULL AUTO_INCREMENT,
      team_id INT NOT NULL,
      email VARCHAR(100) NOT NULL,
      name VARCHAR(100) COLLATE utf8mb4_uca1400_ai_ci NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      profile JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY members_email_unique (email),
      KEY members_name (name(10)),
      CONSTRAINT members_team_fk FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
      CONSTRAINT members_status_check CHECK (status IN ('active', 'blocked'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Members';
  `,
  '0002_members.down.sql': 'DROP TABLE members;\n',
});
const INVITES = Object.freeze({
  '0003_invites.up.sql': `
    CREATE TABLE invites (
      id INT NOT NULL,
      team_id INT NOT NULL,
      email VARCHAR(100) NOT NULL,
      PRIMARY KEY (id),
      KEY invites_team (team_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Invites';
  `,
  '0003_invites.down.sql': 'DROP TABLE invites;\n',
});
const SCHEMA = Object.freeze({ ...TEAMS, ...MEMBERS, ...INVITES });
const SCHEMA_FILES = Object.freeze(['0001_teams.up.sql', '0002_members.up.sql', '0003_invites.up.sql']);
const [FIRST_FILE] = SCHEMA_FILES;
const SCHEMA_EVENTS = Object.freeze(SCHEMA_FILES.flatMap((fileName) => [`start ${fileName}`, `finish ${fileName}`]));

// The third file of the schema as a build holds it after a rename.
const GUESTS = Object.freeze({ '0003_guests.up.sql': INVITES['0003_invites.up.sql'] });

const MEMBER_AGE = Object.freeze({
  '0004_member_age.up.sql': "ALTER TABLE members ADD COLUMN age INT NULL, ADD KEY members_age (age), ADD CONSTRAINT members_age_check CHECK (age >= 0);\nALTER TABLE teams COMMENT = 'Teams of members';\n",
  '0004_member_age.down.sql': "ALTER TABLE members DROP CONSTRAINT members_age_check, DROP KEY members_age, DROP COLUMN age;\nALTER TABLE teams COMMENT = 'Teams';\n",
});

const SEEDS = Object.freeze({
  'seed/0001_core_team.up.sql': "INSERT INTO teams (id, slug) VALUES (1, 'core');\n",
  'seed/0002_web_team.up.sql': "INSERT INTO teams (id, slug) VALUES (2, 'web');\n",
});

// The lowest version came last: it alters the table the second one creates, after the third has altered it.
const PROJECTS = Object.freeze({
  '0002_projects.up.sql': 'CREATE TABLE projects (id INT PRIMARY KEY, title VARCHAR(50) NOT NULL) COLLATE=utf8mb4_bin;\n',
  '0003_project_owner.up.sql': 'ALTER TABLE projects ADD COLUMN owner_id INT NULL;\n',
});
const PROJECT_CODE = Object.freeze({ '0001_project_code.up.sql': 'ALTER TABLE projects ADD COLUMN code VARCHAR(10) NULL;\n' });

const COLLATIONS = Object.freeze({
  '0001_labels.up.sql': `
    CREATE TABLE labels (id INT PRIMARY KEY, title VARCHAR(50) NOT NULL) DEFAULT CHARSET=utf8mb4;
    CREATE TABLE codes (
      id INT PRIMARY KEY,
      code VARCHAR(10) COLLATE utf8mb4_general_ci NOT NULL,
      legacy VARCHAR(10) CHARACTER SET latin1 NULL,
      title VARCHAR(50) COLLATE utf8mb4_uca1400_ai_ci NULL
    ) COLLATE=utf8mb4_bin;
    CREATE VIEW code_list AS SELECT code, legacy FROM codes;
  `,
});

// Names neither a charset nor a collation: its table takes what its database defaults to.
const PLAIN = Object.freeze({ '0001_plain.up.sql': 'CREATE TABLE plain (id INT PRIMARY KEY, title VARCHAR(50) NULL);\n' });

// Of each kind one constraint the migration names and one it leaves to the server, and a check written
// on a column, which the server names after the column.
const SEATS = Object.freeze({
  '0002_seats.up.sql': `
    CREATE TABLE seats (
      id INT NOT NULL,
      team_id INT NOT NULL,
      host_team_id INT NOT NULL,
      capacity INT NOT NULL CHECK (capacity > 0),
      price INT NOT NULL,
      PRIMARY KEY (id),
      FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
      CONSTRAINT seats_host_team_fk FOREIGN KEY (host_team_id) REFERENCES teams (id) ON DELETE CASCADE,
      CHECK (price >= 0),
      CONSTRAINT seats_price_check CHECK (price < 1000)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Seats';
  `,
});

// One table in three steps, each with a table check of its own. The server drops a check with the only
// column it names, so the down file of the second step spells no name.
const COUNTERS = Object.freeze({
  '0001_counters.up.sql': 'CREATE TABLE counters (a INT NULL, CONSTRAINT counters_a_check CHECK (a > 0)) COLLATE=utf8mb4_bin;\n',
  '0002_counter_b.up.sql': 'ALTER TABLE counters ADD COLUMN b INT NULL, ADD CONSTRAINT counters_b_check CHECK (b > 0);\n',
  '0002_counter_b.down.sql': 'ALTER TABLE counters DROP COLUMN b;\n',
  '0003_counter_c.up.sql': 'ALTER TABLE counters ADD COLUMN c INT NULL, ADD CONSTRAINT counters_c_check CHECK (c > 0);\n',
});

// The same steps with the names of the checks left to the server, and the names it gives three of them.
const CONSTRAINT_NAME_REGEXP = /CONSTRAINT \w+ /g;
const COUNTERS_UNNAMED = Object.freeze(mapValues(COUNTERS, (sql) => sql.replaceAll(CONSTRAINT_NAME_REGEXP, '')));
const SERVER_CHECK_NAMES = Object.freeze(['CONSTRAINT_1', 'CONSTRAINT_2', 'CONSTRAINT_3']);
const RENUMBERED_CHECK_REGEXP = /^check counters\.CONSTRAINT_\d+: clause is /m;

const INVOICES = Object.freeze({
  '0001_invoices.up.sql': `
    CREATE SEQUENCE invoice_numbers START WITH 1000;
    CREATE TABLE invoices (
      id INT NOT NULL,
      issue_number BIGINT NOT NULL DEFAULT NEXTVAL(invoice_numbers),
      net DECIMAL(10,2) NOT NULL,
      gross DECIMAL(10,2) AS (net * 1.2) STORED,
      label VARCHAR(20) AS (CONCAT('INV-', id)) VIRTUAL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
    CREATE VIEW invoice_totals AS SELECT id, gross FROM invoices;
  `,
});

// Fails on its second statement, with its first table made; the corrected text is what the file was meant to do.
const HALVES = Object.freeze({
  '0002_halves.up.sql': 'CREATE TABLE halves (id INT PRIMARY KEY) COLLATE=utf8mb4_bin;\nCREATE TABLE halves (id INT);\n',
});
const HALVES_CORRECTED = 'CREATE TABLE halves (id INT PRIMARY KEY) COLLATE=utf8mb4_bin;\nCREATE TABLE wholes (id INT PRIMARY KEY) COLLATE=utf8mb4_bin;\n';
const HALVES_FAILURE = "0002_halves.up.sql: statement 2 failed: Table 'halves' already exists";

// Its ALTER stays, being DDL, and its backfill fails where two slugs begin with one letter: every column
// and index of the file is there then, and none of its rows.
const TEAM_CODE = Object.freeze({
  '0002_team_code.up.sql': 'ALTER TABLE teams ADD COLUMN code VARCHAR(10) NULL, ADD UNIQUE KEY teams_code_unique (code);\nUPDATE teams SET code = LEFT(slug, 1);\n',
});
const TEAM_CODE_FAILURE = "0002_team_code.up.sql: statement 2 failed: Duplicate entry '***' for key 'teams_code_unique'";

// Applies where a table "legacy" stands that no migration creates, and so fails where the migrations are built.
const LEGACY_NOTE = Object.freeze({
  '0002_legacy_note.up.sql': 'CREATE TABLE notes (id INT PRIMARY KEY) COLLATE=utf8mb4_bin;\nALTER TABLE legacy ADD COLUMN note INT NULL;\n',
});
const LEGACY_NOTE_FAILURE = 'While building the reference database: 0002_legacy_note.up.sql: statement 2 failed';

const LIVE = 'in the live database';
const BUILT = 'by the migrations';
const EXTRA = 'exists in the live database, the migrations do not create it';
const ABSENT = 'missing in the live database, the migrations create it';
const DIRTY = 'is dirty: with no other line here, the tables, columns, indexes, checks and foreign keys of its up file are all there; the rows it writes are not compared';
const SERVER_NAMED = 'the server has named it, give it a name in the migration (CONSTRAINT <name> ...)';
const NOT_DROPPED = 'that "verify" has built could not be dropped: drop it by hand';

// A change made by hand, and every line "verify" must tell of it: no line less and no line more.
const DRIFTS = Object.freeze([
  ['a longer column', 'ALTER TABLE members MODIFY email VARCHAR(200) NOT NULL', [
    `column members.email: type is "varchar(200)" ${LIVE}, "varchar(100)" ${BUILT}`,
  ]],
  ['a column that may be null', 'ALTER TABLE members MODIFY email VARCHAR(100) NULL', [
    `column members.email: nullable is "YES" ${LIVE}, "NO" ${BUILT}`,
    `column members.email: default is "NULL" ${LIVE}, null ${BUILT}`,
  ]],
  ['another default', "ALTER TABLE members ALTER status SET DEFAULT 'blocked'", [
    `column members.status: default is "'blocked'" ${LIVE}, "'active'" ${BUILT}`,
  ]],
  ['another collation of a column', 'ALTER TABLE members MODIFY name VARCHAR(100) COLLATE utf8mb4_bin NULL', [
    `column members.name: collation is "utf8mb4_bin" ${LIVE}, "utf8mb4_uca1400_ai_ci" ${BUILT}`,
  ]],
  ['a comment of a column', "ALTER TABLE members MODIFY email VARCHAR(100) NOT NULL COMMENT 'Login'", [
    `column members.email: comment is "Login" ${LIVE}, "" ${BUILT}`,
  ]],
  ['a column that tracks its update', 'ALTER TABLE members MODIFY created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)', [
    `column members.created_at: extra is "on update current_timestamp(3)" ${LIVE}, "" ${BUILT}`,
  ]],
  ['a signed column made unsigned', 'ALTER TABLE members MODIFY id INT UNSIGNED NOT NULL AUTO_INCREMENT', [
    `column members.id: type is "int(10) unsigned" ${LIVE}, "int(11)" ${BUILT}`,
  ]],
  ['an added column', 'ALTER TABLE members ADD COLUMN note VARCHAR(10) NULL', [
    `column members.note: ${EXTRA}`,
  ]],
  ['an added column of a foreign charset, once: the collations are checked in what the migrations give', 'ALTER TABLE members ADD COLUMN legacy VARCHAR(10) CHARACTER SET latin1 NULL', [
    `column members.legacy: ${EXTRA}`,
  ]],
  ['a dropped column, with the index on it', 'ALTER TABLE members DROP COLUMN name', [
    `column members.name: ${ABSENT}`,
    `index members.members_name: ${ABSENT}`,
  ]],
  ['a moved column', "ALTER TABLE members MODIFY status VARCHAR(16) NOT NULL DEFAULT 'active' AFTER id", [
    `table members: the columns stand as id, status, team_id, email, name, profile, created_at ${LIVE}, as id, team_id, email, name, status, profile, created_at ${BUILT}`,
  ]],
  ['a renamed column', 'ALTER TABLE members RENAME COLUMN name TO full_name', [
    `column members.full_name: ${EXTRA}`,
    `column members.name: ${ABSENT}`,
    `index members.members_name: columns is "full_name(10)" ${LIVE}, "name(10)" ${BUILT}`,
  ]],
  ['an added index', 'ALTER TABLE members ADD KEY members_status (status)', [
    `index members.members_status: ${EXTRA}`,
  ]],
  ['a dropped index', 'ALTER TABLE members DROP KEY members_name', [
    `index members.members_name: ${ABSENT}`,
  ]],
  ['a unique index made plain', 'ALTER TABLE members DROP KEY members_email_unique, ADD KEY members_email_unique (email)', [
    `index members.members_email_unique: unique is "NO" ${LIVE}, "YES" ${BUILT}`,
  ]],
  ['a plain index made unique', 'ALTER TABLE members DROP KEY members_name, ADD UNIQUE KEY members_name (name(10))', [
    `index members.members_name: unique is "YES" ${LIVE}, "NO" ${BUILT}`,
  ]],
  ['an index of other columns', 'ALTER TABLE members DROP KEY members_name, ADD KEY members_name (name DESC, email)', [
    `index members.members_name: columns is "name DESC, email" ${LIVE}, "name(10)" ${BUILT}`,
  ]],
  ['an index the optimizer is told to ignore', 'ALTER TABLE members ALTER INDEX members_name IGNORED', [
    `index members.members_name: ignored is "YES" ${LIVE}, "NO" ${BUILT}`,
  ]],
  ['an added foreign key, though another table has a key of its name', 'ALTER TABLE invites ADD CONSTRAINT members_team_fk FOREIGN KEY (team_id) REFERENCES teams (id)', [
    `foreign key invites.members_team_fk: ${EXTRA}`,
  ]],
  ['a dropped foreign key', 'ALTER TABLE members DROP FOREIGN KEY members_team_fk', [
    `foreign key members.members_team_fk: ${ABSENT}`,
  ]],
  ['another rule of a foreign key', 'ALTER TABLE members DROP FOREIGN KEY members_team_fk, ADD CONSTRAINT members_team_fk FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE RESTRICT', [
    `foreign key members.members_team_fk: on delete is "RESTRICT" ${LIVE}, "CASCADE" ${BUILT}`,
  ]],
  ['an added check', "ALTER TABLE invites ADD CONSTRAINT invites_email_check CHECK (email <> '')", [
    `check invites.invites_email_check: ${EXTRA}`,
  ]],
  ['a dropped check', 'ALTER TABLE members DROP CONSTRAINT members_status_check', [
    `check members.members_status_check: ${ABSENT}`,
  ]],
  ['another text of a check', "ALTER TABLE members DROP CONSTRAINT members_status_check, ADD CONSTRAINT members_status_check CHECK (status IN ('active', 'blocked', 'deleted'))", [
    `check members.members_status_check: clause is "\`status\` in ('active','blocked','deleted')" ${LIVE}, "\`status\` in ('active','blocked')" ${BUILT}`,
  ]],
  ['a JSON column made plain text', 'ALTER TABLE members MODIFY profile LONGTEXT COLLATE utf8mb4_bin NULL', [
    `check members.profile: ${ABSENT}`,
  ]],
  ['another engine', 'ALTER TABLE invites ENGINE = MyISAM', [
    `table invites: engine is "MyISAM" ${LIVE}, "InnoDB" ${BUILT}`,
  ]],
  ['another comment of a table', "ALTER TABLE members COMMENT = 'People'", [
    `table members: comment is "People" ${LIVE}, "Members" ${BUILT}`,
  ]],
  ['another default collation of a table', 'ALTER TABLE teams COLLATE = utf8mb4_uca1400_ai_ci', [
    `table teams: default collation is "utf8mb4_uca1400_ai_ci" ${LIVE}, "utf8mb4_bin" ${BUILT}`,
  ]],
  ['another row format', 'ALTER TABLE teams ROW_FORMAT = COMPACT', [
    `table teams: row format is "Compact" ${LIVE}, "Dynamic" ${BUILT}`,
    `table teams: options is "row_format=COMPACT" ${LIVE}, "" ${BUILT}`,
  ]],
  ['a table no migration creates', 'CREATE TABLE extras (id INT PRIMARY KEY)', [
    `table extras: ${EXTRA}`,
  ]],
  ['a table and columns named as the properties every object has', 'CREATE TABLE `constructor` (`toString` INT PRIMARY KEY, `__proto__` INT NULL)', [
    `table constructor: ${EXTRA}`,
  ]],
  ['a view no migration creates', 'CREATE VIEW member_names AS SELECT id, name FROM members', [
    `table member_names: ${EXTRA}`,
  ]],
  ['a dropped table', 'DROP TABLE members', [
    `table members: ${ABSENT}`,
  ]],
]);

// What readStructure() gives of the table "teams", in the form compareStructures() takes.
const TEAMS_STRUCTURE = Object.freeze({
  cells: {
    type: 'BASE TABLE', engine: 'InnoDB', rowFormat: 'Dynamic', defaultCollation: 'utf8mb4_bin', options: '', comment: 'Teams',
  },
  columnOrder: ['id', 'slug'],
  columns: {
    id: {
      type: 'int(11)', nullable: 'NO', default: null, extra: '', collation: null, generationExpression: null, comment: '',
    },
    slug: {
      type: 'varchar(50)', nullable: 'NO', default: null, extra: '', collation: 'utf8mb4_bin', generationExpression: null, comment: '',
    },
  },
  indexes: {
    PRIMARY: {
      columns: 'id', unique: 'YES', type: 'BTREE', ignored: 'NO', comment: '',
    },
    teams_slug_unique: {
      columns: 'slug', unique: 'YES', type: 'BTREE', ignored: 'NO', comment: '',
    },
  },
  checks: {},
  foreignKeys: {},
});

const testDb = await createTestDb();
const { up, down, verify } = bindMigrator(testDb);

// The objects readStructure() keys by name have no prototype: a copy with plain ones compares with a literal.
async function read(database, options, pool = testDb) {
  return structuredClone(await pool.run(() => readStructure(database, options)));
}

// What "verify" resolves with when the live database is what its migrations build.
function matched(tableCount) {
  return {
    database: testDb.name, tableCount, differences: [], notes: [],
  };
}

// The databases "verify" builds through a pool of this file, as LIKE and GRANT name them.
function toReferencePattern() {
  return toLikePattern(testDb.config.db.migrationReferencePrefix);
}

function isReferenceName(name) {
  const prefix = testDb.config.db.migrationReferencePrefix;

  return name.startsWith(prefix) && isUuid(name.slice(prefix.length).replaceAll('_', '-'));
}

// "record" is a callback of a run: it notes the databases of "verify" that stand on the server at that moment.
function watchReferences() {
  const seen = new Set();

  async function record() {
    (await listReferenceNames(testDb)).forEach((name) => seen.add(name));
  }

  return { seen, record };
}

// The one database "verify" has left behind: a leftover of an earlier test must not be taken for it.
async function readLeftReference() {
  const references = await listReferenceNames(testDb);

  assert.equal(references.length, 1, `Expected one database of "verify", found: ${references.join(', ')}`);

  return references[0];
}

async function dropReferences() {
  const references = await listReferenceNames(testDb);

  await Promise.all(references.map((name) => testDb.runAsAdmin(`DROP DATABASE IF EXISTS \`${name}\``)));
}

// A pool of an account that may build the databases of "verify" and may not drop them: what it has built
// stays on the server, and goes with the test when the test has failed before it dropped that by hand.
// "db" is the db section of its config.
async function openKeeper(t, db) {
  const pattern = toReferencePattern();
  const account = await testDb.createOwner(t, [pattern]);

  t.after(dropReferences);
  await testDb.runAsAdmin(`REVOKE DROP ON \`${pattern}\`.* FROM ?@?`, [account.APP_DATABASE_USER, ACCOUNT_HOST]);

  return testDb.open({ env: account, db }, t);
}

// A callback of a run that ends the session "id" as the first file starts: by then that session holds the lock
// of the migrator and the database of "verify" is created.
function cutLockAtStart(id) {
  async function cutLock(fileName) {
    if (fileName === FIRST_FILE) {
      await killSession(testDb, id);
    }
  }

  return cutLock;
}

// What a run rejects with when the session of its lock is gone; "lost" is the error of the driver behind it.
function describeLockLost(lost) {
  return `The connection the migrator keeps its lock on was lost (${lost?.message}): run the command again`;
}

// Migrated in a row, then the step in the middle rolled back alone and applied again: the database has
// recorded the steps as the first, the third, the second, and "verify" builds them in that order.
async function migrateOutOfOrder(directory) {
  await up({ directory });
  await down({ directory, names: ['counter_b'] });
  await up({ directory });
}

describe('verifyMigrations', { skip: testDb.skip }, () => {
  beforeEach(() => Promise.all([testDb.reset(), dropReferences()]));

  test('finds nothing in a database its migrations have built, whatever rows it holds, and tells of every file it builds from', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const { events, hooks } = createMigrationEvents();

    await up({ directory });
    await testDb.readRows("INSERT INTO teams (id, slug) VALUES (1, 'core'), (2, 'web')");
    await testDb.readRows("INSERT INTO members (team_id, email, profile) VALUES (1, 'a@example.com', '{\"a\": 1}'), (2, 'b@example.com', NULL)");

    assert.deepEqual(await verify({ directory, ...hooks }), matched(3));
    assert.deepEqual(events, SCHEMA_EVENTS);
  });

  test('finds nothing after the same schema was reached another way: by later migrations, by a rollback and a new run', async (t) => {
    const directory = await createMigrationDir(t, { ...SCHEMA, ...MEMBER_AGE });

    await up({ directory, names: ['teams', 'members'] });
    await up({ directory });
    await down({ directory });
    await down({ directory, names: ['members'] });
    await up({ directory });

    assert.deepEqual(await verify({ directory }), matched(3));
  });

  test('does not mind the next AUTO_INCREMENT value: it is a counter of rows, not a part of the schema', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);

    await up({ directory });
    await testDb.readRows('ALTER TABLE members AUTO_INCREMENT = 5000');

    assert.deepEqual(await verify({ directory }), matched(3));
  });

  DRIFTS.forEach(([name, sql, differences]) => {
    test(`tells of ${name}`, async (t) => {
      const directory = await createMigrationDir(t, SCHEMA);

      await up({ directory });
      await testDb.readRows(sql);

      assert.deepEqual((await verify({ directory })).differences, differences);
    });
  });

  // The table and the view swap their names: each then differs from what the migrations build under its name
  // in its columns as well, and none of those is told.
  test('tells of a table that became a view, and of a view that became a table, in one line each: nothing else of the two is compared', async (t) => {
    const directory = await createMigrationDir(t, INVOICES);

    await up({ directory });
    await testDb.readRows('DROP VIEW invoice_totals');
    await testDb.readRows('RENAME TABLE invoices TO invoice_totals');
    await testDb.readRows('CREATE VIEW invoices AS SELECT id, gross FROM invoice_totals');

    assert.deepEqual(await verify({ directory }), {
      ...matched(3),
      differences: [
        `table invoice_totals: type is "BASE TABLE" ${LIVE}, "VIEW" ${BUILT}`,
        `table invoices: type is "VIEW" ${LIVE}, "BASE TABLE" ${BUILT}`,
      ],
    });
  });

  test('leaves the table of the migrator out: no migration creates it, and a change made to it by hand is not a difference', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);

    await up({ directory });
    await testDb.readRows("ALTER TABLE _migrations ADD COLUMN note VARCHAR(10) COLLATE utf8mb4_general_ci NULL, COMMENT = 'Kept by hand'");

    assert.deepEqual(await verify({ directory }), matched(3));
  });

  test('finds nothing in a sequence, a default that takes its next value, a generated column and a view: the default is read without the name of its database', async (t) => {
    const directory = await createMigrationDir(t, INVOICES);

    await up({ directory });
    await testDb.readRows('INSERT INTO invoices (id, net) VALUES (1, 100), (2, 250)');

    const { invoices } = (await read(testDb.name)).tables;

    assert.deepEqual(await verify({ directory }), matched(3));
    assert.equal(invoices.columns.issue_number.default, 'nextval(`invoice_numbers`)');
    assert.deepEqual([invoices.columns.gross.extra, invoices.columns.gross.generationExpression], ['STORED GENERATED', '`net` * 1.2']);
    assert.deepEqual([invoices.columns.label.extra, invoices.columns.label.generationExpression], ['VIRTUAL GENERATED', "concat('INV-',`id`)"]);
  });

  test('builds and compares a foreign key into another database: a file may name that one, and the key is read with its name', async (t) => {
    const neighbour = await testDb.createNeighbour(t);
    const directory = await createMigrationDir(t, {
      '0001_subscriptions.up.sql': `
        CREATE TABLE subscriptions (
          id INT PRIMARY KEY,
          plan_id INT NOT NULL,
          CONSTRAINT subscriptions_plan_fk FOREIGN KEY (plan_id) REFERENCES \`${neighbour}\`.plans (id)
        ) COLLATE=utf8mb4_bin;
      `,
    });

    await testDb.runAsAdmin(`CREATE TABLE \`${neighbour}\`.plans (id INT PRIMARY KEY)`);
    await up({ directory });

    assert.deepEqual(await verify({ directory }), matched(1));
    assert.deepEqual((await read(testDb.name)).tables.subscriptions.foreignKeys, {
      subscriptions_plan_fk: {
        columns: 'plan_id', references: `${neighbour}.plans.id`, onUpdate: 'RESTRICT', onDelete: 'RESTRICT',
      },
    });
  });

  test('checks the collations the migrations give, though the live database matches them: of a table and of a column, not of a view', async (t) => {
    const directory = await createMigrationDir(t, COLLATIONS);

    await up({ directory });

    assert.deepEqual(await verify({ directory }), {
      ...matched(3),
      differences: [
        'column codes.code: the collation utf8mb4_general_ci is not allowed, only utf8mb4_bin and utf8mb4_uca1400_ai_ci are',
        'column codes.legacy: the collation latin1_swedish_ci is not allowed, only utf8mb4_bin and utf8mb4_uca1400_ai_ci are',
        'table labels: the default collation is utf8mb4_uca1400_ai_ci, it must be utf8mb4_bin',
      ],
    });
  });

  test('asks for a name where a migration has left a table check or a foreign key to the server, though the live database matches: a named one and a check written on a column give no line', async (t) => {
    const directory = await createMigrationDir(t, { ...TEAMS, ...SEATS });

    await up({ directory });

    const { seats } = (await read(testDb.name)).tables;

    assert.deepEqual(await verify({ directory }), {
      ...matched(2),
      differences: [`check seats.CONSTRAINT_1: ${SERVER_NAMED}`, `foreign key seats.1: ${SERVER_NAMED}`],
    });
    assert.deepEqual(Object.keys(seats.checks).toSorted(), ['CONSTRAINT_1', 'capacity', 'seats_price_check']);
    assert.deepEqual(Object.keys(seats.foreignKeys).toSorted(), ['1', 'seats_host_team_fk']);
  });

  test('finds nothing after a step in the middle was rolled back alone and applied again, when every check has a name: a name does not depend on the order the files ran in', async (t) => {
    const directory = await createMigrationDir(t, COUNTERS);

    await migrateOutOfOrder(directory);

    assert.deepEqual(await verify({ directory }), matched(1));
  });

  test('asks for the names because the server numbers an unnamed check by what its table holds: after the same rollback the live database and the one the files build give one number to two checks', async (t) => {
    const directory = await createMigrationDir(t, COUNTERS_UNNAMED);
    const guard = SERVER_CHECK_NAMES.map((name) => `check counters.${name}: ${SERVER_NAMED}`);

    await migrateOutOfOrder(directory);

    const { differences } = await verify({ directory });

    assert.match(differences.join('\n'), RENUMBERED_CHECK_REGEXP);
    assert.deepEqual(differences.filter((line) => line.endsWith(SERVER_NAMED)), guard);
  });

  test('creates its database with the charset and the collation of the live one: a table that names none takes the same on both sides', async (t) => {
    const directory = await createMigrationDir(t, PLAIN);

    await testDb.alterDatabase('COLLATE utf8mb4_general_ci');
    await up({ directory });

    assert.deepEqual((await verify({ directory })).differences, [
      'table plain: the default collation is utf8mb4_general_ci, it must be utf8mb4_bin',
      'column plain.title: the collation utf8mb4_general_ci is not allowed, only utf8mb4_bin and utf8mb4_uca1400_ai_ci are',
    ]);
  });

  test('neither builds nor compares a migration that is not applied: it names it in a note and does not miss its tables', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const { events, hooks } = createMigrationEvents();

    await up({ directory, names: ['teams'] });

    assert.deepEqual(await verify({ directory, ...hooks }), {
      ...matched(1),
      notes: ['not applied, and so not compared: 0002_members, 0003_invites'],
    });
    assert.deepEqual(events, ['start 0001_teams.up.sql', 'finish 0001_teams.up.sql']);
  });

  test('tells what of a dirty migration the database lacks once its file can be built, and adds a line for the mark itself', async (t) => {
    const directory = await createMigrationDir(t, { ...TEAMS, ...HALVES });
    const dirty = `the migration 0002_halves ${DIRTY}`;

    await assert.rejects(up({ directory }), { message: `${HALVES_FAILURE}; the migration is left dirty` });
    await assert.rejects(verify({ directory }), { message: `While building the reference database: ${HALVES_FAILURE}` });

    await writeMigrationFiles(directory, { '0002_halves.up.sql': HALVES_CORRECTED });

    assert.deepEqual((await verify({ directory })).differences, [`table wholes: ${ABSENT}`, dirty]);

    await testDb.readRows('CREATE TABLE wholes (id INT PRIMARY KEY) COLLATE=utf8mb4_bin');

    assert.deepEqual((await verify({ directory })).differences, [dirty]);
  });

  test('tells of a dirty migration whose backfill failed in the line of the mark alone: its columns and indexes are there, and the line does not claim the rows the file was to write', async (t) => {
    const directory = await createMigrationDir(t, { ...TEAMS, ...TEAM_CODE });

    await up({ directory, names: ['teams'] });
    await testDb.readRows("INSERT INTO teams (id, slug) VALUES (1, 'core'), (2, 'crew')");
    await assert.rejects(up({ directory }), { message: `${TEAM_CODE_FAILURE}; the migration is left dirty` });

    assert.deepEqual(await verify({ directory }), {
      ...matched(1),
      differences: [`the migration 0002_team_code ${DIRTY}`],
    });
    assert.deepEqual(await testDb.readRows('SELECT code FROM teams ORDER BY id'), [{ code: null }, { code: null }]);
  });

  test('compares with the file as it is now when a migration was changed after it was applied, and says so in a line', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);

    await up({ directory });
    await writeMigrationFiles(directory, { '0001_teams.up.sql': TEAMS['0001_teams.up.sql'].replace('VARCHAR(50)', 'VARCHAR(60)') });

    assert.deepEqual((await verify({ directory })).differences, [
      `column teams.slug: type is "varchar(50)" ${LIVE}, "varchar(60)" ${BUILT}`,
      'the migration 0001_teams was changed after it was applied: the comparison was made with the file as it is now',
    ]);
  });

  test('refuses to compare when an applied migration has no file in this build, before it builds anything', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const { events, hooks } = createMigrationEvents();

    await up({ directory });
    await removeMigrationFiles(directory, Object.keys(INVITES));

    await assert.rejects(verify({ directory, ...hooks }), {
      message: 'The migration 0003_invites is applied, and this build has no file of it: "verify" builds from the files of the build that applied it',
    });
    assert.deepEqual(events, []);
  });

  test('refuses to compare when the file under an applied number has another name, before it builds anything, and compares once the file has its name back', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const { events, hooks } = createMigrationEvents();

    await up({ directory });
    await removeMigrationFiles(directory, Object.keys(INVITES));
    await writeMigrationFiles(directory, GUESTS);

    await assert.rejects(verify({ directory, ...hooks }), {
      message: 'Version 3 is applied to this database as the migration 0003_invites, and this build has 0003_guests under it: two migrations took one number, or the file was renamed after it was applied. Give another number to the one that is not applied, or give the file its name back',
    });
    assert.deepEqual(events, []);

    await removeMigrationFiles(directory, Object.keys(GUESTS));
    await writeMigrationFiles(directory, INVITES);

    assert.deepEqual(await verify({ directory }), matched(3));
  });

  test('builds in the order the database recorded, not in the order of the versions: a lower version that was applied later alters what a higher one created', async (t) => {
    const directory = await createMigrationDir(t, PROJECTS);
    const { events, hooks } = createMigrationEvents();

    await up({ directory });
    await writeMigrationFiles(directory, PROJECT_CODE);
    await up({ directory });

    assert.deepEqual(await verify({ directory, ...hooks }), matched(1));
    assert.deepEqual(events.filter((event) => event.startsWith('start')), [
      'start 0002_projects.up.sql',
      'start 0003_project_owner.up.sql',
      'start 0001_project_code.up.sql',
    ]);
  });

  test('takes no notice of seeds: an applied one is not built, and one that is not applied is not named', async (t) => {
    const directory = await createMigrationDir(t, { ...SCHEMA, ...SEEDS });
    const { events, hooks } = createMigrationEvents();

    await up({ directory });
    await up({ directory, type: MIGRATION_TYPE.SEED, names: ['core_team'] });

    assert.deepEqual(await verify({ directory, ...hooks }), matched(3));
    assert.deepEqual(events, SCHEMA_EVENTS);
  });

  test('compares a database no migrator has touched as an empty one, and leaves it without the table of the migrator', async (t) => {
    const directory = await createMigrationDir(t);

    assert.deepEqual(await verify({ directory }), matched(0));

    await writeMigrationFiles(directory, SCHEMA);

    assert.deepEqual(await verify({ directory }), {
      ...matched(0),
      notes: ['not applied, and so not compared: 0001_teams, 0002_members, 0003_invites'],
    });
    assert.deepEqual(await listTableNames(testDb), []);
  });

  // The account may not create a database: had "verify" asked for one first, it would be told of that right.
  test('refuses an applied file that now names the live database before it creates a database of its own: run there, the file would write into the live one', async (t) => {
    const directory = await createMigrationDir(t, TEAMS);
    const owner = testDb.open({ env: await testDb.createOwner(t) }, t);
    await up({ directory });
    await writeMigrationFiles(directory, { '0001_teams.up.sql': `CREATE TABLE ${testDb.name}.strays (id INT PRIMARY KEY);\n` });

    await assert.rejects(verify({ directory }, owner), {
      message: `0001_teams.up.sql holds ${describeQualifiedName(`${testDb.name}.strays`)}: ${MIGRATION_TEXT.NAMES_NO_DATABASE}`,
    });

    await writeMigrationFiles(directory, { '0001_teams.up.sql': `USE \`${testDb.name}\`;\nCREATE TABLE strays (id INT PRIMARY KEY);\n` });

    await assert.rejects(verify({ directory }, owner), { message: `0001_teams.up.sql holds a USE statement: ${MIGRATION_TEXT.NAMES_NO_DATABASE}` });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'teams']);
  });

  test('never works under a prefix that cannot name a database: one that leaves no room for the UUID after it, or is no name, is refused when the pool is made', (t) => {
    const refusal = {
      name: 'TypeError',
      message: `config.db requires migrationReferencePrefix to be 1 to ${REFERENCE_PREFIX_MAX_LENGTH} letters, digits and underscores that do not start with a digit: a UUID follows it in the name of a database`,
    };

    assert.throws(() => testDb.open({ db: { migrationReferencePrefix: 'v'.repeat(REFERENCE_PREFIX_MAX_LENGTH + 1) } }, t), refusal);
    assert.throws(() => testDb.open({ db: { migrationReferencePrefix: 'verify-' } }, t), refusal);
  });

  test('builds a database of its own beside the live one, named by the prefix of the config and a UUID, and drops it whether it finds a difference or not', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const { seen, record } = watchReferences();

    await up({ directory });

    assert.deepEqual(await verify({ directory, onFileFinish: record }), matched(3));
    assert.deepEqual([...seen].map((name) => isReferenceName(name)), [true]);
    assert.deepEqual(await listReferenceNames(testDb), []);

    await testDb.readRows('DROP TABLE members');

    assert.deepEqual((await verify({ directory, onFileFinish: record })).differences, [`table members: ${ABSENT}`]);
    assert.deepEqual([...seen].map((name) => isReferenceName(name)), [true, true]);
    assert.deepEqual(await listReferenceNames(testDb), []);
  });

  test('drops its database when a file fails in it, and tells the file and the statement after the words "While building the reference database"', async (t) => {
    const directory = await createMigrationDir(t, { ...TEAMS, ...LEGACY_NOTE });
    const { seen, record } = watchReferences();

    await testDb.readRows('CREATE TABLE legacy (id INT PRIMARY KEY)');
    await up({ directory });

    const error = await rejectionOf(verify({ directory, onFileStart: record }));
    const [reference] = seen;

    assert.equal(error.message, `${LEGACY_NOTE_FAILURE}: Table '${reference}.legacy' doesn't exist`);
    assert.deepEqual(await listReferenceNames(testDb), []);
  });

  test('drops its database through a connection of its own when the one that holds the lock was lost, and tells of the lost connection, the error of the driver as its cause', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const single = testDb.open({ db: { connectionLimit: 1 } }, t);
    const [{ id }] = await single.readRows('SELECT CONNECTION_ID() AS id');
    const { seen, record } = watchReferences();

    await up({ directory });

    const error = await rejectionOf(verify({ directory, onFileStart: cutLockAtStart(id), onFileFinish: record }, single));
    const lost = findDbError(error.cause);

    assert.equal(error.message, describeLockLost(lost));
    assert.deepEqual([findDbError(error), lost?.isFatal], [null, true]);
    assert.deepEqual([...seen].map((name) => isReferenceName(name)), [true]);
    assert.deepEqual(await listReferenceNames(testDb), []);
    assert.deepEqual(await verify({ directory }, single), matched(3));
  });

  test('tells of a database it could not drop in a line of the result: a run that has left one behind is not a clean one', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const keeper = await openKeeper(t);

    await up({ directory });

    const result = await verify({ directory }, keeper);
    const reference = await readLeftReference();

    assert.deepEqual(result, { ...matched(3), differences: [`the database ${reference} ${NOT_DROPPED}`] });

    await testDb.runAsAdmin(`DROP DATABASE \`${reference}\``);

    assert.deepEqual(await listReferenceNames(testDb), []);
  });

  test('tells of a database it could not drop after a file has failed in it too: the error names the failure of the build first, then the database to drop by hand', async (t) => {
    const directory = await createMigrationDir(t, { ...TEAMS, ...LEGACY_NOTE });
    const keeper = await openKeeper(t);

    await testDb.readRows('CREATE TABLE legacy (id INT PRIMARY KEY)');
    await up({ directory });

    const error = await rejectionOf(verify({ directory }, keeper));
    const reference = await readLeftReference();

    assert.equal(error.message, `${LEGACY_NOTE_FAILURE}: Table '${reference}.legacy' doesn't exist; the database ${reference} ${NOT_DROPPED}`);

    await testDb.runAsAdmin(`DROP DATABASE \`${reference}\``);

    assert.deepEqual(await listReferenceNames(testDb), []);
  });

  test('tells of a database it could not drop after the comparison has failed too, here with the lock lost: the error ends with the database to drop by hand', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const keeper = await openKeeper(t, { connectionLimit: 1 });
    const [{ id }] = await keeper.readRows('SELECT CONNECTION_ID() AS id');

    await up({ directory });

    const error = await rejectionOf(verify({ directory, onFileStart: cutLockAtStart(id) }, keeper));
    const reference = await readLeftReference();

    assert.equal(error.message, `${describeLockLost(findDbError(error.cause?.cause))}; the database ${reference} ${NOT_DROPPED}`);

    await testDb.runAsAdmin(`DROP DATABASE \`${reference}\``);

    assert.deepEqual(await listReferenceNames(testDb), []);
  });

  test('works on a pool of one connection: every file runs on a connection of its own', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const single = testDb.open({ db: { connectionLimit: 1 } }, t);

    await up({ directory });

    assert.deepEqual(await verify({ directory }, single), matched(3));
    assert.equal(single.db.getStats().activeCount, 0);
  });

  test('tells an account that owns only its database which right to give it, the prefix escaped as GRANT takes it, and passes once that statement was run for the account', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const account = await testDb.createOwner(t);
    const grant = `GRANT ALL PRIVILEGES ON \`${toReferencePattern()}\`.* TO`;

    await up({ directory });

    await assert.rejects(verify({ directory }, testDb.open({ env: account }, t)), {
      message: `"verify" builds a database of its own beside the live one, and this account may not create it. Give it the right: ${grant} the account`,
    });

    await testDb.runAsAdmin(`${grant} ?@?`, [account.APP_DATABASE_USER, ACCOUNT_HOST]);

    assert.deepEqual(await verify({ directory }, testDb.open({ env: account }, t)), matched(3));
    assert.deepEqual(await listReferenceNames(testDb), []);
  });

  test('waits for a running migrator as "up" does, tells of the wait once and compares what that migrator has left', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const { events, hooks } = createMigrationEvents();
    const reached = Promise.withResolvers();
    const waited = Promise.withResolvers();

    // The migrator stands in its callback, the lock in its hands, until "verify" has told that it waits.
    async function hold() {
      reached.resolve();
      await waited.promise;
    }

    function onLockWait() {
      hooks.onLockWait();
      waited.resolve();
    }

    const migrating = up({ directory, onFileStart: hold });

    t.after(() => {
      waited.resolve();

      return Promise.allSettled([migrating]);
    });
    await Promise.race([reached.promise, migrating]);

    assert.deepEqual(await verify({ directory, ...hooks, onLockWait }), matched(3));
    assert.deepEqual(events, ['wait', ...SCHEMA_EVENTS]);
    assert.deepEqual((await migrating).files, SCHEMA_FILES);
  });
});

describe('readStructure and readDatabaseDefaults', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('read the tables of a database by their names, with the cells of every column, index, check and foreign key and a view by its kind alone, and leave out the tables named in "except"', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);

    await up({ directory });
    await testDb.readRows('CREATE VIEW member_names AS SELECT id, name FROM members');

    const { database, tables } = await read(testDb.name, { except: ['_migrations', 'invites'] });

    assert.equal(database, testDb.name);
    assert.deepEqual(Object.keys(tables).toSorted(), ['member_names', 'members', 'teams']);
    assert.deepEqual(tables.teams, TEAMS_STRUCTURE);
    assert.deepEqual(tables.member_names.cells, { type: 'VIEW' });
    assert.deepEqual(tables.members.columnOrder, ['id', 'team_id', 'email', 'name', 'status', 'profile', 'created_at']);
    assert.deepEqual(tables.members.columns.status, {
      type: 'varchar(16)', nullable: 'NO', default: "'active'", extra: '', collation: 'utf8mb4_bin', generationExpression: null, comment: '',
    });
    assert.deepEqual(tables.members.indexes.members_name, {
      columns: 'name(10)', unique: 'NO', type: 'BTREE', ignored: 'NO', comment: '',
    });
    assert.deepEqual(tables.members.checks, {
      members_status_check: { level: 'Table', clause: "`status` in ('active','blocked')" },
      profile: { level: 'Column', clause: 'json_valid(`profile`)' },
    });
    assert.deepEqual(tables.members.foreignKeys, {
      members_team_fk: {
        columns: 'team_id', references: 'teams.id', onUpdate: 'RESTRICT', onDelete: 'CASCADE',
      },
    });
    assert.deepEqual(Object.keys((await read(testDb.name)).tables).toSorted(), ['_migrations', 'invites', 'member_names', 'members', 'teams']);
  });

  test('leave out the temporary tables and sequences of the session that reads, also one that hides a table or a sequence of the database', async (t) => {
    const single = testDb.open({ db: { connectionLimit: 1 } }, t);

    await single.readRows('CREATE TABLE notes (id INT PRIMARY KEY) COLLATE=utf8mb4_bin');
    await single.readRows('CREATE SEQUENCE note_numbers');
    await single.readRows('CREATE TEMPORARY TABLE notes (id INT, body TEXT)');
    await single.readRows('CREATE TEMPORARY TABLE scratch (id INT)');
    await single.readRows('CREATE TEMPORARY SEQUENCE note_numbers START WITH 500');
    await single.readRows('CREATE TEMPORARY SEQUENCE scratch_numbers');

    const { tables } = await read(testDb.name, {}, single);

    assert.deepEqual(Object.keys(tables).toSorted(), ['note_numbers', 'notes']);
    assert.deepEqual([tables.notes.cells.type, tables.note_numbers.cells.type], ['BASE TABLE', 'SEQUENCE']);
    assert.deepEqual(tables.notes.columnOrder, ['id']);
    assert.deepEqual(await single.readRows('SELECT COUNT(*) AS total FROM scratch'), [{ total: 0 }]);
    assert.deepEqual(await single.readRows('SELECT NEXTVAL(note_numbers) AS hiding, NEXTVAL(scratch_numbers) AS scratch'), [{ hiding: 500, scratch: 1 }]);
  });

  test('refuse to read the foreign keys as an account that may only read: it is shown their columns and not the keys, and a comparison would lose them without a word', async (t) => {
    const directory = await createMigrationDir(t, SCHEMA);
    const account = await testDb.createOwner(t);
    const reader = [account.APP_DATABASE_USER, ACCOUNT_HOST];

    await up({ directory });
    await testDb.runAsAdmin('REVOKE ALL PRIVILEGES, GRANT OPTION FROM ?@?', reader);
    await testDb.runAsAdmin(`GRANT SELECT ON \`${toLikePattern(testDb.name)}\`.* TO ?@?`, reader);

    await assert.rejects(read(testDb.name, {}, testDb.open({ env: account }, t)), {
      message: `The foreign keys of the database "${testDb.name}" cannot be read: information_schema shows this account their columns and not the keys themselves`,
    });
  });

  test('refuse a database that is not there instead of reading it as an empty one', async () => {
    const refusal = { message: 'Database "nfs_test_missing" does not exist' };

    await assert.rejects(testDb.run(() => readStructure('nfs_test_missing')), refusal);
    await assert.rejects(testDb.run(() => readDatabaseDefaults('nfs_test_missing')), refusal);
  });

  test('readDatabaseDefaults gives the charset, the collation and the comment of a database', async () => {
    await testDb.alterDatabase("COLLATE utf8mb4_uca1400_ai_ci COMMENT 'Kept by the tests'");

    assert.deepEqual(await testDb.run(() => readDatabaseDefaults(testDb.name)), {
      charset: 'utf8mb4', collation: 'utf8mb4_uca1400_ai_ci', comment: 'Kept by the tests',
    });
  });
});
