import { IMAGE_INPUT_TYPES } from '#core/image/profile.js';
import { assertRouteContract } from '#core/schema/route.js';
import { FILE_CHECK } from '#enums/file-check.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { USER_STATUS } from '#enums/user-status.js';
import { getUserSchema, getUsersSchema } from '#root/src/routes/v1/users/controller.js';
import useUserRoutes from '#root/src/routes/v1/users/index.js';
import { describeAnswer, successBody } from '#root/tests/helper/app.js';
import {
  assertHeadsRefused,
  assertRefused,
  bothWays,
  buildOpenApp,
  describeRefusal,
  expectStatuses,
  FORBIDDEN,
  injectAs,
  issueFor,
  listBadBodies,
  listDeclaredRoutes,
  listHeadTwins,
  listWrongRequests,
  OUTAGE,
  probeGuard,
  readDocumentedOperations,
  readFailureLines,
  REFUSED_CONNECTION,
  UNAUTHENTICATED,
  UNAVAILABLE,
  withHeaders,
} from '#root/tests/helper/guard.js';
import { createLogSink } from '#root/tests/helper/log.js';
import {
  createImage,
  createUploadSection,
  listStored,
  removeTestUploads,
  textPart,
} from '#root/tests/helper/multipart.js';
import { avatarPart, patchMeFormRequest } from '#root/tests/helper/route.js';
import { buildDownApp } from '#root/tests/helper/session.js';
import * as userSchema from '#schemas/entity/user.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import { freezeDeep, pick } from '#utils/object.js';
import { convertStringToBytes } from '#utils/string.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, describe, test } from 'node:test';

after(() => removeTestUploads());

const PUBLIC = Object.freeze({ auth: false });
const OWN = Object.freeze({ auth: true });
const READ = freezeDeep({ auth: true, scopes: ['users:read', 'users:manage'] });
const MANAGE = freezeDeep({ auth: true, scopes: ['users:manage'] });

const USERS_URL = '/api/v1/users';
const ME_URL = `${USERS_URL}/me`;
const USER_URL = `${USERS_URL}/${uuidv7()}`;
const BAD_ID = 'not-a-uuid';
const CAPITAL_ID = uuidv7().toUpperCase();
const BAD_USER_URL = `${USERS_URL}/${BAD_ID}`;
const DOCUMENTED_USER_URL = `${USERS_URL}/{id}`;
const LEAKS_URL = '/api/v1/leaks/users';

const MOVED_PREFIX = '/api/v2/users';

const NAME = 'Anna';
const JOINED_NAME = 'Jean-Luc';
const APOSTROPHE_NAME = "O'Connor";
const CYRILLIC_NAME = "Мар'яна";
const PADDED_NAME = '  Kovalenko  ';
const PADDED_EMAIL = '  Anna@Example.COM  ';
const TITLED_NAME = 'Dr. X';
const DIGIT_NAME = 'R2D2';
const GRINNING_FACE = String.fromCodePoint(0x1F600);
const EMOJI_NAME = `${NAME}${GRINNING_FACE}`;
const NOT_AN_ADDRESS = 'anna.example.com';
const NOT_TEXT = 42;
const UNKNOWN_SORT = 'oldest';
const BODY_FIELD = 'firstName';

const NOT_FOUND = Object.freeze({ statusCode: 404, code: 'NOT_FOUND_ERROR', message: 'Not found' });
const UNCHANGED = Object.freeze({ statusCode: 409, code: 'NO_CHANGES', message: 'No changes' });
const INVALID = Object.freeze({ statusCode: 422, code: 'VALIDATION_ERROR', message: 'Validation error' });

const UNCHANGED_EXAMPLE = Object.freeze({ status: 'error', code: UNCHANGED.code, message: UNCHANGED.message });
const PROTECTED_EXAMPLE = Object.freeze({ status: 'error', code: 'GROUP_PROTECTED', message: 'Group is protected' });
const USERS_TAGS = Object.freeze(['Users']);
const UNAUTHORIZED_DESCRIPTION = 'Unauthorized: AUTHENTICATION_ERROR, SESSION_REVOKED';
const FORBIDDEN_DESCRIPTION = 'Forbidden: AUTHORIZATION_ERROR, ORIGIN_ERROR';

const NO_SCOPES = Object.freeze([]);
const READER = Object.freeze(['users:read']);
const MANAGER = Object.freeze(['users:manage']);
const ALL_SCOPES_OF_USERS = Object.freeze(['users:*']);
const ALL_SCOPES_OF_GROUPS = Object.freeze(['groups:*']);
const READER_WITH_GROUPS = Object.freeze(['groups:*', 'users:read']);
const FULL_ACCESS = Object.freeze(['*']);

