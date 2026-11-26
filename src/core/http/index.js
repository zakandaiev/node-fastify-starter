import { getContext } from '#core/context/index.js';
import { AppError } from '#core/error/index.js';
import { maskErrorValues } from '#core/error/mask.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { UPSTREAM_FAILURE } from '#enums/upstream-failure.js';
import { unique } from '#utils/array.js';
import { isTimeoutError } from '#utils/async.js';
import { createByteCollector } from '#utils/bytes.js';
import { convertStringToMs } from '#utils/date.js';
import {
  decodeFormValue,
  encodeFormValue,
  encodeUrlComponent,
  encodeUrlPath,
} from '#utils/encoding.js';
import { compact, mapKeys } from '#utils/object.js';
import { truncate } from '#utils/string.js';
import {
  isArray,
  isBoolean,
  isNonEmptyString,
  isObject,
  isPositiveInteger,
  isString,
  toNumber,
} from '#utils/type.js';
import { isWebUrl } from '#utils/validate.js';
import { isIP } from 'node:net';

const REQUEST_MESSAGE = 'Upstream request';
const FAILED_MESSAGE = 'Upstream request failed';

const DEFAULT_METHOD = HTTP_METHOD.GET;
const BODILESS_METHODS = Object.freeze([HTTP_METHOD.GET, HTTP_METHOD.HEAD]);
const SUCCESS_STATUS_MIN = 200;
const SUCCESS_STATUS_MAX = 299;
const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;

const MASK = '***';
const OPAQUE_ORIGIN = 'null';
const PROTOCOL_SEPARATOR = '//';
const PORT_SEPARATOR = ':';
const LABEL_SEPARATOR = '.';
const SLASH = '/';
const ESCAPED_SLASH = '\\/';
const QUERY_SEPARATOR = '&';
const QUERY_ASSIGNMENT = '=';
const SEARCH_TEXT_REGEXP = /[^&=]+/g;

// The second sign of padding of a base64 token is written as %3D once URLSearchParams sets another parameter.
const PADDING_REGEXP = /^(?:=|%3D)*$/i;
const PERCENT_ESCAPE_REGEXP = /%[0-9A-F]{2}/g;
const REDIRECT_MODE = 'manual';

// What stays of a secret host: its last two labels, the site near enough without the list of public suffixes.
const SITE_LABEL_COUNT = 2;

const CAUSE_MAX_DEPTH = 5;

const UTF8_DECODER = new TextDecoder();

const FAILURE_MESSAGES = Object.freeze({
  [UPSTREAM_FAILURE.INVALID_URL]: 'The address is not an http or https URL without credentials',
  [UPSTREAM_FAILURE.NETWORK]: 'The upstream could not be reached',
  [UPSTREAM_FAILURE.TIMEOUT]: 'The upstream did not answer in time',
  [UPSTREAM_FAILURE.TOO_LARGE]: 'The answer of the upstream is larger than its ceiling',
  [UPSTREAM_FAILURE.STATUS]: 'The upstream answered with a status that is not a success',
  [UPSTREAM_FAILURE.INVALID_JSON]: 'The answer of the upstream is not JSON',
  [UPSTREAM_FAILURE.INVALID_ANSWER]: 'The answer of the upstream is not what the call expects',
  [UPSTREAM_FAILURE.REFUSED_HOST]: 'The host is not on the allow-list of the fetch',
  [UPSTREAM_FAILURE.REFUSED_ADDRESS]: 'The host is a private address',
  [UPSTREAM_FAILURE.REFUSED_TYPE]: 'The upstream answered with a type the fetch does not take',
  [UPSTREAM_FAILURE.TOO_MANY_REDIRECTS]: 'The upstream redirected more times than the fetch follows',
});

// Its own fields name the call, never its address as given: a token rides in the path or the query of many APIs.
export class UpstreamError extends Error {
  constructor(reason, { cause, ...details } = {}) {
    if (!Object.hasOwn(FAILURE_MESSAGES, reason)) {
      throw new TypeError(`UpstreamError(reason, details) requires a reason from src/enums/upstream-failure.js, got "${reason}"`);
    }

    super(FAILURE_MESSAGES[reason], cause === undefined ? undefined : { cause });

    this.reason = reason;
    Object.assign(this, compact(details));
  }
}

