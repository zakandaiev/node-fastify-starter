import {
  hmac,
  objectHash,
  sha256,
  timingSafeEqual,
} from '#utils/hash.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

class Sample {}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SHA256_HEX_REGEXP = /^[0-9a-f]{64}$/;

const RFC_4231_CASES = [
  {
    key: Buffer.alloc(20, 0x0b),
    data: 'Hi There',
    digest: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  },
  {
    key: 'Jefe',
    data: 'what do ya want for nothing?',
    digest: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  },
  {
    key: Buffer.alloc(20, 0xaa),
    data: Buffer.alloc(50, 0xdd),
    digest: '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
  },
  {
    key: Buffer.from('0102030405060708090a0b0c0d0e0f10111213141516171819', 'hex'),
    data: Buffer.alloc(50, 0xcd),
    digest: '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b',
  },
  {
    key: Buffer.alloc(131, 0xaa),
    data: 'Test Using Larger Than Block-Size Key - Hash Key First',
    digest: '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
  },
  {
    key: Buffer.alloc(131, 0xaa),
    data: 'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.',
    digest: '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
  },
];

const JEFE_CASE = RFC_4231_CASES[1];
const DEEP_LEVELS = 20000;

const NOT_BYTE_SOURCES = [null, undefined, 0, 1, true, {}, [97], new ArrayBuffer(3), new DataView(new ArrayBuffer(3))];
const UNKNOWN_ENCODINGS = ['utf8', 'latin1', 'binary', 'HEX', 'Base64', '', null, 0, {}];
const UNSUPPORTED_VALUES = [() => {}, Sample, Symbol('id'), new Map(), new Set(), new WeakMap(), new Sample(), /x/, new Error('x'), new Uint8Array(2), new ArrayBuffer(2), Object.create({})];

function assertAllDifferent(values) {
  assert.equal(new Set(values.map((value) => objectHash(value))).size, values.length);
}

function parseDeepBody(leaf) {
  return JSON.parse(`${'{"list":['.repeat(DEEP_LEVELS)}${leaf}${']}'.repeat(DEEP_LEVELS)}`);
}

