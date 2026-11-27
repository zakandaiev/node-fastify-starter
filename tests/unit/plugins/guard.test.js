import { authenticate } from '#core/auth/authenticate.js';
import { SCOPES_DECORATOR } from '#core/schema/route.js';
import { COOKIE } from '#enums/cookie.js';
import { SCOPE, SCOPE_ALL } from '#enums/scope.js';
import useAuth from '#root/src/plugins/130.auth.js';
import useGuard from '#root/src/plugins/140.guard.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import {
  assertRefused,
  buildOpenApp,
  buildPluginApp,
  countCalls,
  describeHeaders,
  DONE_SCHEMA,
  FORBIDDEN,
  issueFor,
  leaveName,
  NO_STORE,
  readState,
  REVOKED,
  UNAUTHENTICATED,
  withoutUser,
} from '#root/tests/helper/guard.js';
import { buildDownApp, REVOKED_MARK } from '#root/tests/helper/session.js';
import { idParam } from '#schemas/common/request.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import fp from 'fastify-plugin';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  GROUPS_ALL,
  GROUPS_MANAGE,
  GROUPS_READ,
  USERS_ALL,
  USERS_READ,
} = SCOPE;

const GUARDED = Object.freeze({ auth: true });
const PUBLIC = Object.freeze({ auth: false });
const READ = Object.freeze({ auth: true, scopes: [GROUPS_READ] });
const MANAGE = Object.freeze({ auth: true, scopes: [GROUPS_MANAGE] });

const ITEMS_URL = '/api/v1/items';
const EARLY_URL = '/api/v1/early';
const ITEM_BODY = Object.freeze({
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', maxLength: 20 } },
});

const OUT_OF_REACH = 'has security.scopes and is out of reach of the guard plugin, which guards what is declared after it, in scopes opened after it';
const AUTH_OUT_OF_REACH = 'has security: { auth: true } and is out of reach of the auth plugin, which guards what is declared after it, in scopes opened after it';

const GUARD_SIGNATURE = 'fastify.guard.scope(requirement)';
const LIST_MESSAGE = `${GUARD_SIGNATURE} requires a non-empty list of scopes: ['a', 'b'] for one of them, [['a', 'b']] for both`;

const HOLDERS = Object.freeze({
  'no scope': [],
  'groups:read': [GROUPS_READ],
  'groups:manage': [GROUPS_MANAGE],
  'users:read': [USERS_READ],
  'groups:read and users:read': [GROUPS_READ, USERS_READ],
  'groups:manage and users:read': [GROUPS_MANAGE, USERS_READ],
  'groups:*': [GROUPS_ALL],
  'groups:* and users:read': [GROUPS_ALL, USERS_READ],
  'users:*': [USERS_ALL],
  '*': [SCOPE_ALL],
  'near misses of groups:read': ['GROUPS:READ', 'groups:read ', 'groups', 'groups:*x', 'read'],
});

const REQUIREMENTS = Object.freeze([
  ['one scope', [GROUPS_READ], ['groups:read', 'groups:read and users:read', 'groups:*', 'groups:* and users:read', '*']],
  ['any of two', [GROUPS_READ, GROUPS_MANAGE], [
    'groups:read',
    'groups:manage',
    'groups:read and users:read',
    'groups:manage and users:read',
    'groups:*',
    'groups:* and users:read',
    '*',
  ]],
  ['all of two', [[GROUPS_READ, USERS_READ]], ['groups:read and users:read', 'groups:* and users:read', '*']],
  ['any of two pairs', [[GROUPS_READ, USERS_READ], [GROUPS_MANAGE, USERS_READ]], [
    'groups:read and users:read',
    'groups:manage and users:read',
    'groups:* and users:read',
    '*',
  ]],
  ['a scope or a pair', [GROUPS_MANAGE, [GROUPS_READ, USERS_READ]], [
    'groups:manage',
    'groups:read and users:read',
    'groups:manage and users:read',
    'groups:*',
    'groups:* and users:read',
    '*',
  ]],
  ['a pair of one', [[USERS_READ]], [
    'users:read',
    'groups:read and users:read',
    'groups:manage and users:read',
    'groups:* and users:read',
    'users:*',
    '*',
  ]],
]);