// On the prototype, not on the instance: an own enumerable name is copied into every log line next to "type".
Object.defineProperty(UpstreamError.prototype, 'name', {
  value: 'UpstreamError',
  writable: true,
  configurable: true,
});

// The failure behind a 502: the error itself, or the cause of the AppError a fetch has thrown.
export function findUpstreamError(error) {
  if (error instanceof UpstreamError) {
    return error;
  }

  return error instanceof AppError && error.cause instanceof UpstreamError
    ? error.cause
    : null;
}

// A route that does not catch it answers 502, and the error-alert plugin reports it.
export function toUpstreamAppError(upstreamError) {
  return new AppError(ERROR_CODE.UPSTREAM_ERROR, { cause: upstreamError });
}

function lowerEscapes(text) {
  return text.replace(PERCENT_ESCAPE_REGEXP, (escape) => escape.toLowerCase());
}

function readJsonForms(text) {
  const json = JSON.stringify(text).slice(1, -1);

  return [text, json, json.replaceAll(SLASH, ESCAPED_SLASH)];
}

// A piece of a call comes back as given, as encodeURIComponent(), a path or a form writes it, with its escapes
// in lower case, or inside a JSON string, where "/" may be "\/".
function readForms(piece) {
  return [piece, encodeUrlComponent(piece), encodeUrlPath(piece), encodeFormValue(piece)]
    .flatMap((form) => [form, lowerEscapes(form)])
    .flatMap((form) => readJsonForms(form));
}

// Longest first: a piece inside a longer one would leave the rest of the longer one in the text.
function toPieces(forms) {
  return unique(forms.filter((form) => isNonEmptyString(form))).sort((left, right) => right.length - left.length);
}

function maskPieces(text, pieces) {
  return pieces.reduce((masked, piece) => masked.split(piece).join(MASK), text);
}

function readQueryPart(part) {
  const separatorAt = part.indexOf(QUERY_ASSIGNMENT);

  if (separatorAt === -1) {
    return { key: part, value: '' };
  }

  const value = part.slice(separatorAt + 1);

  return {
    key: part.slice(0, separatorAt),
    value: PADDING_REGEXP.test(value)
      ? ''
      : value,
  };
}

// A bare "?token", a "token=" and a base64 token with its padding are keys without a value, and such a key is
// the secret itself.
function readQueryParts(search) {
  return search.slice(1).split(QUERY_SEPARATOR).filter(Boolean).map((part) => readQueryPart(part));
}

// The separators inside a secret stay: without them the parts on both sides of it would run into one.
function maskSearch(search, pieces) {
  return pieces.reduce((masked, piece) => masked.split(piece).join(piece.replace(SEARCH_TEXT_REGEXP, MASK)), search);
}

function maskQueryPart({ key, value }) {
  return value
    ? `${key}${QUERY_ASSIGNMENT}${MASK}`
    : MASK;
}

function maskQuery(search, { pieces, isAddressSecret }) {
  const parts = readQueryParts(maskSearch(search, pieces));

  if (!parts.length) {
    return '';
  }

  return isAddressSecret
    ? `?${MASK}`
    : `?${parts.map((part) => maskQueryPart(part)).join(QUERY_SEPARATOR)}`;
}

function maskPath(pathname, { pieces, isAddressSecret }) {
  return isAddressSecret
    ? `${SLASH}${MASK}`
    : maskPieces(pathname, pieces);
}

// A name is in lower case in a URL, so is a secret inside it; a subdomain may be the secret of a webhook itself.
function maskHost(hostname, { pieces, isAddressSecret }) {
  const labels = hostname.split(LABEL_SEPARATOR);

  if (isAddressSecret && !isIP(hostname) && labels.length > SITE_LABEL_COUNT) {
    return [MASK, ...labels.slice(-SITE_LABEL_COUNT)].join(LABEL_SEPARATOR);
  }

  return maskPieces(hostname, toPieces(pieces.map((piece) => piece.toLowerCase())));
}

