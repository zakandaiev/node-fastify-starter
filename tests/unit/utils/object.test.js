import {
  compact,
  deepMerge,
  diff,
  freezeDeep,
  getPath,
  mapKeys,
  mapValues,
  omit,
  pick,
} from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

class Sample {
  constructor() {
    this.settings = { isActive: true };
  }
}

const PROTOTYPE_KEYS = Reflect.ownKeys(Object.prototype);

const POLLUTED_JSON = [
  '{"__proto__":{"isAdmin":true}}',
  '{"constructor":{"prototype":{"isAdmin":true}}}',
  '{"prototype":{"isAdmin":true}}',
];

const NOT_PLAIN_OBJECTS = [null, undefined, 'text', 5, true, [], new Date(0), new Map(), new Sample(), () => {}];
const NOT_KEY_LISTS = [undefined, null, 'id', { 0: 'id' }, new Set(['id']), [undefined], [null], [{}], [['id']], [Symbol('id')], [Number.NaN]];

function assertPrototypeUntouched() {
  assert.equal({}.isAdmin, undefined);
  assert.deepEqual(Reflect.ownKeys(Object.prototype), PROTOTYPE_KEYS);
}

function readOwnValue(object, key) {
  return Object.getOwnPropertyDescriptor(object, key)?.value;
}

function nestObjects(levels, leaf = {}) {
  return Array.from({ length: levels - 1 }).reduce((inner) => ({ child: inner }), leaf);
}

function nestArrays(levels) {
  return Array.from({ length: levels - 1 }).reduce((inner) => [inner], []);
}

describe('pick', () => {
  test('returns a new object with those of the listed keys that the source owns', () => {
    const user = { id: 1, email: 'anna@example.com', role: 'admin' };

    assert.deepEqual(pick(user, ['id', 'role']), { id: 1, role: 'admin' });
    assert.deepEqual(pick(user, ['id', 'missing']), { id: 1 });
    assert.deepEqual(pick(user, ['id', 'id']), { id: 1 });
    assert.deepEqual(pick(user, []), {});
    assert.deepEqual(pick({}, ['id']), {});
  });

  test('reads a dictionary built on a prototype without a prototype, as request.query of Fastify is', () => {
    const query = Object.assign(Object.create(Object.create(null)), { limit: '5', offset: '10', token: 'abc' });

    assert.deepEqual(pick(query, ['limit', 'offset']), { limit: '5', offset: '10' });
    assert.equal(getPath(query, ['limit']), '5');
    assert.equal(getPath(query, 'offset'), '10');
  });

  test('keeps a listed key whatever its value is', () => {
    const source = {
      a: undefined,
      b: null,
      c: 0,
      d: '',
      e: false,
    };
    const result = pick(source, ['a', 'b', 'c', 'd', 'e']);

    assert.deepEqual(result, source);
    assert.ok(Object.hasOwn(result, 'a'));
  });

  test('is shallow and does not mutate the source', () => {
    const settings = { theme: 'dark' };
    const source = Object.freeze({ id: 1, settings });
    const result = pick(source, ['id', 'settings']);

    assert.notEqual(result, source);
    assert.equal(result.settings, settings);
    assert.deepEqual(source, { id: 1, settings: { theme: 'dark' } });
  });

  test('never reads an inherited key', () => {
    const inherited = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];

    assert.deepEqual(pick({}, inherited), {});
    assert.deepEqual(pick({ id: 1 }, ['id', ...inherited]), { id: 1 });
    assertPrototypeUntouched();
  });

  test('keeps "__proto__", "constructor" and "prototype" as plain own keys and leaves every prototype alone', () => {
    POLLUTED_JSON.forEach((json) => {
      const source = JSON.parse(json);
      const result = pick(source, Object.keys(source));

      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      assert.deepEqual(Object.keys(result), Object.keys(source));
      assert.equal(result.isAdmin, undefined);
      assertPrototypeUntouched();
    });

    assert.deepEqual(readOwnValue(pick(JSON.parse(POLLUTED_JSON[0]), ['__proto__']), '__proto__'), { isAdmin: true });
  });

  test('accepts a source without a prototype and a numeric key', () => {
    const source = Object.assign(Object.create(null), { 1: 'one', 2: 'two', name: 'Anna' });
    const result = pick(source, [1, 'name']);

    assert.deepEqual(result, { 1: 'one', name: 'Anna' });
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
  });

  test('rejects a source that is not a plain object', () => {
    NOT_PLAIN_OBJECTS.forEach((source) => {
      assert.throws(() => pick(source, ['id']), { name: 'TypeError', message: /^pick\(object, keys\) requires/ });
    });
  });

  test('rejects keys that are not an array of strings or numbers', () => {
    NOT_KEY_LISTS.forEach((keys) => {
      assert.throws(() => pick({ id: 1 }, keys), { name: 'TypeError', message: /^pick\(object, keys\) requires/ });
    });
  });
});

