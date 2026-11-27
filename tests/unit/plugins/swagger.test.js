import { MODE } from '#config/env.js';
import { IMAGE_INPUT_TYPES } from '#core/image/profile.js';
import { addErrorResponses, createSchema } from '#core/schema/create-schema.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { SCOPE } from '#enums/scope.js';
import { buildTestApp, readRequestId } from '#root/tests/helper/app.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { errorEnvelope, successEnvelope } from '#schemas/common/envelope.js';
import { json, text } from '#schemas/common/field.js';
import * as paginationSchema from '#schemas/common/pagination.js';
import * as userSchema from '#schemas/entity/user.js';
import { UUID_LENGTH, UUID_REGEXP } from '#utils/id.js';
import { omit, pick } from '#utils/object.js';
import { isArray, isObject } from '#utils/type.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const DOCS_PREFIX = '/docs';
const MOVED_DOCS_PREFIX = '/reference';
const SPEC_PATH = '/json';
const PING_URL = '/api/v1/system/ping';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const JSON_MEDIA_TYPE = 'application/json';
const FORM_MEDIA_TYPE = 'multipart/form-data';

// A path no route of src/routes takes: the same path there would fail these tests on a duplicate route.
const PROBE_URL = '/api/v1/docs-probe/users';

const SERVED_MESSAGE = 'API docs are served';
const OFF_MESSAGE = 'API docs are off: they are served in dev mode only';

const PUBLIC = Object.freeze({ auth: false });
const GUARDED = Object.freeze({ auth: true });
const SCOPED = Object.freeze({ auth: true, scopes: [[SCOPE.GROUPS_READ, SCOPE.USERS_READ], SCOPE.GROUPS_MANAGE] });

const TOKEN_SCHEMES = Object.freeze([{ cookieAuth: [] }, { bearerAuth: [] }]);

const UNAUTHORIZED_DESCRIPTION = 'Unauthorized: AUTHENTICATION_ERROR, SESSION_REVOKED';
const FORBIDDEN_DESCRIPTION = 'Forbidden: AUTHORIZATION_ERROR, ORIGIN_ERROR';

// What @fastify/swagger writes for a route without a response schema.
const DEFAULT_ANSWER = Object.freeze({ description: 'Default Response' });

const OUTSIDE_URL = '/outside-probe';

// What the gate, the finite guards and the json marker put into a schema: only the validation reads them.
const VALIDATION_KEYS = Object.freeze(['allOf', 'finite', 'if', 'json', 'then']);

const OPEN_OBJECT = Object.freeze({ type: 'object', additionalProperties: true });

const TAGS = Object.freeze({
  type: 'array',
  items: text('Tag', { maxLength: 32 }),
  maxItems: 10,
  uniqueItems: true,
  description: 'Tags',
});

const EXTRA_SOURCE = Object.freeze({
  properties: { settings: json(), tags: TAGS },
});

const UPDATE_SCHEMA = createSchema(userSchema, EXTRA_SOURCE)
  .params(['id'])
  .body(['email', 'firstName', 'settings', 'tags'], { isPatch: true })
  .response(200, { data: ['id', 'email', 'settings'] })
  .meta({ tags: ['Users'], summary: 'Update a user' })
  .build();

const LIST_SCHEMA = createSchema(userSchema, paginationSchema)
  .query(['limit', 'offset', 'sort', 'status', 'createdAt'])
  .response(200, { data: ['id', 'email'], format: 'array' })
  .defaultResponses()
  .build();

const REMOVE_SCHEMA = createSchema(userSchema)
  .params(['id'])
  .response(204)
  .response(404)
  .build();

const FOUND_RESPONSE = Object.freeze({
  200: successEnvelope({ type: 'object', properties: { isFound: { type: 'boolean' } } }),
});

