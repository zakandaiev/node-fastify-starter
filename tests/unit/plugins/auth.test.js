import { issueTokens } from '#core/auth/token.js';
import { createContext, getContext } from '#core/context/index.js';
import { AppError } from '#core/error/index.js';
import { createLogger } from '#core/logger/index.js';
import { createRouteHook } from '#core/schema/route.js';
import { COOKIE } from '#enums/cookie.js';
import useErrorHandler from '#root/src/plugins/000.error-handler.js';
import useContext from '#root/src/plugins/010.context.js';
import useRedis from '#root/src/plugins/020.redis.js';
import useDb from '#root/src/plugins/030.db.js';
import useCookie from '#root/src/plugins/090.cookie.js';
import useJwt from '#root/src/plugins/100.jwt.js';
import useAuth from '#root/src/plugins/130.auth.js';
import {
  accept,
  createAlertReceiver,
  NO_THROTTLE,
  readBlock,
  readTitles,
  readUrls,
} from '#root/tests/helper/alert.js';
import { describeAnswer, errorBody } from '#root/tests/helper/app.js';
import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import {
  buildDownApp,
  connectAppRedis,
  createMarkedRedisEnv,
  runInApp,
  toBearer,
} from '#root/tests/helper/session.js';
import { successEnvelope } from '#schemas/common/envelope.js';
import { idParam } from '#schemas/common/request.js';
import { mapSeries } from '#utils/async.js';
import { nowUtc } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import { pick } from '#utils/object.js';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const GUARDED = Object.freeze({ auth: true });
const PUBLIC = Object.freeze({ auth: false });
const SCOPES = Object.freeze(['users:read', 'users:write']);

const REVOKED_MARK = '0';
const NO_MARK = null;

const BASIC = 'Basic dXNlcjpwYXNzd29yZA==';
const LONG_REPEATS = 1000;

const ITEMS_URL = '/api/v1/items';
const EARLY_URL = '/api/v1/early';
const DONE_SCHEMA = Object.freeze({
  response: { 200: successEnvelope({ type: 'object', properties: { isDone: { type: 'boolean' } } }) },
});
const ITEM_BODY = Object.freeze({
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', maxLength: 20 } },
});

const NO_STORE = 'no-store';
const OWN_POLICY = 'private, max-age=60';
const BEARER = 'Bearer';

const UNAUTHENTICATED = Object.freeze({
  statusCode: 401,
  code: 'AUTHENTICATION_ERROR',
  message: 'Authentication error',
  challenge: BEARER,
});
const REVOKED = Object.freeze({
  statusCode: 401,
  code: 'SESSION_REVOKED',
  message: 'Session revoked',
  challenge: BEARER,
});
const UNAVAILABLE = Object.freeze({
  statusCode: 503,
  code: 'SERVICE_UNAVAILABLE_ERROR',
  message: 'Service unavailable',
  retryAfter: '60',
});

const REQUEST_FAILED_MESSAGE = 'Request failed';
const OUT_OF_REACH = 'has security: { auth: true } and is out of reach of the auth plugin, which guards what is declared after it, in scopes opened after it';
const DATABASE_CONNECTION_TITLE = 'Database connection failed';
const REFUSED_CODE = 'ECONNREFUSED';

// Long enough for a second alert to reach the receiver: what is not there by then was never sent.
const SETTLE_MS = 300;

async function buildOpenApp(t, { marks, env = {}, ...sections } = {}) {
  const fastify = await buildDownApp(t, { ...sections, env: { ...(await createMarkedRedisEnv(t, marks)), ...env } });

  await connectAppRedis(fastify);

  return fastify;
}

// Not the app of the tests: what is added to it comes behind the guard.
async function buildGuardAfter(t, useEarlier) {
  const config = createTestConfig({ env: { ...(await createMarkedRedisEnv(t)), ...(await createDownEnv()) } });
  const fastify = Fastify({ loggerInstance: createLogger(config.logger), genReqId: () => uuidv7() });

  t.after(() => fastify.close());
  fastify.decorate('config', config);
  fastify.decorate('context', createContext({ config, log: fastify.log }));
  fastify.addHook('onRoute', createRouteHook(config.app));
  await mapSeries([useErrorHandler, useContext, useRedis, useDb, useCookie, useJwt, fp(useEarlier), useAuth], (plugin) => fastify.register(plugin));
  await connectAppRedis(fastify);

  return fastify;
}

