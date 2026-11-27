import { cutAddressTail, normalizeEmail, normalizePhone } from '#utils/string.js';
import { isNonEmptyString, isString, toString } from '#utils/type.js';
import { BlockList, isIP } from 'node:net';

export const EMAIL_MAX_LENGTH = 254;
// Minimal on purpose: the real filter is the delivery of a message. A label cannot hold a dot, so the match is linear.
const EMAIL_REGEXP = /^[^\s@\p{Cc}]+@[^\s@.\p{Cc}]+(?:\.[^\s@.\p{Cc}]+)+$/v;

// The longest address that browsers, proxies and CDNs all take.
export const URL_MAX_LENGTH = 2048;

const WEB_PROTOCOLS = Object.freeze(['http:', 'https:']);
const HOSTNAME_PROTOCOL = 'https:';

export const REDIRECT_PATH_MAX_LENGTH = 512;
// Browsers read "/\evil.com" as "//evil.com" and drop tabs and line breaks before that,
// and a Location header takes printable ASCII only: Node throws ERR_INVALID_CHAR on the rest.
const REDIRECT_PATH_REGEXP = /^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/;
// One or two dots, each "." or "%2e" in any case: URL parsing removes such a segment, and "/.//evil.com" becomes the
// pathname "//evil.com", which a page that redirects to its pathname sends to another host.
const DOT_SEGMENT_REGEXP = /^(?:\.|%2e){1,2}$/i;
const PATH_SEPARATOR = '/';

const LOCALHOST = 'localhost';
const IPV6_HOSTNAME_REGEXP = /^\[(.*)\]$/;

const IPV4 = 'ipv4';
const IPV6 = 'ipv6';
const FAMILIES = Object.freeze({ 4: IPV4, 6: IPV6 });
const PREFIX_MAX_LENGTHS = Object.freeze({ [IPV4]: 32, [IPV6]: 128 });

// The longest text of an address is an IPv4 one inside an IPv6 one; a zone after "%" could be of any length.
export const IP_MAX_LENGTH = 45;

const CIDR_SEPARATOR = '/';
const ZONE_SEPARATOR = '%';
const PREFIX_LENGTH_REGEXP = /^(?:0|[1-9]\d{0,2})$/;

const BYTE_VALUES = 256;
const HEX_RADIX = 16;

const LOOPBACK_BLOCKS = Object.freeze([
  ['127.0.0.0', 8],
  ['::1', 128],
]);

// What cannot be a host of the public internet: "this network", private use, shared (carrier-grade NAT), loopback,
// link-local (the cloud metadata address lives there), protocol assignments, documentation, benchmarking,
// multicast and reserved.
const PRIVATE_IPV4_BLOCKS = Object.freeze([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]);

