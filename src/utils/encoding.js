import { isString } from '#utils/type.js';
import { isUint8Array } from 'node:util/types';

const BASE64URL = 'base64url';
const HEX = 'hex';
const UTF8 = 'utf8';

const BASE64URL_OPTIONS = Object.freeze({ alphabet: BASE64URL, omitPadding: true });
const HEX_REGEXP = /^(?:[0-9A-Fa-f]{2})*$/;

function toBytes(value, name) {
  if (isString(value)) {
    return Buffer.from(value, UTF8);
  }

  if (!isUint8Array(value)) {
    throw new TypeError(`${name}(value) requires a string, a Buffer or a Uint8Array`);
  }

  return value;
}

export function encodeBase64Url(value) {
  return toBytes(value, 'encodeBase64Url').toBase64(BASE64URL_OPTIONS);
}

// Buffer.from() skips every character it does not know and drops the spare bits of the last one,
// so a text is well-formed only when it is exactly what the encoder writes for the decoded bytes.
export function decodeBase64Url(text) {
  if (!isString(text)) {
    return null;
  }

  const bytes = Buffer.from(text, BASE64URL);

  return encodeBase64Url(bytes) === text
    ? bytes
    : null;
}

export function isBase64Url(value) {
  return value !== '' && decodeBase64Url(value) !== null;
}

export function encodeHex(value) {
  return toBytes(value, 'encodeHex').toHex();
}

// Buffer.from() stops at the first pair that is not hex and reads a character above U+00FF by its low byte.
export function decodeHex(text) {
  return isString(text) && HEX_REGEXP.test(text)
    ? Buffer.from(text, HEX)
    : null;
}

export function isHex(value) {
  return value !== '' && decodeHex(value) !== null;
}
