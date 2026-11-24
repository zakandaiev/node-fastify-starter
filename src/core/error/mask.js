import { maskDbErrorValues } from '#core/db/error.js';
import { isString } from '#utils/type.js';

const VALUE_MASK = '***';
const LINE_BREAK = '\n';

// fast-json-stringify, the serializer of every response, repeats the value it could not write, and that is
// a field of a row: "The value "…" cannot be converted to an integer." The value may hold quotes, line breaks and the
// words that follow it, so it ends at the last of those words; a text without them runs to the end of its line.
const SERIALIZER_VALUE_PREFIX = 'The value "';
const SERIALIZER_VALUE_SUFFIX = '" cannot be converted to ';

// The same words inside a JSON text, such as the body of a refusal. Without both of them the text is not known to be
// the serializer's, and an upstream words its own refusals so.
const JSON_VALUE_PREFIX = 'The value \\"';
const JSON_VALUE_SUFFIX = '\\" cannot be converted to ';

function findLineEnd(text, from) {
  const end = text.indexOf(LINE_BREAK, from);

  return end === -1
    ? text.length
    : end;
}

function maskSerializerValue(text) {
  const start = text.indexOf(SERIALIZER_VALUE_PREFIX);

  if (start === -1) {
    return text;
  }

  const valueStart = start + SERIALIZER_VALUE_PREFIX.length;
  const suffixAt = text.lastIndexOf(SERIALIZER_VALUE_SUFFIX);
  const valueEnd = suffixAt < valueStart
    ? findLineEnd(text, valueStart)
    : suffixAt;

  return `${text.slice(0, valueStart)}${VALUE_MASK}${text.slice(valueEnd)}`;
}

function maskJsonValue(text) {
  const start = text.indexOf(JSON_VALUE_PREFIX);
  const valueStart = start + JSON_VALUE_PREFIX.length;
  const valueEnd = text.lastIndexOf(JSON_VALUE_SUFFIX);

  return start === -1 || valueEnd < valueStart
    ? text
    : `${text.slice(0, valueStart)}${VALUE_MASK}${text.slice(valueEnd)}`;
}

// For any text of an error on its way to a log, an alert or a response: what the database and the serializer
// repeat of the data is hidden, the names and the frames of a stack stay.
export function maskErrorValues(text) {
  if (!isString(text)) {
    return text;
  }

  return maskDbErrorValues(maskSerializerValue(maskJsonValue(text)));
}
