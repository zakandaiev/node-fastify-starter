import { createUploadConfig } from '#config/upload.js';
import { toDbError } from '#core/db/error.js';
import { IMAGE_INPUT_TYPES } from '#core/image/profile.js';
import { isStorageKey } from '#core/storage/key.js';
import { commitUploadedFiles, keepUploadedFiles } from '#core/upload/index.js';
import { FILE_CHECK } from '#enums/file-check.js';
import { HEADER } from '#enums/header.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { buildTestApp, errorBody, successBody } from '#root/tests/helper/app.js';
import { timeIt, waitFor } from '#root/tests/helper/async.js';
import {
  assertRefused, buildOpenApp, issueFor, UNAUTHENTICATED,
} from '#root/tests/helper/guard.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import {
  BOUNDARY,
  CLOSING,
  createForm,
  createImage,
  createPdf,
  CRLF,
  fileHeader,
  filePart,
  FORM_TYPE,
  listStored,
  REMOVE_OPTIONS,
  textPart,
  withForm,
} from '#root/tests/helper/multipart.js';
import { buildDownApp } from '#root/tests/helper/session.js';
import { openRawConnection, sendRawRequest } from '#root/tests/helper/socket.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import { freezeDeep } from '#utils/object.js';
import { convertStringToBytes } from '#utils/string.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';

const directory = await mkdtemp(nodePath.join(tmpdir(), 'nfs-test-multipart-'));

after(() => rm(directory, REMOVE_OPTIONS));

const STORAGE = Object.freeze({ ...createUploadConfig().storage });
const BASE_URL = 'https://app.test';

const PDF = 'application/pdf';
const WEBP = 'image/webp';

const ITEMS_URL = '/items';
const MAX_FILES_URL = '/items/max-files';
const TOTAL_URL = '/items/total';
const PLAIN_URL = '/plain';
const LOST_URL = '/items/lost';
const FAILED_URL = '/items/failed';
const UNKNOWN_URL = '/nowhere';

const PUBLIC = Object.freeze({ auth: false });
const GUARDED = Object.freeze({ auth: true });

const KB = 1024;
const AVATAR_MAX_SIZE = 64 * KB;
const SCAN_MAX_SIZE = KB;
const TOTAL_MAX_SIZE = 1.5 * KB;
const SCAN_OVER_HALF = 900;
const ROUTE_BODY_LIMIT = 64;

const PHOTO_WIDTH = 1024;
const PHOTO_HEIGHT = 768;
const AVATAR_SIDE = createUploadConfig().image.profiles[IMAGE_PROFILE.AVATAR].maxSize;
const PNG_WIDTH = 64;
const PNG_HEIGHT = 48;
const EXIF = Object.freeze({
  IFD0: { Copyright: 'Somebody', ImageDescription: 'A street at night' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '50/1 27/1 1/1',
    GPSLongitudeRef: 'E',
    GPSLongitude: '30/1 31/1 2/1',
  },
});

const RETRY_AFTER = '60';
const ANSWER_DEADLINE_MS = 1000;
const HELD_MS = 100;
const HANG_TIMEOUT_MS = 5000;

// Past the buffers of the sockets on both ends, written in the slices a proxy forwards a body it is still receiving in.
const LARGE_FORM_BYTES = 4 * 1024 * KB;
const SLICE_BYTES = 256 * KB;
const SLICE_PAUSE_MS = 5;
const SLOW_DEADLINE_MS = 10000;

// Small enough for a test to send a body past maxBodySize: the other limits go down with it, as the config requires.
const SMALL_BODY = freezeDeep({
  maxFileSize: '64KB',
  maxTotalSize: '128KB',
  maxBodySize: '256KB',
  avatarMaxSize: '64KB',
});
const SMALL_BODY_BYTES = convertStringToBytes(SMALL_BODY.maxBodySize);

const PART_HEADER_BYTES = convertStringToBytes(createUploadConfig().maxPartHeaderSize);
const LONG_NAME_BYTES = 8 * KB;
const NO_BREAK_SPACE = String.fromCodePoint(0xA0);

const ITEM_BODY = freezeDeep({
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 20 },
    label: { type: ['string', 'null'], maxLength: 20 },
    count: { type: 'integer' },
    isPublic: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string', maxLength: 10 }, maxItems: 5 },
  },
  additionalProperties: false,
});

const FILES = freezeDeep({
  fields: {
    avatar: { maxSize: '64KB', mime: IMAGE_INPUT_TYPES, image: IMAGE_PROFILE.AVATAR },
    scans: { max: 2, maxSize: '1KB', mime: [PDF] },
  },
});

const PDF_BYTES = Buffer.from('%PDF-1.7\nthe bytes of a scan\n');
const EXE_BYTES = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(KB)]);
const PNG_SIGNATURE_BYTES = 8;
const PDF_HEAD_BYTES = 9;

