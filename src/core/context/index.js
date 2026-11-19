import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function createContext({
  config,
  log,
  db = null,
  redis = null,
  cacheRedis = null,
  requestId = null,
  transaction = null,
} = {}) {
  if (!config) {
    throw new TypeError('createContext({ config, log }) requires config');
  }

  if (!log) {
    throw new TypeError('createContext({ config, log }) requires log');
  }

  return Object.freeze({
    config,
    log,
    db,
    redis,
    cacheRedis,
    requestId,
    transaction,
  });
}

export function runInContext(context, fn) {
  if (!context) {
    throw new TypeError('runInContext(context, fn) requires a context');
  }

  if (typeof fn !== 'function') {
    throw new TypeError('runInContext(context, fn) requires a function');
  }

  return storage.run(context, fn);
}

export function getContext() {
  const context = storage.getStore();

  if (!context) {
    throw new Error('No active context: wrap the call in runInContext(context, fn)');
  }

  return context;
}

// For code that also runs where no context is, such as a listener of a socket event: null there.
export function findContext() {
  return storage.getStore() ?? null;
}

// A socket keeps the context it was opened in for every event it ever emits, reconnects included:
// one opened inside a request would hand that request's context to all of them.
export function runOutsideContext(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('runOutsideContext(fn) requires a function');
  }

  return storage.exit(fn);
}