describe('omit', () => {
  test('returns a new object without the listed keys', () => {
    const user = { id: 1, email: 'anna@example.com', passwordHash: 'hash' };

    assert.deepEqual(omit(user, ['passwordHash']), { id: 1, email: 'anna@example.com' });
    assert.deepEqual(omit(user, ['id', 'email', 'passwordHash']), {});
    assert.deepEqual(omit(user, ['missing']), user);
    assert.deepEqual(omit({}, ['id']), {});
  });

  test('returns a shallow copy for an empty list of keys', () => {
    const settings = { theme: 'dark' };
    const source = { id: 1, settings, note: undefined };
    const result = omit(source, []);

    assert.notEqual(result, source);
    assert.deepEqual(result, source);
    assert.equal(result.settings, settings);
  });

  test('does not mutate the source', () => {
    const source = Object.freeze({ id: 1, role: 'admin' });

    assert.deepEqual(omit(source, ['role']), { id: 1 });
    assert.deepEqual(source, { id: 1, role: 'admin' });
  });

  test('treats a numeric key as its string form', () => {
    assert.deepEqual(omit({ 1: 'one', 2: 'two' }, [1]), { 2: 'two' });
    assert.deepEqual(omit({ 1: 'one', 2: 'two' }, ['2']), { 1: 'one' });
  });

  test('keeps "__proto__", "constructor" and "prototype" as plain own keys unless they are listed', () => {
    POLLUTED_JSON.forEach((json) => {
      const source = JSON.parse(json);
      const kept = omit(source, []);
      const dropped = omit(source, Object.keys(source));

      assert.equal(Object.getPrototypeOf(kept), Object.prototype);
      assert.deepEqual(Object.keys(kept), Object.keys(source));
      assert.equal(kept.isAdmin, undefined);
      assert.equal(Object.getPrototypeOf(dropped), Object.prototype);
      assert.deepEqual(Object.keys(dropped), []);
      assertPrototypeUntouched();
    });

    assert.deepEqual(readOwnValue(omit(JSON.parse(POLLUTED_JSON[0]), []), '__proto__'), { isAdmin: true });
  });

  test('accepts a source without a prototype and returns a plain object', () => {
    const result = omit(Object.assign(Object.create(null), { id: 1, role: 'admin' }), ['role']);

    assert.deepEqual(result, { id: 1 });
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
  });

  test('rejects a source that is not a plain object', () => {
    NOT_PLAIN_OBJECTS.forEach((source) => {
      assert.throws(() => omit(source, ['id']), { name: 'TypeError', message: /^omit\(object, keys\) requires/ });
    });
  });

  test('rejects keys that are not an array of strings or numbers: an undefined key would keep the field it was meant to drop', () => {
    NOT_KEY_LISTS.forEach((keys) => {
      assert.throws(() => omit({ id: 1 }, keys), { name: 'TypeError', message: /^omit\(object, keys\) requires/ });
    });
  });
});

