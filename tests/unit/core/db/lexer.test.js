import {
  isSymbol,
  SYMBOL,
  TOKEN_TYPE,
  tokenizeSql,
} from '#core/db/lexer.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function read(sql) {
  return tokenizeSql(sql).map((token) => [token.type, token.value]);
}

function readUpper(sql) {
  return tokenizeSql(sql)
    .filter((token) => token.type === TOKEN_TYPE.WORD)
    .map((token) => token.upper);
}

function readPlaceholders(sql) {
  return tokenizeSql(sql)
    .filter((token) => token.type === TOKEN_TYPE.PLACEHOLDER)
    .map((token) => token.name);
}

function readQuoted(sql) {
  return tokenizeSql(sql)
    .filter((token) => token.type === TOKEN_TYPE.QUOTED)
    .map((token) => token.value);
}

function readComments(sql) {
  return tokenizeSql(sql)
    .filter((token) => token.type === TOKEN_TYPE.COMMENT)
    .map((token) => token.value);
}

describe('tokenizeSql', () => {
  test('requires a string', () => {
    assert.throws(() => tokenizeSql(), /requires a string/);
    assert.throws(() => tokenizeSql(null), TypeError);
    assert.throws(() => tokenizeSql(['SELECT 1']), TypeError);
  });

  test('returns no token for an empty statement and for whitespace', () => {
    assert.deepEqual(tokenizeSql(''), []);
    assert.deepEqual(tokenizeSql(' \n\t '), []);
  });

  test('reads words, symbols and placeholders, and passes over operators and numbers', () => {
    assert.deepEqual(read('SELECT id, name FROM users WHERE id = :id AND age >= 18;'), [
      ['word', 'SELECT'],
      ['word', 'id'],
      ['symbol', ','],
      ['word', 'name'],
      ['word', 'FROM'],
      ['word', 'users'],
      ['word', 'WHERE'],
      ['word', 'id'],
      ['placeholder', ':id'],
      ['word', 'AND'],
      ['word', 'age'],
      ['symbol', ';'],
    ]);
  });

  test('gives every token its place in the statement', () => {
    const sql = 'SELECT `a` FROM t WHERE x IN (:ids) -- tail';
    const tokens = tokenizeSql(sql);

    tokens.forEach((token) => assert.equal(sql.slice(token.start, token.end), token.value));
    assert.deepEqual(tokens.map((token) => token.start), [0, 7, 11, 16, 18, 24, 26, 29, 30, 34, 36]);
  });

  test('gives a word its upper-case form and a placeholder its name', () => {
    const [select, placeholder] = tokenizeSql('select 1 + :userId');

    assert.equal(select.upper, 'SELECT');
    assert.equal(select.value, 'select');
    assert.equal(placeholder.name, 'userId');
    assert.equal(placeholder.value, ':userId');
  });

  test('exports the symbols it reads', () => {
    assert.deepEqual(
      tokenizeSql('( ) , ; ?').map((token) => token.value),
      [SYMBOL.OPEN, SYMBOL.CLOSE, SYMBOL.COMMA, SYMBOL.SEMICOLON, SYMBOL.QUESTION],
    );
  });
});

describe('isSymbol', () => {
  test('tells a symbol token by its character', () => {
    const [open, word, close] = tokenizeSql('(a)');

    assert.equal(isSymbol(open, SYMBOL.OPEN), true);
    assert.equal(isSymbol(close, SYMBOL.CLOSE), true);
    assert.equal(isSymbol(open, SYMBOL.CLOSE), false);
    assert.equal(isSymbol(word, SYMBOL.OPEN), false);
  });

  test('takes a parenthesis inside quotes and a missing token for no symbol', () => {
    const [quoted] = tokenizeSql("'('");

    assert.equal(isSymbol(quoted, SYMBOL.OPEN), false);
    assert.equal(isSymbol(undefined, SYMBOL.OPEN), false);
  });
});

