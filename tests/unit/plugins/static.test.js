import { MODE } from '#config/env.js';
import { createRateLimitConfig } from '#config/rate-limit.js';
import { createUploadConfig } from '#config/upload.js';
import { createRouteHook, RATE_LIMIT_DECORATOR } from '#core/schema/route.js';
import { toStorageKey } from '#core/storage/key.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import useStatic from '#root/src/plugins/190.static.js';
import { errorBody } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { REMOVE_OPTIONS } from '#root/tests/helper/multipart.js';
import { buildDownApp } from '#root/tests/helper/session.js';
import { mapSeries } from '#utils/async.js';
import { convertStringToSeconds } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import { MIME_EXTENSIONS } from '#utils/mime.js';
import { pick } from '#utils/object.js';
import Fastify from 'fastify';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { after, describe, test } from 'node:test';

const directory = await mkdtemp(nodePath.join(tmpdir(), 'nfs-test-static-'));

after(() => rm(directory, REMOVE_OPTIONS));

const UPLOAD_ROOT = nodePath.join(directory, 'upload');
const PUBLIC_ROOT = nodePath.join(directory, 'public');
const STORAGE = Object.freeze({ ...createUploadConfig().storage, root: UPLOAD_ROOT });

const PUBLIC_PATH = '/upload/';
const BARE_PUBLIC_PATH = '/upload';
const OTHER_PUBLIC_PATH = '/media/';
const OTHER_MAX_AGE = '1h';

const FILE_BYTES = Buffer.from('the bytes of a stored file');
const OUTSIDE_FILE = 'outside.txt';

const CACHE_FOR_GOOD = `public, max-age=${convertStringToSeconds(STORAGE.maxAge)}, immutable`;
const WEAK_ETAG_REGEXP = /^W\/"[^"]+"$/;

const FILE_HEADER_NAMES = Object.freeze([
  'content-type',
  'content-length',
  'content-disposition',
  'x-content-type-options',
  'cross-origin-resource-policy',
  'cache-control',
  'x-robots-tag',
  'etag',
  'last-modified',
  'accept-ranges',
]);

// What a browser does with each kind of stored file: an image the app encodes is shown, the rest is saved.
const ANSWERS_BY_EXTENSION = Object.freeze({
  jpg: ['image/jpeg', 'inline'],
  png: ['image/png', 'inline'],
  webp: ['image/webp', 'inline'],
  gif: ['image/gif', 'attachment'],
  pdf: ['application/pdf', 'attachment'],
});

// Names a file on the disk may have that no key has: the case of a UUID and of an extension, no extension, a type the
// app never stores, a dot file.
const FOREIGN_NAMES = Object.freeze([
  `${uuidv7().toUpperCase()}.webp`,
  `${uuidv7()}.WEBP`,
  uuidv7(),
  `${uuidv7()}.exe`,
  `${uuidv7()}.svg`,
  `.${uuidv7()}.webp`,
  '.env',
]);

const SUBFOLDER = 'folder';
const SUBFOLDER_KEY = toStorageKey('webp');

// Paths to a file that is there, out of the root or in a folder of it, in spellings a router decodes into one parameter.
const PATHS = Object.freeze([
  `..%2f${OUTSIDE_FILE}`,
  `%2e%2e%2f${OUTSIDE_FILE}`,
  `..%5c${OUTSIDE_FILE}`,
  `${SUBFOLDER}%2f..%2f..%2f${OUTSIDE_FILE}`,
  `${SUBFOLDER}%2f${SUBFOLDER_KEY}`,
]);

const PING_URL = '/api/v1/system/ping';
const SPEC_URL = '/docs/json';

// A socket of the internet: a request of the own network that names no client is never counted.
const PUBLIC_CLIENT = Object.freeze({ remoteAddress: '8.8.8.8' });
const ONE_REQUEST = Object.freeze({ max: 1, window: '1m' });
const REQUESTS_PAST_LIMIT = 5;

const BROKEN_TOKEN = 'broken.access.token';

const PUBLIC_FILES = Object.freeze({
  'hello.txt': 'hello',
  'nested/page.html': '<p>page</p>',
  'nested/index.html': '<p>index</p>',
  '.env': 'SECRET=1',
  'nested/.secret': 'secret',
});

const SERVED_PUBLIC_FILES = Object.freeze({
  '/hello.txt': PUBLIC_FILES['hello.txt'],
  '/nested/page.html': PUBLIC_FILES['nested/page.html'],
});

const REFUSED_PUBLIC_URLS = Object.freeze(['/.env', '/nested/.secret', '/', '/nested/', '/nested']);

await mkdir(nodePath.join(UPLOAD_ROOT, SUBFOLDER), { recursive: true });
await writeFile(nodePath.join(directory, OUTSIDE_FILE), FILE_BYTES);
await writeFile(nodePath.join(UPLOAD_ROOT, SUBFOLDER, SUBFOLDER_KEY), FILE_BYTES);
await Promise.all(FOREIGN_NAMES.map((name) => writeFile(nodePath.join(UPLOAD_ROOT, name), FILE_BYTES)));
await mkdir(nodePath.join(PUBLIC_ROOT, 'nested'), { recursive: true });
await Promise.all(Object.entries(PUBLIC_FILES).map(([name, text]) => writeFile(nodePath.join(PUBLIC_ROOT, name), text)));

