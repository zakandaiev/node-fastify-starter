import { migrateUp } from '#core/db/migrator.js';
import packageData from '#root/package.json' with { type: 'json' };
import { TEST_ENV } from '#root/tests/helper/config.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { parseLogLines } from '#root/tests/helper/log.js';
import { describePendingRefusal, REPOSITORY_MIGRATIONS } from '#root/tests/helper/migration.js';
import {
  createWorkDir,
  getFreePort,
  runNode,
  startNode,
  waitForOutput,
} from '#root/tests/helper/process.js';
import { readRedisEnv, REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { getServiceAddress, getServiceSkip } from '#root/tests/helper/service.js';
import { compact } from '#utils/object.js';
import assert from 'node:assert/strict';
import { platform } from 'node:process';
import { before, describe, test } from 'node:test';

const SERVER = 'src/server.js';
const STARTED = /Server started/;

// Exact: "Redis is ready" alone would also match the line of the cache Redis.
const MAIN_READY = /"msg":"Redis is ready"/;
const CACHE_READY = /"msg":"Cache Redis is ready"/;

const testDb = await createTestDb();
const redisSkip = await getServiceSkip(['redis']);
const redisEnv = readRedisEnv();

async function startServer(t, env = {}) {
  const cwd = await createWorkDir(t, {
    ...TEST_ENV,
    ...redisEnv,
    ...testDb.env,
    ...env,
  });
  const port = await getFreePort();
  const server = startNode(SERVER, { args: [`--port=${port}`], cwd });

  return { server, port, cwd };
}

describe('server', { skip: testDb.skip }, () => {
  before(() => testDb.run(() => migrateUp()));

  test('listens on loopback and the port from --port and logs the versions of the app and of the database', async (t) => {
    const { server, port } = await startServer(t);

    const lines = parseLogLines(await waitForOutput(server, STARTED));
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const started = lines.find((line) => STARTED.test(line.msg));

    assert.equal(response.status, 404);
    assert.ok(lines.some((line) => line.msg === `Server listening at http://127.0.0.1:${port}`));
    assert.deepEqual(started.app, { name: packageData.name, version: packageData.version, mode: 'prod' });
    assert.match(started.database.version, /^\d+\.\d+\.\d+-MariaDB/);
  });

  test('connects to Redis once it starts and says so, and where the cache lives', { skip: redisSkip }, async (t) => {
    const { server } = await startServer(t);

    const lines = parseLogLines(await waitForOutput(server, MAIN_READY));
    const ready = lines.find((line) => line.msg === 'Redis is ready');
    const cache = lines.find((line) => line.msg === 'Cache lives in the main Redis: it must run with noeviction and memory to spare');
    const { host, port } = getServiceAddress('redis');

    assert.equal(ready.redis.address, `${host}:${port}`);
    assert.equal(cache.cache.redis, ready.redis.address);
  });

  test('connects a Redis of its own for the cache as well', { skip: redisSkip }, async (t) => {
    const { server } = await startServer(t, compact({
      APP_CACHE_REDIS_HOST: redisEnv.APP_REDIS_HOST,
      APP_CACHE_REDIS_PORT: redisEnv.APP_REDIS_PORT,
      APP_CACHE_REDIS_USER: redisEnv.APP_REDIS_USER,
      APP_CACHE_REDIS_PASSWORD: redisEnv.APP_REDIS_PASSWORD,
    }));

    await waitForOutput(server, CACHE_READY);

    const lines = parseLogLines(await waitForOutput(server, MAIN_READY));

    assert.ok(lines.some((line) => line.msg === 'Cache uses a Redis of its own'));
    assert.ok(lines.some((line) => line.msg === 'Cache Redis is ready'));
  });

  test('starts and listens without Redis: Redis only speeds it up', async (t) => {
    const { server, port } = await startServer(t, REDIS_DOWN_ENV);

    const lines = parseLogLines(await waitForOutput(server, STARTED));
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/system/ping`);
    const unreachable = lines.find((line) => line.msg === 'Redis is not reachable');

    assert.equal(response.status, 200);
    assert.equal(unreachable.level, 40);
    assert.equal(unreachable.err.code, 'ECONNREFUSED');
  });

  test('prints readable logs in dev mode', async (t) => {
    const { server } = await startServer(t, { APP_MODE: 'dev' });

    const stdout = await waitForOutput(server, STARTED);

    assert.throws(() => parseLogLines(stdout), SyntaxError);
    assert.match(stdout, /INFO/);
  });

  test('closes and exits with 0 on SIGTERM', { skip: platform === 'win32' && 'Windows cannot deliver SIGTERM to a process' }, async (t) => {
    const { server, port } = await startServer(t);

    await waitForOutput(server, STARTED);

    const { code, stdout } = await server.stop();
    const messages = parseLogLines(stdout).map((line) => line.msg);

    assert.equal(code, 0);
    assert.ok(messages.includes('Server is shutting down'));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  });

  test('exits with an error when the port is taken', async (t) => {
    const { server, port, cwd } = await startServer(t);

    await waitForOutput(server, STARTED);

    const { code, stdout } = await runNode(SERVER, { args: [`--port=${port}`], cwd });
    const failed = parseLogLines(stdout).find((line) => line.msg === 'Server failed to start');

    assert.equal(code, 1);
    assert.equal(failed.err.code, 'EADDRINUSE');
  });

  test('does not start on a database that does not exist', async (t) => {
    const cwd = await createWorkDir(t, { ...TEST_ENV, ...testDb.env, APP_DATABASE_NAME: 'nfs_test_missing' });
    const { code, stdout } = await runNode(SERVER, { args: ['--port=0'], cwd });
    const failed = parseLogLines(stdout).find((line) => line.msg === 'Server failed to start');

    assert.equal(code, 1);
    assert.equal(failed.err.code, 'ER_BAD_DB_ERROR');
    assert.equal(stdout.includes('Server listening'), false);
  });

  test('does not start and does not listen on a database without the migrations of the build, and names them', async (t) => {
    const empty = await testDb.createNeighbour(t);
    const cwd = await createWorkDir(t, { ...TEST_ENV, ...testDb.env, APP_DATABASE_NAME: empty });
    const { code, stdout } = await runNode(SERVER, { args: ['--port=0'], cwd });
    const failed = parseLogLines(stdout).find((line) => line.msg === 'Server failed to start');

    assert.equal(code, 1);
    assert.equal(failed.err.message, describePendingRefusal(REPOSITORY_MIGRATIONS));
    assert.equal(stdout.includes('Server listening'), false);
  });
});