const LIST_FIELDS = Object.freeze(['id', 'email', 'firstName', 'lastName', 'avatarUrl', 'status', 'createdAt']);
const MANAGED_FIELDS = Object.freeze(['email', 'firstName', 'lastName']);
const PROFILE_FIELDS = Object.freeze(['firstName', 'lastName']);
const NAME_FORMAT = 'person-name';
const EMAIL_FORMAT = 'email';
const NULLABLE_TEXT = Object.freeze(['string', 'null']);
const SUCCESS_CODES = Object.freeze(['200', '204']);
const LIST_ORDER = freezeDeep({ enum: ['newest', 'name'], default: 'newest' });

// The avatar of PATCH /me: in JSON null alone, which removes it, in a form a file of these types and size.
const AVATAR_JSON_FIELD = freezeDeep({ type: 'null', description: 'null removes the file; a file itself is sent as multipart/form-data' });
const AVATAR_FORM_FIELD = freezeDeep({
  type: 'string',
  format: 'binary',
  description: 'A file of image/jpeg, image/png, image/webp, of at most 5 MB; the text null removes it',
});
const AVATAR_MAX_SIZE = convertStringToBytes('5MB');
const SMALL_AVATAR_MAX_SIZE = '1MB';
const KB = 1024;

// The key of a file of somebody else, as a client would name it in place of the file.
const STRANGER_KEY = `${uuidv7()}.webp`;

const PHOTO_WIDTH = 64;
const PHOTO_HEIGHT = 48;
const PHOTO = await createImage(PHOTO_WIDTH, PHOTO_HEIGHT).png().toBuffer();
const PROGRAM = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(KB)]);
const OVERSIZED = Buffer.alloc(AVATAR_MAX_SIZE + KB, 1);

// A request each route takes from a caller with the scopes beside it: past the guard, it goes to the database.
const REQUESTS = freezeDeep([
  ['GET /me', { method: 'GET', url: ME_URL }, NO_SCOPES],
  ['PATCH /me', { method: 'PATCH', url: ME_URL, payload: { firstName: NAME } }, NO_SCOPES],
  ['DELETE /me', { method: 'DELETE', url: ME_URL }, NO_SCOPES],
  ['GET /', { method: 'GET', url: USERS_URL }, READER],
  ['GET /:id', { method: 'GET', url: USER_URL }, READER],
  ['PATCH /:id', { method: 'PATCH', url: USER_URL, payload: { firstName: NAME } }, MANAGER],
  ['DELETE /:id', { method: 'DELETE', url: USER_URL }, MANAGER],
  ['POST /:id/block', { method: 'POST', url: `${USER_URL}/block` }, MANAGER],
  ['POST /:id/unblock', { method: 'POST', url: `${USER_URL}/unblock` }, MANAGER],
]);

const SCOPED_REQUESTS = freezeDeep(REQUESTS.filter(([, request]) => request.url !== ME_URL));

// The root of the prefix is served with the slash too: a guard that missed that spelling would leave it open.
const SLASH_REQUESTS = freezeDeep([['GET / with a slash', { method: 'GET', url: `${USERS_URL}/` }]]);

const HEAD_REQUESTS = freezeDeep(listHeadTwins([...REQUESTS, ...SLASH_REQUESTS]));

const SCOPED_HEAD_REQUESTS = freezeDeep(HEAD_REQUESTS.filter(([, request]) => request.url !== ME_URL));

// What the validation of a route refuses, and its answer: a request the guard lets through ends there, short of the
// database.
const GUARD_PROBES = freezeDeep({
  'PATCH /me': [{ method: 'PATCH', url: ME_URL, payload: { firstName: TITLED_NAME } }, 422],
  'GET /': [{ url: `${USERS_URL}?sort=${UNKNOWN_SORT}` }, 422],
  'HEAD /': [{ method: 'HEAD', url: `${USERS_URL}?sort=${UNKNOWN_SORT}` }, 422],
  'GET /:id': [{ url: BAD_USER_URL }, 404],
  'HEAD /:id': [{ method: 'HEAD', url: BAD_USER_URL }, 404],
  'PATCH /:id': [{ method: 'PATCH', url: USER_URL, payload: { firstName: NOT_TEXT } }, 422],
  'DELETE /:id': [{ method: 'DELETE', url: BAD_USER_URL }, 404],
  'POST /:id/block': [{ method: 'POST', url: `${BAD_USER_URL}/block` }, 404],
  'POST /:id/unblock': [{ method: 'POST', url: `${BAD_USER_URL}/unblock` }, 404],
});

const OWNING = Object.freeze(['PATCH /me']);
const READING = Object.freeze(['GET /', 'HEAD /', 'GET /:id', 'HEAD /:id']);
const CHANGING = Object.freeze(['PATCH /:id', 'DELETE /:id', 'POST /:id/block', 'POST /:id/unblock']);
const DELETE_ME = 'DELETE /me';

