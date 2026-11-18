import { rejectionOf, waitFor } from '#root/tests/helper/async.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('waitFor', () => {
  test('resolves with the first value that is there, a zero and an empty text included', async () => {
    const values = [undefined, null, false, 0];
    const read = () => values.shift();

    assert.equal(await waitFor(read, 'a value'), 0);
    assert.deepEqual(values, []);
    assert.equal(await waitFor(async () => '', 'a text'), '');
  });

  test('rejects, naming what it waited for, when nothing came within the checks it was given', async () => {
    let calls = 0;

    function read() {
      calls += 1;

      return null;
    }

    await assert.rejects(waitFor(read, 'a session of the script', 2), /^Error: Timed out waiting for a session of the script$/);
    assert.equal(calls, 3);
  });

  test('rejects with the error of the read', async () => {
    await assert.rejects(waitFor(() => Promise.reject(new Error('The database is down')), 'a row'), /The database is down/);
  });
});

describe('rejectionOf', () => {
  test('resolves with the error a promise rejects with', async () => {
    const error = new Error('Refused');

    assert.equal(await rejectionOf(Promise.reject(error)), error);
  });

  test('fails for a promise that resolves', async () => {
    await assert.rejects(rejectionOf(Promise.resolve(1)), /The promise was expected to reject/);
  });
});