const PRIVATE_IPV6_BLOCKS = Object.freeze([
  ['::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]);

// An IPv6 address that carries an IPv4 one is judged by the address it carries: behind NAT64 or 6to4 it is that host.
// The IPv4-mapped form needs no entry: BlockList checks it against the IPv4 blocks by itself.
const NAT64_PREFIX = '64:ff9b::';
const NAT64_PREFIX_LENGTH = 96;
const SIX_TO_FOUR_PREFIX = '2002:';
const SIX_TO_FOUR_PREFIX_LENGTH = 16;

// isIP() converts its argument to a string, and BlockList throws on anything but a string.
function getFamily(address) {
  return isString(address)
    ? FAMILIES[isIP(address)] ?? null
    : null;
}

function toHexGroups(ipv4) {
  const [first, second, third, fourth] = ipv4.split('.').map(Number);

  return `${(first * BYTE_VALUES + second).toString(HEX_RADIX)}:${(third * BYTE_VALUES + fourth).toString(HEX_RADIX)}`;
}

function toCarrierBlocks([network, prefixLength]) {
  return [
    [`${NAT64_PREFIX}${network}`, NAT64_PREFIX_LENGTH + prefixLength],
    [`${SIX_TO_FOUR_PREFIX}${toHexGroups(network)}::`, SIX_TO_FOUR_PREFIX_LENGTH + prefixLength],
  ];
}

function createBlockList(blocks) {
  const list = new BlockList();

  blocks.forEach(([network, prefixLength]) => {
    list.addSubnet(network, prefixLength, getFamily(network));
  });

  return list;
}

const loopbackAddresses = createBlockList(LOOPBACK_BLOCKS);

const privateAddresses = createBlockList([
  ...PRIVATE_IPV4_BLOCKS,
  ...PRIVATE_IPV6_BLOCKS,
  ...PRIVATE_IPV4_BLOCKS.flatMap(toCarrierBlocks),
]);

function isListed(list, address) {
  const family = getFamily(address);

  return family !== null && list.check(address, family);
}

function parseCidr(value) {
  const separatorIndex = isString(value)
    ? value.indexOf(CIDR_SEPARATOR)
    : -1;

  if (separatorIndex === -1) {
    return null;
  }

  const network = value.slice(0, separatorIndex);
  const prefixLength = value.slice(separatorIndex + 1);
  const family = getFamily(network);
  const isValid = family !== null
    && !network.includes(ZONE_SEPARATOR)
    && PREFIX_LENGTH_REGEXP.test(prefixLength)
    && Number(prefixLength) <= PREFIX_MAX_LENGTHS[family];

  return isValid
    ? { network, prefixLength: Number(prefixLength), family }
    : null;
}

export function isEmail(value) {
  if (!isString(value)) {
    return false;
  }

  const email = normalizeEmail(value);

  return email.length <= EMAIL_MAX_LENGTH && EMAIL_REGEXP.test(email);
}

// The form an email is stored and searched in, or null for what is no email.
export function toValidEmail(value) {
  return isEmail(value)
    ? normalizeEmail(value)
    : null;
}

export function isPhone(value) {
  return isString(value) && normalizePhone(value) !== null;
}

export function isCidr(value) {
  return parseCidr(value) !== null;
}

export function ipInCidr(address, cidr) {
  const block = parseCidr(cidr);
  const family = getFamily(address);

  if (block === null || family === null) {
    return false;
  }

  const list = new BlockList();

  list.addSubnet(block.network, block.prefixLength, block.family);

  return list.check(address, family);
}

// For a column of addresses: the ip of a request may be a text its client wrote (a proxy that passes X-Forwarded-For
// on as it came), and one longer than the column would fail the insert.
export function toIpAddress(value) {
  return getFamily(value) !== null && value.length <= IP_MAX_LENGTH
    ? value
    : null;
}

export function isLoopbackAddress(address) {
  return isListed(loopbackAddresses, address);
}

// The hostname of a URL writes an IPv6 address in brackets, which no check of an address takes.
export function toHostAddress(hostname) {
  const [, address] = IPV6_HOSTNAME_REGEXP.exec(toString(hostname)) ?? [];

  return address ?? toString(hostname);
}

// A hostname of this machine for any resolver: "localhost" or a loopback address.
export function isLoopbackHostname(hostname) {
  return hostname === LOCALHOST || isLoopbackAddress(toHostAddress(hostname));
}

// A host as the hostname of a URL writes it, in lower case and punycode: the form the host of an address is compared
// in. No IPv6 address passes, a URL keeps it in brackets.
export function isHostname(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const address = `${HOSTNAME_PROTOCOL}//${value}`;

  return URL.canParse(address) && toHostAddress(new URL(address).hostname) === value;
}

export function isPrivateAddress(address) {
  return isListed(privateAddresses, address);
}

// http or https without credentials, which fetch() refuses to send. The ports fetch() blocks are not checked.
export function isWebUrl(value) {
  if (!isString(value) || !URL.canParse(value)) {
    return false;
  }

  const url = new URL(value);

  return WEB_PROTOCOLS.includes(url.protocol) && !url.username && !url.password;
}

function hasDotSegment(path) {
  return cutAddressTail(path).split(PATH_SEPARATOR).some((segment) => DOT_SEGMENT_REGEXP.test(segment));
}

export function isSafeRedirectPath(value) {
  return isString(value)
    && value.length <= REDIRECT_PATH_MAX_LENGTH
    && REDIRECT_PATH_REGEXP.test(value)
    && !hasDotSegment(value);
}
