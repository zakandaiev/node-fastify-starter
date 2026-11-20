import { readSystemEnv } from '#config/env.js';
import { MIGRATION_DIRECTION } from '#enums/migration-direction.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { argv } from 'node:process';
import { parseArgs } from 'node:util';

const STRING = 'string';
const BOOLEAN = 'boolean';
const LIST_SEPARATOR = ',';
const NPM_CONFIG_PREFIX = 'npm_config_';

function toPort(value) {
  if (!/^\d+$/.test(value)) {
    throw new Error('--port must be a non-negative integer');
  }

  return Number(value);
}

function toNonEmpty(value, name) {
  if (value === '') {
    throw new Error(`--${name} must not be empty`);
  }

  return value;
}

// An npm script names its own direction, and what is added after "--" comes second: taken as "the last one
// wins", "npm run migrate:status -- --direction=down" would roll back.
function toChoice(values, name, choices) {
  if (values.length > 1) {
    throw new Error(`--${name} is given twice: ${values.join(', ')}`);
  }

  if (!choices.includes(values[0])) {
    throw new Error(`--${name} must be one of: ${choices.join(', ')}`);
  }

  return values[0];
}

function toDirection(values, name) {
  return toChoice(values, name, Object.values(MIGRATION_DIRECTION));
}

function toMigrationType(values, name) {
  return toChoice(values, name, Object.values(MIGRATION_TYPE));
}

// A list given twice is one list: of a repeated argument parseArgs would keep the last value only,
// and "--names-exclude=a --names-exclude=b" would silently exclude "b" alone.
function toNames(values, name) {
  const names = values.flatMap((value) => value.split(LIST_SEPARATOR)).map((item) => item.trim());

  if (names.includes('')) {
    throw new Error(`--${name} must be a list of names separated by commas, such as --${name}=users,sessions`);
  }

  return names;
}

// A flag takes no value: "--dry-run" is true, and parseArgs refuses "--dry-run=true".
const ARGS = Object.freeze({
  port: { type: STRING, parse: toPort },
  host: { type: STRING, parse: toNonEmpty },
  output: { type: STRING, parse: toNonEmpty },
  direction: { type: STRING, multiple: true, parse: toDirection },
  type: { type: STRING, multiple: true, parse: toMigrationType },
  names: { type: STRING, multiple: true, parse: toNames },
  'names-exclude': { type: STRING, multiple: true, parse: toNames },
  'dry-run': { type: BOOLEAN },
});

function parseValue(name, value) {
  const { parse } = ARGS[name];

  return parse
    ? parse(value, name)
    : value;
}

function toOption(name) {
  const { type, multiple = false } = ARGS[name];

  return [name, { type, multiple }];
}

// An argument written before "--" is taken by npm, which then runs the script without it and without a word:
// "npm run migrate:down --dry-run" would roll back for real. npm leaves what it took in the environment.
function assertNotTakenByNpm(names, values, env) {
  const taken = names.find((name) => !Object.hasOwn(values, name) && Object.hasOwn(env, `${NPM_CONFIG_PREFIX}${name.replaceAll('-', '_')}`));

  if (taken) {
    throw new Error(`--${taken} was given to npm, not to the script: put it after "--", as in "npm run <script> -- --${taken}"`);
  }
}

export function readArgs(names, args = argv.slice(2), env = readSystemEnv()) {
  const unknownName = names.find((name) => !Object.hasOwn(ARGS, name));

  if (unknownName) {
    throw new Error(`Argument --${unknownName} is not declared in src/config/arg.js`);
  }

  const { values } = parseArgs({
    args,
    options: Object.fromEntries(names.map((name) => toOption(name))),
  });

  assertNotTakenByNpm(names, values, env);

  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, parseValue(name, value)]),
  );
}
