import {
  EMAIL_MAX_LENGTH,
  REDIRECT_PATH_MAX_LENGTH,
  URL_MAX_LENGTH,
  ipInCidr,
  isCidr,
  isEmail,
  isHostname,
  isLoopbackAddress,
  isLoopbackHostname,
  isPhone,
  isPrivateAddress,
  isSafeRedirectPath,
  isWebUrl,
  toHostAddress,
  toIpAddress,
  toValidEmail,
} from '#utils/validate.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const INSTANT_MS = 500;
const HOSTILE_LENGTH = 100000;

const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7F);
const TAB = String.fromCharCode(9);
const LINE_FEED = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(0x5C);
const SCRIPT_URL = ['javascript', 'alert(1)'].join(':');

const NOT_STRINGS = [null, undefined, 0, 1, true, {}, [], ['127.0.0.1'], { toString: () => '127.0.0.1' }];

// Spellings that some resolvers read as an address, but that are not the canonical text of one.
const NOT_CANONICAL_ADDRESSES = [
  '',
  'localhost',
  ' 127.0.0.1',
  '127.0.0.1 ',
  `127.0.0.1${LINE_FEED}`,
  '127.1',
  '2130706433',
  '0x7f.0.0.1',
  '0177.0.0.1',
  '010.0.0.1',
  '127.0.0.1:80',
  '127.0.0.256',
  '[::1]',
  '[::1]:80',
  '::1/128',
  '::g',
  '1:2:3:4:5:6:7:8:9',
];

function assertAll(predicate, values, expected) {
  values.forEach((value) => {
    assert.equal(predicate(value), expected, `${predicate.name}(${JSON.stringify(value)})`);
  });
}

function measure(fn) {
  const startedAt = performance.now();

  fn();

  return performance.now() - startedAt;
}

describe('isEmail', () => {
  test('accepts an address of the shape local@domain.tld', () => {
    assertAll(isEmail, [
      'john@example.com',
      'john.doe+tag@mail.example.co.uk',
      'user_name@example.io',
      "o'brien@example.com",
      'a@b.c',
      'josé@example.com',
      'іван@приклад.укр',
    ], true);
  });

  test('checks the normalized form: letter case and outer whitespace do not matter', () => {
    assertAll(isEmail, ['John@Example.COM', '  john@example.com  ', `john@example.com${LINE_FEED}`], true);
  });

  test('rejects an address without exactly one "@" or with an empty side', () => {
    assertAll(isEmail, ['', 'john', 'john.example.com', '@example.com', 'john@', 'john@@example.com', 'john@doe@example.com'], false);
  });

  test('rejects a domain without a dot or with an empty label', () => {
    assertAll(isEmail, ['john@localhost', 'john@.com', 'john@example.', 'john@example..com', 'john@.'], false);
  });

  test('rejects whitespace and control characters inside the address', () => {
    assertAll(isEmail, [
      'john doe@example.com',
      'john@exa mple.com',
      `john${TAB}@example.com`,
      `john@example.com${LINE_FEED}bcc@example.com`,
      `john${NUL}@example.com`,
      `john@example${DEL}.com`,
    ], false);
  });

  test('accepts 254 characters and rejects 255', () => {
    const domain = '@example.com';

    assert.equal(isEmail(`${'a'.repeat(254 - domain.length)}${domain}`), true);
    assert.equal(isEmail(`${'a'.repeat(255 - domain.length)}${domain}`), false);
  });

  test('rejects what is not a string, even when its text form is an address', () => {
    assertAll(isEmail, [...NOT_STRINGS, ['john@example.com'], { toString: () => 'john@example.com' }], false);
  });

  test('answers instantly on a long hostile input', () => {
    const inputs = [
      'a'.repeat(HOSTILE_LENGTH),
      '@'.repeat(HOSTILE_LENGTH),
      `a@${'a.'.repeat(HOSTILE_LENGTH / 2)}`,
      `${'a'.repeat(HOSTILE_LENGTH / 2)}@${'.'.repeat(HOSTILE_LENGTH / 2)}`,
      `a@${'.a'.repeat(120)} `,
    ];

    assert.ok(measure(() => assertAll(isEmail, inputs, false)) < INSTANT_MS);
  });
});