function listPlugins(plugin) {
  return plugin
    ? [fp(plugin)]
    : [];
}

function buildGuardAround(t, { earlier, between } = {}) {
  return buildPluginApp(t, [...listPlugins(earlier), useAuth, ...listPlugins(between), useGuard]);
}

function declareScoped(fastify, url) {
  fastify.get(url, { schema: DONE_SCHEMA, security: READ }, () => ({ isDone: true }));
}

function appendHookOf(events, name) {
  async function useAppender(instance) {
    instance.addHook('onRoute', (routeOptions) => {
      routeOptions.onRequest = [...[routeOptions.onRequest ?? []].flat(), leaveName(events, name)];
    });
  }

  return useAppender;
}

function readStatuses(responses) {
  return responses.map((response) => response.statusCode);
}

function injectAs(fastify, requests, issued) {
  return Promise.all(requests.map((request) => fastify.inject({ ...request, cookies: issued?.cookies })));
}

function unknownMessage(code) {
  return `${GUARD_SIGNATURE} names "${code}", which is no action of the scope catalog in src/enums/scope.js: a typo would leave the route to full access alone`;
}

describe('guard plugin', () => {
  test('is registered under the name "guard" and marks the requests of what it reaches, as the route hook looks for', async (t) => {
    const fastify = await buildDownApp(t);

    assert.equal(fastify.hasPlugin('guard'), true);
    assert.equal(fastify.hasRequestDecorator(SCOPES_DECORATOR), true);
  });
});

