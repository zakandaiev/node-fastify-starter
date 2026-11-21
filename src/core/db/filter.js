import { DATETIME_MAX_MS, DATETIME_MIN_MS } from '#core/db/binding.js';
import { FILTER_OPERATOR, FILTER_TYPE } from '#enums/filter-type.js';
import { camelToSnakeKey } from '#utils/case.js';
import {
  addToDate,
  isIsoDate,
  isUtcDateTime,
  parseStrictUtc,
  toDate,
} from '#utils/date.js';
import { getPath } from '#utils/object.js';
import { escapeLikePattern } from '#utils/string.js';
import {
  isArray,
  isBoolean,
  isNonEmptyArray,
  isNonEmptyString,
  isNumber,
  isObject,
  isString,
} from '#utils/type.js';

export const FILTER_LIST_SEPARATOR = ',';

const SIGNATURE = 'buildFilter(schema, payload, { options, disabled })';
const OPTIONS_SIGNATURE = 'readFilterOptions(key, filter, property)';
const PARAMETERS_SIGNATURE = 'readFilterParameters(key, filter)';

const FILTER_TYPES = Object.freeze(Object.values(FILTER_TYPE));
const RANGE_TYPES = Object.freeze([FILTER_TYPE.NUMBER, FILTER_TYPE.DATE, FILTER_TYPE.DATETIME]);
const RANGE_SUFFIX = Object.freeze({ FROM: 'From', TO: 'To' });

// The lexer reads a placeholder name of these characters only (#core/db/lexer.js); in snake case such a key is
// a plain column name too.
const KEY_REGEXP = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_PREFIX = 'filter_';

const COMPARISON = Object.freeze({
  EQUAL: '=',
  FROM: '>=',
  TO: '<=',
  BEFORE: '<',
  LIKE: 'LIKE',
});
const LIKE_WILDCARD = '%';
const CONDITION_SEPARATOR = ' AND ';
const NOTHING_MATCHES = Object.freeze({ sql: 'FALSE', binding: Object.freeze({}) });

const ONE_DAY = '1d';

function isOptionValue(value) {
  return isString(value) || isNumber(value) || isBoolean(value);
}

function isOptionInput(value) {
  return isString(value) || (isArray(value) && value.every((item) => isOptionValue(item)));
}

const VALUE_CHECKS = Object.freeze({
  [FILTER_TYPE.TEXT]: { isValid: isString, expected: 'a string' },
  [FILTER_TYPE.BOOLEAN]: { isValid: isBoolean, expected: 'a boolean' },
  [FILTER_TYPE.NUMBER]: { isValid: isNumber, expected: 'a finite number' },
  [FILTER_TYPE.DATE]: { isValid: isIsoDate, expected: 'a date written as YYYY-MM-DD' },
  [FILTER_TYPE.DATETIME]: { isValid: isUtcDateTime, expected: 'a date-time in UTC written in ISO 8601' },
});
const OPTION_CHECK = Object.freeze({ isValid: isOptionValue, expected: 'a string, a number or a boolean' });
const OPTION_LIST_CHECK = Object.freeze({
  isValid: isOptionInput,
  expected: 'a list separated by commas or an array of strings, numbers and booleans',
});

function keepValue(value) {
  return value;
}

function toNextDay(value) {
  return addToDate(toDate(value), ONE_DAY);
}

// A day ends where the next one starts: an end at 23:59:59.999 would miss the microseconds of a DATETIME(6).
const BOUNDS = Object.freeze({
  [FILTER_TYPE.NUMBER]: [
    { suffix: RANGE_SUFFIX.FROM, comparison: COMPARISON.FROM, read: keepValue },
    { suffix: RANGE_SUFFIX.TO, comparison: COMPARISON.TO, read: keepValue },
  ],
  [FILTER_TYPE.DATE]: [
    { suffix: RANGE_SUFFIX.FROM, comparison: COMPARISON.FROM, read: toDate },
    { suffix: RANGE_SUFFIX.TO, comparison: COMPARISON.BEFORE, read: toNextDay },
  ],
  [FILTER_TYPE.DATETIME]: [
    { suffix: RANGE_SUFFIX.FROM, comparison: COMPARISON.FROM, read: parseStrictUtc },
    { suffix: RANGE_SUFFIX.TO, comparison: COMPARISON.TO, read: parseStrictUtc },
  ],
});

