import {
  assertScopeRequirement,
  assertWantedScopes,
  isEveryScopeGranted,
  isRequirementMet,
  readGroupGrants,
} from '#core/authz/match.js';
import { createQuery } from '#core/db/query.js';
import { isInTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { USER_STATUS } from '#enums/user-status.js';
import { unique } from '#utils/array.js';
import { isUuid } from '#utils/id.js';
import { isObject } from '#utils/type.js';

const GRANTS_SQL = `
  SELECT g.is_superadmin, gs.scope
  FROM user_groups ug
  JOIN groups g ON g.id = ug.group_id
  LEFT JOIN group_scopes gs ON gs.group_id = g.id
  WHERE ug.user_id = :userId
`;

const HOLDS_SIGNATURE = 'assertActorHolds(actor, { requirement, scopes })';

// What the groups of a user grant together, sorted. Never cached: it goes into a token, which keeps it long enough.
export async function readUserScopes(userId) {
  const query = createQuery(GRANTS_SQL, { userId }, { isTimeLimited: true });

  await query.execute();

  const grants = query.fetchAll().flatMap((row) => readGroupGrants({
    isSuperadmin: row.isSuperadmin,
    scopes: row.scope === null
      ? []
      : [row.scope],
  }));

  return grants.includes(SCOPE_ALL)
    ? [SCOPE_ALL]
    : unique(grants).toSorted();
}

function assertHoldsCall(actor, { requirement, scopes }) {
  if (actor !== null && !(isObject(actor) && isUuid(actor.id))) {
    throw new TypeError(`${HOLDS_SIGNATURE} requires the locked row of the actor { id, status }, or null for one who is there no more`);
  }

  assertScopeRequirement(requirement, HOLDS_SIGNATURE);
  assertWantedScopes(scopes, HOLDS_SIGNATURE);

  if (!isInTransaction()) {
    throw new Error(`${HOLDS_SIGNATURE} judges under the lock of the row of the actor: it runs inside withTransaction()`);
  }
}

// By the database, not by the token: a demoted or blocked actor would act for the life of the token. One who is not
// active, or is there no more, holds nothing.
export async function assertActorHolds(actor, { requirement, scopes } = {}) {
  assertHoldsCall(actor, { requirement, scopes });

  const held = actor?.status === USER_STATUS.ACTIVE
    ? await readUserScopes(actor.id)
    : [];
  if (!isRequirementMet(held, requirement) || !isEveryScopeGranted(held, scopes)) {
    throw new AppError(ERROR_CODE.AUTHORIZATION_ERROR);
  }

  return true;
}
