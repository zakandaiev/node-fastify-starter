import { markSessionAlive, markSessionsRevoked } from '#core/auth/registry.js';
import { issueTokens } from '#core/auth/token.js';
import { assertActiveUser, lockUsers } from '#core/auth/user.js';
import { readUserScopes } from '#core/authz/scope.js';
import { getContext } from '#core/context/index.js';
import { createQuery } from '#core/db/query.js';
import { afterCommit, withTransaction } from '#core/db/transaction.js';
import { ISOLATION_LEVEL } from '#enums/isolation-level.js';
import { nowUtc } from '#utils/date.js';
import { assertUuid, uuidv7 } from '#utils/id.js';

// Under REPEATABLE READ a locking read fails once another session has changed its row since the first plain read of
// the transaction, and every refresh of the user changes one. A transaction around these calls names both, and only the
// level is checked; it also locks the row of the user before anything that refers to the user.
export const SESSION_TRANSACTION = Object.freeze({ isolation: ISOLATION_LEVEL.READ_COMMITTED, retry: true });

const INSERT_SQL = `
  INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, user_agent, ip, is_dev)
  VALUES (:sid, :userId, :refreshTokenHash, :expiresAt, :userAgent, :ip, :isDev)
`;

// Without the index named, the server reads a small table whole, and locks the sessions of everyone with it: here, and
// in the UPDATE of a list of a dozen ids.
const LOCK_LIVE_SQL = `
  SELECT id
  FROM sessions FORCE INDEX (idx_sessions_user)
  WHERE user_id = :userId AND id <> :exceptSid AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
  ORDER BY rotated_at, id
  FOR UPDATE
`;

const REVOKE_LIST_SQL = 'UPDATE sessions FORCE INDEX (PRIMARY) SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id IN (:sids)';

const REVOKE_OWN_SQL = `
  UPDATE sessions
  SET revoked_at = CURRENT_TIMESTAMP(3)
  WHERE id = :sid AND user_id = :userId AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
`;

const LIST_SQL = `
  SELECT id, user_agent, ip, is_dev, started_at, rotated_at, expires_at
  FROM sessions
  WHERE user_id = :userId AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
  ORDER BY rotated_at DESC, id DESC
`;

const NO_SID = '00000000-0000-0000-0000-000000000000';

function assertUserId(userId, signature) {
  return assertUuid(userId, signature, 'a user');
}

function assertSid(sid, signature) {
  return assertUuid(sid, signature, 'a session');
}

// No statement on sessions is cached, so none of them moves a version of the table: a refresh of anyone would move it,
// and the marks of the registry would wait for Redis behind it.
async function run(sql, binding) {
  const query = createQuery(sql, binding);

  await query.execute();

  return query;
}

// The status is read under the lock: a block that has committed meanwhile refuses the sign-in, and one that waits for
// this lock will see the session.
async function lockActiveUser(userId) {
  const [user = null] = await lockUsers([userId]);

  return assertActiveUser(user);
}

async function revokeByIds(sids) {
  if (!sids.length) {
    return false;
  }

  await run(REVOKE_LIST_SQL, { sids });
  await afterCommit(() => markSessionsRevoked(sids));

  return true;
}

async function lockLiveSids(userId, exceptSid) {
  const rows = (await run(LOCK_LIVE_SQL, { userId, exceptSid })).fetchAll();

  return rows.map((row) => row.id);
}

async function evictAboveLimit(userId, newSid) {
  const { maxSessions } = getContext().config.auth;
  const sids = await lockLiveSids(userId, newSid);
  const excess = sids.length + 1 - maxSessions;

  return revokeByIds(sids.slice(0, Math.max(0, excess)));
}

async function insertSession({ userId, client, isDev }) {
  const sid = uuidv7();

  await lockActiveUser(userId);

  const scopes = await readUserScopes(userId);
  const { issued, refreshTokenHash, expiresAt } = issueTokens({
    userId,
    sid,
    scopes,
    startedAt: nowUtc(),
  });

  await run(INSERT_SQL, {
    sid,
    userId,
    refreshTokenHash,
    expiresAt,
    userAgent: client.userAgent,
    ip: client.ip,
    isDev,
  });
  await afterCommit(() => markSessionAlive(sid, issued.accessTtl));
  await evictAboveLimit(userId, sid);

  return issued;
}

// The tokens are signed before the commit and belong to nobody until it: whoever gets them must not hand them out from
// inside a transaction around this call. A user who is blocked, or is there no more, gets 403.
export async function createSession({ userId, client, isDev = false } = {}) {
  const signature = 'createSession({ userId, client, isDev })';

  assertUserId(userId, signature);

  if (!client) {
    throw new TypeError(`${signature} requires the client of the request: readClient(request)`);
  }

  return withTransaction(() => insertSession({ userId, client, isDev }), SESSION_TRANSACTION);
}

export async function revokeSession({ sid, userId } = {}) {
  const signature = 'revokeSession({ sid, userId })';

  assertUserId(userId, signature);
  assertSid(sid, signature);

  const isRevoked = (await run(REVOKE_OWN_SQL, { sid, userId })).affectedRows() > 0;

  if (isRevoked) {
    await afterCommit(() => markSessionsRevoked([sid]));
  }

  return isRevoked;
}

async function revokeLive(userId, exceptSid) {
  await lockUsers([userId]);

  const sids = await lockLiveSids(userId, exceptSid);

  await revokeByIds(sids);

  return sids.length;
}

// The row of the user first, as in createSession(): a sign-in on its way is either seen here or refused by what this
// call is a part of, such as a block.
export async function revokeAllSessions(userId, { except = NO_SID } = {}) {
  const signature = 'revokeAllSessions(userId, { except })';

  assertUserId(userId, signature);
  assertSid(except, signature);

  return withTransaction(() => revokeLive(userId, except), SESSION_TRANSACTION);
}

export async function listSessions(userId) {
  assertUserId(userId, 'listSessions(userId)');

  return (await run(LIST_SQL, { userId })).fetchAll();
}