describe('sha256', () => {
  test('returns the lowercase hex digest by default: the known vectors for "", "abc" and the two-block NIST message', () => {
    assert.equal(sha256(''), EMPTY_SHA256);
    assert.equal(sha256('abc'), ABC_SHA256);
    assert.equal(
      sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  test('returns the digest as hex, base64url, base64 or a Buffer on request', () => {
    assert.equal(sha256('', 'hex'), EMPTY_SHA256);
    assert.equal(sha256('', 'base64url'), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
    assert.equal(sha256('', 'base64'), '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    assert.deepEqual(sha256('', 'buffer'), Buffer.from(EMPTY_SHA256, 'hex'));
  });

  test('hashes a string by its UTF-8 bytes', () => {
    assert.equal(sha256('Привіт 😀'), 'ddba3cd4d7a37cecfcc51219e742144da7e91102a8d6959e1f29611d127d110e');
    assert.equal(sha256('😀'), sha256(Buffer.from([0xf0, 0x9f, 0x98, 0x80])));
  });

  test('hashes a Buffer and a typed array by their bytes, a view by its own window', () => {
    const floats = new Float64Array([1.5, -2]);

    assert.equal(sha256(Buffer.from('abc')), ABC_SHA256);
    assert.equal(sha256(new Uint8Array([97, 98, 99])), ABC_SHA256);
    assert.equal(sha256(new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4)), ABC_SHA256);
    assert.equal(sha256(new Uint8Array(0)), EMPTY_SHA256);
    assert.equal(sha256(floats), sha256(Buffer.from(floats.buffer)));
  });

  test('rejects a value that is neither a string nor a typed array', () => {
    NOT_BYTE_SOURCES.forEach((value) => {
      assert.throws(() => sha256(value), { name: 'TypeError', message: /^sha256\(value, encoding\) requires a string/ });
    });
  });

  test('rejects an encoding outside the list', () => {
    UNKNOWN_ENCODINGS.forEach((encoding) => {
      assert.throws(() => sha256('abc', encoding), { name: 'TypeError', message: /^sha256\(value, encoding\) requires one of the encodings/ });
    });
  });
});

describe('hmac', () => {
  test('returns HMAC-SHA256 as lowercase hex by default: the test cases of RFC 4231', () => {
    RFC_4231_CASES.forEach(({ key, data, digest }) => {
      assert.equal(hmac(data, key), digest);
    });
  });

  test('takes the secret as a string, a Buffer or a typed array, a string by its UTF-8 bytes', () => {
    const { data, digest } = JEFE_CASE;

    assert.equal(hmac(data, 'Jefe'), digest);
    assert.equal(hmac(data, Buffer.from('Jefe')), digest);
    assert.equal(hmac(data, new Uint8Array([0x4a, 0x65, 0x66, 0x65])), digest);
    assert.equal(hmac(data, 'ключ 😀'), hmac(data, Buffer.from('ключ 😀', 'utf8')));
  });

  test('takes the value as a string, a Buffer or a typed array, a string by its UTF-8 bytes', () => {
    const { key, data, digest } = JEFE_CASE;

    assert.equal(hmac(Buffer.from(data), key), digest);
    assert.equal(hmac(new Uint8Array(Buffer.from(data)), key), digest);
    assert.equal(hmac('Привіт 😀', key), hmac(Buffer.from('Привіт 😀', 'utf8'), key));
    assert.match(hmac('', key), SHA256_HEX_REGEXP);
  });

  test('returns the digest as hex, base64url, base64 or a Buffer on request', () => {
    const { key, data, digest } = JEFE_CASE;

    assert.equal(hmac(data, key, { encoding: 'hex' }), digest);
    assert.equal(hmac(data, key, { encoding: 'base64url' }), 'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM');
    assert.equal(hmac(data, key, { encoding: 'base64' }), 'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=');
    assert.deepEqual(hmac(data, key, { encoding: 'buffer' }), Buffer.from(digest, 'hex'));
  });

  test('uses another digest algorithm on request: the same case for SHA-512 and for SHA-1 of RFC 2202', () => {
    const { key, data } = JEFE_CASE;

    assert.equal(
      hmac(data, key, { algorithm: 'sha512' }),
      '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737',
    );
    assert.equal(hmac(data, key, { algorithm: 'sha1' }), 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
    assert.equal(hmac(data, key, { algorithm: 'sha1', encoding: 'buffer' }).length, 20);
  });

  test('rejects an empty or missing secret', () => {
    ['', undefined, null, Buffer.alloc(0), new Uint8Array(0)].forEach((secret) => {
      assert.throws(() => hmac('data', secret), { name: 'TypeError', message: /^hmac\(value, secret, options\) requires a non-empty/ });
    });
  });

  test('rejects a secret that is neither a string nor a typed array', () => {
    [0, 1, true, {}, { length: 4 }, ['Jefe'], new ArrayBuffer(4)].forEach((secret) => {
      assert.throws(() => hmac('data', secret), { name: 'TypeError', message: /^hmac\(value, secret, options\) requires a non-empty/ });
    });
  });

  test('rejects a value that is neither a string nor a typed array', () => {
    NOT_BYTE_SOURCES.forEach((value) => {
      assert.throws(() => hmac(value, 'Jefe'), { name: 'TypeError', message: /^hmac\(value, secret, options\) requires a string/ });
    });
  });

  test('rejects an encoding outside the list', () => {
    UNKNOWN_ENCODINGS.forEach((encoding) => {
      assert.throws(() => hmac('data', 'Jefe', { encoding }), { name: 'TypeError', message: /^hmac\(value, secret, options\) requires one of the encodings/ });
    });
  });

  test('rejects an algorithm that node:crypto does not know and keeps its error as the cause', () => {
    ['md6', 'sha257', 'sha256,sha1', '', 256, null, {}].forEach((algorithm) => {
      assert.throws(() => hmac('data', 'Jefe', { algorithm }), (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /^hmac\(value, secret, options\) requires an algorithm/);
        assert.ok(error.cause instanceof Error);

        return true;
      });
    });
  });
});

describe('objectHash', () => {
  test('returns the sha256 hex of a serialization with sorted keys and typed scalars', () => {
    const value = {
      sql: 'SELECT 1',
      binding: [1, '1', 1n, null, undefined, true, -0, Number.NaN, new Date(0), Buffer.from('ab')],
      tableVersions: { users: 3, roles: 1 },
    };
    const serialized = '{"binding":[1,"1",1n,null,undefined,true,-0,NaN,Date(0),Buffer(6162)],"sql":"SELECT 1","tableVersions":{"roles":1,"users":3}}';

    assert.equal(objectHash(value), sha256(serialized));
  });

  test('returns the same 64 hex characters in every process', () => {
    assert.equal(
      objectHash({ sql: 'SELECT * FROM users WHERE id = ?', binding: [1], tableVersions: ['users:3'] }),
      'dc284cb730b32f004a88d148ead89c5450d1992bdd7476aa97d6c0328feef7d7',
    );
  });

  test('hashes a scalar as a value of its type', () => {
    ['abc', '', 0, 1.5, 10n, true, false, null, undefined, new Date(0), Buffer.from('abc')].forEach((value) => {
      assert.match(objectHash(value), SHA256_HEX_REGEXP);
    });

    assert.equal(objectHash('abc'), sha256('"abc"'));
  });

  test('does not depend on the order of keys, at any depth', () => {
    const hash = objectHash({ b: { c: [{ x: 1, y: 2 }], d: 4 }, 10: 'ten', a: 1 });

    assert.equal(objectHash({ a: 1, 10: 'ten', b: { d: 4, c: [{ y: 2, x: 1 }] } }), hash);
    assert.equal(objectHash([{ a: 1, b: 2 }]), objectHash([{ b: 2, a: 1 }]));
  });

  test('depends on the order of array items, at any depth', () => {
    assert.notEqual(objectHash([1, 2]), objectHash([2, 1]));
    assert.notEqual(objectHash({ list: [{ id: 1 }, { id: 2 }] }), objectHash({ list: [{ id: 2 }, { id: 1 }] }));
  });

  test('treats an object without a prototype as a plain object', () => {
    const bare = Object.assign(Object.create(null), { a: 1, b: Object.assign(Object.create(null), { c: 2 }) });

    assert.equal(objectHash(bare), objectHash({ a: 1, b: { c: 2 } }));
  });

  test('hashes an own key "__proto__" as data', () => {
    assertAllDifferent([JSON.parse('{"__proto__":{"a":1}}'), {}, { a: 1 }]);
  });

  test('tells a number from its string, from a BigInt and from a boolean', () => {
    assertAllDifferent([1, '1', 1n, '1n', true, 'true', 0, false, '']);
  });

  test('tells null, undefined and a missing key apart', () => {
    assertAllDifferent([null, undefined, 'null', 'undefined']);
    assertAllDifferent([{}, { a: undefined }, { a: null }, { a: 'undefined' }]);
    assertAllDifferent([[], [undefined], [null], [undefined, undefined]]);
  });

  test('tells a Date from its ISO string and from its timestamp', () => {
    const date = new Date(0);

    assertAllDifferent([date, date.toISOString(), date.getTime(), 'Date(0)', new Date(1)]);
    assert.equal(objectHash(new Date(0)), objectHash(date));
  });

  test('hashes every invalid Date alike, and apart from NaN and null', () => {
    assertAllDifferent([new Date(Number.NaN), Number.NaN, null, new Date(0)]);
    assert.equal(objectHash(new Date(Number.NaN)), objectHash(new Date(Infinity)));
  });

  test('tells a Buffer from a string, from its hex and from an array of its bytes', () => {
    const buffer = Buffer.from('abc');

    assertAllDifferent([buffer, 'abc', '616263', 'Buffer(616263)', [97, 98, 99], buffer.toJSON(), Buffer.alloc(0)]);
    assert.equal(objectHash(Buffer.from([97, 98, 99])), objectHash(buffer));
  });

  test('tells NaN and the infinities from null and from each other', () => {
    assertAllDifferent([Number.NaN, Infinity, -Infinity, null, 'NaN', 'Infinity']);
    assertAllDifferent([[Number.NaN], [Infinity], [-Infinity], [null]]);
    assert.equal(objectHash(Number.NaN), objectHash(Number('x')));
  });

  test('tells -0 from 0', () => {
    assertAllDifferent([-0, 0, '-0', '0']);
    assertAllDifferent([{ value: -0 }, { value: 0 }]);
  });

  test('keeps the structure in the hash: a string or a key cannot imitate it', () => {
    assertAllDifferent([[1, 2], [[1], 2], [1, [2]], [[1, 2]], ['1,2'], ['1', '2'], '[1,2]']);
    assertAllDifferent([{ a: 1, b: 2 }, { 'a":1,"b': 2 }, { a: { b: 2 } }, { 'a.b': 2 }, { a: '{"b":2}' }, [{ a: 1 }, { b: 2 }]]);
    assertAllDifferent([{ a: 'b' }, { b: 'a' }, ['a', 'b'], [['a', 'b']]]);
    assertAllDifferent([[], {}, '', '[]', '{}', [[]], [{}], { '': [] }]);
  });

  test('reads a hole of a sparse array as undefined', () => {
    const sparse = new Array(2);

    sparse[1] = 'b';

    assert.equal(objectHash(sparse), objectHash([undefined, 'b']));
    assertAllDifferent([sparse, ['b'], [null, 'b']]);
    assert.notEqual(objectHash(new Array(1)), objectHash([]));
  });

  test('accepts an object that repeats without being its own ancestor', () => {
    const shared = { id: 1 };

    assert.equal(
      objectHash([shared, shared, { again: shared }]),
      objectHash([{ id: 1 }, { id: 1 }, { again: { id: 1 } }]),
    );
  });

  test('rejects a function, a symbol and an instance of another class, at any depth', () => {
    UNSUPPORTED_VALUES.forEach((value) => {
      [value, [value], { key: value }, { list: [1, { key: value }] }].forEach((input) => {
        assert.throws(() => objectHash(input), { name: 'TypeError', message: /^objectHash\(value\) cannot serialize \[object \w+\]/ });
      });
    });
  });

  test('rejects a property keyed by a symbol', () => {
    const tagged = { id: 1, [Symbol('tag')]: 2 };

    [tagged, [tagged], { nested: tagged }].forEach((input) => {
      assert.throws(() => objectHash(input), { name: 'TypeError', message: /^objectHash\(value\) cannot serialize a property keyed by a symbol/ });
    });
  });

  test('rejects a circular structure', () => {
    const circular = { id: 1 };
    const circularList = [1];
    const parent = { name: 'parent' };

    circular.self = circular;
    circularList.push(circularList);
    parent.child = { name: 'child', parent };

    [circular, circularList, parent, [parent], { deep: { list: [circular] } }].forEach((input) => {
      assert.throws(() => objectHash(input), { name: 'TypeError', message: /^objectHash\(value\) cannot serialize a circular structure/ });
    });
  });

  test('hashes a parsed body of 20000 nested levels: recursion would overflow the call stack', () => {
    const hash = objectHash(parseDeepBody(1));

    assert.match(hash, SHA256_HEX_REGEXP);
    assert.equal(objectHash(parseDeepBody(1)), hash);
    assert.notEqual(objectHash(parseDeepBody(2)), hash);
  });

  test('does not mutate the value', () => {
    const value = Object.freeze({ b: Object.freeze([3, 1, 2]), a: Object.freeze({ z: 1, y: 2 }) });

    assert.match(objectHash(value), SHA256_HEX_REGEXP);
    assert.deepEqual(Object.keys(value), ['b', 'a']);
    assert.deepEqual(value.b, [3, 1, 2]);
    assert.deepEqual(Object.keys(value.a), ['z', 'y']);
  });
});

describe('timingSafeEqual', () => {
  test('returns true for equal strings and for equal bytes', () => {
    assert.equal(timingSafeEqual('secret', 'secret'), true);
    assert.equal(timingSafeEqual('пароль 😀', 'пароль 😀'), true);
    assert.equal(timingSafeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3])), true);
    assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), Buffer.from([1, 2, 3])), true);
  });

  test('returns false for different values of the same length', () => {
    assert.equal(timingSafeEqual('secret', 'secreT'), false);
    assert.equal(timingSafeEqual('secret', 'terces'), false);
    assert.equal(timingSafeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4])), false);
  });

  test('returns false for a different length instead of throwing like crypto.timingSafeEqual()', () => {
    assert.equal(timingSafeEqual('secret', 'secret1'), false);
    assert.equal(timingSafeEqual('secret', ''), false);
    assert.equal(timingSafeEqual('', 'secret'), false);
    assert.equal(timingSafeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2])), false);
    assert.equal(timingSafeEqual(new Uint8Array(4), new Uint16Array(4)), false);
  });

  test('compares strings by their UTF-8 bytes: an equal character count with a different byte length is not an error', () => {
    assert.equal('abcd'.length, 'абвг'.length);
    assert.equal(timingSafeEqual('abcd', 'абвг'), false);
    assert.equal(timingSafeEqual('é', 'e'), false);
    assert.equal(timingSafeEqual('😀', '😎'), false);
    assert.equal(timingSafeEqual('é', 'ab'), false);
    assert.equal(timingSafeEqual('é', 'é'.normalize('NFD')), false);
  });

  test('compares a string with bytes by its UTF-8 encoding', () => {
    assert.equal(timingSafeEqual('é', Buffer.from([0xc3, 0xa9])), true);
    assert.equal(timingSafeEqual(Buffer.from('secret'), 'secret'), true);
    assert.equal(timingSafeEqual('é', Buffer.from([0xe9])), false);
  });

  test('compares typed arrays by their bytes', () => {
    const words = new Uint16Array([0x0102, 0x0304]);

    assert.equal(timingSafeEqual(words, Buffer.from(words.buffer)), true);
    assert.equal(timingSafeEqual(new Uint8Array([0, 1, 2, 3, 0]).subarray(1, 4), new Uint8Array([1, 2, 3])), true);
    assert.equal(timingSafeEqual(new Float64Array([1.5]), new Float64Array([2.5])), false);
  });

  test('treats two empty values as equal, like crypto.timingSafeEqual(): rejecting an empty secret is up to the caller', () => {
    assert.equal(timingSafeEqual('', ''), true);
    assert.equal(timingSafeEqual(Buffer.alloc(0), ''), true);
  });

  test('returns false for a value that is neither a string nor a typed array, even an identical one', () => {
    const list = ['secret'];

    [[null, null], [undefined, undefined], [1, 1], [true, true], [list, list], [{}, {}], [Symbol.iterator, Symbol.iterator]].forEach(([left, right]) => {
      assert.equal(timingSafeEqual(left, right), false);
    });

    [null, undefined, 0, {}, ['secret'], new ArrayBuffer(6), new DataView(new ArrayBuffer(6))].forEach((value) => {
      assert.equal(timingSafeEqual('secret', value), false);
      assert.equal(timingSafeEqual(value, 'secret'), false);
    });
  });
});
