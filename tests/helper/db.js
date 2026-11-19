import { createContext, runInContext } from '#core/context/index.js';
import { createDb } from '#core/db/index.js';
import { createLogger } from '#core/logger/index.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { waitFor } from '#root/tests/helper/async.js';
import { createTestConfig, createTestEnv } from '#root/tests/helper/config.js';
import { getFreePort } from '#root/tests/helper/process.js';
import { getServiceSkip, reportSkip } from '#root/tests/helper/service.js';
import { isStaleId } from '#root/tests/helper/stale.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import { randomToken } from '#utils/random.js';
import { createConnection } from 'mysql2/promise';
import assert from 'node:assert/strict';
import { after } from 'node:test';

export const DATABASE_PREFIX = 'nfs_test_';
const ID_LENGTH = 36;

// The name of a database holds 64 characters and "verify" puts a UUID after its prefix, so the prefix of
// a test file carries the last group of the name of its database, not the whole of it.
const REFERENCE_ID_LENGTH = 12;
const DATABASE_ENV_KEYS = Object.freeze([
  'APP_DATABASE_HOST',
  'APP_DATABASE_PORT',
  'APP_DATABASE_NAME',
  'APP_DATABASE_USER',
  'APP_DATABASE_PASSWORD',
]);
const LOOPBACK = '127.0.0.1';
export const ACCOUNT_HOST = '%';

const GATE_PREFIX = 'nfs-test-gate:';
const GATE_WAIT_SECONDS = 10;
const LOCK_WAIT_STATE = 'User lock';

// A database that a session still holds locked is left for the next run instead of being waited for:
// the server would wait a day.
const DROP_LOCK_WAIT_SECONDS = 5;

const SKIPPED_TEST_NAME = 'integration tests on MariaDB';

// The name carries the moment it was made: a UUIDv7 with underscores, since a dash needs quoting everywhere.
export function createDatabaseName(id = uuidv7()) {
  return `${DATABASE_PREFIX}${id.replaceAll('-', '_')}`;
}

// What a killed run leaves behind and the next one sweeps: the databases of the test files, the accounts made
// for them (named the same way) and the databases "verify" builds beside the one it checks. The last are named
// by the prefix of the test file when a pool of the tests runs it, and by the prefix of the config when a process does.
function listStalePrefixes() {
  return [DATABASE_PREFIX, createTestConfig().db.migrationReferencePrefix];
}

// For LIKE and for GRANT alike: an underscore stands for itself, and anything may follow the prefix.
export function toLikePattern(prefix) {
  return `${prefix.replaceAll('_', '\\_')}%`;
}

// The UUIDv7 a name ends with, its underscores dashes again, or null for a name the tests did not make.
export function readDatabaseId(name) {
  return name.startsWith(DATABASE_PREFIX) && name.length >= DATABASE_PREFIX.length + ID_LENGTH
    ? name.slice(-ID_LENGTH).replaceAll('_', '-')
    : null;
}

function isStale(name) {
  return listStalePrefixes().some((prefix) => name.startsWith(prefix))
    && isStaleId(name.slice(-ID_LENGTH).replaceAll('_', '-'));
}

// Not through createDb(): a broken driver must not break the setup of its own tests.
export function connectAdmin(env = createTestEnv()) {
  return createConnection({
    host: env.APP_DATABASE_HOST,
    port: env.APP_DATABASE_PORT,
    user: env.APP_DATABASE_USER,
    password: env.APP_DATABASE_PASSWORD,
  });
}

async function withAdmin(env, fn) {
  const connection = await connectAdmin(env);

  try {
    await connection.query(`SET SESSION lock_wait_timeout = ${DROP_LOCK_WAIT_SECONDS}`);

    return await fn(connection);
  } finally {
    await connection.end();
  }
}

function dropDatabase(connection, name) {
  return connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
}

// With the checks of foreign keys off: a table that another database refers to is not dropped otherwise.
async function dropDatabases(connection, names) {
  await connection.query('SET SESSION foreign_key_checks = 0');

  return Promise.allSettled(names.map((name) => dropDatabase(connection, name)));
}

