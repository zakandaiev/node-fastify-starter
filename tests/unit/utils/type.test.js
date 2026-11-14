import {
  isArray,
  isBoolean,
  isFunction,
  isNonEmptyArray,
  isNonEmptyObject,
  isNonEmptyString,
  isNonNegativeInteger,
  isNumber,
  isNumberInRange,
  isNumeric,
  isObject,
  isPositiveInteger,
  isString,
  isStringBoolean,
  isStringValidJson,
  toNumber,
  toString,
} from '#utils/type.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';

class Sample {}

const NOT_OBJECTS = [null, undefined, 0, 1, '', 'text', true, Symbol('sample'), 10n, () => {}];

describe('isArray', () => {
  test('accepts arrays only', () => {
    assert.equal(isArray([]), true);
    assert.equal(isArray([1, 2]), true);
    assert.equal(isArray(new Array(2)), true);
  });

  test('rejects array-likes and everything else', () => {
    [{ length: 0 }, 'ab', new Set([1]), new Uint8Array(2), null, undefined].forEach((value) => {
      assert.equal(isArray(value), false);
    });
  });
});

describe('isObject', () => {
  test('accepts a plain object and an object without a prototype', () => {
    assert.equal(isObject({}), true);
    assert.equal(isObject({ id: 1 }), true);
    assert.equal(isObject(Object.create(null)), true);
    assert.equal(isObject(JSON.parse('{"id":1}')), true);
  });

  test('accepts an object whose own keys shadow the prototype', () => {
    assert.equal(isObject(JSON.parse('{"constructor":1}')), true);
    assert.equal(isObject(JSON.parse('{"__proto__":{"isAdmin":true}}')), true);
    assert.equal(isObject({ constructor: Array, toString: null }), true);
  });

  test('accepts a dictionary built on a prototype without a prototype, as request.query of Fastify is', () => {
    function Dictionary() {}

    Dictionary.prototype = Object.create(null);

    const query = new Dictionary();

    query.token = 'secret';

    assert.equal(isObject(query), true);
    assert.equal(isObject(Object.create(Object.create(null))), true);
  });

  test('accepts a plain object of another realm', () => {
    assert.equal(isObject(runInNewContext('({ id: 1 })')), true);
    assert.equal(isObject(runInNewContext('[1]')), false);
  });

  test('rejects arrays, dates and instances of other classes', () => {
    [[], new Date(), new Map(), new Set(), /x/, new Sample(), new Error('x'), Buffer.alloc(1), Object.create({})].forEach((value) => {
      assert.equal(isObject(value), false);
    });
  });

  test('rejects primitives and functions', () => {
    NOT_OBJECTS.forEach((value) => {
      assert.equal(isObject(value), false);
    });
  });
});

describe('isString', () => {
  test('accepts primitive strings only', () => {
    assert.equal(isString(''), true);
    assert.equal(isString('text'), true);
    assert.equal(isString(String(1)), true);
    // eslint-disable-next-line no-new-wrappers -- the wrapper object is the case under test
    assert.equal(isString(new String('text')), false);
    assert.equal(isString(1), false);
    assert.equal(isString(null), false);
    assert.equal(isString(['a']), false);
  });
});

describe('isNonEmptyString', () => {
  test('accepts a string that holds at least one character', () => {
    assert.equal(isNonEmptyString('a'), true);
    assert.equal(isNonEmptyString(' '), true);
    assert.equal(isNonEmptyString('0'), true);
  });

  test('rejects an empty string and everything that is not a string', () => {
    // eslint-disable-next-line no-new-wrappers -- the wrapper object is the case under test
    ['', null, undefined, 0, 1, true, ['a'], { length: 1 }, new String('text')].forEach((value) => {
      assert.equal(isNonEmptyString(value), false);
    });
  });
});

describe('isNonEmptyArray', () => {
  test('accepts an array that holds at least one item', () => {
    assert.equal(isNonEmptyArray([0]), true);
    assert.equal(isNonEmptyArray([undefined]), true);
    assert.equal(isNonEmptyArray(new Array(1)), true);
  });

  test('rejects an empty array and everything that is not an array', () => {
    [[], 'ab', { length: 1 }, new Set([1]), new Uint8Array(2), null, undefined].forEach((value) => {
      assert.equal(isNonEmptyArray(value), false);
    });
  });
});