function buildStaticApp(t, {
  env = {}, app = {}, storage = {}, ...sections
} = {}) {
  return buildDownApp(t, {
    ...sections,
    env,
    app: { publicRoot: PUBLIC_ROOT, ...app },
    upload: { storage: { ...STORAGE, ...storage } },
  });
}

async function storeFile(extension) {
  const key = toStorageKey(extension);

  await writeFile(nodePath.join(UPLOAD_ROOT, key), FILE_BYTES);

  return key;
}

function repeat(count, item) {
  return Array.from({ length: count }, () => item);
}

function readStatuses(responses) {
  return responses.map((response) => response.statusCode);
}

function assertNotFound(response, url) {
  assert.equal(response.statusCode, 404, url);
  assert.deepEqual(response.json(), errorBody(response, 'NOT_FOUND_ERROR', 'Not found'), url);
}

async function declareRoutes(t) {
  const config = createTestConfig({ upload: { storage: STORAGE } });
  const fastify = Fastify();
  const routes = [];

  t.after(() => fastify.close());
  fastify.decorate('config', config);
  fastify.decorateRequest(RATE_LIMIT_DECORATOR, null);
  fastify.addHook('onRoute', createRouteHook(config.app));
  fastify.addHook('onRoute', (routeOptions) => {
    routes.push(pick(routeOptions, ['method', 'url', 'security']));
  });
  await fastify.register(useStatic);

  return routes;
}

