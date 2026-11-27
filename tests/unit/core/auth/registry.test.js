import {
  isSessionAlive,
  markSessionAlive,
  markSessionsRevoked,
  watchRevokedSessions,
} from '#core/auth/registry.js';
import { createContext, getContext, runInContext } from '#core/context/index.js';
import { DbError } from '#core/db/error.js';
import { withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { createLogger } from '#core/logger/index.js';
import { createRedis } from '#core/redis/index.js';
import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import { createTestConfig, PROCESS_KEY_PREFIX } from '#root/tests/helper/config.js';
import { createDownDb } from '#root/tests/helper/db.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import {
  createFakeRedis,
  createTcpProxy,
  REDIS_DOWN_ENV,
  RESP_OK,
  toRespArray,
  toRespBulk,
  toRespError,
  waitUntilReady,
} from '#root/tests/helper/redis.js';
import {
  listUntold,
  toRegistryKey,
  UNTOLD_MESSAGE,
  untoldOf,
} from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { addToDate, nowUtc, toDate } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

const LABEL = 'Redis';
const LOOPBACK = '127.0.0.1';
const CRLF = '\r\n';

const ACCESS_TTL_SECONDS = 300;
const ACCESS_TTL_MS = 300_000;
const MEMORY_TTL_MS = 3000;

const AUTH = Object.freeze({ accessTtl: '5m', registryMemoryTtl: '3s' });

const SHORT_TTL_SECONDS = 1;
const SMALL_MEMORY = 2;
const CLOCK_START_MS = 1_000_000;
const LATE_ANSWER_MS = 2000;

const SESSION_LIFE = '30d';
const FROZEN_DATE_MS = Date.UTC(2026, 10, 25);

const LIFETIMES = [
  { leftMs: ACCESS_TTL_MS + 1000, seconds: ACCESS_TTL_SECONDS },
  { leftMs: ACCESS_TTL_MS, seconds: ACCESS_TTL_SECONDS },
  { leftMs: 90_900, seconds: 90 },
  { leftMs: 1000, seconds: 1 },
  { leftMs: 999, seconds: null },
];

const SHORT_COMMAND_TIMEOUT = Object.freeze({ commandTimeout: '0.3s', socketTimeout: '30s' });
const SHORT_READ_TIMEOUT = Object.freeze({ readTimeout: '0.1s' });

// A held answer that a regression never lets go of fails its test at this, instead of holding the run for ever.
const HANG_TIMEOUT_MS = 5000;

const REQUEST_IDS = ['request-1', 'request-2', 'request-3'];

const HANDSHAKE = Object.freeze(['hello', 'client', 'auth', 'info']);

const ALIVE = toRespBulk('1');
const REVOKED = toRespBulk('0');
const ABSENT = toRespBulk(null);
const FOREIGN = toRespBulk('2');
const UNANSWERED = '';
const ONE = `:1${CRLF}`;
const QUEUED = `+QUEUED${CRLF}`;
const REFUSED = toRespError('NOPERM this user has no permissions to run this command');
const NO_MEMORY = toRespError("OOM command not allowed when used memory > 'maxmemory'.");
const ABORTED = toRespError('EXECABORT Transaction discarded because of previous errors.');

const TRANSACTION_TAKEN = Object.freeze({
  multi: RESP_OK,
  set: QUEUED,
  expire: QUEUED,
  exec: `*2${CRLF}${RESP_OK}${ONE}`,
});
const MARK_STANDS = `*2${CRLF}${ABSENT}${ONE}`;
const PIPELINE_TAKEN = Object.freeze({ set: RESP_OK, publish: ONE });

const CHANNEL = `${PROCESS_KEY_PREFIX}auth:revoke`;

const CONNECT_FAILURE = Object.freeze({ code: 'ECONNREFUSED', isConnectFailure: true });
const MISSING_COLUMN = Object.freeze({ code: 'ER_BAD_FIELD_ERROR', errno: 1054 });

const READ_FAILED_MESSAGE = 'The mark of a live session could not be read: the database decides';
const ALIVE_FAILED_MESSAGE = 'The mark of a live session could not be written: the database decides until it is';
const REVOKED_FAILED_MESSAGE = 'Redis did not take a mark of a revoked session, or the message about it';
const UNREADABLE_MESSAGE = 'A message of revoked sessions cannot be read';
const IN_TRANSACTION_MESSAGE = 'isSessionAlive(sid) judges by what is committed: it runs outside withTransaction()';

// Not JSON, so it is warned about: once its line is there, the messages before it have been handled.
const LAST_MESSAGE = 'the last message';

function toKey(sid) {
  return toRegistryKey(PROCESS_KEY_PREFIX, sid);
}

function readOf(sid) {
  return ['get', toKey(sid)];
}

