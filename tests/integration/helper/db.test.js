import { isDatabaseAccessDenied, isLockWaitTimeout } from '#core/db/error.js';
import { migrateUp, verifyMigrations } from '#core/db/migrator.js';
import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import {
  ACCOUNT_HOST,
  connectAdmin,
  countSessionsLeft,
  createDatabaseName,
  createGate,
  createTestDb,
  DATABASE_PREFIX,
  dropStaleAccounts,
  dropStaleDatabases,
  findSessionId,
  killSession,
  toLikePattern,
  waitAtGate,
} from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import {
  createMigrationDir,
  listReferenceNames,
  listTableNames,
  readDirtyMarks,
} from '#root/tests/helper/migration.js';
import { createWorkDir, runNode } from '#root/tests/helper/process.js';
import { uuidv7 } from '#utils/id.js';
import { randomToken } from '#utils/random.js';
import assert from 'node:assert/strict';
import {
  after,
  beforeEach,
  describe,
  test,
} from 'node:test';

const LEAVE_APP_OPEN = 'tests/fixture/leave-app-open.js';

const LOOKALIKE_PREFIX = 'nfsxtestx';
const OWN_PREFIX = `${DATABASE_PREFIX}by_the_caller_`;
const UUID_NAME_PATTERN = '[0-9a-f]{8}_[0-9a-f]{4}_7[0-9a-f]{3}_[0-9a-f]{4}_[0-9a-f]{12}';
const TEST_NAME_REGEXP = new RegExp(`^${DATABASE_PREFIX}${UUID_NAME_PATTERN}$`);
const NAME_TAIL_LENGTH = 12;

const MS_IN_MINUTE = 60000;
const STALE_MINUTES = 61;
const YOUNG_MINUTES = 59;

const HEX_RADIX = 16;
const MOMENT_DIGITS = 12;
const MOMENT_HIGH_DIGITS = 8;
const MOMENT_LENGTH = MOMENT_DIGITS + 1;

const DATABASE_ACCESS_DENIED = 1044;
const TABLE_ACCESS_DENIED = 1142;
const USER_LIMIT_REACHED = 1226;
const QUERY_INTERRUPTED = 1317;
const ROW_IS_REFERENCED = 1451;

const ONE_CONNECTION_LIMIT = 'MAX_USER_CONNECTIONS 1';
const LIMIT_REACHED_REGEXP = /'max_user_connections' resource \(current value: 1\)/;

// What the list of sessions says of one that waits for a lock it has asked GET_LOCK() for.
const LOCK_WAIT_STATE = 'User lock';

// How long a session that only names a gate in its statement stays listed beside the one that waits at it.
const TALK_SECONDS = 2;
const ADD_NOTE_SQL = 'ALTER TABLE teams ADD COLUMN note INT NULL';

// A wait at a gate that tells how it ended. Cut by KILL as soon as the session is found: no test waits this
// long, the limit only ends a wait that was not cut.
const HELD_SQL = 'SELECT GET_LOCK(:name, :seconds) AS taken';
const HELD_SECONDS = 10;

const WHO_SQL = 'SELECT :id AS id, DATABASE() AS name';
const DEFAULTS_SQL = 'SELECT default_character_set_name AS charset, default_collation_name AS collation FROM information_schema.schemata WHERE schema_name = :name';
const BINARY_DEFAULTS = Object.freeze({ charset: 'utf8mb4', collation: 'utf8mb4_bin' });

const TEAMS_SQL = 'CREATE TABLE teams (id INT PRIMARY KEY) COLLATE=utf8mb4_bin;\n';
const MEMBERS_SQL = 'CREATE TABLE members (id INT PRIMARY KEY) COLLATE=utf8mb4_bin;\n';
const TEAMS = Object.freeze({ '0001_teams.up.sql': TEAMS_SQL });

const testDb = await createTestDb();

// Asked for without a test: it stays to the end of the file, where the hook below looks for it.
const fileNeighbour = testDb.skip
  ? null
  : await testDb.createNeighbour();

const LEFTOVER_ID = toNamePart(uuidv7());

async function listDatabases(names) {
  const rows = await testDb.runAsAdmin('SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name IN (?)', [names]);

  return rows.map((row) => row.name).toSorted();
}

async function listAccounts(names) {
  const rows = await testDb.runAsAdmin('SELECT user AS name FROM mysql.global_priv WHERE user IN (?)', [names]);

  return rows.map((row) => row.name).toSorted();
}

function readDefaults(name) {
  return testDb.readRows(DEFAULTS_SQL, { name });
}

// What a "verify" that failed leaves beside the database of the file: a name of its prefix and a UUIDv7.
function nameLeftover() {
  return `${testDb.config.db.migrationReferencePrefix}${LEFTOVER_ID}`;
}

// The hooks of a file run in the order they were made: this one, made after createTestDb(), finds the server
// as the hook of the helper has left it. The last test of the file leaves there what that hook is to drop.
after(async () => {
  if (testDb.skip) {
    return false;
  }

  const left = [nameLeftover(), fileNeighbour];

  try {
    assert.deepEqual(await listDatabases([testDb.name, ...left]), []);
  } finally {
    await Promise.allSettled(left.map((name) => testDb.runAsAdmin(`DROP DATABASE IF EXISTS \`${name}\``)));
  }
});

