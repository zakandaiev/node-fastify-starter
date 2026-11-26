import { SCHEMA_LIMITS } from '#config/schema.js';
import {
  assertFilterDefinition,
  FILTER_LIST_SEPARATOR,
  readFilterOptions,
  readFilterParameters,
} from '#core/db/filter.js';
import { assertSortEntries, SORT_PARAMETER } from '#core/db/sort.js';
import { isRedirectStatus } from '#core/http/index.js';
import { REQUEST_PARTS } from '#core/schema/walk.js';
import { ERROR_CATALOG } from '#enums/error-code.js';
import { FILTER_TYPE } from '#enums/filter-type.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { RESPONSE_STATUS } from '#enums/response-status.js';
import { errorEnvelope, listEnvelope, successEnvelope } from '#schemas/common/envelope.js';
import {
  dateTimeUtc,
  isoDate,
  pickFields,
  withDescription,
  withoutNull,
} from '#schemas/common/field.js';
import { patchBody, pathParams, queryParams } from '#schemas/common/request.js';
import { UUID_LENGTH, UUID_REGEXP } from '#utils/id.js';
import { freezeDeep, pick } from '#utils/object.js';
import { hasOnlyTypes, isNumericSchema } from '#utils/schema.js';
import { escapeRegExp } from '#utils/string.js';
import {
  isArray,
  isNonEmptyArray,
  isNonEmptyObject,
  isObject,
  isString,
} from '#utils/type.js';
import { STATUS_CODES } from 'node:http';

const OBJECT_FORMAT = 'object';
const ARRAY_FORMAT = 'array';

const NULL_TYPE = 'null';

