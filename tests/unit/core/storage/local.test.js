import { toStorageKey } from '#core/storage/key.js';
import { createLocalStorage } from '#core/storage/local.js';
import { REMOVE_OPTIONS } from '#root/tests/helper/multipart.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { after, describe, test } from 'node:test';

const BASE_URL = 'https://app.test';
const PUBLIC_PATH = '/upload/';
const UUID = '019a0000-0000-7000-8000-000000000000';
const PARALLEL_PUTS = 20;
const CUT_SHORT_BYTES = 4;
const VIEW_TEXT = 'ABC';
const PADDING = 'xx';

const BYTES = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1');
const OTHER_BYTES = Buffer.from('%PDF-2.0\n', 'latin1');

const BAD_KEYS = [
  '../x.png',
  `../${UUID}.png`,
  'a/b.png',
  `a/${UUID}.png`,
  `a\\${UUID}.png`,
  `..\\${UUID}.png`,
  `${UUID.toUpperCase()}.png`,
  `${UUID}.exe`,
  `${UUID}.PNG`,
  UUID,
  `${UUID}.`,
  `${UUID}.${'p'.repeat(UUID.length)}`,
  'x'.repeat(UUID.length * 2),
  '',
  null,
  undefined,
  1,
  {},
  [`${UUID}.png`],
  Buffer.from(`${UUID}.png`),
  { toString: () => `${UUID}.png` },
];

const directory = await mkdtemp(nodePath.join(tmpdir(), 'nfs-test-storage-'));

after(() => rm(directory, REMOVE_OPTIONS));

function createRootPath() {
  return nodePath.join(directory, uuidv7(), 'upload');
}

// Two levels of the root are not there yet: a put makes both.
function openStorage(root = createRootPath()) {
  return { root, storage: createLocalStorage({ root, publicPath: PUBLIC_PATH, baseUrl: BASE_URL }) };
}

async function placeFile(filePath) {
  await mkdir(nodePath.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'in the way');
}

async function readFileHandlePrototype() {
  const handle = await open(nodePath.join(directory, uuidv7()), 'w');

  await handle.close();

  return Object.getPrototypeOf(handle);
}

function assertStableFailure(error, verb, filePath) {
  assert.equal(error.message, `Storage failed to ${verb} a file: ${error.cause.code}`);
  assert.match(error.cause.code, /^E[A-Z]+$/);
  assert.equal(error.cause.message.includes(filePath), true);

  return true;
}

describe('createLocalStorage', () => {
  test('gives a frozen adapter of put, get, delete, exists and url', () => {
    const { storage } = openStorage();

    assert.ok(Object.isFrozen(storage));
    assert.deepEqual(Object.keys(storage), ['put', 'get', 'delete', 'exists', 'url']);
  });

  test('requires an absolute root: a relative one would follow the working directory of the process', () => {
    [undefined, null, '', 'upload', './upload', 'upload/files', '..', 1, [directory]].forEach((root) => {
      assert.throws(() => createLocalStorage({ root, publicPath: PUBLIC_PATH, baseUrl: BASE_URL }), {
        name: 'TypeError',
        message: 'createLocalStorage({ root, publicPath, baseUrl }) requires root to be an absolute path: a relative one would follow the working directory of the process',
      });
    });

    assert.throws(() => createLocalStorage(), /requires root to be an absolute path/);
  });

  test('requires a public path of plain segments between slashes', () => {
    const root = createRootPath();

    ['/upload/', '/static/upload/', '/user_files/', '/a-b/'].forEach((publicPath) => {
      assert.doesNotThrow(() => createLocalStorage({ root, publicPath, baseUrl: BASE_URL }));
    });

    [
      undefined,
      null,
      '',
      '/',
      '//',
      'upload/',
      '/upload',
      '/upload//',
      '//upload/',
      '/./',
      '/../',
      '/upload/../',
      '/%2e%2e/',
      '/up load/',
      '/upload?x=/',
      '/upload#/',
      '/a\\b/',
      '/upload/\n',
      1,
    ].forEach((publicPath) => {
      assert.throws(() => createLocalStorage({ root, publicPath, baseUrl: BASE_URL }), {
        name: 'TypeError',
        message: 'createLocalStorage({ root, publicPath, baseUrl }) requires publicPath to start and end with "/" and to hold segments of letters, digits, "_" and "-", such as "/upload/"',
      }, JSON.stringify(publicPath));
    });
  });

  test('requires the base URL of the app, which the public path follows', () => {
    const root = createRootPath();

    ['https://app.test', 'http://127.0.0.1:4173', 'https://api.example.com:8443'].forEach((baseUrl) => {
      assert.doesNotThrow(() => createLocalStorage({ root, publicPath: PUBLIC_PATH, baseUrl }));
    });

    [undefined, null, '', 'app.test', '//app.test', 'ftp://app.test', 'https://app.test/', 'https://user:secret@app.test', 'file:///srv/upload', 1].forEach((baseUrl) => {
      assert.throws(() => createLocalStorage({ root, publicPath: PUBLIC_PATH, baseUrl }), {
        name: 'TypeError',
        message: 'createLocalStorage({ root, publicPath, baseUrl }) requires baseUrl to be an http or https URL that does not end with "/", such as config.app.url',
      }, String(baseUrl));
    });
  });
});

