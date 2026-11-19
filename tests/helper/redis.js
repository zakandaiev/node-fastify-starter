import { createContext, runInContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import { createRedis } from '#core/redis/index.js';
import {
  createTestConfig,
  createTestEnv,
  PROCESS_KEY_PREFIX,
  REDIS_TEST_PREFIX,
} from '#root/tests/helper/config.js';
import { DATABASE_PREFIX, readDatabaseId } from '#root/tests/helper/db.js';
import { getServiceSkip, reportSkip } from '#root/tests/helper/service.js';
import { isStaleId } from '#root/tests/helper/stale.js';
import { chunk } from '#utils/array.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import { randomToken } from '#utils/random.js';
import { Redis } from 'ioredis';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { after } from 'node:test';

const ID_LENGTH = 36;
const LOOPBACK = '127.0.0.1';

const SCAN_COUNT = 1000;
const UNLINK_BATCH = 500;
const READY_TIMEOUT = '5s';

const KEY_SEPARATOR = ':';
const CACHE_NAMESPACE = 'cache:';
const TABLE_VERSION_NAMESPACE = 'table-version:';
const NO_EXPIRY = -1;

const SKIPPED_TEST_NAME = 'integration tests on Redis';
const LABEL = 'Test Redis';

const GLOB_SPECIAL_REGEXP = /[*?[\]\\]/g;

const ACL_USER_PREFIX = 'nfs-test-';

// Nothing listens on port 1: a Redis that is down, which no other test file can start to listen on meanwhile.
export const REDIS_DOWN_ENV = Object.freeze({ APP_REDIS_HOST: LOOPBACK, APP_REDIS_PORT: '1' });

// Short enough to watch several reconnects within a test.
export const FAST_RECONNECT = Object.freeze({ reconnectStep: '0.05s', reconnectMaxDelay: '0.1s' });

const REDIS_ENV_KEYS = Object.freeze(['APP_REDIS_HOST', 'APP_REDIS_PORT', 'APP_REDIS_USER', 'APP_REDIS_PASSWORD']);

// The Redis the tests reach, which .env or the environment may name, for the .env of a child process:
// a child gets no APP_* of this process.
export function readRedisEnv() {
  return pick(createTestEnv(), REDIS_ENV_KEYS);
}

export function createKeyPrefix(id = uuidv7()) {
  return `${REDIS_TEST_PREFIX}${id}${KEY_SEPARATOR}`;
}

export function toScanPattern(prefix) {
  return `${prefix.replace(GLOB_SPECIAL_REGEXP, (character) => `\\${character}`)}*`;
}

// Not through createRedis(): a broken client must not break the cleanup of its own tests. And without a key prefix:
// SCAN returns whole keys, and a prefixed client would put its prefix in front of them again.
export function connectAdmin(env = createTestEnv()) {
  return new Redis({
    host: env.APP_REDIS_HOST,
    port: env.APP_REDIS_PORT,
    username: env.APP_REDIS_USER,
    password: env.APP_REDIS_PASSWORD,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
}

async function scanFrom(admin, pattern, cursor, keys) {
  const [next, batch] = await admin.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);

  keys.push(...batch);

  return next === '0'
    ? keys
    : scanFrom(admin, pattern, next, keys);
}

export function scanKeys(admin, pattern) {
  return scanFrom(admin, pattern, '0', []);
}

async function unlinkKeys(admin, keys) {
  await Promise.all(chunk(keys, UNLINK_BATCH).map((batch) => admin.unlink(...batch)));

  return keys.length;
}

function isStaleTestKey(key) {
  return isStaleId(key.slice(REDIS_TEST_PREFIX.length, REDIS_TEST_PREFIX.length + ID_LENGTH));
}

// A process a test starts, such as the server, names its keys after its database: <app>:nfs_test_<uuidv7>:...
function isStaleDatabaseKey(key) {
  const databaseId = readDatabaseId(key.split(KEY_SEPARATOR)[1] ?? '');

  return databaseId !== null && isStaleId(databaseId);
}

// Only what a killed run left, an hour old: the keys of the files that run beside this one are younger.
export async function removeStaleKeys(admin) {
  const databasePrefix = `${createTestConfig().app.name}${KEY_SEPARATOR}${DATABASE_PREFIX}`;
  const [testKeys, databaseKeys] = await Promise.all([
    scanKeys(admin, toScanPattern(REDIS_TEST_PREFIX)),
    scanKeys(admin, toScanPattern(databasePrefix)),
  ]);

  return unlinkKeys(admin, [
    ...testKeys.filter((key) => isStaleTestKey(key)),
    ...databaseKeys.filter((key) => isStaleDatabaseKey(key)),
  ]);
}

export async function removeKeys(admin, prefix) {
  return unlinkKeys(admin, await scanKeys(admin, toScanPattern(prefix)));
}

// An account a killed run left behind: named by the tests with a UUIDv7, an hour old.
export async function removeStaleUsers(admin) {
  const stale = (await admin.acl('USERS'))
    .filter((user) => user.startsWith(ACL_USER_PREFIX) && isStaleId(user.slice(ACL_USER_PREFIX.length)));

  await Promise.all(stale.map((user) => admin.acl('DELUSER', user)));

  return stale.length;
}

// An account of Redis with the rules a test gives it, on the keys and channels of the file only. A client that logs
// in with it is closed before remove(), or it goes on retrying a refused password.
export async function createAclUser(admin, rules) {
  const user = `${ACL_USER_PREFIX}${uuidv7()}`;
  const password = randomToken();

  await admin.acl('SETUSER', user, 'on', `>${password}`, `~${PROCESS_KEY_PREFIX}*`, `&${PROCESS_KEY_PREFIX}*`, ...rules);

  function remove() {
    return admin.acl('DELUSER', user);
  }

  return { env: { APP_REDIS_USER: user, APP_REDIS_PASSWORD: password }, remove };
}

// Every key a test file has written is checked before it goes: a cache entry always has a TTL, a table version
// never has one. Keys under a namespace of their own (another prefix inside the file's) are not the cache's.
async function assertKeyTtls(admin, prefix) {
  const keys = (await scanKeys(admin, toScanPattern(prefix))).filter((key) => {
    const name = key.slice(prefix.length);

    return name.startsWith(CACHE_NAMESPACE) || name.startsWith(TABLE_VERSION_NAMESPACE);
  });
  const ttls = await Promise.all(keys.map((key) => admin.pttl(key)));
  const wrong = keys.filter((key, index) => (key.slice(prefix.length).startsWith(CACHE_NAMESPACE)
    ? ttls[index] <= 0
    : ttls[index] !== NO_EXPIRY));

  assert.deepEqual(wrong, [], 'A cache key without a TTL or a table version with one');

  return keys.length;
}

// Resolves once the client is ready, or fails the test at the deadline: a client of the tests that cannot connect
// must fail its test, not wait for ever.
export async function waitUntilReady(redis, timeout = READY_TIMEOUT) {
  assert.equal(await redis.whenReady({ timeout }), true, `${redis.label} did not get ready within ${timeout}`);

  return true;
}

function toRedisSections(sections, keyPrefix) {
  return { ...sections, redis: { keyPrefix, ...sections.redis } };
}

// A client of createRedis() on the prefix of the file, started as the entrypoint starts its clients, with a context
// that holds it as both the main and the cache Redis. The client logs with "log", the context with "contextLog"
// when one is given, so a test tells a line of a request from one of the client. "label" names it in the log.
function openRedis(scope, sections = {}, { label = LABEL, contextLog } = {}) {
  const config = createTestConfig(toRedisSections(sections, scope.keyPrefix));
  const log = createLogger(config.logger);
  const { cache, ...main } = config.redis;
  const redis = createRedis(main, { log, label });
  const context = createContext({
    config,
    log: contextLog?.(log) ?? log,
    redis,
    cacheRedis: redis,
  });

  function run(fn) {
    return runInContext(context, fn);
  }

  scope.clients.push(redis);
  redis.connect();

  return {
    config,
    log,
    redis,
    context,
    run,
  };
}

// The admin client goes whatever fails before: it reconnects for ever and would hold the file open.
async function removeScope(scope) {
  await Promise.allSettled(scope.clients.map((redis) => redis.close()));

  try {
    await assertKeyTtls(scope.admin, scope.keyPrefix);
  } finally {
    try {
      await removeKeys(scope.admin, scope.keyPrefix);
    } finally {
      scope.admin.disconnect();
    }
  }
}

// For the test file that calls this at its top level: its keys carry the prefix of its process, are checked and
// removed after its last test, and nothing is ever flushed. Without Redis it returns only "skip", the reason for
// describe(name, { skip }); in CI it throws instead.
export async function createTestRedis() {
  const skip = await getServiceSkip(['redis']);

  if (skip) {
    return { skip: reportSkip(SKIPPED_TEST_NAME, skip) };
  }

  const admin = connectAdmin();

  await admin.connect();
  await Promise.all([removeStaleKeys(admin), removeStaleUsers(admin)]);

  const scope = { keyPrefix: PROCESS_KEY_PREFIX, admin, clients: [] };
  const opened = openRedis(scope);

  function readKeys() {
    return scanKeys(admin, toScanPattern(scope.keyPrefix));
  }

  after(() => removeScope(scope));
  await waitUntilReady(opened.redis);

  return {
    skip: false,
    keyPrefix: scope.keyPrefix,
    admin,
    open: openRedis.bind(null, scope),
    readKeys,
    ...opened,
  };
}

function trackSocket(proxy, socket) {
  proxy.sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => proxy.sockets.delete(socket));

  if (proxy.isFrozen) {
    socket.pause();
  }

  return socket;
}

function joinThroughProxy(proxy, client, target) {
  const upstream = trackSocket(proxy, net.connect(target));

  trackSocket(proxy, client);
  client.on('data', (bytes) => upstream.write(bytes));
  upstream.on('data', (bytes) => client.write(bytes));
  client.once('close', () => upstream.destroy());
  upstream.once('close', () => client.destroy());

  return true;
}

function killProxied(proxy) {
  const count = proxy.sockets.size;

  proxy.sockets.forEach((socket) => socket.destroy());

  return count;
}

function setFrozen(proxy, isFrozen) {
  proxy.isFrozen = isFrozen;
  proxy.sockets.forEach((socket) => (isFrozen
    ? socket.pause()
    : socket.resume()));

  return true;
}

// A server that hangs, which a closed port cannot stand for: frozen, the proxy holds the bytes as TCP does and passes
// them on in order once thawed, and a connection torn down meanwhile takes what it held with it.
export async function createTcpProxy(t, target) {
  const proxy = { isFrozen: false, sockets: new Set() };
  const server = net.createServer((client) => joinThroughProxy(proxy, client, target));

  t.after(() => {
    killProxied(proxy);
    server.close();
  });

  server.listen(0, LOOPBACK);
  await once(server, 'listening');

  const { port } = server.address();

  return {
    port,
    env: Object.freeze({ APP_REDIS_HOST: LOOPBACK, APP_REDIS_PORT: String(port) }),
    freeze: () => setFrozen(proxy, true),
    thaw: () => setFrozen(proxy, false),
    kill: () => killProxied(proxy),
    countConnections: () => proxy.sockets.size / 2,
  };
}

// A server that takes connections and never says a word: TCP is up, the protocol never starts.
// It counts every connection it has taken.
export async function createSilentServer(t) {
  const sockets = new Set();
  let acceptedCount = 0;
  const server = net.createServer((socket) => {
    acceptedCount += 1;
    sockets.add(socket);
    socket.on('error', () => {});
  });

  function countAccepted() {
    return acceptedCount;
  }

  t.after(() => {
    sockets.forEach((socket) => socket.destroy());
    server.close();
  });

  server.listen(0, LOOPBACK);
  await once(server, 'listening');

  return { port: server.address().port, countAccepted };
}

const CRLF = '\r\n';
const ARRAY_MARK = 0x2a;
const BULK_MARK = 0x24;

export const RESP_OK = `+OK${CRLF}`;
const RESP_PONG = `+PONG${CRLF}`;

export function toRespError(text) {
  return `-${text}${CRLF}`;
}

export function toRespBulk(text) {
  return text === null
    ? `$-1${CRLF}`
    : `$${Buffer.byteLength(text)}${CRLF}${text}${CRLF}`;
}

export function toRespArray(texts) {
  return `*${texts.length}${CRLF}${texts.map((text) => toRespBulk(text)).join('')}`;
}

export const FAKE_RUN_ID = 'f'.repeat(40);

// What ioredis sends is one array of bulk strings for each command, several of them in one chunk at times.
// Null until the whole command is there.
function readCommand(buffer) {
  if (buffer[0] !== ARRAY_MARK) {
    return null;
  }

  const countEnd = buffer.indexOf(CRLF);

  if (countEnd < 0) {
    return null;
  }

  const count = Number(buffer.subarray(1, countEnd).toString());
  const args = [];
  let offset = countEnd + CRLF.length;

  for (let index = 0; index < count; index += 1) {
    const sizeEnd = buffer.indexOf(CRLF, offset);

    if (buffer[offset] !== BULK_MARK || sizeEnd < 0) {
      return null;
    }

    const size = Number(buffer.subarray(offset + 1, sizeEnd).toString());
    const start = sizeEnd + CRLF.length;

    if (buffer.length < start + size + CRLF.length) {
      return null;
    }

    args.push(buffer.subarray(start, start + size).toString());
    offset = start + size + CRLF.length;
  }

  return { args, length: offset };
}

// Just enough of Redis for a client to get ready: HELLO is refused as unknown (the client goes on in RESP2),
// AUTH and CLIENT pass, INFO says the server is loaded. "respond" answers first; null leaves the command to these.
function answerByDefault(args) {
  const name = args[0].toUpperCase();

  if (name === 'HELLO') {
    return toRespError("ERR unknown command 'HELLO'");
  }

  if (['AUTH', 'CLIENT', 'SELECT', 'QUIT'].includes(name)) {
    return RESP_OK;
  }

  if (name === 'PING') {
    return RESP_PONG;
  }

  if (name === 'INFO') {
    return toRespBulk(['# Server', 'redis_version:8.0.0', `run_id:${FAKE_RUN_ID}`, 'loading:0', ''].join(CRLF));
  }

  return toRespError(`ERR unknown command '${args[0]}'`);
}

// A Redis of the tests' own making that answers what "respond" says: for what the real one will not do on demand,
// such as refusing a password or loading its data for ever. It records every command it received.
export async function createFakeRedis(t, respond = () => null) {
  const sockets = new Set();
  const commands = [];

  function drain(socket, buffer) {
    const command = readCommand(buffer);

    if (!command) {
      return buffer;
    }

    commands.push(command.args);
    socket.write(respond(command.args) ?? answerByDefault(command.args));

    return drain(socket, buffer.subarray(command.length));
  }

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);

    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (bytes) => {
      buffer = drain(socket, Buffer.concat([buffer, bytes]));
    });
  });

  function kill() {
    const count = sockets.size;

    sockets.forEach((socket) => socket.destroy());

    return count;
  }

  t.after(() => {
    kill();
    server.close();
  });

  server.listen(0, LOOPBACK);
  await once(server, 'listening');

  return { port: server.address().port, commands, kill };
}