const definitionsBySchema = new WeakMap();

function isOption(option) {
  return isObject(option)
    && isOptionValue(option.value)
    && (option.label === undefined || isString(option.label))
    && (option.isDisabled === undefined || isBoolean(option.isDisabled));
}

function assertOptionList(key, options, signature, { isEmptyAllowed = false } = {}) {
  const isList = isEmptyAllowed
    ? isArray(options)
    : isNonEmptyArray(options);

  if (!isList || !options.every((option) => isOption(option))) {
    throw new TypeError(`${signature}: the options of the filter "${key}" must be a list of { value, label } with a string, number or boolean value; a label is a string, isDisabled a boolean`);
  }

  const values = options.map((option) => String(option.value));

  if (new Set(values).size !== values.length) {
    throw new TypeError(`${signature}: the options of the filter "${key}" must be distinct values, also as text`);
  }
}

function assertFilterFlags(key, filter, signature) {
  if (filter.isMultiple !== undefined && (!isBoolean(filter.isMultiple) || filter.type !== FILTER_TYPE.OPTIONS)) {
    throw new TypeError(`${signature}: the filter "${key}" takes isMultiple only as an options filter, and as a boolean`);
  }

  if (filter.isExact !== undefined && (!isBoolean(filter.isExact) || filter.type !== FILTER_TYPE.TEXT)) {
    throw new TypeError(`${signature}: the filter "${key}" takes isExact only as a text filter, and as a boolean`);
  }

  if (filter.isDisabled !== undefined && !isBoolean(filter.isDisabled)) {
    throw new TypeError(`${signature}: the filter "${key}" takes isDisabled only as a boolean`);
  }
}

function assertFilterTexts(key, filter, signature) {
  if (filter.column !== undefined && !isNonEmptyString(filter.column)) {
    throw new TypeError(`${signature}: the filter "${key}" takes a column only as a non-empty string`);
  }

  if (filter.label !== undefined && !isString(filter.label)) {
    throw new TypeError(`${signature}: the filter "${key}" takes a label only as a string`);
  }
}

function assertFilterOptions(key, filter, signature) {
  if (filter.options === undefined) {
    return false;
  }

  if (filter.type !== FILTER_TYPE.OPTIONS) {
    throw new TypeError(`${signature}: the filter "${key}" takes options only as an options filter`);
  }

  assertOptionList(key, filter.options, signature);

  return true;
}

export function assertFilterDefinition(key, filter, signature) {
  if (!isObject(filter)) {
    throw new TypeError(`${signature}: the filter "${key}" must be an object`);
  }

  if (!FILTER_TYPES.includes(filter.type)) {
    throw new TypeError(`${signature}: the filter "${key}" has the type "${filter.type}", which is not one of ${FILTER_TYPES.join(', ')}`);
  }

  if (filter.operator !== undefined && (filter.operator !== FILTER_OPERATOR.RANGE || !RANGE_TYPES.includes(filter.type))) {
    throw new TypeError(`${signature}: the filter "${key}" may take the operator "${FILTER_OPERATOR.RANGE}" only as a ${RANGE_TYPES.join(', ')} filter`);
  }

  assertFilterFlags(key, filter, signature);
  assertFilterTexts(key, filter, signature);
  assertFilterOptions(key, filter, signature);
}

export function readFilterOptions(key, filter, property) {
  if (!isObject(filter) || filter.type !== FILTER_TYPE.OPTIONS) {
    throw new TypeError(`${OPTIONS_SIGNATURE} requires the definition of an options filter, and "${key}" is not one`);
  }

  if (filter.options !== undefined) {
    assertOptionList(key, filter.options, OPTIONS_SIGNATURE);

    return filter.options;
  }

  return isArray(property?.enum)
    ? property.enum.filter((value) => value !== null).map((value) => ({ value, label: String(value) }))
    : null;
}

