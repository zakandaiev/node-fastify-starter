import packageData from '#root/package.json' with { type: 'json' };
import { TEST_ENV } from '#root/tests/helper/config.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { parseLogLines } from '#root/tests/helper/log.js';
import {
  createWorkDir,
  getFreePort,
  runNode,
  startNode,
  waitForOutput,
} from '#root/tests/helper/process.js';
import assert from 'node:assert/strict';
import { platform } from 'node:process';
import { describe, test } from 'node:test';

const SERVER = 'src/server.js';
const STARTED = /Server started/;

const testDb = await createTestDb();

async function startServer(t, env = {}) {
  const cwd = await createWorkDir(t, { ...TEST_ENV, ...testDb.env, ...env });
  const port = await getFreePort();
  const server = startNode(SERVER, { args: [`--port=${port}`], cwd });

  return { server, port, cwd };
}

describe('server', { skip: testDb.skip }, () => {
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
});