// Fastify copies "query" to "querystring" in the schema that validates, never in the one the docs read.
const SEARCH_SCHEMA = Object.freeze({
  query: {
    type: 'object',
    properties: { q: text('Text to look for') },
    additionalProperties: false,
  },
  response: FOUND_RESPONSE,
});

const SHARED_SCHEMA_ID = 'docsProbeProfile';

async function buildModeApp(t, mode, { env = {}, ...sections } = {}) {
  const fastify = await buildTestApp({ ...sections, env: { ...env, APP_MODE: mode } });

  t.after(() => fastify.close());

  return fastify;
}

function injectAll(fastify, urls) {
  return Promise.all(urls.map((url) => fastify.inject(url)));
}

async function readSpec(fastify, prefix = DOCS_PREFIX) {
  const response = await fastify.inject(`${prefix}${SPEC_PATH}`);

  assert.equal(response.statusCode, 200);

  return response.json();
}

function notFoundBody(response, message = 'Not found') {
  return {
    status: 'error',
    code: 'NOT_FOUND_ERROR',
    message,
    meta: { requestId: readRequestId(response) },
  };
}

function answerNothing(request, reply) {
  return reply.noContent();
}

// Returns the schemas the routes validate with: the hook runs after the one of the app has replaced them.
function useProbeRoutes(fastify) {
  const validated = [];

  fastify.addHook('onRoute', (routeOptions) => {
    validated.push(routeOptions.schema);
  });
  fastify.patch(`${PROBE_URL}/:id`, { schema: UPDATE_SCHEMA, security: PUBLIC }, answerNothing);
  fastify.delete(`${PROBE_URL}/:id`, { schema: REMOVE_SCHEMA, security: PUBLIC }, answerNothing);
  fastify.get(PROBE_URL, { schema: LIST_SCHEMA, security: PUBLIC }, answerNothing);
  fastify.get(`${PROBE_URL}/search`, { schema: SEARCH_SCHEMA, security: PUBLIC }, answerNothing);

  return validated;
}

function collectKeys(value) {
  if (isArray(value)) {
    return value.flatMap((item) => collectKeys(item));
  }

  return isObject(value)
    ? Object.entries(value).flatMap(([key, item]) => [key, ...collectKeys(item)])
    : [];
}

function findKeys(value, keys) {
  const found = new Set(collectKeys(value));

  return keys.filter((key) => found.has(key));
}

function readMedia(container) {
  return container.content[JSON_MEDIA_TYPE];
}

function readData(response) {
  return readMedia(response).schema.properties.data;
}

function readParameters(operation) {
  return Object.fromEntries((operation.parameters ?? []).map(({ name, ...parameter }) => [name, parameter]));
}

function readParameterSchemas(operation) {
  return Object.fromEntries(Object.entries(readParameters(operation)).map(([name, parameter]) => [name, parameter.schema]));
}

function readSummaries(paths) {
  const probePaths = Object.keys(paths).filter((path) => path.startsWith(PROBE_URL));

  return Object.fromEntries(probePaths.flatMap((path) => Object.entries(paths[path])
    .map(([method, { summary }]) => [`${method} ${path.slice(PROBE_URL.length)}`, summary])));
}

function withoutDescriptions(properties) {
  return Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, omit(schema, ['description'])]));
}

// @fastify/swagger moves the first example of a response schema next to it, under the media type.
function toDocumentedError({ examples: [example], ...schema }) {
  return { description: schema.description, content: { [JSON_MEDIA_TYPE]: { schema, example } } };
}

function documentErrorResponses(statusCodes) {
  return Object.fromEntries(Object.entries(addErrorResponses({}, statusCodes)).map(([statusCode, response]) => [statusCode, toDocumentedError(response)]));
}

