import { isStorageKey } from '#core/storage/key.js';
import { isNonEmptyString, isString } from '#utils/type.js';
import { isWebUrl } from '#utils/validate.js';
import {
  access,
  mkdir,
  open,
  readFile,
  unlink,
} from 'node:fs/promises';
import nodePath from 'node:path';
import { isUint8Array } from 'node:util/types';

// "x": the open fails on a file that is there, so a key is never written over.
const NEW_FILE_FLAG = 'wx';

// A root that is a file holds no file either: Windows answers ENOENT there, the others ENOTDIR.
const MISSING_CODES = Object.freeze(['ENOENT', 'ENOTDIR']);
const UNKNOWN_CODE = 'UNKNOWN';

const VERB = Object.freeze({
  WRITE: 'write',
  READ: 'read',
  DELETE: 'delete',
  CHECK: 'check',
});

const SIGNATURE = Object.freeze({
  FACTORY: 'createLocalStorage({ root, publicPath, baseUrl })',
  PUT: 'storage.put(key, bytes)',
  GET: 'storage.get(key)',
  DELETE: 'storage.delete(key)',
  EXISTS: 'storage.exists(key)',
  URL: 'storage.url(key)',
});

// Segments of letters, digits, "_" and "-": an address that needs no encoding, and no dot segment to lead out of it.
const PUBLIC_PATH_REGEXP = /^(?:\/[\w-]+)+\/$/;
const URL_PATH_SEPARATOR = '/';

function assertOptions({ root, publicPath, baseUrl }) {
  if (!isNonEmptyString(root) || !nodePath.isAbsolute(root)) {
    throw new TypeError(`${SIGNATURE.FACTORY} requires root to be an absolute path: a relative one would follow the working directory of the process`);
  }

  if (!isString(publicPath) || !PUBLIC_PATH_REGEXP.test(publicPath)) {
    throw new TypeError(`${SIGNATURE.FACTORY} requires publicPath to start and end with "/" and to hold segments of letters, digits, "_" and "-", such as "/upload/"`);
  }

  if (!isWebUrl(baseUrl) || baseUrl.endsWith(URL_PATH_SEPARATOR)) {
    throw new TypeError(`${SIGNATURE.FACTORY} requires baseUrl to be an http or https URL that does not end with "/", such as config.app.url`);
  }
}

function assertKey(key, signature) {
  if (!isStorageKey(key)) {
    throw new TypeError(`${signature} requires a key made by toStorageKey(extension)`);
  }
}

// The text of an error of fs names the path, and with it the UUID of the file: an alert told by its message would
// never repeat.
function toStorageError(verb, error) {
  return new Error(`Storage failed to ${verb} a file: ${error?.code ?? UNKNOWN_CODE}`, { cause: error });
}

function toFilePath(state, key) {
  return nodePath.join(state.root, key);
}

async function createRoot(state) {
  try {
    await mkdir(state.root, { recursive: true });
  } catch (error) {
    state.rootCreation = null;

    throw error;
  }
}

// One creation for all the puts that wait for it; one that failed is tried again by the next put.
function prepareRoot(state) {
  state.rootCreation ??= createRoot(state);

  return state.rootCreation;
}

// A file the disk filled up under would stay, cut short, under a key nobody holds.
async function writeNewFile(filePath, bytes) {
  const handle = await open(filePath, NEW_FILE_FLAG);

  try {
    await handle.writeFile(bytes);
    await handle.close();
  } catch (error) {
    await Promise.allSettled([handle.close(), unlink(filePath)]);

    throw error;
  }
}

async function runOnFile(verb, action, missingResult) {
  try {
    return await action();
  } catch (error) {
    if (MISSING_CODES.includes(error?.code)) {
      return missingResult;
    }

    throw toStorageError(verb, error);
  }
}

async function put(state, key, bytes) {
  assertKey(key, SIGNATURE.PUT);

  if (!isUint8Array(bytes)) {
    throw new TypeError(`${SIGNATURE.PUT} requires the bytes of the file as a Buffer or a Uint8Array`);
  }

  try {
    await prepareRoot(state);
    await writeNewFile(toFilePath(state, key), bytes);
  } catch (error) {
    throw toStorageError(VERB.WRITE, error);
  }
}

async function get(state, key) {
  assertKey(key, SIGNATURE.GET);

  return runOnFile(VERB.READ, () => readFile(toFilePath(state, key)), null);
}

async function remove(state, key) {
  assertKey(key, SIGNATURE.DELETE);

  return runOnFile(VERB.DELETE, async () => {
    await unlink(toFilePath(state, key));

    return true;
  }, false);
}

async function exists(state, key) {
  assertKey(key, SIGNATURE.EXISTS);

  return runOnFile(VERB.CHECK, async () => {
    await access(toFilePath(state, key));

    return true;
  }, false);
}

function url(state, key) {
  assertKey(key, SIGNATURE.URL);

  return `${state.urlPrefix}${key}`;
}

export function createLocalStorage({ root, publicPath, baseUrl } = {}) {
  assertOptions({ root, publicPath, baseUrl });

  const state = {
    root,
    urlPrefix: `${baseUrl}${publicPath}`,
    rootCreation: null,
  };

  return Object.freeze({
    put: put.bind(null, state),
    get: get.bind(null, state),
    delete: remove.bind(null, state),
    exists: exists.bind(null, state),
    url: url.bind(null, state),
  });
}