// One hook for the connection and for what is made through it: the hooks of a test run in the order they were
// made, and a connection that was ended first would leave the rest on the server.
async function openAdmin(t) {
  const connection = await connectAdmin();
  const drops = [];

  async function createDatabases(names) {
    drops.push(...names.map((name) => [`DROP DATABASE IF EXISTS \`${name}\``]));
    await Promise.all(names.map((name) => connection.query(`CREATE DATABASE \`${name}\``)));
  }

  async function createAccounts(names) {
    drops.push(...names.map((name) => ['DROP USER IF EXISTS ?@?', [name, ACCOUNT_HOST]]));
    await Promise.all(names.map((name) => connection.query('CREATE USER ?@? IDENTIFIED BY ?', [name, ACCOUNT_HOST, randomToken()])));
  }

  t.after(async () => {
    await Promise.allSettled(drops.map(([sql, values]) => connection.query(sql, values)));
    await connection.end();
  });

  return { connection, createDatabases, createAccounts };
}

// What an account of a test makes by itself goes with the test, whatever the test got to.
function dropDatabasesAfter(t, names) {
  t.after(() => Promise.allSettled(names.map((name) => testDb.runAsAdmin(`DROP DATABASE IF EXISTS \`${name}\``))));
}

// A promise a test has started is waited for before the test ends, also when the test fails before it got
// to wait for it itself: taken at once, so that a rejection is never one that nobody holds.
function settleBeforeEnd(t, promise) {
  const settled = Promise.allSettled([promise]);

  t.after(() => settled);

  return promise;
}

function toNamePart(id) {
  return id.replaceAll('-', '_');
}

// A UUIDv7 of this run only, with the moment of so many minutes ago in it: its first twelve digits, a dash
// after the eighth.
function createAgedId(minutes) {
  const moment = (Date.now() - minutes * MS_IN_MINUTE).toString(HEX_RADIX).padStart(MOMENT_DIGITS, '0');

  return `${moment.slice(0, MOMENT_HIGH_DIGITS)}-${moment.slice(MOMENT_HIGH_DIGITS)}${uuidv7().slice(MOMENT_LENGTH)}`;
}

function createAgedName(minutes) {
  return createDatabaseName(createAgedId(minutes));
}

// What "verify" leaves beside a test database when a pool of the tests runs it: a name of the tests that ends
// with the UUIDv7 of the reference. A name holds 64 characters, so of the database only its moment stands here.
function createAgedReferenceName(databaseMinutes, referenceMinutes) {
  const moment = createAgedId(databaseMinutes).slice(0, MOMENT_LENGTH);

  return createDatabaseName(`${moment}-${createAgedId(referenceMinutes)}`);
}

// A pool of one connection, closed with the test: every statement of it runs in one session.
function openWorker(t) {
  return testDb.open({ db: { connectionLimit: 1 } }, t);
}

async function readSessionId(pool) {
  const [{ id }] = await pool.readRows('SELECT CONNECTION_ID() AS id');

  return id;
}

// One more session of an account, ended with the test; without an account, a session of the administrator.
async function connectAs(t, account = {}) {
  const connection = await connectAdmin({ ...testDb.env, ...account });

  t.after(() => connection.end());

  return connection;
}

// The session that holds the lock of a gate: the one that keeps it closed, or null once the gate is open
// and no waiter is on its way through.
async function readGateHolder(gate) {
  const [{ holder }] = await testDb.readRows('SELECT IS_USED_LOCK(:name) AS holder', { name: gate.name });

  return holder;
}

// Every session whose statement carries the name of the gate, whatever it is doing.
async function listSessionsOf(gate) {
  const rows = await testDb.readRows(
    'SELECT id FROM information_schema.processlist WHERE info LIKE :pattern AND id <> CONNECTION_ID()',
    { pattern: `%${gate.name}%` },
  );

  return rows.map((row) => row.id);
}

async function listLockWaiters(ids) {
  const rows = await testDb.readRows(
    'SELECT id FROM information_schema.processlist WHERE id IN (:ids) AND state = :state ORDER BY id',
    { ids, state: LOCK_WAIT_STATE },
  );

  return rows.map((row) => row.id);
}

// findSessionId() finds a session by the text the server lists for it, and that is the rest of a file while
// the server reads its next statement: this resolves once every one of the sessions stands at its gate.
function waitForLockWaiters(ids) {
  return waitFor(async () => (await listLockWaiters(ids)).length === ids.length, 'the sessions to wait at their gate');
}

// Holds a session at a closed gate and tells whether a KILL has cut its wait: GET_LOCK() answers NULL then,
// not the 0 of a wait that has had its time. A KILL that finds the session on its way to the wait, or one
// that ends the session, fails the statement instead.
async function waitUntilCut(query, gate) {
  try {
    const [{ taken }] = await query(HELD_SQL, { name: gate.name, seconds: HELD_SECONDS });

    return taken === null;
  } catch (error) {
    if (error.errno === QUERY_INTERRUPTED || error.isFatal) {
      return true;
    }

    throw error;
  }
}