const PHOTO = await createImage(PHOTO_WIDTH, PHOTO_HEIGHT).jpeg().withExif(EXIF).toBuffer();
const PNG = await createImage(PNG_WIDTH, PNG_HEIGHT).png().toBuffer();
const BROKEN_PNG = Buffer.concat([PNG.subarray(0, PNG_SIGNATURE_BYTES), Buffer.from('no image after the signature')]);

const STORAGE_MESSAGE = 'Uploaded files are stored';

function pdfPart(bytes = PDF_BYTES) {
  return filePart('scans', bytes, { filename: 'scan.pdf', type: PDF });
}

function pngPart() {
  return filePart('avatar', PNG, { filename: 'me.png', type: 'image/png' });
}

function sendForm(fastify, parts, { method = 'PATCH', url = ITEMS_URL, headers = {} } = {}) {
  return fastify.inject(withForm({ method, url, headers }, parts));
}

function toRawHead({
  method = 'PATCH',
  url = ITEMS_URL,
  contentLength,
  headers = [],
}) {
  return Buffer.from([
    `${method} ${url} HTTP/1.1`,
    'Host: localhost',
    `Content-Type: ${FORM_TYPE}`,
    `Content-Length: ${contentLength}`,
    'Connection: close',
    ...headers,
    '',
    '',
  ].join(CRLF));
}

function toRawRequest(body) {
  return Buffer.concat([toRawHead({ contentLength: Buffer.byteLength(body) }), Buffer.from(body)]);
}

function readRawAnswer(text) {
  const [statusLine] = text.split(CRLF);

  return { status: Number(statusLine.split(' ')[1]), body: JSON.parse(text.slice(text.indexOf('{'))) };
}

function echo(request, reply) {
  return reply.ok({ body: request.body, files: request.uploadedFiles });
}

function keepAndEcho(request, reply) {
  keepUploadedFiles(request);

  return echo(request, reply);
}

function countCall(calls) {
  return function handler() {
    calls.push(true);

    return { isDone: true };
  };
}

function declareItems(fastify, {
  url = ITEMS_URL,
  files = FILES,
  security = PUBLIC,
  handler = echo,
  ...options
} = {}) {
  fastify.patch(url, {
    ...options,
    schema: { body: ITEM_BODY },
    security,
    files,
  }, handler);
}

async function buildUploadApp(t, { upload = {}, ...sections } = {}) {
  const root = nodePath.join(directory, uuidv7());
  const fastify = await buildDownApp(t, { ...sections, upload: { ...upload, storage: { ...STORAGE, root } } });

  return { fastify, root };
}

async function openItems(t, options) {
  const opened = await buildUploadApp(t);

  declareItems(opened.fastify, options);

  return opened;
}

function toEntry(column, operator, operatorValue) {
  return {
    column,
    columnValue: null,
    operator,
    operatorValue,
  };
}

function assertFileRefused(response, validation) {
  assert.equal(response.statusCode, 422, response.body);
  assert.deepEqual(response.json(), { ...errorBody(response, 'VALIDATION_ERROR', 'Validation error'), validation });
}

function assertFailed(response, statusCode, code, message) {
  assert.equal(response.statusCode, statusCode, response.body);
  assert.deepEqual(response.json(), errorBody(response, code, message));
}

describe('multipart plugin', () => {
  test('is registered under the name "multipart", gives the app and the context the storage of config.upload, and says at the start where it stores', async (t) => {
    const sink = createLogSink();
    const { fastify } = await buildUploadApp(t, { logger: { level: 'info', stream: sink.stream } });
    const key = `${uuidv7()}.webp`;

    assert.equal(fastify.hasPlugin('multipart'), true);
    assert.equal(fastify.context.storage, fastify.storage);
    assert.equal(fastify.storage.url(key), `${BASE_URL}/upload/${key}`);
    assert.deepEqual(findLogLines(sink, STORAGE_MESSAGE).map((line) => [line.level, line.storage]), [[LOG_LEVEL.INFO, { driver: 'local', publicPath: '/upload/' }]]);
  });

  test('does not start with an upload section it cannot work with', async () => {
    await assert.rejects(buildTestApp({ upload: { maxParts: 0 } }), /^TypeError: config\.upload requires maxParts and maxActiveFiles to be positive integers$/);
    await assert.rejects(buildTestApp({ upload: { storage: { ...STORAGE, maxAge: '0s' } } }), /config\.upload\.storage requires maxAge to be above zero/);
    await assert.rejects(buildTestApp({ upload: { storage: { ...STORAGE, publicPath: 'upload' } } }), /requires publicPath/);
  });

  test('answers 415 to a multipart body on a route without files, before its handler', async (t) => {
    const { fastify } = await buildUploadApp(t);
    const calls = [];

    fastify.post(PLAIN_URL, { security: PUBLIC }, countCall(calls));

    const response = await sendForm(fastify, [textPart('name', 'Anna')], { method: 'POST', url: PLAIN_URL });

    assertFailed(response, 415, 'UNSUPPORTED_MEDIA_TYPE_ERROR', 'Unsupported media type');
    assert.deepEqual(calls, []);
  });

  test('answers 404 to a form sent to a path no route has and to a method its path does not take, as it does to JSON', async (t) => {
    const { fastify, root } = await openItems(t);
    const targets = [['POST', UNKNOWN_URL], ['POST', ITEMS_URL]];
    const [forms, json] = await Promise.all([
      mapSeries(targets, ([method, url]) => sendForm(fastify, [textPart('name', 'Anna'), pngPart()], { method, url })),
      mapSeries(targets, ([method, url]) => fastify.inject({ method, url, payload: { name: 'Anna' } })),
    ]);

    [...forms, ...json].forEach((response) => assertFailed(response, 404, 'NOT_FOUND_ERROR', 'Not found'));
    assert.equal(existsSync(root), false);
  });
});