async function listStale(connection, sql) {
  const results = await Promise.all(listStalePrefixes().map((prefix) => connection.query(sql, [toLikePattern(prefix)])));

  return results.flatMap(([rows]) => rows.map((row) => row.name)).filter((name) => isStale(name));
}

// Resolves with the names it has dropped: one that could not be dropped must not fail the test file that
// only cleans up on its way.
export async function dropStaleDatabases(connection) {
  const stale = await listStale(connection, 'SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name LIKE ?');
  const results = await Promise.allSettled(stale.map((name) => dropDatabase(connection, name)));

  return stale.filter((name, index) => results[index].status === 'fulfilled');
}

function dropAccount(connection, user) {
  return connection.query('DROP USER IF EXISTS ?@?', [user, ACCOUNT_HOST]);
}

export async function dropStaleAccounts(connection) {
  const stale = await listStale(connection, 'SELECT user AS name FROM mysql.global_priv WHERE user LIKE ?');
  const results = await Promise.allSettled(stale.map((user) => dropAccount(connection, user)));

  return stale.filter((user, index) => results[index].status === 'fulfilled');
}

// An account that may do anything in the databases it is given and nothing elsewhere, as the account of an app
// in production: every other test connects as root, which no refusal of the server ever meets. In a pattern
// "_" and "%" stand for any characters unless escaped; "limit" is written as in CREATE USER ... WITH.
async function createAccount(env, patterns, limit) {
  const account = { APP_DATABASE_USER: createDatabaseName(), APP_DATABASE_PASSWORD: randomToken() };
  const limitClause = limit
    ? ` WITH ${limit}`
    : '';

  await withAdmin(env, async (connection) => {
    await connection.query(
      `CREATE USER ?@? IDENTIFIED BY ?${limitClause}`,
      [account.APP_DATABASE_USER, ACCOUNT_HOST, account.APP_DATABASE_PASSWORD],
    );
    await Promise.all(patterns.map((pattern) => connection.query(
      `GRANT ALL PRIVILEGES ON \`${pattern}\`.* TO ?@?`,
      [account.APP_DATABASE_USER, ACCOUNT_HOST],
    )));
  });

  return account;
}

async function countSessions(pool, ids) {
  const [{ total }] = await pool.readRows('SELECT COUNT(*) AS total FROM information_schema.processlist WHERE id IN (:ids)', { ids });

  return total;
}

// How many of the sessions are still on the server: 0 once all of them have left, however long it takes
// within the deadline. "pool" is what open() returns; the sessions are named by CONNECTION_ID().
// With "checks" of 0 it counts at once.
export async function countSessionsLeft(pool, ids, checks) {
  try {
    await waitFor(async () => (await countSessions(pool, ids)) === 0, 'the sessions to leave the server', checks);

    return 0;
  } catch {
    return countSessions(pool, ids);
  }
}

// Among the sessions of one database, the one of the pool unless another is named: test files run side by side
// on one server. With a state, the session must be in it too.
function findSession(pool, { mark, database = pool.config.db.database, state = null }, what) {
  return waitFor(async () => {
    const [session] = await pool.readRows(
      'SELECT id FROM information_schema.processlist WHERE db = :database AND info LIKE :pattern AND (:state IS NULL OR state = :state) AND id <> CONNECTION_ID()',
      { database, pattern: `%${mark}%`, state },
    );

    return session?.id;
  }, what);
}

// The session of another connection that is running a statement with "mark" in its text, once the server
// lists it.
export function findSessionId(pool, mark, database) {
  return findSession(pool, { mark, database }, `a session that runs "${mark}"`);
}

// KILL ends the session; with "isQueryOnly" it cuts only the statement the session is running.
export function killSession(pool, id, { isQueryOnly = false } = {}) {
  return pool.readRows(`KILL ${isQueryOnly ? 'QUERY ' : ''}${Number(id)}`);
}