function aliveMarkOf(sid, seconds = ACCESS_TTL_SECONDS) {
  return [
    ['multi'],
    ['set', toKey(sid), '1', 'EX', String(seconds), 'NX'],
    ['expire', toKey(sid), String(seconds)],
    ['exec'],
  ];
}

function revokedMarksOf(sids) {
  return [
    ...sids.map((sid) => ['set', toKey(sid), '0', 'EX', String(ACCESS_TTL_SECONDS)]),
    ['publish', CHANNEL, JSON.stringify(sids)],
  ];
}

function listSent(fake) {
  return fake.commands.filter(([name]) => !HANDSHAKE.includes(name));
}

function answerWith(replies) {
  return ([name]) => replies[name] ?? null;
}

function answerMarks(marks) {
  const replies = new Map(Object.entries(marks).map(([sid, reply]) => [toKey(sid), reply]));

  return ([name, key]) => (name === 'get'
    ? replies.get(key) ?? ABSENT
    : null);
}

// Right behind the confirmation of the subscription: a message before it is none to the client.
function deliverMessages(messages, replies = {}) {
  return ([name, channel]) => {
    if (name === 'subscribe') {
      return [
        `*3${CRLF}${toRespBulk('subscribe')}${toRespBulk(channel)}${ONE}`,
        ...messages.map((message) => toRespArray(['message', channel, message])),
      ].join('');
    }

    return replies[name] ?? null;
  };
}

function toResult(rows) {
  return { rows, fields: [{ name: 'expires_at' }], affectedRows: rows.length };
}

function answerLive() {
  return toResult([{ expires_at: addToDate(nowUtc(), SESSION_LIFE) }]);
}

function answerNothing() {
  return toResult([]);
}

function answerNever() {
  throw new Error('The database was not to be asked');
}

function createStubDb(answer) {
  const questions = [];
  const driver = {
    withConnection: async (fn) => fn({}),
    begin: async () => true,
    commit: async () => true,
    rollback: async () => true,
    destroy: () => true,
  };

  async function query(sql, binding, options) {
    questions.push({ ...binding, ...options });

    return answer(binding.sid);
  }

  return { db: { driver, query }, questions };
}

function questionOf(sid) {
  return { sid, isTimeLimited: true };
}

function bindRegistry(context) {
  return {
    check: (sid) => runInContext(context, () => isSessionAlive(sid)),
    markAlive: (sid, ttlSeconds) => runInContext(context, () => markSessionAlive(sid, ttlSeconds)),
    markRevoked: (sids) => runInContext(context, () => markSessionsRevoked(sids)),
  };
}

function openProcess(t, {
  env = REDIS_DOWN_ENV,
  auth,
  redis: section,
  db,
} = {}) {
  const sink = createLogSink();
  const config = createTestConfig({
    env,
    auth: { ...AUTH, ...auth },
    redis: section,
    logger: { level: 'info', stream: sink.stream },
  });
  const { cache, ...main } = config.redis;
  const log = createLogger(config.logger);
  const redis = createRedis(main, { log, label: LABEL });
  const context = createContext({
    config,
    log,
    db,
    redis,
  });

  t.after(() => redis.close());

  return {
    redis,
    context,
    sink,
    ...bindRegistry(context),
  };
}

// Behind a proxy: the fake answers at once, and a test has to hold an answer on its way.
async function openOnFake(t, { respond, answer = answerNever, ...options }) {
  const fake = await createFakeRedis(t, respond);
  const proxy = await createTcpProxy(t, { host: LOOPBACK, port: fake.port });
  const stub = createStubDb(answer);
  const opened = openProcess(t, { ...options, env: proxy.env, db: stub.db });

  opened.redis.connect();
  await waitUntilReady(opened.redis);

  return {
    ...opened,
    fake,
    proxy,
    stub,
  };
}

function openWithoutRedis(answer) {
  const sink = createLogSink();
  const config = createTestConfig({ auth: AUTH, logger: { level: 'info', stream: sink.stream } });
  const stub = createStubDb(answer);
  const context = createContext({ config, log: createLogger(config.logger), db: stub.db });

  return {
    sink,
    stub,
    ...bindRegistry(context),
  };
}

// The clock the memory of the registry goes by. Timers and Redis go by their own.
function mockClock(t) {
  const clock = { now: CLOCK_START_MS };

  t.mock.method(performance, 'now', () => clock.now);

  return clock;
}

function createSids(count) {
  return Array.from({ length: count }, () => uuidv7());
}

function listProblems(sink) {
  return sink.lines
    .filter((line) => line.level >= LOG_LEVEL.WARN)
    .map((line) => [line.level, line.msg]);
}

function waitForWarnings(sink, count) {
  return waitFor(() => findLogLines(sink, UNREADABLE_MESSAGE).length === count, `${count} warning(s) about a message`);
}