function declareGuarded(fastify, url) {
  fastify.get(url, { schema: DONE_SCHEMA, security: GUARDED }, () => ({ isDone: true }));
}

function issueFor(fastify, { userId = uuidv7(), sid = uuidv7(), scopes = SCOPES } = {}) {
  const { issued } = runInApp(fastify, () => issueTokens({
    userId,
    sid,
    scopes,
    startedAt: nowUtc(),
  }));

  return {
    ...issued,
    cookies: { [COOKIE.ACCESS_TOKEN]: issued.accessToken },
    headers: toBearer(issued.accessToken),
  };
}

function countCalls() {
  const calls = { count: 0 };

  function handler() {
    calls.count += 1;

    return { isDone: true };
  }

  return { calls, handler };
}

function readState(request) {
  return { user: request.user, session: request.session };
}

function leaveName(events, name) {
  async function onRequest(request) {
    events.push([name, request.user]);
  }

  return onRequest;
}

function withoutUser(names) {
  return names.map((name) => [name, null]);
}

function describeRefusal(response, refusal) {
  return {
    statusCode: refusal.statusCode,
    body: errorBody(response, refusal.code, refusal.message),
    retryAfter: refusal.retryAfter,
    challenge: refusal.challenge,
    cacheControl: NO_STORE,
    cookies: undefined,
  };
}

function assertRefused(responses, refusal, names = responses.map((response, index) => index)) {
  assert.deepEqual(
    responses.map((response, index) => [names[index], describeAnswer(response)]),
    responses.map((response, index) => [names[index], describeRefusal(response, refusal)]),
  );
}

function describeHeaders(response) {
  return [response.statusCode, response.headers['cache-control'], response.headers['www-authenticate']];
}

function listUnusableBearers({ accessToken, refreshToken }) {
  return {
    'Bearer alone': 'Bearer',
    'Bearer and spaces': 'Bearer   ',
    'Bearer with garbage': 'Bearer garbage',
    'Bearer with two parts': `Bearer ${accessToken} ${accessToken}`,
    'Bearer with a refresh token': `Bearer ${refreshToken}`,
    'Bearer with a cut token': `bearer ${accessToken.slice(0, -1)}`,
  };
}

function listUnusableRequests(issued) {
  const { accessToken, refreshToken } = issued;
  const bearers = Object.entries(listUnusableBearers(issued))
    .map(([name, authorization]) => [name, { headers: { authorization } }]);

  return {
    'no token at all': {},
    'an empty cookie': { cookies: { accessToken: '' } },
    'a cookie with no value': { headers: { cookie: 'accessToken' } },
    'a cookie with a broken escape': { headers: { cookie: 'accessToken=%E0%A4%A' } },
    'garbage in the cookie': { cookies: { accessToken: 'garbage' } },
    'long garbage in the cookie': { cookies: { accessToken: 'garbage.'.repeat(LONG_REPEATS) } },
    'three empty parts in the cookie': { cookies: { accessToken: '..' } },
    'a cut token in the cookie': { cookies: { accessToken: accessToken.slice(0, -1) } },
    'a refresh token in the cookie of the access token': { cookies: { accessToken: refreshToken } },
    'the refresh cookie alone': { cookies: { refreshToken } },
    'the access token in a cookie of another name': { cookies: { token: accessToken } },
    'the access token in the query': { query: { accessToken } },
    'the access token without a scheme': { headers: { authorization: accessToken } },
    'the access token under another scheme': { headers: { authorization: `Token ${accessToken}` } },
    'Basic credentials and no cookie': { headers: { authorization: BASIC } },
    ...Object.fromEntries(bearers),
  };
}

describe('auth plugin', () => {
  test('is registered under the name "auth"', async (t) => {
    const fastify = await buildDownApp(t);

    assert.equal(fastify.hasPlugin('auth'), true);
  });
});

