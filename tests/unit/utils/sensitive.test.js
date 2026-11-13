import { isSensitiveKey, maskSensitiveDeep } from '#utils/sensitive.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

class Sample {
  constructor() {
    this.password = 'qwerty';
  }
}

const HIDDEN = '[hidden]';
const DEPTH_LIMIT = '[depth limit]';
const REPEATED = '[repeated]';
const UNREADABLE = '[unreadable]';

const MAX_DEPTH = 12;
const LATTICE_WIDTH = 3;
const INSTANT_MS = 2000;

const PROTOTYPE_KEYS = Reflect.ownKeys(Object.prototype);

function nestObjects(levels, leaf) {
  return Array.from({ length: levels }).reduce((inner) => ({ child: inner }), leaf);
}

function nestArrays(levels, leaf) {
  return Array.from({ length: levels }).reduce((inner) => [inner], leaf);
}

// A loop over numbers: a failed deep comparison of 100000 levels would take minutes to print.
function countLevels(value) {
  let levels = 0;
  let current = value;

  while (current !== null && typeof current === 'object') {
    levels += 1;
    current = Array.isArray(current) ? current[0] : current.child;
  }

  return levels;
}

describe('isSensitiveKey', () => {
  test('accepts a key that names a credential', () => {
    [
      'auth',
      'authorization',
      'proxy-authorization',
      'token',
      'accessToken',
      'refresh_token',
      'id_token',
      'x-csrf-token',
      'password',
      'passwd',
      'passphrase',
      'pwd',
      'secret',
      'clientSecret',
      'key',
      'apiKey',
      'x-api-key',
      'privateKey',
      'idempotency-key',
      'jwt',
      'session',
      'sessionId',
      'cookie',
      'cookies',
      'set-cookie',
      'credentials',
      'signature',
      'x-hub-signature-256',
      'hash',
      'refresh_token_hash',
      'otp',
      'totp',
      'codeVerifier',
      'code_verifier',
      'initData',
    ].forEach((key) => {
      assert.equal(isSensitiveKey(key), true, key);
    });
  });

  test('ignores the letter case and finds a fragment anywhere in the key', () => {
    ['Authorization', 'PASSWORD', 'APP_JWT_ACCESS_SECRET', 'APP_DATABASE_PASSWORD', 'APP_LOG_API_KEY', 'MYSQL_PWD', 'tgWebAppInitData', 'userPasswordConfirm'].forEach((key) => {
      assert.equal(isSensitiveKey(key), true, key);
    });
  });

  test('leaves the fields that an alert and a log line have to show', () => {
    [
      'code',
      'status',
      'statusCode',
      'message',
      'method',
      'url',
      'ip',
      'id',
      'userId',
      'requestId',
      'userAgent',
      'name',
      'version',
      'mode',
      'title',
      'stack',
      'origin',
      'referer',
      'email',
      'phone',
      'state',
      'level',
      'time',
      'hostname',
      'pid',
      'msg',
      'err',
      'reason',
      'channels',
      '',
    ].forEach((key) => {
      assert.equal(isSensitiveKey(key), false, key);
    });
  });

  test('hides a key that merely contains a fragment: too much is the safe side', () => {
    ['author', 'keyword', 'passport', 'rootPath'].forEach((key) => {
      assert.equal(isSensitiveKey(key), true, key);
    });
  });

  test('converts a key that is not a string with String()', () => {
    assert.equal(isSensitiveKey(0), false);
    assert.equal(isSensitiveKey(12), false);
    assert.equal(isSensitiveKey(null), false);
    assert.equal(isSensitiveKey(undefined), false);
    assert.equal(isSensitiveKey(true), false);
    assert.equal(isSensitiveKey(Symbol('id')), false);
    assert.equal(isSensitiveKey(Symbol('token')), true);
    assert.equal(isSensitiveKey(['api', 'key']), true);
    assert.equal(isSensitiveKey({ toString: () => 'Password' }), true);
    assert.equal(isSensitiveKey({}), false);
  });

  test('counts a key that cannot be converted to a string as sensitive instead of throwing', () => {
    assert.equal(isSensitiveKey(Object.create(null)), true);
    assert.equal(isSensitiveKey(JSON.parse('{"toString":1}')), true);
    assert.equal(isSensitiveKey([JSON.parse('{"toString":1}')]), true);
  });

  test('reads a long key in linear time', () => {
    const startedAt = performance.now();

    assert.equal(isSensitiveKey('a'.repeat(1000000)), false);
    assert.equal(isSensitiveKey(`${'a'.repeat(1000000)}token`), true);
    assert.ok(performance.now() - startedAt < INSTANT_MS);
  });
});