describe('guard plugin: a route with scopes', () => {
  test('answers 401 that names the Bearer scheme without a token anybody can use and for a session that is over, with the scope or without it, and 403 AUTHORIZATION_ERROR that names none without the scope: nothing may be stored and the handler never runs', async (t) => {
    const endedSid = uuidv7();
    const fastify = await buildOpenApp(t, { marks: { [endedSid]: REVOKED_MARK } });
    const { calls, handler } = countCalls();

    fastify.get('/scoped', { security: READ }, handler);

    const reader = issueFor(fastify, [GROUPS_READ]);
    const ended = [[GROUPS_READ], [USERS_READ]].map((scopes) => issueFor(fastify, scopes, { sid: endedSid }));
    const unusable = [
      {},
      { cookies: { [COOKIE.ACCESS_TOKEN]: 'garbage' } },
      { cookies: { [COOKIE.ACCESS_TOKEN]: reader.refreshToken } },
      { cookies: { [COOKIE.REFRESH_TOKEN]: reader.refreshToken } },
      { headers: { authorization: 'Bearer garbage' }, cookies: reader.cookies },
    ];
    const lacking = [[], [USERS_READ], [GROUPS_MANAGE], [USERS_ALL]].map((scopes) => issueFor(fastify, scopes));
    const [ofGuests, ofEnded, ofLacking] = await Promise.all([
      Promise.all(unusable.map((request) => fastify.inject({ url: '/scoped', ...request }))),
      Promise.all(ended.flatMap(({ cookies, headers }) => [{ cookies }, { headers }]).map((request) => fastify.inject({ url: '/scoped', ...request }))),
      Promise.all(lacking.flatMap(({ cookies, headers }) => [{ cookies }, { headers }]).map((request) => fastify.inject({ url: '/scoped', ...request }))),
    ]);

    assertRefused(ofGuests, UNAUTHENTICATED);
    assertRefused(ofEnded, REVOKED);
    assertRefused(ofLacking, FORBIDDEN);
    assert.equal(calls.count, 0);
  });

  test('serves a holder of the scope, of its wildcard or of "*", by the cookie or by the Bearer header, with the user and the session of the token and nothing to store', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get('/scoped', { security: READ }, readState);

    const holders = [[GROUPS_READ], [USERS_READ, GROUPS_READ], [GROUPS_ALL], [SCOPE_ALL]].map((scopes) => issueFor(fastify, scopes));
    const responses = await Promise.all(holders.flatMap(({ cookies, headers }) => [
      fastify.inject({ url: '/scoped', cookies }),
      fastify.inject({ url: '/scoped', headers }),
    ]));

    assert.deepEqual(responses.map((response) => describeHeaders(response)), responses.map(() => [200, NO_STORE, undefined]));
    assert.deepEqual(responses.map((response) => response.json()), holders.flatMap(({ userId, sid, scopes }) => [
      { user: { id: userId, scopes }, session: { id: sid } },
      { user: { id: userId, scopes }, session: { id: sid } },
    ]));
  });

  test('lets through only the holders that meet the requirement in each of its forms, and refuses the rest with 403', async (t) => {
    const fastify = await buildOpenApp(t);

    REQUIREMENTS.forEach(([, scopes], index) => {
      fastify.get(`/scoped/${index}`, { security: { auth: true, scopes } }, countCalls().handler);
    });

    const holders = Object.entries(HOLDERS).map(([name, scopes]) => [name, issueFor(fastify, scopes).cookies]);
    const results = await Promise.all(REQUIREMENTS.map(async ([name], index) => {
      const responses = await Promise.all(holders.map(([, cookies]) => fastify.inject({ url: `/scoped/${index}`, cookies })));

      return [name, Object.fromEntries(holders.map(([holder], at) => [holder, responses[at].statusCode]))];
    }));

    assert.deepEqual(results, REQUIREMENTS.map(([name, , allowed]) => [
      name,
      Object.fromEntries(Object.keys(HOLDERS).map((holder) => [holder, allowed.includes(holder) ? 200 : 403])),
    ]));
  });

  test('a guest gets 401 and a user without the scope 403 whatever the body, its type or the id in the path, and only a holder of the scope learns what is wrong with the request', async (t) => {
    const fastify = await buildOpenApp(t);
    const { calls, handler } = countCalls();
    const params = idParam('Item id');

    fastify.post('/items/:id', { schema: { params, body: ITEM_BODY }, security: READ }, handler);
    fastify.post('/content/:id', { schema: { params, body: { content: { 'application/json': { schema: ITEM_BODY } } } }, security: READ }, handler);

    const id = uuidv7();
    const requests = [
      { url: `/items/${id}`, payload: { name: 'x'.repeat(fastify.config.app.bodyLimit) } },
      { url: `/items/${id}`, payload: {} },
      { url: `/items/${id}`, headers: { 'content-type': 'application/json' }, payload: '{"name":' },
      { url: `/items/${id}`, headers: { 'content-type': 'text/csv' }, payload: 'name' },
      { url: `/content/${id}`, headers: { 'content-type': 'text/plain' }, payload: 'name' },
      { url: '/items/not-a-uuid', payload: { name: 'Anna' } },
      { url: `/items/${id}`, payload: { name: 'Anna' } },
    ].map((request) => ({ method: 'POST', ...request }));

    assertRefused(await injectAs(fastify, requests), UNAUTHENTICATED);
    assertRefused(await injectAs(fastify, requests, issueFor(fastify, [GROUPS_MANAGE, USERS_READ])), FORBIDDEN);
    assert.equal(calls.count, 0);

    const ofReader = await injectAs(fastify, requests, issueFor(fastify, [GROUPS_READ]));

    assert.deepEqual(ofReader.map((response) => describeHeaders(response)), [413, 422, 400, 415, 415, 404, 200].map((statusCode) => [statusCode, NO_STORE, undefined]));
    assert.equal(calls.count, 1);
  });

  test('guards the HEAD twin of a route, both spellings of the root of a prefix, an encoded path and each of several methods', async (t) => {
    const fastify = await buildOpenApp(t);
    const { calls, handler } = countCalls();

    await fastify.register(async (scope) => {
      scope.get('/', { schema: DONE_SCHEMA, security: READ }, handler);
      scope.delete('/:id', { schema: DONE_SCHEMA, security: READ }, handler);
      scope.route({
        method: ['PUT', 'PATCH'],
        url: '/:id',
        schema: DONE_SCHEMA,
        security: READ,
        handler,
      });
    }, { prefix: ITEMS_URL });

    const requests = [
      ['GET', ITEMS_URL],
      ['GET', `${ITEMS_URL}/`],
      ['HEAD', ITEMS_URL],
      ['HEAD', `${ITEMS_URL}/`],
      ['GET', '/%61pi/v1/items'],
      ['GET', '/api/v1/%69tems/?page=1'],
      ['PUT', `${ITEMS_URL}/1`],
      ['PATCH', `${ITEMS_URL}/1`],
      ['DELETE', `${ITEMS_URL}/1`],
      ['DELETE', '/%61pi/v1/items/%31'],
    ].map(([method, url]) => ({ method, url }));
    const [ofGuest, ofLacking] = await Promise.all([
      injectAs(fastify, requests),
      injectAs(fastify, requests, issueFor(fastify, [GROUPS_MANAGE])),
    ]);

    assert.deepEqual(readStatuses(ofGuest), requests.map(() => 401));
    assert.deepEqual(readStatuses(ofLacking), requests.map(() => 403));
    assert.equal(calls.count, 0);

    const ofReader = await injectAs(fastify, requests, issueFor(fastify, [GROUPS_READ]));

    assert.deepEqual(readStatuses(ofReader), requests.map(() => 200));
    assert.equal(calls.count, requests.length);
  });
});