describe('auth plugin: a request with no token anybody can use', () => {
  test('is answered 401 AUTHENTICATION_ERROR that names the Bearer scheme and sets no cookie, and never reaches the handler of the route', async (t) => {
    const fastify = await buildOpenApp(t);
    const { calls, handler } = countCalls();

    fastify.get('/guarded', { security: GUARDED }, handler);

    const issued = issueFor(fastify);
    const requests = Object.entries(listUnusableRequests(issued));
    const responses = await Promise.all(requests.map(([, request]) => fastify.inject({ url: '/guarded', ...request })));

    assertRefused(responses, UNAUTHENTICATED, requests.map(([name]) => name));
    assert.equal(calls.count, 0);

    const allowed = await fastify.inject({ url: '/guarded', cookies: issued.cookies });

    assert.equal(allowed.statusCode, 200);
    assert.equal(calls.count, 1);
  });

  test('is not saved by a valid cookie beside a Bearer header, while Basic credentials are no token and leave the cookie to be read', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get('/guarded', { security: GUARDED }, countCalls().handler);

    const issued = issueFor(fastify);
    const { cookies } = issued;
    const bearers = Object.entries(listUnusableBearers(issued));
    const refused = await Promise.all(bearers.map(([, authorization]) => fastify.inject({ url: '/guarded', cookies, headers: { authorization } })));
    const allowed = await Promise.all([
      fastify.inject({ url: '/guarded', cookies }),
      fastify.inject({ url: '/guarded', cookies, headers: { authorization: BASIC } }),
    ]);

    assertRefused(refused, UNAUTHENTICATED, bearers.map(([name]) => name));
    assert.deepEqual(allowed.map((response) => response.statusCode), [200, 200]);
  });

  test('raises no alert: the first to reach the receiver is that of a route that fails after them', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const fastify = await buildDownApp(t, { env: receiver.env.webhook, alert: receiver.config.alert });

    fastify.get('/guarded', { security: GUARDED }, countCalls().handler);
    fastify.get('/boom', async () => {
      throw new Error('Route failed');
    });

    const requests = Object.entries(listUnusableRequests(issueFor(fastify)));
    const responses = await Promise.all(requests.map(([, request]) => fastify.inject({ url: '/guarded', ...request })));

    await fastify.inject('/boom');
    await waitFor(() => receiver.requests.length > 0, 'the alert of the failed route');

    assertRefused(responses, UNAUTHENTICATED, requests.map(([name]) => name));
    assert.deepEqual(readUrls(receiver), ['https://app.test/boom']);
  });
});

describe('auth plugin: what the guard answers before', () => {
  test('a guest gets 401 whatever the body, its type or the id in the path, and a user what is wrong with them: none of the answers may be stored, and only the 401 names a scheme', async (t) => {
    const fastify = await buildOpenApp(t);
    const { calls, handler } = countCalls();

    fastify.post('/items/:id', { schema: { params: idParam('Item id'), body: ITEM_BODY }, security: GUARDED }, handler);

    const { cookies } = issueFor(fastify);
    const itemUrl = `/items/${uuidv7()}`;
    const requests = [
      { url: itemUrl, payload: { name: 'x'.repeat(fastify.config.app.bodyLimit) } },
      { url: itemUrl, payload: {} },
      { url: itemUrl, headers: { 'content-type': 'application/json' }, payload: '{"name":' },
      { url: itemUrl, headers: { 'content-type': 'text/csv' }, payload: 'name' },
      { url: '/items/not-a-uuid', payload: { name: 'Anna' } },
      { url: itemUrl, payload: { name: 'Anna' } },
    ].map((request) => ({ method: 'POST', ...request }));

    assertRefused(await Promise.all(requests.map((request) => fastify.inject(request))), UNAUTHENTICATED);
    assert.equal(calls.count, 0);

    const ofUser = await Promise.all(requests.map((request) => fastify.inject({ ...request, cookies })));

    assert.deepEqual(ofUser.map((response) => describeHeaders(response)), [413, 422, 400, 415, 404, 200].map((statusCode) => [statusCode, NO_STORE, undefined]));
    assert.equal(calls.count, 1);
  });
});