describe('isSessionAlive: what Redis says', () => {
  test('takes "1" for alive and "0" for revoked without a question to the database, and remembers both', async (t) => {
    mockClock(t);

    const [alive, revoked] = createSids(2);
    const { check, fake, stub } = await openOnFake(t, { respond: answerMarks({ [alive]: ALIVE, [revoked]: REVOKED }) });

    assert.deepEqual(await mapSeries([alive, revoked, alive, revoked], check), [true, false, true, false]);
    assert.deepEqual(listSent(fake), [readOf(alive), readOf(revoked)]);
    assert.deepEqual(stub.questions, []);
  });

  test('asks the database about a session without a mark, with a time limit, and writes the mark of a live one back', async (t) => {
    mockClock(t);

    const [sid] = createSids(1);
    const { check, fake, stub } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: ABSENT }),
      answer: answerLive,
    });

    assert.deepEqual(await mapSeries([sid, sid], check), [true, true]);
    assert.deepEqual(stub.questions, [questionOf(sid)]);
    assert.deepEqual(listSent(fake), [readOf(sid), ...aliveMarkOf(sid)]);
  });

  test('writes a mark back for the seconds the session has left when an access token would live longer, and none for less than one', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: FROZEN_DATE_MS });

    const cases = LIFETIMES.map((lifetime) => ({ ...lifetime, sid: uuidv7() }));
    const { check, fake } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: ABSENT }),
      answer: (sid) => toResult([{ expires_at: toDate(FROZEN_DATE_MS + cases.find((item) => item.sid === sid).leftMs) }]),
    });

    assert.deepEqual(await mapSeries(cases.map((item) => item.sid), check), cases.map(() => true));
    assert.deepEqual(listSent(fake), cases.flatMap(({ sid, seconds }) => [
      readOf(sid),
      ...(seconds === null ? [] : aliveMarkOf(sid, seconds)),
    ]));
  });

  test('refuses a session with neither a mark nor a live row, writes nothing back and asks nobody about it again', async (t) => {
    const [sid] = createSids(1);
    const { check, fake, stub } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: ABSENT }),
      answer: answerNothing,
    });

    assert.deepEqual(await mapSeries([sid, sid], check), [false, false]);
    assert.deepEqual(stub.questions, [questionOf(sid)]);
    assert.deepEqual(listSent(fake), [readOf(sid)]);
  });

  test('leaves a mark that says neither to the database, and writes nothing over it', async (t) => {
    const [live, missing] = createSids(2);
    const { check, fake, stub } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: FOREIGN }),
      answer: (sid) => (sid === live ? answerLive() : answerNothing()),
    });

    assert.deepEqual(await mapSeries([live, missing], check), [true, false]);
    assert.deepEqual(stub.questions, [questionOf(live), questionOf(missing)]);
    assert.deepEqual(listSent(fake), [readOf(live), readOf(missing)]);
  });
});

describe('isSessionAlive: a Redis that fails', () => {
  test('leaves a read that Redis refuses to the database, sends no write after it and logs the refusal', async (t) => {
    const [live, missing] = createSids(2);
    const {
      check, fake, stub, sink,
    } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: REFUSED }),
      answer: (sid) => (sid === live ? answerLive() : answerNothing()),
    });

    assert.deepEqual(await mapSeries([live, missing], check), [true, false]);
    assert.deepEqual(stub.questions, [questionOf(live), questionOf(missing)]);
    assert.deepEqual(listSent(fake), [readOf(live), readOf(missing)]);
    assert.deepEqual(listProblems(sink), [[LOG_LEVEL.ERROR, READ_FAILED_MESSAGE]]);
  });

  test('spends one commandTimeout on a Redis that does not answer: the database decides and no write is sent after the read', async (t) => {
    const [sid] = createSids(1);
    const {
      check, fake, stub, sink,
    } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: UNANSWERED }),
      answer: answerLive,
      redis: SHORT_COMMAND_TIMEOUT,
    });

    assert.equal(await check(sid), true);
    assert.deepEqual(stub.questions, [questionOf(sid)]);
    assert.deepEqual(listSent(fake), [readOf(sid)]);
    assert.deepEqual(listProblems(sink), [[LOG_LEVEL.ERROR, READ_FAILED_MESSAGE]]);
  });

  test('leaves every check to the database while Redis is down', async (t) => {
    const [live, missing] = createSids(2);
    const stub = createStubDb((sid) => (sid === live ? answerLive() : answerNothing()));
    const { check, redis } = openProcess(t, { db: stub.db });

    redis.connect();

    assert.deepEqual(await mapSeries([live, missing], check), [true, false]);
    assert.deepEqual(stub.questions, [questionOf(live), questionOf(missing)]);
  });

  test('answers SERVICE_UNAVAILABLE_ERROR when the database is away as well, with the error of the database as its cause', async (t) => {
    const down = await createDownDb(t);
    const { check, redis } = openProcess(t, { db: down.db });

    redis.connect();

    const error = await rejectionOf(check(uuidv7()));

    assert.ok(error instanceof AppError);
    assert.deepEqual([error.code, error.statusCode], ['SERVICE_UNAVAILABLE_ERROR', 503]);
    assert.ok(error.cause instanceof DbError);
    assert.deepEqual([error.cause.code, error.cause.isConnectFailure], ['ECONNREFUSED', true]);
  });
});

