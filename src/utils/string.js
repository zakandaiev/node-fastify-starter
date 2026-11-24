import {
  isNonNegativeInteger,
  isNumberInRange,
  isObject,
  isString,
  toNumber,
  toString,
} from '#utils/type.js';

const SPACE = ' ';
const WHITESPACE_REGEXP = /^\s$/;
const WHITESPACE_RUN_REGEXP = /\s+/g;

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});
const HTML_ESCAPE_REGEXP = /[&<>"']/g;

const HTML_ENTITIES = Object.freeze({
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': SPACE,
});
const HTML_ENTITY_REGEXP = /&(?:amp|lt|gt|quot|#39|nbsp);/g;

const REGEXP_SYNTAX_REGEXP = /[\\^$.*+?()[\]{}|/]/g;
const LIKE_SYNTAX_REGEXP = /[\\%_]/g;

const TAG_OPEN = '<';
const TAG_CLOSE = '>';
const END_TAG_OPEN = '</';
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
// "<!-->" is a complete comment: its closing "-->" shares the dashes with the opening "<!--".
const COMMENT_CLOSE_OFFSET = 2;
const ATTRIBUTE_ASSIGNMENT = '=';
const ATTRIBUTE_QUOTES = Object.freeze(['"', "'"]);
const MARKUP_LEAD_REGEXP = /^[a-z/!?]$/i;
const TAG_NAME_REGEXP = /^<\/?([a-z][^\s/>]*)/i;

const RAW_TEXT_TAGS = new Set(['script', 'style']);

// Any other tag leaves a space behind: "<p>one</p><p>two</p>" must not become "onetwo".
const INLINE_TAGS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn',
  'em', 'font', 'i', 'ins', 'kbd', 'mark', 'nobr', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
]);

