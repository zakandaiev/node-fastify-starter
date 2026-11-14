import { isArray, isFunction, isObject } from '#utils/type.js';

const FINITE_KEYWORD = 'finite';

const NUMERIC_TYPES = Object.freeze(['number', 'integer']);
const BODY_PART = 'body';

// Both spellings of the query: Fastify copies "query" to "querystring" only at ready(), after the onRoute hooks.
export const REQUEST_PARTS = Object.freeze([BODY_PART, 'querystring', 'query', 'params', 'headers']);

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
  'then',
]);

// The value is a map of a name to a subschema: its keys are names given by the author, not keywords.
const SUBSCHEMA_MAP_KEYWORDS = Object.freeze(['$defs', 'definitions', 'dependencies', 'patternProperties', 'properties']);

// These validate the same value as the schema that holds them: what they coerce stays coerced when the branch fails.
// A $ref is one of them, and the only place to guard its value: the hook does not see the schema it points to.
const SAME_VALUE_KEYWORDS = Object.freeze(['$ref', 'allOf', 'anyOf', 'if', 'not', 'oneOf']);

// The value is read from its parent when there is one: a schema AJV compiled apart from its caller (a $ref
// to a schema that holds a $ref itself) writes the coerced number there, and "data" still holds the text.
function isFiniteValue(isEnabled, data, parentSchema, dataContext) {
  const value = dataContext?.parentData === undefined
    ? data
    : dataContext.parentData[dataContext.parentDataProperty];

  return !isEnabled || typeof value !== 'number' || Number.isFinite(value);
}

// With coerceTypes "Infinity" and "1e400" become numbers, and AJV runs minimum and maximum only on finite ones.
// No "type" in the definition on purpose: a keyword of the number group sits under the same isFinite() check.
export function useFiniteKeyword(ajv) {
  if (!isFunction(ajv?.addKeyword)) {
    throw new TypeError('useFiniteKeyword(ajv) requires an instance of AJV');
  }

  ajv.addKeyword({
    keyword: FINITE_KEYWORD,
    schemaType: 'boolean',
    errors: false,
    error: {
      message: 'must be a finite number',
    },
    validate: isFiniteValue,
  });

  return ajv;
}

export function readSchemaTypes(schema) {
  if (!isObject(schema)) {
    throw new TypeError('readSchemaTypes(schema) requires a schema object');
  }

  return [schema.type ?? []].flat();
}

function needsGuard(schema) {
  const isNumeric = readSchemaTypes(schema).some((type) => NUMERIC_TYPES.includes(type));

  return schema[FINITE_KEYWORD] === undefined
    && (isNumeric || SAME_VALUE_KEYWORDS.some((keyword) => schema[keyword] !== undefined));
}

function guardSchemaMap(map) {
  return Object.fromEntries(Object.entries(map).map(([name, schema]) => [name, addFiniteGuards(schema)]));
}

// Returns a copy: a schema is shared by the parts of a route, by its HEAD twin and by other routes,
// and the builder of schemas may freeze it.
export function addFiniteGuards(schema) {
  if (isArray(schema)) {
    return schema.map((item) => addFiniteGuards(item));
  }

  if (!isObject(schema)) {
    return schema;
  }

  const guards = [
    ...SUBSCHEMA_KEYWORDS
      .filter((keyword) => schema[keyword] !== undefined)
      .map((keyword) => [keyword, addFiniteGuards(schema[keyword])]),
    ...SUBSCHEMA_MAP_KEYWORDS
      .filter((keyword) => isObject(schema[keyword]))
      .map((keyword) => [keyword, guardSchemaMap(schema[keyword])]),
  ];

  return {
    ...schema,
    ...Object.fromEntries(guards),
    ...(needsGuard(schema) && { [FINITE_KEYWORD]: true }),
  };
}

function guardBody(body) {
  if (!isObject(body) || !isObject(body.content)) {
    return addFiniteGuards(body);
  }

  return {
    ...body,
    content: Object.fromEntries(
      Object.entries(body.content).map(([mediaType, media]) => [mediaType, { ...media, schema: addFiniteGuards(media.schema) }]),
    ),
  };
}

function guardPart(part, schema) {
  return part === BODY_PART
    ? guardBody(schema)
    : addFiniteGuards(schema);
}

// Always a new top-level object: Fastify writes the "querystring" alias and a mark of its own into the schema
// of a route, which throws on a frozen one.
export function guardRouteSchema(routeSchema) {
  if (!isObject(routeSchema)) {
    throw new TypeError('guardRouteSchema(routeSchema) requires the schema object of a route');
  }

  const guards = REQUEST_PARTS
    .filter((part) => routeSchema[part] !== undefined)
    .map((part) => [part, guardPart(part, routeSchema[part])]);

  return {
    ...routeSchema,
    ...Object.fromEntries(guards),
  };
}
