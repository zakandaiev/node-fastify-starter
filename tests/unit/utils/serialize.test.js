import { keyBy } from '#utils/array.js';
import { deserializeValue, serializeValue, toJsonTree } from '#utils/serialize.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

class Sample {}

const TAG = String.fromCharCode(0);
const DEEP_LEVELS = 100000;

const UNSUPPORTED_VALUES = [() => {}, Sample, Symbol('id'), new Map(), new Set(), new WeakMap(), new Sample(), /x/, new Error('x'), new Uint8Array(2), new ArrayBuffer(2), Object.create({}), Promise.resolve()];

function roundTrip(value) {
  return deserializeValue(serializeValue(value));
}

function tagText(...payload) {
  return JSON.stringify({ [TAG]: payload });
}

describe('serializeValue and deserializeValue', () => {
  test('give back the rows of a query as they were: a Date stays a Date, a Buffer a Buffer', () => {
    const rows = [
      {
        id: '019a0000-0000-7000-8000-000000000000',
        name: 'Ada',
        isActive: true,
        score: 4.5,
        count: 3,
        note: null,
        createdAt: new Date('2026-11-19T10:20:30.456Z'),
        hash: Buffer.from([0, 1, 254, 255]),
        profile: { theme: 'dark', tags: ['a', 'b'], nested: { level: 2 } },
      },
      { id: '019a0000-0000-7000-8000-000000000001', createdAt: new Date(0), hash: Buffer.alloc(0) },
    ];

    const restored = roundTrip(rows);

    assert.deepStrictEqual(restored, rows);
    assert.ok(restored[0].createdAt instanceof Date);
    assert.ok(Buffer.isBuffer(restored[0].hash));
  });

  test('keep the types JSON has no place for: undefined, a BigInt, NaN, Infinity, -0 and an invalid date', () => {
    const value = {
      missing: undefined,
      big: 12345678901234567890n,
      negativeBig: -5n,
      notANumber: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
      minusInfinity: Number.NEGATIVE_INFINITY,
      minusZero: -0,
      invalidDate: new Date(Number.NaN),
      list: [undefined, null, -0, 1n],
    };

    const restored = roundTrip(value);

    assert.deepStrictEqual(restored, value);
    assert.ok(Object.hasOwn(restored, 'missing'));
    assert.equal(restored.list.length, 4);
    assert.ok(Object.is(restored.minusZero, -0));
    assert.ok(Number.isNaN(restored.invalidDate.getTime()));
  });

  test('give back a top-level primitive of any kind', () => {
    [null, true, false, 0, -0, 1.5, 'text', '', undefined, 7n, Number.NaN, new Date(5), Buffer.from('x')].forEach((value) => {
      assert.deepStrictEqual(roundTrip(value), value);
    });
  });

  test('write plain JSON for plain data, readable by anything that reads JSON', () => {
    const text = serializeValue({
      name: 'Ada', tags: ['a'], count: 1, note: null,
    });

    assert.equal(text, '{"name":"Ada","tags":["a"],"count":1,"note":null}');
  });

  test('keep an own key that starts with the tag character, and a key that is only that character', () => {
    const value = {
      [TAG]: 1,
      [`${TAG}x`]: 2,
      [`${TAG}${TAG}y`]: 3,
      inner: { [TAG]: [TAG] },
    };

    assert.deepStrictEqual(roundTrip(value), value);
  });

  test('keep a "__proto__" key as an own property and leave the prototype of the object alone', () => {
    const value = JSON.parse('{"__proto__":{"isAdmin":true},"name":"Ada","inner":{"__proto__":{"x":1},"y":2}}');
    const withTag = JSON.parse('{"__proto__":{"isAdmin":true}}');

    withTag[`${TAG}k`] = 1;

    [value, withTag].forEach((source) => {
      const restored = roundTrip(source);

      assert.equal(Object.getPrototypeOf(restored), Object.prototype);
      assert.ok(Object.hasOwn(restored, '__proto__'));
      assert.deepEqual(Object.getOwnPropertyDescriptor(restored, '__proto__').value, { isAdmin: true });
      assert.equal(restored.isAdmin, undefined);
    });

    assert.equal(roundTrip(value).inner.y, 2);
    assert.equal(roundTrip(value).inner.x, undefined);
    assert.equal({}.isAdmin, undefined);
  });

  test('give back an object without a prototype without one: a map of keyBy() is not answered by inherited names', () => {
    const byId = keyBy([{ id: 'a', tags: [] }, { id: '__proto__', tags: ['x'] }], 'id');
    const value = { byId, list: [Object.assign(Object.create(null), { [TAG]: 1, nested: Object.create(null) })] };

    const restored = roundTrip(value);

    assert.deepStrictEqual(restored, value);
    assert.equal(Object.getPrototypeOf(restored.byId), null);
    assert.equal(restored.byId.constructor, undefined);
    assert.equal(restored.byId.toString, undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptor(restored.byId, '__proto__').value, { id: '__proto__', tags: ['x'] });
    assert.equal(Object.getPrototypeOf(restored.list[0].nested), null);
    assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  });

  test('write and read back a tree nested deeper than the call stack goes, of arrays and of objects', () => {
    const arrays = JSON.parse(`${'['.repeat(DEEP_LEVELS)}1${']'.repeat(DEEP_LEVELS)}`);
    const objects = Array.from({ length: DEEP_LEVELS }).reduce((inner) => ({ a: inner }), { at: new Date(0) });
    const restoredArrays = roundTrip(arrays);
    const restoredObjects = roundTrip(objects);
    let depth = 0;
    let node = restoredArrays;

    while (Array.isArray(node)) {
      depth += 1;
      [node] = node;
    }

    assert.equal(depth, DEEP_LEVELS);
    assert.equal(node, 1);

    depth = 0;
    node = restoredObjects;

    while (node.a) {
      depth += 1;
      node = node.a;
    }

    assert.equal(depth, DEEP_LEVELS);
    assert.ok(node.at instanceof Date);
  });

  test('refuse what it cannot give back the same, instead of flattening it into a plain object', () => {
    UNSUPPORTED_VALUES.forEach((value) => {
      assert.throws(() => serializeValue(value), TypeError);
      assert.throws(() => serializeValue({ nested: [value] }), TypeError);
    });
  });

  test('refuse an array with a hole or with a key of its own, and an object on a prototype of its own', () => {
    const sparse = new Array(3);
    const withTotal = Object.assign([1, 2], { total: 42 });
    const inheriting = Object.assign(Object.create(Object.create(null)), { a: 1 });

    sparse[0] = 1;

    assert.throws(() => serializeValue(sparse), /holes or with keys of its own/);
    assert.throws(() => serializeValue({ rows: withTotal }), /holes or with keys of its own/);
    assert.throws(() => serializeValue(inheriting), /cannot keep \[object Object\]/);
  });

  test('refuse a property keyed by a symbol', () => {
    assert.throws(() => serializeValue({ a: 1, [Symbol('b')]: 2 }), /keyed by a symbol/);
  });

  test('refuse a circular structure, also one that has to be copied for its keys', () => {
    const plain = { name: 'a' };
    const tagged = { [TAG]: 'a' };

    plain.self = plain;
    tagged.self = { back: tagged };

    assert.throws(() => serializeValue(plain), TypeError);
    assert.throws(() => serializeValue(tagged), TypeError);
  });

  test('refuse a text it would not have written', () => {
    const malformed = [
      tagText('unknown', 1),
      tagText(),
      tagText('undefined', 1),
      tagText('number', '5'),
      tagText('number', ['NaN']),
      tagText('number'),
      tagText('date', 1.9),
      tagText('object'),
      tagText('object', [1]),
      tagText('object', null),
      tagText('object', { [`${TAG}x`]: 1 }),
      tagText('bigint', '0x10'),
      tagText('bigint', ' 1'),
      tagText('bigint', 1),
      tagText('date', '2026-11-19T00:00:00Z'),
      tagText('date', 8.64e15 + 1),
      tagText('buffer', 'not base64!'),
      tagText('buffer', 5),
      JSON.stringify({ [TAG]: ['undefined'], other: 1 }),
      JSON.stringify({ [`${TAG}x`]: 1 }),
      JSON.stringify({ [TAG]: 'undefined' }),
    ];

    malformed.forEach((text) => assert.throws(() => deserializeValue(text), /does not write/, text));
    assert.throws(() => deserializeValue('{"a":'), SyntaxError);
    assert.throws(() => deserializeValue(Buffer.from('1')), /requires a string/);
  });
});

