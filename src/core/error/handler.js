import { classifyError, findUniqueViolation, isSchemaError } from '#core/error/classify.js';
import { AppError } from '#core/error/index.js';
import { maskErrorValues } from '#core/error/mask.js';
import { formatValidation, normalizeValidation } from '#core/error/validation.js';
import { createEnvelope } from '#core/response/index.js';
import { ERROR_CATALOG, ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { convertStringToSeconds, nowUtc } from '#utils/date.js';
import { uuidv7 } from '#utils/id.js';
import { getPath, omit } from '#utils/object.js';
import {
  isArray,
  isNonEmptyArray,
  isNonEmptyString,
  isNonNegativeInteger,
  isObject,
  isPositiveInteger,
  isString,
} from '#utils/type.js';
import { STATUS_CODES, validateHeaderName, validateHeaderValue } from 'node:http';

const JSON_CONTENT_TYPE = MEDIA_TYPE.JSON_UTF8;
const NO_STORE = 'no-store';
const CONNECTION_CLOSE = 'close';
const HTTP_VERSION = 'HTTP/1.1';
const HTTP_LINE_BREAK = '\r\n';

const REQUEST_FAILED_MESSAGE = 'Request failed';
const RESPONSE_STARTED_MESSAGE = 'Request failed after the response had started';
const HANDLER_FAILED_MESSAGE = 'Error handler failed';
const CLIENT_ERROR_MESSAGE = 'Connection closed on a client error';

const CONNECTION_RESET_CODE = 'ECONNRESET';

const UNIQUE_OPERATOR = 'unique';

// The codes Node gives up on a connection with: its timeout check and its parser. Any other code is a bad request.
const CLIENT_ERROR_STATUSES = Object.freeze({
  ERR_HTTP_REQUEST_TIMEOUT: HTTP_STATUS.REQUEST_TIMEOUT,
  HPE_HEADER_OVERFLOW: HTTP_STATUS.REQUEST_HEADER_FIELDS_TOO_LARGE,
  HPE_CHUNK_EXTENSIONS_OVERFLOW: HTTP_STATUS.PAYLOAD_TOO_LARGE,
});

// These describe a body, and the body of an error is always our JSON: under the Content-Type of the error
// Fastify refuses to serialize an object, under its Content-Encoding the client cannot read it,
// and Node refuses a Trailer once Transfer-Encoding is gone.
const BODY_HEADERS = Object.freeze([
  HEADER.CONTENT_TYPE,
  HEADER.CONTENT_LENGTH,
  HEADER.CONTENT_ENCODING,
  HEADER.TRANSFER_ENCODING,
  HEADER.TRAILER,
]);

// What a client sent and the raw error of AJV stay out of the log: the first is personal data, the second repeats it.
const VALIDATION_LOG_OMITTED_KEYS = Object.freeze(['columnValue', 'schema']);

// At startup, not on the first 422 or 503: a wrong value would only show as the raw fallback of the handler.
// Retry-After is a whole number of seconds: a client ignores or misreads "1.5" and "-30".
export function assertErrorConfig(appConfig) {
  const { maxErrors, maxValueLength, maxListLength } = appConfig?.validation ?? {};

  if (![maxErrors, maxValueLength, maxListLength].every((limit) => isPositiveInteger(limit))) {
    throw new TypeError('config.app.validation requires maxErrors, maxValueLength and maxListLength to be positive integers');
  }

  const retryAfter = convertStringToSeconds(appConfig.unavailableRetryAfter);

  if (!isNonNegativeInteger(retryAfter)) {
    throw new TypeError('config.app.unavailableRetryAfter requires a whole number of seconds that is not negative');
  }
}

function isServerFault(statusCode) {
  return statusCode >= HTTP_STATUS.INTERNAL_SERVER_ERROR && statusCode !== HTTP_STATUS.SERVICE_UNAVAILABLE;
}

function describeAppError(error, { appConfig }) {
  return {
    message: error.message,
    validation: isArray(error.validation)
      ? normalizeValidation(error.validation, appConfig.validation)
      : undefined,
    headers: error.headers,
  };
}

function describeSchemaError(error, request, { code, appConfig }) {
  return {
    message: ERROR_CATALOG[code].message,
    validation: code === ERROR_CODE.VALIDATION_ERROR
      ? formatValidation(error, request, { ...appConfig.validation, isDev: appConfig.isDev })
      : undefined,
  };
}

// Own keys only: an index named "constructor" must not read a method of the map for a field.
// The map is the decorator of the error-handler plugin: without it a duplicate goes out under a null column.
function readUniqueField(request, constraint) {
  const field = isString(constraint)
    ? getPath(request.server.uniqueFields, [constraint])
    : undefined;

  return isNonEmptyString(field)
    ? field
    : null;
}

// The text of the database names the index, so only a developer reads it; the driver has masked the value there.
function describeUniqueViolation(dbError, request, { code, appConfig }) {
  const column = readUniqueField(request, dbError.constraint);

  return {
    message: appConfig.isDev && isNonEmptyString(dbError.message)
      ? dbError.message
      : ERROR_CATALOG[code].message,
    validation: normalizeValidation([{
      column,
      columnValue: column === null
        ? null
        : getPath(request.body, [column]),
      operator: UNIQUE_OPERATOR,
      operatorValue: null,
    }], appConfig.validation),
  };
}

// The headers of an unknown fault are details of it: only a refusal carries them to the client.
function describeForeignError(error, { code, statusCode, appConfig }) {
  return {
    message: appConfig.isDev && isNonEmptyString(error?.message)
      ? maskErrorValues(error.message)
      : ERROR_CATALOG[code].message,
    headers: isServerFault(statusCode)
      ? undefined
      : error?.headers,
  };
}

function describeDetails(error, request, classification) {
  if (error instanceof AppError) {
    return describeAppError(error, classification);
  }

  const violation = findUniqueViolation(error);

  if (violation) {
    return describeUniqueViolation(violation, request, classification);
  }

  return isSchemaError(error)
    ? describeSchemaError(error, request, classification)
    : describeForeignError(error, classification);
}

function describeFailure(error, request, appConfig) {
  const { code, statusCode } = classifyError(error);

  return {
    code,
    statusCode,
    logLevel: ERROR_CATALOG[code].logLevel,
    stack: appConfig.isDev && isServerFault(statusCode) && isString(error?.stack)
      ? maskErrorValues(error.stack)
      : undefined,
    ...describeDetails(error, request, { code, statusCode, appConfig }),
  };
}

// Item by item, as writeHead does: Node joins a list before validateHeaderValue() looks at it,
// and an undefined item passes there. Array.from() turns a hole into the undefined that writeHead reads.
function isSendableHeader(name, value) {
  const items = isArray(value)
    ? Array.from(value)
    : [value];

  try {
    validateHeaderName(name);
    items.forEach((item) => validateHeaderValue(name, item));

    return true;
  } catch {
    return false;
  }
}

// A header Node refuses makes writeHead throw after reply.send() has returned, where only Fastify can answer,
// and it answers with its own body. So the ones a route left on the reply go, and those of the error are not copied.
function dropUnsendableHeaders(reply) {
  Object.entries(reply.getHeaders())
    .filter(([name, value]) => !isSendableHeader(name, value))
    .forEach(([name]) => reply.removeHeader(name));
}

function copyHeaders(headers, reply) {
  if (!isObject(headers)) {
    return false;
  }

  Object.entries(headers)
    .filter(([name]) => !BODY_HEADERS.includes(name.toLowerCase()))
    .filter(([name, value]) => isSendableHeader(name, value))
    .forEach(([name, value]) => reply.header(name, value));

  return true;
}

// A writeHead that Node refused has already marked the response: the reason phrase of the first status,
// no body after a 204 or a 304, chunked framing. The envelope goes out on that same response.
function reviveResponse(request, reply) {
  const { raw } = reply;

  if (raw.statusMessage === undefined) {
    return false;
  }

  raw.statusMessage = undefined;
  raw.chunkedEncoding = false;
  // eslint-disable-next-line no-underscore-dangle -- Node has no public way to take back "this response has no body"
  raw._hasBody = request.raw.method !== HTTP_METHOD.HEAD;

  return true;
}

// The reply still carries what the route did to it before it failed: a serializer of its own, the caching
// policy of the answer that never came. An error is never stored, unless the error itself says otherwise.
function resetReply(request, reply) {
  reviveResponse(request, reply);
  reply.serializer(null);
  BODY_HEADERS.forEach((name) => reply.removeHeader(name));
  dropUnsendableHeaders(reply);
  reply.header(HEADER.CACHE_CONTROL, NO_STORE);
}

// The body goes out as a string: serialized here, a failure lands in the catch of handleError,
// and a response schema the route declares for this status can neither cut the envelope nor break it.
function sendFailure(failure, request, reply, appConfig) {
  const body = JSON.stringify(createEnvelope({
    code: failure.code,
    message: failure.message,
    validation: failure.validation,
    requestId: request.id,
    stack: failure.stack,
  }));

  resetReply(request, reply);
  copyHeaders(failure.headers, reply);

  if (failure.code === ERROR_CODE.SERVICE_UNAVAILABLE_ERROR && !reply.hasHeader(HEADER.RETRY_AFTER)) {
    reply.header(HEADER.RETRY_AFTER, String(convertStringToSeconds(appConfig.unavailableRetryAfter)));
  }

  reply
    .code(failure.statusCode)
    .header(HEADER.REQUEST_ID, request.id)
    .type(JSON_CONTENT_TYPE)
    .send(body);
}

function logFailure(error, failure, request) {
  const validation = isNonEmptyArray(failure.validation)
    ? failure.validation.map((entry) => omit(entry, VALIDATION_LOG_OMITTED_KEYS))
    : undefined;

  request.log[failure.logLevel]({ err: error, validation }, REQUEST_FAILED_MESSAGE);
}

// A response that waits in a pipeline has no socket yet, and destroy() closes nothing then: when its turn
// comes, Node writes the started head and never ends it. The socket is destroyed as soon as it is assigned.
function tearDown(raw) {
  raw.once('socket', (socket) => socket.destroy());
  raw.destroy();
}

function respond(error, request, reply) {
  if (reply.sent) {
    return false;
  }

  // reply.sent is still false here: JSON appended to a started body would corrupt it.
  if (reply.raw.headersSent) {
    request.log.error({ err: error }, RESPONSE_STARTED_MESSAGE);
    tearDown(reply.raw);

    return false;
  }

  const appConfig = request.server.config.app;
  const failure = describeFailure(error, request, appConfig);

  logFailure(error, failure, request);
  sendFailure(failure, request, reply, appConfig);

  return true;
}

// The error has just broken the handler, so it is read once more under a guard of its own.
function readFallbackStatus(error) {
  try {
    return classifyError(error).statusCode;
  } catch {
    return HTTP_STATUS.INTERNAL_SERVER_ERROR;
  }
}

// Nothing of the failed attempt is sent: neither its headers nor the reason phrase, the missing body
// and the chunked framing its writeHead left. A "connection: close" it carried still closes the connection.
function sendRawFailure(error, request, reply) {
  const { raw } = reply;

  if (raw.destroyed || raw.writableEnded) {
    return false;
  }

  if (raw.headersSent) {
    tearDown(raw);

    return false;
  }

  const status = readFallbackStatus(error);
  const isClientError = status < HTTP_STATUS.INTERNAL_SERVER_ERROR;
  const code = isClientError
    ? ERROR_CODE.BAD_REQUEST_ERROR
    : ERROR_CODE.SERVER_ERROR;
  const statusCode = isClientError
    ? status
    : HTTP_STATUS.INTERNAL_SERVER_ERROR;
  const body = JSON.stringify(createEnvelope({
    code,
    message: ERROR_CATALOG[code].message,
    requestId: request.id,
  }));

  raw.getHeaderNames().forEach((name) => raw.removeHeader(name));
  reviveResponse(request, reply);
  raw.writeHead(statusCode, {
    [HEADER.CONTENT_TYPE]: JSON_CONTENT_TYPE,
    [HEADER.CONTENT_LENGTH]: Buffer.byteLength(body),
    [HEADER.CACHE_CONTROL]: NO_STORE,
    ...(isString(request.id) && { [HEADER.REQUEST_ID]: request.id }),
  });
  raw.end(body);

  return true;
}

function answerHandlerFailure(error, request, reply) {
  try {
    sendRawFailure(error, request, reply);
  } catch {
    tearDown(reply.raw);
  }
}

function logHandlerFailure(request, handlerError) {
  try {
    request.log.error({ err: handlerError }, HANDLER_FAILED_MESSAGE);
  } catch {
    // The logger is what failed: there is nothing left to report with.
  }
}

// Synchronous and total, with no decorator, hook or context behind it: the router calls the same function
// as frameworkErrors, outside the try/catch of Fastify, where an exception takes the process down.
// It ends without a value: Fastify sends whatever an error handler returns as the body.
export function handleError(error, request, reply) {
  try {
    respond(error, request, reply);
  } catch (handlerError) {
    answerHandlerFailure(error, request, reply);
    logHandlerFailure(request, handlerError);
  }
}

function logClientError(log, error, failure) {
  try {
    log[ERROR_CATALOG[failure.code].logLevel]({ err: error, requestId: failure.requestId }, CLIENT_ERROR_MESSAGE);
  } catch {
    // The logger is what failed: there is nothing left to report with.
  }
}

function writeClientError(socket, { code, statusCode, requestId }) {
  const body = JSON.stringify(createEnvelope({ code, message: ERROR_CATALOG[code].message, requestId }));
  const head = [
    `${HTTP_VERSION} ${statusCode} ${STATUS_CODES[statusCode]}`,
    `${HEADER.DATE}: ${nowUtc().toUTCString()}`,
    `${HEADER.CONTENT_TYPE}: ${JSON_CONTENT_TYPE}`,
    `${HEADER.CONTENT_LENGTH}: ${Buffer.byteLength(body)}`,
    `${HEADER.CACHE_CONTROL}: ${NO_STORE}`,
    `${HEADER.REQUEST_ID}: ${requestId}`,
    `${HEADER.CONNECTION}: ${CONNECTION_CLOSE}`,
  ].join(HTTP_LINE_BREAK);

  socket.write(`${head}${HTTP_LINE_BREAK}${HTTP_LINE_BREAK}${body}`);
}

// Node keeps the response in flight on the socket. Once its head went out, an answer written here would land
// in the middle of that response, so the connection is only closed, as Node itself does.
function isResponseStarted(socket) {
  // eslint-disable-next-line no-underscore-dangle -- Node shows the response in flight of a socket in no other way
  return socket._httpMessage?._headerSent === true;
}

function answerClientError(socket, failure) {
  try {
    if (socket.writable && !isResponseStarted(socket)) {
      writeClientError(socket, failure);
    }
  } catch {
    // The socket is what failed: it is destroyed by the caller either way.
  }
}

function readClientErrorStatus(error) {
  return Object.hasOwn(CLIENT_ERROR_STATUSES, error?.code)
    ? CLIENT_ERROR_STATUSES[error.code]
    : HTTP_STATUS.BAD_REQUEST;
}

function refuseClient(server, error, socket) {
  if (error?.code === CONNECTION_RESET_CODE || socket.destroyed) {
    return false;
  }

  const failure = { ...classifyError({ statusCode: readClientErrorStatus(error) }), requestId: uuidv7() };

  answerClientError(socket, failure);
  logClientError(server.log, error, failure);
  socket.destroy(error);

  return true;
}

function closeClientSocket(socket, error) {
  try {
    socket.destroy(error);
  } catch {
    // The socket is what failed: nothing else can close it.
  }
}

// Node gave up on the connection, usually before there was a route, a hook or a reply: the envelope is written
// to the socket by hand, under an id made here; a request already in its handler logs its own failure under
// its own id. Fastify binds the handler to its instance. It is a listener of the server, so it must not throw.
export function handleClientError(error, socket) {
  try {
    return refuseClient(this, error, socket);
  } catch {
    closeClientSocket(socket, error);

    return false;
  }
}

export function handleNotFound(request, reply) {
  const appConfig = request.server.config.app;
  const entry = ERROR_CATALOG[ERROR_CODE.NOT_FOUND_ERROR];

  sendFailure({
    code: ERROR_CODE.NOT_FOUND_ERROR,
    statusCode: entry.statusCode,
    message: appConfig.isDev
      ? `Route ${request.method} ${request.url} not found`
      : entry.message,
  }, request, reply, appConfig);
}