function toRangeNames(key) {
  return [`${key}${RANGE_SUFFIX.FROM}`, `${key}${RANGE_SUFFIX.TO}`];
}

export function readFilterParameters(key, filter) {
  if (!isString(key) || !isObject(filter)) {
    throw new TypeError(`${PARAMETERS_SIGNATURE} requires the key and the definition of a filter`);
  }

  return filter.operator === FILTER_OPERATOR.RANGE
    ? toRangeNames(key)
    : [key];
}

function toOptions(list) {
  return list.map((option) => ({
    value: option.value,
    label: option.label ?? String(option.value),
    isDisabled: option.isDisabled === true,
  }));
}

function readOptions(key, filter, property) {
  if (filter.type !== FILTER_TYPE.OPTIONS) {
    return null;
  }

  const list = readFilterOptions(key, filter, property);

  return list === null
    ? null
    : toOptions(list);
}

function readValueCheck(filter) {
  if (filter.type !== FILTER_TYPE.OPTIONS) {
    return VALUE_CHECKS[filter.type];
  }

  return filter.isMultiple === true
    ? OPTION_LIST_CHECK
    : OPTION_CHECK;
}

function toPlaceholder(key, suffix = '') {
  return `${PLACEHOLDER_PREFIX}${key}${suffix}`;
}

// A day is two bounds even when the filter is no range: it binds the placeholders of the halves of one.
function isBoundedFilter(filter) {
  return filter.operator === FILTER_OPERATOR.RANGE || filter.type === FILTER_TYPE.DATE;
}

function readPlaceholders(key, filter) {
  return isBoundedFilter(filter)
    ? toRangeNames(key).map((name) => toPlaceholder(name))
    : [toPlaceholder(key)];
}

function prepareFilter(key, filter, properties) {
  assertFilterDefinition(key, filter, SIGNATURE);

  if (!KEY_REGEXP.test(key)) {
    throw new TypeError(`${SIGNATURE}: the key of the filter "${key}" names its placeholders: it takes letters, digits and underscores, and does not start with a digit`);
  }

  const property = getPath(properties, [key]);

  return {
    key,
    type: filter.type,
    column: filter.column ?? camelToSnakeKey(key),
    label: filter.label ?? property?.description ?? key,
    isRange: filter.operator === FILTER_OPERATOR.RANGE,
    isBounded: isBoundedFilter(filter),
    isMultiple: filter.isMultiple === true,
    isExact: filter.isExact === true,
    isDisabled: filter.isDisabled === true,
    options: readOptions(key, filter, property),
    check: readValueCheck(filter),
    parameters: readFilterParameters(key, filter),
    placeholders: readPlaceholders(key, filter),
  };
}

function findSharedName(definitions, readNames) {
  const claims = definitions.flatMap((definition) => readNames(definition).map((name) => ({ name, key: definition.key })));
  const clash = claims.find((claim, index) => claims.findIndex((other) => other.name === claim.name) !== index);

  return clash === undefined
    ? null
    : { ...clash, owner: claims.find((claim) => claim.name === clash.name).key };
}

// A parameter is a key of the query and a placeholder a key of the binding: one name may be a parameter
// of one filter and a placeholder of another.
function assertDistinctNames(definitions) {
  const parameter = findSharedName(definitions, (definition) => definition.parameters);

  if (parameter !== null) {
    throw new TypeError(`${SIGNATURE}: the filters "${parameter.owner}" and "${parameter.key}" both take the query parameter "${parameter.name}"`);
  }

  const placeholder = findSharedName(definitions, (definition) => definition.placeholders);

  if (placeholder !== null) {
    throw new TypeError(`${SIGNATURE}: the filters "${placeholder.owner}" and "${placeholder.key}" both bind the placeholder :${placeholder.name}`);
  }
}

function prepareDefinitions(schema) {
  const { filters, properties = {} } = schema;

  if (!isObject(filters) || !isObject(properties)) {
    throw new TypeError(`${SIGNATURE} requires a schema with a map of "filters", and its "properties", when it has them, as a map too`);
  }

  const definitions = Object.entries(filters).map(([key, filter]) => prepareFilter(key, filter, properties));

  assertDistinctNames(definitions);

  return new Map(definitions.map((definition) => [definition.key, definition]));
}

