import { mapRequestSchemas } from '#core/schema/walk.js';
import { SCHEMA_KEYWORD } from '#enums/schema-keyword.js';
import { isNumericSchema, mapSchema } from '#utils/schema.js';
import { isFunction, isObject } from '#utils/type.js';

const FINITE_KEYWORD = SCHEMA_KEYWORD.FINITE;

// These validate the same value as the schema that holds them: what they coerce stays coerced when the branch fails.
// A $ref is not one of them: a local one points into the definitions this walk guards, a shared one into a schema
// the validator of the app guards when it adds it.
const SAME_VALUE_KEYWORDS = Object.freeze(['allOf', 'anyOf', 'if', 'not', 'oneOf']);

// The value is read from its parent when there is one: a schema AJV compiled apart from its caller (a $ref
// to a schema that holds a $ref itself) writes the coerced number there, and "data" still holds the text.
function isFiniteValue(data, dataContext) {
  const value = dataContext?.parentData === undefined
    ? data
    : dataContext.parentData[dataContext.parentDataProperty];

  return typeof value !== 'number' || Number.isFinite(value);
}

function acceptValue() {
  return true;
}

// Without coercion a schema with a "type" refuses Infinity by itself (strictNumbers): a second entry for the same
// value would only repeat it.
function compileFinite(isEnabled, parentSchema, { opts }) {
  const isRefusedByType = parentSchema.type !== undefined && !opts.coerceTypes && opts.strictNumbers !== false;

  return isEnabled && !isRefusedByType
    ? isFiniteValue
    : acceptValue;
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
    compile: compileFinite,
  });

  return ajv;
}

function needsGuard(schema) {
  return schema[FINITE_KEYWORD] === undefined
    && (isNumericSchema(schema) || SAME_VALUE_KEYWORDS.some((keyword) => schema[keyword] !== undefined));
}

function markFinite(schema) {
  return needsGuard(schema)
    ? { ...schema, [FINITE_KEYWORD]: true }
    : schema;
}

export function addFiniteGuards(schema) {
  return mapSchema(schema, markFinite);
}

export function guardRouteSchema(routeSchema) {
  if (!isObject(routeSchema)) {
    throw new TypeError('guardRouteSchema(routeSchema) requires the schema object of a route');
  }

  return mapRequestSchemas(routeSchema, addFiniteGuards);
}
