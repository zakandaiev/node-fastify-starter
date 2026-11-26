import { writeAudit } from '#core/audit/index.js';
import { createContext, runInContext } from '#core/context/index.js';
import { AUDIT_ACTION } from '#enums/audit-action.js';
import { AUTH_ROUTE } from '#enums/auth-route.js';
import { CLIENT_AUTHENTICATION } from '#enums/client-authentication.js';
import { COOKIE } from '#enums/cookie.js';
import { GROUP_SLUG } from '#enums/group.js';
import { IDENTITY_LINK_REASON } from '#enums/identity-link-reason.js';
import { SCOPE_ALL } from '#enums/scope.js';
import { TOKEN_TYPE } from '#enums/token-type.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const ACTION_COLUMN_LENGTH = 64;

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
      SESSION_REFRESH_REPLAY: 'session.refresh_replay',
      USER_GROUP_GRANT: 'user.group_grant',
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