function readDefinitions(schema) {
  if (!isObject(schema)) {
    throw new TypeError(`${SIGNATURE} requires a schema: an object with a map of "filters"`);
  }

  if (!definitionsBySchema.has(schema)) {
    definitionsBySchema.set(schema, prepareDefinitions(schema));
  }

  return definitionsBySchema.get(schema);
}

export function readFilterPlaceholders(schema) {
  return Array.from(readDefinitions(schema).values()).flatMap((definition) => definition.placeholders);
}

export function readFilterColumns(schema) {
  return Array.from(readDefinitions(schema).values(), (definition) => definition.column);
}

function readRuntimeList(definitions, key, list) {
  if (definitions.get(key)?.type !== FILTER_TYPE.OPTIONS) {
    throw new TypeError(`${SIGNATURE}: options are given for "${key}", which is not an options filter of the schema`);
  }

  assertOptionList(key, list, SIGNATURE, { isEmptyAllowed: true });

  return toOptions(list);
}

function readRuntimeOptions(definitions, options) {
  if (!isObject(options)) {
    throw new TypeError(`${SIGNATURE} requires options to map the keys of options filters to their lists`);
  }

  return new Map(Object.entries(options).map(([key, list]) => [key, readRuntimeList(definitions, key, list)]));
}

function readDisabled(definitions, disabled) {
  if (!isArray(disabled) || !disabled.every((key) => isString(key))) {
    throw new TypeError(`${SIGNATURE} requires disabled to be a list of the keys of filters`);
  }

  const unknown = disabled.find((key) => !definitions.has(key));

  if (unknown !== undefined) {
    throw new TypeError(`${SIGNATURE}: disabled names "${unknown}", which is not a filter of the schema`);
  }

  return new Set(disabled);
}

function readOptionList(definition, runtimeOptions) {
  const options = runtimeOptions.get(definition.key) ?? definition.options;

  if (options === null) {
    throw new TypeError(`${SIGNATURE}: the options filter "${definition.key}" has no list in the schema: give it the list from the database in { options }`);
  }

  return options;
}

function readParameter(definition, payload, parameter) {
  const value = getPath(payload, [parameter]);

  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (!definition.check.isValid(value)) {
    throw new TypeError(`${SIGNATURE}: "${parameter}" of the filter "${definition.key}" must be ${definition.check.expected}: name the filter in .query() of the route, whose schema gives it that type`);
  }

  return value;
}

function readInput(definition, payload) {
  const values = definition.parameters.map((parameter) => readParameter(definition, payload, parameter));

  if (values.every((value) => value === null)) {
    return null;
  }

  return definition.isRange
    ? values
    : values[0];
}

function compare(column, { name, comparison, value }) {
  return { sql: `${column} ${comparison} :${name}`, binding: { [name]: value } };
}

function clampMoment(bound) {
  const time = bound.value.getTime();

  if (time < DATETIME_MIN_MS) {
    return bound.comparison === COMPARISON.FROM
      ? { ...bound, value: toDate(DATETIME_MIN_MS) }
      : null;
  }

  if (time > DATETIME_MAX_MS) {
    return bound.comparison === COMPARISON.TO || bound.comparison === COMPARISON.BEFORE
      ? { ...bound, comparison: COMPARISON.TO, value: toDate(DATETIME_MAX_MS) }
      : null;
  }

  return bound;
}

function buildMomentParts(column, bounds) {
  const clamped = bounds.map((bound) => clampMoment(bound));

  return clamped.includes(null)
    ? [NOTHING_MATCHES]
    : clamped.map((bound) => compare(column, bound));
}

function buildBoundParts({ type, key, column }, values) {
  const bounds = BOUNDS[type]
    .map((bound, index) => ({ ...bound, given: values[index] }))
    .filter(({ given }) => given !== null)
    .map(({
      suffix,
      comparison,
      read,
      given,
    }) => ({ name: toPlaceholder(key, suffix), comparison, value: read(given) }));

  return type === FILTER_TYPE.NUMBER
    ? bounds.map((bound) => compare(column, bound))
    : buildMomentParts(column, bounds);
}

