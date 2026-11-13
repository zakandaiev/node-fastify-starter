import { argv } from 'node:process';
import { parseArgs } from 'node:util';

function toPort(value) {
  if (!/^\d+$/.test(value)) {
    throw new Error('--port must be a non-negative integer');
  }

  return Number(value);
}

function toHost(value) {
  if (value === '') {
    throw new Error('--host must not be empty');
  }

  return value;
}

const ARG_PARSERS = Object.freeze({
  port: toPort,
  host: toHost,
});

export function readArgs(names, args = argv.slice(2)) {
  const unknownName = names.find((name) => !Object.hasOwn(ARG_PARSERS, name));

  if (unknownName) {
    throw new Error(`Argument --${unknownName} is not declared in src/config/arg.js`);
  }

  const { values } = parseArgs({
    args,
    options: Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
  });

  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, ARG_PARSERS[name](value)]),
  );
}