// A migration that stops between its two tables for as long as the gate is closed.
function createHeldMigration(gate) {
  return { '0001_held.up.sql': `${TEAMS_SQL}${gate.statement};\n${MEMBERS_SQL}` };
}

describe('createTestDb', { skip: testDb.skip }, () => {
  test('gives the file a database of its own, with a pool, a context and the env of a process that needs it', async () => {
    const { rows } = await testDb.run(() => testDb.db.query('SELECT DATABASE() AS name'));

    assert.equal(testDb.skip, false);
    assert.match(testDb.name, TEST_NAME_REGEXP);
    assert.deepEqual(rows, [{ name: testDb.name }]);
    assert.deepEqual(await listDatabases([testDb.name]), [testDb.name]);
    assert.equal(testDb.config.db.database, testDb.name);
    assert.equal(testDb.context.db, testDb.db);
    assert.equal(testDb.env.APP_DATABASE_NAME, testDb.name);
    assert.deepEqual(Object.keys(testDb.env).toSorted(), [
      'APP_DATABASE_HOST',
      'APP_DATABASE_NAME',
      'APP_DATABASE_PASSWORD',
      'APP_DATABASE_PORT',
      'APP_DATABASE_USER',
    ]);
  });

  test('creates the database in utf8mb4 with the binary collation by default', async () => {
    assert.deepEqual(await readDefaults(testDb.name), [BINARY_DEFAULTS]);
  });

  test('opens more pools on the same database, each with its own settings', async (t) => {
    const single = testDb.open({ db: { connectionLimit: 1 }, logger: { level: 'warn' } }, t);
    const { rows } = await single.run(() => single.db.query('SELECT DATABASE() AS name'));

    assert.deepEqual(rows, [{ name: testDb.name }]);
    assert.equal(single.config.db.connectionLimit, 1);
    assert.equal(single.config.logger.level, 'warn');
    assert.notEqual(single.db, testDb.db);
  });

  test('keeps every pool on the database of the file: a name the caller gives in the env is passed over', async (t) => {
    const pool = testDb.open({ env: { APP_DATABASE_NAME: createDatabaseName() } }, t);

    assert.equal(pool.config.db.database, testDb.name);
    assert.deepEqual(await pool.readRows('SELECT DATABASE() AS name'), [{ name: testDb.name }]);
  });

  test('reads the rows of a statement through a pool and in its context: the values are bound, and the line goes to the log of that pool alone', async (t) => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'info', stream: sink.stream } }, t);

    assert.deepEqual(await testDb.readRows(WHO_SQL, { id: 1 }), [{ id: 1, name: testDb.name }]);
    assert.deepEqual(await logged.readRows(WHO_SQL, { id: 2 }), [{ id: 2, name: testDb.name }]);
    assert.deepEqual(await logged.readRows('DO 1'), []);
    assert.deepEqual(sink.lines.map((line) => line.sql), [WHO_SQL, 'DO 1']);
  });

  test('closes a pool that was opened for a test when that test ends, and its session leaves the server; a pool opened without a test stays open', async (t) => {
    const opened = {};

    t.after(() => opened.forFile?.db.close());

    await t.test('inside the test', async (inner) => {
      opened.forTest = testDb.open({ db: { connectionLimit: 1 } }, inner);
      opened.forFile = testDb.open({ db: { connectionLimit: 1 } });
      opened.sessionId = await readSessionId(opened.forTest);

      assert.equal(await opened.forFile.db.ping(), true);
    });

    await assert.rejects(opened.forTest.db.ping(), /Pool is closed/);
    assert.equal(await countSessionsLeft(testDb, [opened.sessionId]), 0);
    assert.equal(await opened.forFile.db.ping(), true);
  });

  test('empties the database on request, and the pools that were open go on working in it', async (t) => {
    const second = testDb.open({ db: { connectionLimit: 1 } }, t);

    await testDb.run(() => testDb.db.query('CREATE TABLE leftovers (id INT PRIMARY KEY)'));
    await second.run(() => second.db.query('CREATE PROCEDURE leftover_routine() SELECT 1'));
    await testDb.reset();

    const { rows: tables } = await testDb.run(() => testDb.db.query(
      'SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = :name',
      { name: testDb.name },
    ));
    const { rows: routines } = await second.run(() => second.db.query(
      'SELECT COUNT(*) AS total FROM information_schema.routines WHERE routine_schema = :name',
      { name: testDb.name },
    ));
    const { rows: defaults } = await second.run(() => second.db.query('SELECT DATABASE() AS name, @@collation_database AS collation'));

    assert.deepEqual([tables[0].total, routines[0].total], [0, 0]);
    assert.deepEqual(defaults, [{ name: testDb.name, collation: 'utf8mb4_bin' }]);
    await testDb.run(() => testDb.db.query('CREATE TABLE leftovers (id INT PRIMARY KEY)'));
  });

  test('builds an app that works on the same database', async (t) => {
    const fastify = await testDb.buildApp();
    t.after(() => fastify.close());

    assert.equal(fastify.config.db.database, testDb.name);
    assert.match(await fastify.db.verify(), /MariaDB/);
  });

  // In a process of its own: a pool that is left open does not fail a test, it keeps the file from exiting,
  // and runNode() turns that into an error.
  test('ends the pool of an app a test has left open: the test file still exits by itself', async (t) => {
    const { code, stdout } = await runNode(LEAVE_APP_OPEN, { cwd: await createWorkDir(t), env: testDb.env });

    assert.equal(code, 0);
    assert.match(stdout, /^ℹ pass 1$/m);
  });
});

