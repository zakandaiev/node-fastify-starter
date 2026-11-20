import {
  escapeHtml,
  escapeRegExp,
  formatBytes,
  mask,
  normalizeEmail,
  normalizePhone,
  stripHtml,
  truncate,
} from '#utils/string.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const HOSTILE_REPEATS = 100000;
const TIME_LIMIT_MS = 1000;

const GRIN = '\u{1F600}';
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
const FLAG = '\u{1F1FA}\u{1F1E6}';
const TONED_THUMB = '\u{1F44D}\u{1F3FD}';
const KEYCAP = '1\u{FE0F}\u{20E3}';
const E_ACUTE_DECOMPOSED = 'e\u{301}';

const REGEXP_SYNTAX_CHARACTERS = Object.freeze(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);

const LITERAL_PATTERNS = Object.freeze([
  ['a.b', 'axb'],
  ['(x)', 'x'],
  ['[a-z]+', 'abc'],
  ['^start$', 'start'],
  ['a|b', 'a'],
  ['x{1,2}', 'xx'],
  ['a+', 'aa'],
  ['colou?r', 'color'],
  ['C:\\path\\file.txt', 'C:\\path\\fileXtxt'],
  ['https://example.com/a?b=1', 'https://example.com/b=1'],
  ['user-name_1', 'user-name_2'],
  [`Привіт.${GRIN}`, `Привіт!${GRIN}`],
  [REGEXP_SYNTAX_CHARACTERS.join(''), ''],
]);

const EMAIL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    @media (max-width: 600px) { .card > td { padding: 16px !important; } }
  </style>
</head>
<body>
  <!--[if mso]><table role="presentation"><tr><td><![endif]-->
  <table class="card">
    <tr>
      <td>
        <h1>Confirm your email</h1>
        <p>Hello, <b>Anna</b>!</p>
        <p>Your code:&nbsp;<strong>123456</strong>.<br>It expires in 10&nbsp;minutes.</p>
        <p><a href="https://example.com/verify?a=1&amp;b=2" title="Open &gt; confirm">Confirm</a></p>
      </td>
    </tr>
  </table>
  <!--[if mso]></td></tr></table><![endif]-->
  <p class="footer">This is an automatic email, please do not reply.</p>