describe('guard plugin: the order of the hooks', () => {
  test('the scope guard comes after the own hooks of the route, after those of its folder, after one an earlier onRoute hook has put there and after the auth hook', async (t) => {
    const events = [];
    const fastify = await buildGuardAround(t, {
      earlier: appendHookOf(events, 'earlier plugin'),
      between: appendHookOf(events, 'plugin between'),
    });

    await fastify.register(async (scope) => {
      scope.addHook('onRequest', leaveName(events, 'folder'));
      scope.get('/scoped', { onRequest: leaveName(events, 'route'), security: READ }, async (request) => {
        events.push(['handler', request.user]);

        return { isDone: true };
      });
    });

    const lacking = issueFor(fastify, [USERS_READ]);
    const reader = issueFor(fastify, [GROUPS_READ]);
    const before = withoutUser(['folder', 'route', 'earlier plugin']);

    assertRefused([await fastify.inject('/scoped')], UNAUTHENTICATED);
    assert.deepEqual(events.splice(0), before);

    assertRefused([await fastify.inject({ url: '/scoped', cookies: lacking.cookies })], FORBIDDEN);
    assert.deepEqual(events.splice(0), [...before, ['plugin between', { id: lacking.userId, scopes: [USERS_READ] }]]);

    const allowed = await fastify.inject({ url: '/scoped', cookies: reader.cookies });
    const user = { id: reader.userId, scopes: [GROUPS_READ] };

    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(events, [...before, ['plugin between', user], ['handler', user]]);
  });

  test('a route without scopes gets nothing from the guard, and one with scopes gets its scope guard last, behind the auth hook', async (t) => {
    const fastify = await buildDownApp(t);
    const onRequest = [leaveName([], 'own')];
    const seen = {};

    // Added after the plugins, it runs behind their onRoute hooks and sees what they have left. The hooks of compress and
    // the limiter come before those of auth and are not the matter here.
    fastify.addHook('onRoute', (routeOptions) => {
      if (routeOptions.method === 'GET') {
        seen[routeOptions.url] = (routeOptions.onRequest ?? []).filter((hook) => hook === onRequest[0] || hook === authenticate || hook.name === 'guardScopes');
      }
    });
    fastify.get('/public', { onRequest, security: PUBLIC }, countCalls().handler);
    fastify.get('/no-security', { onRequest }, countCalls().handler);
    fastify.get('/guarded', { onRequest, security: GUARDED }, countCalls().handler);
    fastify.get('/scoped', { onRequest, security: READ }, countCalls().handler);
    fastify.get('/plain-scoped', { security: READ }, countCalls().handler);

    assert.deepEqual(seen['/public'], onRequest);
    assert.deepEqual(seen['/no-security'], onRequest);
    assert.deepEqual(seen['/guarded'], [onRequest[0], authenticate]);
    assert.deepEqual(seen['/scoped'].slice(0, -1), [onRequest[0], authenticate]);
    assert.deepEqual(seen['/plain-scoped'].slice(0, -1), [authenticate]);
    assert.deepEqual([seen['/scoped'], seen['/plain-scoped']].map((hooks) => [hooks.length, typeof hooks.at(-1), hooks.at(-1) === authenticate]), [[3, 'function', false], [2, 'function', false]]);
    assert.equal(onRequest.length, 1);
  });
});

