import { createContext, runInContext } from '#core/context/index.js';
import { createDb } from '#core/db/index.js';
import { createLogger } from '#core/logger/index.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createTestConfig, createTestEnv } from '#root/tests/helper/config.js';
import { getFreePort } from '#root/tests/helper/process.js';
import { getServiceSkip, reportSkip } from '#root/tests/helper/service.js';
import { isExpired } from '#utils/date.js';
import { uuidTimestamp, uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import { createConnection } from 'mysql2/promise';
import { after } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const DATABASE_PREFIX = 'nfs_test_';
const DATABASE_ENV_KEYS = Object.freeze([
  'APP_DATABASE_HOST',
  'APP_DATABASE_PORT',
  'APP_DATABASE_NAME',
  'APP_DATABASE_USER',
  'APP_DATABASE_PASSWORD',
]);
const LOOPBACK = '127.0.0.1';

// A run that was killed leaves its database behind: the next run drops what is older than this.
const STALE_AFTER = '1h';

// A database that a session still holds locked is left for the next run instead of being waited for:
// the server would wait a day.
const DROP_LOCK_WAIT_SECONDS = 5;

// The server drops a session a moment after its connection was ended or killed.
const GONE_CHECKS = 100;
const GONE_CHECK_INTERVAL_MS = 20;

const SKIPPED_TEST_NAME = 'integration tests on MariaDB';

// The name carries the moment it was made: a UUIDv7 with underscores, since a dash needs quoting everywhere.
export function createDatabaseName(id = uuidv7()) {
  return `${DATABASE_PREFIX}${id.replaceAll('-', '_')}`;
}

function readCreatedAt(name) {
  return uuidTimestamp(name.slice(DATABASE_PREFIX.length).replaceAll('_', '-'));
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

// A name without a moment in it is not of these tests' making and is left alone. Resolves with the names
// it has dropped: one that could not be dropped must not fail the test file that only cleans up on its way.
export async function dropStaleDatabases(connection) {
  const [rows] = await connection.query(
    'SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name LIKE ?',
    [`${DATABASE_PREFIX.replaceAll('_', '\\_')}%`],
  );
  const stale = rows
    .map((row) => row.name)
    .filter((name) => readCreatedAt(name) !== null && isExpired(readCreatedAt(name), STALE_AFTER));

  const results = await Promise.allSettled(stale.map((name) => dropDatabase(connection, name)));

  return stale.filter((name, index) => results[index].status === 'fulfilled');
}

// How many of the sessions are still on the server: 0 once all of them have left, however long it takes
// within the deadline. "pool" is what open() returns; the sessions are named by CONNECTION_ID().
export async function countSessionsLeft(pool, ids, checksLeft = GONE_CHECKS) {
  const { rows } = await pool.run(() => pool.db.query(
    'SELECT COUNT(*) AS total FROM information_schema.processlist WHERE id IN (:ids)',
    { ids },
  ));

  if (rows[0].total === 0 || checksLeft === 0) {
    return rows[0].total;
  }

  await sleep(GONE_CHECK_INTERVAL_MS);

  return countSessionsLeft(pool, ids, checksLeft - 1);
}

function withDatabase(sections, name) {
  return { ...sections, env: { ...sections.env, APP_DATABASE_NAME: name } };
}

function openPool(config) {
  const db = createDb(config.db);
  const context = createContext({ config, log: createLogger(config.logger), db });

  return {
    config,
    db,
    context,
    run: (fn) => runInContext(context, fn),
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

async function createDatabase(env, name) {
  await withAdmin(env, async (connection) => {
    await dropStaleDatabases(connection);
    await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  });
}

// The pools first: a pool that is left open keeps the process of the test file alive after its last test.
async function removeDatabase(env, name, pools) {
  await Promise.allSettled(pools.map((db) => db.close()));
  await withAdmin(env, (connection) => dropDatabase(connection, name));
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
  const pools = [];

  await createDatabase(env, name);

  // One more pool on the same database: a pool of one connection, a short time limit, a log sink.
  function open(overrides = {}) {
    const opened = openPool(createTestConfig(withDatabase(overrides, name)));

    pools.push(opened.db);

    return opened;
  }

  async function buildApp(overrides = {}) {
    const fastify = await buildTestApp(withDatabase(overrides, name));

    pools.push(fastify.db);

    return fastify;
  }

  after(() => removeDatabase(env, name, pools));

  return {
    skip: false,
    name,
    env: pick(env, DATABASE_ENV_KEYS),
    open,
    buildApp,
    ...open(),
  };
}
