import {
  hasBearerScheme,
  readBearerToken,
  readCookie,
  readRequestOrigin,
} from '#utils/header.js';
import fastifyCookie from '@fastify/cookie';
import createFastify from 'fastify';
import assert from 'node:assert/strict';
import { maxHeaderSize } from 'node:http';
import { describe, test } from 'node:test';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.e30.signature-part_1~+/=';

const MANY = 2500;
const LONG = 100_000;
const INSTANT_MS = 1000;

describe('hasBearerScheme', () => {
  test('is true for the scheme in any case, also with no token or a token of several parts after it', () => {
    [`Bearer ${TOKEN}`, `bearer ${TOKEN}`, `BEARER\t${TOKEN}`, 'Bearer', 'Bearer ', `Bearer ${TOKEN} second-part`].forEach((value) => {
      assert.equal(hasBearerScheme(value), true, JSON.stringify(value));
    });
  });

  test('is false for another scheme, for a word that only begins with it and for what is not a string', () => {
    ['Basic dXNlcjpwYXNzd29yZA==', `Bearer${TOKEN}`, `Token ${TOKEN}`, ` Bearer ${TOKEN}`, '', undefined, null, [`Bearer ${TOKEN}`]].forEach((value) => {
      assert.equal(hasBearerScheme(value), false, JSON.stringify(value));
    });
  });
});

describe('readBearerToken', () => {
  test('reads the token whatever the case of the scheme', () => {
    ['Bearer', 'bearer', 'BEARER', 'bEaReR'].forEach((scheme) => {
      assert.equal(readBearerToken(`${scheme} ${TOKEN}`), TOKEN, scheme);
    });
  });

  test('takes spaces and tabs between the scheme and the token and after the token', () => {
    [
      `Bearer   ${TOKEN}`,
      `Bearer\t${TOKEN}`,
      `Bearer \t ${TOKEN}`,
      `Bearer ${TOKEN}  `,
      `Bearer ${TOKEN}\t`,
    ].forEach((value) => {
      assert.equal(readBearerToken(value), TOKEN, JSON.stringify(value));
    });
  });

  test('gives null for another scheme, an empty token and a token of several parts', () => {
    [
      'Basic dXNlcjpwYXNzd29yZA==',
      `Token ${TOKEN}`,
      'Bearer',
      'Bearer ',
      'Bearer \t ',
      '',
      `Bearer${TOKEN}`,
      `Bearer ${TOKEN} second-part`,
      `Bearer ${TOKEN}\tsecond-part`,
    ].forEach((value) => {
      assert.equal(readBearerToken(value), null, JSON.stringify(value));
    });
  });

  test('gives null for a value that is not a string', () => {
    [undefined, null, 42, [`Bearer ${TOKEN}`], { token: TOKEN }].forEach((value) => {
      assert.equal(readBearerToken(value), null, String(value));
    });
  });
});