describe('deepMerge', () => {
  test('merges plain objects recursively, the later source wins', () => {
    const defaults = { server: { host: 'localhost', port: 3000, tls: { isEnabled: false } }, name: 'app' };
    const overrides = { server: { port: 8080, tls: { isEnabled: true, file: 'cert.pem' } } };
    const last = { server: { host: 'example.com' }, mode: 'prod' };

    assert.deepEqual(deepMerge(defaults, overrides, last), {
      server: { host: 'example.com', port: 8080, tls: { isEnabled: true, file: 'cert.pem' } },
      name: 'app',
      mode: 'prod',
    });
  });

  test('replaces an array and any other value instead of merging it', () => {
    assert.deepEqual(deepMerge({ tags: ['a', 'b'] }, { tags: ['c'] }), { tags: ['c'] });
    assert.deepEqual(deepMerge({ value: { nested: 1 } }, { value: [1] }), { value: [1] });
    assert.deepEqual(deepMerge({ value: [1] }, { value: { nested: 1 } }), { value: { nested: 1 } });
    assert.deepEqual(deepMerge({ value: { nested: 1 } }, { value: 'text' }), { value: 'text' });
    assert.deepEqual(deepMerge({ value: { nested: 1 } }, { value: null }), { value: null });
    assert.deepEqual(deepMerge({ value: 1 }, { value: 0 }), { value: 0 });
  });

  test('never writes undefined: it does not override and is not copied', () => {
    assert.deepEqual(
      deepMerge({ a: 1, nested: { b: 2 } }, { a: undefined, nested: { b: undefined } }),
      { a: 1, nested: { b: 2 } },
    );
    assert.deepEqual(Object.keys(deepMerge({ a: undefined }, { b: undefined })), []);
    assert.deepEqual(deepMerge({}, { list: [undefined, 1] }), { list: [undefined, 1] });
  });

  test('returns a new object and leaves the inputs untouched', () => {
    const target = freezeDeep({ nested: { list: [1, { isDeep: true }] }, kept: { a: 1 } });
    const source = freezeDeep({ nested: { extra: { b: 2 } }, items: [{ id: 1 }, [2]] });
    const result = deepMerge(target, source);

    assert.notEqual(result, target);
    assert.deepEqual(result, {
      nested: { list: [1, { isDeep: true }], extra: { b: 2 } },
      kept: { a: 1 },
      items: [{ id: 1 }, [2]],
    });
    assert.deepEqual(target, { nested: { list: [1, { isDeep: true }] }, kept: { a: 1 } });
    assert.deepEqual(source, { nested: { extra: { b: 2 } }, items: [{ id: 1 }, [2]] });
  });

  test('shares no plain object or array with its inputs: a change of the result does not leak', () => {
    const target = { nested: { list: [1, { isDeep: true }] }, kept: { a: 1 } };
    const source = { nested: { extra: { b: 2 } }, items: [{ id: 1 }, [2]] };
    const snapshot = structuredClone([target, source]);
    const result = deepMerge(target, source);

    result.nested.list[1].isDeep = false;
    result.nested.list.push(3);
    result.nested.extra.b = 3;
    result.kept.a = 2;
    result.items[0].id = 2;
    result.items[1].push(3);

    assert.deepEqual([target, source], snapshot);
    assert.notEqual(result.kept, target.kept);
    assert.notEqual(result.nested.list, target.nested.list);
    assert.notEqual(result.items, source.items);
  });

  test('copies a plain target deeply when there are no sources', () => {
    const target = { list: [{ id: 1 }], nested: { a: 1 } };
    const result = deepMerge(target);

    assert.deepEqual(result, target);
    assert.notEqual(result, target);
    assert.notEqual(result.list[0], target.list[0]);
    assert.notEqual(result.nested, target.nested);
  });

  test('keeps a value that is neither a plain object nor an array by reference', () => {
    const date = new Date(0);
    const map = new Map([['key', {}]]);
    const sample = new Sample();
    const buffer = Buffer.from('ab');
    const result = deepMerge({ date: {}, sample: { settings: {} } }, {
      date,
      map,
      sample,
      list: [buffer],
    });

    assert.equal(result.date, date);
    assert.equal(result.map, map);
    assert.equal(result.sample, sample);
    assert.equal(result.list[0], buffer);
  });

  test('skips "__proto__", "constructor" and "prototype" at every level, in a source and in the target', () => {
    POLLUTED_JSON.forEach((json) => {
      const nested = `{"safe":1,"nested":${json},"list":[${json}]}`;

      [deepMerge({}, JSON.parse(json)), deepMerge(JSON.parse(json))].forEach((result) => {
        assert.deepEqual(Object.keys(result), []);
        assert.equal(Object.getPrototypeOf(result), Object.prototype);
        assert.equal(result.isAdmin, undefined);
      });

      [deepMerge({ nested: {} }, JSON.parse(nested)), deepMerge(JSON.parse(nested), {})].forEach((result) => {
        assert.deepEqual(result, { safe: 1, nested: {}, list: [{}] });
        assert.equal(result.nested.isAdmin, undefined);
        assert.equal(result.list[0].isAdmin, undefined);
      });

      assertPrototypeUntouched();
    });
  });

  test('treats any other inherited name as an ordinary key', () => {
    const result = deepMerge(JSON.parse('{"toString":{"a":1}}'), JSON.parse('{"toString":{"b":2},"valueOf":3}'));

    assert.deepEqual(readOwnValue(result, 'toString'), { a: 1, b: 2 });
    assert.equal(readOwnValue(result, 'valueOf'), 3);
    assertPrototypeUntouched();
  });

  test('neither reads nor assigns through the prototype: a read-only inherited property, as on a frozen Object.prototype, changes nothing', () => {
    // eslint-disable-next-line no-extend-native -- an inherited read-only property is the case under test
    Object.defineProperty(Object.prototype, 'locked', { value: { isInherited: true }, writable: false, configurable: true });

    try {
      assert.deepEqual(deepMerge({}, { locked: { a: 1 } }, { locked: { b: 2 }, list: [{ locked: 3 }] }), {
        locked: { a: 1, b: 2 },
        list: [{ locked: 3 }],
      });
    } finally {
      delete Object.prototype.locked;
    }

    assertPrototypeUntouched();
  });

  test('throws a TypeError on a circular target or source instead of overflowing the stack', () => {
    const circular = { name: 'loop' };
    circular.self = circular;

    const list = [];
    list.push(list);

    const parent = { child: {} };
    parent.child.parent = parent;

    [
      () => deepMerge({}, circular),
      () => deepMerge(circular, {}),
      () => deepMerge({}, { list }),
      () => deepMerge({}, { parent }),
    ].forEach((merge) => {
      assert.throws(merge, { name: 'TypeError', message: /circular/ });
    });
  });

  test('accepts a value shared by several keys: it is not a cycle', () => {
    const shared = { id: 1 };
    const sharedList = [shared, shared];
    const result = deepMerge({}, {
      first: shared,
      second: shared,
      list: sharedList,
      copy: sharedList,
    });

    assert.deepEqual(result, {
      first: { id: 1 },
      second: { id: 1 },
      list: [{ id: 1 }, { id: 1 }],
      copy: [{ id: 1 }, { id: 1 }],
    });
    assert.notEqual(result.first, result.second);
    assert.notEqual(result.list, result.copy);
    assert.notEqual(result.list[0], result.list[1]);
    assert.deepEqual(deepMerge(shared, shared), { id: 1 });
  });

  test('accepts 100 levels of nesting', () => {
    assert.deepEqual(deepMerge(nestObjects(100)), nestObjects(100));
    assert.deepEqual(deepMerge({}, { list: nestArrays(99) }), { list: nestArrays(99) });
  });

  test('throws a RangeError on deeper nesting instead of overflowing the stack', () => {
    [nestObjects(101), { list: nestArrays(100) }, nestObjects(50000)].forEach((source) => {
      assert.throws(() => deepMerge({}, source), { name: 'RangeError', message: /at most 100 levels/ });
      assert.throws(() => deepMerge(source), { name: 'RangeError', message: /at most 100 levels/ });
    });
  });

  test('rejects a target or a source that is not a plain object', () => {
    NOT_PLAIN_OBJECTS.forEach((value) => {
      assert.throws(() => deepMerge(value), TypeError);
      assert.throws(() => deepMerge({}, value), TypeError);
      assert.throws(() => deepMerge({}, {}, value), TypeError);
    });

    assert.throws(() => deepMerge(), { name: 'TypeError', message: /^deepMerge\(target, \.\.\.sources\) requires/ });
  });
});