// The databases "verify" builds are named after the database of the test file: files run side by side on one
// server, and each must be able to tell its own from those of the others.
function toReferencePrefix(name) {
  return `${DATABASE_PREFIX}${name.slice(-REFERENCE_ID_LENGTH)}_`;
}

function withDatabase(sections, name) {
  return {
    ...sections,
    env: { ...sections.env, APP_DATABASE_NAME: name },
    db: { migrationReferencePrefix: toReferencePrefix(name), ...sections.db },
  };
}

function openPool(config) {
  const db = createDb(config.db);
  const context = createContext({ config, log: createLogger(config.logger), db });

  function run(fn) {
    return runInContext(context, fn);
  }

  async function readRows(sql, binding) {
    const { rows } = await run(() => db.query(sql, binding));

    return rows;
  }

  return {
    config,
    db,
    context,
    run,
    readRows,
  };
}

// A closed port stands for a database that is down: what is built on this env needs no service.
export async function createDownEnv() {
  return { APP_DATABASE_HOST: LOOPBACK, APP_DATABASE_PORT: String(await getFreePort()) };
}

export async function createDownDb(t, sections = {}) {
  const down = openPool(createTestConfig({ ...sections, env: { ...sections.env, ...(await createDownEnv()) } }));

  t.after(() => down.db.close());

  return down;
}

function createEmptyDatabase(connection, name) {
  return connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
}

async function createDatabase(env, name) {
  await withAdmin(env, async (connection) => {
    await dropStaleDatabases(connection);
    await dropStaleAccounts(connection);
    await createEmptyDatabase(connection, name);
  });
}

// Everything in the database is gone, the pools stay: a session keeps its default database through a drop
// and a create of the same name. For a test that needs the database as it was at the start of the file.
async function resetDatabase(env, name) {
  await withAdmin(env, async (connection) => {
    await dropDatabase(connection, name);
    await createEmptyDatabase(connection, name);
  });
}

// The pools first: a pool that is left open keeps the process of the test file alive after its last test.
// With the database go its neighbours and what a failed test of "verify" has left beside it.
async function removeDatabase(env, name, { pools, neighbours }) {
  await Promise.allSettled(pools.map((db) => db.close()));
  await withAdmin(env, async (connection) => {
    const [references] = await connection.query(
      'SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name LIKE ?',
      [toLikePattern(toReferencePrefix(name))],
    );

    await dropDatabases(connection, [...references.map((reference) => reference.name), ...neighbours, name]);
  });
}

// A statement that waits until the test lets it go, to hold a script or a migration file in the middle without
// a sleep: it asks for an advisory lock a session of the gate keeps, and gives the lock back at once, so that
// every waiter passes when the gate opens. KILL QUERY lets a waiter pass too: GET_LOCK answers NULL, no error.
export async function createGate(t) {
  const name = `${GATE_PREFIX}${uuidv7()}`;
  const keeper = await connectAdmin();
  let isOpen = false;

  async function open() {
    if (isOpen) {
      return false;
    }

    isOpen = true;
    await keeper.end();

    return true;
  }

  // The session that waits at the gate. Told by its state, not by the text alone: the server lists the whole
  // rest of a script against its session before it has reached the statement.
  function findWaiter(pool, database) {
    return findSession(pool, { mark: name, database, state: LOCK_WAIT_STATE }, `a session to wait at the gate ${name}`);
  }

  t.after(open);
  await keeper.query('SELECT GET_LOCK(?, 0)', [name]);

  return {
    name,
    statement: `DO GET_LOCK('${name}', ${GATE_WAIT_SECONDS}), RELEASE_LOCK('${name}')`,
    open,
    findWaiter,
  };
}

// Resolves, with the session of the waiter, once the server is in the middle of the script or the file that
// holds the statement of the gate. A run that has ended before that fails the test with what it ended with;
// the end of the test waits for the run, so that nothing of it writes into the next test.
export async function waitAtGate(t, pool, { gate, running, database }) {
  t.after(() => Promise.allSettled([running]));

  const sessionId = await Promise.race([gate.findWaiter(pool, database), running]);

  assert.ok(Number.isInteger(sessionId), 'The run has ended before the test caught it at the gate');

  return sessionId;
}

