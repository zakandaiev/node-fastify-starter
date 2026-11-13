import {
  isValidPersonName,
  normalizePersonName,
  PERSON_NAME_MAX_LENGTH,
  toValidPersonName,
} from '#utils/person.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const INSTANT_MS = 1000;
const RAW_MAX_LENGTH = 256;
const HOSTILE_LENGTH = 100000;

const ACUTE = '\u{0301}';
const CIRCUMFLEX = '\u{0302}';
const TILDE = '\u{0303}';
const BREVE = '\u{0306}';
const DIAERESIS = '\u{0308}';
const DOT_BELOW = '\u{0323}';
const DAKUTEN = '\u{3099}';
const RIGHT_QUOTE = '\u{2019}';
const MODIFIER_APOSTROPHE = '\u{02BC}';
const OKINA = '\u{02BB}';
const GERESH = '\u{05F3}';
const EMOJI_SELECTOR = '\u{FE0F}';
const TEXT_SELECTOR = '\u{FE0E}';
const HANGUL_FILLER = '\u{3164}';
const ZERO_WIDTH_SPACE = '\u{200B}';
const ZERO_WIDTH_NON_JOINER = '\u{200C}';
const ZERO_WIDTH_JOINER = '\u{200D}';
const RIGHT_TO_LEFT_OVERRIDE = '\u{202E}';
const NO_BREAK_SPACE = '\u{00A0}';
const IDEOGRAPHIC_SPACE = '\u{3000}';

const COMPATIBILITY_IDEOGRAPH = '\u{FA1B}';
const HEBREW_NAME = '\u{05D3}\u{05D5}\u{05D3}';
const FAMILY_EMOJI = `\u{1F469}${ZERO_WIDTH_JOINER}\u{1F467}`;
const UNORDERED_MARKS = `${ACUTE}${DOT_BELOW}`;

const NAMES = ["Мар'яна", 'Анна-Марія', 'Müller', 'Kovács', "O'Connor", 'Ανδρέας', '山田'];

const NAMES_BY_SCRIPT = Object.freeze({
  Arabic: '\u{0645}\u{062D}\u{0645}\u{062F}',
  Hebrew: HEBREW_NAME,
  Devanagari: 'प्रिया',
  Thai: 'สมชาย',
  Hangul: '지민',
  Georgian: 'ნინო',
  Armenian: 'Հայկ',
  Vietnamese: 'Nguyễn',
  Hiragana: 'さくら',
  Ethiopic: 'አበበ',
  Hawaiian: `${OKINA}Iolani`,
});

const REWRITTEN_BY_NFKC = Object.freeze({
  Thai: 'น้ำทิพย์',
  Lao: 'ໜູ',
  Armenian: 'Լևոն',
});

const NOT_FONT_LETTERS = Object.freeze({
  'trade mark sign': '\u{2122}',
  'numero sign': '\u{2116}',
  'ligature fi': '\u{FB01}',
  'Roman numeral eight': '\u{2167}',
  'Roman numeral one': '\u{2160}',
  'circled digit one': '\u{2460}',
  'double-struck digit one': '\u{1D7D9}',
  'circled ideograph': '\u{3297}',
  'halfwidth katakana': '\u{FF71}',
  'acute accent': '\u{00B4}',
});

const INVISIBLE = Object.freeze({
  'Hangul filler': HANGUL_FILLER,
  'two Hangul fillers': `${HANGUL_FILLER}${HANGUL_FILLER}`,
  'Hangul filler after a name': `Anna${HANGUL_FILLER}`,
  'Hangul choseong filler': '\u{115F}',
  'Hangul jungseong filler': '\u{1160}',
  'halfwidth Hangul filler': '\u{FFA0}',
  'zero width space': `An${ZERO_WIDTH_SPACE}na`,
  'right-to-left override': `${RIGHT_TO_LEFT_OVERRIDE}Anna`,
  'zero width joiner': `Anna${ZERO_WIDTH_JOINER}`,
});