describe('isSessionAlive: a database that fails', () => {
  test('gives one failure to everybody who waits for it and remembers nothing: the next check asks again', async (t) => {
    const [sid] = createSids(1);
    const cause = new DbError('away', CONNECT_FAILURE);
    const answers = [() => Promise.reject(cause), answerLive];
    const { check, fake, stub } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: ABSENT }),
      answer: () => answers.shift()(),
    });

    const errors = await Promise.all([check(sid), check(sid)].map((checking) => rejectionOf(checking)));

    assert.deepEqual(errors.map((error) => error instanceof AppError), [true, true]);
    assert.deepEqual(errors.map((error) => [error.code, error.cause === cause]), [['SERVICE_UNAVAILABLE_ERROR', true], ['SERVICE_UNAVAILABLE_ERROR', true]]);
    assert.equal(await check(sid), true);
    assert.deepEqual(stub.questions, [questionOf(sid), questionOf(sid)]);
    assert.deepEqual(listSent(fake), [readOf(sid), readOf(sid), ...aliveMarkOf(sid)]);
  });

  test('waits for one that went silent no longer than readTimeout, and neither remembers nor writes back what it says later', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const [sid] = createSids(1);
    const late = Promise.withResolvers();
    const answers = [() => late.promise, answerLive];
    const { check, fake, stub } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: ABSENT }),
      answer: () => answers.shift()(),
      auth: SHORT_READ_TIMEOUT,
    });

    const errors = await Promise.all([check(sid), check(sid)].map((checking) => rejectionOf(checking)));

    late.resolve(answerLive());
    await nextTurn();

    assert.deepEqual(errors.map((error) => error instanceof AppError), [true, true]);
    assert.deepEqual(errors.map((error) => [error.code, error.cause.code]), [['SERVICE_UNAVAILABLE_ERROR', 'READ_TIMEOUT'], ['SERVICE_UNAVAILABLE_ERROR', 'READ_TIMEOUT']]);
    assert.equal(await check(sid), true);
    assert.deepEqual(stub.questions, [questionOf(sid), questionOf(sid)]);
    assert.deepEqual(listSent(fake), [readOf(sid), readOf(sid), ...aliveMarkOf(sid)]);
  });

  test('rejects with the very error of one that is there and refuses the statement, and remembers nothing', async (t) => {
    const [sid] = createSids(1);
    const refusal = new DbError('Unknown column', MISSING_COLUMN);
    const answers = [() => Promise.reject(refusal), answerLive];
    const { check, stub } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: ABSENT }),
      answer: () => answers.shift()(),
    });

    assert.equal(await rejectionOf(check(sid)), refusal);
    assert.equal(await check(sid), true);
    assert.deepEqual(stub.questions, [questionOf(sid), questionOf(sid)]);
  });
});