const ADDRESS_TAIL_REGEXP = /[?#]/;
// What follows a scheme, or a path in quotes whose tail begins before the quote that closes it, up to the next space.
// "/^" begins a pattern, not a path.
const ADDRESS_IN_TEXT_REGEXP = /(?<=[A-Za-z][A-Za-z\d+.-]{0,31}):\/\/\S+|(?<=(["'`]))\/(?!\^)(?:(?!\1)[^\s?#])*[?#]\S*/g;
const FRAME_POSITION_REGEXP = /:\d+:\d+$/;
const CLOSING_MARKS = Object.freeze([')', ']', '}', "'", '"', '`', '>', ',', '.', ';', ':']);

const TRUNCATE_SUFFIX = '…';
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const CODE_POINT_MAX_LENGTH = 2;

const MASK_CHAR = '*';
const MASK_VISIBLE_COUNT = 1;

const BYTE_UNITS = Object.freeze(['B', 'KB', 'MB', 'GB', 'TB']);
const BYTES_PER_UNIT = 1024;
const BYTES_DECIMALS = 1;
const DECIMALS_MAX = 100;

// NFC takes quadratic time on a long run of combining marks, and no address is longer than this.
const EMAIL_INPUT_MAX_LENGTH = 320;
const UNICODE_FORM = 'NFC';

const PHONE_RAW_MAX_LENGTH = 32;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
const PHONE_SEPARATOR_REGEXP = /[\s+().-]/g;
const DIGITS_REGEXP = /^\d+$/;

export function escapeHtml(value) {
  return toString(value).replace(HTML_ESCAPE_REGEXP, (char) => HTML_ESCAPES[char]);
}

// Not RegExp.escape(): it writes a leading letter or digit as \x.., and the pattern lands in the API docs.
// Every character escaped here is a syntax character, which the "u" flag of AJV accepts escaped.
export function escapeRegExp(value) {
  return toString(value).replace(REGEXP_SYNTAX_REGEXP, '\\$&');
}

// The backslash is the escape of LIKE while NO_BACKSLASH_ESCAPES is off, and the MariaDB driver turns that mode
// off in every session.
export function escapeLikePattern(value) {
  if (!isString(value)) {
    throw new TypeError('escapeLikePattern(value) requires a string');
  }

  return value.replace(LIKE_SYNTAX_REGEXP, '\\$&');
}

// What is left unclosed runs to the end of the input, as in a browser: a failed search is never repeated from
// the next "<", and that is what keeps the scan linear on "<script<script<script…".
function indexAfter(text, search, from) {
  const index = text.indexOf(search, from);

  return index === -1
    ? text.length
    : index + search.length;
}

// "<" opens markup only before a letter, "/", "!" or "?": in "1 < 2" it is text, as it is for a browser.
function findMarkupStart(html, from) {
  let start = html.indexOf(TAG_OPEN, from);

  while (start !== -1 && !MARKUP_LEAD_REGEXP.test(html.charAt(start + 1))) {
    start = html.indexOf(TAG_OPEN, start + 1);
  }

  return start === -1
    ? html.length
    : start;
}

// ">" inside a quoted attribute value does not close the tag, and a quote opens a value only after "=".
function findTagEnd(html, start) {
  let position = start;
  let isValueNext = false;

  while (position < html.length) {
    const char = html[position];

    if (char === TAG_CLOSE) {
      return position + 1;
    }

    if (isValueNext && ATTRIBUTE_QUOTES.includes(char)) {
      position = indexAfter(html, char, position + 1);
      isValueNext = false;
    } else {
      isValueNext = char === ATTRIBUTE_ASSIGNMENT || (isValueNext && WHITESPACE_REGEXP.test(char));
      position += 1;
    }
  }

  return html.length;
}

function readTagName(tag) {
  const [, name = ''] = TAG_NAME_REGEXP.exec(tag) ?? [];

  return name.toLowerCase();
}

function isEndTagAt(html, index, name) {
  const candidate = html.slice(index, index + END_TAG_OPEN.length + name.length + 1);

  return readTagName(candidate) === name;
}

function findRawTextEnd(html, name, from) {
  let close = html.indexOf(END_TAG_OPEN, from);

  while (close !== -1 && !isEndTagAt(html, close, name)) {
    close = html.indexOf(END_TAG_OPEN, close + END_TAG_OPEN.length);
  }

  return close === -1
    ? html.length
    : findTagEnd(html, close);
}

function readMarkup(html, start) {
  if (html.startsWith(COMMENT_OPEN, start)) {
    return { end: indexAfter(html, COMMENT_CLOSE, start + COMMENT_CLOSE_OFFSET), separator: '' };
  }

  const tagEnd = findTagEnd(html, start);
  const name = readTagName(html.slice(start, tagEnd));
  const isRawText = RAW_TEXT_TAGS.has(name) && !html.startsWith(END_TAG_OPEN, start);

  return {
    end: isRawText
      ? findRawTextEnd(html, name, tagEnd)
      : tagEnd,
    separator: INLINE_TAGS.has(name)
      ? ''
      : SPACE,
  };
}

function decodeEntities(text) {
  return text.replace(HTML_ENTITY_REGEXP, (entity) => HTML_ENTITIES[entity]);
}

function extractText(html) {
  const parts = [];
  let position = 0;
  let start = findMarkupStart(html, position);

  while (start < html.length) {
    const { end, separator } = readMarkup(html, start);

    parts.push(decodeEntities(html.slice(position, start)), separator);
    position = end;
    start = findMarkupStart(html, position);
  }

  parts.push(decodeEntities(html.slice(position)));

  return parts.join('');
}

export function stripHtml(value) {
  return extractText(toString(value))
    .replace(WHITESPACE_RUN_REGEXP, SPACE)
    .trim();
}

// A grapheme boundary depends on the text before it and on one code point after it,
// so the rest of a long value is left out of the segmentation.
function cutAtGrapheme(text, length) {
  const { index } = GRAPHEME_SEGMENTER
    .segment(text.slice(0, length + CODE_POINT_MAX_LENGTH))
    .containing(length);

  return text.slice(0, index);
}

// The query and the fragment of an address carry OAuth codes, tokens and the initData of a Mini App.
export function cutAddressTail(value, mark = '') {
  const text = toString(value);
  const start = text.search(ADDRESS_TAIL_REGEXP);

  return start === -1
    ? text
    : `${text.slice(0, start)}${mark}`;
}

function cutFoundAddress(address) {
  const start = address.search(ADDRESS_TAIL_REGEXP);

  if (start === -1) {
    return address;
  }

  const tail = address.slice(start);
  let closingAt = tail.length;

  // Walked back by hand: a pattern for the closing marks at the end tries every place in a long run of them.
  while (closingAt > 0 && CLOSING_MARKS.includes(tail[closingAt - 1])) {
    closingAt -= 1;
  }

  const [position = ''] = FRAME_POSITION_REGEXP.exec(tail.slice(0, closingAt)) ?? [];

  return `${address.slice(0, start)}${position}${tail.slice(closingAt)}`;
}

// Every address with "://" inside a text, and every path in quotes that starts with "/" and whose tail begins before the
// same quote comes again, loses its query and fragment up to the next space: a browser leaves ( ) ' and ` raw there. The
// line and the column of a frame stay, with the marks that close the address. A path without quotes is any text.
export function cutAddressTails(value) {
  return toString(value).replace(ADDRESS_IN_TEXT_REGEXP, cutFoundAddress);
}

export function truncate(value, maxLength, suffix = TRUNCATE_SUFFIX) {
  if (!isNonNegativeInteger(maxLength)) {
    throw new RangeError('truncate(value, maxLength, suffix) requires a non-negative integer maxLength');
  }

  if (!isString(suffix)) {
    throw new TypeError('truncate(value, maxLength, suffix) requires a string suffix');
  }

  const text = toString(value);

  if (text.length <= maxLength) {
    return text.toWellFormed();
  }

  const ending = suffix.length > maxLength
    ? ''
    : suffix;
  const head = cutAtGrapheme(text, maxLength - ending.length).trimEnd();

  return `${head}${ending}`.toWellFormed();
}

export function mask(value, options = {}) {
  if (!isObject(options)) {
    throw new TypeError('mask(value, options) requires options to be a plain object');
  }

  const { start = MASK_VISIBLE_COUNT, end = MASK_VISIBLE_COUNT, char = MASK_CHAR } = options;

  if (!isNonNegativeInteger(start) || !isNonNegativeInteger(end)) {
    throw new RangeError('mask(value, options) requires start and end to be non-negative integers');
  }

  if (!isString(char) || Array.from(char).length !== 1) {
    throw new TypeError('mask(value, options) requires char to be a single character');
  }

  const symbols = Array.from(toString(value));
  const hiddenCount = symbols.length - start - end;

  if (hiddenCount <= 0) {
    return char.repeat(symbols.length);
  }

  return [
    ...symbols.slice(0, start),
    char.repeat(hiddenCount),
    ...symbols.slice(symbols.length - end),
  ].join('');
}

export function formatBytes(bytes, decimals = BYTES_DECIMALS) {
  if (!Number.isInteger(decimals) || !isNumberInRange(decimals, 0, DECIMALS_MAX)) {
    throw new RangeError(`formatBytes(bytes, decimals) requires decimals to be an integer from 0 to ${DECIMALS_MAX}`);
  }

  const size = toNumber(bytes);

  if (size === null || size < 0) {
    return null;
  }

  // Rounded first, compared second: 1048575 bytes are "1 MB", not "1024 KB".
  const values = BYTE_UNITS.map((unused, index) => Number((size / (BYTES_PER_UNIT ** index)).toFixed(decimals)));
  const lastIndex = BYTE_UNITS.length - 1;
  const unitIndex = values.findIndex((value, index) => value < BYTES_PER_UNIT || index === lastIndex);

  return `${values[unitIndex]} ${BYTE_UNITS[unitIndex]}`;
}

// NFC goes last: lower-casing keeps canonical equivalence but not the form. "İ" becomes "i" + U+0307,
// and a mark below the letter that follows it is then out of canonical order.
export function normalizeEmail(value) {
  const email = toString(value).trim();

  if (email.length > EMAIL_INPUT_MAX_LENGTH) {
    return '';
  }

  return email.toLowerCase().normalize(UNICODE_FORM);
}

export function normalizePhone(value) {
  const raw = toString(value);

  if (raw.length > PHONE_RAW_MAX_LENGTH) {
    return null;
  }

  const digits = raw.replace(PHONE_SEPARATOR_REGEXP, '');
  const isPhone = DIGITS_REGEXP.test(digits) && isNumberInRange(digits.length, PHONE_MIN_DIGITS, PHONE_MAX_DIGITS);

  return isPhone
    ? digits
    : null;
}