describe('createTestDb: the databases "verify" builds', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('gives every pool of the file one prefix for them: the prefix of the tests with the last twelve characters of the name of its database, which is not the prefix of a process, unless the caller gives its own', async (t) => {
    const fastify = await testDb.buildApp();
    t.after(() => fastify.close());

    const prefix = `${DATABASE_PREFIX}${testDb.name.slice(-NAME_TAIL_LENGTH)}_`;
    const pools = [testDb, testDb.open({}, t), testDb.open({ db: { connectionLimit: 1 } }, t), fastify];
    const own = testDb.open({ db: { migrationReferencePrefix: OWN_PREFIX } }, t);

    assert.deepEqual(pools.map((pool) => pool.config.db.migrationReferencePrefix), pools.map(() => prefix));
    assert.notEqual(prefix, createTestConfig().db.migrationReferencePrefix);
    assert.equal(own.config.db.migrationReferencePrefix, OWN_PREFIX);
  });

  test('lets "verify" run through a pool: what it builds is named by that prefix and a UUIDv7, so that a file tells its own from those of the files beside it, and is gone when the run ends', async (t) => {
    const directory = await createMigrationDir(t, TEAMS);
    const { migrationReferencePrefix: prefix } = testDb.config.db;
    const built = [];

    async function recordBuilt() {
      built.push(...await listReferenceNames(testDb));
    }

    await testDb.run(() => migrateUp({ directory }));

    const result = await testDb.run(() => verifyMigrations({ directory, onFileStart: recordBuilt }));

    assert.deepEqual(result, {
      database: testDb.name,
      tableCount: 1,
      differences: [],
      notes: [],
    });
    assert.equal(built.length, 1);
    assert.match(built[0], new RegExp(`^${prefix}${UUID_NAME_PATTERN}$`));
    assert.deepEqual(await listReferenceNames(testDb), []);
  });
});

describe('runAsAdmin', { skip: testDb.skip }, () => {
  test('runs one statement as the administrator of the server, in no database, and resolves with its rows: the values are bound, and no session is left behind', async () => {
    const [{ id, ...row }] = await testDb.runAsAdmin(
      'SELECT CONNECTION_ID() AS id, SUBSTRING_INDEX(CURRENT_USER(), ?, 1) AS user, DATABASE() AS name, ? AS number, ? AS text',
      ['@', 1, "it's bound"],
    );

    assert.deepEqual(row, {
      user: testDb.env.APP_DATABASE_USER,
      name: null,
      number: 1,
      text: "it's bound",
    });
    assert.equal(await countSessionsLeft(testDb, [id]), 0);
  });

  test('does what the account of a test may not do: it reads the accounts of the server, which an owner of the database of the file is refused', async (t) => {
    const account = await testDb.createOwner(t);
    const owner = testDb.open({ env: account }, t);
    const refusal = await rejectionOf(owner.readRows('SELECT COUNT(*) AS total FROM mysql.global_priv'));

    assert.equal(refusal.errno, TABLE_ACCESS_DENIED);
    assert.deepEqual(
      await testDb.runAsAdmin('SELECT COUNT(*) AS total FROM mysql.global_priv WHERE user = ? AND host = ?', [account.APP_DATABASE_USER, ACCOUNT_HOST]),
      [{ total: 1 }],
    );
  });
});

describe('createNeighbour', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('gives a test another database on the server: empty, in utf8mb4 with the binary collation, named as a database of the tests, and gone when the test ends', async (t) => {
    let neighbour;

    await t.test('inside the test', async (inner) => {
      neighbour = await testDb.createNeighbour(inner);

      assert.match(neighbour, TEST_NAME_REGEXP);
      assert.notEqual(neighbour, testDb.name);
      assert.deepEqual(await readDefaults(neighbour), [BINARY_DEFAULTS]);
      assert.deepEqual(
        await testDb.readRows('SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = :neighbour', { neighbour }),
        [{ total: 0 }],
      );
    });

    assert.deepEqual(await listDatabases([neighbour, testDb.name]), [testDb.name]);
  });

  test('drops the neighbour of a test although a table of the database of the file refers to it: the foreign key keeps the server from dropping it otherwise', async (t) => {
    let neighbour;

    await t.test('inside the test', async (inner) => {
      neighbour = await testDb.createNeighbour(inner);

      await testDb.readRows(`CREATE TABLE \`${neighbour}\`.plans (id INT PRIMARY KEY)`);
      await testDb.readRows(`CREATE TABLE members (id INT PRIMARY KEY, plan_id INT NOT NULL, CONSTRAINT members_plan_fk FOREIGN KEY (plan_id) REFERENCES \`${neighbour}\`.plans (id))`);

      const refusal = await rejectionOf(testDb.runAsAdmin(`DROP DATABASE \`${neighbour}\``));

      assert.equal(refusal.errno, ROW_IS_REFERENCED);
      assert.deepEqual(await listDatabases([neighbour]), [neighbour]);
    });

    assert.deepEqual(await listDatabases([neighbour]), []);
    assert.deepEqual(await listTableNames(testDb), ['members']);
  });

  test('keeps a neighbour that was asked for without a test to the end of the file: every test finds it as it was made, and the hook at the top of this file looks for it when the file has ended', async () => {
    assert.match(fileNeighbour, TEST_NAME_REGEXP);
    assert.deepEqual(await listDatabases([fileNeighbour]), [fileNeighbour]);
    assert.deepEqual(await readDefaults(fileNeighbour), [BINARY_DEFAULTS]);
  });
});