describe('EMAIL_MAX_LENGTH', () => {
  test('is the length of the longest address isEmail accepts, whichever side of the "@" is long', () => {
    const longLocal = `${'a'.repeat(EMAIL_MAX_LENGTH - '@example.com'.length)}@example.com`;
    const longDomain = `a@${'b'.repeat(EMAIL_MAX_LENGTH - 'a@.com'.length)}.com`;

    [longLocal, longDomain].forEach((address) => {
      assert.equal(address.length, EMAIL_MAX_LENGTH);
      assert.equal(isEmail(address), true);
      assert.equal(isEmail(`a${address}`), false);
    });
  });

  test('is measured on the address isEmail checks: the outer whitespace it trims is not counted', () => {
    const address = `${'a'.repeat(EMAIL_MAX_LENGTH - '@example.com'.length)}@example.com`;

    assert.equal(isEmail(`  ${address}  `), true);
    assert.equal(isEmail(`  a${address}  `), false);
  });
});

describe('toValidEmail', () => {
  test('gives an email in the form it is stored and searched in: trimmed, in lower case and NFC', () => {
    assert.equal(toValidEmail('  Anna@Example.COM '), 'anna@example.com');
    assert.equal(toValidEmail('Ce\u0301line@example.com'), 'c\u00e9line@example.com');
  });

  test('gives null for what is no email, a text that is not one included', () => {
    ['anna.example.com', '', ' ', null, undefined, 42, {}, `${'a'.repeat(EMAIL_MAX_LENGTH)}@example.com`].forEach((value) => {
      assert.equal(toValidEmail(value), null);
    });
  });
});

describe('isPhone', () => {
  test('accepts a number the way people type it', () => {
    assertAll(isPhone, ['+380501234567', '380 50 123 45 67', '+1 (415) 555-2671', '050.123.45.67', '1234567', '123456789012345'], true);
  });

  test('rejects letters, too few and too many digits', () => {
    assertAll(isPhone, ['', 'phone', '+38050123456x', '123456', '1234567890123456', '+', '()'], false);
  });

  test('rejects what is not a string, a number included', () => {
    assertAll(isPhone, [...NOT_STRINGS, 380501234567], false);
  });
});

describe('isCidr', () => {
  test('accepts an IPv4 block', () => {
    assertAll(isCidr, ['10.0.0.0/8', '192.168.1.0/24', '0.0.0.0/0', '1.2.3.4/32', '172.16.0.0/12'], true);
  });

  test('accepts an IPv6 block', () => {
    assertAll(isCidr, ['::/0', '::1/128', 'fd00::/8', '2001:db8::/32', 'FE80::/10', '::ffff:10.0.0.0/104'], true);
  });

  test('accepts an address with host bits set: the prefix alone defines the block', () => {
    assertAll(isCidr, ['10.1.2.3/8', '2001:db8::1/32'], true);
  });

  test('rejects a prefix length that is missing or out of range', () => {
    assertAll(isCidr, ['10.0.0.0', '10.0.0.0/', '/8', '10.0.0.0/33', '::/129', '10.0.0.0/999', '::/1000'], false);
  });

  test('rejects a prefix length that is not a plain decimal integer', () => {
    assertAll(isCidr, ['10.0.0.0/+8', '10.0.0.0/-8', '10.0.0.0/08', '10.0.0.0/ 8', '10.0.0.0/8 ', '10.0.0.0/8.0', '10.0.0.0/0x8', '10.0.0.0/8/8', '10.0.0.0/a'], false);
  });

  test('rejects an address that is not canonical or carries a zone', () => {
    assertAll(isCidr, ['10.0.0/8', '010.0.0.0/8', ' 10.0.0.0/8', 'localhost/8', 'fe80::1%eth0/64', '[::1]/128'], false);
  });

  test('rejects what is not a string', () => {
    assertAll(isCidr, NOT_STRINGS, false);
  });

  test('answers instantly on a long hostile input', () => {
    const inputs = ['/'.repeat(HOSTILE_LENGTH), `10.0.0.0/${'1'.repeat(HOSTILE_LENGTH)}`, `${'1.'.repeat(HOSTILE_LENGTH)}/8`];

    assert.ok(measure(() => assertAll(isCidr, inputs, false)) < INSTANT_MS);
  });
});