// For a log or an error: no credentials, no value of the query, and no secret the caller names (the token of a bot)
// in its path, its query or an ASCII host; a secret address (a webhook, one from outside) keeps its scheme, site and port.
// An address without a host of its own (mailto:, data:, blob:) is all body, so nothing of it is kept.
export function maskUrl(url, { secrets = [], isAddressSecret = false } = {}) {
  if (!isArray(secrets) || !secrets.every((secret) => isNonEmptyString(secret)) || !isBoolean(isAddressSecret)) {
    throw new TypeError('maskUrl(url, { secrets, isAddressSecret }) requires secrets to be a list of non-empty strings and isAddressSecret a boolean');
  }

  const text = url instanceof URL
    ? url.href
    : url;

  if (!isString(text) || !URL.canParse(text)) {
    return MASK;
  }

  const {
    origin,
    protocol,
    hostname,
    port,
    pathname,
    search,
  } = new URL(text);
  const masking = { pieces: toPieces(secrets.flatMap((secret) => readForms(secret))), isAddressSecret };
  const host = port
    ? `${maskHost(hostname, masking)}${PORT_SEPARATOR}${port}`
    : maskHost(hostname, masking);

  return origin === OPAQUE_ORIGIN || !hostname
    ? MASK
    : `${protocol}${PROTOCOL_SEPARATOR}${host}${maskPath(pathname, masking)}${maskQuery(search, masking)}`;
}

// The address is parsed by hand first: fetch() and new URL() put an address they refuse into their error,
// and that error would carry a token to the log.
export function parseUpstreamUrl(url) {
  const text = url instanceof URL
    ? url.href
    : url;

  return isWebUrl(text)
    ? new URL(text)
    : null;
}

// What an upstream may echo of the call in the body of its refusal ({"path": "/v1/…?api_key=…"}): the secrets
// the caller names, and each value of the query long enough to be one, a bare key included, as sent and as a form
// reads it. A form of a value may be shorter than it (a path with "..") and is then too short as well.
function readEchoes(target, secrets, minLength) {
  const values = target
    ? readQueryParts(target.search).map(({ key, value }) => value || key)
    : [];
  const queryPieces = values.flatMap((value) => {
    const decoded = decodeFormValue(value) ?? value;

    return decoded.length >= minLength
      ? [value, decoded]
      : [];
  });

  const queryForms = queryPieces
    .flatMap((piece) => readForms(piece))
    .filter((form) => form.length >= minLength);

  return toPieces([...secrets.flatMap((secret) => readForms(secret)), ...queryForms]);
}

// The name of the service goes into the log and the alert of every call.
export function assertServiceOptions(options, signature) {
  if (!isObject(options) || !isNonEmptyString(options.service)) {
    throw new TypeError(`${signature} requires options with the name of the service, for the log and the alert`);
  }

  return true;
}

export function readTimeout(value, fallback, signature) {
  const ms = convertStringToMs(value ?? fallback);

  if (!(ms > 0)) {
    throw new TypeError(`${signature} requires a timeout above zero, such as "5s"`);
  }

  return ms;
}

function readBody(options, signature) {
  if (options.json !== undefined && options.body !== undefined) {
    throw new TypeError(`${signature} takes either json or body`);
  }

  return options.json === undefined
    ? options.body
    : JSON.stringify(options.json);
}

// The caller's headers win over those given here whatever their case: two spellings of one header would be joined
// into one value, and a Content-Type of two values is refused.
function readHeaders(options, defaults, signature) {
  if (options.headers !== undefined && !isObject(options.headers)) {
    throw new TypeError(`${signature} requires headers to be a plain object`);
  }

  return {
    ...defaults,
    ...(options.json !== undefined && { [HEADER.CONTENT_TYPE]: MEDIA_TYPE.JSON_UTF8 }),
    ...mapKeys(options.headers ?? {}, (name) => name.toLowerCase()),
  };
}

// fetch() writes only the six common methods in upper case: a "patch" would go out as it is and be refused.
function readMethod(options, body, signature) {
  const method = options.method ?? DEFAULT_METHOD;

  if (!isNonEmptyString(method)) {
    throw new TypeError(`${signature} requires method to be a non-empty string`);
  }

  const name = method.toUpperCase();

  if (body !== undefined && body !== null && BODILESS_METHODS.includes(name)) {
    throw new TypeError(`${signature} sends no body with ${name}: name the method that carries it, such as POST`);
  }

  return name;
}