describe('guard plugin: what a route is declared with', () => {
  test('the scopes of a route are copied when it is declared: a change of the list afterwards lets nobody else in and keeps nobody out, on its HEAD twin too', async (t) => {
    const fastify = await buildOpenApp(t);
    const scopes = [GROUPS_READ];
    const terms = [[GROUPS_READ, USERS_READ]];

    fastify.get('/one', { security: { auth: true, scopes } }, countCalls().handler);
    fastify.get('/pair', { security: { auth: true, scopes: terms } }, countCalls().handler);
    scopes.splice(0, 1, USERS_READ);
    terms[0].pop();

    const requests = [
      ['GET', '/one', [GROUPS_READ]],
      ['HEAD', '/one', [GROUPS_READ]],
      ['GET', '/one', [USERS_READ]],
      ['HEAD', '/one', [USERS_READ]],
      ['GET', '/pair', [GROUPS_READ, USERS_READ]],
      ['HEAD', '/pair', [GROUPS_READ, USERS_READ]],
      ['GET', '/pair', [GROUPS_READ]],
      ['HEAD', '/pair', [GROUPS_READ]],
    ];
    const responses = await Promise.all(requests.map(([method, url, held]) => fastify.inject({ method, url, cookies: issueFor(fastify, held).cookies })));

    assert.deepEqual(readStatuses(responses), [200, 200, 403, 403, 200, 200, 403, 403]);
  });

  test('onRequest hooks of the route, given as a function, a list, or a list that routes of other scopes share, frozen or not, run before the guards and stay as they were', async (t) => {
    const fastify = await buildOpenApp(t);
    const { calls, handler } = countCalls();
    const events = [];
    const single = leaveName(events, 'single');
    const list = [leaveName(events, 'first'), leaveName(events, 'second')];
    const shared = [leaveName(events, 'shared')];
    const frozen = Object.freeze([leaveName(events, 'frozen')]);

    fastify.get('/function', { onRequest: single, security: READ }, handler);
    fastify.get('/list', { onRequest: list, security: READ }, handler);
    fastify.get('/shared-read', { onRequest: shared, security: READ }, handler);
    fastify.get('/shared-manage', { onRequest: shared, security: MANAGE }, handler);
    fastify.get('/shared-guarded', { onRequest: shared, security: GUARDED }, handler);
    fastify.get('/frozen-read', { onRequest: frozen, security: READ }, handler);
    fastify.get('/frozen-manage', { onRequest: frozen, security: MANAGE }, handler);

    const urls = ['/function', '/list', '/shared-read', '/shared-manage', '/shared-guarded', '/frozen-read', '/frozen-manage'];
    const ownHooks = withoutUser(['single', 'first', 'second', 'shared', 'shared', 'shared', 'frozen', 'frozen']);
    const reader = issueFor(fastify, [GROUPS_READ]);
    const manager = issueFor(fastify, [GROUPS_MANAGE]);

    assertRefused(await mapSeries(urls, (url) => fastify.inject(url)), UNAUTHENTICATED, urls);
    assert.deepEqual(events.splice(0), ownHooks);

    const ofReader = await mapSeries(urls, (url) => fastify.inject({ url, cookies: reader.cookies }));

    assert.deepEqual(events.splice(0), ownHooks);

    const ofManager = await mapSeries(urls, (url) => fastify.inject({ url, cookies: manager.cookies }));

    assert.deepEqual(events, ownHooks);
    assert.deepEqual(readStatuses(ofReader), [200, 200, 200, 403, 200, 200, 403]);
    assert.deepEqual(readStatuses(ofManager), [403, 403, 403, 200, 200, 403, 200]);
    assert.equal(calls.count, 8);
    assert.deepEqual([list.length, shared.length, frozen.length], [2, 1, 1]);
  });
});