describe('isSessionAlive: the memory of the process', () => {
  test('keeps an alive session for registryMemoryTtl from the start of its check, however late the answer, and a read prolongs nothing', async (t) => {
    const clock = mockClock(t);
    const [sid] = createSids(1);
    const { check, fake, proxy } = await openOnFake(t, { respond: answerWith({ get: ALIVE }) });

    proxy.freeze();

    const checking = check(sid);

    clock.now += LATE_ANSWER_MS;
    proxy.thaw();

    assert.equal(await checking, true);

    clock.now = CLOCK_START_MS + MEMORY_TTL_MS - 1;

    assert.equal(await check(sid), true);
    assert.deepEqual(listSent(fake), [readOf(sid)]);

    clock.now = CLOCK_START_MS + MEMORY_TTL_MS;

    assert.equal(await check(sid), true);
    assert.deepEqual(listSent(fake), [readOf(sid), readOf(sid)]);
  });

  test('counts from the start of the check also when the database has answered late', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const clock = mockClock(t);
    const [sid] = createSids(1);
    const held = Promise.withResolvers();
    const answers = [() => held.promise, answerLive];
    const { check, stub } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: ABSENT }),
      answer: () => answers.shift()(),
    });
    const checking = check(sid);

    await waitFor(() => stub.questions.length === 1, 'the question to the database');
    clock.now += LATE_ANSWER_MS;
    held.resolve(answerLive());

    assert.equal(await checking, true);

    clock.now = CLOCK_START_MS + MEMORY_TTL_MS - 1;

    assert.equal(await check(sid), true);
    assert.equal(stub.questions.length, 1);

    clock.now = CLOCK_START_MS + MEMORY_TTL_MS;

    assert.equal(await check(sid), true);
    assert.equal(stub.questions.length, 2);
  });

  test('keeps a revoked session for as long as an access token lives, then asks again', async (t) => {
    const clock = mockClock(t);
    const [read, marked] = createSids(2);
    const { check, markRevoked, fake } = await openOnFake(t, { respond: answerWith({ ...PIPELINE_TAKEN, get: REVOKED }) });

    await markRevoked([marked]);

    assert.equal(await check(read), false);

    clock.now += ACCESS_TTL_MS - 1;

    assert.deepEqual(await mapSeries([read, marked], check), [false, false]);
    assert.deepEqual(listSent(fake), [...revokedMarksOf([marked]), readOf(read)]);

    clock.now += 1;

    assert.deepEqual(await mapSeries([read, marked], check), [false, false]);
    assert.deepEqual(listSent(fake), [...revokedMarksOf([marked]), readOf(read), readOf(read), readOf(marked)]);
  });

  test('holds registryMemoryMaxEntries live sessions, gives up the one asked about longest ago, and lets none of them push out a revoked one', async (t) => {
    mockClock(t);

    const [revoked, first, second, third] = createSids(4);
    const { check, markRevoked, fake } = await openOnFake(t, {
      respond: answerWith({ ...PIPELINE_TAKEN, get: ALIVE }),
      auth: { registryMemoryMaxEntries: SMALL_MEMORY },
    });

    await markRevoked([revoked]);
    await mapSeries([first, second, first, third], check);

    assert.deepEqual(await mapSeries([first, third, revoked, second], check), [true, true, false, true]);
    assert.deepEqual(listSent(fake), [...revokedMarksOf([revoked]), ...[first, second, third, second].map((sid) => readOf(sid))]);
  });

  test('holds registryMemoryMaxEntries revoked sessions as well: one that is given up is asked about again, and its mark refuses it', async (t) => {
    const sids = createSids(SMALL_MEMORY + 1);
    const [givenUp, ...held] = sids;
    const { check, markRevoked, fake } = await openOnFake(t, {
      respond: answerWith({ ...PIPELINE_TAKEN, get: REVOKED }),
      auth: { registryMemoryMaxEntries: SMALL_MEMORY },
    });

    await markRevoked(sids);

    assert.deepEqual(await mapSeries([...held, givenUp], check), sids.map(() => false));
    assert.deepEqual(listSent(fake), [...revokedMarksOf(sids), readOf(givenUp)]);
  });

  test('forgets that a session was alive once it is revoked, also where the others revoked with it push its revocation out at once: it is asked about again, and its mark refuses it', async (t) => {
    mockClock(t);

    const sids = createSids(SMALL_MEMORY + 1);
    const [givenUp] = sids;
    const replies = { ...PIPELINE_TAKEN, get: ALIVE };
    const { check, markRevoked, fake } = await openOnFake(t, {
      respond: answerWith(replies),
      auth: { registryMemoryMaxEntries: SMALL_MEMORY },
    });

    assert.equal(await check(givenUp), true);

    replies.get = REVOKED;
    await markRevoked(sids);

    assert.equal(await check(givenUp), false);
    assert.deepEqual(listSent(fake), [readOf(givenUp), ...revokedMarksOf(sids), readOf(givenUp)]);
  });

  test('refuses a session revoked while the "alive" of Redis was on its way: those who wait for it, and everybody after', async (t) => {
    mockClock(t);

    const [sid] = createSids(1);
    const {
      check, markRevoked, fake, proxy, stub,
    } = await openOnFake(t, { respond: answerWith({ ...PIPELINE_TAKEN, get: ALIVE }) });

    proxy.freeze();

    const checks = [check(sid), check(sid)];
    const marking = markRevoked([sid]);

    proxy.thaw();

    assert.deepEqual(await Promise.all(checks), [false, false]);
    assert.equal(await marking, true);
    assert.equal(await check(sid), false);
    assert.deepEqual(listSent(fake), [readOf(sid), ...revokedMarksOf([sid])]);
    assert.deepEqual(stub.questions, []);
  });

  test('refuses a session revoked while the "alive" of the database was on its way, without waiting for it, and writes "1" only where there is no mark', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    mockClock(t);

    const [sid] = createSids(1);
    const held = Promise.withResolvers();
    const {
      check, markRevoked, fake, stub,
    } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, ...PIPELINE_TAKEN, get: ABSENT }),
      answer: () => held.promise,
    });
    const checks = [check(sid), check(sid)];

    await waitFor(() => stub.questions.length === 1, 'the question to the database');
    await markRevoked([sid]);

    assert.equal(await check(sid), false);

    held.resolve(answerLive());

    assert.deepEqual(await Promise.all(checks), [false, false]);
    assert.equal(await check(sid), false);
    assert.deepEqual(stub.questions, [questionOf(sid)]);
    assert.deepEqual(listSent(fake), [readOf(sid), ...revokedMarksOf([sid]), ...aliveMarkOf(sid)]);
  });

  test('forgets that a session was alive as soon as it is revoked, and a later mark of life brings it back to nobody', async (t) => {
    mockClock(t);

    const [sid] = createSids(1);
    const {
      check, markAlive, markRevoked, fake,
    } = await openOnFake(t, { respond: answerWith({ ...TRANSACTION_TAKEN, ...PIPELINE_TAKEN, get: ALIVE }) });

    assert.equal(await check(sid), true);

    await markRevoked([sid]);

    assert.equal(await check(sid), false);

    await markAlive(sid, ACCESS_TTL_SECONDS);

    assert.equal(await check(sid), false);
    assert.deepEqual(listSent(fake), [readOf(sid), ...revokedMarksOf([sid]), ...aliveMarkOf(sid)]);
  });

  test('belongs to one client of Redis: two apps of one process keep theirs apart', async (t) => {
    const [sid] = createSids(1);
    const respond = answerWith({ ...PIPELINE_TAKEN, get: ALIVE });
    const [revoker, other] = [await openOnFake(t, { respond }), await openOnFake(t, { respond })];

    await revoker.markRevoked([sid]);

    assert.deepEqual([await revoker.check(sid), await other.check(sid)], [false, true]);
    assert.deepEqual(listSent(other.fake), [readOf(sid)]);
  });
});