// AJV coerces the text of a parameter to a type of its field, and queryParams() drops null from those types.
const TEXT_TYPES = Object.freeze(['string']);
const OPTION_FIELD_TYPES = Object.freeze(['string', 'number', 'integer', 'boolean']);
const NUMBER_KEYWORDS = Object.freeze(['type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);

const STATUS_MAX = 599;

// The statuses any route can answer with; a route that calls out adds 502 itself.
const DEFAULT_ERROR_STATUSES = Object.freeze([
  HTTP_STATUS.BAD_REQUEST,
  HTTP_STATUS.UNAUTHORIZED,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.NOT_FOUND,
  HTTP_STATUS.PAYLOAD_TOO_LARGE,
  HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
  HTTP_STATUS.UNPROCESSABLE_ENTITY,
  HTTP_STATUS.TOO_MANY_REQUESTS,
  HTTP_STATUS.INTERNAL_SERVER_ERROR,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
]);

const VALIDATION_EXAMPLE = Object.freeze([{
  column: 'email',
  columnValue: 'anna.example.com',
  operator: 'format',
  operatorValue: 'email',
}]);

const ROUTE_PART_KEYS = Object.freeze([...REQUEST_PARTS, 'response']);

const DEFAULT_RESPONSES_STEP = 'defaultResponses()';

const SIGNATURE = 'createSchema(...sources)';

function mergeMaps(sources, name) {
  return sources.reduce((merged, source) => {
    const map = source[name] ?? {};

    if (!isObject(map)) {
      throw new TypeError(`${SIGNATURE} requires "${name}" of a source to be a map`);
    }

    const taken = Object.keys(map).find((key) => Object.hasOwn(merged, key));

    if (taken !== undefined) {
      throw new TypeError(`${SIGNATURE}: "${taken}" is in the "${name}" of two sources`);
    }

    return { ...merged, ...map };
  }, {});
}

function mergeSort(sources) {
  const sort = sources.flatMap((source) => source.sort ?? []);

  assertSortEntries(sort, SIGNATURE);

  return sort;
}

// Each source is a module of src/schemas (import * as userSchema) or an object of the same shape.
function readSources(sources) {
  if (!isNonEmptyArray(sources) || !sources.every((source) => isObject(source) && isObject(source.properties))) {
    throw new TypeError(`${SIGNATURE} requires schema modules: objects that export "properties"`);
  }

  return {
    properties: mergeMaps(sources, 'properties'),
    filters: mergeMaps(sources, 'filters'),
    example: mergeMaps(sources, 'example'),
    sort: mergeSort(sources),
  };
}

function pickExample(example, keys) {
  const picked = pick(example, keys);

  return isNonEmptyObject(picked)
    ? picked
    : undefined;
}

function withExample(schema, example) {
  return example === undefined
    ? schema
    : { ...schema, examples: [example] };
}

function readOptionValues(key, filter, property) {
  const options = readFilterOptions(key, filter, property);

  if (options === null) {
    return null;
  }

  const values = options.map((option) => String(option.value));
  const outside = isArray(property?.enum)
    ? values.find((value) => !property.enum.map(String).includes(value))
    : undefined;

  if (outside !== undefined) {
    throw new TypeError(`${SIGNATURE}: the options of the filter "${key}" must be values of the enum of its field: "${outside}" is not one`);
  }

  return values;
}

// Items separated by commas, at most maxCount of them: the regexp counts them, a length limit would not.
function toCommaList(item, maxCount, maxLength) {
  return {
    type: 'string',
    maxLength,
    pattern: `^${item}(?:${FILTER_LIST_SEPARATOR}${item}){0,${maxCount - 1}}$`,
  };
}

function toEnumList(key, values) {
  if (values.some((value) => value.includes(FILTER_LIST_SEPARATOR))) {
    throw new TypeError(`${SIGNATURE}: an option of the filter "${key}" holds "${FILTER_LIST_SEPARATOR}", which separates the values of the list`);
  }

  const item = `(?:${values.map((value) => escapeRegExp(value)).join('|')})`;
  const maxLength = values.reduce((length, value) => length + value.length, 0) + values.length - 1;

  return toCommaList(item, values.length, maxLength);
}

// Options from the database are rows, and a row is addressed by its UUID. Only that pattern goes into the list:
// a field pattern that matches a comma would let the regexp try every split of the list.
function toIdList(key, property) {
  if (property?.pattern !== UUID_REGEXP.source) {
    throw new TypeError(`${SIGNATURE}: the filter "${key}" of several values needs options, an enum or a uuid() field for the ids of its rows`);
  }

  const { listMaxValues } = SCHEMA_LIMITS;

  return toCommaList(`(?:${UUID_REGEXP.source.slice(1, -1)})`, listMaxValues, UUID_LENGTH * listMaxValues + listMaxValues - 1);
}

function toOptionsValue(key, filter, property) {
  const values = readOptionValues(key, filter, property);

  if (filter.isMultiple === true) {
    return values
      ? toEnumList(key, values)
      : toIdList(key, property);
  }

  if (values) {
    return { type: 'string', enum: values };
  }

  if (!isObject(property)) {
    throw new TypeError(`${SIGNATURE}: the filter "${key}" needs options, an enum or a field to read its value from`);
  }

  if (!hasOnlyTypes(withoutNull(property), OPTION_FIELD_TYPES)) {
    throw new TypeError(`${SIGNATURE}: the options filter "${key}" reads its value from a field that is not a string, a number or a boolean`);
  }

  return property;
}

function toNumberValue(key, property) {
  if (property === undefined) {
    return { type: 'number' };
  }

  if (!isNumericSchema(withoutNull(property), { isOnly: true })) {
    throw new TypeError(`${SIGNATURE}: the number filter "${key}" is on a field that is not a number: its types, null aside, must be number or integer`);
  }

  return pick(property, NUMBER_KEYWORDS);
}

// A text filter searches by a fragment: the pattern and the format of the field would refuse one, and an empty
// value is a filter left unused, not an error.
function toTextValue(key, filter, property) {
  if (filter.isExact !== true || !isObject(property)) {
    return { type: 'string', maxLength: property?.maxLength ?? SCHEMA_LIMITS.textMaxLength };
  }

  if (!hasOnlyTypes(withoutNull(property), TEXT_TYPES)) {
    throw new TypeError(`${SIGNATURE}: the exact text filter "${key}" is on a field that is not text: its type, null aside, must be string`);
  }

  return property;
}

function toFilterValue(key, filter, property) {
  switch (filter.type) {
    case FILTER_TYPE.TEXT:
      return toTextValue(key, filter, property);
    case FILTER_TYPE.BOOLEAN:
      return { type: 'boolean' };
    case FILTER_TYPE.NUMBER:
      return toNumberValue(key, property);
    case FILTER_TYPE.DATE:
      return isoDate();
    case FILTER_TYPE.DATETIME:
      return dateTimeUtc();
    case FILTER_TYPE.OPTIONS:
      return toOptionsValue(key, filter, property);
    default:
      throw new TypeError(`${SIGNATURE}: the filter "${key}" has the type "${filter.type}", which is not one of ${Object.values(FILTER_TYPE).join(', ')}`);
  }
}

function expandFilter(key, filter, property) {
  assertFilterDefinition(key, filter, SIGNATURE);

  const value = withDescription(toFilterValue(key, filter, property), filter.label ?? property?.description);

  return readFilterParameters(key, filter).map((name) => [name, value]);
}

function toSortValue(sort) {
  if (!sort.length) {
    throw new TypeError(`${SIGNATURE}: the query asks for "${SORT_PARAMETER}", and no source has a "sort"`);
  }

  const defaultEntry = sort.find((entry) => entry.isDefault === true);

  return {
    type: 'string',
    enum: sort.map((entry) => entry.value),
    ...(defaultEntry && { default: defaultEntry.value }),
    description: 'Order of the rows',
  };
}

function expandQueryKey(key, { properties, filters, sort }) {
  if (key === SORT_PARAMETER) {
    return [[key, toSortValue(sort)]];
  }

  if (Object.hasOwn(filters, key)) {
    return expandFilter(key, filters[key], properties[key]);
  }

  if (Object.hasOwn(properties, key)) {
    return [[key, properties[key]]];
  }

  throw new TypeError(`${SIGNATURE}: the query names "${key}", which is neither a field, a filter nor "${SORT_PARAMETER}"`);
}

function buildQuery(keys, sources) {
  if (!isNonEmptyArray(keys) || !keys.every((key) => isString(key))) {
    throw new TypeError(`${SIGNATURE}.query(keys) requires a list of names`);
  }

  const entries = keys.flatMap((key) => expandQueryKey(key, sources));
  const names = entries.map(([name]) => name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);

  if (repeated !== undefined) {
    throw new TypeError(`${SIGNATURE}.query(keys) gives the parameter "${repeated}" twice`);
  }

  return queryParams(Object.fromEntries(entries));
}

function buildPlainBody(keys, required, properties) {
  const fields = pickFields(properties, keys);

  if (!isArray(required) || !required.every((key) => Object.hasOwn(fields, key))) {
    throw new TypeError(`${SIGNATURE}.body(keys, { required }) requires "required" to be a list of the keys of the body`);
  }

  return {
    type: 'object',
    properties: fields,
    ...(required.length && { required }),
    additionalProperties: false,
  };
}

function buildBody(keys, { properties, example }, { required = [], isPatch = false } = {}) {
  if (isPatch && !(isArray(required) && !required.length)) {
    throw new TypeError(`${SIGNATURE}.body(keys, { isPatch: true }) takes no "required": every field of a PATCH is optional`);
  }

  const body = isPatch
    ? patchBody(properties, keys)
    : buildPlainBody(keys, required, properties);

  return withExample(body, pickExample(example, keys));
}

function readListedCodes(codes, statusCodes, signature) {
  if (codes === undefined) {
    return statusCodes;
  }

  const isListed = isNonEmptyArray(codes)
    && new Set(codes).size === codes.length
    && Array.from(codes).every((code) => statusCodes.includes(code));

  if (!isListed) {
    throw new TypeError(`${signature} takes "codes" as distinct codes of src/enums/error-code.js that answer with this status: ${statusCodes.join(', ')}`);
  }

  return codes;
}

// The codes of the catalog are what an error answers with: a status none of them has is never sent.
function buildErrorResponse(statusCode, signature, { description, codes } = {}) {
  const statusCodes = Object.keys(ERROR_CATALOG).filter((code) => ERROR_CATALOG[code].statusCode === statusCode);

  if (!statusCodes.length) {
    throw new TypeError(`${signature}: no code of src/enums/error-code.js answers with this status`);
  }

  const listed = readListedCodes(codes, statusCodes, signature);

  const [code] = listed;
  const example = {
    status: RESPONSE_STATUS.ERROR,
    code,
    message: ERROR_CATALOG[code].message,
    ...(statusCode === HTTP_STATUS.UNPROCESSABLE_ENTITY && { validation: VALIDATION_EXAMPLE }),
  };

  return {
    ...errorEnvelope,
    description: description ?? `${STATUS_CODES[statusCode]}: ${listed.join(', ')}`,
    examples: [example],
  };
}

// The refusals a response map lacks, each with every code of its status: what .defaultResponses() adds, and what the
// docs add to a guarded route.
export function addErrorResponses(response, statusCodes) {
  const signature = 'addErrorResponses(response, statusCodes)';

  if (!isObject(response) || !isNonEmptyArray(statusCodes) || !Array.from(statusCodes).every((statusCode) => Number.isInteger(statusCode))) {
    throw new TypeError(`${signature} requires the response map of a route and a list of HTTP statuses`);
  }

  const missing = statusCodes.filter((statusCode) => !Object.hasOwn(response, statusCode));

  return {
    ...response,
    ...Object.fromEntries(missing.map((statusCode) => [statusCode, buildErrorResponse(statusCode, `${signature} for ${statusCode}`)])),
  };
}

function buildData(keys, format, { properties, example }) {
  if (keys === undefined) {
    return { schema: { type: NULL_TYPE }, example: null };
  }

  if (!isNonEmptyArray(keys)) {
    throw new TypeError(`${SIGNATURE}.response(code, { data }) requires "data" to be a list of field names`);
  }

  const schema = { type: 'object', properties: pickFields(properties, keys) };
  const itemExample = pickExample(example, keys);

  if (itemExample === undefined) {
    return { schema };
  }

  return {
    schema,
    example: format === ARRAY_FORMAT
      ? [itemExample]
      : itemExample,
  };
}

// One list of keys gives both the schema of "data" and its example. "array" is a list with its pagination,
// sort and filters: the result of query.getAll() that reply.list() sends.
function buildSuccessResponse(statusCode, sources, {
  data,
  format = OBJECT_FORMAT,
  description,
  codes,
} = {}) {
  if (codes !== undefined) {
    throw new TypeError(`${SIGNATURE}.response(${statusCode}) is no error: it takes no "codes"`);
  }

  if (![OBJECT_FORMAT, ARRAY_FORMAT].includes(format)) {
    throw new TypeError(`${SIGNATURE}.response(code, { format }) requires the format "${OBJECT_FORMAT}" or "${ARRAY_FORMAT}"`);
  }

  if (format === ARRAY_FORMAT && data === undefined) {
    throw new TypeError(`${SIGNATURE}.response(code, { format: "${ARRAY_FORMAT}" }) requires "data": the fields of a row`);
  }

  const built = buildData(data, format, sources);
  const envelope = format === ARRAY_FORMAT
    ? listEnvelope(built.schema)
    : successEnvelope(built.schema);
  const response = { ...envelope, description: description ?? STATUS_CODES[statusCode] };

  return Object.hasOwn(built, 'example')
    ? withExample(response, { status: RESPONSE_STATUS.SUCCESS, data: built.example })
    : response;
}

function buildEmptyResponse(statusCode, options = {}) {
  if (options.data !== undefined || options.format !== undefined) {
    throw new TypeError(`${SIGNATURE}.response(${statusCode}) has no body: it takes no "data" or "format"`);
  }

  if (options.codes !== undefined) {
    throw new TypeError(`${SIGNATURE}.response(${statusCode}) is no error: it takes no "codes"`);
  }

  return { type: NULL_TYPE, description: options.description ?? STATUS_CODES[statusCode] };
}

function isEmptyStatus(statusCode) {
  return statusCode === HTTP_STATUS.NO_CONTENT || isRedirectStatus(statusCode);
}

function buildResponse(statusCode, options, sources) {
  if (!Number.isInteger(statusCode) || statusCode < HTTP_STATUS.OK || statusCode > STATUS_MAX) {
    throw new TypeError(`${SIGNATURE}.response(code) requires an HTTP status from ${HTTP_STATUS.OK} to ${STATUS_MAX}`);
  }

  if (options !== undefined && !isObject(options)) {
    throw new TypeError(`${SIGNATURE}.response(code, options) requires options to be an object`);
  }

  if (isEmptyStatus(statusCode)) {
    return buildEmptyResponse(statusCode, options);
  }

  if (statusCode < HTTP_STATUS.BAD_REQUEST) {
    return buildSuccessResponse(statusCode, sources, options);
  }

  if (options?.data !== undefined || options?.format !== undefined) {
    throw new TypeError(`${SIGNATURE}.response(${statusCode}) is an error: its body is the error envelope, without "data"`);
  }

  return buildErrorResponse(statusCode, `${SIGNATURE}.response(${statusCode})`, options);
}

function assertMeta(fields) {
  if (!isObject(fields)) {
    throw new TypeError(`${SIGNATURE}.meta(fields) requires an object, such as { tags, summary, description }`);
  }

  const part = ROUTE_PART_KEYS.find((key) => Object.hasOwn(fields, key));

  if (part !== undefined) {
    throw new TypeError(`${SIGNATURE}.meta(fields) cannot set "${part}": meta holds what the docs say of a route, not a part of its request or response`);
  }
}

function takeStep(state, step) {
  if (state.steps.has(step)) {
    throw new TypeError(`${SIGNATURE}.${step} is given twice`);
  }

  state.steps.add(step);

  return state;
}

function buildResponses({ steps, responses }) {
  return steps.has(DEFAULT_RESPONSES_STEP)
    ? addErrorResponses(responses, DEFAULT_ERROR_STATUSES)
    : { ...responses };
}

// A copy is frozen: freezing in place would reach the arrays and objects the caller passed in.
function buildRouteSchema(state) {
  if (!Object.keys(state.responses).some((statusCode) => Number(statusCode) < HTTP_STATUS.BAD_REQUEST)) {
    throw new TypeError(`${SIGNATURE}.build() requires a success response, such as .response(200, { data })`);
  }

  return freezeDeep(structuredClone({ ...state.meta, ...state.parts, response: buildResponses(state) }));
}

// Every step is optional and comes in any order; a step given twice fails when the module of the route loads.
export function createSchema(...sources) {
  const state = {
    sources: readSources(sources),
    steps: new Set(),
    parts: {},
    responses: {},
    meta: {},
  };

  const builder = {
    body(keys, options) {
      takeStep(state, 'body()').parts.body = buildBody(keys, state.sources, options);

      return builder;
    },
    query(keys) {
      takeStep(state, 'query()').parts.querystring = buildQuery(keys, state.sources);

      return builder;
    },
    params(keys) {
      takeStep(state, 'params()').parts.params = pathParams(pickFields(state.sources.properties, keys));

      return builder;
    },
    response(statusCode, options) {
      takeStep(state, `response(${statusCode})`).responses[statusCode] = buildResponse(statusCode, options, state.sources);

      return builder;
    },
    // The statuses still missing are filled in by build(): a .response() of one of them may come later.
    defaultResponses() {
      takeStep(state, DEFAULT_RESPONSES_STEP);

      return builder;
    },
    meta(fields) {
      assertMeta(fields);
      takeStep(state, 'meta()').meta = fields;

      return builder;
    },
    build() {
      return buildRouteSchema(state);
    },
  };

  return builder;
}
