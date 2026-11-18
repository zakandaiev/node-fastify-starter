import { runMigrate } from '#root/scripts/migrate.js';
import { waitFor } from '#root/tests/helper/async.js';
import {
  connectAdmin,
  countSessionsLeft,
  createDatabaseName,
  createDownEnv,
  createGate,
  createTestDb,
  findSessionId,
} from '#root/tests/helper/db.js';
import {
  createMigrationDir,
  describeDirtyRefusal,
  describeTarget,
  listReferenceNames,
  listTableNames,
  loseMigratorLock,
  MIGRATION_TEXT,
  readAppliedRows,
  readKillStatement,
  readStatementsByHand,
  removeMigrationFiles,
  runMigrateProcess,
  writeMigrationFiles,
} from '#root/tests/helper/migration.js';
import { mapSeries } from '#utils/async.js';
import { sha256 } from '#utils/hash.js';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import nodePath from 'node:path';
import { beforeEach, describe, test } from 'node:test';

const DEFAULT_MODE = 'prod';
const DEV = Object.freeze({ APP_MODE: 'dev' });

const LINE_BREAK = '\n';
const PATH_SEPARATOR = '/';
const TIME_REGEXP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
const DURATION_REGEXP = /\b\d+ ms\b/;
const DIRECTORY_REGEXP = /(?<=created: ).*\//;

const LOCK_PREFIX = 'migrator:';
const RECENT_SECONDS = 5;

// DATE_FORMAT prints a second with six digits after the point, a line of the script with three.
const EXTRA_TIME_DIGITS = 3;

const USERS = Object.freeze({
  '0001_users.up.sql': 'CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(100) NOT NULL);\n',
  '0001_users.down.sql': 'DROP TABLE users;\n',
});
const SESSIONS = Object.freeze({
  '0002_sessions.up.sql': 'CREATE TABLE sessions (id INT PRIMARY KEY);\n',
  '0002_sessions.down.sql': 'DROP TABLE sessions;\n',
});
const TEAMS = Object.freeze({
  '0003_teams.up.sql': 'CREATE TABLE teams (id INT PRIMARY KEY);\n',
  '0003_teams.down.sql': 'DROP TABLE teams;\n',
});

// Another migration under the number of USERS, as a second branch would have made it, and the same one under
// a number that is free.
const ACCOUNTS = Object.freeze({
  '0001_accounts.up.sql': 'CREATE TABLE accounts (id INT PRIMARY KEY);\n',
  '0001_accounts.down.sql': 'DROP TABLE accounts;\n',
});
const RENUMBERED_ACCOUNTS = Object.freeze({
  '0002_accounts.up.sql': ACCOUNTS['0001_accounts.up.sql'],
  '0002_accounts.down.sql': ACCOUNTS['0001_accounts.down.sql'],
});

// Fails on its second statement, with the table of its first one already in the database.
const BROKEN = Object.freeze({
  '0004_broken.up.sql': 'CREATE TABLE halves (id INT PRIMARY KEY);\nCREATE TABLE halves (id INT);\nCREATE TABLE wholes (id INT PRIMARY KEY);\n',
});
const REPAIRED = Object.freeze({
  '0004_broken.up.sql': 'CREATE TABLE halves (id INT PRIMARY KEY);\nCREATE TABLE wholes (id INT PRIMARY KEY);\n',
});

const LATER = Object.freeze({ '0005_later.up.sql': 'CREATE TABLE later (id INT PRIMARY KEY);\n' });

// Two texts the lexer cannot read, each quoted in the refusal with a line break inside the piece: a dump opens
// with a comment the server would run, and the only quote of the other text is never closed.
const DUMPED = Object.freeze({
  '0002_notes.up.sql': '/*!40101 SET NAMES utf8mb4 */;\nCREATE TABLE notes (id INT PRIMARY KEY);\n',
});
const UNCLOSED = Object.freeze({
  '0002_notes.up.sql': "CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(100));\nINSERT INTO notes (id, body) VALUES (1, 'never closed);\nINSERT INTO notes (id, body) VALUES (2, NULL);\n",
});

// The typo stands on the third line of the second statement: the server quotes the rest of that statement.
const MISSPELLED = Object.freeze({
  '0002_drafts.up.sql': 'CREATE TABLE drafts (id INT PRIMARY KEY);\nCREATE TABLE draft_notes (\n  id INT PRIMARY KEY,\n  body VARCHAR(100) NOT NUL,\n  draft_id INT NOT NULL\n);\n',
});

const SEEDS = Object.freeze({
  'seed/0001_first_user.up.sql': "INSERT INTO users (id, email) VALUES (1, 'first@example.com');\n",
  'seed/0001_first_user.down.sql': 'DELETE FROM users WHERE id = 1;\n',
  'seed/0002_second_user.up.sql': "INSERT INTO users (id, email) VALUES (2, 'second@example.com');\n",
  'seed/0002_second_user.down.sql': 'DELETE FROM users WHERE id = 2;\n',
});

const UNKNOWN_NAME_HINT = 'a name is given without its version, as it stands after the number in the name of the file';

const testDb = await createTestDb();

// The first line of every run that goes to a database: where it is going. "env" is what the run was given
// beside the environment of this file.
function target(label, env = {}) {
  const {
    APP_DATABASE_USER: user,
    APP_DATABASE_HOST: host,
    APP_DATABASE_PORT: port,
    APP_DATABASE_NAME: database,
    APP_MODE: mode = DEFAULT_MODE,
  } = { ...testDb.env, ...env };

  return describeTarget(label, {
    db: {
      user, host, port, database,
    },
    app: { mode },
  });
}

// What differs from run to run is taken out of a line: the moment and the duration.
function normalize(line) {
  return line.replace(TIME_REGEXP, '<time>').replace(DURATION_REGEXP, 'N ms');
}