const MARKS_WITHOUT_LETTER = Object.freeze({
  'accent alone': ACUTE,
  'accent before the name': `${ACUTE}Anna`,
  'accent after a hyphen': `Anna-${ACUTE}Maria`,
  'emoji selector alone': EMOJI_SELECTOR,
  'combining grapheme joiner alone': '\u{034F}',
});

const LETTER_EMOJI_RANGES = [[0x24B6, 0x24E9], [0x1F130, 0x1F189]];

const NOT_NAMES = [
  ['an empty string', ''],
  ['whitespace', '   '],
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a boolean', true],
  ['a bigint', 10n],
  ['a symbol', Symbol('Anna')],
  ['an array', ['Anna']],
  ['an object', { name: 'Anna' }],
  ['an object with a throwing toString', { toString() { throw new Error('toString() must not be called'); } }],
];

const HOSTILE_UNITS = [MODIFIER_APOSTROPHE, UNORDERED_MARKS, "'", '-', 'a-', "a'"];
const HOSTILE_LENGTHS = [RAW_MAX_LENGTH, HOSTILE_LENGTH];
const HOSTILE_STRINGS = HOSTILE_LENGTHS.flatMap((length) => HOSTILE_UNITS.map((unit) => `a${unit.repeat((length - 2) / unit.length)}!`));

function toCharacters([from, to]) {
  return Array.from({ length: to - from + 1 }, (unused, index) => String.fromCodePoint(from + index));
}

function measure(fn) {
  const startedAt = performance.now();

  fn();

  return performance.now() - startedAt;
}

describe('PERSON_NAME_MAX_LENGTH', () => {
  test('limits a name to 40 characters', () => {
    assert.equal(PERSON_NAME_MAX_LENGTH, 40);
  });
});