describe('static plugin: GET /upload/:key', () => {
  test('answers a stored image with its bytes and its type, to show in place and to keep for good: nosniff, cross-origin for a page of another origin, noindex and an ETag', async (t) => {
    const fastify = await buildStaticApp(t);
    const response = await fastify.inject(`${PUBLIC_PATH}${await storeFile('webp')}`);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, FILE_BYTES);
    assert.deepEqual(pick(response.headers, ['content-type', 'content-disposition', 'x-content-type-options', 'cross-origin-resource-policy', 'cache-control', 'x-robots-tag']), {
      'content-type': 'image/webp',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': CACHE_FOR_GOOD,
      'x-robots-tag': 'noindex',
    });
    assert.equal(Number(response.headers[HEADER.CONTENT_LENGTH]), FILE_BYTES.length);
    assert.match(response.headers.etag, WEAK_ETAG_REGEXP);
  });

  test('answers HEAD with the headers of GET and no body', async (t) => {
    const fastify = await buildStaticApp(t);
    const url = `${PUBLIC_PATH}${await storeFile('webp')}`;
    const [get, head] = await Promise.all(['GET', 'HEAD'].map((method) => fastify.inject({ method, url })));

    assert.deepEqual([head.statusCode, head.payload], [200, '']);
    assert.deepEqual(pick(head.headers, FILE_HEADER_NAMES), pick(get.headers, FILE_HEADER_NAMES));
    assert.deepEqual(Object.keys(pick(get.headers, FILE_HEADER_NAMES)), FILE_HEADER_NAMES);
  });

  test('answers 304 without a body to a client that holds the file: If-None-Match with its ETag', async (t) => {
    const fastify = await buildStaticApp(t);
    const url = `${PUBLIC_PATH}${await storeFile('webp')}`;
    const { headers } = await fastify.inject(url);
    const responses = await Promise.all(['GET', 'HEAD'].map((method) => fastify.inject({ method, url, headers: { 'if-none-match': headers.etag } })));

    assert.deepEqual(responses.map((response) => [response.statusCode, response.payload]), [[304, ''], [304, '']]);
    assert.deepEqual(responses.map((response) => response.headers.etag), [headers.etag, headers.etag]);
  });

  test('shows in place only what the app encodes images into: a GIF and a PDF are offered to save, each under its own type', async (t) => {
    const fastify = await buildStaticApp(t);
    const answers = await Promise.all(MIME_EXTENSIONS.map(async (extension) => {
      const response = await fastify.inject(`${PUBLIC_PATH}${await storeFile(extension)}`);

      return [extension, [response.headers[HEADER.CONTENT_TYPE], response.headers[HEADER.CONTENT_DISPOSITION]]];
    }));

    assert.deepEqual(Object.fromEntries(answers), ANSWERS_BY_EXTENSION);
  });

  test('answers a key without a file with the 404 envelope of the app, GET and HEAD', async (t) => {
    const fastify = await buildStaticApp(t);
    const url = `${PUBLIC_PATH}${toStorageKey('webp')}`;
    const [get, head] = await Promise.all(['GET', 'HEAD'].map((method) => fastify.inject({ method, url })));

    assertNotFound(get);
    // inject() keeps the body that Node drops from an answer to HEAD: only the status of that one is read.
    assert.equal(head.statusCode, 404);
    assert.equal(get.headers[HEADER.CONTENT_DISPOSITION], undefined);
  });

  test('answers 404 to every name that is no key, though a file of that name lies in the root, and to every path out of the root or into a folder of it', async (t) => {
    const fastify = await buildStaticApp(t);
    const urls = [...FOREIGN_NAMES.map((name) => encodeURIComponent(name)), ...PATHS].map((name) => `${PUBLIC_PATH}${name}`);
    const responses = await Promise.all(urls.map((url) => fastify.inject(url)));

    responses.forEach((response, index) => assertNotFound(response, urls[index]));
  });

  test('lists nothing: the public path itself is no route, with a slash and without', async (t) => {
    const fastify = await buildStaticApp(t);
    const urls = [PUBLIC_PATH, BARE_PUBLIC_PATH];

    await storeFile('webp');

    const responses = await Promise.all(urls.map((url) => fastify.inject(url)));

    responses.forEach((response, index) => assertNotFound(response, urls[index]));
  });

  test('takes its root, its public path and its maxAge from the storage section', async (t) => {
    const fastify = await buildStaticApp(t, { storage: { publicPath: OTHER_PUBLIC_PATH, maxAge: OTHER_MAX_AGE } });
    const key = await storeFile('png');
    const [served, unserved] = await Promise.all([OTHER_PUBLIC_PATH, PUBLIC_PATH].map((path) => fastify.inject(`${path}${key}`)));

    assert.equal(served.statusCode, 200);
    assert.deepEqual(served.rawPayload, FILE_BYTES);
    assert.equal(served.headers[HEADER.CACHE_CONTROL], `public, max-age=${convertStringToSeconds(OTHER_MAX_AGE)}, immutable`);
    assertNotFound(unserved);
  });

  test('is outside the limiter: a guest past the guest tier still gets every file and every 404', async (t) => {
    const fastify = await buildStaticApp(t, { rateLimit: { tiers: { ...createRateLimitConfig().tiers, guest: ONE_REQUEST } } });
    const url = `${PUBLIC_PATH}${await storeFile('webp')}`;
    const limited = await mapSeries([PING_URL, PING_URL], (pingUrl) => fastify.inject({ url: pingUrl, ...PUBLIC_CLIENT }));
    const urls = [...repeat(REQUESTS_PAST_LIMIT, url), `${PUBLIC_PATH}${toStorageKey('webp')}`, `${PUBLIC_PATH}${PATHS[0]}`];
    const answers = await mapSeries(urls, (fileUrl) => fastify.inject({ url: fileUrl, ...PUBLIC_CLIENT }));

    assert.deepEqual(readStatuses(limited), [200, 429]);
    assert.deepEqual(readStatuses(answers), [...repeat(REQUESTS_PAST_LIMIT, 200), 404, 404]);
  });

  test('reads no token: a broken one, in the header or in the cookie, gets the file as a guest does', async (t) => {
    const fastify = await buildStaticApp(t);
    const url = `${PUBLIC_PATH}${await storeFile('webp')}`;
    const responses = await Promise.all([
      { url },
      { url, headers: { [HEADER.AUTHORIZATION]: `Bearer ${BROKEN_TOKEN}` } },
      { url, cookies: { [COOKIE.ACCESS_TOKEN]: BROKEN_TOKEN } },
    ].map((request) => fastify.inject(request)));

    assert.deepEqual(readStatuses(responses), [200, 200, 200]);
  });

  test('declares its route with security, as every route has, which the route hook takes: no auth and no limiter', async (t) => {
    const routes = await declareRoutes(t);

    assert.deepEqual(routes, [{ method: ['GET', 'HEAD'], url: '/upload/:key', security: { auth: false, rateLimit: false } }]);
  });

  test('is left out of the API docs of dev mode', async (t) => {
    const fastify = await buildStaticApp(t, { env: { APP_MODE: MODE.DEV } });
    const spec = await fastify.inject(SPEC_URL);

    assert.equal(spec.statusCode, 200);
    assert.deepEqual(Object.keys(spec.json().paths).filter((path) => path.startsWith(BARE_PUBLIC_PATH)), []);
  });
});

describe('static plugin: public/', () => {
  test('serves nothing of it in prod mode', async (t) => {
    const fastify = await buildStaticApp(t, { env: { APP_MODE: MODE.PROD } });
    const urls = Object.keys(SERVED_PUBLIC_FILES);
    const responses = await Promise.all(urls.map((url) => fastify.inject(url)));

    responses.forEach((response, index) => assertNotFound(response, urls[index]));
  });

  test('serves its files at "/" in dev mode, but no dot file, no index and no listing', async (t) => {
    const fastify = await buildStaticApp(t, { env: { APP_MODE: MODE.DEV } });
    const served = await Promise.all(Object.keys(SERVED_PUBLIC_FILES).map(async (url) => [url, (await fastify.inject(url)).payload]));
    const refused = await Promise.all(REFUSED_PUBLIC_URLS.map((url) => fastify.inject(url)));

    assert.deepEqual(Object.fromEntries(served), SERVED_PUBLIC_FILES);
    assert.deepEqual(readStatuses(refused), REFUSED_PUBLIC_URLS.map(() => 404));
  });
});