describe('multipart plugin: the body of a route with files', () => {
  test('takes JSON with null in place of a file and no files at all, refuses a string there, and any media type but JSON and a form', async (t) => {
    const { fastify } = await openItems(t);
    const [removed, named, text] = await Promise.all([
      fastify.inject({ method: 'PATCH', url: ITEMS_URL, payload: { name: 'Anna', avatar: null } }),
      fastify.inject({ method: 'PATCH', url: ITEMS_URL, payload: { avatar: 'somebody-else.webp' } }),
      fastify.inject({
        method: 'PATCH', url: ITEMS_URL, payload: 'name', headers: { [HEADER.CONTENT_TYPE]: 'text/plain' },
      }),
    ]);

    assert.deepEqual(removed.json(), successBody(removed, { body: { name: 'Anna', avatar: null }, files: null }));
    assertFileRefused(named, [{
      column: 'avatar',
      columnValue: 'somebody-else.webp',
      operator: 'type',
      operatorValue: 'null',
    }]);
    assertFailed(text, 415, 'UNSUPPORTED_MEDIA_TYPE_ERROR', 'Unsupported media type');
  });

  test('takes a form of text fields, coerced as a query is, a repeated one as a list, and a photo encoded by its profile, smaller and without its EXIF', async (t) => {
    const { fastify, root } = await openItems(t, { handler: keepAndEcho });
    const response = await sendForm(fastify, [
      textPart('name', 'Anna'),
      textPart('count', '5'),
      textPart('tags', 'a'),
      textPart('tags', 'b'),
      filePart('avatar', PHOTO, { filename: 'photo.jpg', type: 'image/jpeg' }),
    ]);
    const { avatar } = response.json().data.files;
    const stored = await fastify.storage.get(avatar.key);
    const [photo, encoded] = await Promise.all([sharp(PHOTO).metadata(), sharp(stored).metadata()]);

    assert.deepEqual(response.json(), successBody(response, {
      body: { name: 'Anna', count: 5, tags: ['a', 'b'] },
      files: {
        avatar: {
          key: avatar.key,
          url: `${BASE_URL}/upload/${avatar.key}`,
          mime: WEBP,
          size: stored.length,
          width: AVATAR_SIDE,
          height: AVATAR_SIDE * (PHOTO_HEIGHT / PHOTO_WIDTH),
        },
      },
    }));
    assert.ok(isStorageKey(avatar.key));
    assert.deepEqual(await listStored(root), [avatar.key]);
    assert.notEqual(photo.exif, undefined);
    assert.deepEqual([encoded.format, encoded.width, encoded.exif], ['webp', AVATAR_SIDE, undefined]);
  });

  test('reads the text "null" as null, which removes a file, and refuses any other text in place of a file', async (t) => {
    const { fastify } = await openItems(t);
    const [removed, empty, named] = await Promise.all(['null', '', 'other.webp'].map((value) => sendForm(fastify, [textPart('avatar', value)])));

    assert.deepEqual(removed.json(), successBody(removed, { body: { avatar: null }, files: {} }));
    [[empty, ''], [named, 'other.webp']].forEach(([response, columnValue]) => {
      assertFileRefused(response, [{
        column: 'avatar',
        columnValue,
        operator: 'const',
        operatorValue: null,
      }]);
    });
  });

  test('reads the text "null" as null only in a field that takes null: a number and a flag refuse it as they refuse null of JSON, and a text field keeps it as text', async (t) => {
    const { fastify } = await openItems(t);
    const [taken, refused, json] = await Promise.all([
      sendForm(fastify, [textPart('label', 'null'), textPart('avatar', 'null'), textPart('name', 'null'), textPart('tags', 'a'), textPart('tags', 'null')]),
      sendForm(fastify, [textPart('count', 'null'), textPart('isPublic', 'null')]),
      fastify.inject({ method: 'PATCH', url: ITEMS_URL, payload: { count: null, isPublic: null } }),
    ]);

    assert.deepEqual(taken.json(), successBody(taken, {
      body: {
        label: null,
        avatar: null,
        name: 'null',
        tags: ['a', 'null'],
      },
      files: {},
    }));
    [refused, json].forEach((response) => {
      assert.equal(response.statusCode, 422, response.body);
      assert.deepEqual(response.json().validation.map((entry) => [entry.column, entry.operator]), [['count', 'type'], ['isPublic', 'type']]);
    });
  });

  test('drops blank text of a number as a query does: empty or white space, it is no value, never 0', async (t) => {
    const { fastify } = await openItems(t);
    const responses = await Promise.all(['', '  ', NO_BREAK_SPACE].map((value) => sendForm(fastify, [textPart('count', value), textPart('name', 'Anna')])));

    responses.forEach((response) => {
      assert.deepEqual(response.json(), successBody(response, { body: { name: 'Anna' }, files: {} }));
    });
  });

  test('stores a document as it came and gives a field of several files a list of them', async (t) => {
    const { fastify, root } = await openItems(t);
    const response = await sendForm(fastify, [pdfPart(), pdfPart()]);
    const { scans } = response.json().data.files;

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(scans.map((scan) => [scan.mime, scan.size]), [[PDF, PDF_BYTES.length], [PDF, PDF_BYTES.length]]);
    assert.deepEqual(await fastify.storage.get(scans[0].key), PDF_BYTES);
    assert.deepEqual((await listStored(root)).toSorted(), scans.map((scan) => scan.key).toSorted());
  });

  test('ignores a file of a field the route does not name and an empty file input: neither is stored or in the body', async (t) => {
    const { fastify, root } = await openItems(t);
    const response = await sendForm(fastify, [
      filePart('other', PDF_BYTES, { filename: 'other.pdf', type: PDF }),
      filePart('avatar', Buffer.alloc(0), { filename: '' }),
      textPart('name', 'Anna'),
    ]);

    assert.deepEqual(response.json(), successBody(response, { body: { name: 'Anna' }, files: {} }));
    assert.deepEqual(await listStored(root), []);
  });

  test('refuses a file over maxSize of its field, read past it or cut by the parser at the largest of the route, with no file left', async (t) => {
    const { fastify, root } = await openItems(t);
    const [scan, avatar] = await mapSeries([
      [pdfPart(), pdfPart(createPdf(SCAN_MAX_SIZE + 1))],
      [pdfPart(), filePart('avatar', Buffer.alloc(AVATAR_MAX_SIZE + KB, 1), { filename: 'big.png', type: 'image/png' })],
    ], (parts) => sendForm(fastify, parts));

    assertFileRefused(scan, [toEntry('scans', FILE_CHECK.MAX_SIZE, SCAN_MAX_SIZE)]);
    assertFileRefused(avatar, [toEntry('avatar', FILE_CHECK.MAX_SIZE, AVATAR_MAX_SIZE)]);
    assert.deepEqual(await listStored(root), []);
  });

  test('refuses a field past its max, a text value of it counted as one of its files, with no file left', async (t) => {
    const { fastify, root } = await openItems(t);
    const [scans, avatar] = await mapSeries([
      [pdfPart(), pdfPart(), pdfPart()],
      [pngPart(), textPart('avatar', 'null')],
    ], (parts) => sendForm(fastify, parts));

    assertFileRefused(scans, [toEntry('scans', FILE_CHECK.MAX_FILES, 2)]);
    assertFileRefused(avatar, [toEntry('avatar', FILE_CHECK.MAX_FILES, 1)]);
    assert.deepEqual(await listStored(root), []);
  });

  test('refuses a body past maxFiles and past totalMaxSize of the route, at the field of the file that crossed it, with no file left', async (t) => {
    const { fastify, root } = await buildUploadApp(t);

    declareItems(fastify, { url: MAX_FILES_URL, files: { ...FILES, maxFiles: 2 } });
    declareItems(fastify, { url: TOTAL_URL, files: { ...FILES, totalMaxSize: '1.5KB' } });

    const [files, total] = await mapSeries([
      [MAX_FILES_URL, [pngPart(), pdfPart(), pdfPart()]],
      [TOTAL_URL, [pdfPart(createPdf(SCAN_OVER_HALF)), pdfPart(createPdf(SCAN_OVER_HALF))]],
    ], ([url, parts]) => sendForm(fastify, parts, { url }));

    assertFileRefused(files, [toEntry('scans', FILE_CHECK.MAX_FILES, 2)]);
    assertFileRefused(total, [toEntry('scans', FILE_CHECK.TOTAL_MAX_SIZE, TOTAL_MAX_SIZE)]);
    assert.deepEqual(await listStored(root), []);
  });

  test('tells the type by the bytes: a program renamed a.png and sent as image/png is refused, and so is a PNG the decoder cannot read', async (t) => {
    const { fastify, root } = await openItems(t);
    const [program, broken] = await mapSeries([EXE_BYTES, BROKEN_PNG], (bytes) => sendForm(fastify, [filePart('avatar', bytes, { filename: 'a.png', type: 'image/png' })]));

    assertFileRefused(program, [toEntry('avatar', FILE_CHECK.MIME, IMAGE_INPUT_TYPES)]);
    assertFileRefused(broken, [toEntry('avatar', FILE_CHECK.IMAGE, null)]);
    assert.deepEqual(await listStored(root), []);
  });

  test('answers 413 to text over the bodyLimit of the route, one field or several together, with no file left', async (t) => {
    const { fastify, root } = await openItems(t, { bodyLimit: ROUTE_BODY_LIMIT });
    const responses = await mapSeries([
      [textPart('name', 'x'.repeat(ROUTE_BODY_LIMIT + 1))],
      [pdfPart(), textPart('name', 'x'.repeat(ROUTE_BODY_LIMIT / 2)), textPart('tags', 'x'.repeat(ROUTE_BODY_LIMIT / 2 + 1))],
    ], (parts) => sendForm(fastify, parts));

    responses.forEach((response) => assertFailed(response, 413, 'PAYLOAD_TOO_LARGE_ERROR', 'Payload too large'));
    assert.deepEqual(await listStored(root), []);
  });

  test('counts the names into the text of the form: names over the bodyLimit of the route are 413 though every value is empty, as the same keys in JSON are, and so is the name of a file part', async (t) => {
    const { fastify, root } = await openItems(t, { bodyLimit: ROUTE_BODY_LIMIT });
    const name = 'x'.repeat(ROUTE_BODY_LIMIT + 1);
    const responses = await mapSeries([
      () => sendForm(fastify, [textPart(name, '')]),
      () => sendForm(fastify, [pdfPart(), filePart(name, PDF_BYTES, { filename: 'other.pdf', type: PDF })]),
      () => fastify.inject({ method: 'PATCH', url: ITEMS_URL, payload: { [name]: '' } }),
    ], (send) => send());

    responses.forEach((response) => assertFailed(response, 413, 'PAYLOAD_TOO_LARGE_ERROR', 'Payload too large'));
    assert.deepEqual(await listStored(root), []);
  });

  // A field is given once the boundary after it comes: the first write ends with the line of that boundary.
  test('stops the parse once the text is over its limit: the rest of the body is read and never parsed, a field the parser would refuse included, and the answer is 413', async (t) => {
    const { fastify, root } = await openItems(t, { bodyLimit: ROUTE_BODY_LIMIT });
    const payload = new PassThrough();
    const answering = fastify.inject({
      method: 'PATCH',
      url: ITEMS_URL,
      headers: { [HEADER.CONTENT_TYPE]: FORM_TYPE },
      payload,
    });

    payload.write(Buffer.concat([pdfPart(), textPart('name', 'x'.repeat(ROUTE_BODY_LIMIT + 1)), Buffer.from(`--${BOUNDARY}`)]));
    await sleep(HELD_MS);
    payload.end(`${CRLF}Content-Disposition: form-data; name="constructor"${CRLF}${CRLF}x${CRLF}${CLOSING}`);

    assertFailed(await answering, 413, 'PAYLOAD_TOO_LARGE_ERROR', 'Payload too large');
    assert.deepEqual(await listStored(root), []);
  });

  test('reads the header of a part up to maxPartHeaderSize of the config: a longer name is cut there', async (t) => {
    const names = [];
    const { fastify } = await openItems(t, {
      preValidation: async (request) => {
        names.push(...Object.keys(request.body));
      },
    });
    const response = await sendForm(fastify, [textPart('y'.repeat(LONG_NAME_BYTES), ''), textPart('name', 'Anna')]);

    assert.deepEqual(response.json(), successBody(response, { body: { name: 'Anna' }, files: {} }));
    assert.equal(names.length, 2);
    assert.ok(names.every((key) => Buffer.byteLength(key) < PART_HEADER_BYTES), String(names.map((key) => key.length)));
  });

  test('reads four pairs of the header of a part, no more: a Content-Disposition after four others names no field', async (t) => {
    const { fastify } = await openItems(t);
    const padded = Buffer.from([`--${BOUNDARY}`, 'X-A: 1', 'X-B: 2', 'X-C: 3', 'X-D: 4', 'Content-Disposition: form-data; name="label"', '', 'Late', ''].join(CRLF));
    const response = await sendForm(fastify, [padded, textPart('name', 'Anna')]);

    assert.deepEqual(response.json(), successBody(response, { body: { name: 'Anna' }, files: {} }));
  });

  test('answers 400 to a field named as a key of Object.prototype, with no file left', async (t) => {
    const { fastify, root } = await openItems(t);
    const response = await sendForm(fastify, [pdfPart(), textPart('constructor', 'x')]);

    assertFailed(response, 400, 'BAD_REQUEST_ERROR', 'Bad request');
    assert.deepEqual(await listStored(root), []);
  });
});

