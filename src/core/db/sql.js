import {
  isSymbol,
  isWord,
  SYMBOL,
  TOKEN_TYPE,
  tokenizeSql,
} from '#core/db/lexer.js';
import { isNonEmptyString } from '#utils/type.js';

const CLAUSE = Object.freeze({
  SELECT: 'SELECT',
  FROM: 'FROM',
  WHERE: 'WHERE',
  GROUP_BY: 'GROUP BY',
  HAVING: 'HAVING',
  WINDOW: 'WINDOW',
  OVER: 'OVER',
  DISTINCT: 'DISTINCT',
  ORDER_BY: 'ORDER BY',
  LIMIT: 'LIMIT',
  PROCEDURE: 'PROCEDURE',
  INTO: 'INTO',
  FOR_UPDATE: 'FOR UPDATE',
  LOCK_IN_SHARE_MODE: 'LOCK IN SHARE MODE',
  SET_OPERATION: 'UNION, EXCEPT or INTERSECT',
  FETCH: 'OFFSET ... ROWS or FETCH',
});

const WORD_CLAUSES = new Map([
  ['SELECT', CLAUSE.SELECT],
  ['FROM', CLAUSE.FROM],
  ['WHERE', CLAUSE.WHERE],
  ['HAVING', CLAUSE.HAVING],
  ['OVER', CLAUSE.OVER],
  ['DISTINCT', CLAUSE.DISTINCT],
  ['DISTINCTROW', CLAUSE.DISTINCT],
  ['LIMIT', CLAUSE.LIMIT],
  ['PROCEDURE', CLAUSE.PROCEDURE],
  ['INTO', CLAUSE.INTO],
  ['UNION', CLAUSE.SET_OPERATION],
  ['EXCEPT', CLAUSE.SET_OPERATION],
  ['INTERSECT', CLAUSE.SET_OPERATION],
  ['FETCH', CLAUSE.FETCH],
]);

// After FOR, ORDER BY and GROUP BY are an index hint inside FROM ("USE INDEX FOR ORDER BY (i)"),
// and FOR before anything but UPDATE is a hint or FOR SYSTEM_TIME of a table.
const PAIRED_CLAUSES = new Map([
  ['ORDER', { next: 'BY', clause: CLAUSE.ORDER_BY }],
  ['GROUP', { next: 'BY', clause: CLAUSE.GROUP_BY }],
  ['FOR', { next: 'UPDATE', clause: CLAUSE.FOR_UPDATE }],
  ['LOCK', { next: 'IN', clause: CLAUSE.LOCK_IN_SHARE_MODE }],
]);

