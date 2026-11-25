import { readInTime } from '#core/auth/read.js';
import { readLifetimes, TTL_MIN } from '#core/auth/settings.js';
import { getContext } from '#core/context/index.js';
import { createQuery } from '#core/db/query.js';
import { isInTransaction } from '#core/db/transaction.js';
import { REDIS_FAILURE, runRedisSafely } from '#core/redis/index.js';
import { singleFlight } from '#utils/async.js';
import { convertStringToMs, differenceInSeconds, nowUtc } from '#utils/date.js';
import { isUuid } from '#utils/id.js';
import { readLru, writeLru } from '#utils/lru.js';
import { isArray } from '#utils/type.js';

const SESSION_NAMESPACE = 'session:';
const REVOKE_CHANNEL = 'auth:revoke';

// "Revoked" is final: nothing writes "alive" over it.
const MARK = Object.freeze({ ALIVE: '1', REVOKED: '0' });

const TTL_UNIT = 'EX';
const ONLY_IF_ABSENT = 'NX';

const READ_FAILED_MESSAGE = 'The mark of a live session could not be read: the database decides';
const ALIVE_FAILED_MESSAGE = 'The mark of a live session could not be written: the database decides until it is';
const REVOKED_FAILED_MESSAGE = 'Redis did not take a mark of a revoked session, or the message about it';
const UNTOLD_MESSAGE = 'Sessions are revoked, and Redis did not take all it was told: another process may take an old mark for live until the access token ends';
const UNREADABLE_MESSAGE = 'A message of revoked sessions cannot be read';

const LIVE_SQL = `
  SELECT expires_at
  FROM sessions
  WHERE id = :sid AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
`;

// What this process knows of sessions, for each Redis client: two apps of one process keep theirs apart. Revoked ones
// have a map of their own, so the traffic of live ones cannot push them out before their time.
const states = new WeakMap();

function getState(owner) {
  if (!states.has(owner)) {
    states.set(owner, { alive: new Map(), revoked: new Map(), flights: singleFlight() });
  }

  return states.get(owner);
}

// Without Redis (a script, a test) the process has its own memory and the database.
function findState({ redis, db }) {
  return getState(redis ?? db);
}

function toKey(sid) {
  return `${SESSION_NAMESPACE}${sid}`;
}

function isKnownRevoked(state, sid) {
  return readLru(state.revoked, sid, performance.now()) !== undefined;
}

function isKnownAlive(state, sid) {
  return readLru(state.alive, sid, performance.now()) !== undefined;
}

// For as long as an access token of it may still be out: after that nobody asks.
function rememberRevoked(state, sid, authConfig) {
  state.alive.delete(sid);

  return writeLru(state.revoked, sid, true, {
    until: performance.now() + convertStringToMs(authConfig.accessTtl),
    maxEntries: authConfig.registryMemoryMaxEntries,
  });
}

// Counted from the moment the check began, not from its answer: what it was told is that old.
function rememberAlive(state, sid, authConfig, checkedAt) {
  return writeLru(state.alive, sid, true, {
    until: checkedAt + convertStringToMs(authConfig.registryMemoryTtl),
    maxEntries: authConfig.registryMemoryMaxEntries,
  });
}

// Written only where there is no mark: this one may have been on its way while the session was revoked, and must not
// bring it back. A mark that is there only gets its time again, which a revoked one may have as well.
export async function markSessionAlive(sid, ttlSeconds) {
  const { redis } = getContext();
  const key = toKey(sid);
  const result = await runRedisSafely(
    (client) => client.multi().set(key, MARK.ALIVE, TTL_UNIT, ttlSeconds, ONLY_IF_ABSENT).expire(key, ttlSeconds),
    ALIVE_FAILED_MESSAGE,
    { redis },
  );

  return result !== REDIS_FAILURE;
}

