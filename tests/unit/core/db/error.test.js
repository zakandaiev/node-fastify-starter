import { maskDbErrorValues } from '#core/db/error.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('maskDbErrorValues', () => {
  test('hides the duplicate value and keeps the name of the index', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry 'john@example.com' for key 'uq_users_email'"),
      "Duplicate entry '***' for key 'uq_users_email'",
    );
  });

  test('hides a value that holds quotes or the text of the message itself', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry 'o'brien' for key 'x' for key 'uq_users_name'"),
      "Duplicate entry '***' for key 'uq_users_name'",
    );
  });

  test('hides the value on every line of a stack', () => {
    const stack = [
      "Error: Duplicate entry '380501234567' for key 'uq_users_phone'",
      '    at PromisePool.query (node_modules/mysql2/promise.js:1:1)',
      "  cause: Duplicate entry 'second@example.com' for key 'uq_users_email'",
    ].join('\n');

    assert.equal(maskDbErrorValues(stack), [
      "Error: Duplicate entry '***' for key 'uq_users_phone'",
      '    at PromisePool.query (node_modules/mysql2/promise.js:1:1)',
      "  cause: Duplicate entry '***' for key 'uq_users_email'",
    ].join('\n'));
  });

  test('leaves a text without a duplicate entry as it is', () => {
    const text = "Unknown column 'nickname' in 'field list'";

    assert.equal(maskDbErrorValues(text), text);
    assert.equal(maskDbErrorValues(''), '');
  });

  test('hides the rest of a message that is cut before the name of the index', () => {
    assert.equal(maskDbErrorValues("Duplicate entry 'john@example.com"), "Duplicate entry '***");
    assert.equal(maskDbErrorValues("Error: Duplicate entry 'john@exa…"), "Error: Duplicate entry '***");
  });

  test('hides an entry that is cut after a complete one: on a later line, on the same line, inside the suffix', () => {
    assert.equal(
      maskDbErrorValues("Error: Duplicate entry 'a@b.c' for key 'uq_users_email'\ncaused by: Error: Duplicate entry 'john@exa…"),
      "Error: Duplicate entry '***' for key 'uq_users_email'\ncaused by: Error: Duplicate entry '***",
    );
    assert.equal(
      maskDbErrorValues("Sign-up failed: Duplicate entry 'a@b.c' for key 'uq_users_email': Duplicate entry 'john@exa…"),
      "Sign-up failed: Duplicate entry '***' for key 'uq_users_email': Duplicate entry '***",
    );
    assert.equal(
      maskDbErrorValues("Duplicate entry 'a' for key 'uq_a'\n    at query (pool.js:1:1)\nDuplicate entry 'john@example.com' for k…"),
      "Duplicate entry '***' for key 'uq_a'\n    at query (pool.js:1:1)\nDuplicate entry '***",
    );
  });

  test('hides the lines of a value whose entry does not start its line: cut after a complete entry, or between two entries', () => {
    assert.equal(
      maskDbErrorValues("Sign-up failed: Duplicate entry 'a@b.c' for key 'uq_users_email': Duplicate entry 'first line\nsecond line of the val…"),
      "Sign-up failed: Duplicate entry '***' for key 'uq_users_email': Duplicate entry '***",
    );
    assert.equal(
      maskDbErrorValues("Import failed: Duplicate entry 'a@b.c' for key 'uq_users_email'; Duplicate entry 'first line\nsecond line' for key 'uq_notes_text'; Duplicate entry '380501234567' for key 'uq_users_phone'"),
      "Import failed: Duplicate entry '***' for key 'uq_users_phone'",
    );
  });

  test('hides the lines of a value that is cut before the name of the index', () => {
    assert.equal(maskDbErrorValues("Duplicate entry 'first line\nsecond line of the val…"), "Duplicate entry '***");
  });

  test('keeps the name of the index of an empty value', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry '' for key 'uq_users_nickname'"),
      "Duplicate entry '***' for key 'uq_users_nickname'",
    );
  });

  test('hides a value that holds a line break', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry 'first line\nsecond line' for key 'uq_notes_text'"),
      "Duplicate entry '***' for key 'uq_notes_text'",
    );
  });

  test('hides the whole of a value whose first line ends like the message itself', () => {
    assert.equal(
      maskDbErrorValues("Duplicate entry 'o'brien' for key 'x'\nsecond line of the value' for key 'uq_users_email'"),
      "Duplicate entry '***' for key 'uq_users_email'",
    );
  });

  test('keeps a text that is already masked as it is', () => {
    const text = "Duplicate entry '***' for key 'uq_users_email'";

    assert.equal(maskDbErrorValues(text), text);
  });

  test('returns what is not a string untouched', () => {
    const error = new Error("Duplicate entry 'a' for key 'b'");

    assert.equal(maskDbErrorValues(error), error);
    assert.equal(maskDbErrorValues(null), null);
    assert.equal(maskDbErrorValues(undefined), undefined);
    assert.equal(maskDbErrorValues(42), 42);
  });

  test('answers instantly on a long hostile input', () => {
    const startedAt = performance.now();

    maskDbErrorValues("Duplicate entry '".repeat(50000));
    maskDbErrorValues("Duplicate entry 'a' for key 'b' ".repeat(50000));
    maskDbErrorValues("Duplicate entry 'a' for key 'b'\n".repeat(50000));

    assert.ok(performance.now() - startedAt < 500);
  });
});