describe('isSessionAlive: its callers', () => {
  test('asks once for all who come together, and each of them goes on in its own context', async (t) => {
    const [sid] = createSids(1);
    const { context, fake, stub } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, get: ABSENT }),
      answer: answerLive,
    });

    const results = await Promise.all(REQUEST_IDS.map((requestId) => runInContext(createContext({ ...context, requestId }), async () => ({
      isAlive: await isSessionAlive(sid),
      requestId: getContext().requestId,
    }))));

    assert.deepEqual(results, REQUEST_IDS.map((requestId) => ({ isAlive: true, requestId })));
    assert.deepEqual(listSent(fake), [readOf(sid), ...aliveMarkOf(sid)]);
    assert.deepEqual(stub.questions, [questionOf(sid)]);
  });

  test('gives two sessions asked about together each the answer of its own', async (t) => {
    const [alive, revoked] = createSids(2);
    const { check, fake } = await openOnFake(t, { respond: answerMarks({ [alive]: ALIVE, [revoked]: REVOKED }) });

    assert.deepEqual(await Promise.all([check(alive), check(revoked)]), [true, false]);
    assert.deepEqual(listSent(fake), [readOf(alive), readOf(revoked)]);
  });

  test('refuses to run inside withTransaction(), also where the memory knows the answer, asks nobody and remembers nothing', async (t) => {
    const [known, unknown] = createSids(2);
    const {
      check, markRevoked, context, fake, stub,
    } = await openOnFake(t, {
      respond: answerWith({ ...PIPELINE_TAKEN, get: ALIVE }),
    });

    await markRevoked([known]);

    const errors = await runInContext(context, () => withTransaction(() => Promise.all(
      [known, unknown].map((sid) => rejectionOf(isSessionAlive(sid))),
    )));

    assert.deepEqual(errors.map((error) => error.message), [IN_TRANSACTION_MESSAGE, IN_TRANSACTION_MESSAGE]);
    assert.deepEqual(listSent(fake), revokedMarksOf([known]));
    assert.deepEqual(stub.questions, []);
    assert.equal(await check(unknown), true);
  });
});

describe('markSessionAlive', () => {
  test('sends SET NX and EXPIRE in one transaction, and tells that the mark is there whether it has written it or found one', async (t) => {
    const [sid] = createSids(1);
    const replies = [TRANSACTION_TAKEN.exec, MARK_STANDS];
    const { markAlive, fake, sink } = await openOnFake(t, {
      respond: ([name]) => (name === 'exec'
        ? replies.shift()
        : TRANSACTION_TAKEN[name] ?? null),
    });

    assert.deepEqual([await markAlive(sid, ACCESS_TTL_SECONDS), await markAlive(sid, SHORT_TTL_SECONDS)], [true, true]);
    assert.deepEqual(listSent(fake), [...aliveMarkOf(sid), ...aliveMarkOf(sid, SHORT_TTL_SECONDS)]);
    assert.deepEqual(listProblems(sink), []);
  });

  test('tells that a Redis that refuses it has no mark, with one error line, and throws nothing', async (t) => {
    const { markAlive, sink } = await openOnFake(t, {
      respond: answerWith({ ...TRANSACTION_TAKEN, set: REFUSED, exec: ABORTED }),
    });

    assert.equal(await markAlive(uuidv7(), ACCESS_TTL_SECONDS), false);
    assert.deepEqual(listProblems(sink), [[LOG_LEVEL.ERROR, ALIVE_FAILED_MESSAGE]]);
  });

  test('tells that a Redis that is down has no mark, and throws nothing', async (t) => {
    const { markAlive, redis } = openProcess(t);

    redis.connect();

    assert.equal(await markAlive(uuidv7(), ACCESS_TTL_SECONDS), false);
  });
});

