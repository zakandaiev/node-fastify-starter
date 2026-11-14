import { maskDbErrorValues } from '#core/db/error.js';
import { maskSensitiveDeep, OMIT_VALUE, UNREADABLE_PLACEHOLDER } from '#utils/sensitive.js';
import {
  isArray,
  isFunction,
  isNonEmptyString,
  isObject,
  isString,
} from '#utils/type.js';
import pino from 'pino';

const LINE_BREAK = '\n';
const QUERY_SEPARATOR = '?';
const CUT_MARK = '…';

const DEFAULT_ERROR_TYPE = 'Error';
const MERGE_FALLBACK_KEY = 'mergingObject';
const MERGE_ENTRY_DEPTH = 1;

// sql: the driver puts the statement with its values there, the text protocol substitutes them on the client.
// validation: the list of a schema error; the error handler logs its own form of it, short and without values.
const ERROR_OMITTED_KEYS = Object.freeze(['sql', 'validation']);

// Fastify builds the text of these errors from the raw URL, query string included.
const URL_ERROR_CODES = Object.freeze(['FST_ERR_BAD_URL', 'FST_ERR_REP_ALREADY_SENT']);

// A getter of an error may throw: the property is replaced, the rest of the error is logged.
function readProperty(source, key) {
  try {
    return source[key];
  } catch {
    return UNREADABLE_PLACEHOLDER;
  }
}

function cutQuery(text, mark = '') {
  const queryStart = text.indexOf(QUERY_SEPARATOR);

  return queryStart === -1
    ? text
    : `${text.slice(0, queryStart)}${mark}`;
}

// Only the first line of a stack repeats the message.
function cutStackQuery(stack) {
  const [head, ...frames] = stack.split(LINE_BREAK);

  return [cutQuery(head, CUT_MARK), ...frames].join(LINE_BREAK);
}

function readErrorTexts(error) {
  const message = readProperty(error, 'message');
  const stack = readProperty(error, 'stack');

  if (!URL_ERROR_CODES.includes(readProperty(error, 'code'))) {
    return { message, stack };
  }

  return {
    message: isString(message)
      ? cutQuery(message, CUT_MARK)
      : message,
    stack: isString(stack)
      ? cutStackQuery(stack)
      : stack,
  };
}

function readErrorType(error) {
  const name = readProperty(Object(readProperty(error, 'constructor')), 'name');

  return isNonEmptyString(name)
    ? name
    : DEFAULT_ERROR_TYPE;
}

// What Object.keys() does not see: the members of an AggregateError and a cause given to the constructor
// are not enumerable, the name and the code of a DOMException are accessors of its prototype.
function readHiddenProperties(error) {
  const members = readProperty(error, 'errors');
  const hasHiddenMembers = isArray(members) && !Object.prototype.propertyIsEnumerable.call(error, 'errors');

  return {
    ...(error instanceof DOMException && { name: readProperty(error, 'name'), code: readProperty(error, 'code') }),
    ...(Object.hasOwn(error, 'cause') && { cause: readProperty(error, 'cause') }),
    ...(hasHiddenMembers && { aggregateErrors: members }),
  };
}

// Built here and not by pino.stdSerializers.err: that one tags the error it walks with a symbol, so a frozen
// error makes the log call throw, and it does not look into arrays and plain objects the error holds.
// The texts built here win over own properties of the same names: @fastify/error assigns "message" in its
// constructor, and that enumerable copy would bring back the query string the cut has removed.
function toPlainError(error) {
  const texts = { type: readErrorType(error), ...readErrorTexts(error) };
  const ownKeys = Object.keys(error).filter((key) => !Object.hasOwn(texts, key));

  return {
    ...texts,
    ...Object.fromEntries(ownKeys.map((key) => [key, readProperty(error, key)])),
    ...readHiddenProperties(error),
  };
}

// By the prototype or by the slot: an error of Fastify is the first only, an error of another realm the second.
function isError(value) {
  return value instanceof Error || Error.isError(value);
}