describe('guard plugin: a route declared before it', () => {
  test('refuses the start and is named when it has scopes: in a plugin between the auth plugin and the guard, in a scope of it, behind an after(), under /api or not', async (t) => {
    const plugins = {
      'a route of the plugin': async (instance) => {
        declareScoped(instance, EARLY_URL);
      },
      'a route of a scope in it': async (instance) => {
        instance.register(async (scope) => {
          declareScoped(scope, '/early');
        }, { prefix: '/api/v1' });
      },
      'the root of a scope in it': async (instance) => {
        instance.register(async (scope) => {
          declareScoped(scope, '/');
        }, { prefix: EARLY_URL });
      },
      'a route behind an after() of the scope': async (instance) => {
        instance.register(async (scope) => {
          scope.after(async () => {
            declareScoped(scope, '/early');
          });
        }, { prefix: '/api/v1' });
      },
      'a route of a scope that decorates a guard of its own': async (instance) => {
        instance.register(async (scope) => {
          scope.decorate('guard', Object.freeze({}));
          scope.decorateRequest('scopes', null);
          declareScoped(scope, '/early');
        }, { prefix: '/api/v1' });
      },
    };
    const names = Object.keys(plugins);
    const errors = await mapSeries(names, (name) => rejectionOf(buildGuardAround(t, { between: plugins[name] })));
    const outside = await rejectionOf(buildGuardAround(t, {
      between: async (instance) => {
        declareScoped(instance, '/early');
      },
    }));
    const beforeAuth = await rejectionOf(buildGuardAround(t, {
      earlier: async (instance) => {
        declareScoped(instance, '/early');
      },
    }));

    assert.deepEqual(
      errors.map((error, index) => [names[index], error.message]),
      names.map((name) => [name, `Route GET ${EARLY_URL} ${OUT_OF_REACH}`]),
    );
    assert.equal(outside.message, `Route GET /early ${OUT_OF_REACH}`);
    assert.equal(beforeAuth.message, `Route GET /early ${AUTH_OUT_OF_REACH}`);
  });

  test('is refused in a scope opened before the plugin however late it is declared, while a guarded one without scopes is taken there', async (t) => {
    const { calls, handler } = countCalls();
    let early;
    const fastify = await buildGuardAround(t, {
      between: async (instance) => {
        await instance.register(async (scope) => {
          early = scope;
        }, { prefix: EARLY_URL });
      },
    });

    assert.throws(() => declareScoped(early, '/scoped'), { message: `Route GET ${EARLY_URL}/scoped ${OUT_OF_REACH}` });
    early.get('/guarded', { schema: DONE_SCHEMA, security: GUARDED }, handler);

    const { cookies } = issueFor(fastify, [GROUPS_READ]);
    const responses = await Promise.all([
      fastify.inject({ url: `${EARLY_URL}/scoped`, cookies }),
      fastify.inject(`${EARLY_URL}/guarded`),
      fastify.inject({ url: `${EARLY_URL}/guarded`, cookies }),
    ]);

    assert.deepEqual(readStatuses(responses), [404, 401, 200]);
    assert.equal(calls.count, 1);
  });
});