// The script in this process: the code it would exit with and the lines it prints. "pool" gives the config
// the run reads, "lines" is given by a test that looks at them while the run goes on, "isExact" by one that
// compares the moment and the duration too.
async function migrate(args, {
  directory, pool = testDb, lines = [], isExact = false,
} = {}) {
  const code = await runMigrate({
    readConfig: () => pool.config,
    args,
    directory,
    print: (line) => lines.push(isExact ? line : normalize(line)),
  });

  return { code, lines };
}

// The script as npm runs it, on the migrations of the repository.
async function migrateAsProcess(t, args, { env = {}, systemEnv } = {}) {
  const { code, stdout, stderr } = await runMigrateProcess(t, { ...testDb.env, ...env }, args, systemEnv);

  return { code, lines: stdout.trimEnd().split(LINE_BREAK).map((line) => normalize(line)), stderr };
}

// The files a directory of migrations holds, named as writeMigrationFiles() takes them: a seed with its folder.
async function listFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => nodePath.relative(directory, nodePath.join(entry.parentPath, entry.name)).split(nodePath.sep).join(PATH_SEPARATOR))
    .toSorted();
}

function toIsoTime(moment) {
  return `${moment.slice(0, -EXTRA_TIME_DIGITS)}Z`;
}

// What every run is refused with while the row of BROKEN is dirty; "upSql" is the text of its up file then.
function describeDirty(upSql) {
  return `❌ Migration failed: ${describeDirtyRefusal({ id: '0004_broken', version: 4, checksum: sha256(upSql) })}`;
}

// A file that stops after its first statement until the gate opens: a run caught in the middle of a file,
// with the table of that file created and its row marked.
function createHeldFiles(gate) {
  return { '0002_held.up.sql': `CREATE TABLE held (id INT PRIMARY KEY);\n${gate.statement};\n` };
}

// The sessions whose database is the one of this file: those of its pools and, while it runs, of the script.
async function listSessionIds() {
  const rows = await testDb.readRows('SELECT id FROM information_schema.processlist WHERE db = :database', { database: testDb.name });

  return rows.map((row) => row.id);
}

// Resolves once that database has no session beside the "known" ones: what a run has opened is closed. A session
// the script forgot would keep its process from exiting.
function waitForSessionsToLeave(known) {
  return waitFor(
    async () => (await listSessionIds()).every((id) => known.includes(id)),
    'the sessions the script has opened to leave the server',
  );
}