describe('normalizePersonName', () => {
  test('returns a name of plain composed letters as is', () => {
    [...NAMES, ...Object.values(NAMES_BY_SCRIPT)].forEach((name) => {
      assert.equal(normalizePersonName(name), name);
    });
  });

  test('trims whitespace around the value and keeps it inside', () => {
    assert.equal(normalizePersonName('  Anna  '), 'Anna');
    assert.equal(normalizePersonName('\t\nAnna Maria\r\n'), 'Anna Maria');
    assert.equal(normalizePersonName(`${NO_BREAK_SPACE}Anna${IDEOGRAPHIC_SPACE}`), 'Anna');
  });

  test('composes a decomposed letter', () => {
    assert.equal(normalizePersonName(`Kova${ACUTE}cs`), 'Kov\u{00E1}cs');
    assert.equal(normalizePersonName(`Андріи${BREVE}`), 'Андрі\u{0439}');
    assert.equal(normalizePersonName(`Nguye${CIRCUMFLEX}${TILDE}n`), 'Nguy\u{1EC5}n');
    assert.equal(normalizePersonName('\u{1112}\u{1161}\u{11AB}'), '\u{D55C}');
  });

  test('turns a font letter into the plain one', () => {
    const fonts = {
      'mathematical double-struck': ['𝕍𝕚𝕣𝕒', 'Vira'],
      fullwidth: ['Ｖｉｒａ', 'Vira'],
      circled: ['Ⓥⓘⓡⓐ', 'Vira'],
      squared: ['\u{1F145}\u{1F138}\u{1F141}\u{1F130}', 'VIRA'],
      superscript: ['ᵛⁱʳᵃ', 'vira'],
      'mathematical bold Greek': ['\u{1D6A8}\u{1D6CE}\u{1D6CE}\u{1D6C2}', 'Αννα'],
      'Cyrillic modifier': ['\u{1E030}', 'а'],
    };

    Object.entries(fonts).forEach(([font, [styled, plain]]) => {
      assert.equal(normalizePersonName(styled), plain, font);
    });
  });

  test('composes a font letter with the mark that follows it', () => {
    assert.equal(normalizePersonName(`Ｚｏｅ${DIAERESIS}`), 'Zo\u{00EB}');
  });

  test('keeps a letter followed by the emoji selector: it is a picture', () => {
    assert.equal(normalizePersonName('Ⓜ'), 'M');
    assert.equal(normalizePersonName(`Ⓜ${EMOJI_SELECTOR}`), `Ⓜ${EMOJI_SELECTOR}`);
  });

  test('keeps the spelling of Thai, Lao and Armenian names, which full NFKC would rewrite', () => {
    Object.entries(REWRITTEN_BY_NFKC).forEach(([script, name]) => {
      assert.notEqual(name.normalize('NFKC'), name, script);
      assert.equal(normalizePersonName(name), name, script);
    });
  });

  test('keeps symbols, ligatures and numbers, which full NFKC would turn into letters', () => {
    Object.entries(NOT_FONT_LETTERS).forEach(([label, symbol]) => {
      assert.notEqual(symbol.normalize('NFKC'), symbol, label);
      assert.equal(normalizePersonName(symbol), symbol, label);
    });
  });

  test('keeps a CJK compatibility ideograph, which NFC would replace with the unified one', () => {
    [`${COMPATIBILITY_IDEOGRAPH}田`, '\u{F9DC}', '\u{2F800}'].forEach((name) => {
      assert.notEqual(name.normalize('NFC'), name);
      assert.equal(normalizePersonName(name), name);
    });
  });

  test('composes the letters around a CJK compatibility ideograph', () => {
    assert.equal(normalizePersonName(`${COMPATIBILITY_IDEOGRAPH}\u{304B}${DAKUTEN}`), `${COMPATIBILITY_IDEOGRAPH}\u{304C}`);
    assert.equal(normalizePersonName(`e${ACUTE}${COMPATIBILITY_IDEOGRAPH}e${ACUTE}`), `\u{00E9}${COMPATIBILITY_IDEOGRAPH}\u{00E9}`);
  });

  test('returns its own result unchanged when applied again', () => {
    const values = [
      '  Anna  ',
      `Kova${ACUTE}cs`,
      '𝕍𝕚𝕣𝕒 🌸',
      `Ⓜ${EMOJI_SELECTOR}арина`,
      `${COMPATIBILITY_IDEOGRAPH}\u{304B}${DAKUTEN}`,
      `a${UNORDERED_MARKS.repeat(3)}`,
      `e${ACUTE}`.repeat(RAW_MAX_LENGTH / 2),
      '\u{FB2C}'.repeat(RAW_MAX_LENGTH),
    ];

    values.forEach((value) => {
      const normalized = normalizePersonName(value);

      assert.equal(normalizePersonName(normalized), normalized);
    });
  });

  test('converts what is not a string like toString: null and undefined become an empty string', () => {
    assert.equal(normalizePersonName(null), '');
    assert.equal(normalizePersonName(undefined), '');
    assert.equal(normalizePersonName(42), '42');
    assert.equal(normalizePersonName(''), '');
    assert.equal(normalizePersonName('   '), '');
  });

  test('normalizes a value of 256 characters and only trims a longer one, which cannot be a name', () => {
    const decomposed = `e${ACUTE}`.repeat(RAW_MAX_LENGTH / 2);

    assert.equal(normalizePersonName(decomposed), '\u{00E9}'.repeat(RAW_MAX_LENGTH / 2));
    assert.equal(normalizePersonName(`  ${decomposed}a  `), `${decomposed}a`);
    assert.equal(normalizePersonName(`${' '.repeat(RAW_MAX_LENGTH)}e${ACUTE}`), '\u{00E9}');
  });

  test('does not spend the quadratic time of NFC on a long run of combining marks', () => {
    const hostile = `a${UNORDERED_MARKS.repeat(HOSTILE_LENGTH)}`;
    const elapsed = measure(() => {
      assert.equal(normalizePersonName(hostile), hostile);
    });

    assert.ok(elapsed < INSTANT_MS, `took ${elapsed} ms`);
  });
});