describe('guard plugin: fastify.guard', () => {
  test('is frozen and holds the auth hook of the core and scope(), the maker of scope guards', async (t) => {
    const fastify = await buildDownApp(t);
    const { guard } = fastify;

    assert.equal(Object.isFrozen(guard), true);
    assert.deepEqual(Object.keys(guard), ['auth', 'scope']);
    assert.equal(guard.auth, authenticate);
    assert.equal(typeof guard.scope, 'function');
    assert.throws(() => {
      guard.auth = guard.scope;
    }, TypeError);
    assert.equal(guard.auth, authenticate);
  });

  test('auth guards a route outside the contract by hand: 401 that names the Bearer scheme to a guest, the user and the session of the token to the handler, and nothing to store', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get('/by-hand', { onRequest: fastify.guard.auth }, readState);

    const { userId, sid, headers } = issueFor(fastify, [USERS_READ]);
    const [guest, user] = await Promise.all([fastify.inject('/by-hand'), fastify.inject({ url: '/by-hand', headers })]);

    assertRefused([guest], UNAUTHENTICATED);
    assert.deepEqual(describeHeaders(user), [200, NO_STORE, undefined]);
    assert.deepEqual(user.json(), { user: { id: userId, scopes: [USERS_READ] }, session: { id: sid } });
  });

  test('scope() alone signs a request in first: 401 to a guest and to a session that is over, 403 without the scope and the user with it, for a scope given as a string, a list or a list of lists', async (t) => {
    const endedSid = uuidv7();
    const fastify = await buildOpenApp(t, { marks: { [endedSid]: REVOKED_MARK } });

    fastify.get('/by-hand/one', { onRequest: fastify.guard.scope(GROUPS_READ) }, readState);
    fastify.get('/by-hand/any', { onRequest: fastify.guard.scope([GROUPS_READ, GROUPS_MANAGE]) }, readState);
    fastify.get('/by-hand/all', { onRequest: [fastify.guard.scope([[GROUPS_READ, USERS_READ]])] }, readState);

    const urls = ['/by-hand/one', '/by-hand/any', '/by-hand/all'];
    const requests = urls.map((url) => ({ url }));
    const holders = [[GROUPS_READ], [GROUPS_MANAGE], [GROUPS_ALL], [GROUPS_READ, USERS_READ], [SCOPE_ALL]];
    const [ofGuest, ofEnded, ...ofHolders] = await Promise.all([
      injectAs(fastify, requests),
      injectAs(fastify, requests, issueFor(fastify, [SCOPE_ALL], { sid: endedSid })),
      ...holders.map((scopes) => injectAs(fastify, requests, issueFor(fastify, scopes))),
    ]);

    assertRefused(ofGuest, UNAUTHENTICATED, urls);
    assertRefused(ofEnded, REVOKED, urls);
    assert.deepEqual(ofHolders.map((responses) => readStatuses(responses)), [
      [200, 200, 403],
      [403, 200, 403],
      [200, 200, 403],
      [200, 200, 200],
      [200, 200, 200],
    ]);
    assertRefused(ofHolders[1].filter((response) => response.statusCode === 403), FORBIDDEN);

    const [allowed] = ofHolders.at(-1);

    assert.deepEqual(describeHeaders(allowed), [200, NO_STORE, undefined]);
    assert.deepEqual(allowed.json().user.scopes, [SCOPE_ALL]);
  });

  test('scope() refuses at once what is no requirement: an unknown code, a wildcard, "*", an empty one, a term nested deeper, what is neither a list nor a string', async (t) => {
    const fastify = await buildDownApp(t);
    const unknown = [
      ['an unknown code', 'groups:write', 'groups:write'],
      ['a code in upper case', 'GROUPS:READ', 'GROUPS:READ'],
      ['an empty string', '', ''],
      ['a wildcard', GROUPS_ALL, GROUPS_ALL],
      ['"*"', SCOPE_ALL, SCOPE_ALL],
      ['an unknown code in a list', [GROUPS_READ, 'users:write'], 'users:write'],
      ['a wildcard in a term', [[GROUPS_READ, USERS_ALL]], USERS_ALL],
    ];
    const malformed = {
      nothing: undefined,
      null: null,
      'an empty list': [],
      'an empty term': [GROUPS_READ, []],
      'a term nested deeper': [[[GROUPS_READ]]],
      'a term with a list in it': [[GROUPS_READ, [USERS_READ]]],
      'a number': 42,
      'a list of numbers': [42],
      'an object': { scopes: [GROUPS_READ] },
    };

    unknown.forEach(([name, requirement, code]) => {
      assert.throws(() => fastify.guard.scope(requirement), { name: 'TypeError', message: unknownMessage(code) }, name);
    });
    Object.entries(malformed).forEach(([name, requirement]) => {
      assert.throws(() => fastify.guard.scope(requirement), { name: 'TypeError', message: LIST_MESSAGE }, name);
    });
  });

  test('scope() copies its requirement: a change of the list afterwards lets nobody else in and keeps nobody out', async (t) => {
    const fastify = await buildOpenApp(t);
    const requirement = [GROUPS_READ];
    const terms = [[GROUPS_READ, USERS_READ]];

    fastify.get('/by-hand/one', { onRequest: fastify.guard.scope(requirement) }, countCalls().handler);
    fastify.get('/by-hand/pair', { onRequest: fastify.guard.scope(terms) }, countCalls().handler);
    requirement.splice(0, 1, USERS_READ);
    terms[0].pop();

    const responses = await Promise.all([
      ['/by-hand/one', [GROUPS_READ]],
      ['/by-hand/one', [USERS_READ]],
      ['/by-hand/pair', [GROUPS_READ, USERS_READ]],
      ['/by-hand/pair', [GROUPS_READ]],
    ].map(([url, held]) => fastify.inject({ url, cookies: issueFor(fastify, held).cookies })));

    assert.deepEqual(readStatuses(responses), [200, 403, 200, 403]);
  });

  test('scope() behind auth takes the user auth has left, and as a hook of a folder guards every route in it', async (t) => {
    const fastify = await buildOpenApp(t);
    const { calls, handler } = countCalls();

    fastify.get('/by-hand/both', { onRequest: [fastify.guard.auth, fastify.guard.scope(GROUPS_READ)] }, handler);
    await fastify.register(async (scope) => {
      scope.addHook('onRequest', scope.guard.scope(GROUPS_MANAGE));
      scope.get('/first', handler);
      scope.post('/second', handler);
    }, { prefix: '/managed' });

    const requests = [{ url: '/by-hand/both' }, { url: '/managed/first' }, { method: 'POST', url: '/managed/second' }];
    const [ofGuest, ofReader, ofManager] = await Promise.all([
      injectAs(fastify, requests),
      injectAs(fastify, requests, issueFor(fastify, [GROUPS_READ])),
      injectAs(fastify, requests, issueFor(fastify, [GROUPS_MANAGE])),
    ]);

    assertRefused(ofGuest, UNAUTHENTICATED);
    assert.deepEqual([ofReader, ofManager].map((responses) => readStatuses(responses)), [[200, 403, 403], [403, 200, 200]]);
    assert.equal(calls.count, 3);
  });
});