describe('compact', () => {
  test('removes the keys of a plain object whose value is null or undefined', () => {
    assert.deepEqual(compact({
      a: 1,
      b: null,
      c: undefined,
      d: 'text',
    }), { a: 1, d: 'text' });
    assert.deepEqual(compact({ a: null }), {});
    assert.deepEqual(compact({}), {});
  });

  test('removes null and undefined items of an array, holes included', () => {
    const sparse = new Array(3);
    sparse[1] = 'b';

    assert.deepEqual(compact([1, null, 2, undefined, 3]), [1, 2, 3]);
    assert.deepEqual(compact(sparse), ['b']);
    assert.deepEqual(compact([null]), []);
    assert.deepEqual(compact([]), []);
  });

  test('keeps 0, an empty string, false and NaN', () => {
    const values = [0, '', false, Number.NaN];

    assert.deepEqual(compact(values), values);
    assert.deepEqual(compact({ ...values }), { ...values });
  });

  test('is shallow: a nested null stays and a nested value keeps its identity', () => {
    const nested = { a: null };

    assert.equal(compact({ nested }).nested, nested);
    assert.deepEqual(compact([[null], { a: undefined }]), [[null], { a: undefined }]);
  });

  test('returns a new value and does not mutate the given one', () => {
    const object = Object.freeze({ a: 1, b: null });
    const list = Object.freeze([1, null]);
    const full = Object.freeze({ a: 1 });

    assert.deepEqual(compact(object), { a: 1 });
    assert.deepEqual(compact(list), [1]);
    assert.notEqual(compact(full), full);
    assert.deepEqual(object, { a: 1, b: null });
    assert.deepEqual(list, [1, null]);
  });

  test('accepts an object without a prototype and keeps "__proto__" as a plain own key', () => {
    const result = compact(JSON.parse('{"__proto__":{"isAdmin":true},"empty":null}'));

    assert.deepEqual(compact(Object.assign(Object.create(null), { a: 1, b: null })), { a: 1 });
    assert.deepEqual(Object.keys(result), ['__proto__']);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.isAdmin, undefined);
    assertPrototypeUntouched();
  });

  test('rejects what is neither a plain object nor an array', () => {
    [null, undefined, 'text', 5, true, new Date(0), new Map(), new Set([1]), new Sample(), () => {}].forEach((value) => {
      assert.throws(() => compact(value), { name: 'TypeError', message: /^compact\(value\) requires/ });
    });
  });
});