describe('markSessionsRevoked', () => {
  test('sends a mark for every session and one message with all of them, in a pipeline and not in a transaction', async (t) => {
    const sids = createSids(3);
    const { markRevoked, fake, sink } = await openOnFake(t, { respond: answerWith(PIPELINE_TAKEN) });

    assert.equal(await markRevoked(sids), true);
    assert.deepEqual(listSent(fake), revokedMarksOf(sids));
    assert.deepEqual(listProblems(sink), []);
  });

  test('is known to its own process before Redis has answered: a check beside it asks nobody', async (t) => {
    const sids = createSids(2);
    const {
      check, markRevoked, fake, stub, sink,
    } = await openOnFake(t, {
      respond: answerWith({ get: ALIVE, set: UNANSWERED, publish: UNANSWERED }),
      redis: SHORT_COMMAND_TIMEOUT,
    });
    const marking = markRevoked(sids);
    const checks = sids.map((sid) => check(sid));

    assert.deepEqual(await Promise.all(checks), [false, false]);
    assert.equal(await marking, false);
    assert.deepEqual(listSent(fake), revokedMarksOf(sids));
    assert.deepEqual(stub.questions, []);
    assert.deepEqual(listUntold(sink), [untoldOf(sids)]);
  });

  test('passes the message on to a Redis that refuses the marks, and names the sessions in one error line', async (t) => {
    const sids = createSids(2);
    const { markRevoked, fake, sink } = await openOnFake(t, { respond: answerWith({ ...PIPELINE_TAKEN, set: NO_MEMORY }) });

    assert.equal(await markRevoked(sids), false);
    assert.deepEqual(listSent(fake), revokedMarksOf(sids));
    assert.deepEqual(listUntold(sink), [untoldOf(sids)]);
    assert.deepEqual(listProblems(sink), [[LOG_LEVEL.ERROR, REVOKED_FAILED_MESSAGE], [LOG_LEVEL.ERROR, UNTOLD_MESSAGE]]);
  });

  test('names the sessions of every call that Redis refuses, also where the failure itself is logged once', async (t) => {
    const [first, second] = [createSids(1), createSids(1)];
    const { markRevoked, sink } = await openOnFake(t, { respond: answerWith({ ...PIPELINE_TAKEN, set: NO_MEMORY }) });

    assert.deepEqual(await mapSeries([first, second], markRevoked), [false, false]);
    assert.deepEqual(listUntold(sink), [untoldOf(first), untoldOf(second)]);
    assert.equal(findLogLines(sink, REVOKED_FAILED_MESSAGE).length, 1);
  });

  test('writes the marks to a Redis that refuses the message, and names the sessions in one error line', async (t) => {
    const sids = createSids(2);
    const { markRevoked, fake, sink } = await openOnFake(t, { respond: answerWith({ ...PIPELINE_TAKEN, publish: REFUSED }) });

    assert.equal(await markRevoked(sids), false);
    assert.deepEqual(listSent(fake), revokedMarksOf(sids));
    assert.deepEqual(listUntold(sink), [untoldOf(sids)]);
    assert.deepEqual(listProblems(sink), [[LOG_LEVEL.ERROR, REVOKED_FAILED_MESSAGE], [LOG_LEVEL.ERROR, UNTOLD_MESSAGE]]);
  });

  test('names the sessions a Redis that is down was not told of in one error line, and its own process refuses them', async (t) => {
    const sids = createSids(2);
    const stub = createStubDb(answerLive);
    const {
      check, markRevoked, redis, sink,
    } = openProcess(t, { db: stub.db });

    redis.connect();

    assert.equal(await markRevoked(sids), false);
    assert.deepEqual(await mapSeries(sids, check), [false, false]);
    assert.deepEqual(stub.questions, []);
    assert.deepEqual(listUntold(sink), [untoldOf(sids)]);
  });

  test('has nothing to tell about an empty list', async (t) => {
    const { markRevoked, fake, sink } = await openOnFake(t, { respond: answerWith(PIPELINE_TAKEN) });

    assert.equal(await markRevoked([]), false);
    assert.deepEqual(listSent(fake), []);
    assert.deepEqual(listProblems(sink), []);
  });
});

