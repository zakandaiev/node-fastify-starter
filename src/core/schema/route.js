import { guardRouteSchema, readSchemaTypes, REQUEST_PARTS } from '#core/schema/finite.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import {
  isBoolean,
  isNonEmptyArray,
  isNonEmptyObject,
  isObject,
} from '#utils/type.js';

const SUCCESS_CODE_REGEXP = /^2(?:\d\d|xx)$/i;
const REDIRECT_CODE_REGEXP = /^3(?:\d\d|xx)$/i;
const NO_CONTENT_CODE = String(HTTP_STATUS.NO_CONTENT);

const JSON_MEDIA_FRAGMENT = 'json';

const OBJECT_TYPE = 'object';
const ARRAY_TYPE = 'array';

// fast-json-stringify merges each branch into the schema that holds it ("if" is only tested),
// so a branch has to be a filter itself.
const BRANCH_LIST_KEYWORDS = Object.freeze(['anyOf', 'oneOf', 'allOf']);
const BRANCH_KEYWORDS = Object.freeze(['then', 'else']);
const MERGE_KEYWORDS = Object.freeze([...BRANCH_LIST_KEYWORDS, ...BRANCH_KEYWORDS]);

const PREFIX_REGEXP = /^\/[^/]+(?:\/[^/]+)*$/;

function isUnderPrefix(url, prefix) {
  return url === prefix || url.startsWith(`${prefix}/`);
}

function isTypedMap(map) {
  return isObject(map) && Object.values(map).every((schema) => isTypedSchema(schema));
}

function opensNothing({
  properties,
  patternProperties,
  additionalProperties,
  items,
}) {
  return additionalProperties !== true
    && (!isObject(additionalProperties) || isTypedSchema(additionalProperties))
    && (properties === undefined || isTypedMap(properties))
    && (patternProperties === undefined || isTypedMap(patternProperties))
    && (items === undefined || isTypedSchema(items));
}

// An object is a filter only when it lists its properties: fast-json-stringify lets every field through
// an open one, and writes {} for one that has no description at all.
function isTypedObject(schema) {
  const { properties, patternProperties, additionalProperties } = schema;

  return opensNothing(schema)
    && (isNonEmptyObject(properties) || isNonEmptyObject(patternProperties) || isObject(additionalProperties));
}

function hasTypedBranches(schema) {
  const lists = BRANCH_LIST_KEYWORDS
    .filter((keyword) => schema[keyword] !== undefined)
    .map((keyword) => schema[keyword]);
  const branches = BRANCH_KEYWORDS
    .filter((keyword) => schema[keyword] !== undefined)
    .map((keyword) => schema[keyword]);

  return lists.every((list) => isNonEmptyArray(list))
    && [...lists.flat(), ...branches].every((branch) => isTypedSchema(branch));
}

function hasBranchList(schema) {
  return BRANCH_LIST_KEYWORDS.some((keyword) => schema[keyword] !== undefined);
}

function isTypedByOwnKeywords(schema) {
  const types = readSchemaTypes(schema);

  if (types.includes(ARRAY_TYPE) && !isTypedSchema(schema.items)) {
    return false;
  }

  if (types.includes(OBJECT_TYPE)) {
    return isTypedObject(schema);
  }

  // No type and a constant is still a filter: the constant is what gets written. An enum is not: a value
  // under a schema that has no type is written as it is.
  return types.length > 0 || schema.const !== undefined;
}

// A $ref is never typed here: the hook cannot see what it points to, and what stands next to it is merged in.
// A list of branches writes the value in place of the schema that holds it, so that schema only must not open
// anything itself. Under "then" and "else" it still writes the value alone on one of the two roads.
function isTypedSchema(schema) {
  if (!isObject(schema) || schema.$ref !== undefined || !hasTypedBranches(schema)) {
    return false;
  }

  return hasBranchList(schema)
    ? opensNothing(schema)
    : isTypedByOwnKeywords(schema);
}

function holdsMerge(schema) {
  return MERGE_KEYWORDS.some((keyword) => schema[keyword] !== undefined);
}

function listSubschemas(schema) {
  const {
    properties,
    patternProperties,
    additionalProperties,
    items,
  } = schema;

  return [
    ...Object.values(isObject(properties) ? properties : {}),
    ...Object.values(isObject(patternProperties) ? patternProperties : {}),
    additionalProperties,
    items,
    ...MERGE_KEYWORDS.flatMap((keyword) => schema[keyword] ?? []),
  ].filter((subschema) => isObject(subschema));
}

// In a merge the closed side answers "false" for every property only the other side names, and the serializer
// writes a value under the schema "false" as it is: a nested object goes out whole. So additionalProperties:
// false is refused on a schema that holds branches and on everything under it; "if" is never merged.
function closesMerge(schema, isMerged = false) {
  const isInMerge = isMerged || holdsMerge(schema);

  return (isInMerge && schema.additionalProperties === false)
    || listSubschemas(schema).some((subschema) => closesMerge(subschema, isInMerge));
}