describe('auth plugin: what the guard covers', () => {
  test('the HEAD twin of a route, both spellings of the root of a prefix, an encoded path and each of several methods', async (t) => {
    const fastify = await buildOpenApp(t);
    const { calls, handler } = countCalls();

    await fastify.register(async (scope) => {
      scope.get('/', { schema: DONE_SCHEMA, security: GUARDED }, handler);
      scope.delete('/:id', { schema: DONE_SCHEMA, security: GUARDED }, handler);
      scope.route({
        method: ['PUT', 'PATCH'],
        url: '/:id',
        schema: DONE_SCHEMA,
        security: GUARDED,
        handler,
      });
    }, { prefix: ITEMS_URL });

    const { cookies } = issueFor(fastify);
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
    const ofGuest = await Promise.all(requests.map((request) => fastify.inject(request)));

    assert.deepEqual(ofGuest.map((response) => response.statusCode), requests.map(() => 401));
    assert.equal(calls.count, 0);

    const ofUser = await Promise.all(requests.map((request) => fastify.inject({ ...request, cookies })));

    assert.deepEqual(ofUser.map((response) => response.statusCode), requests.map(() => 200));
    assert.equal(calls.count, requests.length);
  });

  test('a route with onRequest hooks of its own, given as a function, a list or a frozen list that two routes share, which stays as it was', async (t) => {
    const fastify = await buildOpenApp(t);
    const { calls, handler } = countCalls();
    const events = [];
    const single = leaveName(events, 'single');
    const list = [leaveName(events, 'first'), leaveName(events, 'second')];
    const shared = Object.freeze([leaveName(events, 'shared')]);

    fastify.get('/function', { onRequest: single, security: GUARDED }, handler);
    fastify.get('/list', { onRequest: list, security: GUARDED }, handler);
    fastify.get('/empty', { onRequest: [], security: GUARDED }, handler);
    fastify.get('/shared-one', { onRequest: shared, security: GUARDED }, handler);
    fastify.get('/shared-two', { onRequest: shared, security: GUARDED }, handler);

    const { cookies } = issueFor(fastify);
    const urls = ['/function', '/list', '/empty', '/shared-one', '/shared-two'];
    const ownHooks = withoutUser(['single', 'first', 'second', 'shared', 'shared']);

    assertRefused(await mapSeries(urls, (url) => fastify.inject(url)), UNAUTHENTICATED, urls);
    assert.deepEqual(events.splice(0), ownHooks);
    assert.equal(calls.count, 0);

    const ofUser = await mapSeries(urls, (url) => fastify.inject({ url, cookies }));

    assert.deepEqual(ofUser.map((response) => response.statusCode), urls.map(() => 200));
    assert.deepEqual(events, ownHooks);
    assert.equal(calls.count, urls.length);
    assert.equal(list.length, 2);
    assert.equal(shared.length, 1);
  });
});

describe('auth plugin: the order of the hooks', () => {
  test('the guard comes after the own hooks of the route, after those of its folder and after one an earlier onRoute hook has put there', async (t) => {
    const events = [];
    const fastify = await buildGuardAfter(t, async (instance) => {
      instance.addHook('onRoute', (routeOptions) => {
        routeOptions.onRequest = [...[routeOptions.onRequest ?? []].flat(), leaveName(events, 'earlier plugin')];
      });
    });

    await fastify.register(async (scope) => {
      scope.addHook('onRequest', leaveName(events, 'folder'));
      scope.get('/guarded', { onRequest: leaveName(events, 'route'), security: GUARDED }, async (request) => {
        events.push(['handler', request.user]);

        return { isDone: true };
      });
    });

    const userId = uuidv7();
    const { cookies } = issueFor(fastify, { userId });
    const before = withoutUser(['folder', 'route', 'earlier plugin']);

    assertRefused([await fastify.inject('/guarded')], UNAUTHENTICATED);
    assert.deepEqual(events.splice(0), before);

    const allowed = await fastify.inject({ url: '/guarded', cookies });

    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(events, [...before, ['handler', { id: userId, scopes: SCOPES }]]);
  });
});

