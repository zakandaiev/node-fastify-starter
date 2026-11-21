import { absPath } from '#config/path.js';
import { isNonEmptyString, isObject, isString } from '#utils/type.js';
import { readdir } from 'node:fs/promises';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

const ENTITY_DIRECTORY = nodePath.join(absPath.schema, 'entity');
const MODULE_EXTENSION = '.js';

const SIGNATURE = 'loadUniqueFields(directory)';

async function importSchemas(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(MODULE_EXTENSION))
    .map((entry) => entry.name)
    .toSorted();

  return Promise.all(names.map(async (name) => ({
    name,
    schema: await import(pathToFileURL(nodePath.join(directory, name)).href),
  })));
}

function readUniqueEntries({ name, schema }) {
  const { unique, properties } = schema;

  if (unique === undefined) {
    return [];
  }

  if (!isObject(unique)) {
    throw new TypeError(`${SIGNATURE}: "unique" of ${name} must map the name of an index to a field of the API`);
  }

  return Object.entries(unique).map(([index, field]) => {
    if (!isString(field) || !isObject(properties) || !Object.hasOwn(properties, field)) {
      throw new TypeError(`${SIGNATURE}: the index "${index}" in "unique" of ${name} must name a field of its "properties"`);
    }

    return { index, field, name };
  });
}

function mergeUniqueEntries(entries) {
  const owners = new Map();

  entries.forEach(({ index, name }) => {
    if (owners.has(index)) {
      throw new TypeError(`${SIGNATURE}: the index "${index}" is in "unique" of both ${owners.get(index)} and ${name}`);
    }

    owners.set(index, name);
  });

  return Object.freeze(Object.fromEntries(entries.map(({ index, field }) => [index, field])));
}

export async function loadUniqueFields(directory = ENTITY_DIRECTORY) {
  if (!isNonEmptyString(directory)) {
    throw new TypeError(`${SIGNATURE} requires the path of a directory`);
  }

  const schemas = await importSchemas(directory);

  return mergeUniqueEntries(schemas.flatMap((schema) => readUniqueEntries(schema)));
}