describe('migrate: the cycle of a migration', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('makes the files of a migration, then applies, shows and rolls back what was written into them', async (t) => {
    const directory = await createMigrationDir(t);
    const made = await migrate(['--direction=make', '--names=users'], { directory });

    assert.equal(made.code, 0);
    assert.deepEqual(made.lines.map((line) => line.replace(DIRECTORY_REGEXP, '')), [
      '✅ Migration created: 0001_users.up.sql',
      '✅ Migration created: 0001_users.down.sql',
    ]);

    await writeMigrationFiles(directory, USERS);

    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0001_users.up.sql',
        '✅ Migration finished: 0001_users.up.sql (N ms)',
        '🎉 Migration succeeded: 1 up migration done',
      ],
    });
    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [target('Migration'), '✅ 0001_users: applied, batch 1, <time>, N ms'],
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);

    assert.deepEqual(await migrate(['--direction=down'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0001_users.down.sql',
        '✅ Migration finished: 0001_users.down.sql (N ms)',
        '🎉 Migration succeeded: 1 down migration done',
      ],
    });
    assert.deepEqual(await migrate(['--direction=status'], { directory }), { code: 0, lines: [target('Migration'), '⏳ 0001_users: pending'] });
    assert.deepEqual(await listTableNames(testDb), ['_migrations']);
  });

  test('refuses to make a file under a name that does not fit, is given twice or is taken, in one line that names it, and makes none of the files it was asked for', async (t) => {
    const files = { ...USERS, ...SEEDS };
    const directory = await createMigrationDir(t, files);

    assert.deepEqual(await migrate(['--direction=make', '--names=sessions,add-users'], { directory }), {
      code: 1,
      lines: ['❌ Migration failed: "add-users" is not a name of a migration: a name is 1 to 100 lowercase letters, digits and underscores, such as add_users'],
    });
    assert.deepEqual(await migrate(['--direction=make', '--names=sessions,teams', '--names=sessions'], { directory }), {
      code: 1,
      lines: ['❌ Migration failed: The name "sessions" is given twice: --names tells migrations apart by it'],
    });
    assert.deepEqual(await migrate(['--direction=make', '--type=seed', '--names=third_user,first_user'], { directory }), {
      code: 1,
      lines: ['❌ Seed failed: A seed named "first_user" exists already: --names tells seeds apart by it'],
    });
    assert.deepEqual(await listFiles(directory), Object.keys(files).toSorted());
  });

  test('refuses the files "make" has created until something is written into them, and applies nothing', async (t) => {
    const directory = await createMigrationDir(t, USERS);

    await migrate(['--direction=make', '--names=sessions'], { directory });

    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [target('Migration'), '⏳ 0001_users: pending', '⏳ 0002_sessions: pending'],
    });
    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 1,
      lines: [target('Migration'), '❌ Migration failed: 0002_sessions.up.sql is empty: write its statements, or a comment if there is nothing to do'],
    });
    assert.deepEqual(await listTableNames(testDb), []);
  });

  test('names on a dry run what "up" would apply and what "down" would roll back, and does neither', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });

    assert.deepEqual(await migrate(['--direction=up', '--dry-run'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration would run: 0001_users.up.sql',
        '⏳ Migration would run: 0002_sessions.up.sql',
        '🎉 Migration dry run: 2 up migrations would run',
      ],
    });
    assert.deepEqual(await listTableNames(testDb), []);

    await migrate(['--direction=up'], { directory });

    assert.deepEqual(await migrate(['--direction=down', '--dry-run'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration would run: 0002_sessions.down.sql',
        '⏳ Migration would run: 0001_users.down.sql',
        '🎉 Migration dry run: 2 down migrations would run',
      ],
    });
    assert.deepEqual(await migrate(['--direction=down', '--names=users', '--dry-run'], { directory }), {
      code: 0,
      lines: [target('Migration'), '⏳ Migration would run: 0001_users.down.sql', '🎉 Migration dry run: 1 down migration would run'],
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'sessions', 'users']);
  });

  test('applies the named migrations only, without the excluded ones, and leaves the rest pending', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS, ...TEAMS });

    assert.deepEqual(await migrate(['--direction=up', '--names=teams,users', '--names-exclude=users'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0003_teams.up.sql',
        '✅ Migration finished: 0003_teams.up.sql (N ms)',
        '🎉 Migration succeeded: 1 up migration done',
      ],
    });
    assert.deepEqual(await migrate(['--direction=up', '--names-exclude', 'sessions'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0001_users.up.sql',
        '✅ Migration finished: 0001_users.up.sql (N ms)',
        '🎉 Migration succeeded: 1 up migration done',
      ],
    });
    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '✅ 0001_users: applied, batch 2, <time>, N ms',
        '⏳ 0002_sessions: pending',
        '✅ 0003_teams: applied, batch 1, <time>, N ms',
      ],
    });
  });

  test('rolls back the named migrations whatever batch applied them, and the last batch without the excluded ones', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS, ...TEAMS });

    await migrate(['--direction=up', '--names=sessions'], { directory });
    await migrate(['--direction=up'], { directory });

    assert.deepEqual(await migrate(['--direction=down', '--names=sessions'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0002_sessions.down.sql',
        '✅ Migration finished: 0002_sessions.down.sql (N ms)',
        '🎉 Migration succeeded: 1 down migration done',
      ],
    });
    assert.deepEqual(await migrate(['--direction=down', '--names-exclude=users'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0003_teams.down.sql',
        '✅ Migration finished: 0003_teams.down.sql (N ms)',
        '🎉 Migration succeeded: 1 down migration done',
      ],
    });
    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '✅ 0001_users: applied, batch 2, <time>, N ms',
        '⏳ 0002_sessions: pending',
        '⏳ 0003_teams: pending',
      ],
    });
  });

  test('rolls back the named migrations in the reverse of the order they were applied in, not of their numbers: a lower number may have been applied after a higher one', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS, ...TEAMS });

    await migrate(['--direction=up', '--names=sessions'], { directory });
    await migrate(['--direction=up'], { directory });

    assert.deepEqual(await migrate(['--direction=down', '--names=users,sessions,teams'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0003_teams.down.sql',
        '✅ Migration finished: 0003_teams.down.sql (N ms)',
        '⏳ Migration started: 0001_users.down.sql',
        '✅ Migration finished: 0001_users.down.sql (N ms)',
        '⏳ Migration started: 0002_sessions.down.sql',
        '✅ Migration finished: 0002_sessions.down.sql (N ms)',
        '🎉 Migration succeeded: 3 down migrations done',
      ],
    });
  });

  test('says "cancelled: nothing to do" when there is nothing to apply or to roll back, a dry run included, and writes nothing then', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const cancelled = { code: 0, lines: [target('Migration'), '⚠️ Migration cancelled: nothing to do'] };

    assert.deepEqual(await migrate(['--direction=down'], { directory }), cancelled);
    assert.deepEqual(await migrate(['--direction=down', '--dry-run'], { directory }), cancelled);
    assert.deepEqual(await migrate(['--direction=up', '--names-exclude=users'], { directory }), cancelled);
    assert.deepEqual(await listTableNames(testDb), []);

    await migrate(['--direction=up'], { directory });

    assert.deepEqual(await migrate(['--direction=up'], { directory }), cancelled);
    assert.deepEqual(await migrate(['--direction=up', '--dry-run'], { directory }), cancelled);
    assert.deepEqual(await migrate(['--direction=up', '--names=users'], { directory }), cancelled);
  });

  test('refuses a name no migration has, in one line and before it applies or rolls back anything', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });

    assert.deepEqual(await migrate(['--direction=up', '--names=users,usres'], { directory }), {
      code: 1,
      lines: [target('Migration'), `❌ Migration failed: No migration is named "usres": ${UNKNOWN_NAME_HINT}`],
    });
    assert.deepEqual(await listTableNames(testDb), []);

    await migrate(['--direction=up'], { directory });

    assert.deepEqual(await migrate(['--direction=down', '--names-exclude=0002_sessions'], { directory }), {
      code: 1,
      lines: [target('Migration'), `❌ Migration failed: No migration is named "0002_sessions": ${UNKNOWN_NAME_HINT}`],
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'sessions', 'users']);
  });
});

