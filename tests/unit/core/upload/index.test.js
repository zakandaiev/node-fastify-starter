import { createUploadConfig } from '#config/upload.js';
import { createContext, runInContext } from '#core/context/index.js';
import { toDbError } from '#core/db/error.js';
import { AppError } from '#core/error/index.js';
import { IMAGE_INPUT_TYPES } from '#core/image/profile.js';
import { withFileFields } from '#core/schema/files.js';
import { createStorage } from '#core/storage/index.js';
import { isStorageKey } from '#core/storage/key.js';
import {
  commitUploadedFiles,
  drainRequest,
  keepUploadedFiles,
  readMultipartBody,
  removeUploadedFiles,
  UPLOAD_STATE,
} from '#core/upload/index.js';
import { readFileOptions } from '#core/upload/options.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { FILE_CHECK } from '#enums/file-check.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import {
  createImage,
  createPdf,
  listStored,
  REMOVE_OPTIONS,
} from '#root/tests/helper/multipart.js';
import { mapSeries } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import { freezeDeep } from '#utils/object.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { after, describe, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import sharp from 'sharp';

const directory = await mkdtemp(nodePath.join(tmpdir(), 'nfs-test-upload-'));

after(() => rm(directory, REMOVE_OPTIONS));

const BASE_URL = 'https://app.test';
const STORAGE = Object.freeze({ ...createUploadConfig().storage });
const CONFIG = createTestConfig();
const LOG = Object.freeze({});

const BODY_LIMIT = 64;
const KB = 1024;
const PDF = 'application/pdf';
const PDF_BYTES = Buffer.from('%PDF-1.7\nthe bytes of a document\n');
const EXE_BYTES = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(KB)]);
const BROKEN_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('no image after the signature')]);
const SIDE = 40;

const OPTIONS = readFileOptions({
  fields: {
    avatar: { maxSize: '4KB', mime: IMAGE_INPUT_TYPES, image: IMAGE_PROFILE.AVATAR },
    scans: { max: 2, maxSize: '1KB', mime: [PDF] },
  },
}, CONFIG.upload);

// The text fields of the form of the route beside its files: what a field takes decides how its text is read.
const BODY = freezeDeep({
  type: 'object',
  properties: {
    name: { type: 'string' },
    label: { type: ['string', 'null'] },
    count: { type: 'integer' },
    total: { type: 'number' },
    isPublic: { type: 'boolean' },
    ids: { type: 'array', items: { type: ['integer', 'null'] } },
    tags: { type: 'array', items: { type: 'string' } },
  },
});
const ROUTE_SCHEMA = freezeDeep(withFileFields({ body: BODY }, OPTIONS));

const PNG_BYTES = await createImage(SIDE, SIDE).png().toBuffer();

const PARSER_END_MESSAGE = 'Unexpected end of multipart data';

const BODY_OVER_CONFIG = createTestConfig({ upload: { maxBodySize: '1KB' } });
const BODY_OVER_BYTES = Buffer.alloc(2 * KB, 'x');
const HANG_TIMEOUT_MS = 5000;

function createRoot() {
  return nodePath.join(directory, uuidv7());
}

function openStorage(root = createRoot()) {
  return { root, storage: createStorage({ ...STORAGE, root }, { baseUrl: BASE_URL }) };
}

function textPart(fieldname, value, extra = {}) {
  return {
    type: 'field',
    fieldname,
    value,
    valueTruncated: false,
    fieldnameTruncated: false,
    ...extra,
  };
}

function filePart(fieldname, bytes, { filename = 'file.bin', file = Readable.from([bytes]), isTruncated = false } = {}) {
  file.truncated = isTruncated;

  return {
    type: 'file',
    fieldname,
    filename,
    file,
  };
}

// A parser fed no more never gives the next part: with isHung the parts end in a wait that nothing ends.
async function* listParts(parts, { error, isHung }) {
  yield* parts;

  if (error) {
    throw error;
  }

  if (isHung) {
    await new Promise(() => {});
  }
}

function createRequest(parts, {
  error = null,
  isHung = false,
  raw = Readable.from([]),
  bodyLimit = BODY_LIMIT,
} = {}) {
  const logged = [];

  return {
    logged,
    request: {
      parts: () => listParts(parts, { error, isHung }),
      raw,
      routeOptions: { bodyLimit, schema: ROUTE_SCHEMA },
      uploadedFiles: null,
      log: {
        error(object, message) {
          logged.push([object.err.message, message]);
        },
      },
    },
  };
}

