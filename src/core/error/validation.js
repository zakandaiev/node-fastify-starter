import { getPath } from '#utils/object.js';
import { isSensitiveKey } from '#utils/sensitive.js';
import { truncate } from '#utils/string.js';
import {
  isArray,
  isBoolean,
  isNonEmptyString,
  isNumber,
  isObject,
  isPositiveInteger,
  isString,
} from '#utils/type.js';

const POINTER_SEPARATOR = '/';
const POINTER_ESCAPED_SLASH = '~1';
const POINTER_ESCAPED_TILDE = '~0';
const POINTER_TILDE = '~';
const COLUMN_SEPARATOR = '.';

const PROPERTY_NAMES_KEYWORD = 'propertyNames';

const CONTEXT_SOURCES = Object.freeze({
  body: 'body',
  querystring: 'query',
  params: 'params',
  headers: 'headers',
});

// instancePath of these keywords is the parent object: the field itself is named in params.
const COLUMN_PARAMS = Object.freeze({
  required: 'missingProperty',
  additionalProperties: 'additionalProperty',
  propertyNames: 'propertyName',
  dependencies: 'missingProperty',
});

const OPERATOR_VALUE_PARAMS = Object.freeze({
  type: 'type',
  enum: 'allowedValues',
  const: 'allowedValue',
  format: 'format',
  pattern: 'pattern',
  multipleOf: 'multipleOf',
  minimum: 'limit',
  maximum: 'limit',
  exclusiveMinimum: 'limit',
  exclusiveMaximum: 'limit',
  minLength: 'limit',
  maxLength: 'limit',
  minItems: 'limit',
  maxItems: 'limit',
  minProperties: 'limit',
  maxProperties: 'limit',
  additionalItems: 'limit',
  formatMinimum: 'limit',
  formatMaximum: 'limit',
  formatExclusiveMinimum: 'limit',
  formatExclusiveMaximum: 'limit',
});

// A list that refuses the cut (frozen, a read-only length, a locked item) is still capped by the copy
// formatValidation takes.
function cutList(list, maxLength) {
  try {
    list.length = maxLength;
  } catch {
    return false;
  }

  return true;
}

// Total on purpose: Fastify calls the formatter outside try/catch when the route has an async preValidation hook.
// The list is cut in place: Fastify attaches this very array to the error after the formatter returns,
// and AJV with allErrors gives one error per element of a 50 000-item array.
export function createSchemaErrorFormatter(maxErrors) {
  if (!isPositiveInteger(maxErrors)) {
    throw new TypeError('createSchemaErrorFormatter(maxErrors) requires a positive integer');
  }

  function formatSchemaErrors(errors, dataVar) {
    const count = isArray(errors)
      ? errors.length
      : 0;

    if (count > maxErrors) {
      cutList(errors, maxErrors);
    }

    return new Error(`Request ${dataVar} is not valid: ${count} schema errors`);
  }

  return formatSchemaErrors;
}

// The order matters: "~01" stands for "~1", not for "/".
function decodePointer(instancePath) {
  if (!isNonEmptyString(instancePath)) {
    return [];
  }

  return instancePath
    .slice(POINTER_SEPARATOR.length)
    .split(POINTER_SEPARATOR)
    .map((segment) => segment.replaceAll(POINTER_ESCAPED_SLASH, POINTER_SEPARATOR).replaceAll(POINTER_ESCAPED_TILDE, POINTER_TILDE));
}

// Own keys only: a keyword named "constructor" must not read a method of the map for a parameter name.
function readParam(error, paramNames) {
  const name = isString(error.keyword)
    ? getPath(paramNames, [error.keyword])
    : undefined;

  return isString(name)
    ? getPath(error.params, [name])
    : undefined;
}

// AJV reports a bad key twice: by the keyword of propertyNames, and before it by the keyword the name broke.
// That first error names the key in a field of its own, and its instancePath is still the parent.
function readPropertyName(error) {
  return error.keyword === PROPERTY_NAMES_KEYWORD
    ? readParam(error, COLUMN_PARAMS)
    : error.propertyName;
}

function readSegments(error) {
  const segments = decodePointer(error.instancePath);
  const column = readPropertyName(error) ?? readParam(error, COLUMN_PARAMS);

  return isString(column)
    ? [...segments, column]
    : segments;
}

// A primitive only: an object from the body nested a thousand levels deep overflows the stack of the serializer.
// JSON has no Infinity or NaN and refuses a BigInt: such a number goes out as text.
function toReflectedValue(value, maxValueLength) {
  if (isString(value)) {
    return truncate(value, maxValueLength);
  }

  if (isNumber(value) || isBoolean(value)) {
    return value;
  }

  return typeof value === 'number' || typeof value === 'bigint'
    ? String(value)
    : null;
}

// A list stays a list, within a ceiling of its own: the allowed values of an enum come from the schema,
// and a long one would be repeated in every entry of the response.
function toOperatorValue(value, { maxValueLength, maxListLength }) {
  return isArray(value)
    ? value.slice(0, maxListLength).map((item) => toReflectedValue(item, maxValueLength))
    : toReflectedValue(value, maxValueLength);
}

// One shape for every source of an entry, AJV and AppError alike: the column of a client is as long as the key
// it sent, the value under a sensitive column is never reflected, and nothing in it can fail JSON.stringify.
function createEntry({
  column,
  columnValue,
  operator,
  operatorValue,
}, limits) {
  const { maxValueLength } = limits;
  const isColumnGiven = isNonEmptyString(column);

  return {
    column: isColumnGiven
      ? truncate(column, maxValueLength)
      : null,
    columnValue: isColumnGiven && !isSensitiveKey(column)
      ? toReflectedValue(columnValue, maxValueLength)
      : null,
    operator: isString(operator)
      ? truncate(operator, maxValueLength)
      : null,
    operatorValue: toOperatorValue(operatorValue, limits),
  };
}

// The value of a broken key is the key itself.
function readColumnValue(error, source, segments) {
  return isString(readPropertyName(error))
    ? segments.at(-1)
    : getPath(source, segments);
}

function toSchemaEntry(error, source, { isDev, ...limits }) {
  const segments = readSegments(error);
  const entry = createEntry({
    column: segments.join(COLUMN_SEPARATOR),
    columnValue: readColumnValue(error, source, segments),
    operator: error.keyword,
    operatorValue: readParam(error, OPERATOR_VALUE_PARAMS),
  }, limits);

  return isDev
    ? { ...entry, schema: error }
    : entry;
}

// The value is read after coercion: AJV writes coerced values and defaults into the request even when it fails.
export function formatValidation(error, request, {
  maxErrors,
  maxValueLength,
  maxListLength,
  isDev = false,
}) {
  const source = request?.[CONTEXT_SOURCES[error.validationContext]];

  return error.validation
    .slice(0, maxErrors)
    .filter((item) => isObject(item))
    .map((item) => toSchemaEntry(item, source, { maxValueLength, maxListLength, isDev }));
}

// The list of an AppError is built by the application, often from the request: the same ceiling and the same
// rules for a value apply, and the array of the thrower stays as it was.
export function normalizeValidation(validation, { maxErrors, maxValueLength, maxListLength }) {
  return validation
    .slice(0, maxErrors)
    .filter((item) => isObject(item))
    .map((item) => createEntry(item, { maxValueLength, maxListLength }));
}