// DELETE /me clears the cookies of its session once the user is gone, unless it came with a Bearer token: only one with
// the cookie shows that a deletion which failed leaves them.
function withToken(fastify, [name, request, scopes]) {
  const { cookies, headers } = issueFor(fastify, scopes);

  return name === DELETE_ME
    ? { ...request, cookies }
    : withHeaders(request, headers);
}

function injectPatches(fastify, entries) {
  return Promise.all(entries.map(([, url, payload, { headers }]) => fastify.inject({
    method: 'PATCH',
    url,
    payload,
    headers,
  })));
}

function describeInvalid(response, entry) {
  const refusal = describeRefusal(response, INVALID);

  return { ...refusal, body: { ...refusal.body, validation: [entry] } };
}

function listUserRequests(id) {
  const url = `${USERS_URL}/${id}`;

  return [
    ['GET /:id', { method: 'GET', url }],
    ['PATCH /:id', { method: 'PATCH', url, payload: { firstName: NAME } }],
    ['DELETE /:id', { method: 'DELETE', url }],
    ['POST /:id/block', { method: 'POST', url: `${url}/block` }],
    ['POST /:id/unblock', { method: 'POST', url: `${url}/unblock` }],
  ];
}

function listSelfChanges({ userId, scopes, headers }) {
  return listUserRequests(userId)
    .filter(([name]) => CHANGING.includes(name))
    .map(([name, request]) => [`${name} of themselves with ${scopes.join(', ')}`, withHeaders(request, headers)]);
}

function readJsonSchema(part) {
  return part?.content?.[MEDIA_TYPE.JSON]?.schema;
}

function readSuccess(responses) {
  const code = SUCCESS_CODES.find((statusCode) => Object.hasOwn(responses, statusCode));

  return [code, readJsonSchema(responses[code])?.properties.data];
}

function readFormats(schema) {
  return Object.entries(schema.properties).map(([field, { format }]) => [field, format]);
}

function readParameters(parameters = []) {
  return parameters.map((parameter) => [parameter.in, parameter.name, parameter.required]);
}

function patchMeForm(headers, parts) {
  return withHeaders(patchMeFormRequest(parts), headers);
}

// An app whose storage root is a folder of its own: what a test stores there is all its root holds.
async function buildUploadApp(build, t, sections = {}) {
  const fastify = await build(t, { ...sections, upload: { ...sections.upload, ...createUploadSection() } });

  return { fastify, root: fastify.config.upload.storage.root };
}

