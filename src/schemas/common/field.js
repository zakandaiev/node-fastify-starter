import { SCHEMA_LIMITS } from '#config/schema.js';
import { SCHEMA_FORMAT } from '#enums/schema-format.js';
import { SCHEMA_KEYWORD } from '#enums/schema-keyword.js';
import { ISO_DATE_LENGTH, ISO_DATE_TIME_MAX_LENGTH } from '#utils/date.js';
import { UUID_LENGTH, UUID_REGEXP } from '#utils/id.js';
import { omit, pick } from '#utils/object.js';
import { readSchemaTypes } from '#utils/schema.js';
import {
  isArray,
  isNonEmptyArray,
  isNonNegativeInteger,
  isObject,
  isPositiveInteger,
  isString,
} from '#utils/type.js';
import { EMAIL_MAX_LENGTH } from '#utils/validate.js';

const NULL_TYPE = 'null';

export function withDescription(schema, description) {
  return description === undefined
    ? schema
    : { ...schema, description };
}

// A pattern, not format "uuid": the format also takes upper case and "urn:uuid:", and MariaDB finds a row by any
// of those spellings, so one object would have several addresses.
export function uuid(description) {
  return withDescription({ type: 'string', maxLength: UUID_LENGTH, pattern: UUID_REGEXP.source }, description);
}

// Any script, not ASCII only; the address is checked once trimmed, lower-cased and in NFC, the form it is stored in.
export function email(description) {
  return withDescription({ type: 'string', maxLength: EMAIL_MAX_LENGTH, format: SCHEMA_FORMAT.EMAIL }, description);
}

export function dateTimeUtc(description) {
  return withDescription({ type: 'string', maxLength: ISO_DATE_TIME_MAX_LENGTH, format: SCHEMA_FORMAT.DATE_TIME_UTC }, description);
}

export function isoDate(description) {
  return withDescription({ type: 'string', maxLength: ISO_DATE_LENGTH, format: SCHEMA_FORMAT.DATE }, description);
}

// Empty text is refused by default: a field is cleared with null, so a column does not hold both '' and NULL
// for the same "nothing".
export function text(description, { minLength = 1, maxLength = SCHEMA_LIMITS.textMaxLength } = {}) {
  if (!isNonNegativeInteger(minLength) || !isPositiveInteger(maxLength) || minLength > maxLength) {
    throw new TypeError('text(description, { minLength, maxLength }) requires whole lengths with minLength not above maxLength');
  }

  return withDescription({ type: 'string', minLength, maxLength }, description);
}

// A name a person gives in a form: the format holds it to a word of letters (isValidPersonName), which may be shorter
// than its column.
export function personName(description, { maxLength = SCHEMA_LIMITS.textMaxLength } = {}) {
  return { ...text(description, { maxLength }), format: SCHEMA_FORMAT.PERSON_NAME };
}

export function enumOf(values, description) {
  if (!isNonEmptyArray(values) || !values.every((value) => isString(value)) || new Set(values).size !== values.length) {
    throw new TypeError('enumOf(values, description) requires a list of distinct strings');
  }

  return withDescription({ type: 'string', enum: [...values] }, description);
}

// For a JSON column such as profile, meta or payload: an object of any keys, written out as it is.
export function json(description) {
  return withDescription({ type: 'object', additionalProperties: true, [SCHEMA_KEYWORD.JSON]: true }, description);
}

// An enum lists null too: AJV checks the list after the type, and null would fail it.
export function nullable(field) {
  if (!isObject(field) || field.type === undefined) {
    throw new TypeError('nullable(field) requires the schema of a field that names its "type"');
  }

  const types = readSchemaTypes(field);

  return {
    ...field,
    ...(!types.includes(NULL_TYPE) && { type: [...types, NULL_TYPE] }),
    ...(isArray(field.enum) && !field.enum.includes(null) && { enum: [...field.enum, null] }),
  };
}

function joinTypes(types) {
  return types.length === 1
    ? types[0]
    : types;
}

// The reverse of nullable() for a query parameter: it is text, and with "null" among its types coercion would
// turn an empty value into null.
export function withoutNull(field) {
  if (!isObject(field)) {
    throw new TypeError('withoutNull(field) requires the schema of a field');
  }

  return {
    ...field,
    ...(field.type !== undefined && { type: joinTypes(readSchemaTypes(field).filter((type) => type !== NULL_TYPE)) }),
    ...(isArray(field.enum) && { enum: field.enum.filter((value) => value !== null) }),
  };
}

// A name that is not there is a typo in a route: the field would vanish from the request or the response.
function assertFieldNames(properties, keys, signature) {
  if (!isObject(properties) || !isArray(keys) || !keys.every((key) => isString(key))) {
    throw new TypeError(`${signature} requires a map of fields and a list of their names`);
  }

  const missing = keys.find((key) => !Object.hasOwn(properties, key));

  if (missing !== undefined) {
    throw new TypeError(`${signature} names a field that is not there: "${missing}"`);
  }

  if (new Set(keys).size !== keys.length) {
    throw new TypeError(`${signature} names a field twice`);
  }
}

export function pickFields(properties, keys) {
  assertFieldNames(properties, keys, 'pickFields(properties, keys)');

  return pick(properties, keys);
}

export function omitFields(properties, keys) {
  assertFieldNames(properties, keys, 'omitFields(properties, keys)');

  return omit(properties, keys);
}
