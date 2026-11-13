import { createTestEnv } from '#root/tests/helper/config.js';
import { createWorkDir, getFreePort, runNode } from '#root/tests/helper/process.js';
import {
  findUnavailableServices,
  getServiceAddress,
  getServiceSkip,
  isPortOpen,
  readGreeting,
} from '#root/tests/helper/service.js';
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, test } from 'node:test';

const HOST = '127.0.0.1';
const PRINT_SERVICE_SKIP = 'tests/fixture/print-service-skip.js';

function listen(t, onConnection) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      // isPortOpen() hangs up right after connecting, which resets the connection on this side.
      socket.on('error', () => {});
      onConnection(socket);
    });

    t.after(() => new Promise((done) => { server.close(done); }));
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}

function greet(socket) {
  socket.end('hello');
}

function echo(socket) {
  socket.once('data', (chunk) => socket.end(`echo:${chunk}`));
}

async function createEnv(t) {
  const [openPort, closedPort] = await Promise.all([listen(t, greet), getFreePort()]);

  return createTestEnv({
    APP_DATABASE_HOST: HOST,
    APP_DATABASE_PORT: String(openPort),
    APP_REDIS_HOST: HOST,
    APP_REDIS_PORT: String(closedPort),
  });
}

describe('isPortOpen', () => {
  test('tells an open port from a closed one', async (t) => {
    const [openPort, closedPort] = await Promise.all([listen(t, greet), getFreePort()]);

    assert.equal(await isPortOpen({ host: HOST, port: openPort }), true);
    assert.equal(await isPortOpen({ host: HOST, port: closedPort }), false);
  });
});

describe('readGreeting', () => {
  test('returns what the service sends on connect', async (t) => {
    const port = await listen(t, greet);

    assert.equal(await readGreeting({ host: HOST, port }), 'hello');
  });

  test('returns the answer to a command', async (t) => {
    const port = await listen(t, echo);

    assert.equal(await readGreeting({ host: HOST, port }, 'PING'), 'echo:PING');
  });

  test('returns an empty string for a closed port', async () => {
    assert.equal(await readGreeting({ host: HOST, port: await getFreePort() }), '');
  });
});

describe('getServiceAddress', () => {
  test('takes the address of a service from env', async (t) => {
    const env = await createEnv(t);

    assert.deepEqual(getServiceAddress('mariadb', env), { host: HOST, port: env.APP_DATABASE_PORT });
    assert.deepEqual(getServiceAddress('redis', env), { host: HOST, port: env.APP_REDIS_PORT });
  });

  test('rejects an unknown service', () => {
    assert.throws(() => getServiceAddress('postgres'), /Unknown service "postgres"/);
  });
});

describe('findUnavailableServices', () => {
  test('returns the services whose port is closed', async (t) => {
    const env = await createEnv(t);

    assert.deepEqual(await findUnavailableServices(['mariadb', 'redis'], env), ['redis']);
    assert.deepEqual(await findUnavailableServices(['mariadb'], env), []);
  });
});

describe('getServiceSkip', () => {
  test('returns false when every service is reachable', async (t) => {
    const env = await createEnv(t);

    assert.equal(await getServiceSkip(['mariadb'], { env, isRequired: true }), false);
  });

  test('returns the reason to skip when a service is down', async (t) => {
    const env = await createEnv(t);
    const reason = await getServiceSkip(['mariadb', 'redis'], { env, isRequired: false });

    assert.match(reason, /^redis not reachable/);
  });

  test('throws instead of skipping where skipping is not allowed', async (t) => {
    const env = await createEnv(t);

    await assert.rejects(
      getServiceSkip(['mariadb', 'redis'], { env, isRequired: true }),
      /must not be skipped here, but redis not reachable/,
    );
  });

  test('does not allow a skip in CI, and allows it elsewhere', async (t) => {
    const cwd = await createWorkDir(t);
    const env = { APP_REDIS_HOST: HOST, APP_REDIS_PORT: String(await getFreePort()) };
    const [inCi, locally] = await Promise.all(
      ['true', ''].map((CI) => runNode(PRINT_SERVICE_SKIP, { cwd, env: { ...env, CI } })),
    );

    assert.equal(inCi.code, 1);
    assert.match(inCi.stderr, /must not be skipped here, but redis not reachable/);
    assert.equal(locally.code, 0);
    assert.match(locally.stdout, /^redis not reachable/);
  });
});