</body>
</html>`;

const HOSTILE_HTML = [
  ['an unclosed "<script" repeated', '<script'.repeat(HOSTILE_REPEATS), ''],
  ['an opening "<script>" repeated', '<script>'.repeat(HOSTILE_REPEATS), ''],
  ['a script with closing tags that never end', `<script>${'</script '.repeat(HOSTILE_REPEATS)}`, ''],
  ['a script with almost closing tags', `<script>${'</scrip'.repeat(HOSTILE_REPEATS)}`, ''],
  ['a style with almost closing tags', `<style>${'</styl'.repeat(HOSTILE_REPEATS)}`, ''],
  ['a lone "<" repeated', '<'.repeat(HOSTILE_REPEATS), '<'.repeat(HOSTILE_REPEATS)],
  ['"<<<<" repeated', '<<<<'.repeat(HOSTILE_REPEATS), '<<<<'.repeat(HOSTILE_REPEATS)],
  ['an unclosed comment', `<!--${'x'.repeat(HOSTILE_REPEATS)}`, ''],
  ['an opening "<!--" repeated', '<!--'.repeat(HOSTILE_REPEATS), ''],
  ['an unclosed tag repeated', '<a '.repeat(HOSTILE_REPEATS), ''],
  ['an unclosed attribute quote repeated', '<a title="'.repeat(HOSTILE_REPEATS), ''],
  ['an unclosed end tag repeated', '</'.repeat(HOSTILE_REPEATS), ''],
  ['a tag with a huge number of attributes', `<a ${'a=">" '.repeat(HOSTILE_REPEATS)}>text`, 'text'],
  ['a huge number of tags', '<p>a</p>'.repeat(HOSTILE_REPEATS), Array(HOSTILE_REPEATS).fill('a').join(' ')],
  ['deeply nested tags', `${'<div>'.repeat(HOSTILE_REPEATS)}text${'</div>'.repeat(HOSTILE_REPEATS)}`, 'text'],
  ['an unfinished entity repeated', '&amp'.repeat(HOSTILE_REPEATS), '&amp'.repeat(HOSTILE_REPEATS)],
  ['whitespace only', ' \n'.repeat(HOSTILE_REPEATS), ''],
];

function measure(fn) {
  const startedAt = performance.now();
  const result = fn();

  return { result, elapsedMs: performance.now() - startedAt };
}

describe('escapeHtml', () => {
  test('replaces the five characters that are markup in text and in a quoted attribute value', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
    assert.equal(
      escapeHtml('<a href="/?a=1&b=2">Tom & Jerry\'s</a>'),
      '&lt;a href=&quot;/?a=1&amp;b=2&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
    );
  });

  test('leaves no markup character in the result, so it cannot open a tag or close an attribute', () => {
    const escaped = escapeHtml('"><script>alert(\'x\')</script><img src=x onerror="y">');

    assert.doesNotMatch(escaped, /[<>"']/);
    assert.match(escaped, /^(?:[^&]|&(?:amp|lt|gt|quot|#39);)*$/);
  });

  test('escapes an ampersand that already starts an entity: escaping twice shows the entity as text', () => {
    assert.equal(escapeHtml('&amp;'), '&amp;amp;');
    assert.equal(escapeHtml(escapeHtml('<')), '&amp;lt;');
  });

  test('leaves every other character as is', () => {
    const text = 'Привіт, 世界! 😀 `a=b` /path\\ \n\t {x} [y] (z) #$%*+,-.:;?@^_|~';

    assert.equal(escapeHtml(text), text);
    assert.equal(escapeHtml(''), '');
  });

  test('turns null and undefined into an empty string and converts other values', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
    assert.equal(escapeHtml(false), 'false');
    assert.equal(escapeHtml(['<b>']), '[&quot;&lt;b&gt;&quot;]');
    assert.equal(escapeHtml({ name: "O'Neil" }), '{&quot;name&quot;:&quot;O&#39;Neil&quot;}');
  });

  test('escapes a huge hostile string in linear time', () => {
    const { result, elapsedMs } = measure(() => escapeHtml('<&>"\''.repeat(HOSTILE_REPEATS * 2)));

    assert.equal(result, '&lt;&amp;&gt;&quot;&#39;'.repeat(HOSTILE_REPEATS * 2));
    assert.ok(elapsedMs < TIME_LIMIT_MS, `took ${elapsedMs} ms`);
  });
});

describe('escapeRegExp', () => {
  test('escapes every syntax character of a regular expression with a backslash', () => {
    REGEXP_SYNTAX_CHARACTERS.forEach((char) => {
      assert.equal(escapeRegExp(char), `\\${char}`, char);
    });

    assert.equal(escapeRegExp(REGEXP_SYNTAX_CHARACTERS.join('')), REGEXP_SYNTAX_CHARACTERS.map((char) => `\\${char}`).join(''));
  });

  test('gives a pattern that, compiled with the "u" flag, matches its input literally and nothing else', () => {
    LITERAL_PATTERNS.forEach(([input, nearMiss]) => {
      const pattern = new RegExp(`^${escapeRegExp(input)}$`, 'u');

      assert.equal(pattern.test(input), true, input);
      assert.equal(pattern.test(nearMiss), false, nearMiss);
    });
  });

  test('leaves letters, digits and every other character readable, a leading letter or digit included', () => {
    const text = `Hello World 123 Привіт 世界 ${GRIN} -_,:;=!#@%&~\`'"<>`;

    assert.equal(escapeRegExp(text), text);
    assert.equal(escapeRegExp('abc'), 'abc');
    assert.equal(escapeRegExp('1st'), '1st');
    assert.equal(escapeRegExp(''), '');
    assert.equal(escapeRegExp('a.b'), 'a\\.b');
  });

  test('turns null and undefined into an empty string and converts other values', () => {
    assert.equal(escapeRegExp(null), '');
    assert.equal(escapeRegExp(undefined), '');
    assert.equal(escapeRegExp(1.5), '1\\.5');
    assert.equal(escapeRegExp(['a.b']), '\\["a\\.b"\\]');
  });

  test('escapes a huge hostile string in linear time', () => {
    const { result, elapsedMs } = measure(() => escapeRegExp('.*+?'.repeat(HOSTILE_REPEATS)));

    assert.equal(result, '\\.\\*\\+\\?'.repeat(HOSTILE_REPEATS));
    assert.ok(elapsedMs < TIME_LIMIT_MS, `took ${elapsedMs} ms`);
  });
});