describe('multipart plugin: the files of a failed request', () => {
  test('removes the file of a form whose text the body schema refuses', async (t) => {
    const { fastify, root } = await openItems(t);
    const response = await sendForm(fastify, [pngPart(), textPart('name', 'x'.repeat(ROUTE_BODY_LIMIT))]);

    assert.equal(response.statusCode, 422, response.body);
    assert.deepEqual(response.json().validation.map((entry) => [entry.column, entry.operator]), [['name', 'maxLength']]);
    assert.deepEqual(await listStored(root), []);
  });

  test('removes the files of a request whose handler throws', async (t) => {
    const { fastify, root } = await openItems(t, {
      handler: async () => {
        throw new Error('The service failed');
      },
    });
    const response = await sendForm(fastify, [pngPart(), pdfPart()]);

    assertFailed(response, 500, 'SERVER_ERROR', 'Server error');
    assert.deepEqual(await listStored(root), []);
  });

  test('keeps the files a handler has kept, though it fails after: they belong to the committed rows', async (t) => {
    const { fastify, root } = await openItems(t, {
      handler: async (request) => {
        keepUploadedFiles(request);

        throw new Error('The answer failed after the commit');
      },
    });
    const response = await sendForm(fastify, [pngPart()]);

    assertFailed(response, 500, 'SERVER_ERROR', 'Server error');
    assert.equal((await listStored(root)).length, 1);
  });

  test('keeps the files of a service whose connection was lost on the way, which may have carried the COMMIT, and removes those of one that failed otherwise', async (t) => {
    const lost = toDbError(Object.assign(new Error('Connection lost: The server closed the connection.'), { fatal: true, code: 'PROTOCOL_CONNECTION_LOST' }));
    const { fastify, root } = await buildUploadApp(t);

    declareItems(fastify, {
      url: LOST_URL,
      handler: (request) => commitUploadedFiles(request, async () => {
        throw lost;
      }),
    });
    declareItems(fastify, {
      url: FAILED_URL,
      handler: (request) => commitUploadedFiles(request, async () => {
        throw new Error('The service failed');
      }),
    });

    const [kept, removed] = await mapSeries([LOST_URL, FAILED_URL], (url) => sendForm(fastify, [pngPart()], { url }));

    [kept, removed].forEach((response) => assertFailed(response, 500, 'SERVER_ERROR', 'Server error'));
    assert.equal((await listStored(root)).length, 1);
  });

  test('answers 500 to a store that fails, removes what it stored before, and never reaches the handler', async (t) => {
    const blocked = nodePath.join(directory, uuidv7());
    const calls = [];
    const fastify = await buildDownApp(t, { upload: { storage: { ...STORAGE, root: nodePath.join(blocked, 'upload') } } });

    await writeFile(blocked, 'a file where the folder of the root would be');
    declareItems(fastify, { handler: countCall(calls) });

    const response = await sendForm(fastify, [pdfPart(), textPart('name', 'Anna')]);

    assertFailed(response, 500, 'SERVER_ERROR', 'Server error');
    assert.deepEqual(calls, []);
  });

  test('stores nothing for a guest on a guarded route: the guard answers 401 before the body is parsed, and the storage root is never even made', async (t) => {
    const root = nodePath.join(directory, uuidv7());
    const fastify = await buildOpenApp(t, { upload: { storage: { ...STORAGE, root } } });

    declareItems(fastify, { security: GUARDED });

    const guest = await sendForm(fastify, [pngPart()]);

    assertRefused([guest], UNAUTHENTICATED);
    assert.equal(existsSync(root), false);

    const user = await sendForm(fastify, [pngPart()], { headers: issueFor(fastify).headers });

    assert.equal(user.statusCode, 200, user.body);
    assert.deepEqual(await listStored(root), [user.json().data.files.avatar.key]);
  });
});

