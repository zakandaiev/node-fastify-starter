import { MODE } from '#config/env.js';
import { assertRouteContract } from '#core/schema/route.js';
import { GROUP_SLUG } from '#enums/group.js';
import { HEADER } from '#enums/header.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { SCOPE_CATALOG } from '#enums/scope.js';
import {
  getGroupSchema,
  getMembersSchema,
  getScopesSchema,
} from '#root/src/routes/v1/groups/controller.js';
import useGroupRoutes from '#root/src/routes/v1/groups/index.js';
import { describeAnswer, readRequestId, successBody } from '#root/tests/helper/app.js';
import {
  assertRefused,
  BEARER,
  buildOpenApp,
  describeHeaders,
  describeRefusal,
  FORBIDDEN,
  issueFor,
  NO_STORE,
  UNAUTHENTICATED,
  UNAVAILABLE,
} from '#root/tests/helper/guard.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { buildDownApp } from '#root/tests/helper/session.js';
import * as groupSchema from '#schemas/entity/group.js';
import * as userSchema from '#schemas/entity/user.js';
import { uuidv7 } from '#utils/id.js';
import { freezeDeep, pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const PUBLIC = Object.freeze({ auth: false });
const READ = freezeDeep({ auth: true, scopes: ['groups:read', 'groups:manage'] });
const MANAGE = freezeDeep({ auth: true, scopes: ['groups:manage'] });
const READ_MEMBERS = freezeDeep({ auth: true, scopes: [['groups:read', 'users:read'], ['groups:manage', 'users:read']] });

const GROUPS_URL = '/api/v1/groups';
const SCOPES_URL = `${GROUPS_URL}/scopes`;
const GROUP_URL = `${GROUPS_URL}/${uuidv7()}`;
const MEMBERS_URL = `${GROUP_URL}/members`;
const MEMBER_URL = `${MEMBERS_URL}/${uuidv7()}`;
const BAD_ID = 'not-a-uuid';

const MOVED_PREFIX = '/api/v2/groups';
const DOCS_URL = '/docs/json';

const BROKEN_JSON = '{"name":';

const OUTAGE = Object.freeze({ statusCode: 500, code: 'SERVER_ERROR', message: 'Server error' });
const PROTECTED = Object.freeze({ statusCode: 409, code: 'GROUP_PROTECTED', message: 'Group is protected' });
const UNCHANGED = Object.freeze({ statusCode: 409, code: 'NO_CHANGES', message: 'No changes' });

const PROTECTED_EXAMPLE = Object.freeze({ status: 'error', code: PROTECTED.code, message: PROTECTED.message });

const REQUEST_FAILED_MESSAGE = 'Request failed';
const REFUSED_CONNECTION = freezeDeep([LOG_LEVEL.ERROR, { type: 'DbError', code: 'ECONNREFUSED', isConnectFailure: true }]);

// A request each route takes from a caller with the scopes beside it: past the guard, it goes to the database.
const REQUESTS = freezeDeep([
  ['GET /', { method: 'GET', url: GROUPS_URL }, ['groups:read']],
  ['GET /scopes', { method: 'GET', url: SCOPES_URL }, ['groups:read']],
  ['GET /:id', { method: 'GET', url: GROUP_URL }, ['groups:read']],
  ['POST /', { method: 'POST', url: GROUPS_URL, payload: { slug: 'editors', name: 'Editors' } }, ['groups:manage']],
  ['PATCH /:id', { method: 'PATCH', url: GROUP_URL, payload: { name: 'Editors' } }, ['groups:manage']],
  ['DELETE /:id', { method: 'DELETE', url: GROUP_URL }, ['groups:manage']],
  ['GET /:groupId/members', { method: 'GET', url: MEMBERS_URL }, ['groups:read', 'users:read']],
  ['PUT /:groupId/members/:userId', { method: 'PUT', url: MEMBER_URL }, ['groups:manage']],
  ['DELETE /:groupId/members/:userId', { method: 'DELETE', url: MEMBER_URL }, ['groups:manage']],
]);

// The root of the prefix is served with the slash too: a guard that missed that spelling would leave it open.
const SLASH_REQUESTS = freezeDeep([
  ['GET / with a slash', { method: 'GET', url: `${GROUPS_URL}/` }],
  ['POST / with a slash', { method: 'POST', url: `${GROUPS_URL}/`, payload: { slug: 'editors', name: 'Editors' } }],
]);

const HEAD_REQUESTS = freezeDeep([...REQUESTS, ...SLASH_REQUESTS]
  .filter(([, request]) => request.method === 'GET')
  .map(([name, request]) => [`HEAD ${name.slice('GET '.length)}`, { ...request, method: 'HEAD' }]));

// What the validation of a route refuses, and its answer: a request the guard lets through ends there, short of the
// database. The catalog has nothing to refuse, and is answered.
const GUARD_PROBES = freezeDeep({
  'GET /': [{ url: `${GROUPS_URL}?sort=oldest` }, 422],
  'GET /scopes': [{ url: SCOPES_URL }, 200],
  'HEAD /scopes': [{ method: 'HEAD', url: SCOPES_URL }, 200],
  'GET /:id': [{ url: `${GROUPS_URL}/${BAD_ID}` }, 404],
  'POST /': [{ method: 'POST', url: GROUPS_URL, payload: {} }, 422],
  'PATCH /:id': [{ method: 'PATCH', url: GROUP_URL, payload: { slug: 'Editors' } }, 422],
  'DELETE /:id': [{ method: 'DELETE', url: `${GROUPS_URL}/${BAD_ID}` }, 404],
  'GET /:groupId/members': [{ url: `${MEMBERS_URL}?status=evil` }, 422],
  'HEAD /:groupId/members': [{ method: 'HEAD', url: `${MEMBERS_URL}?status=evil` }, 422],
  'PUT /:groupId/members/:userId': [{ method: 'PUT', url: `${MEMBERS_URL}/${BAD_ID}` }, 404],
  'DELETE /:groupId/members/:userId': [{ method: 'DELETE', url: `${MEMBERS_URL}/${BAD_ID}` }, 404],
});

const READING = Object.freeze(['GET /', 'GET /scopes', 'HEAD /scopes', 'GET /:id']);
const CHANGING = Object.freeze(['POST /', 'PATCH /:id', 'DELETE /:id', 'PUT /:groupId/members/:userId', 'DELETE /:groupId/members/:userId']);
const MEMBERS = Object.freeze(['GET /:groupId/members', 'HEAD /:groupId/members']);

const ALL_SCOPES_OF_GROUPS = Object.freeze(['groups:*']);
const FULL_ACCESS = Object.freeze(['*']);
const MANAGER = Object.freeze(['groups:*', 'users:read']);

// Each slug of GROUP_SLUG is reserved: the seed makes a group of the system out of whatever row holds it.
const RESERVED_POSTS = freezeDeep(Object.values(GROUP_SLUG).flatMap((slug) => [
  [`POST of "${slug}"`, { slug, name: 'Reserved' }],
  [`POST of "${slug}" with full access`, { slug, name: 'Reserved', isSuperadmin: true }],
  [`POST of "${slug}" with users:*`, { slug, name: 'Reserved', scopes: ['users:*'] }],
]).map(([name, payload]) => [name, { method: 'POST', url: GROUPS_URL, payload }]));

const MEMBER_FIELDS = Object.freeze(['id', 'email', 'firstName', 'lastName', 'status', 'createdAt']);

function withHeaders(request, headers) {
  return { ...request, headers: { ...request.headers, ...headers } };
}

function listWrongRequests() {
  return Object.entries(GUARD_PROBES)
    .filter(([, [request, statusCode]]) => request.method !== 'HEAD' && statusCode !== 200)
    .map(([name, [request]]) => [`${name} that its validation refuses`, request]);
}

function listBadBodies(fastify, entries) {
  const tooLarge = { name: 'x'.repeat(fastify.config.app.bodyLimit) };

  return entries.flatMap(([name, request]) => [
    [`${name} with a body over bodyLimit`, { ...request, payload: tooLarge }],
    [`${name} with invalid JSON`, withHeaders({ ...request, payload: BROKEN_JSON }, { [HEADER.CONTENT_TYPE]: MEDIA_TYPE.JSON })],
  ]);
}

function injectAs(fastify, { headers }, entries) {
  return Promise.all(entries.map(([, request]) => fastify.inject(withHeaders(request, headers))));
}

async function probeGuard(fastify, scopes, names) {
  const { headers } = issueFor(fastify, scopes);
  const responses = await Promise.all(names.map((name) => fastify.inject(withHeaders(GUARD_PROBES[name][0], headers))));

  return responses.map((response, index) => [names[index], response.statusCode]);
}

function expectStatuses(names, passing) {
  return names.map((name) => [name, passing.includes(name)
    ? GUARD_PROBES[name][1]
    : FORBIDDEN.statusCode]);
}

// The lines come in the order the requests failed: each answer finds its own by the id of its request.
function readFailures(sink, responses) {
  const lines = findLogLines(sink, REQUEST_FAILED_MESSAGE);

  return responses.map((response) => lines
    .filter((line) => line.requestId === readRequestId(response))
    .map((line) => [line.level, pick(line.err, ['type', 'code', 'isConnectFailure'])]));
}

async function listDeclaredRoutes(fastify) {
  const routes = [];

  // A copy: Fastify writes the second spelling of the root of a prefix into the same options.
  fastify.addHook('onRoute', (routeOptions) => routes.push({ ...routeOptions }));
  await fastify.register(useGroupRoutes, { prefix: MOVED_PREFIX });

  return routes;
}

// OpenAPI names a term of the scopes once for each way the token rides in.
function bothWays(term) {
  return [{ cookieAuth: term }, { bearerAuth: term }];
}

function listOperations(paths) {
  return Object.entries(paths)
    .filter(([path]) => path.startsWith(GROUPS_URL))
    .flatMap(([path, operations]) => Object.entries(operations).map(([method, operation]) => [`${method.toUpperCase()} ${path}`, operation]));
}

describe('routes of groups: who may call them', () => {
  test('each has the method, the path and the scopes of its contract, and a GET a HEAD twin of its scopes: a read takes groups:read or groups:manage, a change groups:manage, the members users:read beside either', async (t) => {
    const routes = await listDeclaredRoutes(await buildDownApp(t));

    assert.deepEqual(routes.filter(({ method }) => method !== 'HEAD').map(({ method, url, security }) => [method, url, security]), [
      ['GET', MOVED_PREFIX, READ],
      ['GET', `${MOVED_PREFIX}/scopes`, READ],
      ['GET', `${MOVED_PREFIX}/:id`, READ],
      ['POST', MOVED_PREFIX, MANAGE],
      ['PATCH', `${MOVED_PREFIX}/:id`, MANAGE],
      ['DELETE', `${MOVED_PREFIX}/:id`, MANAGE],
      ['GET', `${MOVED_PREFIX}/:groupId/members`, READ_MEMBERS],
      ['PUT', `${MOVED_PREFIX}/:groupId/members/:userId`, MANAGE],
      ['DELETE', `${MOVED_PREFIX}/:groupId/members/:userId`, MANAGE],
    ]);
    assert.deepEqual(routes.filter(({ method }) => method === 'HEAD').map(({ url, security }) => [url, security]), [
      [MOVED_PREFIX, READ],
      [`${MOVED_PREFIX}/`, READ],
      [`${MOVED_PREFIX}/scopes`, READ],
      [`${MOVED_PREFIX}/:id`, READ],
      [`${MOVED_PREFIX}/:groupId/members`, READ_MEMBERS],
    ]);
    routes.forEach((route) => {
      assert.doesNotThrow(() => assertRouteContract(route));
    });
  });

  test('a guest gets 401 that names the Bearer scheme from every one, before a body over bodyLimit, invalid JSON, a wrong id or a wrong query is looked at', async (t) => {
    const fastify = await buildDownApp(t);
    const requests = [...REQUESTS, ...SLASH_REQUESTS, ...listBadBodies(fastify, REQUESTS), ...listWrongRequests()];
    const responses = await Promise.all(requests.map(([, request]) => fastify.inject(request)));
    const heads = await Promise.all(HEAD_REQUESTS.map(([, request]) => fastify.inject(request)));

    assertRefused(responses, UNAUTHENTICATED, requests.map(([name]) => name));
    assert.deepEqual(
      heads.map((response, index) => [HEAD_REQUESTS[index][0], describeHeaders(response)]),
      HEAD_REQUESTS.map(([name]) => [name, [UNAUTHENTICATED.statusCode, NO_STORE, BEARER]]),
    );
  });

  test('a user whose token lacks the scopes of a route gets 403 that names no scheme and may not be stored, before a body over bodyLimit, invalid JSON, a wrong id or a wrong query is looked at', async (t) => {
    const fastify = await buildOpenApp(t);
    const beyondReader = [...CHANGING, 'POST / with a slash', 'GET /:groupId/members'];
    const changes = [...REQUESTS, ...SLASH_REQUESTS].filter(([name]) => beyondReader.includes(name));
    const requests = [...REQUESTS, ...SLASH_REQUESTS, ...listBadBodies(fastify, REQUESTS), ...listWrongRequests()];
    const ofReader = [...changes, ...listBadBodies(fastify, changes)];
    const [ofNobody, ofUsersOnly, ofGroupReader] = await Promise.all([
      injectAs(fastify, issueFor(fastify, []), requests),
      injectAs(fastify, issueFor(fastify, ['users:*']), requests),
      injectAs(fastify, issueFor(fastify, ['groups:read']), ofReader),
    ]);
    const heads = await injectAs(fastify, issueFor(fastify, ['users:read']), HEAD_REQUESTS);

    assertRefused(ofNobody, FORBIDDEN, requests.map(([name]) => name));
    assertRefused(ofUsersOnly, FORBIDDEN, requests.map(([name]) => name));
    assertRefused(ofGroupReader, FORBIDDEN, ofReader.map(([name]) => name));
    assert.deepEqual(
      heads.map((response, index) => [HEAD_REQUESTS[index][0], describeHeaders(response)]),
      HEAD_REQUESTS.map(([name]) => [name, [FORBIDDEN.statusCode, NO_STORE, undefined]]),
    );
  });

  test('reading takes groups:read or groups:manage and a change groups:manage, either also through groups:* or full access, and the scopes of users pass neither', async (t) => {
    const fastify = await buildOpenApp(t);
    const names = [...READING, ...CHANGING];
    const profiles = [
      [[], []],
      [['users:*'], []],
      [['groups:read'], READING],
      [['groups:read', 'users:read'], READING],
      [['groups:manage'], names],
      [ALL_SCOPES_OF_GROUPS, names],
      [FULL_ACCESS, names],
    ];
    const statuses = await Promise.all(profiles.map(([scopes]) => probeGuard(fastify, scopes, names)));

    assert.deepEqual(
      statuses.map((list, index) => [profiles[index][0], list]),
      profiles.map(([scopes, passing]) => [scopes, expectStatuses(names, passing)]),
    );
  });

  test('the members of a group take users:read beside groups:read or groups:manage: either alone, or users:read alone, is 403', async (t) => {
    const fastify = await buildOpenApp(t);
    const profiles = [
      [['groups:read'], []],
      [['groups:manage'], []],
      [['users:read'], []],
      [ALL_SCOPES_OF_GROUPS, []],
      [['users:*'], []],
      [['groups:read', 'users:read'], MEMBERS],
      [['groups:manage', 'users:read'], MEMBERS],
      [['groups:*', 'users:*'], MEMBERS],
      [FULL_ACCESS, MEMBERS],
    ];
    const statuses = await Promise.all(profiles.map(([scopes]) => probeGuard(fastify, scopes, MEMBERS)));

    assert.deepEqual(
      statuses.map((list, index) => [profiles[index][0], list]),
      profiles.map(([scopes, passing]) => [scopes, expectStatuses(MEMBERS, passing)]),
    );
  });
});

describe('routes of groups with a service down', () => {
  test('with Redis and the database down, every route answers a valid token 503 with Retry-After, with the scopes or with none: the session is checked before the scopes', async (t) => {
    const fastify = await buildDownApp(t);
    const [ofHolder, ofNobody] = await Promise.all([
      injectAs(fastify, issueFor(fastify, FULL_ACCESS), REQUESTS),
      injectAs(fastify, issueFor(fastify, []), REQUESTS),
    ]);

    assertRefused([...ofHolder, ...ofNobody], UNAVAILABLE, [...REQUESTS, ...REQUESTS].map(([name]) => name));
  });

  test('with Redis alive and the database down, the scopes of its contract take a token past the guard of every route: the catalog is answered, every other route reaches the database and answers the 500 of its outage', async (t) => {
    const sink = createLogSink();
    const fastify = await buildOpenApp(t, { logger: { level: 'error', stream: sink.stream } });
    const catalogEntry = REQUESTS.find(([name]) => name === 'GET /scopes');
    const outages = REQUESTS.filter((entry) => entry !== catalogEntry);
    const [catalog, ...responses] = await Promise.all([catalogEntry, ...outages].map(([, request, scopes]) => fastify.inject(withHeaders(request, issueFor(fastify, scopes).headers))));

    assert.deepEqual(describeAnswer(catalog), {
      statusCode: 200,
      body: successBody(catalog, SCOPE_CATALOG),
      retryAfter: undefined,
      challenge: undefined,
      cacheControl: NO_STORE,
      cookies: undefined,
    });
    assertRefused(responses, OUTAGE, outages.map(([name]) => name));
    assert.deepEqual(readFailures(sink, responses), outages.map(() => [REFUSED_CONNECTION]));
  });

  test('with Redis alive and the database down, the holder rule waits for what the database grants, whatever the token holds: a scope or full access beyond the token, the scopes it holds and a reserved slug for a group that is there are the 500 of the outage, each with the error line of its refused connection', async (t) => {
    const sink = createLogSink();
    const fastify = await buildOpenApp(t, { logger: { level: 'error', stream: sink.stream } });
    const requests = [
      ['POST of a scope beyond the token', { method: 'POST', url: GROUPS_URL, payload: { slug: 'editors', name: 'Editors', scopes: ['groups:read', 'users:*'] } }],
      ['POST of full access', { method: 'POST', url: GROUPS_URL, payload: { slug: 'editors', name: 'Editors', isSuperadmin: true } }],
      ['POST of the scopes the token holds', { method: 'POST', url: GROUPS_URL, payload: { slug: 'editors', name: 'Editors', scopes: ['groups:manage', 'groups:read', 'users:read'] } }],
      ['PATCH of a scope beyond the token', { method: 'PATCH', url: GROUP_URL, payload: { scopes: ['users:*'] } }],
      ['PATCH of full access', { method: 'PATCH', url: GROUP_URL, payload: { isSuperadmin: true } }],
      ...Object.values(GROUP_SLUG).map((slug) => [`PATCH to "${slug}"`, { method: 'PATCH', url: GROUP_URL, payload: { slug } }]),
    ];
    const responses = await injectAs(fastify, issueFor(fastify, MANAGER), requests);

    assertRefused(responses, OUTAGE, requests.map(([name]) => name));
    assert.deepEqual(readFailures(sink, responses), requests.map(() => [REFUSED_CONNECTION]));
  });
});

describe('routes of groups: what the service refuses before the database', () => {
  test('nobody adds themselves to a group or takes themselves out of one, a manager of groups or a holder of full access: 403 while the database is down', async (t) => {
    const fastify = await buildOpenApp(t);
    const tokens = [MANAGER, FULL_ACCESS].map((scopes) => issueFor(fastify, scopes));
    const entries = tokens.flatMap(({ userId, scopes, headers }) => ['PUT', 'DELETE'].map((method) => [
      `${method} of themselves with ${scopes.join(', ')}`,
      { method, url: `${MEMBERS_URL}/${userId}`, headers },
    ]));
    const responses = await Promise.all(entries.map(([, request]) => fastify.inject(request)));

    assertRefused(responses, FORBIDDEN, entries.map(([name]) => name));
  });

  test('no new group takes the slug of a group of the system, whatever it grants and whoever asks, a holder of full access too: 409 GROUP_PROTECTED while the database is down', async (t) => {
    const fastify = await buildOpenApp(t);
    const [ofManager, ofHolder] = await Promise.all([MANAGER, FULL_ACCESS].map((scopes) => injectAs(fastify, issueFor(fastify, scopes), RESERVED_POSTS)));

    assertRefused([...ofManager, ...ofHolder], PROTECTED, [...RESERVED_POSTS, ...RESERVED_POSTS].map(([name]) => name));
  });

  test('a change that names nothing is 409 NO_CHANGES while the database is down', async (t) => {
    const fastify = await buildOpenApp(t);
    const response = await fastify.inject(withHeaders({ method: 'PATCH', url: GROUP_URL, payload: {} }, issueFor(fastify, ['groups:manage']).headers));

    assert.deepEqual(describeAnswer(response), describeRefusal(response, UNCHANGED));
  });
});

describe('routes of groups: what they say', () => {
  test('in dev mode the spec documents each with its scopes as role names of the cookie and of the Bearer header, with 401 and 403, and a route that may meet a protected group with a 409 of the codes it answers with, the first of them its example', async (t) => {
    const fastify = await buildDownApp(t, { env: { APP_MODE: MODE.DEV } });
    const response = await fastify.inject(DOCS_URL);
    const operations = listOperations(response.json().paths);
    const reading = [...bothWays(['groups:read']), ...bothWays(['groups:manage'])];
    const changing = bothWays(['groups:manage']);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(operations.map(([name, operation]) => [name, operation.security]), [
      [`GET ${GROUPS_URL}`, reading],
      [`POST ${GROUPS_URL}`, changing],
      [`GET ${SCOPES_URL}`, reading],
      [`GET ${GROUPS_URL}/{id}`, reading],
      [`PATCH ${GROUPS_URL}/{id}`, changing],
      [`DELETE ${GROUPS_URL}/{id}`, changing],
      [`GET ${GROUPS_URL}/{groupId}/members`, [...bothWays(['groups:read', 'users:read']), ...bothWays(['groups:manage', 'users:read'])]],
      [`PUT ${GROUPS_URL}/{groupId}/members/{userId}`, changing],
      [`DELETE ${GROUPS_URL}/{groupId}/members/{userId}`, changing],
    ]);
    assert.deepEqual(
      operations.map(([name, { tags, responses }]) => [name, tags, responses['401']?.description, responses['403']?.description]),
      operations.map(([name]) => [name, ['Groups'], 'Unauthorized: AUTHENTICATION_ERROR, SESSION_REVOKED', 'Forbidden: AUTHORIZATION_ERROR, ORIGIN_ERROR']),
    );
    assert.deepEqual(
      operations
        .filter(([, { responses }]) => Object.hasOwn(responses, '409'))
        .map(([name, { responses }]) => [name, responses['409'].description, responses['409'].content[MEDIA_TYPE.JSON].example]),
      [
        [`POST ${GROUPS_URL}`, 'Conflict: GROUP_PROTECTED', PROTECTED_EXAMPLE],
        [`PATCH ${GROUPS_URL}/{id}`, 'Conflict: GROUP_PROTECTED, NO_CHANGES', PROTECTED_EXAMPLE],
        [`DELETE ${GROUPS_URL}/{id}`, 'Conflict: GROUP_PROTECTED', PROTECTED_EXAMPLE],
        [`DELETE ${GROUPS_URL}/{groupId}/members/{userId}`, 'Conflict: GROUP_PROTECTED', PROTECTED_EXAMPLE],
      ],
    );
  });

  test('what a handler would hand out by mistake never reaches the body: a group is its fields with its scopes, a member six fields of a user, a scope its code, its name and its description', async (t) => {
    const fastify = await buildDownApp(t);
    const extra = { passwordHash: 'row-secret', grantedBy: uuidv7() };
    const group = groupSchema.example;
    const [entry] = SCOPE_CATALOG;

    fastify.get('/api/v1/leaks/groups/:id', { schema: getGroupSchema, security: PUBLIC }, (request, reply) => reply.ok({ ...group, ...extra }));
    fastify.get('/api/v1/leaks/groups/:groupId/members', { schema: getMembersSchema, security: PUBLIC }, (request, reply) => reply.list({
      data: [{ ...userSchema.example, ...extra }],
    }));
    fastify.get('/api/v1/leaks/scopes', { schema: getScopesSchema, security: PUBLIC }, (request, reply) => reply.list({ data: [{ ...entry, ...extra }] }));

    const [one, members, scopes] = await Promise.all([
      fastify.inject(`/api/v1/leaks/groups/${group.id}`),
      fastify.inject(`/api/v1/leaks/groups/${group.id}/members`),
      fastify.inject('/api/v1/leaks/scopes'),
    ]);

    assert.deepEqual(one.json(), successBody(one, group));
    assert.deepEqual(members.json(), successBody(members, [pick(userSchema.example, MEMBER_FIELDS)]));
    assert.deepEqual(scopes.json(), successBody(scopes, [entry]));
  });
});