function isFilter(data) {
  return isTypedSchema(data) && !closesMerge(data);
}

// Only from an envelope nothing is merged into: what a $ref or a branch brings there is merged into "data" too.
function readEnvelopeData(envelope) {
  const isMerged = !isObject(envelope) || envelope.$ref !== undefined || holdsMerge(envelope);

  return isMerged
    ? undefined
    : envelope.properties?.data;
}

function findJsonMedia(content) {
  return Object.entries(content)
    .filter(([mediaType]) => mediaType === MEDIA_TYPE.ANY || mediaType.toLowerCase().includes(JSON_MEDIA_FRAGMENT))
    .map(([, media]) => media);
}

// A response described by media type carries "data" only when it is JSON: a file or a stream has none.
function hasTypedData(response) {
  if (!isObject(response) || !isObject(response.content)) {
    return isFilter(readEnvelopeData(response));
  }

  return isNonEmptyObject(response.content)
    && findJsonMedia(response.content).every((media) => isFilter(readEnvelopeData(media?.schema)));
}

function formatRoute({ method, url }) {
  return `Route ${[method].flat().join(',')} ${url}`;
}

function assertSecurity(routeOptions) {
  const { security } = routeOptions;

  if (!isObject(security) || !isBoolean(security.auth)) {
    throw new Error(`${formatRoute(routeOptions)} requires security: { auth: true } or, for a public route, security: { auth: false }`);
  }
}

// "default" alone does not count: reply.ok(), created() and list() look for the status they send or its class,
// never for "default".
function assertResponse(routeOptions) {
  const response = routeOptions.schema?.response;
  const codes = isObject(response)
    ? Object.keys(response)
    : [];
  const successCodes = codes.filter((code) => SUCCESS_CODE_REGEXP.test(code));

  if (!successCodes.length && !codes.some((code) => REDIRECT_CODE_REGEXP.test(code))) {
    throw new Error(`${formatRoute(routeOptions)} has no response schema for a 2xx or a 3xx status`);
  }

  const untypedCode = successCodes
    .filter((code) => code !== NO_CONTENT_CODE)
    .find((code) => !hasTypedData(response[code]));

  if (untypedCode !== undefined) {
    throw new Error(`${formatRoute(routeOptions)} has no typed "data" in the response schema of ${untypedCode}: every schema needs a "type", an object also "properties", an array "items"; $ref, {} and additionalProperties: true are not accepted, nor additionalProperties: false on or under anyOf, oneOf, allOf, then and else`);
  }
}

export function assertRouteContract(routeOptions) {
  if (!isObject(routeOptions)) {
    throw new TypeError('assertRouteContract(routeOptions) requires the options of a route');
  }

  assertSecurity(routeOptions);
  assertResponse(routeOptions);
}

function readPartSchemas(part) {
  return isObject(part?.content)
    ? Object.values(part.content).map((media) => media?.schema)
    : [part];
}

// Fastify hands the rejection of an asynchronous validator to the error handler as it is: the list of errors
// is not an array there, is never cut, and the request is answered as a bad one without validation[].
// By truthiness, as AJV reads the keyword.
function assertSynchronous(routeOptions) {
  const asyncPart = REQUEST_PARTS.find((part) => readPartSchemas(routeOptions.schema[part]).some((schema) => Boolean(schema?.$async)));

  if (asyncPart !== undefined) {
    throw new Error(`${formatRoute(routeOptions)} has an asynchronous schema ($async) in "${asyncPart}": validate what needs I/O in the handler`);
  }
}

// Synchronous: Fastify ignores the promise of an async onRoute hook, and the route would go live unchecked.
// The schema is replaced, never changed in place: the HEAD twin of a GET route gets the original options again.
// A route that brings a validator compiler of its own has to give it the keyword: useFiniteKeyword(ajv).
export function createRouteHook({ apiPrefix, healthPrefix } = {}) {
  const prefixes = [apiPrefix, healthPrefix];

  if (!prefixes.every((prefix) => PREFIX_REGEXP.test(prefix))) {
    throw new TypeError('createRouteHook({ apiPrefix, healthPrefix }) requires prefixes like "/api": a leading slash and no trailing one');
  }

  function checkRoute(routeOptions) {
    if (isObject(routeOptions.schema)) {
      assertSynchronous(routeOptions);
      routeOptions.schema = guardRouteSchema(routeOptions.schema);
    }

    if (prefixes.some((prefix) => isUnderPrefix(routeOptions.url, prefix))) {
      assertRouteContract(routeOptions);
    }
  }

  return checkRoute;
}