describe('stripHtml', () => {
  test('drops tags and keeps their text', () => {
    assert.equal(stripHtml('<p>Hello <b>world</b>!</p>'), 'Hello world!');
    assert.equal(stripHtml('<DIV CLASS="x"><IMG SRC="a.png"/>Text</DIV>'), 'Text');
    assert.equal(stripHtml('<p\n  class="lead"\n>multi\nline</p\n>'), 'multi line');
    assert.equal(stripHtml('plain text'), 'plain text');
    assert.equal(stripHtml(''), '');
  });

  test('leaves a space where a block ended, so the words of neighbouring blocks do not merge', () => {
    assert.equal(stripHtml('<p>one</p><p>two</p>'), 'one two');
    assert.equal(stripHtml('line one<br>line two<br/>line three'), 'line one line two line three');
    assert.equal(stripHtml('<ul><li>one</li><li>two</li></ul>'), 'one two');
    assert.equal(stripHtml('<tr><td>a</td><td>b</td></tr>'), 'a b');
    assert.equal(stripHtml('<h1>Title</h1>Text<my-card>custom</my-card>'), 'Title Text custom');
  });

  test('joins the text around an inline tag, so a word and its punctuation stay together', () => {
    assert.equal(stripHtml('<b>Hello</b>, <a href="/world">world</a>.'), 'Hello, world.');
    assert.equal(stripHtml('H<sub>2</sub>O'), 'H2O');
    assert.equal(stripHtml('<span>un</span><EM>break</EM>able'), 'unbreakable');
    assert.equal(stripHtml('super<wbr/>cali<wbr>fragilistic'), 'supercalifragilistic');
    assert.equal(stripHtml('<i>one</i> <i>two</i>'), 'one two');
  });

  test('drops script and style blocks together with their content', () => {
    assert.equal(stripHtml('before<script>if (a < b) { html = "</div>"; }</script>after'), 'before after');
    assert.equal(stripHtml('<style>p > a { color: red; }</style>text'), 'text');
    assert.equal(stripHtml('<SCRIPT type="text/javascript">alert(1)</SCRIPT >text'), 'text');
    assert.equal(stripHtml('<style media="screen">a{}</STYLE\n>text'), 'text');
    assert.equal(stripHtml('<script data-end="</script>">alert(1)</script>text'), 'text');
    assert.equal(stripHtml('<script src="a.js"/>alert(1)</script>text'), 'text');
  });

  test('ends a script or a style only at its own closing tag', () => {
    assert.equal(stripHtml('<script>a</scriptx>b</style>c</script>text'), 'text');
    assert.equal(stripHtml('<style>a</script>b</ style>c</style>text'), 'text');
  });

  test('takes a closing tag without its opening one for a tag, not for the start of a block', () => {
    assert.equal(stripHtml('one</script>two</style>three'), 'one two three');
  });

  test('reads a tag name to its end: a custom element is not the tag its name starts with', () => {
    assert.equal(stripHtml('<script-loader>text</script-loader>'), 'text');
    assert.equal(stripHtml('one<b-card>two</b-card>three'), 'one two three');
  });

  test('drops comments, conditional ones included', () => {
    assert.equal(stripHtml('one<!-- <b>two</b> > three -->four'), 'onefour');
    assert.equal(stripHtml('<!--[if mso]><table><tr><td>mso</td></tr></table><![endif]-->text'), 'text');
    assert.equal(stripHtml('<!--[if !mso]><!-->text<!--<![endif]-->'), 'text');
    assert.equal(stripHtml('<!---->one<!-->two<!--->three'), 'onetwothree');
  });

  test('drops a doctype, a processing instruction and an empty end tag', () => {
    assert.equal(stripHtml('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><?xml version="1.0"?>text</>'), 'text');
  });

  test('reads ">" inside a quoted attribute value as a part of the value', () => {
    assert.equal(stripHtml('<a title="1 > 0">link</a>'), 'link');
    assert.equal(stripHtml("<a title='1 > 0' href=/x>link</a>"), 'link');
    assert.equal(stripHtml('<a title = "Settings -> Profile">link</a>'), 'link');
    assert.equal(stripHtml('<img alt="a > b" src="a.png">text'), 'text');
    assert.equal(stripHtml('<a title="it\'s > that">link</a>'), 'link');
  });

  test('takes a quote for the start of a value only after "="', () => {
    assert.equal(stripHtml('<a href=/x title=don\'t>link</a> and it\'s fine'), "link and it's fine");
    assert.equal(stripHtml('<p class="a"">one "two" three</p>'), 'one "two" three');
  });

  test('keeps "<" that does not open a tag', () => {
    assert.equal(stripHtml('a < b and c > d'), 'a < b and c > d');
    assert.equal(stripHtml('I <3 you'), 'I <3 you');
    assert.equal(stripHtml('1<2, x <= y, <<'), '1<2, x <= y, <<');
    assert.equal(stripHtml('<\u{17F}cript>'), '<\u{17F}cript>');
  });

  test('drops whatever follows an unclosed tag, comment or script, as a browser does', () => {
    assert.equal(stripHtml('text <b'), 'text');
    assert.equal(stripHtml('text<!-- never closed <p>more</p>'), 'text');
    assert.equal(stripHtml('text<script>alert(1)'), 'text');
    assert.equal(stripHtml('text<style>a{}</style'), 'text');
    assert.equal(stripHtml('text<a title="never closed>more</a> more'), 'text');
  });

  test('decodes the entities of escapeHtml and a no-break space', () => {
    assert.equal(stripHtml('5 &gt; 3 &amp;&amp; 1 &lt; 2'), '5 > 3 && 1 < 2');
    assert.equal(stripHtml('&quot;quoted&quot; &#39;single&#39;'), '"quoted" \'single\'');
    assert.equal(stripHtml('10&nbsp;minutes'), '10 minutes');
  });

  test('decodes an entity once', () => {
    assert.equal(stripHtml('&amp;lt;'), '&lt;');
    assert.equal(stripHtml('&amp;amp;'), '&amp;');
    assert.equal(stripHtml('&amp;nbsp;'), '&nbsp;');
  });

  test('leaves any other entity, an unfinished one and one in another case as text', () => {
    const text = '&copy; &mdash; &#169; &#x27; &#039; &amp &AMP; &';

    assert.equal(stripHtml(text), text);
  });

  test('does not build an entity out of pieces that a tag separated', () => {
    assert.equal(stripHtml('&am<b></b>p;'), '&amp;');
  });

  test('restores what escapeHtml escaped', () => {
    const text = '<a href="/?a=1&b=2">Tom & Jerry\'s</a>';

    assert.equal(stripHtml(escapeHtml(text)), text);
  });

  test('collapses runs of whitespace, no-break spaces included, and trims', () => {
    assert.equal(stripHtml('  one \n\n\t two &nbsp;&nbsp; three\u{A0}\u{A0}four  '), 'one two three four');
    assert.equal(stripHtml('<p>  </p>\n<p>\t</p>'), '');
  });

  test('is not a sanitizer: an escaped tag comes back as a tag and has to be escaped again before it goes into HTML', () => {
    const text = stripHtml('<p>&lt;img src=x onerror=alert(1)&gt;</p>');

    assert.equal(text, '<img src=x onerror=alert(1)>');
    assert.equal(escapeHtml(text), '&lt;img src=x onerror=alert(1)&gt;');
  });

  test('is not a sanitizer: the text around a dropped tag can form a tag', () => {
    assert.equal(stripHtml('<<b>script>alert(1)<</b>/script>'), '<script>alert(1)</script>');
  });

  test('turns the HTML of an email into its text alternative', () => {
    assert.equal(
      stripHtml(EMAIL_HTML),
      'Confirm your email Hello, Anna! Your code: 123456. It expires in 10 minutes. Confirm This is an automatic email, please do not reply.',
    );
  });

  test('turns null and undefined into an empty string and converts other values', () => {
    assert.equal(stripHtml(null), '');
    assert.equal(stripHtml(undefined), '');
    assert.equal(stripHtml(5), '5');
    assert.equal(stripHtml(['<b>bold</b>']), '["bold"]');
  });

  HOSTILE_HTML.forEach(([title, html, expected]) => {
    test(`reads ${title} in linear time`, () => {
      const { result, elapsedMs } = measure(() => stripHtml(html));

      assert.equal(result, expected);
      assert.ok(elapsedMs < TIME_LIMIT_MS, `took ${elapsedMs} ms`);
    });
  });
});