describe('maskSensitiveDeep', () => {
  test('hides the value under a sensitive key at any level, inside arrays too', () => {
    const masked = maskSensitiveDeep({
      id: 1,
      password: 'qwerty',
      profile: { accessToken: 'abc', name: 'Anna', tags: ['a'] },
      items: [{ apiKey: 'abc', title: 'First' }, 'text', 5, null],
      headers: { authorization: 'Bearer abc', 'user-agent': 'curl' },
    });

    assert.deepEqual(masked, {
      id: 1,
      password: HIDDEN,
      profile: { accessToken: HIDDEN, name: 'Anna', tags: ['a'] },
      items: [{ apiKey: HIDDEN, title: 'First' }, 'text', 5, null],
      headers: { authorization: HIDDEN, 'user-agent': 'curl' },
    });
  });

  test('hides the value whatever it is: an object, an array, a number, false or an empty string', () => {
    assert.deepEqual(maskSensitiveDeep({
      cookies: { access: 'abc', refresh: 'def' },
      tokens: ['abc', 'def'],
      secret: 0,
      key: false,
      jwt: '',
    }), {
      cookies: HIDDEN,
      tokens: HIDDEN,
      secret: HIDDEN,
      key: HIDDEN,
      jwt: HIDDEN,
    });
  });

  test('keeps null and undefined under a sensitive key: "[hidden]" would claim a secret that was not there', () => {
    const masked = maskSensitiveDeep({ token: null, session: undefined });

    assert.deepEqual(masked, { token: null, session: undefined });
    assert.ok(Object.hasOwn(masked, 'session'));
  });

  test('returns a copy and leaves the input untouched', () => {
    const input = {
      password: 'qwerty',
      nested: { token: 'abc', list: [{ secret: 'abc' }] },
    };
    const snapshot = structuredClone(input);
    const masked = maskSensitiveDeep(input);

    assert.deepEqual(input, snapshot);
    assert.notEqual(masked, input);
    assert.notEqual(masked.nested, input.nested);
    assert.notEqual(masked.nested.list, input.nested.list);
    assert.equal(input.nested.list[0].secret, 'abc');
  });

  test('accepts a frozen input', () => {
    const input = Object.freeze({ nested: Object.freeze({ token: 'abc' }), list: Object.freeze([1]) });

    assert.deepEqual(maskSensitiveDeep(input), { nested: { token: HIDDEN }, list: [1] });
  });

  test('returns a value that is neither a plain object nor an array as is', () => {
    const date = new Date(0);
    const buffer = Buffer.from('ab');
    const error = new Error('boom');
    const sample = new Sample();
    const map = new Map([['password', 'qwerty']]);
    const masked = maskSensitiveDeep({
      date,
      buffer,
      error,
      sample,
      map,
      list: [date, sample],
    });

    assert.equal(masked.date, date);
    assert.equal(masked.buffer, buffer);
    assert.equal(masked.error, error);
    assert.equal(masked.sample, sample);
    assert.equal(masked.map, map);
    assert.equal(masked.list[1], sample);
    assert.equal(maskSensitiveDeep(date), date);
    assert.equal(maskSensitiveDeep(sample), sample);

    ['password', 5, true, null, undefined].forEach((value) => {
      assert.equal(maskSensitiveDeep(value), value);
    });
  });

  test('replaces a cycle with "[repeated]"', () => {
    const node = { id: 1, children: [] };
    node.self = node;
    node.children.push(node);

    assert.deepEqual(maskSensitiveDeep(node), { id: 1, children: [REPEATED], self: REPEATED });
  });

  test('replaces a shared reference with "[repeated]" after its first visit', () => {
    const shared = { id: 1, token: 'abc' };

    assert.deepEqual(maskSensitiveDeep({ first: shared, second: shared, list: [shared] }), {
      first: { id: 1, token: HIDDEN },
      second: REPEATED,
      list: [REPEATED],
    });
  });

  test('walks 12 levels and replaces what lies deeper with "[depth limit]"', () => {
    assert.deepEqual(maskSensitiveDeep(nestObjects(MAX_DEPTH, 'leaf')), nestObjects(MAX_DEPTH, 'leaf'));
    assert.deepEqual(maskSensitiveDeep(nestObjects(MAX_DEPTH + 1, 'leaf')), nestObjects(MAX_DEPTH, DEPTH_LIMIT));
    assert.deepEqual(maskSensitiveDeep(nestArrays(MAX_DEPTH, 'leaf')), nestArrays(MAX_DEPTH, 'leaf'));
    assert.deepEqual(maskSensitiveDeep(nestArrays(MAX_DEPTH + 1, 'leaf')), nestArrays(MAX_DEPTH, DEPTH_LIMIT));
  });

  test('still hides a sensitive key on the last level it walks', () => {
    const masked = maskSensitiveDeep(nestObjects(MAX_DEPTH - 1, { token: 'abc', nested: {} }));

    assert.deepEqual(masked, nestObjects(MAX_DEPTH - 1, { token: HIDDEN, nested: DEPTH_LIMIT }));
  });

  test('does not overflow the stack on 100000 levels of nesting', () => {
    [nestObjects, nestArrays].forEach((nest) => {
      const masked = maskSensitiveDeep(nest(100000, 'leaf'));

      assert.equal(countLevels(masked), MAX_DEPTH);
      assert.deepEqual(masked, nest(MAX_DEPTH, DEPTH_LIMIT));
    });
  });

  test('masks a payload of 100000 keys at once', () => {
    const payload = Object.fromEntries(Array.from({ length: 100000 }, (unused, index) => [`field${index}`, index]));
    payload.password = 'qwerty';

    const startedAt = performance.now();
    const masked = maskSensitiveDeep(payload);

    assert.ok(performance.now() - startedAt < INSTANT_MS);
    assert.equal(Object.keys(masked).length, 100001);
    assert.equal(masked.field99999, 99999);
    assert.equal(masked.password, HIDDEN);
  });

  // Every level holds the next one several times: walked as a tree, the lattice has LATTICE_WIDTH ** 11 paths.
  test('visits a container once, however many paths lead to it', () => {
    const levels = Array.from({ length: MAX_DEPTH - 1 });
    const lattice = levels.reduce((next) => Array.from({ length: LATTICE_WIDTH }, () => next), ['leaf']);
    const expected = levels.reduce((inner) => [inner, ...Array.from({ length: LATTICE_WIDTH - 1 }, () => REPEATED)], ['leaf']);
    const masked = maskSensitiveDeep(lattice);

    assert.equal(masked.filter((item) => item === REPEATED).length, LATTICE_WIDTH - 1);
    assert.deepEqual(masked, expected);
  });

  test('walks a body whose own key shadows the constructor', () => {
    const body = JSON.parse('{"constructor":1,"password":"qwerty","nested":{"constructor":{"token":"abc","prototype":{"key":"abc"}}}}');
    const tooDeep = JSON.parse(`${'{"constructor":'.repeat(20)}1${'}'.repeat(20)}`);

    assert.deepEqual(maskSensitiveDeep(body), {
      constructor: 1,
      password: HIDDEN,
      nested: { constructor: { token: HIDDEN, prototype: { key: HIDDEN } } },
    });
    assert.equal(
      JSON.stringify(maskSensitiveDeep(tooDeep)),
      `${'{"constructor":'.repeat(MAX_DEPTH)}"${DEPTH_LIMIT}"${'}'.repeat(MAX_DEPTH)}`,
    );
  });

  test('keeps "__proto__" as a plain own key of the copy and leaves every prototype alone', () => {
    const masked = maskSensitiveDeep(JSON.parse('{"__proto__":{"isAdmin":true,"password":"qwerty"},"id":1}'));

    assert.deepEqual(Object.keys(masked), ['__proto__', 'id']);
    assert.equal(Object.getPrototypeOf(masked), Object.prototype);
    assert.equal(masked.isAdmin, undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptor(masked, '__proto__').value, { isAdmin: true, password: HIDDEN });
    assert.equal({}.isAdmin, undefined);
    assert.deepEqual(Reflect.ownKeys(Object.prototype), PROTOTYPE_KEYS);
  });

  test('accepts an object without a prototype and returns a plain copy', () => {
    const masked = maskSensitiveDeep(Object.assign(Object.create(null), { id: 1, secret: 'abc' }));

    assert.deepEqual(masked, { id: 1, secret: HIDDEN });
  });

  test('keeps the holes of a sparse array', () => {
    const sparse = new Array(3);
    sparse[1] = { token: 'abc' };

    const masked = maskSensitiveDeep(sparse);

    assert.equal(masked.length, 3);
    assert.equal(Object.hasOwn(masked, 0), false);
    assert.deepEqual(masked[1], { token: HIDDEN });
  });

  test('never throws: a part that cannot be read becomes "[unreadable]", the rest survives', () => {
    const trap = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const { proxy, revoke } = Proxy.revocable({}, {});

    revoke();

    const payload = {
      id: 1,
      trap,
      list: [proxy],
      password: 'qwerty',
    };

    assert.deepEqual(maskSensitiveDeep(payload), {
      id: 1,
      trap: UNREADABLE,
      list: [UNREADABLE],
      password: HIDDEN,
    });
    assert.equal(maskSensitiveDeep(proxy), UNREADABLE);
  });
});