function toPlainObject(value) {
  if (isError(value)) {
    return toPlainError(value);
  }

  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} of ${value.byteLength} bytes]`;
  }

  return value instanceof String
    ? maskDbErrorValues(String(value))
    : { ...value };
}

// What toJSON() gives is read like any other value and never asked for toJSON() again: it may be an instance,
// an error, a function with a toJSON() of its own or the value itself.
function readJsonForm(value, key) {
  const written = value.toJSON(key);

  if (isFunction(written)) {
    return OMIT_VALUE;
  }

  if (isString(written)) {
    return maskDbErrorValues(written);
  }

  return written === null || typeof written !== 'object' || isArray(written)
    ? written
    : toPlainObject(written);
}

// The form JSON.stringify would write for an object that is not a plain one, so that it is walked before
// it is written: an error or a secret inside it must not pass by the masking.
function readObjectForm(value, key) {
  if (isError(value) || ArrayBuffer.isView(value)) {
    return toPlainObject(value);
  }

  if (isFunction(value.toJSON)) {
    return readJsonForm(value, key);
  }

  return isObject(value)
    ? value
    : toPlainObject(value);
}

// The text of the driver may be the key of an entry as well: a tally of failures by their message.
function maskKeys(container) {
  const names = Object.keys(container);

  return names.some((name) => maskDbErrorValues(name) !== name)
    ? Object.fromEntries(names.map((name) => [maskDbErrorValues(name), container[name]]))
    : container;
}

// A function is left out, not left to JSON.stringify: an own toJSON() that survived in a copy would be called
// there, and what it returns is written past the masking.
function cleanLogValue(value, key) {
  if (ERROR_OMITTED_KEYS.includes(key) || isFunction(value)) {
    return OMIT_VALUE;
  }

  if (isString(value)) {
    return maskDbErrorValues(value);
  }

  if (value === null || typeof value !== 'object' || isArray(value)) {
    return value;
  }

  const form = readObjectForm(value, key);

  return isObject(form)
    ? maskKeys(form)
    : form;
}

// Never throws: pino hands the exception of a serializer to the caller of the log method, so the line
// would be lost and the error handler would fall back to its raw answer.
export function serializeError(error) {
  return maskSensitiveDeep(error, { replace: cleanLogValue });
}

// The serializer of Fastify logs request.url as it is: a query string carries OAuth codes and tokens.
// It runs before any hook and on the frameworkErrors path, so it reads nothing a plugin adds.
function serializeRequest(request) {
  return {
    method: request?.method,
    url: cutQuery(String(request?.url ?? '')),
    host: request?.host,
    remoteAddress: request?.ip,
  };
}

function serializeReply(reply) {
  return {
    statusCode: reply?.statusCode,
  };
}

// pino copies err.message into msg when a call gives no message of its own, and that copy passes by
// serializers.err: it is cleaned the same way, a message that is not a text included.
const SERIALIZERS = Object.freeze({
  err: serializeError,
  msg: serializeError,
  req: serializeRequest,
  res: serializeReply,
});

// An instance gets its plain form here as well, or the walk passes it by and its secrets are written;
// an error under any other key than "err" is cleaned like one under it. What pino hands to a serializer
// is left for it: the req and res serializers read getters of a prototype, which a copy does not carry.
function cleanMergeValue(value, key, depth) {
  const isLeftAlone = value === null
    || typeof value !== 'object'
    || isArray(value)
    || (depth === MERGE_ENTRY_DEPTH && Object.hasOwn(SERIALIZERS, key));

  if (isLeftAlone) {
    return value;
  }

  return isError(value)
    ? serializeError(value)
    : readObjectForm(value, key);
}

// pino writes whatever the formatter returns key by key: a text would go out as its letters.
function maskMergeObject(merge) {
  const masked = maskSensitiveDeep(merge, { replace: cleanMergeValue });

  return isObject(masked)
    ? masked
    : { [MERGE_FALLBACK_KEY]: masked };
}

export function createLogger({ level, isPretty = false, stream } = {}) {
  if (!level) {
    throw new TypeError('createLogger({ level }) requires a log level');
  }

  if (isPretty && stream) {
    throw new TypeError('createLogger({ isPretty, stream }) cannot have both: pino drops the stream when a transport is set');
  }

  return pino({
    level,
    serializers: SERIALIZERS,
    formatters: {
      log: maskMergeObject,
    },
    ...(isPretty && {
      transport: {
        target: 'pino-pretty',
      },
    }),
  }, stream);
}