const SELECT_WORD = 'SELECT';
const WITH_WORD = 'WITH';
const FOR_WORD = 'FOR';
const AS_WORD = 'AS';
const AND_WORD = 'AND';
const WINDOW_WORD = 'WINDOW';
const OFFSET_WORD = 'OFFSET';
const FETCH_WORD = 'FETCH';
const OVER_WORD = 'OVER';
const RESTRICT_WORD = 'RESTRICT';
const STATEMENT_WORDS = Object.freeze([SELECT_WORD, 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'VALUES', 'TABLE']);
const AGGREGATE_WORDS = Object.freeze([
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'GROUP_CONCAT',
  'JSON_ARRAYAGG',
  'JSON_OBJECTAGG',
  'BIT_AND',
  'BIT_OR',
  'BIT_XOR',
  'STD',
  'STDDEV',
  'STDDEV_POP',
  'STDDEV_SAMP',
  'VARIANCE',
  'VAR_POP',
  'VAR_SAMP',
]);
const FIRST_SELECT_OPTION_WORDS = Object.freeze(['HIGH_PRIORITY', 'SQL_BUFFER_RESULT', 'SQL_CACHE', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS']);
const SELECT_OPTION_WORDS = Object.freeze([
  'ALL',
  'DISTINCT',
  'DISTINCTROW',
  'STRAIGHT_JOIN',
  'SQL_SMALL_RESULT',
  'SQL_BIG_RESULT',
  ...FIRST_SELECT_OPTION_WORDS,
]);
const NAME_TYPES = Object.freeze([TOKEN_TYPE.WORD, TOKEN_TYPE.QUOTED]);
const BLANKS = Object.freeze([' ', '\t', '\n', '\v', '\f', '\r']);
const DOT = '.';

const BACKWARD = -1;
const FORWARD = 1;

const LOCKING_CLAUSES = Object.freeze([CLAUSE.FOR_UPDATE, CLAUSE.LOCK_IN_SHARE_MODE]);
const LIMIT_BOUNDARIES = Object.freeze([CLAUSE.PROCEDURE, CLAUSE.INTO, ...LOCKING_CLAUSES]);
const ORDER_BOUNDARIES = Object.freeze([CLAUSE.LIMIT, ...LIMIT_BOUNDARIES]);
const WHERE_BOUNDARIES = Object.freeze([CLAUSE.GROUP_BY, CLAUSE.HAVING, CLAUSE.WINDOW, CLAUSE.ORDER_BY, ...ORDER_BOUNDARIES]);
const PAGE_CLAUSES = Object.freeze([CLAUSE.ORDER_BY, CLAUSE.LIMIT]);
const GROUPING_CLAUSES = Object.freeze([CLAUSE.GROUP_BY, CLAUSE.HAVING, CLAUSE.WINDOW, CLAUSE.OVER, CLAUSE.DISTINCT]);
const UNWRAPPABLE_CLAUSES = Object.freeze([...LOCKING_CLAUSES, CLAUSE.INTO, CLAUSE.PROCEDURE]);

const SQL_NAME = 'sql';
const TEXT_NAME = 'text';
const STATEMENT_SUBJECT = 'one statement';

const WRAP_HEAD = 'SELECT * FROM (';
const COUNT_HEAD = 'SELECT COUNT(*) AS total FROM (';
const DERIVED_TABLE_END = ') q';

// WINDOW is no reserved word, and a column may be called window: the clause is "WINDOW <name> AS (".
function isWindowClause(tokens, index) {
  const [name, as, open] = tokens.slice(index + 1, index + 4);

  return NAME_TYPES.includes(name?.type) && isWord(as, [AS_WORD]) && isSymbol(open, SYMBOL.OPEN);
}

// OFFSET is reserved: outside a LIMIT it opens the standard "OFFSET n ROWS [FETCH ...]", which a written
// ORDER BY would cut away and a written LIMIT would stand beside.
function readClauseName(tokens, index, { previousWord, lastClause }) {
  const { upper } = tokens[index];
  const pair = PAIRED_CLAUSES.get(upper);

  if (pair) {
    return isWord(tokens[index + 1], [pair.next]) && !isWord(previousWord, [FOR_WORD])
      ? pair.clause
      : null;
  }

  if (upper === WINDOW_WORD) {
    return isWindowClause(tokens, index)
      ? CLAUSE.WINDOW
      : null;
  }

  if (upper === OFFSET_WORD) {
    return lastClause === CLAUSE.LIMIT
      ? null
      : CLAUSE.FETCH;
  }

  return WORD_CLAUSES.get(upper) ?? null;
}

// On one level of parentheses only, the statement's own by default: a subquery, a CTE body, OVER (...) and
// EXTRACT(YEAR FROM d) hold keywords of their own.
function readClauses(tokens, depth = 0) {
  const clauses = [];
  let previousWord = null;

  tokens.forEach((token, index) => {
    if (token.depth !== depth || token.type !== TOKEN_TYPE.WORD) {
      return false;
    }

    const name = readClauseName(tokens, index, { previousWord, lastClause: clauses.at(-1)?.name });

    if (name) {
      clauses.push({ name, index });
    }

    previousWord = token;

    return true;
  });

  return clauses;
}

function readText(text, signature, { name = SQL_NAME, subject = STATEMENT_SUBJECT } = {}) {
  if (!isNonEmptyString(text)) {
    throw new TypeError(`${signature} requires ${name} to be a non-empty string`);
  }

  const tokens = tokenizeSql(text);

  if (tokens.some((token) => isSymbol(token, SYMBOL.SEMICOLON))) {
    throw new SyntaxError(`${signature} takes ${subject} without a semicolon`);
  }

  const code = tokens.filter((token) => token.type !== TOKEN_TYPE.COMMENT);
  const comments = tokens.filter((token) => token.type === TOKEN_TYPE.COMMENT);

  return {
    sql: text,
    tokens: code,
    clauses: readClauses(code),
    commentsByEnd: new Map(comments.map((comment) => [comment.end, comment])),
  };
}

function hasClause(clauses, names) {
  return clauses.some((clause) => names.includes(clause.name));
}

function findClause(clauses, names, afterIndex = -1) {
  return clauses.find((clause) => names.includes(clause.name) && clause.index > afterIndex);
}

// A query in parentheses, one led by WITH and one made of several queries: a clause of their own cannot be added.
function isQueryExpression({ tokens, clauses }) {
  return isSymbol(tokens[0], SYMBOL.OPEN)
    || isWord(tokens[0], [WITH_WORD])
    || hasClause(clauses, [CLAUSE.SET_OPERATION]);
}

// An ORDER BY and a LIMIT after the last set operation order and cut the whole statement. Its clauses are read
// from the FROM of that query on: "SELECT id INTO @id FROM t" has its INTO before the FROM.
function readTail(clauses) {
  const lastSet = clauses.findLastIndex((clause) => clause.name === CLAUSE.SET_OPERATION);
  const query = clauses.slice(lastSet + 1);
  const from = query.findIndex((clause) => clause.name === CLAUSE.FROM);

  return from === -1
    ? query
    : query.slice(from);
}

function skipOpens(tokens, from) {
  let index = from;

  while (isSymbol(tokens[index], SYMBOL.OPEN)) {
    index += 1;
  }

  return index;
}

function readLevelIndices(tokens, from) {
  const { depth } = tokens[from];
  const indices = [];
  let index = from + 1;

  while (index < tokens.length && tokens[index].depth >= depth) {
    if (tokens[index].depth === depth) {
      indices.push(index);
    }

    index += 1;
  }

  return indices;
}

function isQueryParenthesis(token, previous) {
  return isSymbol(token, SYMBOL.OPEN)
    && (isSymbol(previous, SYMBOL.CLOSE) || isWord(previous, [RESTRICT_WORD]));
}

// The bodies of the common table expressions are SELECTs whatever the statement is: its query stands past them,
// at its statement keyword or at a "(" right after the ")" of the last body or RESTRICT of a CYCLE clause.
// The "(" of "c (a, b) AS (" follows a name or AS.
function findWithQuery(tokens, withIndex) {
  const level = readLevelIndices(tokens, withIndex);
  const start = level.find((index, position) => isWord(tokens[index], STATEMENT_WORDS)
    || isQueryParenthesis(tokens[index], tokens[level[position - 1]]));

  if (start === undefined) {
    return -1;
  }

  return isSymbol(tokens[start], SYMBOL.OPEN)
    ? skipOpens(tokens, start)
    : start;
}

function findQueryStart(tokens) {
  const first = skipOpens(tokens, 0);

  return isWord(tokens[first], [WITH_WORD])
    ? findWithQuery(tokens, first)
    : first;
}

function readSelect(sql, signature) {
  const statement = readText(sql, signature);
  const queryStart = findQueryStart(statement.tokens);

  if (!isWord(statement.tokens[queryStart], [SELECT_WORD])) {
    throw new TypeError(`${signature} requires a SELECT statement`);
  }

  return { ...statement, queryStart };
}

// The server drops an OFFSET ... ROWS without FETCH of a single query in parentheses once the statement goes into
// a derived table or gets an ORDER BY or a LIMIT after them; around a set operation it may drop it or filter the rows
// before it skips them. Only a branch of a set operation keeps it.
function dropsInnerOffset(statement) {
  return readOuterLevels(statement).some(({ tokens, clauses }) => {
    const tail = readTail(clauses);

    return tail.some((clause) => isWord(tokens[clause.index], [OFFSET_WORD]))
      && !tail.some((clause) => isWord(tokens[clause.index], [FETCH_WORD]));
  });
}

function readEditableSelect(sql, signature) {
  const statement = readSelect(sql, signature);

  if (hasClause(statement.clauses, [CLAUSE.FETCH])) {
    throw new SyntaxError(`${signature} cannot take OFFSET ... ROWS or FETCH: write the page with LIMIT`);
  }

  if (dropsInnerOffset(statement)) {
    throw new TypeError(`${signature} cannot take an OFFSET ... ROWS without FETCH inside the parentheses of the statement: once the statement goes into a derived table or gets an ORDER BY or a LIMIT after the parentheses, the server drops that offset or filters the rows before it skips them, so skip the rows with LIMIT ... OFFSET`);
  }

  return statement;
}

// The server takes SQL_NO_CACHE and its kind only in the first query of a statement, never in a common table
// expression, a subquery, a later branch or a derived table: only the query the statement runs can hold them.
function readSelectOptions({ tokens, queryStart }) {
  let end = queryStart + 1;

  while (isWord(tokens[end], SELECT_OPTION_WORDS)) {
    end += 1;
  }

  return tokens.slice(queryStart + 1, end);
}

function readCountableSelect(sql, signature) {
  const statement = readEditableSelect(sql, signature);
  const clause = findClause(statement.clauses, UNWRAPPABLE_CLAUSES);

  if (clause) {
    throw new TypeError(`${signature} cannot put ${clause.name} into a derived table: the server refuses INTO and PROCEDURE there, and a lock taken there covers every row the inner statement reads`);
  }

  const option = readSelectOptions(statement).find((token) => isWord(token, FIRST_SELECT_OPTION_WORDS));

  if (option) {
    throw new TypeError(`${signature} cannot put ${option.upper} into a derived table: the server refuses that option there, so leave it out of the statement`);
  }

  return statement;
}

// The lexer keeps "u.created_at" one word, and passes over the dot beside a quoted part ("`u`.`created_at`").
function isQualifiedName(sql, token) {
  const isDottedWord = token.type === TOKEN_TYPE.WORD && token.value.includes(DOT);

  return isDottedWord || (NAME_TYPES.includes(token.type) && [sql[token.start - 1], sql[token.end]].includes(DOT));
}

// Outside a derived table only the columns of its result have names. An aggregate there silently turns the outer
// query into a grouping of one row, a window runs over the filtered rows, and a qualified name fails.
function namesOnlyResults(sql, tokens) {
  return !tokens.some((token, index) => isWord(token, [OVER_WORD])
    || (isWord(token, AGGREGATE_WORDS) && isSymbol(tokens[index + 1], SYMBOL.OPEN))
    || isQualifiedName(sql, token));
}

function readOwnOrderList({ tokens, clauses }) {
  const tail = readTail(clauses);
  const order = findClause(tail, [CLAUSE.ORDER_BY]);

  if (!order) {
    return [];
  }

  const [, , ...list] = tokens.slice(order.index, findClause(tail, ORDER_BOUNDARIES, order.index)?.index);

  return list;
}

// Walking away from the token at "start", the first token of each lower depth is the parenthesis of that depth
// around it: a parenthesis carries the depth of the level it sits on.
function findEnclosingParentheses(tokens, start, step) {
  const found = [];
  let depth = tokens[start].depth - 1;
  let index = start + step;

  while (depth >= 0 && index >= 0 && index < tokens.length) {
    if (tokens[index].depth === depth) {
      found[depth] = index;
      depth -= 1;
    }

    index += step;
  }

  return found;
}

// From the outside in, each level with the tokens of its own depth between its parentheses: a subquery and
// a branch beside the query hold tokens of that depth too.
function readEnclosingLevels(tokens, start) {
  const opens = findEnclosingParentheses(tokens, start, BACKWARD);
  const closes = findEnclosingParentheses(tokens, start, FORWARD);
  const levels = Array.from(opens, () => []);

  tokens.forEach((token, index) => {
    const level = token.depth - 1;

    if (level >= 0 && level < levels.length && index > opens[level] && index < closes[level]) {
      levels[level].push(token);
    }
  });

  return levels;
}

// From the outside in, the levels around the query up to the first that holds a set operation, with their clauses:
// a branch of a set operation fares alike inside a derived table and outside one. None for a statement that holds
// a set operation itself.
function readOuterLevels({ tokens, clauses, queryStart }) {
  if (hasClause(clauses, [CLAUSE.SET_OPERATION])) {
    return [];
  }

  const levels = readEnclosingLevels(tokens, queryStart)
    .map((level, index) => ({ tokens: level, clauses: readClauses(level, index + 1) }));
  const setLevel = levels.findIndex((level) => hasClause(level.clauses, [CLAUSE.SET_OPERATION]));

  return setLevel === -1
    ? levels
    : levels.slice(0, setLevel + 1);
}

// A LIMIT or a FETCH keeps the order of its level and of the levels inside it. An OFFSET ... ROWS without FETCH,
// which the server may drop, is refused before (dropsInnerOffset).
function keepsOrder(tail) {
  return hasClause(tail, [CLAUSE.LIMIT, CLAUSE.FETCH]);
}

// The server keeps the ORDER BY of a set operation inside a derived table.
function dropsInnerOrder(levels) {
  let isOrderKept = false;
  let index = 0;

  while (index < levels.length) {
    const { clauses } = levels[index];

    if (hasClause(clauses, [CLAUSE.SET_OPERATION])) {
      return false;
    }

    const tail = readTail(clauses);

    isOrderKept = isOrderKept || keepsOrder(tail);

    if (!isOrderKept && hasClause(tail, [CLAUSE.ORDER_BY])) {
      return true;
    }

    index += 1;
  }

  return false;
}

// Inside a derived table the server drops an ORDER BY without LIMIT: the order a query in parentheses gives its
// rows is lost there, unless the statement orders them again after the parentheses.
function losesInnerOrder(statement) {
  return !hasClause(readTail(statement.clauses), [CLAUSE.ORDER_BY]) && dropsInnerOrder(readOuterLevels(statement));
}

function readWrappableSelect(sql, signature) {
  const statement = readCountableSelect(sql, signature);

  if (!namesOnlyResults(statement.sql, readOwnOrderList(statement))) {
    throw new TypeError(`${signature} moves the ORDER BY of the statement out of the derived table, where only the columns of the result have names: order by an alias or a position of the result, not by an aggregate, a window or a qualified name, or use .sort()`);
  }

  if (losesInnerOrder(statement)) {
    throw new TypeError(`${signature} cannot keep the ORDER BY inside the parentheses of the statement: inside a derived table the server drops an ORDER BY without LIMIT, so drop the outer parentheses`);
  }

  return statement;
}

function skipBlanks(sql, start) {
  let position = start;

  while (position < sql.length && BLANKS.includes(sql[position])) {
    position += 1;
  }

  return position;
}

// Read from the text, not from the last token: the lexer passes over numbers and operators ("WHERE age > 18").
// A comment is checked before a blank: a line comment ends with the blanks in front of its line break.
function findCodeEnd({ sql, commentsByEnd }, limit) {
  let end = limit;

  while (end > 0) {
    const comment = commentsByEnd.get(end);

    if (comment) {
      end = comment.start;
    } else if (BLANKS.includes(sql[end - 1])) {
      end -= 1;
    } else {
      return end;
    }
  }

  return end;
}

// A region ends with its code, not with the comment behind it: text put after "FROM t -- note" would be
// a part of the note, and "(<body -- note>)" would lose its closing parenthesis.
function findEndBefore(statement, clause) {
  const limit = clause
    ? statement.tokens[clause.index].start
    : statement.sql.length;

  return findCodeEnd(statement, limit);
}

function isApart(left, right) {
  return [left.at(-1), right[0]].some((char) => char === undefined || BLANKS.includes(char));
}

// Pieces written side by side must not glue into one word: "ORDER BY (a)LIMIT 1" has no blank between them.
function joinSql(left, right) {
  return isApart(left, right)
    ? `${left}${right}`
    : `${left} ${right}`;
}

function spliceSql(sql, start, end, text) {
  return joinSql(joinSql(sql.slice(0, start), text), sql.slice(end));
}

// Right in front of a keyword nothing can swallow the text; at the end it goes ahead of a trailing comment.
function insertClause(statement, boundary, text) {
  const position = boundary
    ? statement.tokens[boundary.index].start
    : findEndBefore(statement, boundary);

  return spliceSql(statement.sql, position, position, text);
}

function replaceClause(statement, clause, boundary, text) {
  return spliceSql(statement.sql, statement.tokens[clause.index].start, findEndBefore(statement, boundary), text);
}

function setClause(statement, name, boundaries, text) {
  const tail = readTail(statement.clauses);
  const clause = findClause(tail, [name]);
  const boundary = findClause(tail, boundaries, clause?.index);

  return clause
    ? replaceClause(statement, clause, boundary, text)
    : insertClause(statement, boundary, text);
}

// The condition that is there goes into parentheses whole: "a OR b" must not bind to the AND.
function extendWhere(statement, where, boundary, condition) {
  const { sql, tokens } = statement;
  const end = findEndBefore(statement, boundary);
  const start = Math.min(skipBlanks(sql, tokens[where.index].end), end);

  return spliceSql(sql, start, end, `(${sql.slice(start, end)}) ${AND_WORD} (${condition})`);
}

function findBodyEnd(statement) {
  return findEndBefore(statement, findClause(readTail(statement.clauses), PAGE_CLAUSES));
}

function readBody({ sql }, end) {
  return sql.slice(skipBlanks(sql, 0), end);
}

// Text of the caller goes in as one piece: it must read as SQL on its own, and it ends with its code,
// so that a line comment at its end cannot swallow the clause written after it.
function readFragment(text, name, signature) {
  const fragment = readText(text, signature, { name, subject: name });
  const end = findCodeEnd(fragment, text.length);
  const start = skipBlanks(text, 0);

  if (start >= end) {
    throw new TypeError(`${signature} requires ${name} to hold SQL, not only blanks and comments`);
  }

  return text.slice(start, end);
}

export function assertOneStatement(sql, signature) {
  readText(sql, signature);
}

export function assertEditableSelect(sql, signature) {
  readEditableSelect(sql, signature);
}

export function assertCountableSelect(sql, signature) {
  readCountableSelect(sql, signature);
}

export function assertWrappableSelect(sql, signature) {
  readWrappableSelect(sql, signature);
}

export function isSelect(sql) {
  const { tokens } = readText(sql, 'isSelect(sql)');

  return isWord(tokens[findQueryStart(tokens)], [SELECT_WORD]);
}

export function isLockingRead(sql) {
  return hasClause(readText(sql, 'isLockingRead(sql)').clauses, LOCKING_CLAUSES);
}

export function namesResultColumns(text) {
  const { sql, tokens } = readText(text, 'namesResultColumns(text)', { name: TEXT_NAME, subject: TEXT_NAME });

  return namesOnlyResults(sql, tokens);
}

// The rows of a query expression, a grouping, a window and a query without FROM exist only once the statement
// has run: a filter on them goes outside, into the WHERE of a derived table.
export function requiresDerivedTable(sql) {
  const statement = readSelect(sql, 'requiresDerivedTable(sql)');

  return isQueryExpression(statement)
    || hasClause(statement.clauses, GROUPING_CLAUSES)
    || !hasClause(statement.clauses, [CLAUSE.FROM]);
}

export function appendToWhere(sql, condition) {
  const signature = 'appendToWhere(sql, condition)';
  const statement = readEditableSelect(sql, signature);
  const text = readFragment(condition, 'condition', signature);

  if (isQueryExpression(statement)) {
    throw new TypeError(`${signature} takes a single query: wrap a statement that starts with "(" or WITH, or holds UNION, EXCEPT or INTERSECT, in a derived table first (wrapSelect)`);
  }

  const tail = readTail(statement.clauses);
  const where = findClause(tail, [CLAUSE.WHERE]);
  const boundary = findClause(tail, WHERE_BOUNDARIES, where?.index);

  return where
    ? extendWhere(statement, where, boundary, text)
    : insertClause(statement, boundary, `${CLAUSE.WHERE} ${text}`);
}

export function replaceOrderBy(sql, orderBy) {
  const signature = 'replaceOrderBy(sql, orderBy)';
  const statement = readEditableSelect(sql, signature);

  return setClause(statement, CLAUSE.ORDER_BY, ORDER_BOUNDARIES, `${CLAUSE.ORDER_BY} ${readFragment(orderBy, 'orderBy', signature)}`);
}

export function replacePagination(sql, limit) {
  const signature = 'replacePagination(sql, limit)';
  const statement = readEditableSelect(sql, signature);

  return setClause(statement, CLAUSE.LIMIT, LIMIT_BOUNDARIES, `${CLAUSE.LIMIT} ${readFragment(limit, 'limit', signature)}`);
}

// The ORDER BY and LIMIT of the statement stay outside, after the derived table: they order and cut the rows
// a filter keeps, and the server drops an ORDER BY without LIMIT inside a derived table.
export function wrapSelect(sql) {
  const statement = readWrappableSelect(sql, 'wrapSelect(sql)');
  const end = findBodyEnd(statement);

  return joinSql(`${WRAP_HEAD}${readBody(statement, end)}${DERIVED_TABLE_END}`, sql.slice(end));
}

// Always over a derived table: an aggregate without GROUP BY, DISTINCT, GROUP BY and a set operation are
// counted by their rows, and the server merges a simple derived table into the count.
export function buildCountSql(sql) {
  const statement = readCountableSelect(sql, 'buildCountSql(sql)');

  return `${COUNT_HEAD}${readBody(statement, findBodyEnd(statement))}${DERIVED_TABLE_END}`;
}