describe('tokenizeSql: parentheses', () => {
  test('counts the depth: a parenthesis sits on the level outside it, its content one level deeper', () => {
    const tokens = tokenizeSql('SELECT (a + (b)) FROM t').map((token) => [token.value, token.depth]);

    assert.deepEqual(tokens, [
      ['SELECT', 0],
      ['(', 0],
      ['a', 1],
      ['(', 1],
      ['b', 2],
      [')', 1],
      [')', 0],
      ['FROM', 0],
      ['t', 0],
    ]);
  });

  test('does not count a parenthesis inside a literal, an identifier or a comment', () => {
    const tokens = tokenizeSql("SELECT '(', `)`, \"((\" /* ( */ FROM t -- )");

    assert.equal(tokens.every((token) => token.depth === 0), true);
  });

  test('refuses a statement whose parentheses do not match', () => {
    assert.throws(() => tokenizeSql('SELECT (1'), /an unclosed parenthesis at position 7/);
    assert.throws(() => tokenizeSql('SELECT ((1)'), /an unclosed parenthesis at position 7/);
    assert.throws(() => tokenizeSql('SELECT 1)'), /a closing parenthesis without an opening one at position 8/);
    assert.throws(() => tokenizeSql('SELECT (1)) + (2'), SyntaxError);
  });
});

