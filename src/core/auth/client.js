import { SCHEMA_LIMITS } from '#config/schema.js';
import { HEADER } from '#enums/header.js';
import { truncate } from '#utils/string.js';
import { isNonEmptyString, isString } from '#utils/type.js';
import {
  isLoopbackAddress,
  isLoopbackHostname,
  isPrivateAddress,
  toIpAddress,
} from '#utils/validate.js';

const NO_SUFFIX = '';

export const CLIENT_ADDRESS_HEADERS = Object.freeze([
  HEADER.X_FORWARDED_FOR,
  HEADER.FORWARDED,
  HEADER.X_REAL_IP,
  HEADER.CF_CONNECTING_IP,
  HEADER.TRUE_CLIENT_IP,
]);

const HOP_SEPARATOR = ',';
const HOST_URL_PREFIX = 'http://';
const LOCALHOST_SUFFIX = '.localhost';

// Where a session is used from, within its columns: a longer text would fail the sign-in and every refresh after it.
export function readClient(request) {
  const userAgent = truncate(request.headers[HEADER.USER_AGENT], SCHEMA_LIMITS.userAgentMaxLength, NO_SUFFIX);

  return {
    userAgent: isNonEmptyString(userAgent)
      ? userAgent
      : null,
    ip: toIpAddress(request.ip),
  };
}

// A Host is a host and a port: with a userinfo, "evil.com@localhost" would parse to localhost.
function readHostname(host) {
  if (!isString(host) || !URL.canParse(`${HOST_URL_PREFIX}${host}`)) {
    return null;
  }

  const url = new URL(`${HOST_URL_PREFIX}${host}`);

  return url.username === '' && url.password === ''
    ? url.hostname
    : null;
}

// A browser takes a .localhost name to this machine by itself, without DNS; the host of the app is pointed here by
// the developer.
function isLocalHostname(hostname, appHost) {
  return isLoopbackHostname(hostname)
    || hostname.endsWith(LOCALHOST_SUFFIX)
    || hostname === readHostname(appHost);
}

function hasLoopbackHopsOnly(forwardedFor) {
  return isString(forwardedFor) && forwardedFor.split(HOP_SEPARATOR).every((hop) => isLoopbackAddress(hop.trim()));
}

// A dev proxy on this machine names its client in X-Forwarded-For, a loopback one; any other header is a proxy in front.
function hasLocalHopsOnly(headers) {
  const forwardedFor = headers[HEADER.X_FORWARDED_FOR];

  return CLIENT_ADDRESS_HEADERS.every((name) => name === HEADER.X_FORWARDED_FOR || headers[name] === undefined)
    && (forwardedFor === undefined || hasLoopbackHopsOnly(forwardedFor));
}

// A worker, a job or a monitor of the own network: a private socket, and no header that names a client. A proxy names
// its client in one, and an SSR server the visitor it renders for. The network of the proxy is private too, so its range
// alone would let all public traffic in. The socket, not request.ip, which trustProxy takes from those headers.
export function isInternalRequest(request) {
  return isPrivateAddress(request.socket?.remoteAddress)
    && CLIENT_ADDRESS_HEADERS.every((name) => request.headers[name] === undefined);
}

// The socket, not request.ip: trustProxy trusts the local network, whose client can write 127.0.0.1 into
// X-Forwarded-For. The raw Host, not request.hostname, which trustProxy takes from X-Forwarded-Host: a page of a name
// its DNS points at 127.0.0.1 sends that name, and so does a client of the network through a dev proxy that keeps it.
export function isLoopbackOnlyRequest(request) {
  const hostname = readHostname(request.headers[HEADER.HOST]);

  return isLoopbackAddress(request.socket.remoteAddress)
    && hostname !== null
    && isLocalHostname(hostname, request.server.config.app.host)
    && hasLocalHopsOnly(request.headers);
}