describe('isValidPersonName', () => {
  test('accepts a name of letters of any script', () => {
    NAMES.forEach((name) => {
      assert.equal(isValidPersonName(name), true, name);
    });

    Object.entries(NAMES_BY_SCRIPT).forEach(([script, name]) => {
      assert.equal(isValidPersonName(name), true, script);
    });
  });

  test('accepts a hyphen, an apostrophe and a right single quote between letters', () => {
    ['Jean-Pierre', 'Mary-Jane-Ann', "D'Arcy-O'Neil", `O${RIGHT_QUOTE}Connor`, `Мар${RIGHT_QUOTE}яна`].forEach((name) => {
      assert.equal(isValidPersonName(name), true, name);
    });
  });

  test('accepts U+02BC anywhere in the name: it is a letter, not a separator', () => {
    [`Мар${MODIFIER_APOSTROPHE}яна`, `${MODIFIER_APOSTROPHE}Анна`, `Анна${MODIFIER_APOSTROPHE}`, `a${MODIFIER_APOSTROPHE.repeat(38)}`].forEach((name) => {
      assert.equal(isValidPersonName(name), true, name);
    });
  });

  test('rejects a hyphen or an apostrophe at an edge of the name', () => {
    ['-Anna', 'Anna-', "'Anna", "Anna'", `${RIGHT_QUOTE}Anna`, `Anna${RIGHT_QUOTE}`].forEach((name) => {
      assert.equal(isValidPersonName(name), false, name);
    });
  });

  test('rejects a doubled hyphen or apostrophe and two of them in a row', () => {
    ['Anna--Maria', "O''Connor", `O${RIGHT_QUOTE}${RIGHT_QUOTE}Connor`, "Anna-'Maria", "Anna'-Maria"].forEach((name) => {
      assert.equal(isValidPersonName(name), false, name);
    });
  });

  test('rejects a space, a digit, a dot, an emoji and any other character', () => {
    const values = [
      'Anna Maria',
      'Anna\tMaria',
      'Іван2',
      'Dr.',
      'J.R.',
      '😀',
      'Anna😀',
      '<b>x</b>',
      'Anna_Maria',
      'Anna,',
      'anna@example.com',
      'В`ячеслав',
      'Anna\u{2010}Maria',
      'Anna\u{2013}Maria',
    ];

    values.forEach((value) => {
      assert.equal(isValidPersonName(value), false, value);
    });
  });

  test('rejects an invisible character: a format control or a Hangul filler, which is a letter by category', () => {
    Object.entries(INVISIBLE).forEach(([label, value]) => {
      assert.equal(isValidPersonName(value), false, label);
    });
  });

  test('accepts marks after a letter: a virama, a stack of accents, the variation selector of an ideograph', () => {
    assert.equal(isValidPersonName('प्रिया'), true);
    assert.equal(isValidPersonName(`a${DOT_BELOW}${ACUTE}`), true);
    assert.equal(isValidPersonName('\u{845B}\u{E0100}\u{57CE}'), true);
  });

  test('rejects a mark without a letter before it', () => {
    Object.entries(MARKS_WITHOUT_LETTER).forEach(([label, value]) => {
      assert.equal(isValidPersonName(value), false, label);
    });
  });

  test('validates the normalized value: trimmed, composed, in plain letters', () => {
    ['  Anna  ', `Kova${ACUTE}cs`, '𝕍𝕚𝕣𝕒', 'Ｖｉｒａ'].forEach((value) => {
      assert.equal(isValidPersonName(value), true, value);
    });
  });

  test('accepts 40 characters and rejects 41', () => {
    assert.equal(isValidPersonName('a'.repeat(PERSON_NAME_MAX_LENGTH)), true);
    assert.equal(isValidPersonName('a'.repeat(PERSON_NAME_MAX_LENGTH + 1)), false);
    assert.equal(isValidPersonName(`${'a'.repeat(20)}-${'b'.repeat(19)}`), true);
    assert.equal(isValidPersonName(`${'a'.repeat(20)}-${'b'.repeat(20)}`), false);
  });

  test('measures the normalized value, and a character outside the basic plane counts as one', () => {
    const characters = {
      'decomposed letter': `e${ACUTE}`,
      'ideograph outside the basic plane': '\u{20BB7}',
      'font letter outside the basic plane': '𝕒',
    };

    Object.entries(characters).forEach(([label, character]) => {
      assert.equal(isValidPersonName(character.repeat(PERSON_NAME_MAX_LENGTH)), true, label);
      assert.equal(isValidPersonName(character.repeat(PERSON_NAME_MAX_LENGTH + 1)), false, label);
    });

    assert.equal(isValidPersonName(`  ${'a'.repeat(PERSON_NAME_MAX_LENGTH)}  `), true);
  });

  test('rejects an empty string, whitespace, null, undefined and what is not a string', () => {
    NOT_NAMES.forEach(([label, value]) => {
      assert.equal(isValidPersonName(value), false, label);
    });
  });

  test('rejects a raw string longer than 256 characters before normalizing it', () => {
    assert.equal(isValidPersonName(`Anna${' '.repeat(RAW_MAX_LENGTH - 4)}`), true);
    assert.equal(isValidPersonName(`Anna${' '.repeat(RAW_MAX_LENGTH - 3)}`), false);
  });

  test('answers at once for "a", 38 times U+02BC and "!": a separator that is also a letter would backtrack exponentially', () => {
    const elapsed = measure(() => {
      assert.equal(isValidPersonName(`a${MODIFIER_APOSTROPHE.repeat(38)}!`), false);
    });

    assert.ok(elapsed < INSTANT_MS, `took ${elapsed} ms`);
  });

  test('answers at once for a hostile string of 256 characters and of 100000', () => {
    const elapsed = measure(() => {
      HOSTILE_STRINGS.forEach((hostile) => {
        assert.equal(isValidPersonName(hostile), false);
      });
    });

    assert.deepEqual([...new Set(HOSTILE_STRINGS.map((hostile) => hostile.length))], HOSTILE_LENGTHS);
    assert.ok(elapsed < INSTANT_MS, `took ${elapsed} ms`);
  });
});