describe('swagger plugin', () => {
  test('serves the UI and the spec with a dev config, and answers 404 with a prod config, in one process', async (t) => {
    const info = { APP_NAME_FORMATTED: 'Docs Probe API', APP_VERSION: '9.8.7', APP_DESCRIPTION: 'The API the docs describe' };
    const [dev, prod] = await Promise.all([buildModeApp(t, MODE.DEV, { env: info }), buildModeApp(t, MODE.PROD)]);
    const urls = [DOCS_PREFIX, `${DOCS_PREFIX}${SPEC_PATH}`];
    const [[ui, spec], prodResponses] = await Promise.all([injectAll(dev, urls), injectAll(prod, urls)]);

    assert.equal(ui.statusCode, 200);
    assert.equal(ui.headers['content-type'], HTML_CONTENT_TYPE);
    assert.match(ui.payload, /<!DOCTYPE html>/i);
    assert.equal(spec.statusCode, 200);
    assert.equal(spec.json().openapi, '3.1.0');
    assert.deepEqual(spec.json().info, { title: 'Docs Probe API', version: '9.8.7', description: 'The API the docs describe' });
    assert.deepEqual(spec.json().components.securitySchemes, {
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'accessToken' },
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    });
    prodResponses.forEach((response) => {
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), notFoundBody(response));
    });
    assert.deepEqual([dev, prod].map((fastify) => fastify.hasPlugin('@fastify/swagger')), [true, false]);
    assert.deepEqual([dev, prod].map((fastify) => fastify.hasPlugin('@fastify/swagger-ui')), [true, false]);
  });

  test('documents a route built with createSchema as its author wrote it: no gate, no finite guard, no json marker', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);
    const validated = useProbeRoutes(fastify);
    const { paths } = await readSpec(fastify);
    const update = paths[`${PROBE_URL}/{id}`].patch;
    const list = paths[PROBE_URL].get;
    const probePaths = Object.keys(paths).filter((path) => path.startsWith(PROBE_URL)).map((path) => paths[path]);

    assert.deepEqual(findKeys(validated, VALIDATION_KEYS), VALIDATION_KEYS);
    assert.deepEqual(findKeys(probePaths, VALIDATION_KEYS), []);
    assert.deepEqual(pick(update, ['summary', 'tags']), { summary: 'Update a user', tags: ['Users'] });
    assert.deepEqual(readParameters(update), {
      id: {
        schema: { type: 'string', maxLength: UUID_LENGTH, pattern: UUID_REGEXP.source },
        in: 'path',
        required: true,
        description: 'User id',
      },
    });
    assert.deepEqual(readMedia(update.requestBody).schema, {
      type: 'object',
      properties: {
        email: userSchema.properties.email,
        firstName: userSchema.properties.firstName,
        settings: OPEN_OBJECT,
        tags: TAGS,
      },
      additionalProperties: false,
    });
    assert.deepEqual(readMedia(update.requestBody).example, pick(userSchema.example, ['email', 'firstName']));
    assert.deepEqual(readData(update.responses['200']), {
      type: 'object',
      properties: { id: userSchema.properties.id, email: userSchema.properties.email, settings: OPEN_OBJECT },
    });
    assert.deepEqual(readMedia(update.responses['200']).example, { status: 'success', data: pick(userSchema.example, ['id', 'email']) });
    assert.deepEqual(readParameterSchemas(list), withoutDescriptions(LIST_SCHEMA.querystring.properties));
  });

  test('documents the query of a route that names it "query" as well as one that names it "querystring"', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);

    useProbeRoutes(fastify);

    const { paths } = await readSpec(fastify);

    assert.deepEqual(readParameters(paths[`${PROBE_URL}/search`].get), {
      q: {
        schema: text(),
        in: 'query',
        required: false,
        description: 'Text to look for',
      },
    });
    assert.deepEqual(Object.keys(readParameterSchemas(paths[PROBE_URL].get)), ['limit', 'offset', 'sort', 'status', 'createdAtFrom', 'createdAtTo']);
  });

  test('documents a 204 of createSchema without a body, and an error status with its envelope and the example of the catalog', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);

    useProbeRoutes(fastify);

    const { paths } = await readSpec(fastify);
    const { responses } = paths[`${PROBE_URL}/{id}`].delete;

    assert.deepEqual(Object.keys(responses), ['204', '404']);
    assert.deepEqual(responses['204'], { description: 'No Content' });
    assert.equal(responses['404'].description, 'Not Found: NOT_FOUND_ERROR');
    assert.deepEqual(omit(readMedia(responses['404']).schema, ['description']), errorEnvelope);
    assert.deepEqual(readMedia(responses['404']).example, { status: 'error', code: 'NOT_FOUND_ERROR', message: 'Not found' });
  });

  test('documents the codes a route names of an error status in their order and the example of the first one, beside the refusals of its guard', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);
    const schema = createSchema(userSchema)
      .params(['id'])
      .response(204)
      .response(409, { codes: [ERROR_CODE.GROUP_PROTECTED, ERROR_CODE.NO_CHANGES] })
      .response(404)
      .build();

    fastify.delete(`${PROBE_URL}/:id/protected`, { schema, security: PUBLIC }, answerNothing);
    fastify.patch(`${PROBE_URL}/:id/protected`, { schema, security: SCOPED }, answerNothing);

    const { paths } = await readSpec(fastify);
    const { delete: open, patch: scoped } = paths[`${PROBE_URL}/{id}/protected`];
    const conflict = open.responses['409'];

    assert.equal(conflict.description, 'Conflict: GROUP_PROTECTED, NO_CHANGES');
    assert.deepEqual(omit(readMedia(conflict).schema, ['description']), errorEnvelope);
    assert.deepEqual(readMedia(conflict).example, { status: 'error', code: 'GROUP_PROTECTED', message: 'Group is protected' });
    assert.deepEqual(Object.keys(open.responses), ['204', '404', '409']);
    assert.deepEqual(Object.keys(scoped.responses), ['204', '401', '403', '404', '409']);
    assert.deepEqual(scoped.responses['409'], conflict);
  });

  test('documents a route with files with both media types of its body: null in place of a file in JSON, and binary for the file picker in the form', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);
    const body = { type: 'object', properties: { firstName: userSchema.properties.firstName }, additionalProperties: false };
    const files = {
      fields: {
        avatar: { maxSize: '5MB', mime: IMAGE_INPUT_TYPES, image: IMAGE_PROFILE.AVATAR },
        scans: { max: 2, maxSize: '1MB', mime: ['application/pdf'] },
      },
    };

    fastify.patch(`${PROBE_URL}/:id/files`, { schema: { ...pick(UPDATE_SCHEMA, ['params', 'response']), body }, security: PUBLIC, files }, answerNothing);

    const { paths } = await readSpec(fastify);
    const { content } = paths[`${PROBE_URL}/{id}/files`].patch.requestBody;
    const binary = { type: 'string', format: 'binary' };

    assert.deepEqual(Object.keys(content), [JSON_MEDIA_TYPE, FORM_MEDIA_TYPE]);
    assert.deepEqual(content[JSON_MEDIA_TYPE].schema, {
      ...body,
      properties: {
        ...body.properties,
        avatar: { type: 'null', description: 'null removes the file; a file itself is sent as multipart/form-data' },
        scans: { type: 'null', description: 'null removes the files; a file itself is sent as multipart/form-data' },
      },
    });
    assert.deepEqual(content[FORM_MEDIA_TYPE].schema, {
      ...body,
      properties: {
        ...body.properties,
        avatar: { ...binary, description: 'A file of image/jpeg, image/png, image/webp, of at most 5 MB; the text null removes it' },
        scans: {
          type: 'array',
          items: binary,
          maxItems: 2,
          description: 'Up to 2 files of application/pdf, each of at most 1 MB; the text null removes them',
        },
      },
    });
  });

  test('keeps the json marker out of a shared schema that a route reaches by $ref', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);

    fastify.addSchema({
      $id: SHARED_SCHEMA_ID,
      type: 'object',
      properties: { settings: json() },
      additionalProperties: false,
    });
    fastify.post(`${PROBE_URL}/profile`, {
      schema: { body: { $ref: `${SHARED_SCHEMA_ID}#` }, response: FOUND_RESPONSE },
      security: PUBLIC,
    }, answerNothing);

    const { components } = await readSpec(fastify);
    const shared = Object.values(components.schemas).find((schema) => schema.title === SHARED_SCHEMA_ID);

    assert.deepEqual(shared.properties.settings, OPEN_OBJECT);
  });

  test('documents the ping route once, without its HEAD twin, and leaves the routes of the UI out', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);
    const { paths } = await readSpec(fastify);
    const ping = paths[PING_URL];

    assert.deepEqual(Object.keys(ping), ['get']);
    assert.deepEqual(pick(ping.get, ['summary', 'tags']), { summary: 'Check that the API answers', tags: ['System'] });
    assert.deepEqual(readData(ping.get.responses['200']), { type: 'object', properties: { isAlive: { type: 'boolean' } } });
    assert.equal(Object.keys(paths).some((path) => path.startsWith(DOCS_PREFIX)), false);
  });

  test('documents the "/" of a plugin without its slash, though both addresses are served, and the "/" of the root as it is', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);

    fastify.register(async (scope) => {
      scope.get('/', { schema: { response: FOUND_RESPONSE }, security: PUBLIC }, answerNothing);
      scope.delete('/', { schema: REMOVE_SCHEMA, security: PUBLIC }, answerNothing);
    }, { prefix: PROBE_URL });
    fastify.get('/', { schema: { response: FOUND_RESPONSE }, security: PUBLIC }, answerNothing);

    const { paths } = await readSpec(fastify);
    const responses = await injectAll(fastify, [PROBE_URL, `${PROBE_URL}/`, '/']);

    assert.deepEqual(Object.keys(paths[PROBE_URL]), ['get', 'delete']);
    assert.equal(Object.hasOwn(paths, `${PROBE_URL}/`), false);
    assert.deepEqual(Object.keys(paths['/']), ['get']);
    assert.deepEqual(responses.map(({ statusCode }) => statusCode), [204, 204, 204]);
  });

  test('documents every other route at the address it answers at: one written with a slash, each of a pair, the "/" of a plugin that is served one way only', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);

    ['/explicit/', '/pair', '/pair/'].forEach((path) => {
      fastify.get(`${PROBE_URL}${path}`, { schema: { summary: path, response: FOUND_RESPONSE }, security: PUBLIC }, answerNothing);
    });
    ['slash', 'no-slash', 'both'].forEach((prefixTrailingSlash) => {
      fastify.register(async (scope) => {
        scope.get('/', { prefixTrailingSlash, schema: { summary: prefixTrailingSlash, response: FOUND_RESPONSE }, security: PUBLIC }, answerNothing);
      }, { prefix: `${PROBE_URL}/${prefixTrailingSlash}` });
    });

    const { paths } = await readSpec(fastify);
    const addresses = ['explicit', 'pair', 'slash', 'no-slash', 'both'].flatMap((name) => [`/${name}`, `/${name}/`]);
    const responses = await injectAll(fastify, addresses.map((address) => `${PROBE_URL}${address}`));

    assert.deepEqual(addresses.filter((address, index) => responses[index].statusCode === 204), [
      '/explicit/',
      '/pair',
      '/pair/',
      '/slash/',
      '/no-slash',
      '/both',
      '/both/',
    ]);
    assert.deepEqual(readSummaries(paths), {
      'get /explicit/': '/explicit/',
      'get /pair': '/pair',
      'get /pair/': '/pair/',
      'get /slash/': 'slash',
      'get /no-slash': 'no-slash',
      'get /both': 'both',
    });
  });

  test('says in one info line at the start whether the docs are served, and under which prefix', async (t) => {
    const devSink = createLogSink();
    const prodSink = createLogSink();

    await Promise.all([
      buildModeApp(t, MODE.DEV, { logger: { level: 'info', stream: devSink.stream } }),
      buildModeApp(t, MODE.PROD, { logger: { level: 'info', stream: prodSink.stream } }),
    ]);

    assert.deepEqual(findLogLines(devSink, SERVED_MESSAGE).map((line) => [line.level, line.docs]), [[LOG_LEVEL.INFO, { prefix: DOCS_PREFIX }]]);
    assert.deepEqual(findLogLines(devSink, OFF_MESSAGE), []);
    assert.deepEqual(findLogLines(prodSink, OFF_MESSAGE).map((line) => line.level), [LOG_LEVEL.INFO]);
    assert.deepEqual(findLogLines(prodSink, SERVED_MESSAGE), []);
  });

  test('moves the UI, its assets and the spec with docsPrefix of the config', async (t) => {
    const sink = createLogSink();
    const fastify = await buildModeApp(t, MODE.DEV, {
      app: { docsPrefix: MOVED_DOCS_PREFIX },
      logger: { level: 'info', stream: sink.stream },
    });
    const initializerUrl = `${MOVED_DOCS_PREFIX}/static/swagger-initializer.js`;
    const [ui, initializer, oldUi, oldSpec] = await injectAll(fastify, [
      MOVED_DOCS_PREFIX,
      initializerUrl,
      DOCS_PREFIX,
      `${DOCS_PREFIX}${SPEC_PATH}`,
    ]);
    const spec = await readSpec(fastify, MOVED_DOCS_PREFIX);

    assert.equal(ui.statusCode, 200);
    assert.equal(ui.headers['content-type'], HTML_CONTENT_TYPE);
    assert.ok(ui.payload.includes(`src="${initializerUrl}"`));
    assert.equal(initializer.statusCode, 200);
    assert.equal(spec.openapi, '3.1.0');
    assert.equal(Object.keys(spec.paths).some((path) => path.startsWith(MOVED_DOCS_PREFIX)), false);
    assert.deepEqual(oldUi.json(), notFoundBody(oldUi, `Route GET ${DOCS_PREFIX} not found`));
    assert.deepEqual(oldSpec.json(), notFoundBody(oldSpec, `Route GET ${DOCS_PREFIX}${SPEC_PATH} not found`));
    assert.deepEqual([oldUi.statusCode, oldSpec.statusCode], [404, 404]);
    assert.deepEqual(findLogLines(sink, SERVED_MESSAGE).map((line) => line.docs), [{ prefix: MOVED_DOCS_PREFIX }]);
  });
});