describe('tokenizeSql: literals and quoted identifiers', () => {
  test('reads a literal in single and double quotes and an identifier in backticks as one token each', () => {
    assert.deepEqual(read("SELECT 'a b', \"c d\", `e f`"), [
      ['word', 'SELECT'],
      ['quoted', "'a b'"],
      ['symbol', ','],
      ['quoted', '"c d"'],
      ['symbol', ','],
      ['quoted', '`e f`'],
    ]);
  });

  test('takes a doubled quote for the quote itself', () => {
    assert.deepEqual(readQuoted("SELECT 'it''s', \"say \"\"hi\"\"\", `a``b`"), ["'it''s'", '"say ""hi"""', '`a``b`']);
    assert.deepEqual(readQuoted("SELECT '''', ''"), ["''''", "''"]);
  });

  test('takes a quote after a backslash for a part of the literal', () => {
    assert.deepEqual(readQuoted("SELECT 'it\\'s', \"a\\\"b\""), ["'it\\'s'", '"a\\"b"']);
  });

  test('closes a literal that ends with an escaped backslash: an even run of backslashes escapes nothing', () => {
    assert.deepEqual(read("SELECT 'a\\\\' AS v, :id"), [
      ['word', 'SELECT'],
      ['quoted', "'a\\\\'"],
      ['word', 'AS'],
      ['word', 'v'],
      ['symbol', ','],
      ['placeholder', ':id'],
    ]);
    assert.deepEqual(readQuoted("SELECT 'a\\\\\\'b', 'c\\\\\\\\'"), ["'a\\\\\\'b'", "'c\\\\\\\\'"]);
  });

  test('takes a backslash inside backticks for an ordinary character', () => {
    assert.deepEqual(read('SELECT 1 AS `a\\`, :id'), [
      ['word', 'SELECT'],
      ['word', 'AS'],
      ['quoted', '`a\\`'],
      ['symbol', ','],
      ['placeholder', ':id'],
    ]);
  });

  test('finds no placeholder, comment or keyword inside a literal', () => {
    const sql = "SELECT ':id', 'a -- b', 'c /* d */', 'e # f', \"WHERE :x\", `:y`, '?'";

    assert.deepEqual(readPlaceholders(sql), []);
    assert.deepEqual(readComments(sql), []);
    assert.deepEqual(tokenizeSql(sql).filter((token) => token.type === TOKEN_TYPE.WORD).map((token) => token.upper), ['SELECT']);
  });

  test('keeps a line break inside a literal', () => {
    assert.deepEqual(readQuoted("SELECT 'first\nsecond' -- tail"), ["'first\nsecond'"]);
  });

  test('reads the introducer of a literal as a word next to it', () => {
    assert.deepEqual(read("SELECT N'abc', X'4142', _utf8mb4'abc'"), [
      ['word', 'SELECT'],
      ['word', 'N'],
      ['quoted', "'abc'"],
      ['symbol', ','],
      ['word', 'X'],
      ['quoted', "'4142'"],
      ['symbol', ','],
      ['word', '_utf8mb4'],
      ['quoted', "'abc'"],
    ]);
  });

  test('refuses a literal that is not closed', () => {
    assert.throws(() => tokenizeSql("SELECT 'abc"), /an unclosed ' at position 7/);
    assert.throws(() => tokenizeSql('SELECT "abc'), /an unclosed " at position 7/);
    assert.throws(() => tokenizeSql('SELECT `abc'), /an unclosed ` at position 7/);
    assert.throws(() => tokenizeSql("SELECT 'abc\\'"), SyntaxError);
    assert.throws(() => tokenizeSql("SELECT 'abc\\"), SyntaxError);
  });
});

describe('tokenizeSql: comments', () => {
  test('reads the three forms of a comment', () => {
    assert.deepEqual(
      readComments('SELECT 1 -- one\n, 2 # two\n, /* three\n lines */ 3'),
      ['-- one', '# two', '/* three\n lines */'],
    );
  });

  test('ends a line comment at the line break, or at the end of the statement', () => {
    assert.deepEqual(read('SELECT 1 -- a\nFROM t # b'), [
      ['word', 'SELECT'],
      ['comment', '-- a'],
      ['word', 'FROM'],
      ['word', 't'],
      ['comment', '# b'],
    ]);
    assert.deepEqual(readComments('SELECT 1 --'), ['--']);
  });

  test('finds no placeholder inside a comment', () => {
    assert.deepEqual(readPlaceholders('SELECT 1 -- owner:me\n, :id # :hash\n /* :block */'), ['id']);
  });

  test('takes two dashes for a comment only before whitespace or a control character', () => {
    assert.deepEqual(readComments('SELECT 5--3'), []);
    assert.deepEqual(readComments('SELECT 5 --3'), []);
    assert.deepEqual(readComments('SELECT 5-- 3'), ['-- 3']);
    assert.deepEqual(readComments('SELECT 5--\t3'), ['--\t3']);
    assert.deepEqual(readComments('SELECT 5--\n3'), ['--']);
    assert.deepEqual(readComments('SELECT 5--\x7f3'), ['--\x7f3']);
    assert.deepEqual(readComments('SELECT 5--\x013'), ['--\x013']);
    assert.deepEqual(readComments('SELECT 5--\r3'), ['--\r3']);
    assert.deepEqual(readComments('SELECT 5--\v3'), ['--\v3']);
    assert.deepEqual(readComments('SELECT 5--é3'), []);
  });

  test('does not open a comment inside a comment', () => {
    assert.deepEqual(readComments('SELECT /* a -- b */ 1'), ['/* a -- b */']);
    assert.deepEqual(read('SELECT 1 -- a /* b\nFROM t'), [
      ['word', 'SELECT'],
      ['comment', '-- a /* b'],
      ['word', 'FROM'],
      ['word', 't'],
    ]);
  });

  test('reads an optimizer hint as a comment', () => {
    assert.deepEqual(readComments('SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1'), ['/*+ MAX_EXECUTION_TIME(1000) */']);
  });

  test('refuses a placeholder inside an optimizer hint: the server would drop the hint, not fail', () => {
    assert.throws(
      () => tokenizeSql('SELECT /*+ MAX_EXECUTION_TIME(:ms) */ 1'),
      /a placeholder inside an optimizer hint at position 7/,
    );
    assert.deepEqual(readPlaceholders('SELECT /* :block */ /*+ NO_MERGE(t) */ :id'), ['id']);
  });

  test('refuses it in every spelling of a name, and reads a colon that starts no name as a part of the hint', () => {
    assert.throws(() => tokenizeSql('SELECT /*+ MAX_EXECUTION_TIME(:MS) */ 1'), /a placeholder inside an optimizer hint/);
    assert.throws(() => tokenizeSql('SELECT /*+ MAX_EXECUTION_TIME(:_ms) */ 1'), /a placeholder inside an optimizer hint/);
    assert.deepEqual(readComments("SELECT /*+ X('10:30') */ 1"), ["/*+ X('10:30') */"]);
    assert.deepEqual(readComments('SELECT /*+ X(a : b) */ 1'), ['/*+ X(a : b) */']);
  });

  test('refuses a block comment that is not closed', () => {
    assert.throws(() => tokenizeSql('SELECT 1 /* tail'), /an unclosed comment at position 9/);
    assert.throws(() => tokenizeSql('SELECT 1 /*/'), SyntaxError);
  });

  test('refuses an executable comment: the server runs what it holds', () => {
    assert.throws(() => tokenizeSql('SELECT 1 /*! + 1 */'), /an unsupported executable comment at position 9/);
    assert.throws(() => tokenizeSql('SELECT 1 /*!50000 + 1 */'), SyntaxError);
    assert.throws(() => tokenizeSql('SELECT 1 /*M! + 1 */'), SyntaxError);
    assert.throws(() => tokenizeSql('SELECT 1 /*M!100000 + 1 */'), SyntaxError);
  });
});

describe('tokenizeSql: placeholders', () => {
  test('reads a name of letters, digits and underscores that does not start with a digit', () => {
    assert.deepEqual(readPlaceholders('SELECT :a, :userId, :user_id, :_x, :a1'), ['a', 'userId', 'user_id', '_x', 'a1']);
    assert.deepEqual(readPlaceholders('SELECT :1, : a, :'), []);
  });

  test('ends the name at the first other character', () => {
    assert.deepEqual(readPlaceholders('WHERE a=:a,b=:b'), ['a', 'b']);
    assert.deepEqual(readPlaceholders('LIMIT :limit OFFSET :offset'), ['limit', 'offset']);
    assert.deepEqual(readPlaceholders('SELECT :a$b'), ['a']);
  });

  test('reads every occurrence of a repeated name', () => {
    assert.deepEqual(readPlaceholders('WHERE a = :id OR b = :id'), ['id', 'id']);
  });

  test('does not take the assignment operator for a placeholder', () => {
    assert.deepEqual(readPlaceholders('SELECT @total := 5, @a:=:value'), ['value']);
  });

  test('gives a placeholder the depth of the parentheses around it', () => {
    const [outer, inner] = tokenizeSql('WHERE a = :a AND b IN (:ids)').filter((token) => token.type === TOKEN_TYPE.PLACEHOLDER);

    assert.equal(outer.depth, 0);
    assert.equal(inner.depth, 1);
  });
});

describe('tokenizeSql: what is not a keyword', () => {
  test('passes over a number with its letters', () => {
    assert.deepEqual(read('SELECT 0x4D, 1e5, 12.5, 7'), [
      ['word', 'SELECT'],
      ['symbol', ','],
      ['symbol', ','],
      ['symbol', ','],
    ]);
  });

  test('ends a number at its decimal point or exponent: the server reads a keyword right after it', () => {
    assert.deepEqual(readUpper('SELECT 0.5ORDER BY 1'), ['SELECT', 'ORDER', 'BY']);
    assert.deepEqual(readUpper('SELECT 1 FROM t WHERE a>.5LIMIT 1'), ['SELECT', 'FROM', 'T', 'WHERE', 'A', 'LIMIT']);
    assert.deepEqual(readUpper('SELECT 1e5IN (1), 1.5e-3UNION, 5.AND'), ['SELECT', 'IN', 'UNION', 'AND']);
  });

  test('takes a whole number glued to letters for a name: the server reads no keyword there', () => {
    assert.deepEqual(readUpper('SELECT 5ORDER, 1eIN, 0x1FIN, 1a.limit'), ['SELECT']);
  });

  test('passes over a user variable and a system variable with their names', () => {
    assert.deepEqual(read('SELECT @limit, @@session.sql_mode, @`order`'), [
      ['word', 'SELECT'],
      ['symbol', ','],
      ['symbol', ','],
      ['quoted', '`order`'],
    ]);
  });

  test('reads an identifier outside ASCII as one word', () => {
    assert.deepEqual(read('SELECT імя FROM таблиця'), [
      ['word', 'SELECT'],
      ['word', 'імя'],
      ['word', 'FROM'],
      ['word', 'таблиця'],
    ]);
    assert.deepEqual(read('SELECT 😀, x'), [
      ['word', 'SELECT'],
      ['word', '😀'],
      ['symbol', ','],
      ['word', 'x'],
    ]);
  });

  test('leaves a word outside ASCII in its own case: its upper form could spell a keyword', () => {
    assert.deepEqual(readUpper('SELECT lımıt, ſelect'), ['SELECT', 'lımıt', 'ſelect']);
  });

  test('reads a name that starts with a dollar sign as one word', () => {
    assert.deepEqual(readUpper('SELECT $limit FROM t'), ['SELECT', '$LIMIT', 'FROM', 'T']);
  });

  test('reads a name after a dot that starts with a digit, a dollar sign or a letter outside ASCII, and a dollar sign inside a word', () => {
    assert.deepEqual(
      readUpper('SELECT in.1, in.$x, in.é, limit$, in$.x FROM t'),
      ['SELECT', 'IN.1', 'IN.$X', 'in.é', 'LIMIT$', 'IN$.X', 'FROM', 'T'],
    );
  });

  test('reads a name glued to a dot as a name, whatever it spells', () => {
    assert.deepEqual(
      readUpper('SELECT r.id, r.limit FROM rules r WHERE r.group = 1 ORDER BY r.order'),
      ['SELECT', 'R.ID', 'R.LIMIT', 'FROM', 'RULES', 'R', 'WHERE', 'R.GROUP', 'ORDER', 'BY', 'R.ORDER'],
    );
    assert.deepEqual(readUpper('SELECT order.id, db.order.limit FROM `order`'), ['SELECT', 'ORDER.ID', 'DB.ORDER.LIMIT', 'FROM']);
    assert.deepEqual(readUpper('SELECT `r`.limit, r .where FROM r'), ['SELECT', 'R', 'FROM', 'R']);
    assert.deepEqual(readUpper('SELECT `db`.t.5limit, .t.9order FROM t'), ['SELECT', 'FROM', 'T']);
    assert.deepEqual(readUpper('SELECT `t`.5limit'), ['SELECT', 'LIMIT']);
  });

  test('keeps the keyword where the server reads one: a dot before a blank, a quote or a star, a blank before a dot', () => {
    assert.deepEqual(readUpper('SELECT r. limit'), ['SELECT', 'R', 'LIMIT']);
    assert.deepEqual(readUpper('SELECT order.`id`'), ['SELECT', 'ORDER']);
    assert.deepEqual(readUpper('SELECT order.*'), ['SELECT', 'ORDER']);
    assert.deepEqual(readUpper('SELECT order .id'), ['SELECT', 'ORDER']);
  });

  test('keeps the place of a chained name in the statement', () => {
    const sql = 'SELECT u.id FROM users u WHERE u.id IN (:ids)';
    const tokens = tokenizeSql(sql);

    tokens.forEach((token) => assert.equal(sql.slice(token.start, token.end), token.value));
    assert.deepEqual(tokens.map((token) => token.value), ['SELECT', 'u.id', 'FROM', 'users', 'u', 'WHERE', 'u.id', 'IN', '(', ':ids', ')']);
  });
});

describe('tokenizeSql: cost', () => {
  test('answers instantly on a long hostile input', () => {
    const startedAt = performance.now();

    tokenizeSql(`SELECT ${"'a\\\\', ".repeat(50000)}1`);
    tokenizeSql(`SELECT ${'(('.repeat(50000)}1${'))'.repeat(50000)}`);
    tokenizeSql(`SELECT ${':a, '.repeat(50000)}1`);
    tokenizeSql(`SELECT 1 ${'-- x\n'.repeat(50000)}`);
    tokenizeSql(`SELECT ${'a.'.repeat(50000)}a`);
    tokenizeSql(`SELECT ${'$.'.repeat(50000)}`);
    tokenizeSql(`SELECT ${'1.'.repeat(50000)}`);
    tokenizeSql(`SELECT ${'$'.repeat(100000)}`);
    assert.throws(() => tokenizeSql(`SELECT ${'/* '.repeat(50000)}`), SyntaxError);
    assert.throws(() => tokenizeSql(`SELECT '${'\\'.repeat(100001)}`), SyntaxError);

    assert.ok(performance.now() - startedAt < 1000);
  });
});