describe('isNonEmptyObject', () => {
  test('accepts a plain object that holds at least one own enumerable key', () => {
    assert.equal(isNonEmptyObject({ a: undefined }), true);
    assert.equal(isNonEmptyObject(Object.assign(Object.create(null), { a: 1 })), true);
    assert.equal(isNonEmptyObject(Object.assign(Object.create(Object.create(null)), { a: 1 })), true);
  });

  test('rejects an empty object, an object with inherited or hidden keys only and everything that is not a plain object', () => {
    const hidden = Object.defineProperty({}, 'a', { value: 1, enumerable: false });
    const inherited = Object.create(Object.assign(Object.create(null), { a: 1 }));

    [{}, Object.create(null), hidden, inherited, [1], 'ab', new Sample(), new Map([['a', 1]]), null, undefined].forEach((value) => {
      assert.equal(isNonEmptyObject(value), false);
    });
  });
});

describe('isPositiveInteger', () => {
  test('accepts safe integers above zero', () => {
    [1, 2, 1e3, Number.MAX_SAFE_INTEGER].forEach((value) => {
      assert.equal(isPositiveInteger(value), true);
    });
  });

  test('rejects zero, negatives, fractions, integers past the safe range and what is not a number', () => {
    [0, -0, -1, 1.5, 2 ** 53, 1e21, Number.MAX_VALUE, Infinity, Number.NaN, '1', 1n, true, null, undefined, [1]].forEach((value) => {
      assert.equal(isPositiveInteger(value), false);
    });
  });
});

describe('isNonNegativeInteger', () => {
  test('accepts zero and safe integers above it', () => {
    [0, -0, 1, 1e3, Number.MAX_SAFE_INTEGER].forEach((value) => {
      assert.equal(isNonNegativeInteger(value), true);
    });
  });

  test('rejects negatives, fractions, integers past the safe range and what is not a number', () => {
    [-1, 0.5, 2 ** 53, Infinity, Number.NaN, '0', 0n, false, null, undefined, [0]].forEach((value) => {
      assert.equal(isNonNegativeInteger(value), false);
    });
  });
});

describe('isNumber', () => {
  test('accepts finite numbers', () => {
    [0, -0, 1, -1.5, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE].forEach((value) => {
      assert.equal(isNumber(value), true);
    });
  });

  test('rejects NaN, the infinities and numeric look-alikes', () => {
    [Number.NaN, Infinity, -Infinity, '1', 1n, null, undefined, true, [1]].forEach((value) => {
      assert.equal(isNumber(value), false);
    });
  });
});

describe('isBoolean', () => {
  test('accepts true and false only', () => {
    assert.equal(isBoolean(true), true);
    assert.equal(isBoolean(false), true);
    [0, 1, 'true', null, undefined].forEach((value) => {
      assert.equal(isBoolean(value), false);
    });
  });
});

describe('isStringBoolean', () => {
  test('accepts the exact strings "true" and "false"', () => {
    assert.equal(isStringBoolean('true'), true);
    assert.equal(isStringBoolean('false'), true);
  });

  test('rejects booleans, other spellings and other strings', () => {
    [true, false, 'TRUE', 'False', ' true', '1', '0', 'yes', '', null].forEach((value) => {
      assert.equal(isStringBoolean(value), false);
    });
  });
});

describe('isFunction', () => {
  test('accepts every kind of function', () => {
    [() => {}, function named() {}, async () => {}, function* generate() { yield 1; }, Sample, Math.max].forEach((value) => {
      assert.equal(isFunction(value), true);
    });
  });

  test('rejects everything else', () => {
    [{}, null, undefined, 'function', { call() {} }].forEach((value) => {
      assert.equal(isFunction(value), false);
    });
  });
});

describe('isNumberInRange', () => {
  test('includes both bounds', () => {
    assert.equal(isNumberInRange(1, 1, 65535), true);
    assert.equal(isNumberInRange(65535, 1, 65535), true);
    assert.equal(isNumberInRange(443, 1, 65535), true);
    assert.equal(isNumberInRange(0.5, 0, 1), true);
  });

  test('rejects a number outside the range', () => {
    assert.equal(isNumberInRange(0, 1, 65535), false);
    assert.equal(isNumberInRange(65536, 1, 65535), false);
    assert.equal(isNumberInRange(-1, 0, 10), false);
  });

  test('rejects what is not a finite number', () => {
    ['5', Number.NaN, Infinity, null, undefined].forEach((value) => {
      assert.equal(isNumberInRange(value, 0, 10), false);
    });
  });
});

