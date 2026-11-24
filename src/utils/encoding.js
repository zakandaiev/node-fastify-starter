import { isString } from '#utils/type.js';
import { isUint8Array } from 'node:util/types';

const BASE64URL = 'base64url';
const HEX = 'hex';
const UTF8 = 'utf8';

const BASE64URL_OPTIONS = Object.freeze({ alphabet: BASE64URL, omitPadding: true });
const HEX_REGEXP = /^(?:[0-9A-Fa-f]{2})*$/;
const PLUS_REGEXP = /\+/g;
const SPACE = ' ';

// Only the path of it is ever written: any http address would do.
const URL_PATH_BASE = 'http://path.invalid';

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

function assertText(value, name) {
  if (!isString(value)) {
    throw new TypeError(`${name}(text) requires a string`);
  }
}

// encodeURIComponent() throws on a lone surrogate: it is written as U+FFFD, as URL and URLSearchParams write it.
export function encodeUrlComponent(text) {
  assertText(text, 'encodeUrlComponent');

  return encodeURIComponent(text.toWellFormed());
}

// null for a broken escape, which decodeURIComponent() throws on.
export function decodeUrlComponent(text) {
  if (!isString(text)) {
    return null;
  }

  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

// As the URL serializer writes a text into a path: a space is %20, while : @ ! ' ( ) ~ and an escape stay as they are.
export function encodeUrlPath(text) {
  assertText(text, 'encodeUrlPath');

  const url = new URL(URL_PATH_BASE);

  url.pathname = `/${text}`;

  return url.pathname.slice(1);
}

// As URLSearchParams writes a value: a space is +, and ~ ! ' ( ) are escaped.
export function encodeFormValue(text) {
  assertText(text, 'encodeFormValue');

  return new URLSearchParams([['', text]]).toString().slice(1);
}

// A value of a query as a form reads it: + is a space.
export function decodeFormValue(text) {
  return isString(text)
    ? decodeUrlComponent(text.replace(PLUS_REGEXP, SPACE))
    : null;
}