describe('getPath', () => {
  const data = {
    user: {
      name: 'Anna',
      roles: [{ name: 'admin' }, { name: 'editor' }],
      'first.name': 'Hanna',
      note: null,
      nickname: undefined,
      loginCount: 0,
      bio: '',
      isBlocked: false,
    },
    text: 'abc',
    createdAt: new Date(0),
    sample: new Sample(),
    index: new Map([['key', 1]]),
    handler() {},
  };

  test('reads a nested value by a dotted path', () => {
    assert.equal(getPath(data, 'user.name'), 'Anna');
    assert.equal(getPath(data, 'user'), data.user);
    assert.equal(getPath(data, 'createdAt'), data.createdAt);
    assert.equal(getPath(data, 'sample'), data.sample);
  });

  test('reads an item of an array by its index', () => {
    assert.equal(getPath(data, 'user.roles.0.name'), 'admin');
    assert.equal(getPath(data, 'user.roles.1'), data.user.roles[1]);
    assert.equal(getPath(['a', ['b', 'c']], '1.0'), 'b');
  });

  test('accepts an array of keys, so a key may contain a dot', () => {
    assert.equal(getPath(data, ['user', 'roles', 1, 'name']), 'editor');
    assert.equal(getPath(data, ['user', 'roles', '1', 'name']), 'editor');
    assert.equal(getPath(data, ['user', 'first.name']), 'Hanna');
    assert.equal(getPath(data, 'user.first.name', 'fallback'), 'fallback');
    assert.equal(getPath({ 1: { 2: 'value' } }, [1, 2]), 'value');
  });

  test('returns the object itself for an empty path', () => {
    assert.equal(getPath(data, ''), data);
    assert.equal(getPath(data, []), data);
    assert.equal(getPath('text', ''), 'text');
    assert.equal(getPath(null, ''), null);
  });

  test('returns the default value for a missing step, undefined when it is not given', () => {
    assert.equal(getPath(data, 'user.missing'), undefined);
    assert.equal(getPath(data, 'user.missing', 'fallback'), 'fallback');
    assert.equal(getPath(data, 'missing.deeper.still', 0), 0);
    assert.equal(getPath(data, 'user.roles.5.name', null), null);
    assert.equal(getPath(data, 'user..name', 'fallback'), 'fallback');
    assert.equal(getPath(undefined, 'user', 'fallback'), 'fallback');
    assert.equal(getPath(null, 'user', 'fallback'), 'fallback');
  });

  test('returns the default value for a key that holds undefined and keeps null and falsy values', () => {
    assert.equal(getPath(data, 'user.nickname', 'fallback'), 'fallback');
    assert.equal(getPath(undefined, '', 'fallback'), 'fallback');
    assert.equal(getPath(data, 'user.note', 'fallback'), null);
    assert.equal(getPath(data, 'user.loginCount', 'fallback'), 0);
    assert.equal(getPath(data, 'user.bio', 'fallback'), '');
    assert.equal(getPath(data, 'user.isBlocked', 'fallback'), false);
  });

  test('never reads an inherited property', () => {
    [
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
      'user.constructor',
      'user.__proto__',
      'user.roles.constructor',
      'user.roles.map',
      'user.roles.constructor.constructor',
      '__proto__.isAdmin',
      'constructor.prototype.isAdmin',
    ].forEach((path) => {
      assert.equal(getPath(data, path, 'fallback'), 'fallback', path);
      assert.equal(getPath(data, path.split('.'), 'fallback'), 'fallback', path);
    });

    assert.equal(getPath(Object.setPrototypeOf(['a'], { 1: 'inherited' }), '1', 'fallback'), 'fallback');
    assertPrototypeUntouched();
  });

  test('does not walk through a value that is neither a plain object nor an array', () => {
    [
      'text.length',
      'text.0',
      'createdAt.getTime',
      'sample.settings',
      'index.size',
      'handler.name',
      'user.name.length',
      'user.loginCount.toFixed',
      'user.note.anything',
    ].forEach((path) => {
      assert.equal(getPath(data, path, 'fallback'), 'fallback', path);
    });
  });

  test('reads an existing item of an array only: no length, no hole and no index in another notation', () => {
    const list = ['a', 'b', 'c'];
    const sparse = new Array(3);
    sparse[2] = 'c';

    ['length', '3', '-1', '01', ' 1', '1e0', '+1', '0x1'].forEach((path) => {
      assert.equal(getPath(list, path, 'fallback'), 'fallback', path);
    });

    [[-1], [1.5], ['1.5'], ['length'], [3]].forEach((path) => {
      assert.equal(getPath(list, path, 'fallback'), 'fallback');
    });

    assert.equal(getPath(list, [2]), 'c');
    assert.equal(getPath(sparse, '0', 'fallback'), 'fallback');
    assert.equal(getPath(sparse, '2', 'fallback'), 'c');
  });

  test('does not take another own property of an array for an item', () => {
    const match = 'ab'.match(/(?<first>a)/);
    const labelled = Object.assign(['a'], { '01': 'padded', '-1': 'negative', 1.5: 'fraction' });

    assert.equal(getPath(match, '0'), 'a');
    assert.equal(getPath(match, 'index', 'fallback'), 'fallback');
    assert.equal(getPath(match, 'groups.first', 'fallback'), 'fallback');

    ['01', '-1', ['1.5'], [-1], [1.5]].forEach((path) => {
      assert.equal(getPath(labelled, path, 'fallback'), 'fallback');
    });
  });

  test('reads own keys "__proto__", "constructor" and "prototype" as data and leaves every prototype alone', () => {
    assert.equal(getPath(JSON.parse(POLLUTED_JSON[0]), '__proto__.isAdmin'), true);
    assert.equal(getPath(JSON.parse(POLLUTED_JSON[1]), 'constructor.prototype.isAdmin'), true);
    assert.equal(getPath(JSON.parse(POLLUTED_JSON[2]), 'prototype.isAdmin'), true);
    assert.equal(getPath({}, '__proto__.isAdmin', 'fallback'), 'fallback');
    assertPrototypeUntouched();
  });

  test('accepts an object without a prototype', () => {
    assert.equal(getPath(Object.assign(Object.create(null), { a: { b: 1 } }), 'a.b'), 1);
  });

  test('walks a path of 20000 steps without recursion', () => {
    const keys = Array.from({ length: 20000 }, () => 'next');
    const deep = keys.reduce((inner) => ({ next: inner }), 'leaf');

    assert.equal(getPath(deep, keys), 'leaf');
    assert.equal(getPath(deep, keys.join('.')), 'leaf');
  });

  test('rejects a path that is neither a string nor an array of strings or numbers', () => {
    [undefined, null, 5, {}, new Set(['user']), [undefined], [null], [{}], [['user']], [Symbol('user')], [Number.NaN]].forEach((path) => {
      assert.throws(() => getPath(data, path), { name: 'TypeError', message: /^getPath\(object, path, defaultValue\) requires/ });
    });
  });
});

