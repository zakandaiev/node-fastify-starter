import { readSystemEnv } from '#config/env.js';
import { absPath } from '#config/path.js';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { execPath } from 'node:process';

const PROCESS_TIMEOUT_MS = 15000;
const REMOVE_RETRIES = 10;
const REMOVE_RETRY_DELAY_MS = 100;

const running = new Set();

function formatEnvFile(env) {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
}

async function removeWorkDir(directory) {
  // Windows refuses to remove the working directory of a live process, so its processes go first.
  await Promise.all([...running].filter((node) => node.cwd === directory).map((node) => node.stop()));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: REMOVE_RETRIES,
    retryDelay: REMOVE_RETRY_DELAY_MS,
  });
}

// A working directory of its own: the process under test reads .env from there, not from the project root.
export async function createWorkDir(t, envFile) {
  const directory = await realpath(await mkdtemp(nodePath.join(tmpdir(), 'nfs-test-')));

  t.after(() => removeWorkDir(directory));

  if (envFile) {
    const content = typeof envFile === 'string'
      ? envFile
      : formatEnvFile(envFile);

    await writeFile(nodePath.join(directory, '.env'), content);
  }

  return directory;
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();

      server.close(() => resolve(port));
    });
  });
}

function collectOutput(child) {
  const output = { stdout: '', stderr: '' };

  child.stdout.setEncoding('utf8').on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output.stderr += chunk; });

  return output;
}

// Only system variables are inherited: an APP_* of the developer's shell must not leak into the child.
export function startNode(script, { args = [], cwd, env = {} } = {}) {
  const child = spawn(execPath, [nodePath.join(absPath.root, script), ...args], {
    cwd,
    env: { ...readSystemEnv(), ...env },
  });
  const output = collectOutput(child);
  const exit = new Promise((resolve) => {
    child.once('close', (code) => resolve({ code, ...output }));
  });

  // The hard kill is for a process that ignores SIGTERM: a hook waiting for it would hang the run.
  function stop() {
    child.kill();
    setTimeout(() => child.kill('SIGKILL'), PROCESS_TIMEOUT_MS).unref();

    return exit;
  }

  const node = {
    child,
    output,
    cwd,
    exit,
    stop,
  };

  running.add(node);
  child.once('close', () => running.delete(node));

  return node;
}

// For a process that must exit by itself: one that keeps running fails the test instead of hanging it.
export async function runNode(script, options) {
  const node = startNode(script, options);
  let isTimedOut = false;

  const timer = setTimeout(() => {
    isTimedOut = true;
    node.child.kill('SIGKILL');
  }, PROCESS_TIMEOUT_MS);
  const result = await node.exit;

  clearTimeout(timer);

  if (isTimedOut) {
    throw new Error(`${script} did not exit within ${PROCESS_TIMEOUT_MS} ms:\n${result.stdout}${result.stderr}`);
  }

  return result;
}

export function waitForOutput({ child, output }, pattern) {
  return new Promise((resolve, reject) => {
    function fail(reason) {
      reject(new Error(`${reason} before ${pattern} appeared in the output:\n${output.stdout}${output.stderr}`));
    }

    const timer = setTimeout(() => fail(`${PROCESS_TIMEOUT_MS} ms passed`), PROCESS_TIMEOUT_MS);

    function check() {
      if (!pattern.test(output.stdout)) {
        return false;
      }

      clearTimeout(timer);
      resolve(output.stdout);

      return true;
    }

    child.stdout.on('data', check);
    child.once('close', () => {
      clearTimeout(timer);
      fail('The process exited');
    });
    check();
  });
}