describe('routes of users: who may call them', () => {
  test('each has the method, the path and the security of its contract, and a GET a HEAD twin of its security: one\'s own account takes any signed-in user, a read users:read or users:manage, a change users:manage', async (t) => {
    const routes = await listDeclaredRoutes(await buildDownApp(t), useUserRoutes, MOVED_PREFIX);

    assert.deepEqual(routes.filter(({ method }) => method !== 'HEAD').map(({ method, url, security }) => [method, url, security]), [
      ['GET', `${MOVED_PREFIX}/me`, OWN],
      ['PATCH', `${MOVED_PREFIX}/me`, OWN],
      ['DELETE', `${MOVED_PREFIX}/me`, OWN],
      ['GET', MOVED_PREFIX, READ],
      ['GET', `${MOVED_PREFIX}/:id`, READ],
      ['PATCH', `${MOVED_PREFIX}/:id`, MANAGE],
      ['DELETE', `${MOVED_PREFIX}/:id`, MANAGE],
      ['POST', `${MOVED_PREFIX}/:id/block`, MANAGE],
      ['POST', `${MOVED_PREFIX}/:id/unblock`, MANAGE],
    ]);
    assert.deepEqual(routes.filter(({ method }) => method === 'HEAD').map(({ url, security }) => [url, security]), [
      [`${MOVED_PREFIX}/me`, OWN],
      [MOVED_PREFIX, READ],
      [`${MOVED_PREFIX}/`, READ],
      [`${MOVED_PREFIX}/:id`, READ],
    ]);
    routes.forEach((route) => {
      assert.doesNotThrow(() => assertRouteContract(route));
    });
  });

  test('a guest gets 401 that names the Bearer scheme from every one, before a body over bodyLimit, invalid JSON, a wrong id or a wrong query is looked at', async (t) => {
    const fastify = await buildDownApp(t);
    const requests = [...REQUESTS, ...SLASH_REQUESTS, ...listBadBodies(fastify, REQUESTS, BODY_FIELD), ...listWrongRequests(GUARD_PROBES)];
    const responses = await Promise.all(requests.map(([, request]) => fastify.inject(request)));
    const heads = await Promise.all(HEAD_REQUESTS.map(([, request]) => fastify.inject(request)));

    assertRefused(responses, UNAUTHENTICATED, requests.map(([name]) => name));
    assertHeadsRefused(heads, UNAUTHENTICATED, HEAD_REQUESTS.map(([name]) => name));
  });

  test('a guest who sends PATCH /me a form with a photo gets 401 before the body is parsed: the storage root is never even made', async (t) => {
    const { fastify, root } = await buildUploadApp(buildDownApp, t);
    const response = await fastify.inject(patchMeForm({}, [textPart('firstName', NAME), avatarPart(PHOTO)]));

    assertRefused([response], UNAUTHENTICATED);
    assert.equal(existsSync(root), false);
  });

  test('a user whose token lacks the scopes of a route gets 403 that names no scheme and may not be stored, before a body over bodyLimit, invalid JSON, a wrong id or a wrong query is looked at', async (t) => {
    const fastify = await buildOpenApp(t);
    const changes = SCOPED_REQUESTS.filter(([name]) => CHANGING.includes(name));
    const requests = [
      ...SCOPED_REQUESTS,
      ...SLASH_REQUESTS,
      ...listBadBodies(fastify, SCOPED_REQUESTS, BODY_FIELD),
      ...listWrongRequests(GUARD_PROBES, [...READING, ...CHANGING]),
    ];
    const ofReader = [...changes, ...listBadBodies(fastify, changes, BODY_FIELD), ...listWrongRequests(GUARD_PROBES, CHANGING)];
    const [ofNobody, ofGroupsOnly, ofUserReader] = await Promise.all([
      injectAs(fastify, issueFor(fastify, NO_SCOPES), requests),
      injectAs(fastify, issueFor(fastify, ALL_SCOPES_OF_GROUPS), requests),
      injectAs(fastify, issueFor(fastify, READER_WITH_GROUPS), ofReader),
    ]);
    const heads = await injectAs(fastify, issueFor(fastify, ALL_SCOPES_OF_GROUPS), SCOPED_HEAD_REQUESTS);

    assertRefused(ofNobody, FORBIDDEN, requests.map(([name]) => name));
    assertRefused(ofGroupsOnly, FORBIDDEN, requests.map(([name]) => name));
    assertRefused(ofUserReader, FORBIDDEN, ofReader.map(([name]) => name));
    assertHeadsRefused(heads, FORBIDDEN, SCOPED_HEAD_REQUESTS.map(([name]) => name));
  });

  test('reading takes users:read or users:manage and a change users:manage, either also through users:* or full access, the scopes of groups pass neither, and one\'s own profile takes no scope at all', async (t) => {
    const fastify = await buildOpenApp(t);
    const names = [...OWNING, ...READING, ...CHANGING];
    const profiles = [
      [NO_SCOPES, OWNING],
      [ALL_SCOPES_OF_GROUPS, OWNING],
      [READER, [...OWNING, ...READING]],
      [READER_WITH_GROUPS, [...OWNING, ...READING]],
      [MANAGER, names],
      [ALL_SCOPES_OF_USERS, names],
      [FULL_ACCESS, names],
    ];
    const statuses = await Promise.all(profiles.map(([scopes]) => probeGuard(fastify, GUARD_PROBES, scopes, names)));

    assert.deepEqual(
      statuses.map((list, index) => [profiles[index][0], list]),
      profiles.map(([scopes, passing]) => [scopes, expectStatuses(GUARD_PROBES, names, passing)]),
    );
  });

  test('a user whose token holds no scope passes the guard of PATCH /me and DELETE /me: the parser of the body comes next and answers a body over bodyLimit with 413 and invalid JSON with 400, not 403', async (t) => {
    const fastify = await buildOpenApp(t);
    const entries = listBadBodies(fastify, REQUESTS.filter(([, request]) => request.url === ME_URL && request.method !== 'GET'), BODY_FIELD);
    const responses = await injectAs(fastify, issueFor(fastify, NO_SCOPES), entries);

    assert.deepEqual(
      responses.map((response, index) => [entries[index][0], describeAnswer(response)]),
      responses.map((response, index) => [entries[index][0], describeRefusal(response, entries[index][2])]),
    );
  });
});