describe('createOwner', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('gives the env of an account that owns the database of the file, named as a database of the tests: it makes tables there and reads them', async (t) => {
    const account = await testDb.createOwner(t);
    const owner = testDb.open({ env: account }, t);

    await owner.readRows('CREATE TABLE owned (id INT PRIMARY KEY)');
    await owner.readRows('INSERT INTO owned (id) VALUES (1), (2)');

    assert.deepEqual(Object.keys(account), ['APP_DATABASE_USER', 'APP_DATABASE_PASSWORD']);
    assert.match(account.APP_DATABASE_USER, TEST_NAME_REGEXP);
    assert.deepEqual(await owner.readRows('SELECT CURRENT_USER() AS account, DATABASE() AS name'), [
      { account: `${account.APP_DATABASE_USER}@${ACCOUNT_HOST}`, name: testDb.name },
    ]);
    assert.deepEqual(await owner.readRows('SELECT id FROM owned ORDER BY id'), [{ id: 1 }, { id: 2 }]);
  });

  test('refuses the account everywhere else: it neither enters another database of the tests, nor reads a table there, nor drops it', async (t) => {
    const other = await testDb.createNeighbour(t);
    const owner = testDb.open({ env: await testDb.createOwner(t) }, t);

    await testDb.readRows(`CREATE TABLE \`${other}\`.things (id INT PRIMARY KEY)`);

    const entering = await rejectionOf(owner.db.driver.withScript({ database: other }, () => 'entered'));
    const reading = await rejectionOf(owner.readRows(`SELECT id FROM \`${other}\`.things`));
    const dropping = await rejectionOf(owner.readRows(`DROP DATABASE \`${other}\``));

    assert.deepEqual(
      [entering, dropping].map((error) => [error.errno, isDatabaseAccessDenied(error)]),
      [[DATABASE_ACCESS_DENIED, true], [DATABASE_ACCESS_DENIED, true]],
    );
    assert.deepEqual([reading.errno, isDatabaseAccessDenied(reading)], [TABLE_ACCESS_DENIED, false]);
    assert.deepEqual(await listDatabases([other]), [other]);
  });

  test('lets the account make the databases an extra pattern names, as GRANT reads it: an escaped underscore stands for itself', async (t) => {
    const { migrationReferencePrefix: prefix } = testDb.config.db;
    const beside = `${prefix}${toNamePart(uuidv7())}`;
    const lookalike = `${prefix.replaceAll('_', 'x')}${toNamePart(uuidv7())}`;
    const owner = testDb.open({ env: await testDb.createOwner(t, [toLikePattern(prefix)]) }, t);

    dropDatabasesAfter(t, [beside, lookalike]);
    await owner.readRows(`CREATE DATABASE \`${beside}\``);
    await owner.readRows(`CREATE TABLE \`${beside}\`.things (id INT PRIMARY KEY)`);

    const refusal = await rejectionOf(owner.readRows(`CREATE DATABASE \`${lookalike}\``));

    assert.deepEqual(await owner.readRows(`SELECT COUNT(*) AS total FROM \`${beside}\`.things`), [{ total: 0 }]);
    assert.deepEqual([refusal.errno, isDatabaseAccessDenied(refusal)], [DATABASE_ACCESS_DENIED, true]);

    await owner.readRows(`DROP DATABASE \`${beside}\``);

    assert.deepEqual(await listDatabases([beside, lookalike]), []);
  });

  test('gives the account a limit when asked, as CREATE USER writes it: with one connection allowed the server refuses the second, which an account without a limit is given', async (t) => {
    const limited = await testDb.createOwner(t, [], { limit: ONE_CONNECTION_LIMIT });
    const free = await testDb.createOwner(t);

    await connectAs(t, limited);
    await connectAs(t, free);

    const refusal = await rejectionOf(connectAs(t, limited));
    const second = await connectAs(t, free);
    const [[{ account }]] = await second.query('SELECT CURRENT_USER() AS account');

    assert.equal(refusal.errno, USER_LIMIT_REACHED);
    assert.match(refusal.message, LIMIT_REACHED_REGEXP);
    assert.equal(account, `${free.APP_DATABASE_USER}@${ACCOUNT_HOST}`);
  });

  test('drops the account after the test that asked for it', async (t) => {
    let user;

    await t.test('inside the test', async (inner) => {
      user = (await testDb.createOwner(inner)).APP_DATABASE_USER;

      assert.deepEqual(await listAccounts([user]), [user]);
    });

    assert.deepEqual(await listAccounts([user]), []);
  });
});

