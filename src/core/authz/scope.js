import { readGroupGrants } from '#core/authz/match.js';
import { createQuery } from '#core/db/query.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { unique } from '#utils/array.js';

const GRANTS_SQL = `
  SELECT g.is_superadmin, gs.scope
  FROM user_groups ug
  JOIN groups g ON g.id = ug.group_id
  LEFT JOIN group_scopes gs ON gs.group_id = g.id
  WHERE ug.user_id = :userId
`;

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