describe('toValidPersonName', () => {
  test('returns a valid name unchanged', () => {
    NAMES.forEach((name) => {
      assert.equal(toValidPersonName(name), name);
    });

    Object.entries(NAMES_BY_SCRIPT).forEach(([script, name]) => {
      assert.equal(toValidPersonName(name), name, script);
    });
  });

  test('returns a valid name normalized: trimmed, composed, in plain letters', () => {
    assert.equal(toValidPersonName('  Anna  '), 'Anna');
    assert.equal(toValidPersonName(`Kova${ACUTE}cs`), 'Kov\u{00E1}cs');
    assert.equal(toValidPersonName('𝕍𝕚𝕣𝕒'), 'Vira');
    assert.equal(toValidPersonName(`${COMPATIBILITY_IDEOGRAPH}田`), `${COMPATIBILITY_IDEOGRAPH}田`);
  });

  test('takes the first word of a value with several words', () => {
    assert.equal(toValidPersonName('Anna Maria'), 'Anna');
    assert.equal(toValidPersonName('Анна-Марія Коваленко'), 'Анна-Марія');
    assert.equal(toValidPersonName("D'Angelo Russell"), "D'Angelo");
    assert.equal(toValidPersonName('山田 太郎'), '山田');
    assert.equal(toValidPersonName('Anna\tMaria'), 'Anna');
    assert.equal(toValidPersonName('Anna\nMaria'), 'Anna');
    assert.equal(toValidPersonName(`Anna${NO_BREAK_SPACE}Maria`), 'Anna');
    assert.equal(toValidPersonName(`Anna${IDEOGRAPHIC_SPACE}Maria`), 'Anna');
  });

  test('skips the words without letters before the name: they are decorations', () => {
    assert.equal(toValidPersonName('🌸 Віра'), 'Віра');
    assert.equal(toValidPersonName('✨ 🌸 Anna 🌸 ✨'), 'Anna');
    assert.equal(toValidPersonName('... Anna'), 'Anna');
    assert.equal(toValidPersonName('2024 Anna'), 'Anna');
    assert.equal(toValidPersonName(`${HANGUL_FILLER} Віра`), 'Віра');
    assert.equal(toValidPersonName(`${MODIFIER_APOSTROPHE} Anna`), 'Anna');
  });

  test('cuts the decorations stuck to the edges of the name', () => {
    const decorated = {
      '🌸Віра🌸': 'Віра',
      '💎Олена': 'Олена',
      'Віра🌸': 'Віра',
      'Шевченко🇺🇦': 'Шевченко',
      '🌸प्रिया🌸': 'प्रिया',
      'น้ำทิพย์🌸': 'น้ำทิพย์',
      [`Anna\u{2764}${EMOJI_SELECTOR}`]: 'Anna',
      [`${FAMILY_EMOJI}Anna${FAMILY_EMOJI}`]: 'Anna',
      '«Anna»': 'Anna',
      '(Anna)': 'Anna',
      '"Anna"': 'Anna',
      '*Anna*': 'Anna',
      'Anna!': 'Anna',
      [`${RIGHT_TO_LEFT_OVERRIDE}Anna`]: 'Anna',
      [`${ZERO_WIDTH_SPACE}Anna${ZERO_WIDTH_SPACE}`]: 'Anna',
      [`Anna${HANGUL_FILLER}`]: 'Anna',
      [`${ACUTE}Anna`]: 'Anna',
    };

    Object.entries(decorated).forEach(([value, name]) => {
      assert.equal(toValidPersonName(value), name, JSON.stringify(value));
    });
  });

  test('treats a modifier letter before the first other letter of the word as a decoration', () => {
    assert.equal(toValidPersonName(`${MODIFIER_APOSTROPHE}Anna Maria`), 'Anna');
    assert.equal(toValidPersonName(`🌸${MODIFIER_APOSTROPHE}Анна`), 'Анна');
  });

  test('returns null for "Dr. X", "<b>x</b>", "Іван2" and an emoji', () => {
    ['Dr. X', '<b>x</b>', 'Іван2', '😀'].forEach((value) => {
      assert.equal(toValidPersonName(value), null, value);
    });
  });

  test('does not look for a name after the first word with a letter', () => {
    ['В`ячеслав Петрович', 'Віра🌸Олена Петренко', 'Anna.Maria Smith', 'x Anna', 'A1 Anna'].forEach((value) => {
      assert.equal(toValidPersonName(value), null, value);
    });
  });

  test('returns null for a word with a digit anywhere in it', () => {
    ['Іван2', 'vira2000', '2pac Shakur', '(1)Anna', 'Anna\u{00B2} Maria', `Anna1${EMOJI_SELECTOR}\u{20E3}`].forEach((value) => {
      assert.equal(toValidPersonName(value), null, value);
    });
  });

  test('returns null for a word of one letter, which is an initial, and returns a whole value of one letter', () => {
    ['J Smith', 'J. Smith', '🌸A🌸', '李 伟'].forEach((value) => {
      assert.equal(toValidPersonName(value), null, value);
    });

    assert.equal(toValidPersonName('J'), 'J');
    assert.equal(toValidPersonName('伟'), '伟');
  });

  test('returns null when a lone dot follows the word, and cuts two or more dots as a decoration', () => {
    ['Dr. X', 'Anna.', 'Mrs. Smith'].forEach((value) => {
      assert.equal(toValidPersonName(value), null, value);
    });

    assert.equal(toValidPersonName('Anna...'), 'Anna');
    assert.equal(toValidPersonName('Anna.. Maria'), 'Anna');
  });

  test('returns null when an apostrophe, a geresh or a joiner follows the word: it is a part of the name', () => {
    const values = {
      apostrophe: "Dell' Anna",
      'right single quote': `Dell${RIGHT_QUOTE} Anna`,
      geresh: `${HEBREW_NAME}${GERESH}`,
      'zero width joiner': `Anna${ZERO_WIDTH_JOINER}`,
      'zero width non-joiner': `Anna${ZERO_WIDTH_NON_JOINER} Maria`,
    };

    Object.entries(values).forEach(([label, value]) => {
      assert.equal(toValidPersonName(value), null, label);
    });
  });

  test('returns null when a letter emoji is stuck to the word: it stands for one of its letters', () => {
    [`Ⓜ${EMOJI_SELECTOR}арина`, '🅰нна', `🅰${TEXT_SELECTOR}нна`, 'Анн🅰'].forEach((value) => {
      assert.equal(toValidPersonName(value), null, value);
    });

    assert.equal(toValidPersonName('🅰 Анна'), 'Анна');
  });

  test('returns null for every letter emoji with the emoji selector on either side of the word', () => {
    LETTER_EMOJI_RANGES.flatMap(toCharacters).forEach((letter) => {
      const emoji = `${letter}${EMOJI_SELECTOR}`;

      assert.equal(toValidPersonName(`${emoji}нна`), null, `${emoji} before the word`);
      assert.equal(toValidPersonName(`Анн${emoji}`), null, `${emoji} after the word`);
    });
  });

  test('returns null for a value without letters', () => {
    ['😀', '123', '!!!', '...', HANGUL_FILLER, '\u{1F150}\u{1F15D}\u{1F15D}\u{1F150}'].forEach((value) => {
      assert.equal(toValidPersonName(value), null, JSON.stringify(value));
    });
  });

  test('returns null for markup', () => {
    ['<b>x</b>', '<b>Anna</b>', '<script>alert(1)</script>', 'Anna<br>'].forEach((value) => {
      assert.equal(toValidPersonName(value), null, value);
    });
  });

  test('returns null for an empty string, whitespace, null, undefined and what is not a string', () => {
    NOT_NAMES.forEach(([label, value]) => {
      assert.equal(toValidPersonName(value), null, label);
    });
  });

  test('returns null for a raw string longer than 256 characters, before any processing', () => {
    assert.equal(toValidPersonName(`Anna${' '.repeat(RAW_MAX_LENGTH - 4)}`), 'Anna');
    assert.equal(toValidPersonName(`Anna${' '.repeat(RAW_MAX_LENGTH - 3)}`), null);
  });

  test('returns either null or a name that is valid and already normalized', () => {
    const values = [
      ...NAMES,
      '🌸Віра🌸',
      `Kova${ACUTE}cs Петренко`,
      '𝕍𝕚𝕣𝕒 🌸',
      `${COMPATIBILITY_IDEOGRAPH}\u{304B}${DAKUTEN} 太郎`,
      `a${MODIFIER_APOSTROPHE.repeat(38)}!`,
      `${OKINA}Iolani Smith`,
      'Anna\u{0}',
      'Anna\u{D83D}',
      '\u{DC00}Anna',
      `${ACUTE}${ACUTE}`,
      "Robert'); DROP TABLE users;--",
      '<b>Anna</b>',
      '',
    ];

    const names = values
      .map((value) => toValidPersonName(value))
      .filter((name) => name !== null);

    assert.ok(names.length > NAMES.length);
    names.forEach((name) => {
      assert.equal(isValidPersonName(name), true, JSON.stringify(name));
      assert.equal(normalizePersonName(name), name, JSON.stringify(name));
      assert.equal(toValidPersonName(name), name, JSON.stringify(name));
    });
  });

  test('answers at once for a hostile string of 256 characters and of 100000', () => {
    const elapsed = measure(() => {
      HOSTILE_STRINGS.forEach((hostile) => {
        assert.equal(toValidPersonName(hostile), null);
      });
    });

    assert.deepEqual([...new Set(HOSTILE_STRINGS.map((hostile) => hostile.length))], HOSTILE_LENGTHS);
    assert.ok(elapsed < INSTANT_MS, `took ${elapsed} ms`);
  });
});