describe('ipInCidr', () => {
  test('includes the first and the last address of an IPv4 block and nothing next to it', () => {
    assert.equal(ipInCidr('10.0.0.0', '10.0.0.0/8'), true);
    assert.equal(ipInCidr('10.255.255.255', '10.0.0.0/8'), true);
    assert.equal(ipInCidr('9.255.255.255', '10.0.0.0/8'), false);
    assert.equal(ipInCidr('11.0.0.0', '10.0.0.0/8'), false);
    assert.equal(ipInCidr('192.168.1.255', '192.168.1.0/24'), true);
    assert.equal(ipInCidr('192.168.2.0', '192.168.1.0/24'), false);
  });

  test('treats /32 as one address and /0 as all of them', () => {
    assert.equal(ipInCidr('1.2.3.4', '1.2.3.4/32'), true);
    assert.equal(ipInCidr('1.2.3.5', '1.2.3.4/32'), false);
    assert.equal(ipInCidr('203.0.113.7', '0.0.0.0/0'), true);
    assert.equal(ipInCidr('2001:db8::1', '::/0'), true);
  });

  test('includes the first and the last address of an IPv6 block and nothing next to it', () => {
    assert.equal(ipInCidr('fd00::', 'fd00::/8'), true);
    assert.equal(ipInCidr('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fd00::/8'), true);
    assert.equal(ipInCidr('fcff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fd00::/8'), false);
    assert.equal(ipInCidr('fe00::', 'fd00::/8'), false);
    assert.equal(ipInCidr('::1', '::1/128'), true);
    assert.equal(ipInCidr('::2', '::1/128'), false);
  });

  test('reads letter case and the long form of an IPv6 address alike', () => {
    assert.equal(ipInCidr('FD00::1', 'fd00::/8'), true);
    assert.equal(ipInCidr('fd00:0:0:0:0:0:0:1', 'FD00::/8'), true);
  });

  test('matches an IPv4-mapped IPv6 address against an IPv4 block as the IPv4 address it carries', () => {
    assert.equal(ipInCidr('::ffff:10.0.0.1', '10.0.0.0/8'), true);
    assert.equal(ipInCidr('::ffff:a00:1', '10.0.0.0/8'), true);
    assert.equal(ipInCidr('::ffff:11.0.0.1', '10.0.0.0/8'), false);
  });

  test('does not match an IPv4 address against an IPv6 block, except the block of the mapped form', () => {
    assert.equal(ipInCidr('10.0.0.1', 'fd00::/8'), false);
    assert.equal(ipInCidr('10.0.0.1', '::ffff:0:0/96'), true);
  });

  test('ignores the zone of a link-local address', () => {
    assert.equal(ipInCidr('fe80::1%eth0', 'fe80::/10'), true);
  });

  test('ignores host bits of the block address', () => {
    assert.equal(ipInCidr('10.9.9.9', '10.1.2.3/8'), true);
  });

  test('returns false for an invalid address or block', () => {
    assert.equal(ipInCidr('10.0.0.1', '10.0.0.0'), false);
    assert.equal(ipInCidr('10.0.0.1', '10.0.0.0/33'), false);
    assert.equal(ipInCidr('10.0.0.1', 'fe80::1%eth0/64'), false);
    assert.equal(ipInCidr('10.0.0.1/8', '10.0.0.0/8'), false);

    NOT_CANONICAL_ADDRESSES.forEach((address) => {
      assert.equal(ipInCidr(address, '0.0.0.0/0'), false, `ipInCidr(${JSON.stringify(address)})`);
      assert.equal(ipInCidr(address, '::/0'), false, `ipInCidr(${JSON.stringify(address)})`);
    });
  });

  test('returns false for what is not a string', () => {
    NOT_STRINGS.forEach((value) => {
      assert.equal(ipInCidr(value, '0.0.0.0/0'), false);
      assert.equal(ipInCidr('10.0.0.1', value), false);
    });
  });
});