describe('put and get', () => {
  test('read back what was put, byte for byte, from a file named by the key in the root', async () => {
    const { root, storage } = openStorage();
    const key = toStorageKey('pdf');

    assert.equal(await storage.put(key, BYTES), undefined);

    const bytes = await storage.get(key);

    assert.ok(Buffer.isBuffer(bytes));
    assert.deepEqual(bytes, BYTES);
    assert.deepEqual(await readFile(nodePath.join(root, key)), BYTES);
    assert.deepEqual(await readdir(root), [key]);
  });

  test('take a Uint8Array, and the bytes of a view without the memory around it', async () => {
    const { storage } = openStorage();
    const memory = Buffer.from(`${PADDING}${VIEW_TEXT}${PADDING}`);
    const view = memory.subarray(PADDING.length, PADDING.length + VIEW_TEXT.length);
    const viewKey = toStorageKey('png');
    const arrayKey = toStorageKey('png');

    await storage.put(viewKey, view);
    await storage.put(arrayKey, Uint8Array.from([1, 2, 3]));

    assert.equal((await storage.get(viewKey)).toString(), VIEW_TEXT);
    assert.deepEqual(await storage.get(arrayKey), Buffer.from([1, 2, 3]));
  });

  test('give null for a key that holds no file, also before the root is there', async () => {
    const { root, storage } = openStorage();

    assert.equal(await storage.get(toStorageKey('png')), null);

    await storage.put(toStorageKey('png'), BYTES);

    assert.equal(await storage.get(toStorageKey('png')), null);
    assert.equal((await readdir(root)).length, 1);
  });

  test('never write over a key: a second put fails without a path in its message and leaves the first file', async () => {
    const { root, storage } = openStorage();
    const key = toStorageKey('jpg');

    await storage.put(key, BYTES);

    await assert.rejects(storage.put(key, OTHER_BYTES), (error) => {
      assert.equal(error.message, 'Storage failed to write a file: EEXIST');

      return assertStableFailure(error, 'write', nodePath.join(root, key));
    });
    assert.deepEqual(await storage.get(key), BYTES);
  });

  test('refuse bytes that are not a Buffer or a Uint8Array, before the root is made', async () => {
    const { root, storage } = openStorage();
    const values = ['text', null, undefined, 1, [1, 2], { length: 1, 0: 1 }, new ArrayBuffer(2), new DataView(new ArrayBuffer(2)), new Uint16Array(2), new Uint8ClampedArray(2)];

    await Promise.all(values.map((bytes) => assert.rejects(storage.put(toStorageKey('png'), bytes), {
      name: 'TypeError',
      message: 'storage.put(key, bytes) requires the bytes of the file as a Buffer or a Uint8Array',
    })));
    assert.equal(existsSync(root), false);
  });

  test('remove a file the disk filled up under, and the key can be put again', async (t) => {
    const { root, storage } = openStorage();
    const key = toStorageKey('pdf');
    const prototype = await readFileHandlePrototype();
    const { writeFile: writeWhole } = prototype;
    const noSpace = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });

    async function writeCutShort(bytes) {
      await writeWhole.call(this, bytes.subarray(0, CUT_SHORT_BYTES));

      throw noSpace;
    }

    const writing = t.mock.method(prototype, 'writeFile', writeCutShort);

    await assert.rejects(storage.put(key, BYTES), (error) => {
      assert.equal(error.message, 'Storage failed to write a file: ENOSPC');
      assert.equal(error.cause, noSpace);

      return true;
    });
    assert.equal(writing.mock.callCount(), 1);
    assert.deepEqual(await readdir(root), []);

    writing.mock.restore();
    await storage.put(key, BYTES);

    assert.deepEqual(await storage.get(key), BYTES);
  });
});

describe('delete and exists', () => {
  test('delete a file once: a second delete, and one of a key never put, are false', async () => {
    const { root, storage } = openStorage();
    const key = toStorageKey('gif');

    assert.equal(await storage.delete(key), false);

    await storage.put(key, BYTES);

    assert.equal(await storage.delete(key), true);
    assert.equal(await storage.delete(key), false);
    assert.equal(await storage.delete(toStorageKey('gif')), false);
    assert.deepEqual(await readdir(root), []);
  });

  test('find a file once it is put, and not after it is deleted', async () => {
    const { storage } = openStorage();
    const key = toStorageKey('webp');

    assert.equal(await storage.exists(key), false);

    await storage.put(key, BYTES);

    assert.equal(await storage.exists(key), true);
    assert.equal(await storage.exists(toStorageKey('webp')), false);

    await storage.delete(key);

    assert.equal(await storage.exists(key), false);
  });
});