describe('multipart plugin: the files at work in the process', () => {
  test('answers 503 with Retry-After to a file while maxActiveFiles are taken, only once its body has ended, and serves the ones at work', async (t) => {
    const { fastify, root } = await buildUploadApp(t, { upload: { maxActiveFiles: 2 } });
    const head = Buffer.concat([textPart('name', 'Anna'), fileHeader('scans', { filename: 'scan.pdf', type: PDF }), PDF_BYTES.subarray(0, PDF_HEAD_BYTES)]);
    const rest = Buffer.concat([PDF_BYTES.subarray(PDF_HEAD_BYTES), Buffer.from(`${CRLF}${CLOSING}`)]);
    const streams = [new PassThrough(), new PassThrough(), new PassThrough()];
    const isAnswered = [false, false, false];

    async function sendHeld(stream, index) {
      const response = await fastify.inject({
        method: 'PATCH',
        url: ITEMS_URL,
        headers: { [HEADER.CONTENT_TYPE]: FORM_TYPE },
        payload: stream,
      });

      isAnswered[index] = true;

      return response;
    }

    declareItems(fastify);
    await fastify.ready();

    const answers = streams.map((stream, index) => sendHeld(stream, index));

    streams.slice(0, 2).forEach((stream) => stream.write(head));
    await sleep(HELD_MS);
    streams[2].write(head);
    await sleep(HELD_MS);

    assert.deepEqual(isAnswered, [false, false, false]);

    streams[2].end(rest);

    const busy = await answers[2];

    assertFailed(busy, 503, 'SERVICE_UNAVAILABLE_ERROR', 'Service unavailable');
    assert.equal(busy.headers[HEADER.RETRY_AFTER], RETRY_AFTER);
    assert.deepEqual(isAnswered.slice(0, 2), [false, false]);

    streams.slice(0, 2).forEach((stream) => stream.end(rest));

    const served = await Promise.all(answers.slice(0, 2));

    assert.deepEqual(served.map((response) => response.statusCode), [200, 200]);
    assert.equal((await listStored(root)).length, 2);
  });
});