describe('freezeDeep', () => {
  test('freezes plain objects and arrays at every level and returns the same reference', () => {
    const config = { server: { ports: [80, { tls: 443 }] }, tags: [['a']], empty: {} };
    const result = freezeDeep(config);

    assert.equal(result, config);

    [config, config.server, config.server.ports, config.server.ports[1], config.tags, config.tags[0], config.empty].forEach((value) => {
      assert.ok(Object.isFrozen(value));
    });
  });

  test('makes a write to any level throw', () => {
    const config = freezeDeep({ server: { ports: [80] } });

    assert.throws(() => {
      config.server.host = 'example.com';
    }, TypeError);
    assert.throws(() => {
      config.server.ports.push(443);
    }, TypeError);
    assert.throws(() => {
      delete config.server;
    }, TypeError);
    assert.deepEqual(config, { server: { ports: [80] } });
  });

  test('survives a cyclic structure', () => {
    const node = { children: [] };
    node.children.push(node);
    node.self = node;

    assert.equal(freezeDeep(node), node);
    assert.ok(Object.isFrozen(node));
    assert.ok(Object.isFrozen(node.children));
  });

  test('leaves a Buffer and a Date as they are: freezing a Buffer would throw', () => {
    const buffer = Buffer.from('ab');
    const date = new Date(0);
    const config = freezeDeep({ payload: buffer, startedAt: date, list: [buffer, date] });

    buffer[0] = 0x7a;
    date.setTime(1000);

    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.list));
    assert.equal(Object.isFrozen(buffer), false);
    assert.equal(Object.isFrozen(date), false);
    assert.equal(buffer.toString(), 'zb');
    assert.equal(date.getTime(), 1000);
    assert.equal(freezeDeep(buffer), buffer);
    assert.equal(freezeDeep(date), date);
  });

  test('leaves a Map, a class instance and a function as they are and does not look inside them', () => {
    const map = new Map([['key', { isInner: true }]]);
    const sample = new Sample();
    const handler = () => {};
    handler.options = { isInner: true };

    freezeDeep({ map, sample, handler });

    [map, map.get('key'), sample, sample.settings, handler, handler.options].forEach((value) => {
      assert.equal(Object.isFrozen(value), false);
    });
  });

  test('returns a primitive as is', () => {
    [null, undefined, 0, 'text', true, 10n, Symbol('sample')].forEach((value) => {
      assert.equal(freezeDeep(value), value);
    });
  });

  test('freezes the children of an object that is already frozen at the top', () => {
    const config = Object.freeze({ nested: { list: [] } });

    freezeDeep(config);

    assert.ok(Object.isFrozen(config.nested));
    assert.ok(Object.isFrozen(config.nested.list));
  });

  test('freezes what hides behind a symbol key or a non-enumerable property', () => {
    const key = Symbol('hidden');
    const config = { [key]: { a: 1 } };
    Object.defineProperty(config, 'internal', { value: { b: 2 }, enumerable: false });

    freezeDeep(config);

    assert.ok(Object.isFrozen(config[key]));
    assert.ok(Object.isFrozen(config.internal));
  });

  test('freezes an object without a prototype', () => {
    const config = Object.assign(Object.create(null), { nested: Object.assign(Object.create(null), { a: 1 }) });

    freezeDeep(config);

    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.nested));
  });

  test('freezes 100000 levels of nesting without recursion', () => {
    const leaf = {};
    const deep = nestObjects(100000, leaf);

    freezeDeep(deep);

    assert.ok(Object.isFrozen(deep));
    assert.ok(Object.isFrozen(leaf));
  });
});

