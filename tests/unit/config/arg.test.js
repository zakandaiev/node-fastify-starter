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
    assert.throws(() => readArgs(['host'], ['--host=']), /--host must not be empty/);
    assert.throws(() => readArgs(['host'], ['--host']), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' });
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