describe('readCookie', () => {
  const COOKIE = 'token';

  const CASES = [
    ['token=abc', 'abc'],
    ['first=1; token=abc; last=2', 'abc'],
    ['first=1;token=abc;last=2', 'abc'],
    [' \t token \t = \t abc \t ;\tlast=2', 'abc'],
    ['token=a \t b', 'a \t b'],
    ['flag; token=abc; flag', 'abc'],
    ['token; token=abc', 'abc'],
    ['token', null],
    ['; ;token=abc;', 'abc'],
    ['token=', ''],
    ['token= \t ; last=2', ''],
    ['token=a=b==; last=2', 'a=b=='],
    ['token="abc"', '"abc"'],
    ['token=a,b', 'a,b'],
    ['token=a+b', 'a+b'],
    ['token=a%20b%3B%D1%96', 'a b;і'],
    ['token=%', '%'],
    ['token=%zz%20; last=2', '%zz%20'],
    ['token=%E0%A4%A', '%E0%A4%A'],
    ['token=abc; token=def', 'abc'],
    ['first=1; token=abc; token=def', 'abc'],
    ['token=; token=def', ''],
    ['token=%; token=def', '%'],
    ['xtoken=1; token=abc; tokenx=2', 'abc'],
    ['xtoken=1; tokenx=2; x.token=3; x token=4; token x=5; token.x=6', null],
    ['Token=1; TOKEN=2', null],
    ['other=token=abc', null],
    ['other=a token=abc', null],
    ['other=a,token=abc', null],
    ['=1; token=abc', 'abc'],
    ['other=1', null],
  ];

  // With its hook on, as it is by default: every cookie of the header is read.
  async function startWithCookies(t) {
    const fastify = createFastify();

    t.after(() => fastify.close());
    fastify.register(fastifyCookie);
    fastify.get('/', async (request) => request.cookies);

    return fastify;
  }

  test('gives the value request.cookies of @fastify/cookie would hold', async (t) => {
    const fastify = await startWithCookies(t);
    const responses = await Promise.all(CASES.map(([cookie]) => fastify.inject({ url: '/', headers: { cookie } })));

    CASES.forEach(([header, expected], index) => {
      assert.equal(readCookie(header, COOKIE), expected, JSON.stringify(header));
      assert.equal(responses[index].json()[COOKIE] ?? null, expected, JSON.stringify(header));
    });
  });

  test('reads back what reply.setCookie() has written, whatever the value', async (t) => {
    const values = ['plain', '', ' a b ', 'a;b=c, "d" \\ e', '100%', '%20', 'Привіт 😀'];
    const fastify = await startWithCookies(t);

    fastify.get('/set', async (request, reply) => {
      values.forEach((value, index) => reply.setCookie(`cookie${index}`, value));
    });

    const { headers } = await fastify.inject('/set');
    const header = headers['set-cookie'].map((line) => line.slice(0, line.indexOf(';'))).join('; ');

    assert.deepEqual(values.map((value, index) => readCookie(header, `cookie${index}`)), values);
  });

  test('takes the name letter by letter, whatever it would mean in a regular expression', () => {
    ['a.b', 'a+b', 'a*b', 'a|b', '$a', '^a', '(a)', '[a]', '{1}', 'a\\b', '__proto__', 'constructor'].forEach((name) => {
      const others = 'a=0; b=0; ab=0; aab=0; axb=0; xa=0; 1=0';

      assert.equal(readCookie(others, name), null, name);
      assert.equal(readCookie(`${others}; ${name}=1`, name), '1', name);
    });
  });

  test('gives null for no header, for a name that is not there and for a value that is not a string', () => {
    [undefined, null, '', 'other=1', 42, ['token=abc'], { token: 'abc' }].forEach((value) => {
      assert.equal(readCookie(value, COOKIE), null, JSON.stringify(value));
    });
  });

  test('decodes no cookie but the one it is asked for, however many a client sends', (t) => {
    const broken = Array.from({ length: MANY }, (unused, index) => `c${index}=%`).join('; ');
    const decode = t.mock.method(globalThis, 'decodeURIComponent');

    assert.ok(broken.length > maxHeaderSize);
    assert.equal(readCookie(`${broken}; token=a%20b; ${broken}`, COOKIE), 'a b');
    assert.equal(readCookie(broken, COOKIE), null);
    assert.equal(decode.mock.callCount(), 1);
    assert.deepEqual(decode.mock.calls[0].arguments, ['a%20b']);
  });

  test('answers instantly on a long hostile header', () => {
    const spaces = ' '.repeat(LONG);
    const startedAt = performance.now();

    assert.equal(readCookie(spaces, COOKIE), null);
    assert.equal(readCookie(`${spaces}token${spaces}=${spaces}abc${spaces}`, COOKIE), 'abc');
    assert.equal(readCookie(`token=a${spaces}b`, COOKIE), `a${spaces}b`);
    assert.equal(readCookie(`token${spaces}`, COOKIE), null);
    [';', '; ', ' ;', '=', 'token', 'token ', 'token;', '; token', 'a=%; '].forEach((piece) => {
      assert.equal(readCookie(piece.repeat(LONG / piece.length), COOKIE), null, piece);
    });

    assert.ok(performance.now() - startedAt < INSTANT_MS);
  });
});

describe('readRequestOrigin', () => {
  test('reads the origin of Origin as a browser writes it: scheme and host in lower case, with the port', () => {
    assert.equal(readRequestOrigin({ origin: 'https://App.Example.COM' }), 'https://app.example.com');
    assert.equal(readRequestOrigin({ origin: 'HTTP://APP.EXAMPLE.COM:8080' }), 'http://app.example.com:8080');
    assert.equal(readRequestOrigin({ origin: 'http://[::1]:4173' }), 'http://[::1]:4173');
  });

  test('drops the port that is the default one of the scheme, and only that one', () => {
    assert.equal(readRequestOrigin({ origin: 'https://app.example.com:443' }), 'https://app.example.com');
    assert.equal(readRequestOrigin({ origin: 'http://app.example.com:80' }), 'http://app.example.com');
    assert.equal(readRequestOrigin({ origin: 'http://app.example.com:443' }), 'http://app.example.com:443');
  });

  test('keeps the scheme apart: the same host over http is another origin', () => {
    assert.notEqual(readRequestOrigin({ origin: 'http://app.example.com' }), readRequestOrigin({ origin: 'https://app.example.com' }));
  });

  test('reads the origin of Referer when there is no Origin, without its credentials, path and query', () => {
    assert.equal(
      readRequestOrigin({ referer: 'https://user:secret@App.Example.com:8443/page?token=secret#top' }),
      'https://app.example.com:8443',
    );
  });

  test('takes Origin over Referer', () => {
    assert.equal(readRequestOrigin({ origin: 'https://a.example.com', referer: 'https://b.example.com/page' }), 'https://a.example.com');
  });

  test('gives an empty origin for "Origin: null", a value it cannot parse and an address of no origin, without falling back to Referer', () => {
    assert.equal(readRequestOrigin({ origin: 'null' }), '');
    assert.equal(readRequestOrigin({ origin: 'null', referer: 'https://app.example.com/page' }), '');
    assert.equal(readRequestOrigin({ origin: 'not a url' }), '');
    assert.equal(readRequestOrigin({ origin: '' }), '');
    assert.equal(readRequestOrigin({ referer: 'app.example.com/page' }), '');
    assert.equal(readRequestOrigin({ origin: 'file:///etc/passwd' }), '');
    assert.equal(readRequestOrigin({ referer: 'data:text/html,hi' }), '');
    assert.equal(readRequestOrigin({ origin: 'chrome-extension://abcdef' }), '');
  });

  test('gives null when neither header is there', () => {
    assert.equal(readRequestOrigin({}), null);
    assert.equal(readRequestOrigin({ authorization: `Bearer ${TOKEN}` }), null);
    assert.equal(readRequestOrigin({ origin: undefined, referer: undefined }), null);
    assert.equal(readRequestOrigin(undefined), null);
  });
});
