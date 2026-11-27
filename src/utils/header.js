import { decodeUrlComponent } from '#utils/encoding.js';
import { escapeRegExp } from '#utils/string.js';
import { isString } from '#utils/type.js';

const BEARER_SCHEME_REGEXP = /^Bearer(?:[ \t]|$)/i;
const BEARER_REGEXP = /^Bearer[ \t]+(\S+)[ \t]*$/i;

const ORIGIN_HEADER = 'origin';
const REFERER_HEADER = 'referer';

// What URL gives as the origin of an address it cannot place: file:, data:, a scheme it does not know.
const OPAQUE_ORIGIN = 'null';

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
// such a value names no origin, and an empty one is on no allow-list. As a browser writes it: the scheme and the host
// in lower case, a default port left out.
function readOrigin(value) {
  if (!URL.canParse(value)) {
    return '';
  }

  const { origin } = new URL(value);

  return origin === OPAQUE_ORIGIN
    ? ''
    : origin;
}

// The origin of the Origin header, or of the Referer without one. Neither comes from a client that is not a browser:
// null, not an origin.
export function readRequestOrigin(headers) {
  const origin = headers?.[ORIGIN_HEADER];

  if (isString(origin)) {
    return readOrigin(origin);
  }

  const referer = headers?.[REFERER_HEADER];

  return isString(referer)
    ? readOrigin(referer)
    : null;
}
