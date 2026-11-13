import { createContext, getContext, runInContext } from '#core/context/index.js';
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
  });

  test('keeps the services it is given', () => {
    const db = {};
    const redis = {};
    const cacheRedis = {};
    const context = createContext({
      config: {},
      log,
      db,
      redis,
      cacheRedis,
    });

    assert.equal(context.db, db);
    assert.equal(context.redis, redis);
    assert.equal(context.cacheRedis, cacheRedis);
  });
});

describe('getContext', () => {
  test('throws a clear error outside a context', () => {
    assert.throws(() => getContext(), /No active context: wrap the call in runInContext/);
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