describe('migrate: seeds', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('calls a seed a seed in every line of a run: where it goes, what it would run, what it ran, how many and what is applied', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SEEDS });

    await migrate(['--direction=up'], { directory });

    assert.deepEqual(await migrate(['--direction=up', '--type=seed', '--dry-run'], { directory }), {
      code: 0,
      lines: [
        target('Seed'),
        '⏳ Seed would run: 0001_first_user.up.sql',
        '⏳ Seed would run: 0002_second_user.up.sql',
        '🎉 Seed dry run: 2 up seeds would run',
      ],
    });
    assert.deepEqual(await migrate(['--direction=up', '--type=seed', '--names=first_user'], { directory }), {
      code: 0,
      lines: [
        target('Seed'),
        '⏳ Seed started: 0001_first_user.up.sql',
        '✅ Seed finished: 0001_first_user.up.sql (N ms)',
        '🎉 Seed succeeded: 1 up seed done',
      ],
    });
    assert.deepEqual(await migrate(['--direction=status', '--type=seed'], { directory }), {
      code: 0,
      lines: [target('Seed'), '✅ 0001_first_user: applied, batch 2, <time>, N ms', '⏳ 0002_second_user: pending'],
    });
    assert.deepEqual(await migrate(['--direction=down', '--type=seed'], { directory }), {
      code: 0,
      lines: [
        target('Seed'),
        '⏳ Seed started: 0001_first_user.down.sql',
        '✅ Seed finished: 0001_first_user.down.sql (N ms)',
        '🎉 Seed succeeded: 1 down seed done',
      ],
    });
    assert.deepEqual(await migrate(['--direction=down', '--type=seed'], { directory }), { code: 0, lines: [target('Seed'), '⚠️ Seed cancelled: nothing to do'] });
  });

  test('calls a seed a seed in what goes wrong too: a name no seed has, a file that fails, a seed the build does not know', async (t) => {
    const directory = await createMigrationDir(t, {
      ...USERS,
      ...SEEDS,
      'seed/0002_second_user.up.sql': `${SEEDS['seed/0002_second_user.up.sql']}${SEEDS['seed/0001_first_user.up.sql']}`,
    });

    await migrate(['--direction=up'], { directory });

    assert.deepEqual(await migrate(['--direction=up', '--type=seed', '--names=users'], { directory }), {
      code: 1,
      lines: [target('Seed'), `❌ Seed failed: No seed is named "users": ${UNKNOWN_NAME_HINT}`],
    });
    assert.deepEqual(await migrate(['--direction=up', '--type=seed'], { directory }), {
      code: 1,
      lines: [
        target('Seed'),
        '⏳ Seed started: 0001_first_user.up.sql',
        '✅ Seed finished: 0001_first_user.up.sql (N ms)',
        '⏳ Seed started: 0002_second_user.up.sql',
        "❌ Seed failed: 0002_second_user.up.sql: statement 2 failed: Duplicate entry '***' for key 'PRIMARY'; nothing of the file was applied",
      ],
    });

    await writeMigrationFiles(directory, SEEDS);
    await removeMigrationFiles(directory, ['seed/0001_first_user.up.sql', 'seed/0001_first_user.down.sql']);

    assert.deepEqual(await migrate(['--direction=up', '--type=seed'], { directory }), {
      code: 0,
      lines: [
        target('Seed'),
        '⏳ Seed started: 0002_second_user.up.sql',
        '✅ Seed finished: 0002_second_user.up.sql (N ms)',
        '⚠️ Seed ahead: the database holds 1 seed this build does not know: 0001_first_user',
        '🎉 Seed succeeded: 1 up seed done',
      ],
    });
  });
});

describe('migrate: a file that fails', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('ends with the code 1 and the place of the failure in its last line, shows the migration as dirty and refuses the next run', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...BROKEN, ...LATER });
    const refusal = { code: 1, lines: [target('Migration'), describeDirty(BROKEN['0004_broken.up.sql'])] };

    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 1,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0001_users.up.sql',
        '✅ Migration finished: 0001_users.up.sql (N ms)',
        '⏳ Migration started: 0004_broken.up.sql',
        "❌ Migration failed: 0004_broken.up.sql: statement 2 failed: Table 'halves' already exists; the migration is left dirty",
      ],
    });
    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '✅ 0001_users: applied, batch 1, <time>, N ms',
        '❌ 0004_broken: dirty, its run failed or was cut short, batch 1, <time>',
        '⏳ 0005_later: pending',
      ],
    });
    assert.deepEqual(await migrate(['--direction=up'], { directory }), refusal);
    assert.deepEqual(await migrate(['--direction=up', '--dry-run'], { directory }), refusal);
    assert.deepEqual(await migrate(['--direction=down'], { directory }), refusal);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'halves', 'users']);
  });

  test('applies a dirty migration again once its row is deleted with the statement the refusal prints for a file that was undone by hand', async (t) => {
    const directory = await createMigrationDir(t, BROKEN);

    await migrate(['--direction=up'], { directory });

    const { lines } = await migrate(['--direction=up'], { directory });
    const [forgetRow] = readStatementsByHand(lines.at(-1));

    await testDb.readRows('DROP TABLE halves');
    await writeMigrationFiles(directory, REPAIRED);
    await testDb.readRows(forgetRow);

    assert.deepEqual(await migrate(['--direction=status'], { directory }), { code: 0, lines: [target('Migration'), '⏳ 0004_broken: pending'] });
    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0004_broken.up.sql',
        '✅ Migration finished: 0004_broken.up.sql (N ms)',
        '🎉 Migration succeeded: 1 up migration done',
      ],
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'halves', 'wholes']);
  });

  test('shows a dirty migration as applied, and goes on with the next one, once its row is updated with the statement the refusal prints for a file that was finished by hand: the refusal says that the statement records the file as it was rewritten', async (t) => {
    const directory = await createMigrationDir(t, { ...BROKEN, ...LATER });

    await migrate(['--direction=up'], { directory });
    await testDb.readRows('CREATE TABLE wholes (id INT PRIMARY KEY)');
    await writeMigrationFiles(directory, REPAIRED);

    const { lines } = await migrate(['--direction=up'], { directory });
    const [, recordWhole] = readStatementsByHand(lines.at(-1));

    assert.equal(lines.at(-1), `${describeDirty(REPAIRED['0004_broken.up.sql'])}${MIGRATION_TEXT.REWRITTEN_NOTE}`);
    await testDb.readRows(recordWhole);

    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [target('Migration'), '✅ 0004_broken: applied, batch 1, <time>', '⏳ 0005_later: pending'],
    });
    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0005_later.up.sql',
        '✅ Migration finished: 0005_later.up.sql (N ms)',
        '🎉 Migration succeeded: 1 up migration done',
      ],
    });
  });

  test('refuses a file the lexer cannot read before any file runs, and in one line though the piece of the file it quotes holds a line break', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...DUMPED });

    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 1,
      lines: [
        target('Migration'),
        '❌ Migration failed: 0002_notes.up.sql cannot be read as SQL, and what cannot be read is not sent: SQL has an unsupported executable comment at position 0: /*!40101 SET NAMES utf8mb4 */; CREATE TABLE notes (id INT P…',
      ],
    });

    await writeMigrationFiles(directory, UNCLOSED);

    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 1,
      lines: [
        target('Migration'),
        "❌ Migration failed: 0002_notes.up.sql cannot be read as SQL, and what cannot be read is not sent: SQL has an unclosed ' at position 100: 'never closed); INSERT INTO notes (id, body) VALUES (2, NUL…",
      ],
    });
    assert.deepEqual(await listTableNames(testDb), []);
  });

  test('tells a syntax error of the server in one line, with the file and the statement, though the piece of the statement the server quotes spans several', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...MISSPELLED });

    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 1,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0001_users.up.sql',
        '✅ Migration finished: 0001_users.up.sql (N ms)',
        '⏳ Migration started: 0002_drafts.up.sql',
        "❌ Migration failed: 0002_drafts.up.sql: statement 2 failed: You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near 'NUL, draft_id INT NOT NULL )' at line 3; the migration is left dirty",
      ],
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'drafts', 'users']);
  });

  test('leaves no session on the server after a run that failed on a file, was refused or could not build its reference: the pool the script has opened is closed', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...BROKEN });
    const before = await listSessionIds();
    const results = await mapSeries(['up', 'down', 'verify'], (direction) => migrate([`--direction=${direction}`], { directory }));

    assert.deepEqual(results.map((result) => result.code), [1, 1, 1]);
    await waitForSessionsToLeave(before);
  });
});

