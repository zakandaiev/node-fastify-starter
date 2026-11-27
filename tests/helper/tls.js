import { addToDate, getStartOfDay, nowUtc } from '#utils/date.js';
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import tls from 'node:tls';

const TAG = Object.freeze({
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  UTF8_STRING: 0x0C,
  SEQUENCE: 0x30,
  SET: 0x31,
  UTC_TIME: 0x17,
  DNS_NAME: 0x82,
  IP_ADDRESS: 0x87,
  VERSION: 0xA0,
  EXTENSIONS: 0xA3,
});

// The object identifiers as DER writes them: Ed25519 1.3.101.112, commonName 2.5.4.3, subjectAltName 2.5.29.17.
const ED25519 = Buffer.from([0x06, 0x03, 0x2B, 0x65, 0x70]);
const COMMON_NAME = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
const SUBJECT_ALT_NAME = Buffer.from([0x06, 0x03, 0x55, 0x1D, 0x11]);

const VERSION_3 = 2;
const SERIAL_NUMBER = 1;
const NO_UNUSED_BITS = 0;
const LONG_LENGTH = 0x80;
const BYTE_VALUES = 256;
const VALIDITY = '1d';

// "2026-11-27T10:20:30.000Z" is the UTCTime "261127102030Z".
const UTC_TIME_REGEXP = /^\d{2}(\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;
const UTC_TIME_ZONE = 'Z';

function toLengthBytes(length) {
  if (length < LONG_LENGTH) {
    return [length];
  }

  const bytes = [];
  let rest = length;

  while (rest > 0) {
    bytes.unshift(rest % BYTE_VALUES);
    rest = Math.floor(rest / BYTE_VALUES);
  }

  return [LONG_LENGTH + bytes.length, ...bytes];
}

function encode(tag, ...contents) {
  const body = Buffer.concat(contents);

  return Buffer.concat([Buffer.from([tag, ...toLengthBytes(body.length)]), body]);
}

function toUtcTime(date) {
  const [, ...parts] = UTC_TIME_REGEXP.exec(date.toISOString());

  return encode(TAG.UTC_TIME, Buffer.from(`${parts.join('')}${UTC_TIME_ZONE}`));
}

function toName(host) {
  return encode(TAG.SEQUENCE, encode(TAG.SET, encode(TAG.SEQUENCE, COMMON_NAME, encode(TAG.UTF8_STRING, Buffer.from(host)))));
}

function toAltNames(host) {
  const name = isIP(host)
    ? encode(TAG.IP_ADDRESS, Buffer.from(host.split('.').map(Number)))
    : encode(TAG.DNS_NAME, Buffer.from(host));

  return encode(TAG.EXTENSIONS, encode(TAG.SEQUENCE, encode(TAG.SEQUENCE, SUBJECT_ALT_NAME, encode(TAG.OCTET_STRING, encode(TAG.SEQUENCE, name)))));
}

// node:crypto signs but writes no certificate, so a file of one would have to be committed: this is an X.509 v3 in DER by
// hand, of an Ed25519 key that signs itself, from the start of the day for a day. The key and the certificate come in
// PEM, for a TLS server of a host name or an IPv4 address.
export function createCertificate(host) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const now = nowUtc();
  const name = toName(host);
  const signed = encode(
    TAG.SEQUENCE,
    encode(TAG.VERSION, encode(TAG.INTEGER, Buffer.from([VERSION_3]))),
    encode(TAG.INTEGER, Buffer.from([SERIAL_NUMBER])),
    encode(TAG.SEQUENCE, ED25519),
    name,
    encode(TAG.SEQUENCE, toUtcTime(getStartOfDay(now)), toUtcTime(addToDate(now, VALIDITY))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    toAltNames(host),
  );
  const signature = encode(TAG.BIT_STRING, Buffer.from([NO_UNUSED_BITS]), sign(null, signed, privateKey));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: new X509Certificate(encode(TAG.SEQUENCE, signed, encode(TAG.SEQUENCE, ED25519), signature)).toString(),
  };
}

// Every TLS client of the process takes the certificate for an authority of its own until the test ends, as a client
// takes a CA: a request that names no "ca" of its own is checked against it.
export function trustCertificate(t, cert) {
  const authorities = tls.getCACertificates('default');

  tls.setDefaultCACertificates([...authorities, cert]);
  t.after(() => tls.setDefaultCACertificates(authorities));
}