describe('toJsonTree', () => {
  test('gives what JSON keeps of a value: an instance, a date and a toJSON() in their plain form, no undefined, no function', () => {
    const tree = toJsonTree({
      account: Object.assign(Object.create({ greet() {} }), { name: 'Anna', apiToken: 'token-value' }),
      at: new Date(0),
      own: { toJSON: () => ({ id: 1 }) },
      missing: undefined,
      run() {},
      list: [1, undefined, null],
    });

    assert.deepEqual(tree, {
      account: { name: 'Anna', apiToken: 'token-value' },
      at: '1970-01-01T00:00:00.000Z',
      own: { id: 1 },
      list: [1, null, null],
    });
    assert.equal(Object.getPrototypeOf(tree.account), Object.prototype);
    assert.equal(toJsonTree(undefined), null);
  });

  test('writes a bigint as its text and a lone surrogate as U+FFFD, inside a string of any depth', () => {
    const half = String.fromCharCode(0xD83D);
    const replacement = String.fromCharCode(0xFFFD);

    assert.deepEqual(toJsonTree({ count: 10n, texts: [`Anna ${half}`], nested: { text: half } }), {
      count: '10',
      texts: [`Anna ${replacement}`],
      nested: { text: replacement },
    });
  });

  test('shares nothing: what was met twice comes back as two values', () => {
    const scopes = ['users:read'];
    const tree = toJsonTree({ requested: scopes, granted: scopes });

    assert.deepEqual(tree, { requested: ['users:read'], granted: ['users:read'] });
    assert.notEqual(tree.requested, tree.granted);
    assert.notEqual(tree.requested, scopes);
  });

  test('writes a lone surrogate of a key as U+FFFD too, in an object of any depth', () => {
    const half = String.fromCharCode(0xD83D);
    const replacement = String.fromCharCode(0xFFFD);

    assert.deepEqual(toJsonTree({ [`a${half}`]: 1, list: [{ [half]: { [half]: 2 } }] }), {
      [`a${replacement}`]: 1,
      list: [{ [replacement]: { [replacement]: 2 } }],
    });
  });

  test('cuts a tree that is nested deeper than it walks, where JSON.stringify() with a replacer runs out of the call stack', () => {
    const half = String.fromCharCode(0xD83D);
    const replacement = String.fromCharCode(0xFFFD);
    const list = Array.from({ length: 5000 }).reduce((inner) => [inner], 'bottom');
    const object = Array.from({ length: 5000 }).reduce((inner) => ({ inner }), 'bottom');
    const halfKeys = Array.from({ length: 5000 }).reduce((inner) => ({ [half]: inner }), 'bottom');
    const kept = Array.from({ length: 60 }).reduce((inner) => [inner], 'bottom');

    assert.equal(JSON.stringify(toJsonTree(list)), `${'['.repeat(64)}"[depth limit]"${']'.repeat(64)}`);
    assert.equal(JSON.stringify(toJsonTree(object)), `${'{"inner":'.repeat(64)}"[depth limit]"${'}'.repeat(64)}`);
    assert.equal(JSON.stringify(toJsonTree(halfKeys)), `${`{"${replacement}":`.repeat(64)}"[depth limit]"${'}'.repeat(64)}`);
    assert.deepEqual(toJsonTree(kept), kept);
  });

  test('counts the depth of a value that is met twice at each place of its own', () => {
    const shared = Array.from({ length: 40 }).reduce((inner) => [inner], 'bottom');
    const buried = Array.from({ length: 30 }).reduce((inner) => [inner], shared);
    const [cut, whole] = toJsonTree([buried, shared]);

    assert.match(JSON.stringify(cut), /"\[depth limit\]"/);
    assert.deepEqual(whole, shared);
  });

  test('throws on a cycle, also through an object whose key is not well formed', () => {
    const half = String.fromCharCode(0xD83D);
    const cycle = {};
    const halfCycle = {};

    cycle.self = cycle;
    halfCycle[half] = halfCycle;

    assert.throws(() => toJsonTree(cycle), TypeError);
    assert.throws(() => toJsonTree(halfCycle), TypeError);
  });

  test('takes an instance whose key is not well formed', () => {
    const half = String.fromCharCode(0xD83D);
    const instance = Object.assign(Object.create({ greet() {} }), { [half]: 1 });

    assert.deepEqual(toJsonTree(instance), { [String.fromCharCode(0xFFFD)]: 1 });
  });
});
