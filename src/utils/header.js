import { isString } from '#utils/type.js';

const BEARER_REGEXP = /^Bearer[ \t]+(\S+)[ \t]*$/i;

const ORIGIN_HEADER = 'origin';
const REFERER_HEADER = 'referer';

export function readBearerToken(authorization) {
  if (!isString(authorization)) {
    return null;
  }

  const [, token = null] = BEARER_REGEXP.exec(authorization) ?? [];

  return token;
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