describe('diff', () => {
  test('returns { from, to } for every key whose value differs', () => {
    const before = {
      firstName: 'Anna',
      lastName: null,
      email: 'anna@example.com',
      status: 'active',
    };
    const after = {
      firstName: 'Hanna',
      lastName: 'Kovalenko',
      email: 'anna@example.com',
      status: 'active',
    };

    assert.deepEqual(diff(before, after), {
      firstName: { from: 'Anna', to: 'Hanna' },
      lastName: { from: null, to: 'Kovalenko' },
    });
  });

  test('returns an empty object when nothing differs', () => {
    assert.deepEqual(diff({}, {}), {});
    assert.deepEqual(diff({ id: 1, tags: ['a'] }, { tags: ['a'], id: 1 }), {});
  });

  test('gives undefined to the side that has no such key', () => {
    assert.deepEqual(diff({ removed: 1 }, { added: 2 }), {
      removed: { from: 1, to: undefined },
      added: { from: undefined, to: 2 },
    });
    assert.deepEqual(diff({ value: null }, {}), { value: { from: null, to: undefined } });
    assert.deepEqual(diff({ value: undefined }, {}), {});
  });

  test('compares the values deeply and strictly', () => {
    const before = {
      groups: [{ slug: 'support' }],
      expiresAt: new Date(0),
      ratio: Number.NaN,
      count: 1,
      channels: ['web'],
      startedAt: new Date(0),
    };
    const after = {
      groups: [{ slug: 'support' }],
      expiresAt: new Date(0),
      ratio: Number.NaN,
      count: '1',
      channels: ['web', 'telegram'],
      startedAt: new Date(1000),
    };

    assert.deepEqual(diff(before, after), {
      count: { from: 1, to: '1' },
      channels: { from: ['web'], to: ['web', 'telegram'] },
      startedAt: { from: new Date(0), to: new Date(1000) },
    });
  });

  test('is shallow over keys: a nested change reports the whole values, the given ones', () => {
    const before = { profile: { name: 'Anna', city: 'Kyiv' } };
    const after = { profile: { name: 'Anna', city: 'Lviv' } };
    const changes = diff(before, after);

    assert.deepEqual(changes, {
      profile: { from: { name: 'Anna', city: 'Kyiv' }, to: { name: 'Anna', city: 'Lviv' } },
    });
    assert.equal(changes.profile.from, before.profile);
    assert.equal(changes.profile.to, after.profile);
  });

  test('reads own values only: an inherited name is not a previous value', () => {
    const changes = diff({}, JSON.parse('{"constructor":1,"toString":2,"hasOwnProperty":3}'));

    assert.deepEqual(Object.entries(changes), [
      ['constructor', { from: undefined, to: 1 }],
      ['toString', { from: undefined, to: 2 }],
      ['hasOwnProperty', { from: undefined, to: 3 }],
    ]);
  });

  test('keeps "__proto__", "constructor" and "prototype" as plain own keys of the result and leaves every prototype alone', () => {
    POLLUTED_JSON.forEach((json) => {
      const keys = Object.keys(JSON.parse(json));

      [
        diff(JSON.parse(json), {}),
        diff({}, JSON.parse(json)),
        diff(JSON.parse(json), JSON.parse(json.replace('true', 'false'))),
      ].forEach((changes) => {
        assert.equal(Object.getPrototypeOf(changes), Object.prototype);
        assert.deepEqual(Object.keys(changes), keys);
        assert.equal(changes.isAdmin, undefined);
        assertPrototypeUntouched();
      });
    });

    assert.deepEqual(
      readOwnValue(diff({}, JSON.parse(POLLUTED_JSON[0])), '__proto__'),
      { from: undefined, to: { isAdmin: true } },
    );
  });

  test('accepts objects without a prototype', () => {
    const before = Object.assign(Object.create(null), { a: 1, b: 2 });

    assert.deepEqual(diff(before, { a: 1, b: 3 }), { b: { from: 2, to: 3 } });
  });

  test('does not mutate its arguments', () => {
    const before = freezeDeep({ tags: ['a'], profile: { city: 'Kyiv' } });
    const after = freezeDeep({ tags: ['b'], profile: { city: 'Kyiv' } });

    assert.deepEqual(diff(before, after), { tags: { from: ['a'], to: ['b'] } });
    assert.deepEqual(before, { tags: ['a'], profile: { city: 'Kyiv' } });
  });

  test('rejects an argument that is not a plain object', () => {
    NOT_PLAIN_OBJECTS.forEach((value) => {
      assert.throws(() => diff(value, {}), { name: 'TypeError', message: /^diff\(before, after\) requires/ });
      assert.throws(() => diff({}, value), TypeError);
    });
  });
});