describe('migrate: status', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('shows every migration of the build and of the database with the mark and the words of its state', async (t) => {
    const directory = await createMigrationDir(t, {
      ...USERS, ...SESSIONS, ...TEAMS, ...BROKEN, ...LATER,
    });

    await migrate(['--direction=up'], { directory });
    await writeMigrationFiles(directory, { '0002_sessions.up.sql': '-- rewritten\n' });
    await removeMigrationFiles(directory, Object.keys(TEAMS));

    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '✅ 0001_users: applied, batch 1, <time>, N ms',
        '⚠️ 0002_sessions: changed after it was applied, batch 1, <time>, N ms',
        '⚠️ 0003_teams: applied, not known to this build, batch 1, <time>, N ms',
        '❌ 0004_broken: dirty, its run failed or was cut short, batch 1, <time>',
        '⏳ 0005_later: pending',
      ],
    });
  });

  test('prints the batch of an applied migration, the moment it ended in UTC and the time it took, as its row holds them', async (t) => {
    const directory = await createMigrationDir(t, USERS);

    await migrate(['--direction=up'], { directory });
    await writeMigrationFiles(directory, SESSIONS);
    await migrate(['--direction=up'], { directory });

    const [users, sessions] = await testDb.readRows(`
      SELECT duration_ms AS durationMs, DATE_FORMAT(applied_at, '%Y-%m-%dT%H:%i:%s.%f') AS moment,
        TIMESTAMPDIFF(SECOND, applied_at, UTC_TIMESTAMP(3)) AS age
      FROM _migrations
      ORDER BY version
    `);
    const { lines } = await migrate(['--direction=status'], { directory, isExact: true });

    assert.deepEqual(lines, [
      target('Migration'),
      `✅ 0001_users: applied, batch 1, ${toIsoTime(users.moment)}, ${users.durationMs} ms`,
      `✅ 0002_sessions: applied, batch 2, ${toIsoTime(sessions.moment)}, ${sessions.durationMs} ms`,
    ]);
    assert.ok(users.age >= 0 && users.age <= RECENT_SECONDS);
  });

  test('shows the file a migrator is running at this moment as running, not as dirty, and does not wait for that migrator', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, createHeldFiles(gate));
    const running = migrate(['--direction=up'], { directory });

    t.after(() => running);
    await findSessionId(testDb, gate.name);

    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [target('Migration'), '⏳ 0002_held: running now, batch 1, <time>'],
    });

    await gate.open();

    assert.deepEqual(await running, {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0002_held.up.sql',
        '✅ Migration finished: 0002_held.up.sql (N ms)',
        '🎉 Migration succeeded: 1 up migration done',
      ],
    });
  });

  test('says "nothing to show" for a folder and a database that hold nothing, and creates nothing there', async (t) => {
    const directory = await createMigrationDir(t);

    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [target('Migration'), '⚠️ Migration status: nothing to show'],
    });
    assert.deepEqual(await migrate(['--direction=status', '--type=seed'], { directory }), {
      code: 0,
      lines: [target('Seed'), '⚠️ Seed status: nothing to show'],
    });
    assert.deepEqual(await listTableNames(testDb), []);
  });
});