describe('auth plugin: a route declared before it', () => {
  test('refuses the start and is named when it is a guarded one: in a plugin with a smaller number, in a scope of it, behind an after(), under /api or not', async (t) => {
    const plugins = {
      'a route of the plugin': async (instance) => {
        declareGuarded(instance, EARLY_URL);
      },
      'a route of a scope in it': async (instance) => {
        instance.register(async (scope) => {
          declareGuarded(scope, '/early');
        }, { prefix: '/api/v1' });
      },
      'the root of a scope in it': async (instance) => {
        instance.register(async (scope) => {
          declareGuarded(scope, '/');
        }, { prefix: EARLY_URL });
      },
      'a route behind an after() of the scope': async (instance) => {
        instance.register(async (scope) => {
          scope.after(async () => {
            declareGuarded(scope, '/early');
          });
        }, { prefix: '/api/v1' });
      },
      'a route of a scope that gives its requests a user of its own': async (instance) => {
        instance.register(async (scope) => {
          scope.decorateRequest('user', null);
          declareGuarded(scope, '/early');
        }, { prefix: '/api/v1' });
      },
    };
    const names = Object.keys(plugins);
    const errors = await mapSeries(names, (name) => rejectionOf(buildGuardAfter(t, plugins[name])));
    const outside = await rejectionOf(buildGuardAfter(t, async (instance) => {
      declareGuarded(instance, '/early');
    }));

    assert.deepEqual(
      errors.map((error, index) => [names[index], error.message]),
      names.map((name) => [name, `Route GET ${EARLY_URL} ${OUT_OF_REACH}`]),
    );
    assert.equal(outside.message, `Route GET /early ${OUT_OF_REACH}`);
  });

  test('is refused in a scope opened before the plugin however late it comes, also where its requests have a user: the guard never reaches such a scope', async (t) => {
    const { calls, handler } = countCalls();
    let early;
    let decorated;
    const fastify = await buildGuardAfter(t, async (instance) => {
      await instance.register(async (scope) => {
        early = scope;
      }, { prefix: EARLY_URL });
      await instance.register(async (scope) => {
        scope.decorateRequest('user', null);
        decorated = scope;
      }, { prefix: '/decorated' });
    });

    assert.throws(() => declareGuarded(early, '/guarded'), { message: `Route GET ${EARLY_URL}/guarded ${OUT_OF_REACH}` });
    assert.throws(() => declareGuarded(decorated, '/guarded'), { message: `Route GET /decorated/guarded ${OUT_OF_REACH}` });
    early.get('/public', { schema: DONE_SCHEMA, security: PUBLIC }, handler);

    const responses = await Promise.all(['/guarded', '/public'].map((path) => fastify.inject(`${EARLY_URL}${path}`)));

    assert.deepEqual(responses.map((response) => response.statusCode), [404, 200]);
    assert.equal(calls.count, 1);
  });

  test('may be a public one, and what is declared behind the plugin is guarded: the HEAD twin of a route and both spellings of the root of a prefix', async (t) => {
    const { calls, handler } = countCalls();
    const fastify = await buildGuardAfter(t, async (instance) => {
      instance.get(EARLY_URL, { schema: DONE_SCHEMA, security: PUBLIC }, handler);
    });

    await fastify.register(async (scope) => {
      scope.get('/', { schema: DONE_SCHEMA, security: GUARDED }, handler);
    }, { prefix: ITEMS_URL });

    const { cookies } = issueFor(fastify);
    const requests = [ITEMS_URL, `${ITEMS_URL}/`].flatMap((url) => ['GET', 'HEAD'].map((method) => ({ method, url })));
    const ofGuest = await Promise.all(requests.map((request) => fastify.inject(request)));

    assert.deepEqual(ofGuest.map((response) => describeHeaders(response)), requests.map(() => [401, NO_STORE, BEARER]));
    assert.equal(calls.count, 0);

    const allowed = await Promise.all([fastify.inject(EARLY_URL), ...requests.map((request) => fastify.inject({ ...request, cookies }))]);

    assert.deepEqual(allowed.map((response) => response.statusCode), allowed.map(() => 200));
    assert.equal(calls.count, allowed.length);
  });
});