describe('mapKeys', () => {
  test('renames every key and keeps the values, in a map without a prototype', () => {
    const mapped = mapKeys({ 'Content-Type': 'text/plain', Accept: 'application/json' }, (key) => key.toLowerCase());

    assert.deepEqual({ ...mapped }, { 'content-type': 'text/plain', accept: 'application/json' });
    assert.equal(Object.getPrototypeOf(mapped), null);
  });

  test('gives two keys that map to one the value of the later', () => {
    assert.deepEqual({ ...mapKeys({ Accept: 'a', accept: 'b' }, (key) => key.toLowerCase()) }, { accept: 'b' });
  });

  test('requires a plain object and a function', () => {
    assert.throws(() => mapKeys([], String), { name: 'TypeError', message: 'mapKeys(object, toKey) requires a plain object and a function' });
    assert.throws(() => mapKeys({}, 'lower'), { name: 'TypeError' });
  });
});

describe('mapValues', () => {
  test('returns an object of the same keys with every value passed through the function, which gets the key too', () => {
    const mapped = mapValues({ first: 1, second: 2 }, (value, key) => `${key}:${value * 2}`);

    assert.deepEqual({ ...mapped }, { first: 'first:2', second: 'second:4' });
    assert.deepEqual(Object.keys(mapValues({}, (value) => value)), []);
  });

  test('returns an object without a prototype: a key from the data is never answered by an inherited property', () => {
    const mapped = mapValues({ users: 1 }, (value) => value);
    const polluted = mapValues(JSON.parse('{"__proto__": {"isAdmin": true}, "constructor": 1}'), (value) => value);

    assert.equal(Object.getPrototypeOf(mapped), null);
    assert.equal(mapped.constructor, undefined);
    assert.equal(mapped.toString, undefined);
    assert.deepEqual(Object.keys(polluted).sort(), ['__proto__', 'constructor']);
    assert.equal({}.isAdmin, undefined);
  });

  test('takes an object without a prototype, such as the result of keyBy', () => {
    const source = Object.assign(Object.create(null), { one: 1 });

    assert.deepEqual({ ...mapValues(source, (value) => value + 1) }, { one: 2 });
  });

  test('rejects what is not a plain object or not a function', () => {
    [null, undefined, 'text', 5, [1], new Map()].forEach((object) => {
      assert.throws(() => mapValues(object, (value) => value), /^TypeError: mapValues\(object, toValue\) requires a plain object and a function$/);
    });
    [null, undefined, 'value', {}].forEach((toValue) => {
      assert.throws(() => mapValues({}, toValue), /mapValues\(object, toValue\) requires/);
    });
  });
});