describe('truncate', () => {
  test('returns a value within the limit as is', () => {
    assert.equal(truncate('Hello', 5), 'Hello');
    assert.equal(truncate('Hello', 100), 'Hello');
    assert.equal(truncate('Hello  ', 7), 'Hello  ');
    assert.equal(truncate(GRIN.repeat(2), 4), GRIN.repeat(2));
    assert.equal(truncate('', 0), '');
  });

  test('cuts a longer value so that the result, suffix included, fits the limit', () => {
    assert.equal(truncate('Hello world', 8), 'Hello w…');
    assert.equal(truncate('Hello world', 10), 'Hello wor…');
    assert.equal(truncate('Hello world', 2), 'H…');
  });

  test('drops trailing whitespace before the suffix and keeps the leading one', () => {
    assert.equal(truncate('Hello world', 7), 'Hello…');
    assert.equal(truncate('Hello \n\t world', 9), 'Hello…');
    assert.equal(truncate('  Hello world', 9), '  Hello…');
    assert.equal(truncate('   world', 3), '…');
  });

  test('takes another suffix, an empty one included', () => {
    assert.equal(truncate('Hello world', 8, '...'), 'Hello...');
    assert.equal(truncate('Hello world', 9, ' [more]'), 'He [more]');
    assert.equal(truncate('Hello world', 5, ''), 'Hello');
  });

  test('returns the suffix alone when nothing else fits', () => {
    assert.equal(truncate('Hello world', 1), '…');
    assert.equal(truncate('Hello world', 3, '...'), '...');
  });

  test('cuts the value without the suffix when the suffix alone is longer than the limit', () => {
    assert.equal(truncate('Hello world', 2, '...'), 'He');
    assert.equal(truncate('Hello world', 6, ' [more]'), 'Hello');
    assert.equal(truncate('Hello world', 0), '');
    assert.equal(truncate(GRIN.repeat(2), 1, '...'), '');
  });

  test('counts the limit in UTF-16 code units, so the result also fits a limit counted in code points', () => {
    const result = truncate(GRIN.repeat(4), 5);

    assert.equal(result, `${GRIN.repeat(2)}…`);
    assert.equal(result.length, 5);
    assert.equal(Array.from(result).length, 3);
  });

  test('never cuts a surrogate pair in half', () => {
    assert.equal(truncate(GRIN.repeat(4), 4), `${GRIN}…`);
    assert.equal(truncate(`a${GRIN}bc`, 3), 'a…');
    assert.equal(truncate(`a${GRIN}bc`, 4), `a${GRIN}…`);
  });

  test('never cuts an emoji sequence apart: a family, a flag, a skin tone and a keycap stay whole or go whole', () => {
    assert.deepEqual([FAMILY.length, FLAG.length, TONED_THUMB.length, KEYCAP.length], [8, 4, 4, 3]);

    assert.equal(truncate(`ab${FAMILY}cd`, 10), 'ab…');
    assert.equal(truncate(`ab${FAMILY}cd`, 11), `ab${FAMILY}…`);
    assert.equal(truncate(FLAG.repeat(3), 8), `${FLAG}…`);
    assert.equal(truncate(FLAG.repeat(3), 9), `${FLAG.repeat(2)}…`);
    assert.equal(truncate(TONED_THUMB.repeat(2), 4), '…');
    assert.equal(truncate(TONED_THUMB.repeat(2), 5), `${TONED_THUMB}…`);
    assert.equal(truncate(KEYCAP.repeat(3), 6), `${KEYCAP}…`);
    assert.equal(truncate(KEYCAP.repeat(3), 7), `${KEYCAP.repeat(2)}…`);
  });

  test('keeps a letter together with its combining marks', () => {
    assert.equal(truncate(E_ACUTE_DECOMPOSED.repeat(3), 4), `${E_ACUTE_DECOMPOSED}…`);
    assert.equal(truncate(E_ACUTE_DECOMPOSED.repeat(3), 5), `${E_ACUTE_DECOMPOSED.repeat(2)}…`);
  });

  test('cuts only between graphemes and stays well formed, whatever the limit', () => {
    const text = `Hi ${FAMILY} and ${FLAG}${FLAG}, ${TONED_THUMB}! ${E_ACUTE_DECOMPOSED} ${KEYCAP} ${GRIN}${GRIN} end\r\nok`;
    const segments = new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text);
    const boundaries = new Set(Array.from(segments, ({ index }) => index));

    Array.from({ length: text.length }, (unused, maxLength) => maxLength).forEach((maxLength) => {
      const result = truncate(text, maxLength);
      const head = result.replace(/…$/, '');

      assert.ok(result.isWellFormed(), `truncate(text, ${maxLength}) is well formed`);
      assert.ok(result.length <= maxLength, `truncate(text, ${maxLength}) fits the limit`);
      assert.ok(text.startsWith(head), `truncate(text, ${maxLength}) starts the value`);
      assert.ok(boundaries.has(head.length), `truncate(text, ${maxLength}) ends between graphemes`);
      assert.equal(result.endsWith('…'), maxLength > 0, `truncate(text, ${maxLength}) ends with the suffix`);
    });

    assert.equal(truncate(text, text.length), text);
  });

  test('replaces a lone surrogate, so the result is well formed whatever the value', () => {
    assert.equal(truncate('ab\u{D83D}', 5), 'ab\u{FFFD}');
    assert.equal(truncate('\u{DE00}abcdef', 3), '\u{FFFD}a…');
    assert.equal(truncate('a\u{D83D}bcdef', 3), 'a\u{FFFD}…');
  });

  test('reads a value through toString', () => {
    assert.equal(truncate(1234567, 4), '123…');
    assert.equal(truncate(null, 3), '');
    assert.equal(truncate(undefined, 3), '');
  });

  test('cuts a huge value without reading it whole', () => {
    const text = `a${'\u{301}'.repeat(HOSTILE_REPEATS * 10)}`;
    const { result, elapsedMs } = measure(() => Array.from({ length: 2000 }, () => truncate(text, 100)));

    assert.equal(result[0], '…');
    assert.ok(elapsedMs < TIME_LIMIT_MS, `took ${elapsedMs} ms`);
  });

  test('rejects a limit that is not a non-negative integer', () => {
    [-1, 1.5, Number.NaN, Infinity, 2 ** 53, '5', null, undefined].forEach((maxLength) => {
      assert.throws(() => truncate('Hello', maxLength), { name: 'RangeError', message: /^truncate\(/ });
    });
  });

  test('rejects a suffix that is not a string', () => {
    [null, 3, {}, ['…']].forEach((suffix) => {
      assert.throws(() => truncate('Hello', 3, suffix), { name: 'TypeError', message: /^truncate\(/ });
    });
  });
});

describe('mask', () => {
  test('keeps the first and the last character and hides the middle', () => {
    assert.equal(mask('secret'), 's****t');
    assert.equal(mask('anna@example.com'), 'a**************m');
    assert.equal(mask('380671234567'), '3**********7');
    assert.equal(mask('019a2b3c-4d5e-7f60-8a1b-2c3d4e5f6071'), '0**********************************1');
  });

  test('keeps as many characters at each end as asked', () => {
    assert.equal(mask('380671234567', { start: 3, end: 2 }), '380*******67');
    assert.equal(mask('secret', { start: 2 }), 'se***t');
    assert.equal(mask('secret', { end: 3 }), 's**ret');
  });

  test('hides a whole end when asked to keep nothing of it', () => {
    assert.equal(mask('secret', { start: 0 }), '*****t');
    assert.equal(mask('secret', { end: 0 }), 's*****');
    assert.equal(mask('secret', { start: 3, end: 0 }), 'sec***');
    assert.equal(mask('secret', { start: 0, end: 0 }), '******');
  });

  test('hides with another character', () => {
    assert.equal(mask('secret', { char: '•' }), 's••••t');
    assert.equal(mask('secret', { char: GRIN }), `s${GRIN.repeat(4)}t`);
  });

  test('masks a short value entirely when the kept ends would leave nothing hidden', () => {
    assert.equal(mask('a'), '*');
    assert.equal(mask('ab'), '**');
    assert.equal(mask('abc'), 'a*c');
    assert.equal(mask('abcd', { start: 2, end: 2 }), '****');
    assert.equal(mask('abcde', { start: 2, end: 2 }), 'ab*de');
    assert.equal(mask('abc', { start: 5, end: 5 }), '***');
    assert.equal(mask('secret', { start: 6, end: 0 }), '******');
  });

  test('returns an empty string for an empty value', () => {
    assert.equal(mask(''), '');
    assert.equal(mask(null), '');
    assert.equal(mask(undefined), '');
    assert.equal(mask('', { start: 0, end: 0 }), '');
  });

  test('counts characters in code points, so an emoji is never split', () => {
    assert.equal(mask(GRIN.repeat(4)), `${GRIN}**${GRIN}`);
    assert.equal(mask(`${GRIN}a`), '**');
    assert.equal(mask(`a${GRIN}${GRIN}b`, { start: 2, end: 0 }), `a${GRIN}**`);
    assert.ok(mask(`${GRIN}secret${GRIN}`).isWellFormed());
  });

  test('reads a value through toString', () => {
    assert.equal(mask(1234567), '1*****7');
  });

  test('rejects a start or an end that is not a non-negative integer', () => {
    [-1, 1.5, Number.NaN, Infinity, '1', null].forEach((count) => {
      assert.throws(() => mask('secret', { start: count }), { name: 'RangeError', message: /^mask\(/ });
      assert.throws(() => mask('secret', { end: count }), { name: 'RangeError', message: /^mask\(/ });
    });
  });

  test('rejects a char that is not exactly one character', () => {
    ['', '**', '\u{2764}\u{FE0F}', 5, null].forEach((char) => {
      assert.throws(() => mask('secret', { char }), { name: 'TypeError', message: /^mask\(/ });
    });
  });

  test('rejects options that are not a plain object', () => {
    [null, 2, 'ab', [1, 1], new Map()].forEach((options) => {
      assert.throws(() => mask('secret', options), { name: 'TypeError', message: /^mask\(/ });
    });
  });
});

describe('formatBytes', () => {
  test('formats a size in 1024-based units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1), '1 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5242880), '5 MB');
    assert.equal(formatBytes(1024 ** 3), '1 GB');
    assert.equal(formatBytes(1024 ** 4), '1 TB');
  });

  test('counts everything above the largest unit in that unit', () => {
    assert.equal(formatBytes(1024 ** 5), '1024 TB');
    assert.equal(formatBytes(Number.MAX_SAFE_INTEGER), '8192 TB');
  });

  test('rounds to one decimal by default and to the given number of decimals', () => {
    assert.equal(formatBytes(1234567), '1.2 MB');
    assert.equal(formatBytes(1234567, 0), '1 MB');
    assert.equal(formatBytes(1234567, 2), '1.18 MB');
    assert.equal(formatBytes(1234567, 3), '1.177 MB');
    assert.equal(formatBytes(1536, 0), '2 KB');
  });

  test('prints no trailing zeros', () => {
    assert.equal(formatBytes(1536, 3), '1.5 KB');
    assert.equal(formatBytes(2048, 2), '2 KB');
    assert.equal(formatBytes(100, 2), '100 B');
    assert.equal(formatBytes(1536, 100), '1.5 KB');
  });

  test('moves to the next unit when rounding reaches 1024', () => {
    assert.equal(formatBytes(1024 ** 2 - 1), '1 MB');
    assert.equal(formatBytes(1024 ** 3 - 1), '1 GB');
    assert.equal(formatBytes(1023.99), '1 KB');
  });

  test('accepts a numeric string and a fractional size', () => {
    assert.equal(formatBytes('0'), '0 B');
    assert.equal(formatBytes('1536'), '1.5 KB');
    assert.equal(formatBytes(0.5), '0.5 B');
    assert.equal(formatBytes(-0), '0 B');
  });

  test('returns null for a negative, non-finite or non-numeric value', () => {
    [-1, '-1', Number.NaN, Infinity, -Infinity, '', ' 5', '1e3', '1,5', 'abc', null, undefined, true, 10n, [], {}].forEach((bytes) => {
      assert.equal(formatBytes(bytes), null, `formatBytes(${String(bytes)})`);
    });
  });

  test('rejects decimals that are not an integer from 0 to 100', () => {
    [-1, 1.5, 101, Number.NaN, Infinity, '1', null].forEach((decimals) => {
      assert.throws(() => formatBytes(1536, decimals), { name: 'RangeError', message: /^formatBytes\(/ });
    });
  });
});

describe('normalizeEmail', () => {
  test('trims and lower-cases an address', () => {
    assert.equal(normalizeEmail('  Anna@Example.COM '), 'anna@example.com');
    assert.equal(normalizeEmail('\tanna@example.com\n'), 'anna@example.com');
    assert.equal(normalizeEmail('anna@example.com'), 'anna@example.com');
  });

  test('returns an empty string for an empty value', () => {
    assert.equal(normalizeEmail(''), '');
    assert.equal(normalizeEmail('   '), '');
    assert.equal(normalizeEmail(null), '');
    assert.equal(normalizeEmail(undefined), '');
  });

  test('keeps dots, plus-tags and accents: they make a different address', () => {
    assert.equal(normalizeEmail('First.Last+Tag@Gmail.com'), 'first.last+tag@gmail.com');
    assert.notEqual(normalizeEmail('josé@example.com'), normalizeEmail('jose@example.com'));
    assert.notEqual(normalizeEmail('straße@example.com'), normalizeEmail('strasse@example.com'));
  });

  test('makes the precomposed and the decomposed spelling of an address equal', () => {
    assert.equal(normalizeEmail('jos\u{E9}@example.com'), 'jos\u{E9}@example.com');
    assert.equal(normalizeEmail('jose\u{301}@example.com'), 'jos\u{E9}@example.com');
    assert.equal(normalizeEmail('JOSE\u{301}@EXAMPLE.COM'), 'jos\u{E9}@example.com');
  });

  test('merges canonical equivalents only: a full-width letter and a ligature stay what they are', () => {
    assert.equal(normalizeEmail('\u{FF21}nna@example.com'), '\u{FF41}nna@example.com');
    assert.equal(normalizeEmail('\u{FB01}x@example.com'), '\u{FB01}x@example.com');
  });

  test('lower-cases without a locale: a Turkish dotted İ and a plain I give the same result everywhere', () => {
    assert.equal(normalizeEmail('I@EXAMPLE.COM'), 'i@example.com');
    assert.equal(normalizeEmail('\u{130}STANBUL@example.com'), 'i\u{307}stanbul@example.com');
    assert.equal(normalizeEmail('I\u{307}STANBUL@example.com'), 'i\u{307}stanbul@example.com');
    assert.equal(normalizeEmail('\u{131}@example.com'), '\u{131}@example.com');
  });

  test('gives a result in NFC that normalizes to itself', () => {
    ['\u{130}\u{325}@example.com', 'i\u{325}\u{307}@example.com', 'JOSE\u{301}@example.com', '\u{1E9E}\u{3A3}@example.com'].forEach((email) => {
      const normalized = normalizeEmail(email);

      assert.equal(normalized, normalized.normalize('NFC'), `normalizeEmail(${JSON.stringify(email)}) is in NFC`);
      assert.equal(normalizeEmail(normalized), normalized, `normalizeEmail(${JSON.stringify(email)}) is stable`);
    });

    assert.equal(normalizeEmail('\u{130}\u{325}@example.com'), normalizeEmail('i\u{325}\u{307}@example.com'));
  });

  test('does not validate: whatever is not an address is normalized the same way', () => {
    assert.equal(normalizeEmail('Not An Email'), 'not an email');
    assert.equal(normalizeEmail(5), '5');
  });

  test('normalizes a value of 320 characters, the ceiling: a local part of 64, "@" and a domain of 255', () => {
    const email = `${'A'.repeat(308)}@example.com`;

    assert.equal(email.length, 320);
    assert.equal(normalizeEmail(` ${email} `), email.toLowerCase());
  });

  test('returns an empty string for a longer value without normalizing it: NFC of a hostile string is quadratic', () => {
    const hostile = `a${'\u{301}'.repeat(HOSTILE_REPEATS / 2)}${'\u{323}'.repeat(HOSTILE_REPEATS / 2)}@example.com`;
    const { result, elapsedMs } = measure(() => normalizeEmail(hostile));

    assert.equal(result, '');
    assert.equal(normalizeEmail(`${'a'.repeat(309)}@example.com`), '');
    assert.ok(elapsedMs < TIME_LIMIT_MS, `took ${elapsedMs} ms`);
  });
});

describe('normalizePhone', () => {
  test('returns the digits of a phone in the formats people type', () => {
    assert.equal(normalizePhone('+380 (67) 123-45-67'), '380671234567');
    assert.equal(normalizePhone('+1 (555) 123-4567'), '15551234567');
    assert.equal(normalizePhone('(+44) 20 7946 0958'), '442079460958');
    assert.equal(normalizePhone('067 123 45 67'), '0671234567');
    assert.equal(normalizePhone('555.123.4567'), '5551234567');
    assert.equal(normalizePhone('00380671234567'), '00380671234567');
    assert.equal(normalizePhone('380671234567'), '380671234567');
  });

  test('drops any whitespace around and inside: a number is often pasted from a formatted page', () => {
    assert.equal(normalizePhone('  +380 67 123 45 67\n'), '380671234567');
    assert.equal(normalizePhone('+380\u{A0}67\u{202F}123\t45 67'), '380671234567');
  });

  test('accepts 7 to 15 digits', () => {
    assert.equal(normalizePhone('123456'), null);
    assert.equal(normalizePhone('1234567'), '1234567');
    assert.equal(normalizePhone('123456789012345'), '123456789012345');
    assert.equal(normalizePhone('1234567890123456'), null);
    assert.equal(normalizePhone('+1 2 3 4 5 6 7 8 9 0 1 2 3 4 5'), '123456789012345');
  });

  test('returns null when a letter or any other character is left', () => {
    [
      '+380 67 123 45 67 ext 5',
      '380-67-CALL-NOW',
      '0671234567#',
      '067/123-45-67',
      '380671234567n',
      '+380\u{2013}67\u{2013}123\u{2013}45\u{2013}67',
      '\u{661}\u{662}\u{663}\u{664}\u{665}\u{666}\u{667}',
      '\u{FF10}\u{FF16}\u{FF17}\u{FF11}\u{FF12}\u{FF13}\u{FF14}\u{FF15}\u{FF16}\u{FF17}',
      '0x1234567',
      '1234567e2',
    ].forEach((phone) => {
      assert.equal(normalizePhone(phone), null, `normalizePhone(${JSON.stringify(phone)})`);
    });
  });

  test('returns null for an empty value and for separators alone', () => {
    ['', '   ', '+', '()-', '+ (  ) - .', null, undefined].forEach((phone) => {
      assert.equal(normalizePhone(phone), null);
    });
  });

  test('reads a value through toString', () => {
    assert.equal(normalizePhone(380671234567), '380671234567');
    assert.equal(normalizePhone(true), null);
    assert.equal(normalizePhone(['380671234567']), null);
  });

  test('rejects a raw value longer than 32 characters, even when the rest of it is separators', () => {
    const phone = '+380 67 123 45 67';

    assert.equal(normalizePhone(phone.padEnd(32)), '380671234567');
    assert.equal(normalizePhone(phone.padEnd(33)), null);
    assert.equal(normalizePhone(`${'-'.repeat(HOSTILE_REPEATS)}1234567`), null);
  });
});