function readOptions(url, options, { signature, headers = {} }) {
  assertServiceOptions(options, signature);

  if (options.maxBytes !== undefined && !isPositiveInteger(options.maxBytes)) {
    throw new TypeError(`${signature} requires maxBytes to be a positive integer`);
  }

  const { config } = getContext();
  const body = readBody(options, signature);
  const target = parseUpstreamUrl(url);
  const masking = { secrets: options.secrets ?? [], isAddressSecret: options.isAddressSecret ?? false };
  const loggedUrl = maskUrl(url, masking);

  return {
    service: options.service,
    method: readMethod(options, body, signature),
    target,
    loggedUrl,
    echoes: readEchoes(target, masking.secrets, config.http.echoMinLength),
    isAddressSecret: masking.isAddressSecret,
    headers: readHeaders(options, headers, signature),
    body,
    timeoutMs: readTimeout(options.timeout, config.http.timeout, signature),
    maxBytes: options.maxBytes ?? config.http.maxResponseBytes,
  };
}

function describeCall(call, extra = {}) {
  return compact({
    service: call.service,
    method: call.method,
    url: call.loggedUrl,
    ...extra,
  });
}

// The AppError a route answers 502 with, for a call named by its service, method and masked address.
export function createUpstreamFailure(call, reason, extra = {}) {
  return toUpstreamAppError(new UpstreamError(reason, describeCall(call, extra)));
}

// The deadline covers the body too: the signal of fetch() also ends a body that is still streaming.
function isTimeoutFailure(error, signal) {
  return (signal.aborted && isTimeoutError(signal.reason)) || isTimeoutError(error);
}

function readNetworkCode(error) {
  return readOwnText(error?.cause?.code ?? error?.code);
}

function readOwnText(text) {
  return isNonEmptyString(text)
    ? text
    : undefined;
}

// Only what names the failure: the messages and the other fields of these errors quote the host, a header fetch()
// refused and what was left of the answer, a token included.
function describeCause(error, depth = 0) {
  if (!(error instanceof Error) || depth === CAUSE_MAX_DEPTH) {
    return undefined;
  }

  return compact({
    type: readOwnText(error.name),
    code: readOwnText(error.code),
    syscall: readOwnText(error.syscall),
    cause: describeCause(error.cause, depth + 1),
  });
}

// A failure of the way there: the deadline, or the network with the code of its socket.
export function createWayFailure(call, error, signal, durationMs) {
  const cause = describeCause(error);

  return isTimeoutFailure(error, signal)
    ? createUpstreamFailure(call, UPSTREAM_FAILURE.TIMEOUT, { durationMs, cause })
    : createUpstreamFailure(call, UPSTREAM_FAILURE.NETWORK, { durationMs, code: readNetworkCode(error), cause });
}

function toFailure(error, call, signal, durationMs) {
  return findUpstreamError(error)
    ? error
    : createWayFailure(call, error, signal, durationMs);
}

// null for a body over the ceiling. The signal is asked and not the rejection: a pipe whose source has already ended
// closes without one.
async function collectBody(body, maxBytes) {
  const collector = createByteCollector(maxBytes);
  const overflow = new AbortController();

  function write(chunk) {
    if (!collector.add(chunk)) {
      overflow.abort();
    }
  }

  try {
    await body.pipeTo(new WritableStream({ write }), { signal: overflow.signal });
  } catch (error) {
    if (!overflow.signal.aborted) {
      throw error;
    }
  }

  return overflow.signal.aborted
    ? null
    : collector.read();
}

// The body is read chunk by chunk against the ceiling: a length the upstream declares may be absent or false, and
// the length of an answer to HEAD or of a 304 is that of a body which is not sent.
async function readResponseBody(response, call) {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const declaredLength = toNumber(response.headers.get(HEADER.CONTENT_LENGTH));

  if (declaredLength !== null && declaredLength > call.maxBytes) {
    await response.body.cancel();

    return null;
  }

  return collectBody(response.body, call.maxBytes);
}

export function logUpstreamCall(call, extra) {
  const { log } = getContext();

  log.info({ upstream: describeCall(call, extra) }, REQUEST_MESSAGE);
}

