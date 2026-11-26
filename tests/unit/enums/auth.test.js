import { writeAudit } from '#core/audit/index.js';
import { createContext, runInContext } from '#core/context/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { AUTH_ROUTE } from '#enums/auth-route.js';
import { CLIENT_AUTHENTICATION } from '#enums/client-authentication.js';
import { COOKIE } from '#enums/cookie.js';
import { GROUP_SLUG } from '#enums/group.js';
import { IDENTITY_LINK_REASON } from '#enums/identity-link-reason.js';
import {
  SCOPE,
  SCOPE_ALL,
  SCOPE_CATALOG,
  SCOPE_CODES,
  SCOPE_SEPARATOR,
  SCOPE_WILDCARD,
} from '#enums/scope.js';
import { TOKEN_TYPE } from '#enums/token-type.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const ACTION_COLUMN_LENGTH = 64;

const SCOPE_CODE_REGEXP = /^[a-z]+(?:-[a-z]+)*:(?:[a-z]+(?:-[a-z]+)*|\*)$/;
const CATALOG_ENTRY_KEYS = Object.freeze(['code', 'name', 'description']);
const CATALOG_CODES = Object.freeze(SCOPE_CATALOG.map(({ code }) => code));

const NO_TRANSACTION_MESSAGE = 'writeAudit({ action, entityType, entityId, actorId, meta, request }) runs inside withTransaction(), with the action it records';

const context = createContext({ config: {}, log: {} });

// Outside a transaction no record is written, and an action that is not one is refused for that first.
function refuseRecord(action) {
  return rejectionOf(runInContext(context, () => writeAudit({ action })));
}

describe('COOKIE', () => {
  test('names the cookies of the two tokens, of their two markers and of a sign-in on its way through a provider', () => {
    assert.deepEqual(COOKIE, {
      ACCESS_TOKEN: 'accessToken',
      REFRESH_TOKEN: 'refreshToken',
      HAS_SESSION: 'hasSession',
      HAS_ACCESS: 'hasAccess',
      OAUTH_STATE: 'oauthState',
      OAUTH_REDIRECT: 'oauthRedirect',
    });
    assert.ok(Object.isFrozen(COOKIE));
  });
});

describe('TOKEN_TYPE', () => {
  test('names the two kinds of tokens, each name being its value in upper case', () => {
    assert.deepEqual(Object.values(TOKEN_TYPE), ['access', 'refresh']);
    assert.ok(Object.isFrozen(TOKEN_TYPE));
    Object.entries(TOKEN_TYPE).forEach(([name, type]) => assert.equal(name, type.toUpperCase()));
  });
});

describe('AUDIT_ACTION', () => {
  test('names the actions of audit_logs, each name being its action in upper case with an underscore for the dot', () => {
    assert.deepEqual(AUDIT_ACTION, {
      GROUP_CREATE: 'group.create',
      GROUP_UPDATE: 'group.update',
      GROUP_DELETE: 'group.delete',
      SESSION_REFRESH_REPLAY: 'session.refresh_replay',
      USER_GROUP_GRANT: 'user.group_grant',
      USER_GROUP_REVOKE: 'user.group_revoke',
      USER_IDENTITY_LINK: 'user.identity_link',
    });
    assert.ok(Object.isFrozen(AUDIT_ACTION));
    Object.entries(AUDIT_ACTION).forEach(([name, action]) => assert.equal(name, action.replaceAll('.', '_').toUpperCase()));
  });

  test('every action is one writeAudit() takes and its column holds', async () => {
    const actions = Object.values(AUDIT_ACTION);
    const errors = await Promise.all(actions.map((action) => refuseRecord(action)));
    const wrongError = await refuseRecord('SESSION_REFRESH_REPLAY');

    assert.deepEqual(errors.map((error) => error.message), actions.map(() => NO_TRANSACTION_MESSAGE));
    assert.equal(wrongError.name, 'TypeError');
    actions.forEach((action) => assert.ok(action.length <= ACTION_COLUMN_LENGTH, action));
  });
});

describe('SCOPE_ALL', () => {
  test('is the one scope that stands for every other', () => {
    assert.equal(SCOPE_ALL, '*');
  });
});

describe('SCOPE_SEPARATOR', () => {
  test('parts the resource of a scope from its action', () => {
    assert.equal(SCOPE_SEPARATOR, ':');
  });
});

describe('SCOPE_WILDCARD', () => {
  test('is the separator and "*": the end of the scope that grants every action of its resource', () => {
    assert.equal(SCOPE_WILDCARD, ':*');
    assert.equal(SCOPE_WILDCARD, `${SCOPE_SEPARATOR}${SCOPE_ALL}`);
  });
});

