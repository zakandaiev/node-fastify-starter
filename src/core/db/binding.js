import {
  isSymbol,
  isWord,
  SYMBOL,
  TOKEN_TYPE,
  tokenizeSql,
} from '#core/db/lexer.js';
import { toDate, toTimestamp } from '#utils/date.js';
import { getPath } from '#utils/object.js';
import {
  isArray,
  isBlankString,
  isBoolean,
  isFunction,
  isNumber,
  isNumberInRange,
  isObject,
  isString,
} from '#utils/type.js';
import { isDate } from 'node:util/types';

const PLACEHOLDER_MARK = '?';
const LIST_KEYWORD = 'IN';
const LIST_SEPARATOR = ', ';
const GLUED_BEFORE_REGEXP = /[A-Za-z0-9_$.'"`\P{ASCII}]/u;
const GLUED_AFTER_REGEXP = /[.'"]/;

// Not "NULL": "x NOT IN (NULL)" is true for no row at all. Against a subquery without rows IN is false and NOT IN
// is true for every row, which is what an empty list means. The table in FROM lets the server see at once that
// nothing can match: without one it reads, and in UPDATE or DELETE locks, every row of the outer table.
const EMPTY_LIST = 'SELECT NULL FROM (SELECT NULL) empty_list WHERE FALSE';

// The moments a DATETIME holds. A Date outside them becomes text the server cannot read as a date: a comparison
// with it then matches every row or none without an error, also in DELETE.
export const DATETIME_MIN_MS = toTimestamp('1000-01-01T00:00:00.000Z');
export const DATETIME_MAX_MS = toTimestamp('9999-12-31T23:59:59.999Z');

const DATETIME_YEARS = `${toDate(DATETIME_MIN_MS).getUTCFullYear()}-${toDate(DATETIME_MAX_MS).getUTCFullYear()}`;

const ALLOWED_VALUES = 'a string, a finite number, a bigint, a boolean, a Date, a Buffer or null';

function renderMark() {
  return PLACEHOLDER_MARK;
}

function isBindable(value) {
  return value === null
    || isString(value)
    || isNumber(value)
    || isBoolean(value)
    || typeof value === 'bigint'
    || Buffer.isBuffer(value)
    || (isDate(value) && isNumberInRange(value.getTime(), DATETIME_MIN_MS, DATETIME_MAX_MS));
}

function describeDate(value) {
  return Number.isNaN(value.getTime())
    ? 'an invalid Date'
    : `a Date outside the years ${DATETIME_YEARS}`;
}

// The type only: the value itself may be personal data, and the message goes to the log.
function describeType(value) {
  if (typeof value === 'number') {
    return String(value);
  }

  if (isArray(value)) {
    return 'a nested array';
  }

  return isDate(value)
    ? describeDate(value)
    : `a value of type ${typeof value}`;
}

function assertBindable(value, name) {
  if (!isBindable(value)) {
    throw new TypeError(`Placeholder :${name} cannot be bound to ${describeType(value)}: a value is ${ALLOWED_VALUES}`);
  }
}

// The lexer passes over operators, numbers and variables: "isAfterBlank" tells that nothing but whitespace
// and comments lies between a token and the one before it, so "IN (:ids + 1)" is not taken for a list.
function readTokens(sql) {
  const tokens = [];
  let position = 0;
  let isAfterBlank = true;

  tokenizeSql(sql).forEach((token) => {
    isAfterBlank = isAfterBlank && isBlankString(sql.slice(position, token.start));
    position = token.end;

    if (token.type !== TOKEN_TYPE.COMMENT) {
      tokens.push({ ...token, isAfterBlank });
      isAfterBlank = true;
    }
  });

  return tokens;
}

function isListPlaceholder(tokens, index) {
  const keyword = tokens[index - 2];
  const open = tokens[index - 1];
  const close = tokens[index + 1];

  return isWord(keyword, [LIST_KEYWORD])
    && isSymbol(open, SYMBOL.OPEN)
    && isSymbol(close, SYMBOL.CLOSE)
    && [open, tokens[index], close].every((token) => token.isAfterBlank);
}

function readList(items, tokens, index) {
  const { name } = tokens[index];

  if (!isListPlaceholder(tokens, index)) {
    throw new TypeError(`Placeholder :${name} is bound to an array, which is allowed only as "IN (:${name})"`);
  }

  if (items.includes(null)) {
    throw new TypeError(`Placeholder :${name} is bound to an array with null in it: IN never matches NULL, and NOT IN with a NULL matches no row`);
  }

  items.forEach((item) => assertBindable(item, name));

  return items;
}

// getPath() reads own keys only: ":constructor" must not read a function from the prototype.
// Array.from() turns the holes of a sparse array into undefined, which is refused like any other.
function readItems(binding, tokens, index) {
  const { name } = tokens[index];
  const value = getPath(binding, [name]);

  if (value === undefined) {
    throw new TypeError(`Placeholder :${name} has no value in the binding`);
  }

  if (isArray(value)) {
    return readList(Array.from(value), tokens, index);
  }

  assertBindable(value, name);

  return [value];
}

function renderItems(items, offset, render) {
  return items.length
    ? items.map((item, index) => render(item, offset + index)).join(LIST_SEPARATOR)
    : EMPTY_LIST;
}

function assertNamed(token) {
  if (isSymbol(token, SYMBOL.QUESTION)) {
    throw new SyntaxError(`SQL has a "?" placeholder at position ${token.start}: only named placeholders (:name) are supported`);
  }
}

// A value written right next to a name, a number, a quote or a dot joins it: "LIMIT:limit" with 1 is the alias
// "LIMIT1" and every row comes back, ":prefix'%'" is one literal with a quote in its middle, "1.:n" is 1.7.
function assertApart(sql, token) {
  if (GLUED_BEFORE_REGEXP.test(sql.charAt(token.start - 1)) || GLUED_AFTER_REGEXP.test(sql.charAt(token.end))) {
    throw new SyntaxError(`SQL has placeholder :${token.name} glued to what stands next to it at position ${token.start}: put a space between them`);
  }
}

// render(value, index) gives the text that stands for one value: "?" by default, the escaped value
// in a driver of a text protocol, "$n" in a driver that numbers its parameters.
export function bindSql(sql, binding = {}, { render = renderMark } = {}) {
  if (!isObject(binding)) {
    throw new TypeError('bindSql(sql, binding) requires binding to be a plain object');
  }

  if (!isFunction(render)) {
    throw new TypeError('bindSql(sql, binding, { render }) requires render to be a function');
  }

  const tokens = readTokens(sql);
  const values = [];
  const parts = [];
  let position = 0;

  tokens.forEach((token, index) => {
    assertNamed(token);

    if (token.type !== TOKEN_TYPE.PLACEHOLDER) {
      return false;
    }

    assertApart(sql, token);

    const items = readItems(binding, tokens, index);

    parts.push(sql.slice(position, token.start), renderItems(items, values.length, render));
    items.forEach((item) => values.push(item));
    position = token.end;

    return true;
  });

  parts.push(sql.slice(position));

  return { sql: parts.join(''), values };
}
