import { readBearerToken, readOriginHost } from '#utils/header.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.e30.signature-part_1~+/=';

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

describe('readOriginHost', () => {
  test('reads the host of Origin in lower case, with its port', () => {
    assert.equal(readOriginHost({ origin: 'https://App.Example.COM' }), 'app.example.com');
    assert.equal(readOriginHost({ origin: 'HTTP://APP.EXAMPLE.COM:8080' }), 'app.example.com:8080');
    assert.equal(readOriginHost({ origin: 'http://[::1]:4173' }), '[::1]:4173');
  });

  test('drops the port that is the default one of the scheme, and only that one', () => {
    assert.equal(readOriginHost({ origin: 'https://app.example.com:443' }), 'app.example.com');
    assert.equal(readOriginHost({ origin: 'http://app.example.com:80' }), 'app.example.com');
    assert.equal(readOriginHost({ origin: 'http://app.example.com:443' }), 'app.example.com:443');
  });

  test('reads the host of Referer when there is no Origin, without its credentials, path and query', () => {
    assert.equal(
      readOriginHost({ referer: 'https://user:secret@App.Example.com:8443/page?token=secret#top' }),
      'app.example.com:8443',
    );
  });

  test('takes Origin over Referer', () => {
    assert.equal(readOriginHost({ origin: 'https://a.example.com', referer: 'https://b.example.com/page' }), 'a.example.com');
  });

  test('gives an empty host for "Origin: null" and for a value it cannot parse, without falling back to Referer', () => {
    assert.equal(readOriginHost({ origin: 'null' }), '');
    assert.equal(readOriginHost({ origin: 'null', referer: 'https://app.example.com/page' }), '');
    assert.equal(readOriginHost({ origin: 'not a url' }), '');
    assert.equal(readOriginHost({ origin: '' }), '');
    assert.equal(readOriginHost({ referer: 'app.example.com/page' }), '');
  });

  test('gives null when neither header is there', () => {
    assert.equal(readOriginHost({}), null);
    assert.equal(readOriginHost({ authorization: `Bearer ${TOKEN}` }), null);
    assert.equal(readOriginHost({ origin: undefined, referer: undefined }), null);
    assert.equal(readOriginHost(undefined), null);
  });
});
