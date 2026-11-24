import { getContext } from '#core/context/index.js';
import {
  assertServiceOptions,
  createUpstreamFailure,
  createWayFailure,
  findUpstreamError,
  isSuccessStatus,
  logUpstreamCall,
  logUpstreamFailure,
  maskUrl,
  parseUpstreamUrl,
  readTimeout,
  UpstreamError,
} from '#core/http/index.js';
import { HEADER } from '#enums/header.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { UPSTREAM_FAILURE } from '#enums/upstream-failure.js';
import { createByteCollector } from '#utils/bytes.js';
import { toMimeEssence } from '#utils/mime.js';
import {
  isArray,
  isNonEmptyArray,
  isNonEmptyString,
  isNonNegativeInteger,
  isObject,
  isPositiveInteger,
  toNumber,
} from '#utils/type.js';
import { ipInCidr, isCidr, isPrivateAddress } from '#utils/validate.js';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SIGNATURE = 'fetchExternal(url, { service, allowedHosts, allowedTypes, maxBytes, timeout, maxRedirects })';

const HTTPS_PROTOCOL = 'https:';
const IDENTITY_ENCODING = 'identity';
const ACCEPT_SEPARATOR = ', ';
const HOST_SEPARATOR = '.';
const CLOSED_MESSAGE = 'The connection closed without an answer';
const CLOSED_CODE = 'ECONNRESET';
const IPV6_BRACKETS_REGEXP = /^\[|\]$/g;

const REDIRECT_STATUSES = Object.freeze([
  HTTP_STATUS.MOVED_PERMANENTLY,
  HTTP_STATUS.FOUND,
  HTTP_STATUS.SEE_OTHER,
  HTTP_STATUS.TEMPORARY_REDIRECT,
  HTTP_STATUS.PERMANENT_REDIRECT,
]);

function readHosts(allowedHosts) {
  if (!isNonEmptyArray(allowedHosts) || !allowedHosts.every((host) => isNonEmptyString(host))) {
    throw new TypeError(`${SIGNATURE} requires allowedHosts: the hosts the address may name, each with its subdomains`);
  }

  return allowedHosts.map((host) => host.toLowerCase());
}

function readTypes(allowedTypes) {
  if (!isNonEmptyArray(allowedTypes) || !allowedTypes.every((type) => isNonEmptyString(type) && toMimeEssence(type) === type)) {
    throw new TypeError(`${SIGNATURE} requires allowedTypes: media types in lower case and without parameters, such as "image/png"`);
  }

  return allowedTypes;
}

function readNetworks(networks) {
  if (!isArray(networks) || !networks.every((network) => isCidr(network))) {
    throw new TypeError('config.http.external.allowedPrivateNetworks must be a list of CIDR blocks');
  }

  return networks;
}

function readOptions(url, options) {
  assertServiceOptions(options, SIGNATURE);

  const { external } = getContext().config.http;
  const maxBytes = options.maxBytes ?? external.maxBytes;
  const maxRedirects = options.maxRedirects ?? external.maxRedirects;

  if (!isPositiveInteger(maxBytes) || !isNonNegativeInteger(maxRedirects)) {
    throw new TypeError(`${SIGNATURE} requires maxBytes above zero and maxRedirects not below zero`);
  }

  // The path and the subdomains of an address that came from outside may name its user: the log gets the site only.
  return {
    service: options.service,
    method: HTTP_METHOD.GET,
    loggedUrl: maskUrl(url, { isAddressSecret: true }),
    allowedHosts: readHosts(options.allowedHosts),
    allowedTypes: readTypes(options.allowedTypes),
    allowedNetworks: readNetworks(external.allowedPrivateNetworks),
    maxBytes,
    maxRedirects,
    timeoutMs: readTimeout(options.timeout, external.timeout, SIGNATURE),
  };
}

function isAllowedHost(hostname, allowedHosts) {
  return allowedHosts.some((host) => hostname === host || hostname.endsWith(`${HOST_SEPARATOR}${host}`));
}

function isAllowedAddress(address, allowedNetworks) {
  return !isPrivateAddress(address) || allowedNetworks.some((network) => ipInCidr(address, network));
}

function refuse(reason, extra) {
  return new UpstreamError(reason, extra);
}

// The address the connection goes to is the one checked here: a name that resolves to a public address for the check
// and to a private one for the connection (DNS rebinding) never gets the second answer.
function createLookup(allowedNetworks) {
  function lookupAllowed(hostname, options, callback) {
    const lookupOptions = isObject(options)
      ? options
      : { family: options };

    dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) {
        callback(error);

        return false;
      }

      if (!addresses.length || addresses.some(({ address }) => !isAllowedAddress(address, allowedNetworks))) {
        callback(refuse(UPSTREAM_FAILURE.REFUSED_ADDRESS));

        return false;
      }

      if (lookupOptions.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }

      return true;
    });
  }

  return lookupAllowed;
}