function readBody(request, storage, { config = CONFIG, options = OPTIONS } = {}) {
  return runInContext(createContext({ config, log: LOG, storage }), () => readMultipartBody(request, options));
}

function toEntry(column, operator, operatorValue) {
  return {
    column,
    columnValue: null,
    operator,
    operatorValue,
  };
}

function readEnded(parts) {
  return parts.filter((part) => part.type === 'file').map((part) => part.file.readableEnded || part.file.destroyed);
}

describe('UPLOAD_STATE', () => {
  test('is a symbol: what a request keeps of its files is no field of the request anyone reads', () => {
    assert.equal(typeof UPLOAD_STATE, 'symbol');
  });
});

describe('readMultipartBody', () => {
  test('takes the text of a form as the body: "null" of a file field is null, a repeated name the list of its values, a part without a name is dropped', async () => {
    const { storage } = openStorage();
    const { request } = createRequest([
      textPart('name', 'Anna'),
      textPart('tags', 'a'),
      textPart('tags', 'b'),
      textPart('avatar', 'null'),
      textPart('note', ''),
      textPart('', 'nameless'),
      textPart(undefined, 'nameless'),
    ]);

    assert.equal(await readBody(request, storage), true);
    assert.deepEqual(request.body, {
      name: 'Anna',
      tags: ['a', 'b'],
      avatar: null,
      note: '',
    });
    assert.deepEqual(request.uploadedFiles, {});
    assert.deepEqual(request[UPLOAD_STATE], { storage, keys: [], isKept: false });
  });

  test('reads "null" as null only where the form takes null, and anywhere else as the text "null"; null of a part of JSON stays null, as in a JSON body, and blank text of a field of numbers is no value', async () => {
    const { storage } = openStorage();
    const { request } = createRequest([
      textPart('avatar', 'null'),
      textPart('label', 'null'),
      textPart('name', 'null'),
      textPart('count', 'null'),
      textPart('isPublic', null),
      textPart('total', '  '),
      textPart('total', ''),
      textPart('ids', '1'),
      textPart('ids', 'null'),
      textPart('ids', ' '),
      textPart('tags', 'a'),
      textPart('tags', 'null'),
      textPart('note', 'null'),
    ], { bodyLimit: KB });

    await readBody(request, storage);

    assert.deepEqual(request.body, {
      avatar: null,
      label: null,
      name: 'null',
      count: 'null',
      isPublic: null,
      ids: ['1', null],
      tags: ['a', 'null'],
      note: 'null',
    });
  });

  test('stores each file as soon as it is read: a document as it came, an image encoded by the profile of its field, a field of several files as a list', async () => {
    const { root, storage } = openStorage();
    const { request } = createRequest([
      filePart('avatar', PNG_BYTES, { filename: 'me.png' }),
      filePart('scans', PDF_BYTES, { filename: 'a.pdf' }),
      filePart('scans', PDF_BYTES, { filename: 'b.pdf' }),
      textPart('name', 'Anna'),
    ]);

    await readBody(request, storage);

    const { avatar, scans } = request.uploadedFiles;
    const keys = [avatar.key, ...scans.map((scan) => scan.key)];

    assert.deepEqual(request.body, { name: 'Anna' });
    assert.ok(keys.every((key) => isStorageKey(key)));
    assert.deepEqual(avatar, {
      key: avatar.key,
      url: `${BASE_URL}/upload/${avatar.key}`,
      mime: 'image/webp',
      size: avatar.size,
      width: SIDE,
      height: SIDE,
    });
    assert.match(avatar.key, /\.webp$/);
    assert.deepEqual(scans, scans.map(({ key }) => ({
      key,
      url: `${BASE_URL}/upload/${key}`,
      mime: PDF,
      size: PDF_BYTES.length,
    })));
    assert.deepEqual(await storage.get(scans[0].key), PDF_BYTES);
    assert.deepEqual((await sharp(await storage.get(avatar.key)).metadata()).format, 'webp');
    assert.deepEqual(request[UPLOAD_STATE].keys, keys);
    assert.deepEqual((await listStored(root)).toSorted(), keys.toSorted());
  });

  test('reads to its end and drops a file of a field the route does not name and an empty file input', async () => {
    const { root, storage } = openStorage();
    const parts = [
      filePart('other', PDF_BYTES, { filename: 'a.pdf' }),
      filePart('avatar', Buffer.alloc(0), { filename: '' }),
      { ...filePart('scans', PDF_BYTES), filename: undefined },
    ];
    const { request } = createRequest(parts);

    await readBody(request, storage);

    assert.deepEqual([request.body, request.uploadedFiles], [{}, {}]);
    assert.deepEqual(readEnded(parts), [true, true, true]);
    assert.deepEqual(await listStored(root), []);
  });

  test('refuses a file over the size of its field, read past it or cut by the parser, a type its field does not take by the bytes, and an image the decoder refuses, and removes the files it stored', async () => {
    const { root, storage } = openStorage();
    const parts = [
      filePart('scans', PDF_BYTES, { filename: 'kept-at-first.pdf' }),
      filePart('scans', createPdf(KB + 1), { filename: 'large.pdf' }),
      filePart('avatar', EXE_BYTES, { filename: 'a.png' }),
    ];
    const { request } = createRequest(parts);
    const error = await rejectionOf(readBody(request, storage));

    assert.ok(error instanceof AppError);
    assert.equal(error.code, ERROR_CODE.VALIDATION_ERROR);
    assert.deepEqual(error.validation, [
      toEntry('scans', FILE_CHECK.MAX_SIZE, KB),
      toEntry('avatar', FILE_CHECK.MIME, IMAGE_INPUT_TYPES),
    ]);
    assert.deepEqual(readEnded(parts), [true, true, true]);
    assert.deepEqual(await listStored(root), []);

    const cut = createRequest([filePart('avatar', PNG_BYTES, { isTruncated: true })]);

    assert.deepEqual((await rejectionOf(readBody(cut.request, storage))).validation, [toEntry('avatar', FILE_CHECK.MAX_SIZE, 4 * KB)]);

    const broken = createRequest([filePart('avatar', BROKEN_PNG)]);

    assert.deepEqual((await rejectionOf(readBody(broken.request, storage))).validation, [toEntry('avatar', FILE_CHECK.IMAGE, null)]);
  });

  test('refuses a field past its max, a text value of it counted as one of its files, the body past maxFiles, and files past totalMaxSize, each once', async () => {
    const { root, storage } = openStorage();
    const options = readFileOptions({
      fields: { avatar: { maxSize: '4KB', mime: IMAGE_INPUT_TYPES, image: IMAGE_PROFILE.AVATAR }, scans: { max: 2, maxSize: '1KB', mime: [PDF] } },
      maxFiles: 2,
      totalMaxSize: '1KB',
    }, CONFIG.upload);
    const halfKb = createPdf(KB / 2 + 1);
    const cases = [
      [[textPart('avatar', 'null'), filePart('avatar', PNG_BYTES), filePart('avatar', PNG_BYTES)], [toEntry('avatar', FILE_CHECK.MAX_FILES, 1)]],
      [[filePart('scans', PDF_BYTES), filePart('scans', PDF_BYTES), filePart('scans', PDF_BYTES)], [toEntry('scans', FILE_CHECK.MAX_FILES, 2)]],
      [[filePart('avatar', PNG_BYTES), filePart('scans', PDF_BYTES), filePart('scans', PDF_BYTES)], [toEntry('scans', FILE_CHECK.MAX_FILES, 2)]],
      [[filePart('scans', halfKb), filePart('scans', halfKb)], [toEntry('scans', FILE_CHECK.TOTAL_MAX_SIZE, KB)]],
    ];

    const errors = await mapSeries(cases, ([parts]) => rejectionOf(readBody(createRequest(parts).request, storage, { options })));

    assert.deepEqual(errors.map((error) => error.validation), cases.map(([, validation]) => validation));
    assert.deepEqual(await listStored(root), []);
  });

  test('answers 413 to text over the bodyLimit of the route, a value the parser cut or the values together, once the body is read', async () => {
    const { root, storage } = openStorage();
    const cut = createRequest([textPart('name', 'x', { valueTruncated: true })]);
    const summed = createRequest([filePart('scans', PDF_BYTES), textPart('name', 'x'.repeat(BODY_LIMIT / 2)), textPart('note', 'x'.repeat(BODY_LIMIT / 2 + 1))]);
    const errors = await mapSeries([cut, summed], ({ request }) => rejectionOf(readBody(request, storage)));

    assert.deepEqual(errors.map((error) => error.code), [ERROR_CODE.PAYLOAD_TOO_LARGE_ERROR, ERROR_CODE.PAYLOAD_TOO_LARGE_ERROR]);
    assert.deepEqual(await listStored(root), []);
  });

  test('counts the names into the text of the form, those of a file part and of a part it drops for want of a name too', async () => {
    const { storage } = openStorage();
    const over = 'x'.repeat(BODY_LIMIT + 1);
    const cases = [
      [textPart(over, '')],
      [textPart('name', 'x'.repeat(BODY_LIMIT / 2)), textPart('', 'x'.repeat(BODY_LIMIT / 2))],
      [filePart(over, PDF_BYTES)],
    ];
    const errors = await mapSeries(cases, (parts) => rejectionOf(readBody(createRequest(parts).request, storage)));

    assert.deepEqual(errors.map((error) => error.code), cases.map(() => ERROR_CODE.PAYLOAD_TOO_LARGE_ERROR));
  });

  test('stops the parse once the text is over: the parser is fed no more, the parts after are never read, and the rest of the body is', { timeout: HANG_TIMEOUT_MS }, async () => {
    const { storage } = openStorage();
    const raw = new PassThrough();
    const parser = new PassThrough();
    const parts = [textPart('name', 'x'.repeat(BODY_LIMIT + 1)), filePart('scans', PDF_BYTES), textPart('note', 'x')];
    const { request } = createRequest(parts, { raw, error: new Error(PARSER_END_MESSAGE) });

    raw.pipe(parser);

    const reading = rejectionOf(readBody(request, storage));

    await once(parser, 'unpipe');
    raw.end('the rest of the body');

    assert.equal((await reading).code, ERROR_CODE.PAYLOAD_TOO_LARGE_ERROR);
    assert.deepEqual([readEnded(parts), raw.readableEnded], [[false], true]);
  });

  test('answers 413 to a body past maxBodySize, while it waits for a part or reads one, once the body has ended: the parser is fed no more, and the rest is read and dropped', { timeout: HANG_TIMEOUT_MS }, async () => {
    const { root, storage } = openStorage();
    const held = new PassThrough();

    async function sendOver(parts, options) {
      const raw = new PassThrough();
      const parser = new PassThrough();
      const { request } = createRequest(parts, { ...options, raw });
      const state = { isSettled: false };

      async function read() {
        const error = await rejectionOf(readBody(request, storage, { config: BODY_OVER_CONFIG }));

        state.isSettled = true;

        return error;
      }

      const reading = read();

      raw.pipe(parser);
      await nextTurn();

      const unpiped = once(parser, 'unpipe');

      raw.write(BODY_OVER_BYTES);
      await unpiped;
      await nextTurn();

      const isSettledEarly = state.isSettled;

      raw.end(BODY_OVER_BYTES);

      return {
        error: await reading,
        raw,
        parser,
        isSettledEarly,
      };
    }

    const waiting = await sendOver([], { isHung: true });
    const reading = await sendOver([filePart('scans', null, { file: held })]);

    [waiting, reading].forEach(({
      error,
      raw,
      parser,
      isSettledEarly,
    }) => {
      assert.equal(error.code, ERROR_CODE.PAYLOAD_TOO_LARGE_ERROR);
      assert.deepEqual([isSettledEarly, raw.readableEnded, parser.readableLength], [false, true, BODY_OVER_BYTES.length]);
    });
    assert.equal(held.destroyed, true);
    assert.deepEqual(await listStored(root), []);
  });

  test('holds the body while it decodes and stores a file, also against the pipe that resumes it, and lets it flow again after', async () => {
    const { storage } = openStorage();
    const raw = new PassThrough();
    const paused = [];
    const { request } = createRequest([filePart('avatar', PNG_BYTES, { filename: 'me.png' })], { raw });
    const watched = {
      ...storage,
      async put(key, bytes) {
        paused.push(raw.isPaused());
        raw.resume();
        await nextTurn();
        paused.push(raw.isPaused());
        raw.end();

        return storage.put(key, bytes);
      },
    };

    await readBody(request, watched);

    assert.deepEqual([...paused, raw.readableEnded], [true, true, true]);
  });

  test('turns an error of the parser into a bad request with the error as its cause, keeps one the parser gave 400 or 413 itself, and removes the files it stored', async () => {
    const { root, storage } = openStorage();
    const broken = new Error(PARSER_END_MESSAGE);
    const tooMany = Object.assign(new Error('reach parts limit'), { statusCode: 413 });
    const named = Object.assign(new Error('prototype property is not allowed as field name'), { statusCode: 400 });
    const errors = await mapSeries([broken, tooMany, named], (error) => rejectionOf(readBody(createRequest([filePart('scans', PDF_BYTES)], { error }).request, storage)));

    assert.ok(errors[0] instanceof AppError);
    assert.deepEqual([errors[0].code, errors[0].cause], [ERROR_CODE.BAD_REQUEST_ERROR, broken]);
    assert.deepEqual(errors.slice(1), [tooMany, named]);
    assert.deepEqual(await listStored(root), []);
  });

  test('reads the rest of the body after a failure of its own, then throws it as it is and removes the files it stored', async () => {
    const { root, storage } = openStorage();
    const failure = new Error('Storage failed to write a file: ENOSPC');
    const puts = [];
    const failing = Object.freeze({
      ...storage,
      async put(key, bytes) {
        puts.push(key);

        if (puts.length > 1) {
          throw failure;
        }

        return storage.put(key, bytes);
      },
    });
    const parts = [filePart('scans', PDF_BYTES), filePart('scans', PDF_BYTES), filePart('avatar', PNG_BYTES), textPart('name', 'Anna')];
    const { request } = createRequest(parts);

    assert.equal(await rejectionOf(readBody(request, failing)), failure);
    assert.deepEqual(readEnded(parts), [true, true, true]);
    assert.equal(puts.length, 2);
    assert.deepEqual(await listStored(root), []);
  });

  test('answers 503 to a file while maxActiveFiles are at work in the process, once its body is read, and takes it again after', async () => {
    const { storage } = openStorage();
    const config = createTestConfig({ upload: { maxActiveFiles: 1 } });
    const held = new PassThrough();
    const first = createRequest([filePart('scans', null, { file: held })]);
    const reading = readBody(first.request, storage, { config });

    held.write('%PDF-1.7\n');
    await nextTurn();

    const busy = await rejectionOf(readBody(createRequest([filePart('scans', PDF_BYTES), textPart('name', 'Anna')]).request, storage, { config }));

    held.end('the rest of it\n');
    await reading;

    assert.equal(busy.code, ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
    assert.equal(first.request.uploadedFiles.scans[0].size, Buffer.byteLength('%PDF-1.7\nthe rest of it\n'));
    assert.equal(await readBody(createRequest([filePart('scans', PDF_BYTES)]).request, storage, { config }), true);
  });

  test('answers only once the body has ended: what the parser left, such as a tail after the closing boundary, is read first', async () => {
    const { storage } = openStorage();
    const raw = new PassThrough();
    const { request } = createRequest([textPart('name', 'Anna')], { raw });
    const state = { isDone: false };

    raw.write('a tail after the closing boundary');

    async function readToEnd() {
      await readBody(request, storage);
      state.isDone = true;
    }

    const reading = readToEnd();

    await nextTurn();
    await nextTurn();

    assert.equal(state.isDone, false);

    raw.end();
    await reading;

    assert.deepEqual([state.isDone, request.body], [true, { name: 'Anna' }]);
  });

  test('requires a request of the multipart plugin and the options of readFileOptions()', async () => {
    const { request } = createRequest([]);
    const calls = [[undefined, OPTIONS], [{}, OPTIONS], [request, undefined], [request, {}]];

    await Promise.all(calls.map(([given, options]) => assert.rejects(readMultipartBody(given, options), {
      name: 'TypeError',
      message: 'readMultipartBody(request, options) requires a request of the multipart plugin and the result of readFileOptions()',
    })));
  });
});

describe('drainRequest', () => {
  test('reads the rest of a body and drops it, however long, and resolves true once the body has ended', async () => {
    const raw = new PassThrough();
    const state = { isDone: false };

    async function drain() {
      const isEnded = await drainRequest({ raw });

      state.isDone = true;

      return isEnded;
    }

    raw.write(BODY_OVER_BYTES);

    const draining = drain();

    await nextTurn();
    assert.equal(state.isDone, false);
    raw.end(BODY_OVER_BYTES);

    assert.deepEqual([await draining, raw.readableEnded], [true, true]);
    assert.equal(await drainRequest({ raw }), true);
  });

  test('resolves false when the body breaks off before its end', async () => {
    const raw = new PassThrough();
    const draining = drainRequest({ raw });

    raw.destroy(new Error('aborted'));

    assert.equal(await draining, false);
  });

  test('requires a request with its body', async () => {
    await Promise.all([undefined, {}, { raw: {} }].map((request) => assert.rejects(drainRequest(request), {
      name: 'TypeError',
      message: 'drainRequest(request) requires a request with its body',
    })));
  });
});

describe('keepUploadedFiles and removeUploadedFiles', () => {
  async function storeTwo() {
    const opened = openStorage();
    const created = createRequest([filePart('scans', PDF_BYTES), filePart('scans', PDF_BYTES)]);

    await readBody(created.request, opened.storage);

    return { ...opened, ...created };
  }

  test('removeUploadedFiles removes the files a request has stored, once: a second call finds none', async () => {
    const { root, request } = await storeTwo();

    assert.equal((await listStored(root)).length, 2);
    assert.equal(await removeUploadedFiles(request), true);
    assert.deepEqual(await listStored(root), []);
    assert.equal(await removeUploadedFiles(request), false);
  });

  test('keepUploadedFiles hands the files to the rows of the service: no removal reaches them after it', async () => {
    const { root, request } = await storeTwo();

    assert.equal(keepUploadedFiles(request), true);
    assert.equal(await removeUploadedFiles(request), false);
    assert.equal((await listStored(root)).length, 2);
  });

  test('commitUploadedFiles keeps the files once the service it runs has resolved, and gives its result', async () => {
    const { root, request } = await storeTwo();

    assert.equal(await commitUploadedFiles(request, async () => 'committed'), 'committed');
    assert.equal(await removeUploadedFiles(request), false);
    assert.equal((await listStored(root)).length, 2);
  });

  test('commitUploadedFiles keeps the files when the connection of the service was lost on the way, which may have carried the COMMIT, and throws that error', async () => {
    const { root, request } = await storeTwo();
    const lost = toDbError(Object.assign(new Error('Connection lost: The server closed the connection.'), { fatal: true, code: 'PROTOCOL_CONNECTION_LOST' }));

    assert.equal(await rejectionOf(commitUploadedFiles(request, async () => {
      throw lost;
    })), lost);
    assert.equal(await removeUploadedFiles(request), false);
    assert.equal((await listStored(root)).length, 2);
  });

  test('commitUploadedFiles leaves the files to be removed after any other failure of the service, and throws it', async () => {
    const { root, request } = await storeTwo();
    const failure = new AppError(ERROR_CODE.NO_CHANGES);

    assert.equal(await rejectionOf(commitUploadedFiles(request, async () => {
      throw failure;
    })), failure);
    assert.equal(await removeUploadedFiles(request), true);
    assert.deepEqual(await listStored(root), []);
  });

  test('commitUploadedFiles requires a request and a function that runs the service', async () => {
    const { request } = createRequest([]);

    await assert.rejects(commitUploadedFiles(null, async () => true), { name: 'TypeError', message: 'commitUploadedFiles(request, run) requires a request' });
    await assert.rejects(commitUploadedFiles(request, 'run'), {
      name: 'TypeError',
      message: 'commitUploadedFiles(request, run) requires a function that runs the service',
    });
  });

  test('both find nothing to do on a request that has stored no file, such as one with a JSON body', async () => {
    const { request } = createRequest([]);

    assert.equal(keepUploadedFiles(request), false);
    assert.equal(await removeUploadedFiles(request), false);
  });

  test('removeUploadedFiles logs a file that fails to go and removes the others: a failed request never fails twice', async () => {
    const { request, logged, storage } = await storeTwo();
    const [failedKey] = request[UPLOAD_STATE].keys;
    const removed = [];

    request[UPLOAD_STATE].storage = Object.freeze({
      ...storage,
      async delete(key) {
        if (key === failedKey) {
          throw new Error('Storage failed to delete a file: EPERM');
        }

        removed.push(key);

        return storage.delete(key);
      },
    });

    assert.equal(await removeUploadedFiles(request), true);
    assert.deepEqual(logged, [['Storage failed to delete a file: EPERM', 'Failed to remove an uploaded file of a failed request']]);
    assert.deepEqual(removed, request.uploadedFiles.scans.slice(1).map((scan) => scan.key));
  });

  test('both require a request', async () => {
    [undefined, null, 'request'].forEach((request) => {
      assert.throws(() => keepUploadedFiles(request), { name: 'TypeError', message: 'keepUploadedFiles(request) requires a request' });
    });
    await Promise.all([undefined, null, 'request'].map((request) => assert.rejects(removeUploadedFiles(request), {
      name: 'TypeError',
      message: 'removeUploadedFiles(request) requires a request',
    })));
  });
});
