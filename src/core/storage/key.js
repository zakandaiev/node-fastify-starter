import { UUID_LENGTH, UUID_REGEXP, uuidv7 } from '#utils/id.js';
import { MIME_EXTENSIONS } from '#utils/mime.js';
import { escapeRegExp } from '#utils/string.js';
import { isString } from '#utils/type.js';

const EXTENSION_SEPARATOR = '.';

// The UUID without the anchors of UUID_REGEXP: the extension follows it.
const UUID_PATTERN = UUID_REGEXP.source.slice(1, -1);
const EXTENSION_PATTERN = MIME_EXTENSIONS.map((extension) => escapeRegExp(extension)).join('|');

// Lower-case hex, hyphens and one dot only: a key is a file name of its own, never a path out of the root.
export const STORAGE_KEY_REGEXP = new RegExp(`^${UUID_PATTERN}${escapeRegExp(EXTENSION_SEPARATOR)}(?:${EXTENSION_PATTERN})$`);

export const STORAGE_KEY_MAX_LENGTH = UUID_LENGTH
  + EXTENSION_SEPARATOR.length
  + Math.max(...MIME_EXTENSIONS.map((extension) => extension.length));

export function isStorageKey(key) {
  return isString(key)
    && key.length <= STORAGE_KEY_MAX_LENGTH
    && STORAGE_KEY_REGEXP.test(key);
}

export function toStorageKey(extension) {
  if (!MIME_EXTENSIONS.includes(extension)) {
    throw new TypeError(`toStorageKey(extension) requires one of the extensions ${MIME_EXTENSIONS.join(', ')}`);
  }

  return `${uuidv7()}${EXTENSION_SEPARATOR}${extension}`;
}