describe('SCOPE', () => {
  test('names the scopes, each name being its code in upper case with an underscore for the separator and ALL for "*"', () => {
    assert.deepEqual(SCOPE, {
      GROUPS_ALL: 'groups:*',
      GROUPS_READ: 'groups:read',
      GROUPS_MANAGE: 'groups:manage',
      USERS_ALL: 'users:*',
      USERS_READ: 'users:read',
    });
    assert.ok(Object.isFrozen(SCOPE));
    Object.entries(SCOPE).forEach(([name, code]) => {
      assert.equal(name, code.replace(SCOPE_WILDCARD, `${SCOPE_SEPARATOR}ALL`).replaceAll(SCOPE_SEPARATOR, '_').toUpperCase());
    });
  });

  test('holds exactly the codes of the catalog, and not "*"', () => {
    assert.deepEqual(Object.values(SCOPE).toSorted(), CATALOG_CODES.toSorted());
    assert.equal(Object.values(SCOPE).includes(SCOPE_ALL), false);
  });
});

describe('SCOPE_CATALOG', () => {
  test('is frozen together with its entries', () => {
    assert.ok(isDeepFrozen(SCOPE_CATALOG));
  });

  test('gives every scope a code in lower case: a resource and an action, or a resource and "*"', () => {
    CATALOG_CODES.forEach((code) => assert.match(code, SCOPE_CODE_REGEXP));
  });

  test('lists each code once, and never "*": full access is the flag of a group, not a scope of the catalog', () => {
    assert.equal(new Set(CATALOG_CODES).size, CATALOG_CODES.length);
    assert.equal(CATALOG_CODES.includes(SCOPE_ALL), false);
  });

  test('has the wildcard of a resource only beside an action of that resource', () => {
    const wildcards = CATALOG_CODES.filter((code) => code.endsWith(SCOPE_WILDCARD));
    const actions = CATALOG_CODES.filter((code) => !code.endsWith(SCOPE_WILDCARD));

    assert.notDeepEqual(wildcards, []);
    wildcards.forEach((wildcard) => {
      const resource = wildcard.slice(0, -SCOPE_WILDCARD.length);

      assert.ok(actions.some((action) => action.startsWith(`${resource}${SCOPE_SEPARATOR}`)), wildcard);
    });
  });

  test('describes every scope by its code, a name and a description, the last two for a fallback the frontend translates by the code', () => {
    SCOPE_CATALOG.forEach((entry) => {
      assert.deepEqual(Object.keys(entry), CATALOG_ENTRY_KEYS, entry.code);
      [entry.name, entry.description].forEach((text) => {
        assert.equal(typeof text, 'string', entry.code);
        assert.notEqual(text.trim(), '', entry.code);
      });
    });
  });
});

describe('SCOPE_CODES', () => {
  test('is frozen and lists the codes of the catalog in the order of the catalog', () => {
    assert.ok(Object.isFrozen(SCOPE_CODES));
    assert.deepEqual(SCOPE_CODES, CATALOG_CODES);
  });
});

describe('GROUP_SLUG', () => {
  test('names the group the seed creates and the code grants by its slug: the one of the administrators', () => {
    assert.deepEqual(GROUP_SLUG, { ADMIN: 'admin' });
    assert.ok(Object.isFrozen(GROUP_SLUG));
  });
});

describe('AUTH_ROUTE', () => {
  test('names the routes of the auth folder that are no provider\'s, each name being its segment in upper case', () => {
    assert.deepEqual(AUTH_ROUTE, {
      ME: 'me',
      PROVIDERS: 'providers',
      REFRESH: 'refresh',
      LOGOUT: 'logout',
      LOGIN_DEV: 'login-dev',
    });
    assert.ok(Object.isFrozen(AUTH_ROUTE));
    Object.entries(AUTH_ROUTE).forEach(([name, segment]) => assert.equal(name, segment.replaceAll('-', '_').toUpperCase()));
  });
});

describe('IDENTITY_LINK_REASON', () => {
  test('names how the record of an identity linked to an account says it was found: by a verified email, or by its user', () => {
    assert.deepEqual(IDENTITY_LINK_REASON, { EMAIL: 'email', LINK: 'link' });
    assert.ok(Object.isFrozen(IDENTITY_LINK_REASON));
  });
});

describe('CLIENT_AUTHENTICATION', () => {
  test('names the two ways a client proves itself to a token endpoint, in the words of OpenID Connect', () => {
    assert.deepEqual(CLIENT_AUTHENTICATION, { POST: 'client_secret_post', BASIC: 'client_secret_basic' });
    assert.ok(Object.isFrozen(CLIENT_AUTHENTICATION));
  });
});