describe('routes of users with a service down', () => {
  test('with Redis and the database down, every route answers a valid token 503 with Retry-After, with the scopes or with none: the session is checked before the scopes', async (t) => {
    const fastify = await buildDownApp(t);
    const [ofHolder, ofNobody] = await Promise.all([
      injectAs(fastify, issueFor(fastify, FULL_ACCESS), REQUESTS),
      injectAs(fastify, issueFor(fastify, NO_SCOPES), REQUESTS),
    ]);

    assertRefused([...ofHolder, ...ofNobody], UNAVAILABLE, [...REQUESTS, ...REQUESTS].map(([name]) => name));
  });

  test('with Redis alive and the database down, the scopes of its contract take a token past the guard of every route, and one with no scope past those of one\'s own account: each reaches the database and answers the 500 of its outage, and DELETE /me with the cookie of its session clears no cookie', async (t) => {
    const sink = createLogSink();
    const fastify = await buildOpenApp(t, { logger: { level: 'error', stream: sink.stream } });
    const responses = await Promise.all(REQUESTS.map((entry) => fastify.inject(withToken(fastify, entry))));

    assertRefused(responses, OUTAGE, REQUESTS.map(([name]) => name));
    assert.deepEqual(readFailureLines(sink, responses), REQUESTS.map(() => [REFUSED_CONNECTION]));
  });

  test('with Redis alive and the database down, null, a name of any script with a hyphen or an apostrophe inside, and a name or an email with spaces around it pass the validation of either route of a change: each reaches the database and answers the 500 of its outage', async (t) => {
    const sink = createLogSink();
    const fastify = await buildOpenApp(t, { logger: { level: 'error', stream: sink.stream } });
    const manager = issueFor(fastify, MANAGER);
    const owner = issueFor(fastify, NO_SCOPES);
    const entries = [
      ['PATCH /:id clearing the email', USER_URL, { email: null }, manager],
      ['PATCH /:id clearing both names', USER_URL, { firstName: null, lastName: null }, manager],
      ['PATCH /:id of names with a hyphen and an apostrophe', USER_URL, { firstName: JOINED_NAME, lastName: APOSTROPHE_NAME }, manager],
      ['PATCH /:id of an email in capitals with spaces around it', USER_URL, { email: PADDED_EMAIL }, manager],
      ['PATCH /me of a name of another script', ME_URL, { firstName: CYRILLIC_NAME }, owner],
      ['PATCH /me of a name with spaces around it', ME_URL, { lastName: PADDED_NAME }, owner],
      ['PATCH /me clearing a name', ME_URL, { lastName: null }, owner],
      ['PATCH /me removing the avatar', ME_URL, { avatar: null }, owner],
    ];
    const responses = await injectPatches(fastify, entries);

    assertRefused(responses, OUTAGE, entries.map(([name]) => name));
    assert.deepEqual(readFailureLines(sink, responses), entries.map(() => [REFUSED_CONNECTION]));
  });

  test('with Redis alive and the database down, PATCH /me takes as a form what it takes as JSON: a name with a photo, a photo alone and the text null of the avatar each reach the database and answer the 500 of its outage, and no photo stays in the storage root', async (t) => {
    const sink = createLogSink();
    const { fastify, root } = await buildUploadApp(buildOpenApp, t, { logger: { level: 'error', stream: sink.stream } });
    const { headers } = issueFor(fastify, NO_SCOPES);
    const forms = [
      ['a name with a photo', [textPart('firstName', CYRILLIC_NAME), avatarPart(PHOTO)]],
      ['a photo alone', [avatarPart(PHOTO)]],
      ['the text null of the avatar', [textPart('avatar', 'null')]],
    ];
    const responses = await mapSeries(forms, ([, parts]) => fastify.inject(patchMeForm(headers, parts)));

    assertRefused(responses, OUTAGE, forms.map(([name]) => name));
    assert.deepEqual(readFailureLines(sink, responses), forms.map(() => [REFUSED_CONNECTION]));
    assert.deepEqual(await listStored(root), []);
  });
});