function buildParts(definition, input) {
  const { type, key, column } = definition;

  if (definition.isBounded) {
    return buildBoundParts(definition, definition.isRange ? input : [input, input]);
  }

  const bound = { name: toPlaceholder(key), comparison: COMPARISON.EQUAL, value: input };

  if (type === FILTER_TYPE.DATETIME) {
    return buildMomentParts(column, [{ ...bound, value: parseStrictUtc(input) }]);
  }

  if (type === FILTER_TYPE.TEXT && !definition.isExact) {
    const pattern = `${LIKE_WILDCARD}${escapeLikePattern(input)}${LIKE_WILDCARD}`;

    return [compare(column, { ...bound, comparison: COMPARISON.LIKE, value: pattern })];
  }

  return [compare(column, bound)];
}

function readOptionInputs({ isMultiple }, input) {
  if (!isMultiple) {
    return [input];
  }

  return isString(input)
    ? input.split(FILTER_LIST_SEPARATOR)
    : input;
}

function buildOptionsEffect(definition, input, options) {
  const wanted = new Set(readOptionInputs(definition, input).map(String));
  const selected = options.filter((option) => !option.isDisabled && wanted.has(String(option.value)));

  if (!selected.length) {
    return null;
  }

  const name = toPlaceholder(definition.key);
  const values = selected.map((option) => option.value);
  const part = values.length === 1
    ? compare(definition.column, { name, comparison: COMPARISON.EQUAL, value: values[0] })
    : { sql: `${definition.column} IN (:${name})`, binding: { [name]: values } };

  return {
    value: definition.isMultiple
      ? selected.map((option) => option.value)
      : values[0],
    parts: [part],
    selected,
  };
}

function buildEffect(definition, input, options) {
  return definition.type === FILTER_TYPE.OPTIONS
    ? buildOptionsEffect(definition, input, options)
    : { value: input, parts: buildParts(definition, input) };
}

function toEntry(definition, { isDisabled, effect, options }) {
  const selected = effect?.selected ?? [];

  return {
    type: definition.type,
    name: definition.key,
    label: definition.label,
    ...(definition.isRange && { operator: FILTER_OPERATOR.RANGE }),
    ...(options && { isMultiple: definition.isMultiple }),
    isDisabled,
    value: effect?.value ?? null,
    ...(options && {
      options: options.map((option) => ({
        label: option.label,
        value: option.value,
        isChecked: selected.includes(option),
        isDisabled: option.isDisabled,
      })),
    }),
  };
}

function applyFilter(definition, payload, runtime) {
  const options = definition.type === FILTER_TYPE.OPTIONS
    ? readOptionList(definition, runtime.options)
    : null;
  const input = readInput(definition, payload);
  const isDisabled = definition.isDisabled || runtime.disabled.has(definition.key);
  const effect = input === null || isDisabled
    ? null
    : buildEffect(definition, input, options);

  return {
    definition,
    effect,
    entry: toEntry(definition, { isDisabled, effect, options }),
  };
}

export function buildFilter(schema, payload = {}, { options = {}, disabled = [] } = {}) {
  const definitions = readDefinitions(schema);

  if (!isObject(payload)) {
    throw new TypeError(`${SIGNATURE} requires payload to be a plain object, such as request.query`);
  }

  const runtime = {
    options: readRuntimeOptions(definitions, options),
    disabled: readDisabled(definitions, disabled),
  };
  const results = Array.from(definitions.values(), (definition) => applyFilter(definition, payload, runtime));
  const effects = results.filter((result) => result.effect !== null);
  const parts = effects.flatMap((result) => result.effect.parts);

  return {
    condition: parts.length
      ? parts.map((part) => part.sql).join(CONDITION_SEPARATOR)
      : null,
    binding: parts.reduce((binding, part) => ({ ...binding, ...part.binding }), {}),
    filters: results.map((result) => result.entry),
    hasText: effects.some((result) => result.definition.type === FILTER_TYPE.TEXT),
  };
}
