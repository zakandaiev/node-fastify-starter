import { isString, toString } from '#utils/type.js';

export const PERSON_NAME_MAX_LENGTH = 40;

// NFC takes quadratic time on a long run of combining marks: the ceiling goes before any Unicode work.
const PERSON_NAME_RAW_MAX_LENGTH = 256;
const NAME_WORD_MIN_LETTERS = 2;

// The Hangul fillers are letters by category and an empty place for a reader.
const INVISIBLE = '\\p{Default_Ignorable_Code_Point}';
const LETTER = `[\\p{L}--${INVISIBLE}]`;
const MARK = '\\p{M}';
const LETTER_RUN = `(?:${LETTER}${MARK}*)+`;

const HYPHEN = '\\-';
const APOSTROPHE = "'\\u2019";
// U+02BC is a letter already: listed here as well, it gives every "ʼ" two readings and the regexp exponential backtracking.
const INNER_SIGN = `[${HYPHEN}${APOSTROPHE}]`;
const NAME_REGEXP = new RegExp(`^${LETTER_RUN}(?:${INNER_SIGN}${LETTER_RUN})*$`, 'v');

// Full NFKC rewrites ordinary spelling (Thai ำ, Lao ໜ, Armenian և) and turns symbols into letters (™ into TM),
// so only a "font" letter is replaced: a code point that NFKC turns into exactly one plain letter.
// Followed by the emoji selector U+FE0F it is a picture and stays as it is.
const PLAIN_LETTER_REGEXP = /^[\p{L}&&[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]]$/v;
const NUMBER_REGEXP = /\p{N}/v;
const EMOJI_SELECTOR = '\\uFE0F';
const FONT_LETTER_CANDIDATE_REGEXP = new RegExp(`\\P{ASCII}(?!${EMOJI_SELECTOR})`, 'gv');

// NFC replaces a CJK compatibility ideograph with the unified one, and in a Japanese name that is another glyph.
const CJK_COMPATIBILITY_IDEOGRAPH = '\\u{F900}-\\u{FAFF}\\u{2F800}-\\u{2FA1F}';
const COMPOSABLE_RUN_REGEXP = new RegExp(`[^${CJK_COMPATIBILITY_IDEOGRAPH}]+`, 'gv');

const WHITESPACE_REGEXP = /\s+/v;
const LETTERS_REGEXP = new RegExp(LETTER, 'gv');
// A modifier letter (ʼ, ー) cannot start a name: before the first other letter it is a decoration.
const LEAD_LETTER = `[\\p{L}--[\\p{Lm}${INVISIBLE}]]`;
const LEAD_LETTER_REGEXP = new RegExp(LEAD_LETTER, 'v');
const WORD_REGEXP = new RegExp(`^(?<head>.*?)(?<core>${LEAD_LETTER}(?:.*${LETTER})?${MARK}*)(?<tail>.*)$`, 'sv');

// A letter emoji (🅰) stuck to a word stands for one of its letters: cut off, it would leave a shortened name.
const CIRCLED_LETTER = '\\u24B6-\\u24E9';
const SQUARED_LETTER = '\\u{1F130}-\\u{1F189}';
const LETTER_EMOJI = `[${CIRCLED_LETTER}${SQUARED_LETTER}]`;
const PRESENTATION_SELECTOR = '[\\uFE0E\\uFE0F]';
// With the "u" flag V8 misses an end-anchored match after a class of astral code points: this regexp needs "v".
const HEAD_STOP_REGEXP = new RegExp(`${LETTER_EMOJI}${PRESENTATION_SELECTOR}?$`, 'v');

// A lone dot ends an abbreviation ("Dr."), two or more are a decoration. A sign of the script right after
// the last letter belongs to the word: without it the name would be a different one.
const ABBREVIATION_DOT = '\\.(?!\\.)';
const GERESH = '\\u05F3';
const JOINER = '\\u200C\\u200D';
const SCRIPT_SIGN = `[${APOSTROPHE}${GERESH}${JOINER}]`;
const TAIL_STOP_REGEXP = new RegExp(`^(?:${ABBREVIATION_DOT}|${SCRIPT_SIGN}|${LETTER_EMOJI})`, 'v');

function toPlainLetter(char) {
  const letter = char.normalize('NFKC');

  return PLAIN_LETTER_REGEXP.test(letter) && !NUMBER_REGEXP.test(char)
    ? letter
    : char;
}

export function normalizePersonName(name) {
  const value = toString(name).trim();

  if (value.length > PERSON_NAME_RAW_MAX_LENGTH) {
    return value;
  }

  return value
    .replace(FONT_LETTER_CANDIDATE_REGEXP, toPlainLetter)
    .replace(COMPOSABLE_RUN_REGEXP, (run) => run.normalize('NFC'));
}

function isRawName(name) {
  return isString(name) && name.length <= PERSON_NAME_RAW_MAX_LENGTH;
}

function isName(value) {
  return Array.from(value).length <= PERSON_NAME_MAX_LENGTH && NAME_REGEXP.test(value);
}

export function isValidPersonName(name) {
  return isRawName(name) && isName(normalizePersonName(name));
}

function toNameWord(word) {
  const { head, core, tail } = word.match(WORD_REGEXP).groups;
  const isClean = !NUMBER_REGEXP.test(word)
    && core.match(LETTERS_REGEXP).length >= NAME_WORD_MIN_LETTERS
    && !HEAD_STOP_REGEXP.test(head)
    && !TAIL_STOP_REGEXP.test(tail);

  return isClean && isName(core)
    ? core
    : null;
}

export function toValidPersonName(name) {
  if (!isRawName(name)) {
    return null;
  }

  const value = normalizePersonName(name);

  if (isName(value)) {
    return value;
  }

  // Later words are not tried: after a broken first word comes a surname or a patronymic, not the name.
  const word = value
    .split(WHITESPACE_REGEXP)
    .find((item) => LEAD_LETTER_REGEXP.test(item));

  return word
    ? toNameWord(word)
    : null;
}