describe('routes of users: what they refuse before the database', () => {
  test('nobody changes, deletes, blocks or unblocks themselves through the routes of a manager, a holder of users:manage or of full access: 403 while the database is down', async (t) => {
    const fastify = await buildOpenApp(t);
    const entries = [MANAGER, FULL_ACCESS].flatMap((scopes) => listSelfChanges(issueFor(fastify, scopes)));
    const responses = await Promise.all(entries.map(([, request]) => fastify.inject(request)));

    assertRefused(responses, FORBIDDEN, entries.map(([name]) => name));
  });

  test('an id that is not a UUID in lower case is 404 on every route of one user while the database is down, the capitals of a UUID too: a user has one address', async (t) => {
    const fastify = await buildOpenApp(t);
    const { headers } = issueFor(fastify, MANAGER);
    const entries = [BAD_ID, CAPITAL_ID].flatMap((id) => listUserRequests(id).map(([name, request]) => [`${name} of ${id}`, withHeaders(request, headers)]));
    const responses = await Promise.all(entries.map(([, request]) => fastify.inject(request)));

    assertRefused(responses, NOT_FOUND, entries.map(([name]) => name));
  });

  test('a change that names nothing its route takes is 409 NO_CHANGES while the database is down: the id, the status, the confirmation of the email and an unknown key are dropped, never written, and so are the email and the status on one\'s own profile', async (t) => {
    const fastify = await buildOpenApp(t);
    const manager = issueFor(fastify, MANAGER);
    const owner = issueFor(fastify, NO_SCOPES);
    const entries = [
      ['PATCH /:id of nothing', USER_URL, {}, manager],
      ['PATCH /:id of the id', USER_URL, { id: uuidv7() }, manager],
      ['PATCH /:id of the status', USER_URL, { status: USER_STATUS.BLOCKED }, manager],
      ['PATCH /:id of the confirmation of the email', USER_URL, { emailVerifiedAt: userSchema.example.emailVerifiedAt }, manager],
      ['PATCH /:id of an unknown key', USER_URL, { isAdmin: true }, manager],
      ['PATCH /me of nothing', ME_URL, {}, owner],
      ['PATCH /me of the email', ME_URL, { email: userSchema.example.email }, owner],
      ['PATCH /me of the status', ME_URL, { status: USER_STATUS.BLOCKED }, owner],
    ];
    const responses = await injectPatches(fastify, entries);

    assertRefused(responses, UNCHANGED, entries.map(([name]) => name));
  });

  test('a name that is not one word of letters is 422 of the format person-name on either route of a change, a value of a wrong type 422 of its type and an email that is no address 422 of the format email, while the database is down', async (t) => {
    const fastify = await buildOpenApp(t);
    const manager = issueFor(fastify, MANAGER);
    const owner = issueFor(fastify, NO_SCOPES);
    const entries = [
      ['PATCH /:id of a title', USER_URL, manager, {
        column: 'firstName', columnValue: TITLED_NAME, operator: 'format', operatorValue: NAME_FORMAT,
      }],
      ['PATCH /:id of a digit', USER_URL, manager, {
        column: 'lastName', columnValue: DIGIT_NAME, operator: 'format', operatorValue: NAME_FORMAT,
      }],
      ['PATCH /:id of an emoji', USER_URL, manager, {
        column: 'firstName', columnValue: EMOJI_NAME, operator: 'format', operatorValue: NAME_FORMAT,
      }],
      ['PATCH /:id of no address', USER_URL, manager, {
        column: 'email', columnValue: NOT_AN_ADDRESS, operator: 'format', operatorValue: EMAIL_FORMAT,
      }],
      ['PATCH /:id of a number', USER_URL, manager, {
        column: 'firstName', columnValue: NOT_TEXT, operator: 'type', operatorValue: NULLABLE_TEXT,
      }],
      ['PATCH /me of a title', ME_URL, owner, {
        column: 'lastName', columnValue: TITLED_NAME, operator: 'format', operatorValue: NAME_FORMAT,
      }],
      ['PATCH /me of an emoji', ME_URL, owner, {
        column: 'firstName', columnValue: EMOJI_NAME, operator: 'format', operatorValue: NAME_FORMAT,
      }],
      ['PATCH /me of a number', ME_URL, owner, {
        column: 'lastName', columnValue: NOT_TEXT, operator: 'type', operatorValue: NULLABLE_TEXT,
      }],
    ];
    const responses = await injectPatches(fastify, entries.map(([name, url, token, { column, columnValue }]) => [name, url, { [column]: columnValue }, token]));

    assert.deepEqual(
      responses.map((response, index) => [entries[index][0], describeAnswer(response)]),
      responses.map((response, index) => [entries[index][0], describeInvalid(response, entries[index][3])]),
    );
  });

  test('PATCH /me takes no text in the avatar, which would name a file of somebody else: a string is 422 of the type null as JSON and of the constant null as a field of a form, while the database is down', async (t) => {
    const fastify = await buildOpenApp(t);
    const { headers } = issueFor(fastify, NO_SCOPES);
    const [json, form] = await Promise.all([
      fastify.inject({
        method: 'PATCH', url: ME_URL, headers, payload: { avatar: STRANGER_KEY },
      }),
      fastify.inject(patchMeForm(headers, [textPart('avatar', STRANGER_KEY)])),
    ]);

    assert.deepEqual(describeAnswer(json), describeInvalid(json, {
      column: 'avatar', columnValue: STRANGER_KEY, operator: 'type', operatorValue: 'null',
    }));
    assert.deepEqual(describeAnswer(form), describeInvalid(form, {
      column: 'avatar', columnValue: STRANGER_KEY, operator: 'const', operatorValue: null,
    }));
  });

  test('PATCH /me refuses with 422 of its field a program renamed a.png and sent as image/png, a file over 5 MB and a name that is none beside a photo, while the database is down: no file stays in the storage root', async (t) => {
    const { fastify, root } = await buildUploadApp(buildOpenApp, t);
    const { headers } = issueFor(fastify, NO_SCOPES);
    const forms = [
      [[avatarPart(PROGRAM, { filename: 'a.png' })], {
        column: 'avatar', columnValue: null, operator: FILE_CHECK.MIME, operatorValue: IMAGE_INPUT_TYPES,
      }],
      [[avatarPart(OVERSIZED, { filename: 'big.png' })], {
        column: 'avatar', columnValue: null, operator: FILE_CHECK.MAX_SIZE, operatorValue: AVATAR_MAX_SIZE,
      }],
      [[textPart('firstName', TITLED_NAME), avatarPart(PHOTO)], {
        column: 'firstName', columnValue: TITLED_NAME, operator: 'format', operatorValue: NAME_FORMAT,
      }],
    ];
    const responses = await mapSeries(forms, ([parts]) => fastify.inject(patchMeForm(headers, parts)));

    assert.deepEqual(responses.map((response) => describeAnswer(response)), responses.map((response, index) => describeInvalid(response, forms[index][1])));
    assert.deepEqual(await listStored(root), []);
  });

  test('PATCH /me takes an avatar up to avatarMaxSize of config.upload: below 5 MB there, a file past it is refused with that size', async (t) => {
    const { fastify, root } = await buildUploadApp(buildOpenApp, t, { upload: { avatarMaxSize: SMALL_AVATAR_MAX_SIZE } });
    const { headers } = issueFor(fastify, NO_SCOPES);
    const maxSize = convertStringToBytes(SMALL_AVATAR_MAX_SIZE);
    const response = await fastify.inject(patchMeForm(headers, [avatarPart(Buffer.alloc(maxSize + KB, 1), { filename: 'big.png' })]));

    assert.deepEqual(describeAnswer(response), describeInvalid(response, {
      column: 'avatar', columnValue: null, operator: FILE_CHECK.MAX_SIZE, operatorValue: maxSize,
    }));
    assert.deepEqual(await listStored(root), []);
  });
});

