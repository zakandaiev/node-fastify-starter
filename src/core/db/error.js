import { isString } from '#utils/type.js';

const LINE_BREAK = '\n';
const VALUE_MASK = '***';

const DUPLICATE_ENTRY_PREFIX = "Duplicate entry '";
const DUPLICATE_ENTRY_SUFFIX = "' for key ";

// The value ends at the LAST suffix: the duplicate itself may hold a quote or the suffix text. A text cut before
// the suffix is masked to its end, and so is an entry cut after the last suffix: one more call, never a deeper one.
// Plain indexOf instead of a regular expression: the text also comes from a public endpoint.
function maskDuplicateEntry(text) {
  const start = text.indexOf(DUPLICATE_ENTRY_PREFIX);

  if (start === -1) {
    return text;
  }

  const valueStart = start + DUPLICATE_ENTRY_PREFIX.length;
  const valueEnd = text.lastIndexOf(DUPLICATE_ENTRY_SUFFIX);
  const masked = `${text.slice(0, valueStart)}${VALUE_MASK}`;

  if (valueEnd < valueStart) {
    return masked;
  }

  const rest = text.slice(valueEnd + DUPLICATE_ENTRY_SUFFIX.length);

  return `${masked}${DUPLICATE_ENTRY_SUFFIX}${maskDuplicateEntry(rest)}`;
}

// A value with a line break of its own leaves a line where an entry starts and does not end,
// or ends and did not start: other entries may stand complete on that same line.
function isBrokenLine(line) {
  const firstPrefix = line.indexOf(DUPLICATE_ENTRY_PREFIX);
  const firstSuffix = line.indexOf(DUPLICATE_ENTRY_SUFFIX);
  const isOpenAtEnd = line.lastIndexOf(DUPLICATE_ENTRY_PREFIX) > line.lastIndexOf(DUPLICATE_ENTRY_SUFFIX);
  const isOpenAtStart = firstSuffix !== -1 && (firstPrefix === -1 || firstSuffix < firstPrefix);

  return isOpenAtEnd || isOpenAtStart;
}

// Line by line, so the frames of a stack survive; when a value spans lines, everything from the first
// prefix to the last suffix of the whole text is the value.
export function maskDbErrorValues(text) {
  if (!isString(text) || !text.includes(DUPLICATE_ENTRY_PREFIX)) {
    return text;
  }

  const lines = text.split(LINE_BREAK);

  return lines.some((line) => isBrokenLine(line))
    ? maskDuplicateEntry(text)
    : lines.map((line) => maskDuplicateEntry(line)).join(LINE_BREAK);
}