describe('migrate: another build and another migrator', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('warns of a database that is ahead of the build, names what the build does not know and applies what it has', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });
    const ahead = '⚠️ Migration ahead: the database holds 2 migrations this build does not know: 0001_users, 0002_sessions';

    await migrate(['--direction=up'], { directory });
    await removeMigrationFiles(directory, [...Object.keys(USERS), ...Object.keys(SESSIONS)]);
    await writeMigrationFiles(directory, TEAMS);

    assert.deepEqual(await migrate(['--direction=up', '--dry-run'], { directory }), {
      code: 0,
      lines: [target('Migration'), ahead, '⏳ Migration would run: 0003_teams.up.sql', '🎉 Migration dry run: 1 up migration would run'],
    });
    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0003_teams.up.sql',
        '✅ Migration finished: 0003_teams.up.sql (N ms)',
        ahead,
        '🎉 Migration succeeded: 1 up migration done',
      ],
    });
    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 0,
      lines: [target('Migration'), ahead, '⚠️ Migration cancelled: nothing to do'],
    });
  });

  test('shows a file that took the number of an applied migration beside the row it is not, and refuses every run until the file has a number of its own', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const refusal = 'failed: Version 1 is applied to this database as the migration 0001_users, and this build has 0001_accounts under it: two migrations took one number, or the file was renamed after it was applied. Give another number to the one that is not applied, or give the file its name back';

    await migrate(['--direction=up'], { directory });
    await removeMigrationFiles(directory, Object.keys(USERS));
    await writeMigrationFiles(directory, ACCOUNTS);

    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ 0001_accounts: pending',
        '⚠️ 0001_users: applied, not known to this build, batch 1, <time>, N ms',
      ],
    });
    assert.deepEqual(await migrate(['--direction=up'], { directory }), { code: 1, lines: [target('Migration'), `❌ Migration ${refusal}`] });
    assert.deepEqual(await migrate(['--direction=down'], { directory }), { code: 1, lines: [target('Migration'), `❌ Migration ${refusal}`] });
    assert.deepEqual(await migrate(['--direction=verify'], { directory }), { code: 1, lines: [target('Verify'), `❌ Verify ${refusal}`] });

    await removeMigrationFiles(directory, Object.keys(ACCOUNTS));
    await writeMigrationFiles(directory, RENUMBERED_ACCOUNTS);

    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0002_accounts.up.sql',
        '✅ Migration finished: 0002_accounts.up.sql (N ms)',
        '⚠️ Migration ahead: the database holds 1 migration this build does not know: 0001_users',
        '🎉 Migration succeeded: 1 up migration done',
      ],
    });
  });

  test('says that it waits while another migrator holds the lock of the database, and goes on once the lock is free', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const holder = await connectAdmin();
    const lock = `${LOCK_PREFIX}${testDb.name}`;
    const waiting = '⏳ Migration waiting: another migrator holds the lock of the database';
    const lines = [];

    t.after(() => holder.end());
    await holder.query('SELECT GET_LOCK(?, 0)', [lock]);

    const running = migrate(['--direction=up'], { directory, lines });

    t.after(() => running);
    await waitFor(() => lines.includes(waiting), 'the line about the wait');

    assert.deepEqual(await migrate(['--direction=status'], { directory }), { code: 0, lines: [target('Migration'), '⏳ 0001_users: pending'] });
    await holder.query('SELECT RELEASE_LOCK(?)', [lock]);

    assert.deepEqual(await running, {
      code: 0,
      lines: [
        target('Migration'),
        waiting,
        '⏳ Migration started: 0001_users.up.sql',
        '✅ Migration finished: 0001_users.up.sql (N ms)',
        '🎉 Migration succeeded: 1 up migration done',
      ],
    });
  });

  test('refuses to roll back while another migrator holds the lock, instead of waiting, and names the connection whose KILL frees it', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const holder = await connectAdmin();

    t.after(() => holder.end());
    await migrate(['--direction=up'], { directory });

    const [[{ id }]] = await holder.query('SELECT CONNECTION_ID() AS id, GET_LOCK(?, 0)', [`${LOCK_PREFIX}${testDb.name}`]);
    const refused = await migrate(['--direction=down'], { directory });

    assert.deepEqual(refused, {
      code: 1,
      lines: [
        target('Migration'),
        `❌ Migration failed: Another migrator is at work on the database "${testDb.name}", on connection ${id}: its row in information_schema.processlist tells what it is doing, and KILL ${id} frees the lock if that migrator is gone. A rollback does not wait for it: what there is to roll back changes with what that one does. Look at the status when it has finished, then run the rollback again`,
      ],
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);

    await testDb.readRows(readKillStatement(refused.lines.at(-1)));

    assert.equal(await countSessionsLeft(testDb, [id]), 0);
    assert.deepEqual(await migrate(['--direction=down'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0001_users.down.sql',
        '✅ Migration finished: 0001_users.down.sql (N ms)',
        '🎉 Migration succeeded: 1 down migration done',
      ],
    });
  });

  test('ends with the code 0 and tells of every file when the connection that held its lock was lost while the last file ran: that file is recorded through a connection of its own, and no session is left on the server', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...USERS, ...createHeldFiles(gate) });
    const before = await listSessionIds();
    const running = migrate(['--direction=up'], { directory });

    t.after(() => running);
    await findSessionId(testDb, gate.name);
    await loseMigratorLock(testDb);
    await gate.open();

    assert.deepEqual(await running, {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0001_users.up.sql',
        '✅ Migration finished: 0001_users.up.sql (N ms)',
        '⏳ Migration started: 0002_held.up.sql',
        '✅ Migration finished: 0002_held.up.sql (N ms)',
        '🎉 Migration succeeded: 2 up migrations done',
      ],
    });
    assert.deepEqual(await migrate(['--direction=status'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '✅ 0001_users: applied, batch 1, <time>, N ms',
        '✅ 0002_held: applied, batch 1, <time>, N ms',
      ],
    });
    await waitForSessionsToLeave(before);
  });

  test('ends with the code 1 when the connection that held its lock was lost while a file before the last ran: the file is recorded, nothing after it runs, and the next run goes on from there', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, { ...createHeldFiles(gate), ...LATER });
    const running = migrate(['--direction=up'], { directory });

    t.after(() => running);
    await findSessionId(testDb, gate.name);
    await loseMigratorLock(testDb);
    await gate.open();

    assert.deepEqual(await running, {
      code: 1,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0002_held.up.sql',
        '❌ Migration failed: 0002_held.up.sql has run to its end and is recorded, but the connection that held the lock was lost while it ran: nothing after it was run. Run the command again',
      ],
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'held']);
    assert.deepEqual(await migrate(['--direction=up'], { directory }), {
      code: 0,
      lines: [
        target('Migration'),
        '⏳ Migration started: 0005_later.up.sql',
        '✅ Migration finished: 0005_later.up.sql (N ms)',
        '🎉 Migration succeeded: 1 up migration done',
      ],
    });
  });
});