describe('routes of users: what they say', () => {
  test('in dev mode the spec documents each under the tag Users with its scopes as role names of the cookie and of the Bearer header, with 401 and 403, and a 409 of exactly the codes its route answers with: none on a read and on an unblock', async (t) => {
    const operations = await readDocumentedOperations(t, USERS_URL);
    const own = bothWays([]);
    const reading = [...bothWays(['users:read']), ...bothWays(['users:manage'])];
    const changing = bothWays(['users:manage']);

    assert.deepEqual(operations.map(([name, operation]) => [name, operation.security]), [
      [`GET ${ME_URL}`, own],
      [`PATCH ${ME_URL}`, own],
      [`DELETE ${ME_URL}`, own],
      [`GET ${USERS_URL}`, reading],
      [`GET ${DOCUMENTED_USER_URL}`, reading],
      [`PATCH ${DOCUMENTED_USER_URL}`, changing],
      [`DELETE ${DOCUMENTED_USER_URL}`, changing],
      [`POST ${DOCUMENTED_USER_URL}/block`, changing],
      [`POST ${DOCUMENTED_USER_URL}/unblock`, changing],
    ]);
    assert.deepEqual(
      operations.map(([name, { tags, responses }]) => [name, tags, responses['401']?.description, responses['403']?.description]),
      operations.map(([name]) => [name, USERS_TAGS, UNAUTHORIZED_DESCRIPTION, FORBIDDEN_DESCRIPTION]),
    );
    assert.deepEqual(
      operations
        .filter(([, { responses }]) => Object.hasOwn(responses, '409'))
        .map(([name, { responses }]) => [name, responses['409'].description, responses['409'].content[MEDIA_TYPE.JSON].example]),
      [
        [`PATCH ${ME_URL}`, 'Conflict: NO_CHANGES', UNCHANGED_EXAMPLE],
        [`DELETE ${ME_URL}`, 'Conflict: GROUP_PROTECTED', PROTECTED_EXAMPLE],
        [`PATCH ${DOCUMENTED_USER_URL}`, 'Conflict: NO_CHANGES', UNCHANGED_EXAMPLE],
        [`DELETE ${DOCUMENTED_USER_URL}`, 'Conflict: GROUP_PROTECTED', PROTECTED_EXAMPLE],
        [`POST ${DOCUMENTED_USER_URL}/block`, 'Conflict: GROUP_PROTECTED', PROTECTED_EXAMPLE],
      ],
    );
  });

  test('in dev mode the spec documents the fields a change takes, the names in the format person-name and the avatar as null alone in JSON, and what each answer holds: a row of the list seven fields of a user, a user every field of its schema, a deletion no body', async (t) => {
    const operations = await readDocumentedOperations(t, USERS_URL);
    const bodies = operations
      .filter(([, { requestBody }]) => requestBody !== undefined)
      .map(([name, { requestBody }]) => [name, readJsonSchema(requestBody)]);
    const user = { type: 'object', properties: userSchema.properties };
    const rows = { type: 'array', items: { type: 'object', properties: pick(userSchema.properties, LIST_FIELDS) } };

    assert.deepEqual(bodies, [
      [`PATCH ${ME_URL}`, {
        type: 'object',
        properties: { ...pick(userSchema.properties, PROFILE_FIELDS), avatar: AVATAR_JSON_FIELD },
        additionalProperties: false,
      }],
      [`PATCH ${DOCUMENTED_USER_URL}`, { type: 'object', properties: pick(userSchema.properties, MANAGED_FIELDS), additionalProperties: false }],
    ]);
    assert.deepEqual(bodies.map(([name, schema]) => [name, readFormats(schema)]), [
      [`PATCH ${ME_URL}`, [['firstName', NAME_FORMAT], ['lastName', NAME_FORMAT], ['avatar', undefined]]],
      [`PATCH ${DOCUMENTED_USER_URL}`, [['email', EMAIL_FORMAT], ['firstName', NAME_FORMAT], ['lastName', NAME_FORMAT]]],
    ]);
    assert.deepEqual(operations.map(([name, { responses }]) => [name, readSuccess(responses)]), [
      [`GET ${ME_URL}`, ['200', user]],
      [`PATCH ${ME_URL}`, ['200', user]],
      [`DELETE ${ME_URL}`, ['204', undefined]],
      [`GET ${USERS_URL}`, ['200', rows]],
      [`GET ${DOCUMENTED_USER_URL}`, ['200', user]],
      [`PATCH ${DOCUMENTED_USER_URL}`, ['200', user]],
      [`DELETE ${DOCUMENTED_USER_URL}`, ['204', undefined]],
      [`POST ${DOCUMENTED_USER_URL}/block`, ['200', user]],
      [`POST ${DOCUMENTED_USER_URL}/unblock`, ['200', user]],
    ]);
  });

  test('in dev mode the spec documents a form beside JSON on PATCH /me alone, of the same fields with the avatar as a file picker for an image of at most 5 MB, and the avatar of a user as the URI of a file or null', async (t) => {
    const operations = await readDocumentedOperations(t, USERS_URL);
    const forms = operations
      .filter(([, { requestBody }]) => requestBody?.content?.[MEDIA_TYPE.FORM_DATA] !== undefined)
      .map(([name, { requestBody: { content } }]) => [name, Object.keys(content), content[MEDIA_TYPE.FORM_DATA].schema]);

    assert.deepEqual(forms, [[`PATCH ${ME_URL}`, [MEDIA_TYPE.JSON, MEDIA_TYPE.FORM_DATA], {
      type: 'object',
      properties: { ...pick(userSchema.properties, PROFILE_FIELDS), avatar: AVATAR_FORM_FIELD },
      additionalProperties: false,
    }]]);
    assert.deepEqual(pick(userSchema.properties.avatarUrl, ['type', 'format']), { type: ['string', 'null'], format: 'uri' });
  });

  test('in dev mode the spec documents the query of the list, its filters, its order with newest first by default and its page, and the id in the path of each route of one user', async (t) => {
    const operations = await readDocumentedOperations(t, USERS_URL);
    const list = operations.find(([name]) => name === `GET ${USERS_URL}`)[1];
    const byId = [['path', 'id', true]];

    assert.deepEqual(operations.map(([name, { parameters }]) => [name, readParameters(parameters)]), [
      [`GET ${ME_URL}`, []],
      [`PATCH ${ME_URL}`, []],
      [`DELETE ${ME_URL}`, []],
      [`GET ${USERS_URL}`, [
        ['query', 'firstName', false],
        ['query', 'status', false],
        ['query', 'createdAtFrom', false],
        ['query', 'createdAtTo', false],
        ['query', 'sort', false],
        ['query', 'limit', false],
        ['query', 'offset', false],
      ]],
      [`GET ${DOCUMENTED_USER_URL}`, byId],
      [`PATCH ${DOCUMENTED_USER_URL}`, byId],
      [`DELETE ${DOCUMENTED_USER_URL}`, byId],
      [`POST ${DOCUMENTED_USER_URL}/block`, byId],
      [`POST ${DOCUMENTED_USER_URL}/unblock`, byId],
    ]);
    assert.deepEqual(pick(list.parameters.find(({ name }) => name === 'sort').schema, ['enum', 'default']), LIST_ORDER);
  });

  test('what a handler would hand out by mistake never reaches the body: a user is every field of its schema, a row of the list seven of them', async (t) => {
    const fastify = await buildDownApp(t);
    const extra = { passwordHash: 'row-secret', providerUserId: 'provider-subject' };
    const user = userSchema.example;

    fastify.get(`${LEAKS_URL}/:id`, { schema: getUserSchema, security: PUBLIC }, (request, reply) => reply.ok({ ...user, ...extra }));
    fastify.get(LEAKS_URL, { schema: getUsersSchema, security: PUBLIC }, (request, reply) => reply.list({ data: [{ ...user, ...extra }] }));

    const [one, list] = await Promise.all([
      fastify.inject(`${LEAKS_URL}/${user.id}`),
      fastify.inject(LEAKS_URL),
    ]);

    assert.deepEqual(one.json(), successBody(one, user));
    assert.deepEqual(list.json(), successBody(list, [pick(user, LIST_FIELDS)]));
  });
});