describe('multipart plugin: a broken body over a socket', () => {
  async function listen(t) {
    const opened = await openItems(t);

    await opened.fastify.listen({ host: '127.0.0.1', port: 0 });

    return { ...opened, port: opened.fastify.server.address().port };
  }

  async function sendRaw(port, body) {
    const { result, durationMs } = await timeIt(() => sendRawRequest(port, toRawRequest(body), { timeoutMs: ANSWER_DEADLINE_MS }));

    return { ...readRawAnswer(result), durationMs };
  }

  test('answers 400 within a second to a body without its closing boundary and to a part whose header never ends, with no file left', async (t) => {
    const { port, root } = await listen(t);
    const answers = await mapSeries([
      Buffer.concat([textPart('name', 'Anna'), pdfPart()]),
      Buffer.concat([textPart('name', 'Anna'), Buffer.from(`--${BOUNDARY}${CRLF}Content-Disposition: form-data; name="scans"; filename="scan.pdf"`)]),
    ], (body) => sendRaw(port, body));

    answers.forEach(({ status, body, durationMs }) => {
      assert.deepEqual([status, body.code], [400, 'BAD_REQUEST_ERROR']);
      assert.ok(durationMs < ANSWER_DEADLINE_MS, String(durationMs));
    });
    assert.deepEqual(await listStored(root), []);
  });

  test('gives the answer of the route to a body with a tail after its closing boundary', async (t) => {
    const { port } = await listen(t);
    const { status, body } = await sendRaw(port, Buffer.concat([createForm([textPart('name', 'Anna')]), Buffer.from('a tail no part belongs to')]));

    assert.deepEqual([status, body.data], [200, { body: { name: 'Anna' }, files: {} }]);
  });

  test('answers 413 to a body of more parts than maxParts of the config, with no file left', async (t) => {
    const { port, root, fastify } = await listen(t);
    const parts = Array.from({ length: fastify.config.upload.maxParts }, (unused, index) => textPart(`field${index}`, 'x'));
    const { status, body } = await sendRaw(port, createForm([pdfPart(), ...parts]));

    assert.deepEqual([status, body.code], [413, 'PAYLOAD_TOO_LARGE_ERROR']);
    assert.deepEqual(await listStored(root), []);
  });

  test('removes the file it stored and gives its upload slot back when the connection drops in the middle of the next file', { timeout: HANG_TIMEOUT_MS }, async (t) => {
    const { fastify, root } = await buildUploadApp(t, { upload: { maxActiveFiles: 1 } });

    declareItems(fastify);
    await fastify.listen({ host: '127.0.0.1', port: 0 });

    const { port } = fastify.server.address();
    const sent = Buffer.concat([textPart('name', 'Anna'), pdfPart(), fileHeader('scans', { filename: 'cut.pdf', type: PDF }), PDF_BYTES.subarray(0, PDF_HEAD_BYTES)]);
    const connection = await openRawConnection(port);

    await connection.write(Buffer.concat([toRawHead({ contentLength: sent.length + KB }), sent]));
    await waitFor(async () => (await listStored(root)).length === 1, 'the first file to be stored');
    connection.socket.destroy();
    await connection.closed;
    await waitFor(async () => (await listStored(root)).length === 0, 'the stored file to be removed');

    const { status } = await sendRaw(port, createForm([pdfPart()]));

    assert.equal(status, 200);
  });
});