describe('toNumber', () => {
  test('returns a finite number as is', () => {
    assert.equal(toNumber(0), 0);
    assert.equal(toNumber(-1.5), -1.5);
    assert.equal(toNumber(42), 42);
  });

  test('converts a string in plain decimal notation', () => {
    assert.equal(toNumber('0'), 0);
    assert.equal(toNumber('42'), 42);
    assert.equal(toNumber('-7'), -7);
    assert.equal(toNumber('0.3'), 0.3);
    assert.equal(toNumber('-12.50'), -12.5);
    assert.equal(toNumber('007'), 7);
  });

  test('returns null for a string that is not entirely a number', () => {
    ['0,3', '12abc', 'abc', '', ' ', ' 5', '5 ', '1 000', '+5', '.5', '5.', '1e3', '0x10', '1_000', '--1', '1.2.3', 'Infinity', 'NaN'].forEach((value) => {
      assert.equal(toNumber(value), null, `toNumber(${JSON.stringify(value)})`);
    });
  });

  test('returns null for a number that is not finite, in either form', () => {
    assert.equal(toNumber(Number.NaN), null);
    assert.equal(toNumber(Infinity), null);
    assert.equal(toNumber(-Infinity), null);
    assert.equal(toNumber('9'.repeat(400)), null);
  });

  test('returns null for other types', () => {
    [null, undefined, true, false, 10n, [], [5], {}, new Date(0)].forEach((value) => {
      assert.equal(toNumber(value), null);
    });
  });

  test('reads a long string of digits in linear time', () => {
    const startedAt = performance.now();

    assert.equal(toNumber(`${'1'.repeat(200000)}x`), null);
    assert.ok(performance.now() - startedAt < 1000);
  });
});

describe('isNumeric', () => {
  test('accepts what toNumber converts', () => {
    [0, 1.5, '0', '42', '-7', '0.3'].forEach((value) => {
      assert.equal(isNumeric(value), true);
    });
  });

  test('rejects what toNumber does not convert', () => {
    ['0,3', '12abc', '', '1e3', Number.NaN, Infinity, null, undefined, true, []].forEach((value) => {
      assert.equal(isNumeric(value), false);
    });
  });
});

describe('isStringValidJson', () => {
  test('accepts a string that holds a JSON object or array', () => {
    ['{}', '[]', '{"id":1}', '[1,"a",null]', ' {"nested":{"list":[]}} '].forEach((value) => {
      assert.equal(isStringValidJson(value), true);
    });
  });

  test('rejects a bare scalar: it is not a document to parse', () => {
    ['1', '"text"', 'true', 'null'].forEach((value) => {
      assert.equal(isStringValidJson(value), false);
    });
  });

  test('rejects broken JSON and other types', () => {
    ['', '{', '{id:1}', "{'id':1}", '[1,]', 'undefined', {}, [], null, undefined, 1].forEach((value) => {
      assert.equal(isStringValidJson(value), false);
    });
  });
});

describe('toString', () => {
  test('returns a string as is', () => {
    assert.equal(toString(''), '');
    assert.equal(toString('text'), 'text');
  });

  test('turns null and undefined into an empty string', () => {
    assert.equal(toString(null), '');
    assert.equal(toString(undefined), '');
  });

  test('converts primitives', () => {
    assert.equal(toString(0), '0');
    assert.equal(toString(-1.5), '-1.5');
    assert.equal(toString(true), 'true');
    assert.equal(toString(10n), '10');
    assert.equal(toString(Symbol('sample')), 'Symbol(sample)');
  });

  test('serializes arrays and plain objects as JSON', () => {
    assert.equal(toString([1, 'a']), '[1,"a"]');
    assert.equal(toString({ id: 1 }), '{"id":1}');
    assert.equal(toString(Object.assign(Object.create(null), { id: 1 })), '{"id":1}');
  });

  test('converts other objects through String()', () => {
    assert.equal(toString(new Date(0)), String(new Date(0)));
    assert.equal(toString(new Error('boom')), 'Error: boom');
  });

  test('does not throw on a value that cannot be serialized', () => {
    const circular = { id: 1 };
    circular.self = circular;

    assert.equal(toString(circular), '[object Object]');
    assert.equal(toString([10n]), '[object Array]');
    assert.equal(toString(Object.create(Object.create(Object.create(null)))), '[object Object]');
    assert.equal(toString({ toJSON: () => undefined }), '');
  });

  test('serializes a dictionary built on a prototype without a prototype as JSON', () => {
    const query = Object.create(Object.create(null));

    query.limit = '5';

    assert.equal(toString(query), '{"limit":"5"}');
  });
});