describe('toIpAddress', () => {
  test('gives an address of either family back as it is written, a zone included', () => {
    ['203.0.113.7', '2001:db8::1', 'FE80::1%eth0', '::ffff:203.0.113.7', '1111:2222:3333:4444:5555:6666:123.123.123.123'].forEach((address) => {
      assert.equal(toIpAddress(address), address);
    });
  });

  test('gives null for a text that is no address, for an address longer than a column of them and for what is not a string', () => {
    [...NOT_CANONICAL_ADDRESSES, 'unknown', '203.0.113.7, 10.0.0.1', `fe80::1%${'z'.repeat(60)}`].forEach((value) => {
      assert.equal(toIpAddress(value), null, JSON.stringify(value));
    });
    NOT_STRINGS.forEach((value) => assert.equal(toIpAddress(value), null));
  });
});

describe('isLoopbackAddress', () => {
  test('accepts the whole 127.0.0.0/8 and ::1', () => {
    assertAll(isLoopbackAddress, ['127.0.0.1', '127.0.0.0', '127.255.255.255', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1'], true);
  });

  test('accepts the IPv4-mapped form of an IPv4 loopback address', () => {
    assertAll(isLoopbackAddress, ['::ffff:127.0.0.1', '::FFFF:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1'], true);
  });

  test('ignores the zone of ::1', () => {
    assert.equal(isLoopbackAddress('::1%lo'), true);
  });

  test('rejects the addresses next to the loopback blocks and other addresses', () => {
    assertAll(isLoopbackAddress, [
      '126.255.255.255',
      '128.0.0.0',
      '0.0.0.0',
      '10.0.0.1',
      '192.168.0.1',
      '::',
      '::2',
      '::ffff:126.255.255.255',
      '::ffff:128.0.0.0',
      '::127.0.0.1',
      'fe80::1',
    ], false);
  });

  test('rejects a host name and every spelling that is not the canonical text of an address', () => {
    assertAll(isLoopbackAddress, NOT_CANONICAL_ADDRESSES, false);
  });

  test('rejects what is not a string', () => {
    assertAll(isLoopbackAddress, NOT_STRINGS, false);
  });
});

describe('toHostAddress', () => {
  test('takes the brackets off an IPv6 hostname, as URL writes it, and leaves any other as it is', () => {
    assert.deepEqual(['[::1]', '[2001:db8::1]', '127.0.0.1', 'example.com', 'localhost'].map((hostname) => toHostAddress(hostname)), ['::1', '2001:db8::1', '127.0.0.1', 'example.com', 'localhost']);
  });

  test('leaves a bracket without its pair, and gives a text for what is no text', () => {
    assert.deepEqual(['[::1', '::1]', '[]'].map((hostname) => toHostAddress(hostname)), ['[::1', '::1]', '']);
    assert.deepEqual([null, undefined].map((hostname) => toHostAddress(hostname)), ['', '']);
  });
});

describe('isLoopbackHostname', () => {
  test('accepts localhost and a loopback address, an IPv6 one in brackets too', () => {
    assertAll(isLoopbackHostname, ['localhost', '127.0.0.1', '127.8.9.10', '[::1]', '::1', '[::ffff:7f00:1]'], true);
  });

  test('refuses a name any resolver may send elsewhere and every other address', () => {
    assertAll(isLoopbackHostname, ['app.localhost', 'localhost.example.com', 'LOCALHOST', '10.0.0.1', '[fe80::1]', '', null, undefined], false);
  });
});

describe('isHostname', () => {
  test('takes a host as the hostname of a URL writes it: a name in lower case and punycode, localhost and an IPv4 address', () => {
    assertAll(isHostname, ['googleusercontent.com', 't.me', 'cdn.example.com', 'xn--80ak6aa92e.example', 'localhost', '127.0.0.1'], true);
  });

  test('refuses what a URL would write otherwise or not take as a host: upper case, Unicode, a port, a path, credentials, a scheme, a space, a short IPv4 form, an IPv6 address', () => {
    assertAll(isHostname, [
      'Cdn.Example.com',
      'приклад.example',
      'cdn.example.com:443',
      'cdn.example.com/avatars',
      'anna@cdn.example.com',
      'https://cdn.example.com',
      'cdn example.com',
      '127.1',
      '[::1]',
      '::1',
      '',
    ], false);
  });

  test('refuses what is not a string, even when its text form is a host', () => {
    assertAll(isHostname, NOT_STRINGS, false);
  });
});

describe('isPrivateAddress', () => {
  // [first address, last address, the address before the block, the address after it]
  const IPV4_BLOCKS = [
    ['0.0.0.0', '0.255.255.255', null, '1.0.0.0'],
    ['10.0.0.0', '10.255.255.255', '9.255.255.255', '11.0.0.0'],
    ['100.64.0.0', '100.127.255.255', '100.63.255.255', '100.128.0.0'],
    ['127.0.0.0', '127.255.255.255', '126.255.255.255', '128.0.0.0'],
    ['169.254.0.0', '169.254.255.255', '169.253.255.255', '169.255.0.0'],
    ['172.16.0.0', '172.31.255.255', '172.15.255.255', '172.32.0.0'],
    ['192.0.0.0', '192.0.0.255', '191.255.255.255', '192.0.1.0'],
    ['192.0.2.0', '192.0.2.255', '192.0.1.255', '192.0.3.0'],
    ['192.88.99.0', '192.88.99.255', '192.88.98.255', '192.88.100.0'],
    ['192.168.0.0', '192.168.255.255', '192.167.255.255', '192.169.0.0'],
    ['198.18.0.0', '198.19.255.255', '198.17.255.255', '198.20.0.0'],
    ['198.51.100.0', '198.51.100.255', '198.51.99.255', '198.51.101.0'],
    ['203.0.113.0', '203.0.113.255', '203.0.112.255', '203.0.114.0'],
    ['224.0.0.0', '239.255.255.255', '223.255.255.255', null],
    ['240.0.0.0', '255.255.255.255', null, null],
  ];

  const IPV6_BLOCKS = [
    ['::', '::ffff:ffff', null, '::1:0:0'],
    ['64:ff9b:1::', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '64:ff9b:0:ffff:ffff:ffff:ffff:ffff', '64:ff9b:2::'],
    ['100::', '100::ffff:ffff:ffff:ffff', 'ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '100:0:0:1::'],
    ['2001:2::', '2001:2:0:ffff:ffff:ffff:ffff:ffff', '2001:1:ffff:ffff:ffff:ffff:ffff:ffff', '2001:2:1::'],
    ['2001:10::', '2001:1f:ffff:ffff:ffff:ffff:ffff:ffff', '2001:f:ffff:ffff:ffff:ffff:ffff:ffff', '2001:20::'],
    ['2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', '2001:db9::'],
    ['3fff::', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '3fff:1000::'],
    ['5f00::', '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '5f01::'],
    ['fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fe00::'],
    ['fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff', null],
    ['fec0::', 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', null, null],
    ['ff00::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', null, null],
  ];

  function assertBlocks(blocks) {
    blocks.forEach(([first, last, before, after]) => {
      assertAll(isPrivateAddress, [first, last], true);
      assertAll(isPrivateAddress, [before, after].filter(Boolean), false);
    });
  }

  test('accepts the first and the last address of every special IPv4 block and rejects the neighbours', () => {
    assertBlocks(IPV4_BLOCKS);
  });

  test('accepts the first and the last address of every special IPv6 block and rejects the neighbours', () => {
    assertBlocks(IPV6_BLOCKS);
  });

  test('accepts the addresses an SSRF guard is there for', () => {
    assertAll(isPrivateAddress, ['127.0.0.1', '0.0.0.0', '169.254.169.254', '10.0.0.1', '172.17.0.1', '192.168.1.1', '100.100.100.200', '::1', '::', 'fd00:ec2::254', 'fe80::1'], true);
  });

  test('rejects public addresses', () => {
    assertAll(isPrivateAddress, [
      '1.1.1.1',
      '8.8.8.8',
      '93.184.216.34',
      '172.15.0.1',
      '192.167.0.1',
      '2001:4860:4860::8888',
      '2606:4700:4700::1111',
      '2a00:1450:4001:81b::200e',
    ], false);
  });

  test('judges an IPv4-mapped address by the IPv4 address it carries', () => {
    assertAll(isPrivateAddress, ['::ffff:10.0.0.1', '::ffff:a00:1', '::FFFF:127.0.0.1', '::ffff:169.254.169.254', '0:0:0:0:0:ffff:c0a8:101'], true);
    assertAll(isPrivateAddress, ['::ffff:8.8.8.8', '::ffff:808:808', '::ffff:11.0.0.0'], false);
  });

  test('judges a NAT64 address by the IPv4 address it carries', () => {
    assertAll(isPrivateAddress, ['64:ff9b::10.0.0.1', '64:ff9b::a00:1', '64:ff9b::127.0.0.1', '64:ff9b::169.254.169.254', '64:ff9b::', '64:ff9b::ffff:ffff'], true);
    assertAll(isPrivateAddress, ['64:ff9b::8.8.8.8', '64:ff9b::808:808', '64:ff9b::9.255.255.255', '64:ff9b::11.0.0.0'], false);
  });

  test('judges a 6to4 address by the IPv4 address it carries', () => {
    assertAll(isPrivateAddress, ['2002:a00:1::1', '2002:7f00:1::', '2002:c0a8:101::1', '2002:a9fe:a9fe::1', '2002::', '2002:ffff:ffff::1'], true);
    assertAll(isPrivateAddress, ['2002:808:808::1', '2002:9ff:ffff:ffff:ffff:ffff:ffff:ffff', '2002:b00::'], false);
  });

  test('treats the deprecated IPv4-compatible form as not public, whatever it carries', () => {
    assertAll(isPrivateAddress, ['::8.8.8.8', '::127.0.0.1', '::a00:1'], true);
  });

  test('leaves a Teredo address public: the IPv4 address inside it is obfuscated and no route leads inside', () => {
    assert.equal(isPrivateAddress('2001:0:4136:e378:8000:63bf:3fff:fdd2'), false);
  });

  test('ignores the zone and the letter case of an IPv6 address', () => {
    assertAll(isPrivateAddress, ['fe80::1%eth0', 'FE80::1', 'FC00::1', 'FD12:3456:789A::1'], true);
  });

  test('returns false for what is not the canonical text of an address: an SSRF guard checks validity on its own', () => {
    assertAll(isPrivateAddress, [...NOT_CANONICAL_ADDRESSES, '10.1', '167772161', '0xa.0.0.1', '012.0.0.1', '[fc00::1]', '10.0.0.1:80', '10.0.0.1/8'], false);
  });

  test('rejects what is not a string', () => {
    assertAll(isPrivateAddress, NOT_STRINGS, false);
  });
});

describe('isWebUrl', () => {
  test('takes an http or https address without credentials', () => {
    ['https://hooks.example.com/services/T/B/X', 'http://127.0.0.1:8080/hook?token=abc', 'https://EXAMPLE.com'].forEach((value) => {
      assert.equal(isWebUrl(value), true, value);
    });
  });

  test('refuses credentials, which fetch() refuses to send, another scheme, and what is not an address', () => {
    ['https://user:pass@hooks.example.com/x', 'https://user@hooks.example.com/x', 'https://:pass@hooks.example.com/x', 'ftp://example.com/x', 'mailto:anna@example.com', 'file:///etc/passwd', '//example.com/x', 'not a url', '', null, 42, new URL('https://example.com')].forEach((value) => {
      assert.equal(isWebUrl(value), false, String(value));
    });
  });
});

describe('URL_MAX_LENGTH', () => {
  test('is 2048, the longest address that browsers, proxies and CDNs all take', () => {
    assert.equal(URL_MAX_LENGTH, 2048);
  });
});

describe('isSafeRedirectPath', () => {
  test('accepts a local path with a query and a fragment', () => {
    assertAll(isSafeRedirectPath, ['/', '/dashboard', '/users/0198c0de-0000-7000-8000-000000000000', '/search?q=a%20b&page=2#results', "/~user/it's", '/@evil.com'], true);
  });

  test('rejects a segment of one or two dots, also spelled %2e in any case: URL parsing removes it, and "/.//evil.com" leaves the pathname "//evil.com"', () => {
    assertAll(isSafeRedirectPath, [
      '/.//evil.com',
      '/..//evil.com',
      '/%2e//evil.com',
      '/%2E%2e//evil.com',
      '/.%2E//evil.com',
      '/%2e.//evil.com',
      '/a/../b',
      '/a/./b',
      '/a/..',
      '/.',
      '/..',
      '/./?next=/',
      '/..#top',
    ], false);
    assert.equal(new URL('/.//evil.com', 'https://app.test').pathname, '//evil.com');
    assert.equal(new URL('/%2E%2e//evil.com', 'https://app.test').pathname, '//evil.com');
  });

  test('accepts dots that are not a whole segment, and dot segments of the query or the fragment', () => {
    assertAll(isSafeRedirectPath, ['/a.b', '/.well-known/x', '/...', '/%2e%2e%2e', '/a/..b', '/a/.%2e./b', '/%2ea', '/search?path=/../x', '/page#/./x'], true);
  });

  test('rejects a target on another host', () => {
    assertAll(isSafeRedirectPath, ['//evil.com', '//evil.com/path', '///evil.com', 'https://evil.com', 'http:/evil.com', SCRIPT_URL, 'evil.com', 'dashboard', ''], false);
  });

  test('rejects a backslash: browsers read it as a slash', () => {
    assertAll(isSafeRedirectPath, [`/${BACKSLASH}evil.com`, `/${BACKSLASH}/evil.com`, `/a${BACKSLASH}b`, `${BACKSLASH}/evil.com`], false);
  });

  test('rejects whitespace and control characters: browsers drop them and the path becomes "//evil.com"', () => {
    assertAll(isSafeRedirectPath, [`/${TAB}/evil.com`, `/${LINE_FEED}/evil.com`, '/ /evil.com', ' /dashboard', '/dashboard ', `/a${NUL}`, `/a${DEL}`], false);
  });

  test('rejects characters outside ASCII: a Location header cannot carry them, an encoded path can', () => {
    assert.equal(isSafeRedirectPath('/шлях'), false);
    assert.equal(isSafeRedirectPath('/café'), false);
    assert.equal(isSafeRedirectPath('/%D1%88%D0%BB%D1%8F%D1%85'), true);
  });

  test('accepts REDIRECT_PATH_MAX_LENGTH characters, 512, and rejects one more', () => {
    assert.equal(REDIRECT_PATH_MAX_LENGTH, 512);
    assert.equal(isSafeRedirectPath(`/${'a'.repeat(REDIRECT_PATH_MAX_LENGTH - 1)}`), true);
    assert.equal(isSafeRedirectPath(`/${'a'.repeat(REDIRECT_PATH_MAX_LENGTH)}`), false);
  });

  test('rejects what is not a string', () => {
    assertAll(isSafeRedirectPath, NOT_STRINGS, false);
  });

  test('answers instantly on a long hostile input', () => {
    const inputs = [`/${'a'.repeat(HOSTILE_LENGTH)}`, '/'.repeat(HOSTILE_LENGTH), `/${BACKSLASH.repeat(HOSTILE_LENGTH)}`];

    assert.ok(measure(() => assertAll(isSafeRedirectPath, inputs, false)) < INSTANT_MS);
  });
});
