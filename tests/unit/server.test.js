import packageData from '#root/package.json' with { type: 'json' };
import { TEST_ENV } from '#root/tests/helper/config.js';
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

// Port 0: a regression that lets the server start must not take the fixed default port.
const ANY_PORT = '--port=0';

function parseLogLines(stdout) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function startServer(t, envFile = TEST_ENV) {
  const cwd = await createWorkDir(t, envFile);
  const port = await getFreePort();
  const server = startNode(SERVER, { args: [`--port=${port}`], cwd });

  return { server, port, cwd };
}

describe('server', () => {
  test('listens on loopback and the port from --port and logs the app version', async (t) => {
    const { server, port } = await startServer(t);

    const lines = parseLogLines(await waitForOutput(server, STARTED));
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const started = lines.find((line) => STARTED.test(line.msg));

    assert.equal(response.status, 404);
    assert.ok(lines.some((line) => line.msg === `Server listening at http://127.0.0.1:${port}`));
    assert.deepEqual(started.app, { name: packageData.name, version: packageData.version, mode: 'prod' });
  });

  test('prints readable logs in dev mode', async (t) => {
    const { server } = await startServer(t, { ...TEST_ENV, APP_MODE: 'dev' });

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

  test('does not start without .env and lists the variables', async (t) => {
    const cwd = await createWorkDir(t);
    const { code, stderr } = await runNode(SERVER, { args: [ANY_PORT], cwd });

    assert.equal(code, 1);
    assert.match(stderr, /Invalid environment variables:/);
    assert.match(stderr, /APP_HOST is required/);
    assert.match(stderr, /APP_JWT_ACCESS_SECRET is required/);
  });

  test('does not start with a secret shorter than 32 characters', async (t) => {
    const cwd = await createWorkDir(t, { ...TEST_ENV, APP_JWT_REFRESH_SECRET: 'a'.repeat(31) });
    const { code, stderr } = await runNode(SERVER, { args: [ANY_PORT], cwd });

    assert.equal(code, 1);
    assert.match(stderr, /APP_JWT_REFRESH_SECRET must be at least 32 characters long/);
  });

  test('does not start with an invalid argument', async (t) => {
    const cwd = await createWorkDir(t, TEST_ENV);
    const [port, host] = await Promise.all([
      runNode(SERVER, { args: ['--port=abc'], cwd }),
      runNode(SERVER, { args: [ANY_PORT, '--host='], cwd }),
    ]);

    assert.equal(port.code, 1);
    assert.match(port.stderr, /--port must be a non-negative integer/);
    assert.equal(host.code, 1);
    assert.match(host.stderr, /--host must not be empty/);
  });

  test('exits with an error when the port is taken', async (t) => {
    const { server, port, cwd } = await startServer(t);

    await waitForOutput(server, STARTED);

    const { code, stdout } = await runNode(SERVER, { args: [`--port=${port}`], cwd });
    const failed = parseLogLines(stdout).find((line) => line.msg === 'Server failed to start');

    assert.equal(code, 1);
    assert.equal(failed.err.code, 'EADDRINUSE');
  });
});