describe('createGate', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('gives a statement that waits until the gate is opened: the session that runs it is found by the name of the gate, and the statement returns once the gate opens, leaving its lock to nobody', async (t) => {
    const gate = await createGate(t);
    const worker = openWorker(t);
    const id = await readSessionId(worker);
    const waiting = settleBeforeEnd(t, worker.readRows(gate.statement));

    assert.equal(await findSessionId(testDb, gate.name), id);

    await waitForLockWaiters([id]);

    assert.equal(await gate.open(), true);
    assert.deepEqual(await waiting, []);
    assert.equal(await readGateHolder(gate), null);
  });

  test('lets every waiter pass when it opens: each takes the lock of the gate and gives it back at once', async (t) => {
    const gate = await createGate(t);
    const workers = [openWorker(t), openWorker(t)];
    const ids = await Promise.all(workers.map((worker) => readSessionId(worker)));
    const waiting = workers.map((worker) => settleBeforeEnd(t, worker.readRows(gate.statement)));

    await waitForLockWaiters(ids);
    await gate.open();

    assert.deepEqual(await Promise.all(waiting), [[], []]);
    assert.equal(await readGateHolder(gate), null);
  });

  test('opens once: the first call lets the lock of the gate go, a second does nothing and says so, and a statement that comes to the open gate finds the lock free', async (t) => {
    const gate = await createGate(t);

    assert.equal(Number.isInteger(await readGateHolder(gate)), true);
    assert.deepEqual([await gate.open(), await gate.open()], [true, false]);

    await waitFor(async () => (await readGateHolder(gate)) === null, 'the lock of the gate to be free');

    assert.deepEqual(await testDb.readRows(gate.statement), []);
    assert.equal(await readGateHolder(gate), null);
  });

  test('opens a gate its test has left closed when that test ends: a statement that still waited there returns after it', async (t) => {
    const worker = openWorker(t);
    const id = await readSessionId(worker);
    const left = {};

    await t.test('inside the test', async (inner) => {
      left.gate = await createGate(inner);
      left.waiting = settleBeforeEnd(t, worker.readRows(left.gate.statement));

      await waitForLockWaiters([id]);
    });

    assert.deepEqual(await left.waiting, []);
    assert.equal(await left.gate.open(), false);
    assert.equal(await readGateHolder(left.gate), null);
  });

  test('gives every gate a lock of its own, named in its statement: opening one leaves the waiter of another where it is', async (t) => {
    const gates = [await createGate(t), await createGate(t)];
    const workers = [openWorker(t), openWorker(t)];
    const ids = await Promise.all(workers.map((worker) => readSessionId(worker)));
    const waiting = workers.map((worker, index) => settleBeforeEnd(t, worker.readRows(gates[index].statement)));

    await waitForLockWaiters(ids);
    await gates[0].open();

    assert.deepEqual(await waiting[0], []);
    assert.deepEqual(await listLockWaiters(ids), [ids[1]]);
    assert.deepEqual(gates.map((gate) => gate.statement.includes(gate.name)), [true, true]);
    assert.notEqual(gates[0].name, gates[1].name);

    await gates[1].open();

    assert.deepEqual(await waiting[1], []);
  });

  test('holds a migration file in the middle, where its statement stands: what the file says before it is done and the row of the file is marked, what follows waits for the gate', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, createHeldMigration(gate));
    const running = settleBeforeEnd(t, testDb.run(() => migrateUp({ directory })));

    await waitForLockWaiters([await findSessionId(testDb, gate.name)]);

    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'teams']);
    assert.deepEqual(await readDirtyMarks(testDb), [['held', true]]);

    await gate.open();

    assert.deepEqual((await running).files, ['0001_held.up.sql']);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'members', 'teams']);
    assert.deepEqual(await readDirtyMarks(testDb), [['held', false]]);
  });

  test('does not hold a file whose wait KILL QUERY has cut: GET_LOCK() answers such a wait with NULL and no error, so the file goes on past the gate, which stays closed', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, createHeldMigration(gate));
    const running = settleBeforeEnd(t, testDb.run(() => migrateUp({ directory })));
    const id = await findSessionId(testDb, gate.name);

    await waitForLockWaiters([id]);

    const keeper = await readGateHolder(gate);

    await killSession(testDb, id, { isQueryOnly: true });

    assert.deepEqual((await running).files, ['0001_held.up.sql']);
    assert.deepEqual(await listTableNames(testDb), ['_migrations', 'members', 'teams']);
    assert.deepEqual(await readDirtyMarks(testDb), [['held', false]]);
    assert.deepEqual([Number.isInteger(keeper), await readGateHolder(gate)], [true, keeper]);
  });

  test('finds its waiter by the state of the session, among the sessions of one database: the text of a script is listed against its session before the server has reached the statement of the gate', async (t) => {
    const gate = await createGate(t);
    const worker = openWorker(t);
    const id = await readSessionId(worker);

    settleBeforeEnd(t, worker.readRows(gate.statement));

    const talker = openWorker(t);
    const talkerId = await readSessionId(talker);

    settleBeforeEnd(t, talker.readRows(`SELECT SLEEP(:seconds), '${gate.name}'`, { seconds: TALK_SECONDS }));
    await waitFor(async () => (await listSessionsOf(gate)).includes(talkerId), 'the session that only names the gate to be listed');

    assert.equal(await gate.findWaiter(testDb), id);
    assert.deepEqual(await listLockWaiters([id, talkerId]), [id]);
    await assert.rejects(gate.findWaiter(testDb, 'no_such_database'), /Timed out waiting for a session to wait at the gate/);
  });
});