describe('auth plugin: a route that is not guarded', () => {
  test('keeps the hooks it was declared with: the guard adds nothing to a public one and nothing to one without security', async (t) => {
    const fastify = await buildDownApp(t);
    const onRequest = [leaveName([], 'own')];
    const seen = {};

    // Added after the plugins, it runs behind the hook of the guard and sees what that one has left.
    fastify.addHook('onRoute', (routeOptions) => {
      if (routeOptions.method === 'GET') {
        seen[routeOptions.url] = routeOptions.onRequest;
      }
    });
    fastify.get('/public', { onRequest, security: PUBLIC }, countCalls().handler);
    fastify.get('/plain-public', { security: PUBLIC }, countCalls().handler);
    fastify.get('/no-security', { onRequest }, countCalls().handler);
    fastify.get('/guarded', { onRequest, security: GUARDED }, countCalls().handler);

    assert.equal(seen['/public'], onRequest);
    assert.equal(seen['/plain-public'], undefined);
    assert.equal(seen['/no-security'], onRequest);
    assert.equal(seen['/guarded'].length, 2);
    assert.equal(seen['/guarded'][0], onRequest[0]);
    assert.equal(onRequest.length, 1);
  });

  test('is served to anyone with a null user and a null session, whatever token the request carries, a valid one too', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get('/public', { security: PUBLIC }, readState);
    fastify.get('/no-security', readState);

    const issued = issueFor(fastify);
    const requests = [...Object.values(listUnusableRequests(issued)), pick(issued, ['cookies']), pick(issued, ['headers'])];
    const responses = await Promise.all(['/public', '/no-security']
      .flatMap((url) => requests.map((request) => fastify.inject({ url, ...request }))));

    assert.deepEqual(responses.map((response) => response.statusCode), responses.map(() => 200));
    assert.deepEqual(responses.map((response) => response.json()), responses.map(() => ({ user: null, session: null })));
  });
});

describe('auth plugin: who the request is from', () => {
  test('request.user is exactly the id and the scopes of the token and request.session its id, frozen through, in the context of the request', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get('/guarded', { security: GUARDED }, async (request) => ({
      ...readState(request),
      isFrozen: [request.user, request.session].every((value) => isDeepFrozen(value)),
      isInContext: getContext().requestId === request.id,
    }));

    const userId = uuidv7();
    const sid = uuidv7();
    const { accessToken, cookies, headers } = issueFor(fastify, { userId, sid });
    const responses = await Promise.all([
      fastify.inject({ url: '/guarded', cookies }),
      fastify.inject({ url: '/guarded', headers }),
      fastify.inject({ url: '/guarded', headers: { authorization: `bearer  ${accessToken} ` } }),
    ]);

    assert.deepEqual(responses.map((response) => response.json()), responses.map(() => ({
      user: { id: userId, scopes: SCOPES },
      session: { id: sid },
      isFrozen: true,
      isInContext: true,
    })));
  });

  test('is kept apart for requests side by side: each handler reads the user of its own token', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get('/guarded', { security: GUARDED }, readState);

    const devices = [['users:read'], ['*'], []].map((scopes) => issueFor(fastify, { scopes }));
    const responses = await Promise.all(devices.map(({ headers }) => fastify.inject({ url: '/guarded', headers })));

    assert.deepEqual(responses.map((response) => response.json()), devices.map(({ userId, sid, scopes }) => ({
      user: { id: userId, scopes },
      session: { id: sid },
    })));
  });
});

describe('auth plugin: what may be stored', () => {
  test('nothing a guarded route answers, by the cookie or by the Bearer header: a body, its HEAD twin and a 204 carry no-store', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get('/guarded', { security: GUARDED }, readState);
    fastify.post('/guarded', { security: GUARDED }, (request, reply) => reply.noContent());

    const { cookies, headers } = issueFor(fastify);
    const responses = await Promise.all([
      fastify.inject({ url: '/guarded', cookies }),
      fastify.inject({ url: '/guarded', headers }),
      fastify.inject({ method: 'HEAD', url: '/guarded', cookies }),
      fastify.inject({ method: 'POST', url: '/guarded', cookies }),
    ]);

    assert.deepEqual(responses.map((response) => describeHeaders(response)), [200, 200, 200, 204].map((statusCode) => [statusCode, NO_STORE, undefined]));
  });

  test('what a guarded handler names a policy of its own for, and not the error it ends in after that', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get('/guarded/:id', { security: GUARDED }, async (request, reply) => {
      reply.header('cache-control', OWN_POLICY);

      if (request.params.id === 'missing') {
        throw new AppError('NOT_FOUND_ERROR');
      }

      if (request.params.id === 'broken') {
        throw new Error('Route failed');
      }

      return { isDone: true };
    });

    const { cookies } = issueFor(fastify);
    const responses = await Promise.all(['there', 'missing', 'broken'].map((id) => fastify.inject({ url: `/guarded/${id}`, cookies })));

    assert.deepEqual(responses.map((response) => describeHeaders(response)), [
      [200, OWN_POLICY, undefined],
      [404, NO_STORE, undefined],
      [500, NO_STORE, undefined],
    ]);
  });

  test('is left to the route where it is not guarded: the guard names no policy there, whoever the request is from', async (t) => {
    const fastify = await buildOpenApp(t);

    fastify.get('/public', { security: PUBLIC }, readState);
    fastify.get('/no-security', readState);

    const { cookies } = issueFor(fastify);
    const responses = await Promise.all(['/public', '/no-security'].flatMap((url) => [
      fastify.inject({ url }),
      fastify.inject({ url, cookies }),
      fastify.inject({ method: 'HEAD', url, cookies }),
    ]));

    assert.deepEqual(responses.map((response) => describeHeaders(response)), responses.map(() => [200, undefined, undefined]));
  });
});