describe('migrate: verify', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('ends with the code 0 when the database matches its migrations, and with 1 and a line for every difference after a change by hand', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });
    const built = [
      target('Verify'),
      '⏳ Verify started: 0001_users.up.sql',
      '✅ Verify finished: 0001_users.up.sql (N ms)',
      '⏳ Verify started: 0002_sessions.up.sql',
      '✅ Verify finished: 0002_sessions.up.sql (N ms)',
    ];

    await migrate(['--direction=up'], { directory });

    assert.deepEqual(await migrate(['--direction=verify'], { directory }), {
      code: 0,
      lines: [...built, `🎉 Verify succeeded: "${testDb.name}" matches its migrations (2 tables)`],
    });

    await testDb.readRows('ALTER TABLE users MODIFY email VARCHAR(200) NOT NULL, ADD KEY users_email (email)');

    assert.deepEqual(await migrate(['--direction=verify'], { directory }), {
      code: 1,
      lines: [
        ...built,
        `❌ Verify failed: "${testDb.name}" differs from its migrations`,
        '   - column users.email: type is "varchar(200)" in the live database, "varchar(100)" by the migrations',
        '   - index users.users_email: exists in the live database, the migrations do not create it',
      ],
    });
    assert.deepEqual(await listReferenceNames(testDb), []);
  });

  test('notes the migrations that are not applied: they take no part in the comparison, and the code is still 0', async (t) => {
    const directory = await createMigrationDir(t, {
      ...USERS, ...SESSIONS, ...TEAMS, ...LATER,
    });

    await migrate(['--direction=up', '--names=users,sessions'], { directory });

    assert.deepEqual(await migrate(['--direction=verify'], { directory }), {
      code: 0,
      lines: [
        target('Verify'),
        '⏳ Verify started: 0001_users.up.sql',
        '✅ Verify finished: 0001_users.up.sql (N ms)',
        '⏳ Verify started: 0002_sessions.up.sql',
        '✅ Verify finished: 0002_sessions.up.sql (N ms)',
        '⚠️ Verify note: not applied, and so not compared: 0003_teams, 0005_later',
        `🎉 Verify succeeded: "${testDb.name}" matches its migrations (2 tables)`,
      ],
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'sessions', 'users']);
  });

  test('says "(1 table)", in the singular, for a database of one table', async (t) => {
    const directory = await createMigrationDir(t, USERS);

    await migrate(['--direction=up'], { directory });

    assert.deepEqual(await migrate(['--direction=verify'], { directory }), {
      code: 0,
      lines: [
        target('Verify'),
        '⏳ Verify started: 0001_users.up.sql',
        '✅ Verify finished: 0001_users.up.sql (N ms)',
        `🎉 Verify succeeded: "${testDb.name}" matches its migrations (1 table)`,
      ],
    });
  });
});

describe('migrate: fresh', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('refuses "fresh" unless APP_MODE=dev, a dry run included, and touches nothing', async (t) => {
    const directory = await createMigrationDir(t, USERS);
    const refusal = {
      code: 1,
      lines: [
        target('Fresh'),
        `❌ Fresh failed: "fresh" drops the database "${testDb.name}" with everything in it: it runs only when APP_MODE=dev`,
      ],
    };

    await migrate(['--direction=up'], { directory });
    await testDb.readRows('CREATE TABLE precious (id INT PRIMARY KEY)');

    assert.deepEqual(await migrate(['--direction=fresh'], { directory }), refusal);
    assert.deepEqual(await migrate(['--direction=fresh', '--dry-run'], { directory }), refusal);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'precious', 'users']);
  });

  test('names on a dry run in dev mode what it would drop and every migration it would apply, the applied ones too, and drops nothing', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS });
    const dev = testDb.open({ env: DEV }, t);

    await migrate(['--direction=up', '--names=users'], { directory });
    await testDb.readRows('CREATE TABLE precious (id INT PRIMARY KEY)');

    assert.deepEqual(await migrate(['--direction=fresh', '--dry-run'], { directory, pool: dev }), {
      code: 0,
      lines: [
        target('Fresh', DEV),
        `⏳ Fresh would drop: the database "${testDb.name}" with everything in it`,
        '⏳ Fresh would run: 0001_users.up.sql',
        '⏳ Fresh would run: 0002_sessions.up.sql',
        '🎉 Fresh dry run: the database would be dropped and 2 up migrations would run',
      ],
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'precious', 'users']);
  });

  test('drops the database in dev mode and migrates anew, telling of the drop and of every file, and leaves the seeds to "up"', async (t) => {
    const directory = await createMigrationDir(t, { ...USERS, ...SESSIONS, ...SEEDS });
    const dev = testDb.open({ env: DEV }, t);

    await migrate(['--direction=up', '--names=users'], { directory });
    await testDb.readRows('CREATE TABLE leftovers (id INT PRIMARY KEY)');

    assert.deepEqual(await migrate(['--direction=fresh'], { directory, pool: dev }), {
      code: 0,
      lines: [
        target('Fresh', DEV),
        `⏳ Fresh started: DROP DATABASE \`${testDb.name}\``,
        `✅ Fresh finished: DROP DATABASE \`${testDb.name}\` (N ms)`,
        '⏳ Fresh started: 0001_users.up.sql',
        '✅ Fresh finished: 0001_users.up.sql (N ms)',
        '⏳ Fresh started: 0002_sessions.up.sql',
        '✅ Fresh finished: 0002_sessions.up.sql (N ms)',
        `🎉 Fresh succeeded: the database "${testDb.name}" was dropped and 2 up migrations done; seeds are applied apart`,
      ],
    });
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'sessions', 'users']);
    assert.deepEqual(await migrate(['--direction=status', '--type=seed'], { directory }), {
      code: 0,
      lines: [target('Seed'), '⏳ 0001_first_user: pending', '⏳ 0002_second_user: pending'],
    });
  });
});