describe('waitAtGate', { skip: testDb.skip }, () => {
  beforeEach(() => testDb.reset());

  test('resolves with the session of the file once a run is in the middle of it, and the end of the test waits for the run', async (t) => {
    const gate = await createGate(t);
    const directory = await createMigrationDir(t, createHeldMigration(gate));
    let running;

    await t.test('inside the test', async (inner) => {
      running = testDb.run(() => migrateUp({ directory }));

      const id = await waitAtGate(inner, testDb, { gate, running });

      assert.deepEqual(await listLockWaiters([id]), [id]);
      assert.deepEqual(await readDirtyMarks(testDb), [['held', true]]);
      await gate.open();
    });

    assert.deepEqual(await readDirtyMarks(testDb), [['held', false]]);
    assert.deepEqual((await running).files, ['0001_held.up.sql']);
  });

  test('fails with what the run ended with when the run has ended before it came to the gate', async (t) => {
    const gate = await createGate(t);
    const failed = Promise.reject(new Error('The run was refused'));
    const passed = Promise.resolve({ files: [] });

    await assert.rejects(waitAtGate(t, testDb, { gate, running: failed }), /^Error: The run was refused$/);
    await assert.rejects(waitAtGate(t, testDb, { gate, running: passed }), /The run has ended before the test caught it at the gate/);
  });
});

// No beforeEach here: it would run before the test inside the test too, and empty the database under it.
describe('holdTable', { skip: testDb.skip }, () => {
  test('keeps a table from being altered until the test that holds it ends: a statement that needs the table waits, and gives up when its session waits no longer', async (t) => {
    const worker = openWorker(t);

    await testDb.reset();
    await worker.readRows(TEAMS_SQL);
    await worker.readRows('SET SESSION lock_wait_timeout = 1');

    await t.test('inside the test', async (inner) => {
      await testDb.holdTable(inner, 'teams');

      await assert.rejects(worker.readRows(ADD_NOTE_SQL), (error) => isLockWaitTimeout(error));
      assert.deepEqual(await worker.readRows('SELECT id FROM teams'), []);
    });

    assert.deepEqual(await worker.readRows(ADD_NOTE_SQL), []);
  });
});

describe('findSessionId, killSession and countSessionsLeft', { skip: testDb.skip }, () => {
  test('finds the session of another connection by a mark in the statement it runs, and cuts that statement alone when told to: the session stays', async (t) => {
    const gate = await createGate(t);
    const worker = openWorker(t);
    const id = await readSessionId(worker);
    const held = settleBeforeEnd(t, waitUntilCut(worker.readRows, gate));

    assert.equal(await findSessionId(testDb, gate.name), id);

    await killSession(testDb, id, { isQueryOnly: true });

    assert.equal(await held, true);
    assert.equal(await countSessionsLeft(testDb, [id], 0), 1);
    assert.equal(await readSessionId(worker), id);
  });

  test('ends the session itself unless told to cut the statement only: the statement is cut with it, and the server lists the session no more', async (t) => {
    const gate = await createGate(t);
    const worker = openWorker(t);
    const id = await readSessionId(worker);
    const held = settleBeforeEnd(t, waitUntilCut(worker.readRows, gate));

    await killSession(testDb, await findSessionId(testDb, gate.name));

    assert.equal(await held, true);
    assert.equal(await countSessionsLeft(testDb, [id]), 0);
  });

  test('looks among the sessions of one database only: the one of the pool, or the one that is named', async (t) => {
    const gate = await createGate(t);
    const neighbour = await testDb.createNeighbour(t);
    const worker = openWorker(t);
    const visitor = await connectAs(t);
    const here = await readSessionId(worker);

    await visitor.query(`USE \`${neighbour}\``);

    const waiting = [worker.readRows(gate.statement), visitor.query(gate.statement)].map((statement) => settleBeforeEnd(t, statement));

    assert.equal(await findSessionId(testDb, gate.name), here);
    assert.equal(await findSessionId(testDb, gate.name, neighbour), visitor.threadId);

    await gate.open();
    await Promise.all(waiting);
  });
});