describe('auth plugin: a session that is over', () => {
  test('is 401 SESSION_REVOKED that names the Bearer scheme for a token that is still valid, and no cookie is touched by the guard', async (t) => {
    const endedSid = uuidv7();
    const fastify = await buildOpenApp(t, { marks: { [endedSid]: REVOKED_MARK } });
    const { calls, handler } = countCalls();

    fastify.get('/guarded', { security: GUARDED }, handler);

    const ended = issueFor(fastify, { sid: endedSid });
    const alive = issueFor(fastify);
    const refused = await Promise.all([
      fastify.inject({ url: '/guarded', cookies: ended.cookies }),
      fastify.inject({ url: '/guarded', headers: ended.headers }),
      fastify.inject({ url: '/guarded', headers: ended.headers, cookies: alive.cookies }),
    ]);

    assertRefused(refused, REVOKED);
    assert.equal(calls.count, 0);
    assert.equal((await fastify.inject({ url: '/guarded', cookies: alive.cookies })).statusCode, 200);
  });
});

describe('auth plugin: with the database down', () => {
  test('a valid token is 503 with Retry-After while Redis is down too, not 401, and the admins get one alert "Database connection failed" whatever route met it', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const sink = createLogSink();
    const fastify = await buildDownApp(t, {
      env: receiver.env.webhook,
      alert: { ...receiver.config.alert, throttleWindow: NO_THROTTLE },
      logger: { level: 'warn', stream: sink.stream },
    });
    const { calls, handler } = countCalls();

    fastify.get('/first', { security: GUARDED }, handler);
    fastify.post('/second', { security: GUARDED }, handler);

    const { cookies, headers } = issueFor(fastify);
    const responses = await Promise.all([
      fastify.inject({ url: '/first', cookies }),
      fastify.inject({ method: 'POST', url: '/second', headers: issueFor(fastify).headers }),
      fastify.inject({ url: '/first', headers }),
    ]);

    await waitFor(() => receiver.requests.length > 0, 'the alert of the database');
    await sleep(SETTLE_MS);

    assertRefused(responses, UNAVAILABLE);
    assert.equal(calls.count, 0);
    assert.deepEqual(findLogLines(sink, REQUEST_FAILED_MESSAGE).map((line) => line.level), responses.map(() => LOG_LEVEL.WARN));
    assert.deepEqual(readTitles(receiver), [DATABASE_CONNECTION_TITLE]);

    const [{ body }] = receiver.requests;

    assert.equal(body.throttleClass, 'failure');
    assert.deepEqual(pick(readBlock(body, 'Error').cause, ['type', 'code', 'isConnectFailure']), {
      type: 'DbError',
      code: REFUSED_CODE,
      isConnectFailure: true,
    });
  });

  test('a valid token is 503 also while Redis is up and has no mark of its session; one it has a mark of goes on', async (t) => {
    const unknownSid = uuidv7();
    const fastify = await buildOpenApp(t, { marks: { [unknownSid]: NO_MARK } });

    fastify.get('/guarded', { security: GUARDED }, readState);

    const unknown = issueFor(fastify, { sid: unknownSid });
    const known = issueFor(fastify);
    const [refused, allowed] = await Promise.all([unknown, known].map(({ cookies }) => fastify.inject({ url: '/guarded', cookies })));

    assertRefused([refused], UNAVAILABLE);
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json().session, { id: known.sid });
  });
});