// What follows works on the database of one test file: "scope" is its { env, name, pools, neighbours }.

// One more pool on the same database: a pool of one connection, a short time limit, a log sink. Given a test,
// the pool is closed with it and not with the file: an open pool is sessions on a server the files share.
function openOnDatabase(scope, overrides = {}, t = null) {
  const opened = openPool(createTestConfig(withDatabase(overrides, scope.name)));

  scope.pools.push(opened.db);
  t?.after(() => opened.db.close());

  return opened;
}

async function buildAppOnDatabase(scope, overrides = {}) {
  const fastify = await buildTestApp(withDatabase(overrides, scope.name));

  scope.pools.push(fastify.db);

  return fastify;
}

// The env of an account that owns this database, and the databases of "extraPatterns" beside it, for
// open({ env }); the account is dropped after the test.
async function createOwner(scope, t, extraPatterns = [], { limit } = {}) {
  const account = await createAccount(scope.env, [scope.name.replaceAll('_', '\\_'), ...extraPatterns], limit);

  t.after(() => withAdmin(scope.env, (connection) => dropAccount(connection, account.APP_DATABASE_USER)));

  return account;
}

// One statement as the administrator of the server, for what the account of a test may not do.
function runAsAdmin(scope, sql, values) {
  return withAdmin(scope.env, async (connection) => {
    const [rows] = await connection.query(sql, values);

    return rows;
  });
}

// Not through a pool: a session keeps the collation of the database it stands in through reset(), and a table
// it creates or a database it alters in a later test would get that collation back.
function alterDatabase(scope, clause, values) {
  return runAsAdmin(scope, `ALTER DATABASE \`${scope.name}\` ${clause}`, values);
}

// A session that has read the table in a transaction it leaves open until the test ends: no statement
// alters the table meanwhile.
async function holdTable(scope, t, table) {
  const reader = await connectAdmin(scope.env);

  t.after(() => reader.end());
  await reader.query('BEGIN');
  await reader.query(`SELECT * FROM \`${scope.name}\`.\`${table}\``);

  return reader;
}

// Another empty database on the server, for what reaches out of its own. It goes with the test,
// or with the file when no test is given.
async function createNeighbour(scope, t = null) {
  const neighbour = createDatabaseName();

  await withAdmin(scope.env, (connection) => createEmptyDatabase(connection, neighbour));

  if (t) {
    t.after(() => withAdmin(scope.env, (connection) => dropDatabases(connection, [neighbour])));
  } else {
    scope.neighbours.push(neighbour);
  }

  return neighbour;
}

// A database of its own for the test file that calls this at its top level: node:test runs every file
// in a process of its own, files side by side. Without MariaDB it returns only "skip", the reason for
// describe(name, { skip }); in CI it throws instead.
export async function createTestDb() {
  const skip = await getServiceSkip(['mariadb']);

  if (skip) {
    return { skip: reportSkip(SKIPPED_TEST_NAME, skip) };
  }

  const name = createDatabaseName();
  const env = createTestEnv({ APP_DATABASE_NAME: name });
  const scope = {
    env, name, pools: [], neighbours: [],
  };

  await createDatabase(env, name);
  after(() => removeDatabase(env, name, scope));

  return {
    skip: false,
    name,
    env: pick(env, DATABASE_ENV_KEYS),
    open: openOnDatabase.bind(null, scope),
    buildApp: buildAppOnDatabase.bind(null, scope),
    createOwner: createOwner.bind(null, scope),
    createNeighbour: createNeighbour.bind(null, scope),
    runAsAdmin: runAsAdmin.bind(null, scope),
    alterDatabase: alterDatabase.bind(null, scope),
    holdTable: holdTable.bind(null, scope),
    reset: () => resetDatabase(env, name),
    ...openOnDatabase(scope),
  };
}
