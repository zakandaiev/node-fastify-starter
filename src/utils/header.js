import { decodeUrlComponent } from '#utils/encoding.js';
import { escapeRegExp } from '#utils/string.js';
import { isString } from '#utils/type.js';

const BEARER_SCHEME_REGEXP = /^Bearer(?:[ \t]|$)/i;
const BEARER_REGEXP = /^Bearer[ \t]+(\S+)[ \t]*$/i;

const ORIGIN_HEADER = 'origin';
const REFERER_HEADER = 'referer';

// Whatever follows the scheme: "Bearer" alone or with a text of several parts is a token nobody can use, not none.
export function hasBearerScheme(authorization) {
  return isString(authorization) && BEARER_SCHEME_REGEXP.test(authorization);
}

export function readBearerToken(authorization) {
  if (!isString(authorization)) {
    return null;
  }

  const [, token = null] = BEARER_REGEXP.exec(authorization) ?? [];

  return token;
}

// One cookie, as setCookie() wrote it: of several pairs of one name the first counts. The others are not looked into:
// a header of thousands of broken escapes, decoded whole, takes milliseconds.
export function readCookie(header, name) {
  if (!isString(header)) {
    return null;
  }

  const [, pair] = new RegExp(`(?:^|;)[ \\t]*${escapeRegExp(name)}[ \\t]*=([^;]*)`).exec(header) ?? [];
  const value = pair?.trim();

  return value === undefined
    ? null
    : decodeUrlComponent(value) ?? value;
}

// A browser that hides where a request comes from sends "Origin: null", and a sandboxed frame of any site can:
// such a value names no host, and an empty one is on no allow-list.
function readHost(value) {
  return URL.canParse(value)
    ? new URL(value).host.toLowerCase()
    : '';
}

// Neither header comes from a client that is not a browser: null, not a host.
export function readOriginHost(headers) {
  const origin = headers?.[ORIGIN_HEADER];

  if (isString(origin)) {
    return readHost(origin);
  }

  const referer = headers?.[REFERER_HEADER];

  return isString(referer)
    ? readHost(referer)
    : null;
}