describe('a process without Redis', () => {
  test('goes by its own memory and the database', async (t) => {
    mockClock(t);

    const [live, missing] = createSids(2);
    const { check, stub, sink } = openWithoutRedis((sid) => (sid === live ? answerLive() : answerNothing()));

    assert.deepEqual(await mapSeries([live, missing, live, missing], check), [true, false, true, false]);
    assert.deepEqual(stub.questions, [questionOf(live), questionOf(missing)]);
    assert.deepEqual(listProblems(sink), []);
  });

  test('refuses what it has revoked itself at once, and says in one error line that nobody else was told', async () => {
    const sids = createSids(2);
    const {
      check, markRevoked, stub, sink,
    } = openWithoutRedis(answerLive);

    assert.equal(await markRevoked(sids), false);
    assert.deepEqual(await mapSeries(sids, check), [false, false]);
    assert.deepEqual(stub.questions, []);
    assert.deepEqual(listProblems(sink), [[LOG_LEVEL.ERROR, UNTOLD_MESSAGE]]);
    assert.deepEqual(listUntold(sink), [untoldOf(sids)]);
  });

  test('writes no mark of a live session, and throws nothing', async () => {
    const { markAlive, stub, sink } = openWithoutRedis(answerNever);

    assert.equal(await markAlive(uuidv7(), ACCESS_TTL_SECONDS), false);
    assert.deepEqual(stub.questions, []);
    assert.deepEqual(listProblems(sink), []);
  });

  test('keeps what it knows by its database: two of them in one process stay apart', async () => {
    const [sid] = createSids(1);
    const [revoker, other] = [openWithoutRedis(answerLive), openWithoutRedis(answerLive)];

    await revoker.markRevoked([sid]);

    assert.deepEqual([await revoker.check(sid), await other.check(sid)], [false, true]);
  });
});

describe('watchRevokedSessions', () => {
  test('refuses the sessions of a message without a question, and no other, for as long as an access token lives', async (t) => {
    const clock = mockClock(t);
    const [first, second, other] = createSids(3);
    const {
      check, context, fake, sink,
    } = await openOnFake(t, {
      respond: deliverMessages([JSON.stringify([first, second]), LAST_MESSAGE], { get: ALIVE }),
    });

    watchRevokedSessions(context);
    await waitForWarnings(sink, 1);

    assert.deepEqual(await mapSeries([first, second, other], check), [false, false, true]);
    assert.deepEqual(listSent(fake), [['subscribe', CHANNEL], readOf(other)]);

    clock.now += ACCESS_TTL_MS - 1;

    assert.equal(await check(first), false);

    clock.now += 1;

    assert.equal(await check(first), true);
    assert.deepEqual(listSent(fake), [['subscribe', CHANNEL], readOf(other), readOf(first)]);
  });

  test('ignores a message that is not JSON, is no list or holds no UUID, with a warning for each, and goes on listening', async (t) => {
    const [alive, revoked] = createSids(2);
    const unreadable = [
      '',
      'not json',
      '["',
      alive,
      JSON.stringify(alive),
      JSON.stringify({ sids: [alive] }),
      'null',
      '42',
      '[]',
      JSON.stringify([alive.toUpperCase()]),
      JSON.stringify([null, 42, 'session', [alive], { sid: alive }]),
    ];
    const {
      check, context, fake, sink,
    } = await openOnFake(t, {
      respond: deliverMessages([...unreadable, JSON.stringify([revoked]), LAST_MESSAGE], { get: ALIVE }),
    });

    watchRevokedSessions(context);
    await waitForWarnings(sink, unreadable.length + 1);

    assert.deepEqual(await mapSeries([alive, revoked], check), [true, false]);
    assert.deepEqual(listSent(fake), [['subscribe', CHANNEL], readOf(alive)]);
    assert.deepEqual(listProblems(sink), [...unreadable, LAST_MESSAGE].map(() => [LOG_LEVEL.WARN, UNREADABLE_MESSAGE]));
  });

  test('takes the sessions of a list that holds other things as well', async (t) => {
    const [first, second] = createSids(2);
    const {
      check, context, fake, sink,
    } = await openOnFake(t, {
      respond: deliverMessages([JSON.stringify([null, first, 'session', second, { sid: first }]), LAST_MESSAGE], { get: ALIVE }),
    });

    watchRevokedSessions(context);
    await waitForWarnings(sink, 1);

    assert.deepEqual(await mapSeries([first, second], check), [false, false]);
    assert.deepEqual(listSent(fake), [['subscribe', CHANNEL]]);
    assert.deepEqual(listProblems(sink), [[LOG_LEVEL.WARN, UNREADABLE_MESSAGE]]);
  });

  test('gives back the function that stops it', async (t) => {
    const { context, fake } = await openOnFake(t, { respond: deliverMessages([]) });
    const stop = watchRevokedSessions(context);

    await waitFor(() => listSent(fake).length === 1, 'the subscription');

    assert.equal(stop(), true);

    await waitFor(() => listSent(fake).length === 2, 'the end of the subscription');

    assert.deepEqual(listSent(fake), [['subscribe', CHANNEL], ['unsubscribe', CHANNEL]]);
  });
});
