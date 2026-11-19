import { resolvePath } from '#config/path.js';
import { createTestConfig, PROCESS_KEY_PREFIX, REDIS_TEST_PREFIX } from '#root/tests/helper/config.js';
import {
  createFakeRedis,
  createKeyPrefix,
  createTcpProxy,
  REDIS_DOWN_ENV,
  toScanPattern,
} from '#root/tests/helper/redis.js';
import { uuidVersion } from '#utils/id.js';
import { Redis } from 'ioredis';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import nodePath from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const UUID_VERSION = 7;
const PREFIX_REGEXP = /^nfs-test:([0-9a-f-]{36}):$/;

// "FLUSH" is spelled in two parts here, so that this file does not find itself.
const FLUSH_REGEXP = new RegExp(`\\b${'FLU'}SH(ALL|DB)\\b`, 'i');
const SOURCE_DIRECTORIES = ['src', 'scripts', 'tests'];

const QUIET_MS = 100;

async function listSources(directory) {
  const entries = await readdir(resolvePath(directory), { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => nodePath.join(entry.parentPath, entry.name));
}

function connectTo(port) {
  return new Redis({
    host: '127.0.0.1', port, lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null,
  });
}

describe('Redis helper', () => {
  test('gives every config of the tests the key prefix of its process: the prefix of the tests and a UUIDv7', () => {
    const [, id] = PREFIX_REGEXP.exec(PROCESS_KEY_PREFIX);

    assert.equal(uuidVersion(id), UUID_VERSION);
    assert.ok(PROCESS_KEY_PREFIX.startsWith(REDIS_TEST_PREFIX));
    assert.equal(createTestConfig().redis.keyPrefix, PROCESS_KEY_PREFIX);
    assert.match(createKeyPrefix(), PREFIX_REGEXP);
    assert.notEqual(createKeyPrefix(), PROCESS_KEY_PREFIX);
  });

  test('escapes what SCAN reads as a pattern', () => {
    assert.equal(toScanPattern('a*b?c[d]e\\f:'), 'a\\*b\\?c\\[d\\]e\\\\f:*');
  });

  test('takes for a Redis that is down a port nothing listens on', async () => {
    const socket = net.connect({ host: REDIS_DOWN_ENV.APP_REDIS_HOST, port: Number(REDIS_DOWN_ENV.APP_REDIS_PORT) });
    const [error] = await new Promise((resolve) => {
      socket.once('error', (err) => resolve([err]));
      socket.once('connect', () => resolve([null]));
    });

    socket.destroy();
    assert.equal(error?.code, 'ECONNREFUSED');
  });

  test('nothing in the repository flushes a Redis: tests remove their own keys', async () => {
    const files = (await Promise.all(SOURCE_DIRECTORIES.map((directory) => listSources(directory)))).flat();
    const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const flushing = files.filter((file, index) => FLUSH_REGEXP.test(texts[index]));

    assert.ok(files.length > 0);
    assert.deepEqual(flushing, []);
  });

  test('a fake Redis gets a client ready, answers what it is told and records what it received', async (t) => {
    const fake = await createFakeRedis(t, (args) => (args[0] === 'get'
      ? '$5\r\nvalue\r\n'
      : null));
    const client = connectTo(fake.port);

    t.after(() => client.disconnect());
    await client.connect();

    assert.equal(await client.get('key'), 'value');
    await assert.rejects(client.lpush('list', 'x'), /unknown command/);
    assert.ok(fake.commands.some((args) => args[0] === 'info'));
  });

  test('a frozen proxy holds the bytes and passes them on in order once thawed; kill() drops its connections', async (t) => {
    const fake = await createFakeRedis(t, (args) => (args[0] === 'get'
      ? `$${args[1].length}\r\n${args[1]}\r\n`
      : null));
    const proxy = await createTcpProxy(t, { host: '127.0.0.1', port: fake.port });
    const client = connectTo(proxy.port);

    t.after(() => client.disconnect());
    await client.connect();
    proxy.freeze();

    let isAnswered = false;

    async function ask() {
      const value = await client.get('first');

      isAnswered = true;

      return value;
    }

    const answer = ask();

    await sleep(QUIET_MS);
    assert.equal(isAnswered, false);

    proxy.thaw();
    assert.equal(await answer, 'first');
    assert.equal(await client.get('second'), 'second');
    assert.equal(proxy.countConnections(), 1);
    assert.equal(proxy.kill(), 2);
  });
});