// Every hop is checked as the first one: a redirect may lead anywhere.
function checkHop(url, options) {
  const target = parseUpstreamUrl(url);

  if (!target) {
    throw refuse(UPSTREAM_FAILURE.INVALID_URL);
  }

  const hostname = target.hostname.replace(IPV6_BRACKETS_REGEXP, '');

  if (!isAllowedHost(hostname, options.allowedHosts)) {
    throw refuse(UPSTREAM_FAILURE.REFUSED_HOST);
  }

  // A literal address is connected to without a lookup.
  if (isIP(hostname) && !isAllowedAddress(hostname, options.allowedNetworks)) {
    throw refuse(UPSTREAM_FAILURE.REFUSED_ADDRESS);
  }

  return target;
}

// No agent of the pool: a connection opened earlier by other code would be reused without this lookup. An answer
// of 101 with an upgrade nobody listens for emits neither "response" nor "error", only "close".
function requestHop(target, options, signal) {
  const transport = target.protocol === HTTPS_PROTOCOL
    ? https
    : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method: HTTP_METHOD.GET,
      headers: {
        [HEADER.ACCEPT]: options.allowedTypes.join(ACCEPT_SEPARATOR),
        [HEADER.ACCEPT_ENCODING]: IDENTITY_ENCODING,
      },
      agent: false,
      lookup: createLookup(options.allowedNetworks),
      signal,
    }, resolve);

    request.once('error', reject);
    request.once('close', () => reject(Object.assign(new Error(CLOSED_MESSAGE), { code: CLOSED_CODE })));
    request.end();
  });
}

// The ceiling holds while the body streams: a length the server declares may be absent or false.
async function readBody(response, { maxBytes, status }, signal) {
  const collector = createByteCollector(maxBytes);

  await pipeline(response, new Writable({
    write(chunk, encoding, callback) {
      callback(collector.add(chunk)
        ? null
        : refuse(UPSTREAM_FAILURE.TOO_LARGE, { status }));
    },
  }), { signal });

  return collector.read();
}

function readLocation(response, target) {
  const location = response.headers[HEADER.LOCATION];

  return isNonEmptyString(location) && URL.canParse(location, target)
    ? new URL(location, target).href
    : null;
}

async function readResponse(response, options, signal) {
  const status = response.statusCode;
  const contentType = toMimeEssence(response.headers[HEADER.CONTENT_TYPE]);
  const declaredLength = toNumber(response.headers[HEADER.CONTENT_LENGTH]);

  if (!isSuccessStatus(status)) {
    response.destroy();
    throw refuse(UPSTREAM_FAILURE.STATUS, { status });
  }

  if (!options.allowedTypes.includes(contentType)) {
    response.destroy();
    throw refuse(UPSTREAM_FAILURE.REFUSED_TYPE, { status });
  }

  if (declaredLength !== null && declaredLength > options.maxBytes) {
    response.destroy();
    throw refuse(UPSTREAM_FAILURE.TOO_LARGE, { status });
  }

  return {
    status,
    contentType,
    bytes: await readBody(response, { maxBytes: options.maxBytes, status }, signal),
  };
}

async function fetchHop(url, options, signal, redirectCount) {
  const target = checkHop(url, options);
  const response = await requestHop(target, options, signal);

  if (!REDIRECT_STATUSES.includes(response.statusCode)) {
    return { ...await readResponse(response, options, signal), url: target.href, redirectCount };
  }

  const location = readLocation(response, target);

  response.destroy();

  if (redirectCount >= options.maxRedirects) {
    throw refuse(UPSTREAM_FAILURE.TOO_MANY_REDIRECTS, { status: response.statusCode });
  }

  if (!location) {
    throw refuse(UPSTREAM_FAILURE.INVALID_URL, { status: response.statusCode });
  }

  return fetchHop(location, options, signal, redirectCount + 1);
}

function toFailure(error, options, signal, durationMs) {
  const upstreamError = findUpstreamError(error);

  return upstreamError
    ? createUpstreamFailure(options, upstreamError.reason, { status: upstreamError.status, durationMs })
    : createWayFailure(options, error, signal, durationMs);
}

// For an address that came from outside, such as the avatar of a provider: the host must be on the allow-list
// and resolve to public addresses only, at every hop of the redirects, which are followed by hand; the type of
// the answer must be one of allowedTypes, and the body is read up to maxBytes. One deadline covers it all.
export async function fetchExternal(url, options = {}) {
  const fetchOptions = readOptions(url, options);
  const signal = AbortSignal.timeout(fetchOptions.timeoutMs);
  const startedAt = performance.now();

  try {
    const result = await fetchHop(url, fetchOptions, signal, 0);

    logUpstreamCall(fetchOptions, {
      status: result.status,
      durationMs: Math.round(performance.now() - startedAt),
      redirectCount: result.redirectCount,
      byteLength: result.bytes.length,
    });

    return {
      url: result.url,
      status: result.status,
      contentType: result.contentType,
      bytes: result.bytes,
    };
  } catch (error) {
    const failure = toFailure(error, fetchOptions, signal, Math.round(performance.now() - startedAt));

    logUpstreamFailure(fetchOptions, failure);

    throw failure;
  }
}