describe('multipart plugin: an answer that comes before the end of a form', () => {
  async function listenGuarded(t) {
    const opened = await buildUploadApp(t);

    declareItems(opened.fastify, { security: GUARDED });
    opened.fastify.post(PLAIN_URL, { security: PUBLIC }, countCall([]));
    await opened.fastify.listen({ host: '127.0.0.1', port: 0 });

    return { ...opened, port: opened.fastify.server.address().port };
  }

  function toSlices(bytes) {
    return Array.from({ length: Math.ceil(bytes.length / SLICE_BYTES) }, (unused, index) => bytes.subarray(index * SLICE_BYTES, (index + 1) * SLICE_BYTES));
  }

  // The body after its head, in slices with a pause between them: a proxy forwards a body as it receives it.
  async function sendInSlices(port, { method, url }, body) {
    const connection = await openRawConnection(port, { timeoutMs: SLOW_DEADLINE_MS });
    const sent = { lastAt: null };

    await connection.write(toRawHead({ method, url, contentLength: body.length }));
    await mapSeries(toSlices(body), async (slice) => {
      await sleep(SLICE_PAUSE_MS);
      sent.lastAt = performance.now();

      return connection.write(slice);
    });

    const text = await connection.closed;

    return { ...readRawAnswer(text), answeredAt: connection.received.firstAt, lastSentAt: sent.lastAt };
  }

  function sendHeldForm(fastify, payload) {
    return fastify.inject({
      method: 'PATCH',
      url: ITEMS_URL,
      headers: { [HEADER.CONTENT_TYPE]: FORM_TYPE },
      payload,
    });
  }

  test('holds a refusal of the guard and of a route without files until the form has ended: over a connection the client closes, each answer comes whole', { timeout: SLOW_DEADLINE_MS * 2 }, async (t) => {
    const { port, root } = await listenGuarded(t);
    const body = createForm([filePart('scans', createPdf(LARGE_FORM_BYTES), { filename: 'large.pdf', type: PDF })]);
    const answers = await mapSeries([{ method: 'PATCH', url: ITEMS_URL }, { method: 'POST', url: PLAIN_URL }], (target) => sendInSlices(port, target, body));

    assert.deepEqual(answers.map(({ status, body: answer }) => [status, answer.code]), [[401, 'AUTHENTICATION_ERROR'], [415, 'UNSUPPORTED_MEDIA_TYPE_ERROR']]);
    answers.forEach(({ answeredAt, lastSentAt }) => assert.ok(answeredAt >= lastSentAt, `the answer came at ${answeredAt}, before the last slice at ${lastSentAt}`));
    assert.equal(existsSync(root), false);
  });

  // Settles the answer to a form whose body goes on past maxBodySize: true when it came before the end of that body.
  async function answerOverForm(fastify, head) {
    const payload = new PassThrough();
    const state = { response: null };

    async function answer() {
      state.response = await sendHeldForm(fastify, payload);
    }

    const answering = answer();

    payload.write(Buffer.concat([head, Buffer.alloc(SMALL_BODY_BYTES + KB)]));
    await sleep(HELD_MS);

    const isEarly = state.response !== null;

    payload.end(Buffer.alloc(KB));
    await answering;

    return { response: state.response, isEarly };
  }

  test('holds a refusal until the end of a form past maxBodySize of the config too, and keeps the connection', async (t) => {
    const { fastify } = await buildUploadApp(t, { upload: SMALL_BODY });

    declareItems(fastify, { security: GUARDED });
    await fastify.ready();

    const { response, isEarly } = await answerOverForm(fastify, Buffer.alloc(0));

    assertRefused([response], UNAUTHENTICATED);
    assert.deepEqual([isEarly, response.headers[HEADER.CONNECTION]], [false, 'keep-alive']);
  });

  test('answers 413 to a form past maxBodySize of the config once its body has ended: the file it stored goes, and the connection stays', async (t) => {
    const { fastify, root } = await buildUploadApp(t, { upload: SMALL_BODY });

    declareItems(fastify);
    await fastify.ready();

    const { response, isEarly } = await answerOverForm(fastify, Buffer.concat([pdfPart(), fileHeader('other', { filename: 'large.bin' })]));

    assertFailed(response, 413, 'PAYLOAD_TOO_LARGE_ERROR', 'Payload too large');
    assert.deepEqual([isEarly, response.headers[HEADER.CONNECTION]], [false, 'keep-alive']);
    assert.deepEqual(await listStored(root), []);
  });

  test('answers 413 whole to a form past maxBodySize of the config over a connection the client closes, after its last slice', { timeout: SLOW_DEADLINE_MS }, async (t) => {
    const { fastify, root } = await buildUploadApp(t, { upload: SMALL_BODY });

    declareItems(fastify);
    await fastify.listen({ host: '127.0.0.1', port: 0 });

    const body = createForm([filePart('scans', createPdf(LARGE_FORM_BYTES), { filename: 'large.pdf', type: PDF })]);
    const answer = await sendInSlices(fastify.server.address().port, { method: 'PATCH', url: ITEMS_URL }, body);

    assert.deepEqual([answer.status, answer.body.code], [413, 'PAYLOAD_TOO_LARGE_ERROR']);
    assert.ok(answer.answeredAt >= answer.lastSentAt, `the answer came at ${answer.answeredAt}, before the last slice at ${answer.lastSentAt}`);
    assert.deepEqual(await listStored(root), []);
  });
});

describe('multipart plugin: what it never touches', () => {
  test('leaves a stored file of the upload folder alone when a request of JSON fails', async (t) => {
    const { fastify, root } = await openItems(t, {
      handler: async () => {
        throw new Error('The service failed');
      },
    });
    const key = `${uuidv7()}.pdf`;

    await mkdir(root, { recursive: true });
    await writeFile(nodePath.join(root, key), PDF_BYTES);

    const response = await fastify.inject({ method: 'PATCH', url: ITEMS_URL, payload: { name: 'Anna' } });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(await listStored(root), [key]);
  });
});