describe('toLikePattern', { skip: testDb.skip }, () => {
  test('gives a pattern the server reads as the prefix and anything after it: an underscore of the prefix stands for itself, not for any character', async () => {
    const [matches] = await testDb.readRows(
      'SELECT :own LIKE :pattern AS own, :bare LIKE :pattern AS bare, :lookalike LIKE :pattern AS lookalike',
      {
        pattern: toLikePattern(DATABASE_PREFIX),
        own: testDb.name,
        bare: DATABASE_PREFIX,
        lookalike: `${LOOKALIKE_PREFIX}${testDb.name.slice(DATABASE_PREFIX.length)}`,
      },
    );

    assert.deepEqual(matches, { own: 1, bare: 1, lookalike: 0 });
  });
});

describe('dropStaleDatabases', { skip: testDb.skip }, () => {
  // Every other test file drops stale databases too, so what is asserted is the end state, not who dropped what.
  async function sweep(t, names) {
    const admin = await openAdmin(t);

    await admin.createDatabases(names);

    const dropped = await dropStaleDatabases(admin.connection);

    return { dropped, left: await listDatabases([...names, testDb.name]) };
  }

  test('drops a database of the tests whose name is older than an hour, and keeps a younger one and the one of this file', async (t) => {
    const stale = createAgedName(STALE_MINUTES);
    const young = createAgedName(YOUNG_MINUTES);
    const { dropped, left } = await sweep(t, [stale, young]);

    assert.deepEqual(left, [young, testDb.name].toSorted());
    assert.deepEqual(dropped.filter((name) => [young, testDb.name].includes(name)), []);
  });

  test('reads the moment from the UUIDv7 a name ends with: an old reference beside a young database goes, a young one beside an old database stays', async (t) => {
    const stale = createAgedReferenceName(YOUNG_MINUTES, STALE_MINUTES);
    const young = createAgedReferenceName(STALE_MINUTES, YOUNG_MINUTES);
    const { dropped, left } = await sweep(t, [stale, young]);

    assert.deepEqual(left, [young, testDb.name].toSorted());
    assert.equal(dropped.includes(young), false);
  });

  test('drops what "verify" of a process has left: a name of the prefix of the config that is older than an hour', async (t) => {
    const prefix = createTestConfig().db.migrationReferencePrefix;
    const stale = `${prefix}${toNamePart(createAgedId(STALE_MINUTES))}`;
    const young = `${prefix}${toNamePart(createAgedId(YOUNG_MINUTES))}`;
    const { dropped, left } = await sweep(t, [stale, young]);

    assert.deepEqual(left, [young, testDb.name].toSorted());
    assert.equal(dropped.includes(young), false);
  });

  test('leaves alone a name of the tests that does not end with a UUIDv7, and an old name that only resembles the prefix of the tests', async (t) => {
    const copy = `${DATABASE_PREFIX}manual_copy_${uuidv7().slice(-NAME_TAIL_LENGTH)}`;
    const lookalike = `${LOOKALIKE_PREFIX}${toNamePart(createAgedId(STALE_MINUTES))}`;
    const { dropped, left } = await sweep(t, [copy, lookalike]);

    assert.deepEqual(left, [copy, lookalike, testDb.name].toSorted());
    assert.deepEqual(dropped.filter((name) => [copy, lookalike].includes(name)), []);
  });
});

describe('dropStaleAccounts', { skip: testDb.skip }, () => {
  test('drops an account of the tests whose name is older than an hour, and keeps a younger one and an old one that only resembles the prefix of the tests', async (t) => {
    const admin = await openAdmin(t);
    const stale = createAgedName(STALE_MINUTES);
    const young = createAgedName(YOUNG_MINUTES);
    const lookalike = `${LOOKALIKE_PREFIX}${toNamePart(createAgedId(STALE_MINUTES))}`;

    await admin.createAccounts([stale, young, lookalike]);

    const dropped = await dropStaleAccounts(admin.connection);

    assert.deepEqual(await listAccounts([stale, young, lookalike]), [young, lookalike].toSorted());
    assert.deepEqual(dropped.filter((name) => [young, lookalike].includes(name)), []);
  });
});

describe('createTestDb: the end of the file', { skip: testDb.skip }, () => {
  test('drops with the database what a failed "verify" has left beside it and the neighbour of the file, to which a table of the database refers by then: the hook at the top of this file looks when the file has ended', async () => {
    const left = [nameLeftover(), fileNeighbour];

    await testDb.runAsAdmin(`CREATE DATABASE \`${nameLeftover()}\``);
    await testDb.readRows(`CREATE TABLE \`${fileNeighbour}\`.plans (id INT PRIMARY KEY)`);
    await testDb.readRows(`CREATE TABLE subscriptions (id INT PRIMARY KEY, plan_id INT NOT NULL, CONSTRAINT subscriptions_plan_fk FOREIGN KEY (plan_id) REFERENCES \`${fileNeighbour}\`.plans (id))`);

    assert.deepEqual(await listDatabases(left), left.toSorted());
  });
});