describe('migrate: as a process', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('exits by itself with the code 0 on an empty database with the migrations of the repository, which has none yet, and writes nothing into that database', async (t) => {
    const [status, up, verify, down] = await mapSeries(
      ['status', 'up', 'verify', 'down'],
      (direction) => migrateAsProcess(t, [`--direction=${direction}`]),
    );

    assert.deepEqual(status, { code: 0, lines: [target('Migration'), '⚠️ Migration status: nothing to show'], stderr: '' });
    assert.deepEqual(up, { code: 0, lines: [target('Migration'), '⚠️ Migration cancelled: nothing to do'], stderr: '' });
    assert.deepEqual(verify, {
      code: 0,
      lines: [target('Verify'), `🎉 Verify succeeded: "${testDb.name}" matches its migrations (0 tables)`],
      stderr: '',
    });
    assert.deepEqual(down, { code: 0, lines: [target('Migration'), '⚠️ Migration cancelled: nothing to do'], stderr: '' });
    assert.deepEqual(await listTableNames(testDb), []);
  });

  test('exits with the code 1 and one line for a wrong argument, before it goes anywhere', async (t) => {
    const [noDirection, noNames, wrongName] = await Promise.all([
      migrateAsProcess(t, []),
      migrateAsProcess(t, ['--direction=up', '--names', '--dry-run']),
      migrateAsProcess(t, ['--direction=make', '--names=add-users', '--dry-run']),
    ]);

    assert.deepEqual(noDirection, {
      code: 1,
      lines: ['❌ Migration failed: --direction is required: one of up, down, status, make, verify, fresh'],
      stderr: '',
    });
    assert.deepEqual(noNames, { code: 1, lines: ["❌ Migration failed: Option '--names' argument is ambiguous."], stderr: '' });
    assert.deepEqual(wrongName, {
      code: 1,
      lines: ['❌ Migration failed: "add-users" is not a name of a migration: a name is 1 to 100 lowercase letters, digits and underscores, such as add_users'],
      stderr: '',
    });
  });

  test('exits with the code 1 and the reason in its last line: "fresh" outside dev mode, a server that is down, a database the server does not have', async (t) => {
    const down = await createDownEnv();
    const missing = { APP_DATABASE_NAME: createDatabaseName() };
    const [fresh, unreachable, unknown] = await Promise.all([
      migrateAsProcess(t, ['--direction=fresh']),
      migrateAsProcess(t, ['--direction=up'], { env: down }),
      migrateAsProcess(t, ['--direction=up'], { env: missing }),
    ]);

    assert.deepEqual(fresh, {
      code: 1,
      lines: [
        target('Fresh'),
        `❌ Fresh failed: "fresh" drops the database "${testDb.name}" with everything in it: it runs only when APP_MODE=dev`,
      ],
      stderr: '',
    });
    assert.deepEqual(unreachable, {
      code: 1,
      lines: [target('Migration', down), `❌ Migration failed: connect ECONNREFUSED ${down.APP_DATABASE_HOST}:${down.APP_DATABASE_PORT}`],
      stderr: '',
    });
    assert.deepEqual(unknown, {
      code: 1,
      lines: [target('Migration', missing), `❌ Migration failed: Unknown database '${missing.APP_DATABASE_NAME}'`],
      stderr: '',
    });
  });

  test('drops the database and migrates anew in dev mode: with no migration in the repository yet, the database is left empty', async (t) => {
    await testDb.readRows('CREATE TABLE leftovers (id INT PRIMARY KEY)');

    assert.deepEqual(await migrateAsProcess(t, ['--direction=fresh'], { env: DEV }), {
      code: 0,
      lines: [
        target('Fresh', DEV),
        `⏳ Fresh started: DROP DATABASE \`${testDb.name}\``,
        `✅ Fresh finished: DROP DATABASE \`${testDb.name}\` (N ms)`,
        `🎉 Fresh succeeded: the database "${testDb.name}" was dropped and 0 up migrations done; seeds are applied apart`,
      ],
      stderr: '',
    });
    assert.deepEqual(await listTableNames(testDb), []);
  });

  test('refuses a flag that npm has swallowed, in one line and before it goes anywhere: nothing is rolled back', async (t) => {
    const directory = await createMigrationDir(t, USERS);

    await migrate(['--direction=up'], { directory });

    assert.deepEqual(await migrateAsProcess(t, ['--direction=down'], { systemEnv: { npm_config_dry_run: 'true' } }), {
      code: 1,
      lines: ['❌ Migration failed: --dry-run was given to npm, not to the script: put it after "--", as in "npm run <script> -- --dry-run"'],
      stderr: '',
    });
    assert.deepEqual(await readAppliedRows(testDb), [
      {
        type: 'migration', version: 1, name: 'users', batch: 1, is_dirty: false,
      },
    ]);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'users']);
  });
});
