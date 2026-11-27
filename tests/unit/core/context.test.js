import {
  createContext,
  findContext,
  getContext,
  runInContext,
  runOutsideContext,
} from '#core/context/index.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const log = Object.freeze({});

describe('createContext', () => {
  test('requires config and log', () => {
    assert.throws(() => createContext(), /requires config/);
    assert.throws(() => createContext({ log }), /requires config/);
    assert.throws(() => createContext({ config: {} }), /requires log/);
  });

  test('returns a frozen context; services that are not there yet are null', () => {
    const config = {};
    const context = createContext({ config, log });

    assert.ok(Object.isFrozen(context));
    assert.equal(context.config, config);
    assert.equal(context.log, log);
    assert.equal(context.db, null);
    assert.equal(context.redis, null);
    assert.equal(context.cacheRedis, null);
    assert.equal(context.jwt, null);
    assert.equal(context.storage, null);
    assert.equal(context.requestId, null);
    assert.equal(context.transaction, null);
  });

  test('keeps the transaction it is created inside', () => {
    const transaction = {};
    const context = createContext({ config: {}, log, transaction });

    assert.equal(context.transaction, transaction);
  });

  test('keeps the id of the request it is created for', () => {
    const context = createContext({ config: {}, log, requestId: '019a0000-0000-7000-8000-000000000000' });

    assert.equal(context.requestId, '019a0000-0000-7000-8000-000000000000');
  });

  test('keeps the services it is given', () => {
    const db = {};
    const redis = {};
    const cacheRedis = {};
    const jwt = {};
    const storage = {};
    const context = createContext({
      config: {},
      log,
      db,
      redis,
      cacheRedis,
      jwt,
      storage,
    });

    assert.equal(context.db, db);
    assert.equal(context.redis, redis);
    assert.equal(context.cacheRedis, cacheRedis);
    assert.equal(context.jwt, jwt);
    assert.equal(context.storage, storage);
  });

  test('keeps the services of the context it is made from: a plugin adds its own to those before it', () => {
    const storage = {};
    const app = createContext({ config: {}, log, storage });
    const request = createContext({ ...app, requestId: '019a0000-0000-7000-8000-000000000000' });

    assert.equal(request.storage, storage);
    assert.equal(request.config, app.config);
    assert.equal(createContext({ ...request, transaction: {} }).storage, storage);
  });
});

describe('getContext', () => {
  test('throws a clear error outside a context', () => {
    assert.throws(() => getContext(), /No active context: wrap the call in runInContext/);
  });
});

describe('findContext', () => {
  test('gives the current context, or null outside one, without throwing', () => {
    const context = createContext({ config: {}, log });

    assert.equal(findContext(), null);
    assert.equal(runInContext(context, () => findContext()), context);
  });
});

describe('runOutsideContext', () => {
  test('runs the function with no context, and what it starts stays without one', async () => {
    const context = createContext({ config: {}, log });
    const { promise, resolve } = Promise.withResolvers();

    const result = runInContext(context, () => runOutsideContext(() => {
      setTimeout(() => resolve(findContext()), 1);

      return findContext();
    }));

    assert.equal(result, null);
    assert.equal(await promise, null);
    assert.throws(() => runOutsideContext('fn'), /requires a function/);
  });
});

describe('runInContext', () => {
  test('requires a context and a function', () => {
    const context = createContext({ config: {}, log });

    assert.throws(() => runInContext(null, () => {}), /requires a context/);
    assert.throws(() => runInContext(context), /requires a function/);
  });

  test('returns the result of the function', async () => {
    const context = createContext({ config: {}, log });

    assert.equal(runInContext(context, () => 'sync'), 'sync');
    assert.equal(await runInContext(context, async () => 'async'), 'async');
  });

  test('exposes the context to the whole async chain and removes it afterwards', async () => {
    const context = createContext({ config: {}, log });

    await runInContext(context, async () => {
      assert.equal(getContext(), context);
      await sleep(1);
      assert.equal(getContext(), context);
      await Promise.all([1, 2].map(async () => assert.equal(getContext(), context)));
    });

    assert.throws(() => getContext(), /No active context/);
  });

  test('keeps parallel contexts apart', async () => {
    const first = createContext({ config: { name: 'first' }, log });
    const second = createContext({ config: { name: 'second' }, log });

    async function readName(delay) {
      await sleep(delay);

      return getContext().config.name;
    }

    const names = await Promise.all([
      runInContext(first, () => readName(5)),
      runInContext(second, () => readName(1)),
    ]);

    assert.deepEqual(names, ['first', 'second']);
  });

  test('restores the outer context after a nested one', () => {
    const outer = createContext({ config: { name: 'outer' }, log });
    const inner = createContext({ config: { name: 'inner' }, log });

    runInContext(outer, () => {
      runInContext(inner, () => assert.equal(getContext(), inner));

      assert.equal(getContext(), outer);
    });
  });
});