describe('url', () => {
  test('gives the address of a file under the public path of the base URL, at once and without the disk', () => {
    const { root, storage } = openStorage();
    const key = toStorageKey('webp');

    assert.equal(storage.url(key), `https://app.test/upload/${key}`);
    assert.equal(existsSync(root), false);
  });
});

describe('the key', () => {
  test('is refused by every method unless toStorageKey made it, and nothing is written anywhere', async () => {
    const { root, storage } = openStorage();
    const methods = [
      [(key) => storage.put(key, BYTES), 'storage.put(key, bytes)'],
      [(key) => storage.get(key), 'storage.get(key)'],
      [(key) => storage.delete(key), 'storage.delete(key)'],
      [(key) => storage.exists(key), 'storage.exists(key)'],
    ];

    await Promise.all(BAD_KEYS.flatMap((key) => methods.map(([call, signature]) => assert.rejects(call(key), {
      name: 'TypeError',
      message: `${signature} requires a key made by toStorageKey(extension)`,
    }))));

    BAD_KEYS.forEach((key) => {
      assert.throws(() => storage.url(key), {
        name: 'TypeError',
        message: 'storage.url(key) requires a key made by toStorageKey(extension)',
      });
    });

    assert.equal(existsSync(nodePath.dirname(root)), false);
  });
});

describe('the root', () => {
  test('is made by the first put only, with the folders above it', async () => {
    const { root, storage } = openStorage();
    const key = toStorageKey('png');

    assert.equal(await storage.exists(key), false);
    assert.equal(await storage.get(key), null);
    assert.equal(await storage.delete(key), false);
    storage.url(key);
    await assert.rejects(storage.put('../x.png', BYTES), TypeError);
    await assert.rejects(storage.put(key, 'not bytes'), TypeError);

    assert.equal(existsSync(nodePath.dirname(root)), false);

    await storage.put(key, BYTES);

    assert.deepEqual(await readdir(root), [key]);
  });

  test('is made once: the puts that come at once wait for one creation, and a later put does not look for it again', async () => {
    const { root, storage } = openStorage();
    const keys = Array.from({ length: PARALLEL_PUTS }, () => toStorageKey('pdf'));

    await Promise.all(keys.map((key) => storage.put(key, BYTES)));

    assert.deepEqual((await readdir(root)).toSorted(), keys.toSorted());

    await rm(root, REMOVE_OPTIONS);

    await assert.rejects(storage.put(toStorageKey('pdf'), BYTES), { message: 'Storage failed to write a file: ENOENT' });
    assert.equal(existsSync(root), false);
  });

  test('is tried again by the next put when it could not be made', async () => {
    const { root, storage } = openStorage();
    const key = toStorageKey('png');

    await placeFile(root);

    await assert.rejects(storage.put(key, BYTES), (error) => assertStableFailure(error, 'write', root));

    await rm(root);
    await storage.put(key, BYTES);

    assert.deepEqual(await storage.get(key), BYTES);
  });

  test('holds no file when it is a file itself: get, exists and delete find nothing there', async () => {
    const { root, storage } = openStorage();
    const key = toStorageKey('png');

    await placeFile(root);

    assert.equal(await storage.get(key), null);
    assert.equal(await storage.exists(key), false);
    assert.equal(await storage.delete(key), false);
  });
});

describe('a failure of the file system', () => {
  test('is a stable message of the verb and the code, with the error of fs as its cause', async () => {
    const { root, storage } = openStorage();
    const key = toStorageKey('png');
    const filePath = nodePath.join(root, key);

    await mkdir(filePath, { recursive: true });

    await assert.rejects(storage.put(key, BYTES), (error) => assertStableFailure(error, 'write', filePath));
    await assert.rejects(storage.get(key), (error) => assertStableFailure(error, 'read', filePath));
    await assert.rejects(storage.delete(key), (error) => assertStableFailure(error, 'delete', filePath));
  });

  test('reads the same for every file: an alert told by its message repeats', async () => {
    const { root, storage } = openStorage();
    const keys = [toStorageKey('png'), toStorageKey('png')];

    await Promise.all(keys.map((key) => mkdir(nodePath.join(root, key), { recursive: true })));

    const reads = await Promise.allSettled(keys.map((key) => storage.get(key)));

    assert.deepEqual(reads.map(({ reason }) => reason.message), [
      'Storage failed to read a file: EISDIR',
      'Storage failed to read a file: EISDIR',
    ]);
  });
});
