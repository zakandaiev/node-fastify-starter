import { pickFields, uuid, withoutNull } from '#schemas/common/field.js';
import { properties as paginationProperties } from '#schemas/common/pagination.js';
import { omit } from '#utils/object.js';
import { mapSchema } from '#utils/schema.js';
import { isObject } from '#utils/type.js';

const DEFAULT_KEYWORD = 'default';

function assertFields(fields, signature) {
  if (!isObject(fields)) {
    throw new TypeError(`${signature} requires a map of fields`);
  }

  return true;
}

function dropDefaults(field) {
  return mapSchema(field, (schema) => omit(schema, [DEFAULT_KEYWORD]));
}

// Every field is optional and keeps no default at any depth: a PATCH writes the keys it got, and a default
// would write a value the client never sent. An unknown key is dropped (removeAdditional), never written.
export function patchBody(properties, keys = Object.keys(properties ?? {})) {
  const fields = pickFields(properties, keys);

  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, dropDefaults(field)])),
    additionalProperties: false,
  };
}

export function pathParams(fields) {
  assertFields(fields, 'pathParams(fields)');

  return {
    type: 'object',
    properties: fields,
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

export function queryParams(fields) {
  assertFields(fields, 'queryParams(fields)');

  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, withoutNull(field)])),
    additionalProperties: false,
  };
}

export function idParam(description) {
  return pathParams({ id: uuid(description) });
}

export function listQuery(fields = {}) {
  assertFields(fields, 'listQuery(fields)');

  const taken = Object.keys(fields).find((key) => Object.hasOwn(paginationProperties, key));

  if (taken !== undefined) {
    throw new TypeError(`listQuery(fields) cannot redefine the pagination field "${taken}"`);
  }

  return queryParams({ ...paginationProperties, ...fields });
}
