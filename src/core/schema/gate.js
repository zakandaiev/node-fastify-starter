import { mapRequestSchemas } from '#core/schema/walk.js';
import { omit, pick } from '#utils/object.js';
import { formatSchemaPointer, mapSchema, readSchemaTypes } from '#utils/schema.js';
import { isNonNegativeInteger, isObject } from '#utils/type.js';

const STRING_TYPE = 'string';
const ARRAY_TYPE = 'array';

// The keywords that cost more than the length of the value: a regexp, a format and a pairwise comparison.
const TEXT_KEYWORDS = Object.freeze(['pattern', 'format']);
const ITEMS_KEYWORD = 'uniqueItems';

// ajv-formats checks these against the format of the same schema: they go wherever the format goes.
const FORMAT_LIMIT_KEYWORDS = Object.freeze(['formatMinimum', 'formatMaximum', 'formatExclusiveMinimum', 'formatExclusiveMaximum']);

function canHold(schema, type) {
  const types = readSchemaTypes(schema);

  return types.length === 0 || types.includes(type);
}

// The limit goes into "then" too: a schema gated twice keeps working instead of failing on its own branch.
function appendGate(schema, keywords, limit) {
  return {
    ...omit(schema, keywords),
    allOf: [...(schema.allOf ?? []), { if: limit, then: { ...limit, ...pick(schema, keywords) } }],
  };
}

function gateText(schema, path, { label, isStrict }) {
  const keywords = TEXT_KEYWORDS.filter((keyword) => schema[keyword] !== undefined);

  if (!keywords.length || !canHold(schema, STRING_TYPE)) {
    return schema;
  }

  if (isNonNegativeInteger(schema.maxLength)) {
    const moved = [...keywords, ...FORMAT_LIMIT_KEYWORDS.filter((keyword) => schema[keyword] !== undefined)];

    return appendGate(schema, moved, { maxLength: schema.maxLength });
  }

  if (!isStrict) {
    return schema;
  }

  throw new TypeError(`${label} ${formatSchemaPointer(path)} has ${keywords.map((keyword) => `"${keyword}"`).join(' and ')} without "maxLength": a request string with a pattern or a format needs a length limit`);
}

function gateItems(schema, path, { label, isStrict }) {
  if (schema[ITEMS_KEYWORD] !== true || !canHold(schema, ARRAY_TYPE)) {
    return schema;
  }

  if (isNonNegativeInteger(schema.maxItems)) {
    return appendGate(schema, [ITEMS_KEYWORD], { maxItems: schema.maxItems });
  }

  if (!isStrict) {
    return schema;
  }

  throw new TypeError(`${label} ${formatSchemaPointer(path)} has "${ITEMS_KEYWORD}" without "maxItems": a request array compared item by item needs a limit`);
}

// With allErrors AJV runs pattern, format and uniqueItems even on a value that has failed maxLength or maxItems:
// a regexp over the whole body, every pair of a 50 000-item array. Under "if" they run only within the limit.
// Not strict, a schema without the limit is left as it is: a shared schema may serve a response only.
export function gateExpensiveKeywords(schema, { label = '"schema"', isStrict = true } = {}) {
  return mapSchema(schema, (subschema, path) => gateItems(gateText(subschema, path, { label, isStrict }), path, { label, isStrict }));
}

function formatPartLabel(part, mediaType) {
  return mediaType === undefined
    ? `"${part}"`
    : `"${part}" (${mediaType})`;
}

export function gateRouteSchema(routeSchema) {
  if (!isObject(routeSchema)) {
    throw new TypeError('gateRouteSchema(routeSchema) requires the schema object of a route');
  }

  return mapRequestSchemas(routeSchema, (schema, part, mediaType) => gateExpensiveKeywords(schema, { label: formatPartLabel(part, mediaType) }));
}
