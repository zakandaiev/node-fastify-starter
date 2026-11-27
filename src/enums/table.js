export const TABLE = Object.freeze({
  USERS: 'users',
  USER_IDENTITIES: 'user_identities',
  GROUPS: 'groups',
  GROUP_SCOPES: 'group_scopes',
  USER_GROUPS: 'user_groups',
  AUDIT_LOGS: 'audit_logs',
  SESSIONS: 'sessions',
});

// The tables whose rows a delete in a table reaches through a foreign key (ON DELETE CASCADE or SET NULL): the server
// changes them with no statement of theirs. A test compares it with the foreign keys of the migrations.
export const TABLE_DEPENDENTS = Object.freeze({
  [TABLE.USERS]: Object.freeze([TABLE.USER_IDENTITIES, TABLE.USER_GROUPS, TABLE.SESSIONS]),
  [TABLE.GROUPS]: Object.freeze([TABLE.GROUP_SCOPES, TABLE.USER_GROUPS]),
});
