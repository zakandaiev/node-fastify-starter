import { createContext, runInContext } from '#core/context/index.js';
import { createStorage, getStorage } from '#core/storage/index.js';
import { toStorageKey } from '#core/storage/key.js';
import { createTestConfig, PROCESS_UPLOAD_ROOT } from '#root/tests/helper/config.js';
import { REMOVE_OPTIONS } from '#root/tests/helper/multipart.js';
import { uuidv7 } from '#utils/id.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { after, describe, test } from 'node:test';

const BASE_URL = 'https://app.test';
const SECTION = Object.freeze({ driver: 'local', publicPath: '/upload/', maxAge: '365d' });
const METHODS = ['put', 'get', 'delete', 'exists', 'url'];

const log = Object.freeze({});

const directory = await mkdtemp(nodePath.join(tmpdir(), 'nfs-test-storage-'));

after(() => rm(directory, REMOVE_OPTIONS));

function createRootPath() {
  return nodePath.join(directory, uuidv7(), 'upload');
}

describe('createStorage', () => {
  test('makes the adapter of the driver the storage section of config.upload names, and touches no disk for it', () => {
    const config = createTestConfig();
    const storage = createStorage(config.upload.storage, { baseUrl: config.app.url });
    const key = toStorageKey('webp');

    assert.ok(Object.isFrozen(storage));
    assert.deepEqual(Object.keys(storage).toSorted(), METHODS.toSorted());
    METHODS.forEach((method) => assert.equal(typeof storage[method], 'function'));
    assert.equal(storage.url(key), `${config.app.url}/upload/${key}`);
    assert.equal(existsSync(config.upload.storage.root), false);
    assert.equal(config.upload.storage.root, PROCESS_UPLOAD_ROOT);
  });

  test('stores through that driver: a file put is read back, found and deleted', async () => {
    const root = createRootPath();
    const storage = createStorage({ ...SECTION, root }, { baseUrl: BASE_URL });
    const key = toStorageKey('pdf');
    const bytes = Buffer.from('%PDF-1.7\n');

    await storage.put(key, bytes);

    assert.deepEqual(await storage.get(key), bytes);
    assert.equal(await storage.exists(key), true);
    assert.equal(await storage.delete(key), true);
    assert.equal(await storage.exists(key), false);
    assert.equal(storage.url(key), `${BASE_URL}/upload/${key}`);
  });

  test('refuses a section that is not an object', () => {
    [undefined, null, 'local', ['local'], 1].forEach((section) => {
      assert.throws(() => createStorage(section, { baseUrl: BASE_URL }), {
        name: 'TypeError',
        message: 'createStorage(storageConfig, { baseUrl }) requires the storage section of config.upload',
      });
    });
  });

  test('refuses a driver it does not know, a name of the prototype of an object included', () => {
    const drivers = [undefined, null, '', 's3', 'Local', 'LOCAL', ' local', 'local ', 1, '__proto__', 'constructor', 'toString', 'hasOwnProperty', { toString: () => 'local' }];

    drivers.forEach((driver) => {
      assert.throws(() => createStorage({ ...SECTION, root: createRootPath(), driver }, { baseUrl: BASE_URL }), {
        name: 'TypeError',
        message: /^config\.upload\.storage requires a driver of local: received /,
      });
    });

    assert.throws(() => createStorage({ ...SECTION, root: createRootPath(), driver: 's3' }), /received 's3'$/);
  });

  test('refuses at once a section its driver cannot work with', () => {
    const root = createRootPath();

    assert.throws(() => createStorage({ ...SECTION, root: 'upload' }, { baseUrl: BASE_URL }), { name: 'TypeError', message: /requires root to be an absolute path/ });
    assert.throws(() => createStorage({ ...SECTION, root, publicPath: 'upload' }, { baseUrl: BASE_URL }), { name: 'TypeError', message: /requires publicPath/ });
    assert.throws(() => createStorage({ ...SECTION, root }), { name: 'TypeError', message: /requires baseUrl/ });
    assert.throws(() => createStorage({ ...SECTION, root }, { baseUrl: `${BASE_URL}/` }), { name: 'TypeError', message: /requires baseUrl/ });
    assert.equal(existsSync(root), false);
  });
});

describe('getStorage', () => {
  test('throws a clear error outside a context', () => {
    assert.throws(() => getStorage(), /No active context: wrap the call in runInContext/);
  });

  test('throws a clear error in a context without storage', () => {
    const context = createContext({ config: {}, log });

    assert.throws(() => runInContext(context, () => getStorage()), {
      name: 'Error',
      message: 'The context has no storage: build it with createContext({ config, log, storage })',
    });
  });

  test('gives the storage of the context', () => {
    const storage = createStorage({ ...SECTION, root: createRootPath() }, { baseUrl: BASE_URL });
    const context = createContext({ config: {}, log, storage });

    assert.equal(runInContext(context, () => getStorage()), storage);
  });
});
