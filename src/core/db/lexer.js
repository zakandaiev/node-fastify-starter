import { truncate } from '#utils/string.js';
import { isString } from '#utils/type.js';

export const TOKEN_TYPE = Object.freeze({
  WORD: 'word',
  PLACEHOLDER: 'placeholder',
  QUOTED: 'quoted',
  COMMENT: 'comment',
  SYMBOL: 'symbol',
});

export const SYMBOL = Object.freeze({
  OPEN: '(',
  CLOSE: ')',
  COMMA: ',',
  SEMICOLON: ';',
  QUESTION: '?',
});

const BACKSLASH = '\\';
const BACKTICK = '`';
const QUOTES = Object.freeze(["'", '"', BACKTICK]);
const SYMBOLS = Object.freeze(Object.values(SYMBOL));

const LINE_BREAK = '\n';
const HASH_COMMENT = '#';
const DASH_COMMENT = '--';
const BLOCK_COMMENT_OPEN = '/*';
const BLOCK_COMMENT_CLOSE = '*/';
const EXECUTABLE_COMMENT_OPENS = Object.freeze(['/*!', '/*M!']);
const HINT_OPEN = '/*+';

const SPACE_CODE = 0x20;
const DELETE_CODE = 0x7F;

const EXCERPT_LENGTH = 60;

// Sticky: each one matches only at lastIndex, so a scan never looks further than its own lexeme.
// A name glued to a dot is a name for the server whatever it spells ("r.limit", "order.id"): a word takes
// the names chained to it, and a name that starts at a dot is passed over.
const WORD_REGEXP = /[A-Za-z_$\P{ASCII}][A-Za-z0-9_$\P{ASCII}]*(?:\.[A-Za-z0-9_$\P{ASCII}]+)*/yu;
const PLACEHOLDER_REGEXP = /:([A-Za-z_][A-Za-z0-9_]*)/y;
// A whole number glued to letters is a name ("5order", "0x4D"), and a variable takes its name ("@limit").
// After a decimal point or an exponent the number ends, and a keyword may follow at once: "0.5ORDER", "1e5IN".
const SKIPPED_REGEXP = /[0-9]+(?:\.[0-9]*(?:[eE][+-]?[0-9]+)?|[eE][+-]?[0-9]+)|\.[0-9]+(?:[eE][+-]?[0-9]+)?|[0-9][A-Za-z0-9_$\P{ASCII}]*(?:\.[A-Za-z0-9_$\P{ASCII}]+)*|@@?[A-Za-z0-9_$.\P{ASCII}]*|\.(?:[A-Za-z_$\P{ASCII}][A-Za-z0-9_$\P{ASCII}]*(?:\.[A-Za-z0-9_$\P{ASCII}]+)*)?/yu;

const NON_ASCII_REGEXP = /\P{ASCII}/u;
const HINT_PLACEHOLDER_REGEXP = /:[A-Za-z_]/;

function matchAt(regexp, sql, start) {
  regexp.lastIndex = start;

  return regexp.exec(sql);
}

function fail(problem, sql, position) {
  throw new SyntaxError(`SQL has ${problem} at position ${position}: ${truncate(sql.slice(position), EXCERPT_LENGTH)}`);
}

// A backslash escapes the next character in '...' and "...", so the quote after an even run of them
// closes the literal; in `...` a backslash is an ordinary character. A doubled quote is the quote itself.
function readQuoted(sql, start) {
  const quote = sql[start];
  const hasBackslashEscapes = quote !== BACKTICK;
  let position = start + 1;

  while (position < sql.length) {
    const char = sql[position];

    if (char === BACKSLASH && hasBackslashEscapes) {
      position += 2;
    } else if (char !== quote) {
      position += 1;
    } else if (sql[position + 1] === quote) {
      position += 2;
    } else {
      return { type: TOKEN_TYPE.QUOTED, end: position + 1 };
    }
  }

  return fail(`an unclosed ${quote}`, sql, start);
}

// "--" opens a comment only before whitespace, a control character or the end: "5--3" is five minus minus three.
function isDashComment(sql, start) {
  if (!sql.startsWith(DASH_COMMENT, start)) {
    return false;
  }

  const nextCode = sql.charCodeAt(start + DASH_COMMENT.length);

  return Number.isNaN(nextCode) || nextCode <= SPACE_CODE || nextCode === DELETE_CODE;
}

function readLineComment(sql, start) {
  const lineEnd = sql.indexOf(LINE_BREAK, start);

  return {
    type: TOKEN_TYPE.COMMENT,
    end: lineEnd === -1
      ? sql.length
      : lineEnd,
  };
}