export function logUpstreamFailure(call, failure) {
  const { log } = getContext();
  const upstreamError = findUpstreamError(failure);

  log.info({
    upstream: describeCall(call, {
      reason: upstreamError?.reason,
      code: upstreamError?.code,
      durationMs: upstreamError?.durationMs,
    }),
  }, FAILED_MESSAGE);
}

// A redirect is an answer like any other, never followed: fetch() would turn the POST of a 301, 302 or 303 into
// a GET without its body, and the 200 of that GET would read as a delivery; a 307 would send the body elsewhere.
async function send(call, signal, startedAt) {
  const response = await fetch(call.target, {
    method: call.method,
    headers: call.headers,
    body: call.body,
    redirect: REDIRECT_MODE,
    signal,
  });
  const bytes = await readResponseBody(response, call);
  const durationMs = Math.round(performance.now() - startedAt);

  if (bytes === null) {
    throw createUpstreamFailure(call, UPSTREAM_FAILURE.TOO_LARGE, { status: response.status, durationMs, maxBytes: call.maxBytes });
  }

  return {
    status: response.status,
    headers: response.headers,
    text: UTF8_DECODER.decode(bytes),
    durationMs,
  };
}

async function runCall(call) {
  if (!call.target) {
    const failure = createUpstreamFailure(call, UPSTREAM_FAILURE.INVALID_URL);

    logUpstreamFailure(call, failure);

    throw failure;
  }

  const signal = AbortSignal.timeout(call.timeoutMs);
  const startedAt = performance.now();

  try {
    const result = await send(call, signal, startedAt);

    logUpstreamCall(call, { status: result.status, durationMs: result.durationMs });

    return result;
  } catch (error) {
    const failure = toFailure(error, call, signal, Math.round(performance.now() - startedAt));

    logUpstreamFailure(call, failure);

    throw failure;
  }
}

// Any status resolves, a failure of the way there rejects: an address that is not a URL, a network error,
// the deadline, a body over its ceiling. The rejection is an AppError with the code UPSTREAM_ERROR,
// and an UpstreamError that names the call is its cause.
export async function fetchUpstream(url, options = {}) {
  return runCall(readOptions(url, options, {
    signature: 'fetchUpstream(url, { service, method, headers, json, body, timeout, maxBytes, secrets, isAddressSecret })',
  }));
}

function isStatusBetween(status, min, max) {
  return Number.isInteger(status) && status >= min && status <= max;
}

export function isSuccessStatus(status) {
  return isStatusBetween(status, SUCCESS_STATUS_MIN, SUCCESS_STATUS_MAX);
}

export function isRedirectStatus(status) {
  return isStatusBetween(status, REDIRECT_STATUS_MIN, REDIRECT_STATUS_MAX);
}

// The start of a refusal goes into the error, for the code an upstream gives, with the secrets it echoes and the values
// its own errors repeat masked before the cut, which could leave half of one. A secret address may come back cut into
// its segments, in any form: its refusal keeps no body.
function readRefusal(text, call, config) {
  return isNonEmptyString(text) && !call.isAddressSecret
    ? truncate(maskErrorValues(maskPieces(text, call.echoes)), config.http.errorBodyMaxLength)
    : undefined;
}

// A status that is not a success and a body that is not JSON reject the same way a failure of the way there does;
// the parse error stays out, since it quotes the body around the place it failed.
export async function fetchJson(url, options = {}) {
  const call = readOptions(url, options, {
    signature: 'fetchJson(url, { service, method, headers, json, body, timeout, maxBytes, secrets, isAddressSecret })',
    headers: { [HEADER.ACCEPT]: MEDIA_TYPE.JSON },
  });
  const result = await runCall(call);
  const { config } = getContext();

  if (!isSuccessStatus(result.status)) {
    throw createUpstreamFailure(call, UPSTREAM_FAILURE.STATUS, { status: result.status, durationMs: result.durationMs, body: readRefusal(result.text, call, config) });
  }

  // A success with no body, such as 204, is no JSON to read.
  if (result.text === '') {
    return null;
  }

  try {
    return JSON.parse(result.text);
  } catch {
    throw createUpstreamFailure(call, UPSTREAM_FAILURE.INVALID_JSON, { status: result.status, durationMs: result.durationMs });
  }
}