// A pipeline, not a transaction: a Redis that refuses the marks (full, read-only) still passes the message on, and the
// other way round.
function tellRedis(redis, sids, ttlSeconds) {
  return runRedisSafely((client) => sids
    .reduce((pipeline, sid) => pipeline.set(toKey(sid), MARK.REVOKED, TTL_UNIT, ttlSeconds), client.pipeline())
    .publish(redis.toChannel(REVOKE_CHANNEL), JSON.stringify(sids)), REVOKED_FAILED_MESSAGE, { redis });
}

// After the commit of the revocation: for this process at once, then for all of them.
export async function markSessionsRevoked(sids) {
  if (!sids.length) {
    return false;
  }

  const context = getContext();
  const state = findState(context);
  const { auth } = context.config;

  sids.forEach((sid) => rememberRevoked(state, sid, auth));

  const result = await tellRedis(context.redis, sids, readLifetimes(auth).accessTtl);

  if (result === REDIS_FAILURE) {
    context.log.error({ sids }, UNTOLD_MESSAGE);
  }

  return result !== REDIS_FAILURE;
}

function readMark(redis, sid) {
  return runRedisSafely((client) => client.get(toKey(sid)), READ_FAILED_MESSAGE, { redis });
}

async function readLiveSession(sid) {
  const query = createQuery(LIVE_SQL, { sid }, { isTimeLimited: true });

  await query.execute();

  return query.fetch();
}

// Only after Redis has said that it holds no mark: one that has just failed would cost a second timeout.
async function writeMarkBack(sid, expiresAt, authConfig) {
  const secondsLeft = differenceInSeconds(expiresAt, nowUtc());

  return secondsLeft >= TTL_MIN
    ? markSessionAlive(sid, Math.min(readLifetimes(authConfig).accessTtl, secondsLeft))
    : false;
}

async function askDatabase(state, sid, { mark, authConfig }) {
  const session = await readInTime(() => readLiveSession(sid));

  if (session === null) {
    rememberRevoked(state, sid, authConfig);

    return false;
  }

  if (mark === null) {
    await writeMarkBack(sid, session.expiresAt, authConfig);
  }

  return true;
}

async function lookUp(state, sid) {
  const { redis, config: { auth: authConfig } } = getContext();
  const checkedAt = performance.now();
  const mark = await readMark(redis, sid);

  if (mark === MARK.REVOKED) {
    rememberRevoked(state, sid, authConfig);

    return false;
  }

  const isAlive = mark === MARK.ALIVE || await askDatabase(state, sid, { mark, authConfig });

  if (isAlive) {
    rememberAlive(state, sid, authConfig, checkedAt);
  }

  return isAlive;
}

// The memory of the process, then Redis, then the row: whoever is away costs the next one a question, not the session.
// The memory is asked again after the answer: a session revoked meanwhile is revoked, whatever the answer was.
export async function isSessionAlive(sid) {
  if (isInTransaction()) {
    throw new Error('isSessionAlive(sid) judges by what is committed: it runs outside withTransaction()');
  }

  const state = findState(getContext());

  if (isKnownRevoked(state, sid)) {
    return false;
  }

  if (isKnownAlive(state, sid)) {
    return true;
  }

  const isAlive = await state.flights(sid, () => lookUp(state, sid));

  return isAlive && !isKnownRevoked(state, sid);
}

function readSids(message) {
  try {
    const sids = JSON.parse(message);

    return isArray(sids)
      ? sids.filter((sid) => isUuid(sid))
      : [];
  } catch {
    return [];
  }
}

// Every process listens to the revocations of the others. The handler runs outside any context: what it needs is here.
export function watchRevokedSessions({ redis, config, log }) {
  const state = getState(redis);

  return redis.subscribe(REVOKE_CHANNEL, (message) => {
    const sids = readSids(message);

    if (!sids.length) {
      log.warn(UNREADABLE_MESSAGE);
    }

    sids.forEach((sid) => rememberRevoked(state, sid, config.auth));
  });
}