// The server runs what "/*! ... */" and "/*M! ... */" hold, and reads a hint "/*+ ... */": a keyword or
// a placeholder inside would be invisible here, and a hint with an unbound name is dropped with a warning only.
function readBlockComment(sql, start) {
  if (EXECUTABLE_COMMENT_OPENS.some((open) => sql.startsWith(open, start))) {
    return fail('an unsupported executable comment', sql, start);
  }

  const close = sql.indexOf(BLOCK_COMMENT_CLOSE, start + BLOCK_COMMENT_OPEN.length);

  if (close === -1) {
    return fail('an unclosed comment', sql, start);
  }

  const end = close + BLOCK_COMMENT_CLOSE.length;

  if (sql.startsWith(HINT_OPEN, start) && HINT_PLACEHOLDER_REGEXP.test(sql.slice(start, end))) {
    return fail('a placeholder inside an optimizer hint', sql, start);
  }

  return { type: TOKEN_TYPE.COMMENT, end };
}

function readPlaceholder(sql, start) {
  const match = matchAt(PLACEHOLDER_REGEXP, sql, start);

  return match
    ? { type: TOKEN_TYPE.PLACEHOLDER, end: start + match[0].length, name: match[1] }
    : null;
}

// A keyword is ASCII only, and "ı".toUpperCase() is "I": a name outside ASCII keeps its own form.
function toUpper(word) {
  return NON_ASCII_REGEXP.test(word)
    ? word
    : word.toUpperCase();
}

function readWord(sql, start) {
  const match = matchAt(WORD_REGEXP, sql, start);

  return match
    ? { type: TOKEN_TYPE.WORD, end: start + match[0].length, upper: toUpper(match[0]) }
    : null;
}

// Whitespace, operators, numbers and variables are not tokens: at least one character is passed over.
function readSkipped(sql, start) {
  const match = matchAt(SKIPPED_REGEXP, sql, start);

  return { type: null, end: start + (match?.[0].length || 1) };
}

function readLexeme(sql, start) {
  const char = sql[start];

  if (QUOTES.includes(char)) {
    return readQuoted(sql, start);
  }

  if (char === HASH_COMMENT || isDashComment(sql, start)) {
    return readLineComment(sql, start);
  }

  if (sql.startsWith(BLOCK_COMMENT_OPEN, start)) {
    return readBlockComment(sql, start);
  }

  if (SYMBOLS.includes(char)) {
    return { type: TOKEN_TYPE.SYMBOL, end: start + 1, value: char };
  }

  return readPlaceholder(sql, start) ?? readWord(sql, start) ?? readSkipped(sql, start);
}

export function isSymbol(token, symbol) {
  return token?.type === TOKEN_TYPE.SYMBOL && token.value === symbol;
}

// "words" are keywords in upper case: a quoted name is no keyword, whatever it spells.
export function isWord(token, words) {
  return token?.type === TOKEN_TYPE.WORD && words.includes(token.upper);
}

// Every token is { type, value, start, end, depth }; a word also has "upper", a placeholder "name".
// A parenthesis carries the depth of the level it sits on, what it encloses is one level deeper.
export function tokenizeSql(sql) {
  if (!isString(sql)) {
    throw new TypeError('tokenizeSql(sql) requires a string');
  }

  const tokens = [];
  const openPositions = [];
  let position = 0;

  while (position < sql.length) {
    const lexeme = readLexeme(sql, position);

    if (isSymbol(lexeme, SYMBOL.CLOSE) && openPositions.pop() === undefined) {
      fail('a closing parenthesis without an opening one', sql, position);
    }

    if (lexeme.type) {
      tokens.push({
        ...lexeme,
        value: sql.slice(position, lexeme.end),
        start: position,
        depth: openPositions.length,
      });
    }

    if (isSymbol(lexeme, SYMBOL.OPEN)) {
      openPositions.push(position);
    }

    position = lexeme.end;
  }

  if (openPositions.length) {
    fail('an unclosed parenthesis', sql, openPositions.at(-1));
  }

  return tokens;
}

// The statements of a text, each as its tokens without the comments and the semicolon. Every semicolon ends
// one, also inside a block: BEGIN ... END reads as the statements it holds. What has no token is no statement.
export function readStatements(sql) {
  const statements = [[]];

  tokenizeSql(sql).forEach((token) => {
    if (isSymbol(token, SYMBOL.SEMICOLON)) {
      statements.push([]);
    } else if (token.type !== TOKEN_TYPE.COMMENT) {
      statements.at(-1).push(token);
    }
  });

  return statements.filter((statement) => statement.length > 0);
}
