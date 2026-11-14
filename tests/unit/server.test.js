import { TEST_ENV } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { parseLogLines } from '#root/tests/helper/log.js';
import { createWorkDir, runNode } from '#root/tests/helper/process.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SERVER = 'src/server.js';

// Port 0: a regression that lets the server start must not take the fixed default port.
const ANY_PORT = '--port=0';

describe('server', () => {
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

  test('does not start and does not listen when the database is unreachable', async (t) => {
    const cwd = await createWorkDir(t, { ...TEST_ENV, ...(await createDownEnv()) });
    const { code, stdout } = await runNode(SERVER, { args: [ANY_PORT], cwd });
    const lines = parseLogLines(stdout);
    const failed = lines.find((line) => line.msg === 'Server failed to start');

    assert.equal(code, 1);
    assert.equal(failed.level, 60);
    assert.equal(failed.err.type, 'DbError');
    assert.equal(failed.err.code, 'ECONNREFUSED');
    assert.equal(lines.some((line) => /^Server listening/.test(line.msg)), false);
    assert.equal(lines.some((line) => line.msg === 'Server started'), false);
  });
});
