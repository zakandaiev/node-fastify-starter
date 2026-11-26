export const SCOPE_ALL = '*';

export const SCOPE_SEPARATOR = ':';

// <resource>:* grants every action of its resource, those the catalog gains later too.
export const SCOPE_WILDCARD = `${SCOPE_SEPARATOR}${SCOPE_ALL}`;

export const SCOPE = Object.freeze({
  GROUPS_ALL: 'groups:*',
  GROUPS_READ: 'groups:read',
  GROUPS_MANAGE: 'groups:manage',
  USERS_ALL: 'users:*',
  USERS_READ: 'users:read',
});

// What a group may hold: "*" is not here, full access is the flag of a group. The name and the description are an
// English fallback: the frontend translates by the code.
export const SCOPE_CATALOG = Object.freeze([
  Object.freeze({ code: SCOPE.GROUPS_ALL, name: 'Groups: everything', description: 'Every action on groups, also those added later' }),
  Object.freeze({ code: SCOPE.GROUPS_READ, name: 'Read groups', description: 'See the groups and the scopes they grant' }),
  Object.freeze({ code: SCOPE.GROUPS_MANAGE, name: 'Manage groups', description: 'Create, change and delete groups and their members, within the scopes one holds' }),
  Object.freeze({ code: SCOPE.USERS_ALL, name: 'Users: everything', description: 'Every action on users, also those added later' }),
  Object.freeze({ code: SCOPE.USERS_READ, name: 'Read users', description: 'See the users and their profiles' }),
]);

export const SCOPE_CODES = Object.freeze(SCOPE_CATALOG.map((entry) => entry.code));