describe('swagger plugin: security', () => {
  test('documents a guarded route with both ways the token rides in, no scope named, and the 401 of the catalog as createSchema documents it', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);

    useProbeRoutes(fastify);
    fastify.get(`${PROBE_URL}/guarded`, { schema: { response: FOUND_RESPONSE }, security: GUARDED }, answerNothing);

    const { paths } = await readSpec(fastify);
    const guarded = paths[`${PROBE_URL}/guarded`].get;
    const unauthorized = guarded.responses['401'];

    assert.deepEqual(guarded.security, TOKEN_SCHEMES);
    assert.deepEqual(Object.keys(guarded.responses), ['200', '401']);
    assert.equal(unauthorized.description, UNAUTHORIZED_DESCRIPTION);
    assert.deepEqual(omit(readMedia(unauthorized).schema, ['description']), errorEnvelope);
    assert.deepEqual(readMedia(unauthorized).example, { status: 'error', code: 'AUTHENTICATION_ERROR', message: 'Authentication error' });
    assert.deepEqual(unauthorized, paths[PROBE_URL].get.responses['401']);
  });

  test('documents a route with scopes with one requirement per term and per way the token rides in, the scopes named, and 401 and 403 as createSchema documents them', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);

    useProbeRoutes(fastify);
    fastify.post(`${PROBE_URL}/scoped`, { schema: { response: FOUND_RESPONSE }, security: SCOPED }, answerNothing);
    fastify.get(`${PROBE_URL}/scoped`, { schema: { response: FOUND_RESPONSE }, security: { auth: true, scopes: [SCOPE.USERS_READ] } }, answerNothing);

    const { paths } = await readSpec(fastify);
    const { get: one, post: terms } = paths[`${PROBE_URL}/scoped`];
    const forbidden = terms.responses['403'];
    const { responses } = paths[PROBE_URL].get;

    assert.deepEqual(terms.security, [
      { cookieAuth: [SCOPE.GROUPS_READ, SCOPE.USERS_READ] },
      { bearerAuth: [SCOPE.GROUPS_READ, SCOPE.USERS_READ] },
      { cookieAuth: [SCOPE.GROUPS_MANAGE] },
      { bearerAuth: [SCOPE.GROUPS_MANAGE] },
    ]);
    assert.deepEqual(one.security, [{ cookieAuth: [SCOPE.USERS_READ] }, { bearerAuth: [SCOPE.USERS_READ] }]);
    assert.deepEqual([one, terms].map((operation) => Object.keys(operation.responses)), [['200', '401', '403'], ['200', '401', '403']]);
    assert.equal(forbidden.description, FORBIDDEN_DESCRIPTION);
    assert.deepEqual(readMedia(forbidden).example, { status: 'error', code: 'AUTHORIZATION_ERROR', message: 'Authorization error' });
    assert.deepEqual(pick(terms.responses, ['401', '403']), pick(responses, ['401', '403']));
  });

  test('documents the 401 and the 403 it adds as addErrorResponses gives them, under the API and outside it, and as a route that declares them itself', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);
    const refusals = [HTTP_STATUS.UNAUTHORIZED, HTTP_STATUS.FORBIDDEN];
    const expected = documentErrorResponses(refusals);
    const routes = [
      [`${PROBE_URL}/guarded`, { schema: { response: FOUND_RESPONSE }, security: GUARDED }],
      [`${PROBE_URL}/scoped`, { schema: { response: FOUND_RESPONSE }, security: SCOPED }],
      [`${PROBE_URL}/declared`, { schema: { response: addErrorResponses(FOUND_RESPONSE, refusals) }, security: PUBLIC }],
      [`${OUTSIDE_URL}/guarded`, { security: GUARDED }],
      [`${OUTSIDE_URL}/scoped`, { security: { auth: true, scopes: [SCOPE.USERS_READ] } }],
    ];

    routes.forEach(([url, options]) => fastify.get(url, options, answerNothing));

    const { paths } = await readSpec(fastify);
    const [guarded, scoped, declared, outsideGuarded, outsideScoped] = routes.map(([url]) => paths[url].get.responses);

    [guarded, outsideGuarded].forEach((responses) => assert.deepEqual(omit(responses, ['200']), pick(expected, ['401'])));
    [scoped, declared, outsideScoped].forEach((responses) => assert.deepEqual(omit(responses, ['200']), expected));
    assert.deepEqual(scoped, declared);
  });

  test('keeps a 401 and a 403 a guarded route declares as they are, and adds only the refusal it lacks', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);
    const signInFirst = { ...errorEnvelope, description: 'Sign in first' };
    const notYours = { ...errorEnvelope, description: 'Not yours to see' };
    const declared = {
      'own-401': { ...FOUND_RESPONSE, 401: signInFirst },
      'own-403': { ...FOUND_RESPONSE, 403: notYours },
      'own-both': { ...FOUND_RESPONSE, 401: signInFirst, 403: notYours },
    };

    Object.entries(declared).forEach(([name, response]) => {
      fastify.get(`${PROBE_URL}/${name}`, { schema: { response }, security: SCOPED }, answerNothing);
    });
    fastify.get(`${PROBE_URL}/own-401-guarded`, { schema: { response: declared['own-401'] }, security: GUARDED }, answerNothing);

    const { paths } = await readSpec(fastify);
    const documented = ['own-401', 'own-403', 'own-both', 'own-401-guarded'].map((name) => {
      const { responses } = paths[`${PROBE_URL}/${name}`].get;

      return [name, Object.fromEntries(Object.entries(responses).map(([code, { description }]) => [code, description]))];
    });

    assert.deepEqual(documented, [
      ['own-401', { 200: 'Default Response', 401: 'Sign in first', 403: FORBIDDEN_DESCRIPTION }],
      ['own-403', { 200: 'Default Response', 401: UNAUTHORIZED_DESCRIPTION, 403: 'Not yours to see' }],
      ['own-both', { 200: 'Default Response', 401: 'Sign in first', 403: 'Not yours to see' }],
      ['own-401-guarded', { 200: 'Default Response', 401: 'Sign in first' }],
    ]);
  });

  test('documents no security and adds no refusal to a public route and to one without security outside the API', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);

    fastify.get(`${PROBE_URL}/public`, { schema: { response: FOUND_RESPONSE }, security: PUBLIC }, answerNothing);
    fastify.get(`${OUTSIDE_URL}/plain`, { schema: { response: FOUND_RESPONSE } }, answerNothing);
    fastify.get(`${OUTSIDE_URL}/bare`, answerNothing);

    const { paths } = await readSpec(fastify);
    const operations = [`${PROBE_URL}/public`, `${OUTSIDE_URL}/plain`, `${OUTSIDE_URL}/bare`].map((path) => paths[path].get);

    assert.deepEqual(operations.map((operation) => [Object.hasOwn(operation, 'security'), Object.keys(operation.responses)]), operations.map(() => [false, ['200']]));
  });

  test('documents a guarded route outside the API that has no schema or no response schema with its security and its refusals next to its default answer', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);

    fastify.get(`${OUTSIDE_URL}/guarded`, { security: GUARDED }, answerNothing);
    fastify.get(`${OUTSIDE_URL}/scoped`, { security: { auth: true, scopes: [SCOPE.USERS_READ] } }, answerNothing);
    fastify.get(`${OUTSIDE_URL}/search`, { schema: omit(SEARCH_SCHEMA, ['response']), security: GUARDED }, answerNothing);

    const { paths } = await readSpec(fastify);
    const operations = ['guarded', 'scoped', 'search'].map((name) => paths[`${OUTSIDE_URL}/${name}`].get);

    assert.deepEqual(operations.map((operation) => [operation.security, Object.keys(operation.responses)]), [
      [TOKEN_SCHEMES, ['200', '401']],
      [[{ cookieAuth: [SCOPE.USERS_READ] }, { bearerAuth: [SCOPE.USERS_READ] }], ['200', '401', '403']],
      [TOKEN_SCHEMES, ['200', '401']],
    ]);
  });

  test('documents the default answer of a guarded route without a response schema as @fastify/swagger does for any route without one: a description and no content', async (t) => {
    const fastify = await buildModeApp(t, MODE.DEV);

    fastify.get(`${OUTSIDE_URL}/bare`, answerNothing);
    fastify.get(`${OUTSIDE_URL}/guarded`, { security: GUARDED }, answerNothing);
    fastify.get(`${OUTSIDE_URL}/scoped`, { security: { auth: true, scopes: [SCOPE.USERS_READ] } }, answerNothing);
    fastify.get(`${OUTSIDE_URL}/search`, { schema: omit(SEARCH_SCHEMA, ['response']), security: GUARDED }, answerNothing);

    const { paths } = await readSpec(fastify);
    const answers = ['bare', 'guarded', 'scoped', 'search'].map((name) => paths[`${OUTSIDE_URL}/${name}`].get.responses['200']);

    assert.deepEqual(answers, [DEFAULT_ANSWER, DEFAULT_ANSWER, DEFAULT_ANSWER, DEFAULT_ANSWER]);
  });
});
