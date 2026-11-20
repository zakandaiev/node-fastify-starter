import { isArray, isFunction, isObject } from '#utils/type.js';

const SUBSCHEMA_KEYWORDS = Object.freeze([
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'oneOf',
  'propertyNames',
  'then',
]);

// The value is a map of a name to a subschema: its keys are names given by the author, not keywords.
export const SUBSCHEMA_MAP_KEYWORDS = Object.freeze(['$defs', 'definitions', 'dependencies', 'patternProperties', 'properties']);

const NUMERIC_TYPES = Object.freeze(['number', 'integer']);

const POINTER_ROOT = '#';
const POINTER_SEPARATOR = '/';

export function readSchemaTypes(schema) {
  if (!isObject(schema)) {
    throw new TypeError('readSchemaTypes(schema) requires a schema object');
  }

  return [schema.type ?? []].flat();
}

export function isNumericSchema(schema) {
  return readSchemaTypes(schema).some((type) => NUMERIC_TYPES.includes(type));
}

function walkSchema(schema, visit, path) {
  if (isArray(schema)) {
    return schema.map((item, index) => walkSchema(item, visit, [...path, String(index)]));
  }

  if (!isObject(schema)) {
    return schema;
  }

  const subschemas = SUBSCHEMA_KEYWORDS
    .filter((keyword) => schema[keyword] !== undefined)
    .map((keyword) => [keyword, walkSchema(schema[keyword], visit, [...path, keyword])]);
  const maps = SUBSCHEMA_MAP_KEYWORDS
    .filter((keyword) => isObject(schema[keyword]))
    .map((keyword) => [keyword, Object.fromEntries(
      Object.entries(schema[keyword]).map(([name, subschema]) => [name, walkSchema(subschema, visit, [...path, keyword, name])]),
    )]);

  return visit({ ...schema, ...Object.fromEntries([...subschemas, ...maps]) }, path);
}

// A JSON Schema, bottom up, into a copy: visit(schema, path) gets every subschema with its own subschemas
// already replaced and returns what stands in its place. The input is never written to: a schema is shared
// by the parts of a route, by its HEAD twin and by other routes, and it may be frozen. A $ref is not followed.
export function mapSchema(schema, visit) {
  if (!isFunction(visit)) {
    throw new TypeError('mapSchema(schema, visit) requires a function that returns the schema to put in place');
  }

  return walkSchema(schema, visit, []);
}

// The path a visitor gets, as AJV writes a schemaPath: "#/properties/email".
export function formatSchemaPointer(path) {
  return [POINTER_ROOT, ...path.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1'))].join(POINTER_SEPARATOR);
}
