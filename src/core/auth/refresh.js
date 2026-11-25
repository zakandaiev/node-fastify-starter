import { alert } from '#core/alert/index.js';
import { writeAudit } from '#core/audit/index.js';
import { readClient } from '#core/auth/client.js';
import { createUnavailableError, isDatabaseAway, readInTime } from '#core/auth/read.js';
import { markSessionAlive, markSessionsRevoked } from '#core/auth/registry.js';
import { isAtMaxAge, issueTokens, verifyRefreshToken } from '#core/auth/token.js';
import { readUserScopes } from '#core/authz/scope.js';
import { getContext } from '#core/context/index.js';
import { isLockConflict, isTransactionTimeout } from '#core/db/error.js';
import { getDb } from '#core/db/index.js';
import { createQuery } from '#core/db/query.js';
import { afterCommit, retryOnLockConflict, withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { TABLE } from '#enums/table.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import { USER_STATUS } from '#enums/user-status.js';
import { singleFlight } from '#utils/async.js';
import { sha256, timingSafeEqual } from '#utils/hash.js';

// By the clock of the database, as every other statement judges a session: what the list, the limit and the revocation
// take for over must not come back to life.
const READ_SQL = `
  SELECT s.refresh_token_hash, s.started_at, s.expires_at
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.id = :sid AND s.user_id = :userId AND u.status = :status AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP(3)
`;

// SYSDATE is the moment the row is compared, behind its lock; CURRENT_TIMESTAMP is the start of the statement.
const ROTATE_SQL = `
  UPDATE sessions
  SET refresh_token_hash = :refreshTokenHash, rotated_at = CURRENT_TIMESTAMP(3), expires_at = :expiresAt, user_agent = :userAgent, ip = :ip
  WHERE id = :sid AND refresh_token_hash = :presentedHash AND revoked_at IS NULL AND expires_at > SYSDATE(3)
`;

const END_SQL = 'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = :sid AND revoked_at IS NULL';

const RETRY_MESSAGE = 'The token of a session is set again after a lock conflict';
const LOST_MESSAGE = 'A refresh lost the race: the row of its session has changed since it was read, or its pair went to another request';
const ABANDONED_MESSAGE = 'Every client that asked for a rotation had gone by the time it was done';
const REPLAY_MESSAGE = 'A refresh token that had been replaced was used again';
const REPLAY_TITLE = 'Refresh token replay';
const REPLAY_KEY = 'session-refresh-replay';
const KEY_SEPARATOR = ':';

// The refreshes on their way in this process, by the hash of the token presented. Of two that come together the second
// may read the row a moment after the first has rotated it, and would be taken for a replay.
const flightsByDb = new WeakMap();

function getFlights() {
  const db = getDb();

  if (!flightsByDb.has(db)) {
    flightsByDb.set(db, singleFlight());
  }

  return flightsByDb.get(db);
}

async function readSession({ sid, userId }) {
  const query = createQuery(READ_SQL, { sid, userId, status: USER_STATUS.ACTIVE }, { isTimeLimited: true });

  await query.execute();

  return query.fetch();
}

// Nobody is named as the actor: it is the user or a thief, and which of them nobody knows. An actor would also take the
// row of the user after the row of the session, the other way round than a sign-in.
async function endReplayed(session, request) {
  const query = createQuery(END_SQL, { sid: session.sid });

  await query.execute();
  await afterCommit(() => markSessionsRevoked([session.sid]));

  if (query.affectedRows() === 0) {
    return false;
  }

  await writeAudit({
    action: AUDIT_ACTION.SESSION_REFRESH_REPLAY,
    entityType: TABLE.SESSIONS,
    entityId: session.sid,
    meta: { userId: session.userId },
    request,
  });
  await afterCommit(() => alert({
    title: REPLAY_TITLE,
    dedupeKey: [REPLAY_KEY, session.sid].join(KEY_SEPARATOR),
    error: { message: REPLAY_MESSAGE, ...session },
    throttleClass: THROTTLE_CLASS.WARNING,
    request,
    isDetached: true,
  }));

  return true;
}

// The line goes first: a database that fails here must not take the only trace of the replay with it. Answered 503 then,
// the client comes back with the same token, and is found again.
async function refuseReplay(session, request) {
  getContext().log.warn(session, REPLAY_MESSAGE);

  try {
    await withTransaction(() => endReplayed(session, request), { retry: true });
  } catch (error) {
    throw isLockConflict(error) || isDatabaseAway(error) || isTransactionTimeout(error)
      ? createUnavailableError(error)
      : error;
  }

  throw new AppError(ERROR_CODE.SESSION_REVOKED);
}

async function sendRotation(binding) {
  const query = createQuery(ROTATE_SQL, binding);

  await query.execute();

  return query.affectedRows() > 0;
}

// The same statement once more after a lock conflict: it cannot rotate twice, and what the token is was decided before.
// What was not sent, or not done, is a 503. A connection lost with the statement on its way leaves nobody knowing
// whether it was done: that stays a 500, since a client told to come back would come with the old token.
async function rotateRow(binding) {
  try {
    return await retryOnLockConflict(() => sendRotation(binding), RETRY_MESSAGE);
  } catch (error) {
    throw isLockConflict(error) || error?.isConnectFailure === true
      ? createUnavailableError(error)
      : error;
  }
}

function refuseLost(sid) {
  getContext().log.warn({ sid }, LOST_MESSAGE);

  throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
}

function isNever() {
  return false;
}

function findRecipient(callers) {
  return callers.find((caller) => !caller.isAbandoned());
}

// Everything that can fail goes before the UPDATE, the signing too.
async function prepare(claims, presentedHash, request) {
  const { sid, userId } = claims;
  const session = await readInTime(() => readSession(claims));

  if (session === null) {
    throw new AppError(ERROR_CODE.SESSION_REVOKED);
  }

  if (!timingSafeEqual(session.refreshTokenHash, presentedHash)) {
    return refuseReplay(claims, request);
  }

  const scopes = await readInTime(() => readUserScopes(userId));

  if (isAtMaxAge(session.startedAt)) {
    throw new AppError(ERROR_CODE.SESSION_REVOKED);
  }

  const { issued, refreshTokenHash, expiresAt } = issueTokens({
    userId,
    sid,
    scopes,
    startedAt: session.startedAt,
  });

  return {
    issued,
    rotation: {
      sid, presentedHash, refreshTokenHash, expiresAt,
    },
    previousExpiresAt: session.expiresAt,
  };
}

// The new pair has not left the process, so the token the client still holds may be the current one again: left as it is,
// the client would come back with it and be taken for a thief. A 503 tells that this was not done: the pair is the current
// one, and goes to whoever has come meanwhile. After any other failure nobody knows which of the two is.
async function takeBack(rotation, previousExpiresAt, callers) {
  let isTakenBack = false;

  try {
    isTakenBack = await rotateRow({
      ...rotation,
      presentedHash: rotation.refreshTokenHash,
      refreshTokenHash: rotation.presentedHash,
      expiresAt: previousExpiresAt,
    });
  } catch (error) {
    const recipient = error instanceof AppError
      ? findRecipient(callers)
      : null;

    if (!recipient) {
      throw error;
    }

    return recipient;
  } finally {
    getContext().log.warn({ sid: rotation.sid, isTakenBack }, ABANDONED_MESSAGE);
  }

  return null;
}

// The pair goes to the first caller whose client is still there, also when it has joined the flight of one that has gone.
// They are looked at before the UPDATE, behind it and behind Redis, since each may wait. What was taken back is made again
// for whoever has come meanwhile, with the same pair.
async function handOver(prepared, callers) {
  const { issued, rotation, previousExpiresAt } = prepared;
  const asker = findRecipient(callers);

  if (!asker) {
    throw new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
  }

  const binding = { ...rotation, ...asker.client };

  if (!(await rotateRow(binding))) {
    return refuseLost(rotation.sid);
  }

  if (findRecipient(callers)) {
    await markSessionAlive(rotation.sid, issued.accessTtl);
  }

  const recipient = findRecipient(callers) ?? await takeBack(binding, previousExpiresAt, callers);

  return recipient
    ? { issued, recipient }
    : handOver(prepared, callers);
}

// 401 AUTHENTICATION_ERROR: no usable token, or the row has changed since it was read. 401 SESSION_REVOKED: the session
// is over, also by this very call. 503: nothing was rotated.
export async function refreshSession({ token, request, isAbandoned = isNever } = {}) {
  const claims = verifyRefreshToken(token);

  if (claims === null) {
    throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
  }

  const presentedHash = sha256(token);

  // Read before anything is waited for: Node forgets the address of a socket that has closed.
  const caller = { isAbandoned, client: readClient(request) };
  const { issued, recipient } = await getFlights()(
    presentedHash,
    async (callers) => handOver(await prepare(claims, presentedHash, request), callers),
    caller,
  );

  return recipient === caller
    ? issued
    : refuseLost(claims.sid);
}
