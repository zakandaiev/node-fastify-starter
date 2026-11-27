import { getContext } from '#core/context/index.js';
import { createLocalStorage } from '#core/storage/local.js';
import { isObject, isString } from '#utils/type.js';
import { inspect } from 'node:util';

// A driver makes the adapter { put, get, delete, exists, url } of the storage section and the base URL of the app:
// another backend is one more entry here.
const STORAGE_DRIVERS = Object.freeze({
  local: createLocalStorage,
});

export function createStorage(storageConfig, { baseUrl } = {}) {
  if (!isObject(storageConfig)) {
    throw new TypeError('createStorage(storageConfig, { baseUrl }) requires the storage section of config.upload');
  }

  const { driver } = storageConfig;

  if (!isString(driver) || !Object.hasOwn(STORAGE_DRIVERS, driver)) {
    throw new TypeError(`config.upload.storage requires a driver of ${Object.keys(STORAGE_DRIVERS).join(', ')}: received ${inspect(driver)}`);
  }

  return STORAGE_DRIVERS[driver]({ ...storageConfig, baseUrl });
}

export function getStorage() {
  const { storage } = getContext();

  if (!storage) {
    throw new Error('The context has no storage: build it with createContext({ config, log, storage })');
  }

  return storage;
}
