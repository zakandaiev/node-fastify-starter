import { readArgs } from '#config/arg.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('readArgs', () => {
  test('returns only the arguments that were passed', () => {
    assert.deepEqual(readArgs(['port', 'host'], []), {});
    assert.deepEqual(readArgs(['port', 'host'], ['--port=5000']), { port: 5000 });
    assert.deepEqual(readArgs(['port', 'host'], ['--port', '5000', '--host=0.0.0.0']), { port: 5000, host: '0.0.0.0' });
  });

  test('takes the last value of a repeated argument', () => {
    assert.deepEqual(readArgs(['port'], ['--port=5000', '--port=6000']), { port: 6000 });
  });

  test('keeps port 0, which lets the system choose a free one', () => {
    assert.deepEqual(readArgs(['port'], ['--port=0']), { port: 0 });
  });

  test('rejects a port that is not a non-negative integer', () => {
    ['abc', '', '50.5', '-1', '5000x', '1e3', ' 5000'].forEach((value) => {
      assert.throws(() => readArgs(['port'], [`--port=${value}`]), /--port must be a non-negative integer/);
    });
  });

  test('rejects an empty host and an argument without a value', () => {
    assert.throws(() => readArgs(['host'], ['--host=']), { message: '--host must not be empty' });
    assert.throws(() => readArgs(['host'], ['--host']), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' });
  });

  test('reads --output as the path it was given', () => {
    assert.deepEqual(readArgs(['output'], ['--output=docs/openapi.json']), { output: 'docs/openapi.json' });
    assert.deepEqual(readArgs(['output'], ['--output', 'D:\\API Docs\\openapi.json']), { output: 'D:\\API Docs\\openapi.json' });
    assert.deepEqual(readArgs(['output'], ['--output=first.json', '--output=second.json']), { output: 'second.json' });
    assert.deepEqual(readArgs(['output'], []), {});
  });

  test('rejects an empty --output and one without a value, by its own name', () => {
    assert.throws(() => readArgs(['output'], ['--output=']), { message: '--output must not be empty' });
    assert.throws(() => readArgs(['output'], ['--output']), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' });
    assert.throws(() => readArgs(['output', 'host'], ['--output=out.json', '--host=']), { message: '--host must not be empty' });
  });

  test('rejects an argument the entrypoint did not ask for', () => {
    assert.throws(() => readArgs(['port'], ['--host=0.0.0.0']), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
    assert.throws(() => readArgs(['port'], ['--prot=5000']), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
    assert.throws(() => readArgs(['port'], ['5000']), { code: 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' });
  });

  test('rejects a name that is not declared', () => {
    assert.throws(() => readArgs(['unknown'], []), /--unknown is not declared/);
  });
});

describe('readArgs: migrations', () => {
  const NAMES = ['direction', 'type', 'names', 'names-exclude', 'dry-run'];

  test('reads the direction and the type as they are and the names as lists', () => {
    assert.deepEqual(readArgs(NAMES, ['--direction=up', '--type=seed', '--names=users,sessions', '--names-exclude=groups']), {
      direction: 'up',
      type: 'seed',
      names: ['users', 'sessions'],
      'names-exclude': ['groups'],
    });
  });

  test('accepts every direction and both types, and no other', () => {
    ['up', 'down', 'status', 'make', 'verify', 'fresh'].forEach((direction) => {
      assert.deepEqual(readArgs(NAMES, [`--direction=${direction}`]), { direction });
    });
    ['migration', 'seed'].forEach((type) => assert.deepEqual(readArgs(NAMES, [`--type=${type}`]), { type }));

    ['', 'UP', 'rollback', 'up,down'].forEach((direction) => {
      assert.throws(
        () => readArgs(NAMES, [`--direction=${direction}`]),
        /--direction must be one of: up, down, status, make, verify, fresh/,
      );
    });
    ['', 'seeds', 'Migration'].forEach((type) => {
      assert.throws(() => readArgs(NAMES, [`--type=${type}`]), /--type must be one of: migration, seed/);
    });
  });

  test('joins a list that is given twice', () => {
    assert.deepEqual(
      readArgs(NAMES, ['--names=users', '--names-exclude=groups', '--names=sessions,audit_logs', '--names-exclude', 'scopes']),
      { names: ['users', 'sessions', 'audit_logs'], 'names-exclude': ['groups', 'scopes'] },
    );
  });

  test('refuses a direction or a type that is given twice: what follows the one of an npm script must not replace it', () => {
    assert.throws(() => readArgs(NAMES, ['--direction=status', '--direction=down']), /--direction is given twice: status, down/);
    assert.throws(() => readArgs(NAMES, ['--direction=up', '--direction', 'up']), /--direction is given twice: up, up/);
    assert.throws(() => readArgs(NAMES, ['--type=seed', '--direction=up', '--type=migration']), /--type is given twice: seed, migration/);
  });

  test('refuses an argument that npm has taken for itself: one written before "--" never reaches the script', () => {
    const cases = {
      'dry-run': { npm_config_dry_run: 'true' },
      names: { npm_config_names: 'users' },
      'names-exclude': { npm_config_names_exclude: 'users' },
      type: { npm_config_type: 'seed' },
    };

    Object.entries(cases).forEach(([name, env]) => {
      assert.throws(
        () => readArgs(NAMES, ['--direction=down'], env),
        new RegExp(`--${name} was given to npm, not to the script: put it after "--", as in "npm run <script> -- --${name}"`),
      );
    });
    assert.throws(() => readArgs(['port', 'host'], [], { npm_config_port: '5000' }), /--port was given to npm/);
    assert.deepEqual(readArgs(NAMES, ['--direction=down', '--dry-run'], { npm_config_dry_run: 'true' }), { direction: 'down', 'dry-run': true });
    assert.deepEqual(readArgs(NAMES, ['--direction=down'], { npm_config_user_agent: 'npm/11', npm_config_cache: '/tmp' }), { direction: 'down' });
  });

  test('trims the names of a list and refuses an empty one among them', () => {
    assert.deepEqual(readArgs(NAMES, ['--names', ' users , sessions ']), { names: ['users', 'sessions'] });
    assert.throws(() => readArgs(NAMES, ['--names=users', '--names=']), /--names must be a list of names separated by commas/);

    ['', ',', 'users,', ',users', 'users,,sessions', ' '].forEach((value) => {
      assert.throws(() => readArgs(NAMES, [`--names=${value}`]), /--names must be a list of names separated by commas/);
      assert.throws(() => readArgs(NAMES, [`--names-exclude=${value}`]), /--names-exclude must be a list of names separated by commas/);
    });
  });

  test('reads --dry-run as a flag that takes no value', () => {
    assert.deepEqual(readArgs(NAMES, ['--dry-run']), { 'dry-run': true });
    assert.deepEqual(readArgs(NAMES, ['--dry-run', '--dry-run']), { 'dry-run': true });
    assert.deepEqual(readArgs(NAMES, []), {});
    assert.throws(() => readArgs(NAMES, ['--dry-run=true']), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' });
    assert.throws(() => readArgs(NAMES, ['--dry-run', 'true']), { code: 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' });
  });
});
