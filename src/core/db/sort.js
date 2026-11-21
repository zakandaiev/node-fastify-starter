import { getPath } from '#utils/object.js';
import {
  isArray,
  isNonEmptyString,
  isObject,
  isString,
} from '#utils/type.js';

export const SORT_PARAMETER = 'sort';

const SIGNATURE = 'buildSort(schema, payload)';
const ENTRIES_SIGNATURE = 'readSortEntries(schema)';

const entriesBySchema = new WeakMap();

export function assertSortEntries(sort, signature) {
  if (!isArray(sort)) {
    throw new TypeError(`${signature} requires "sort" to be a list of entries`);
  }

  const values = sort.map((entry) => entry?.value);

  if (!values.every((value) => isNonEmptyString(value)) || new Set(values).size !== values.length) {
    throw new TypeError(`${signature} requires every entry of "sort" to have a "value" of its own`);
  }

  if (sort.filter((entry) => entry.isDefault === true).length > 1) {
    throw new TypeError(`${signature}: "sort" has more than one entry with isDefault`);
  }

  const unordered = sort.find((entry) => !isNonEmptyString(entry.orderBy));

  if (unordered !== undefined) {
    throw new TypeError(`${signature} requires every entry of "sort" to have an "orderBy" text, and "${unordered.value}" has none`);
  }
}

function readEntries(schema, signature) {
  if (!isObject(schema)) {
    throw new TypeError(`${signature} requires a schema: an object that may export "sort"`);
  }

  if (!entriesBySchema.has(schema)) {
    const entries = schema.sort ?? [];

    assertSortEntries(entries, signature);
    entriesBySchema.set(schema, entries);
  }

  return entriesBySchema.get(schema);
}

// The entries buildSort() applies, read once for each schema object: schema.sort may differ from them later.
export function readSortEntries(schema) {
  return readEntries(schema, ENTRIES_SIGNATURE);
}

function readCode(payload) {
  if (!isObject(payload)) {
    throw new TypeError(`${SIGNATURE} requires payload to be a plain object, such as request.query`);
  }

  const code = getPath(payload, [SORT_PARAMETER]);

  if (code !== undefined && !isString(code)) {
    throw new TypeError(`${SIGNATURE} requires "${SORT_PARAMETER}" of the payload to be the code of an entry: name it in .query() of the route`);
  }

  return code;
}

function findEntry(entries, code) {
  const named = entries.find((entry) => entry.value === code);

  return named ?? entries.find((entry) => entry.isDefault === true) ?? null;
}

export function buildSort(schema, payload = {}) {
  const entries = readEntries(schema, SIGNATURE);
  const applied = findEntry(entries, readCode(payload));

  return {
    orderBy: applied?.orderBy ?? null,
    sort: entries.map((entry) => ({
      label: entry.label ?? entry.value,
      value: entry.value,
      isChecked: entry === applied,
      isDefault: entry.isDefault === true,
    })),
  };
}
