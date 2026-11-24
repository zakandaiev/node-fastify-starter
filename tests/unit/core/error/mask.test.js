import { maskErrorValues } from '#core/error/mask.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SECRET_VALUE = 'anna@example.com';

describe('maskErrorValues', () => {
  test('hides the value the serializer could not write, and keeps the type it wanted', () => {
    assert.equal(
      maskErrorValues(`The value "${SECRET_VALUE}" cannot be converted to an integer.`),
      'The value "***" cannot be converted to an integer.',
    );
    assert.equal(
      maskErrorValues('The value "not a date" cannot be converted to a date-time.'),
      'The value "***" cannot be converted to a date-time.',
    );
  });

  test('hides a value that holds quotes, a line break and the words that follow a value', () => {
    const value = 'a" cannot be converted to x\n"b';

    assert.equal(
      maskErrorValues(`The value "${value}" cannot be converted to a number.`),
      'The value "***" cannot be converted to a number.',
    );
  });

  test('keeps the frames of a stack that repeats the message', () => {
    const stack = [
      `Error: The value "${SECRET_VALUE}" cannot be converted to an integer.`,
      '    at asInteger (serializer.js:111:13)',
      '    at main (eval:1:1)',
    ].join('\n');

    assert.equal(maskErrorValues(stack), [
      'Error: The value "***" cannot be converted to an integer.',
      '    at asInteger (serializer.js:111:13)',
      '    at main (eval:1:1)',
    ].join('\n'));
  });

  test('takes the rest of the line for the value when the words after it are cut off', () => {
    assert.equal(maskErrorValues(`The value "${SECRET_VALUE}`), 'The value "***');
  });

  test('masks such a value also when it stands on a later line of the text', () => {
    assert.equal(
      maskErrorValues(`Error: first line\n  The value "${SECRET_VALUE} of the second\nlast line`),
      'Error: first line\n  The value "***\nlast line',
    );
  });

  test('hides such a value inside a JSON text as well, and leaves a text that only begins or only ends so', () => {
    const refusal = JSON.stringify({ error: { message: 'The value "abc" is not allowed for parameter x', code: 'invalid_param' } });

    assert.equal(
      maskErrorValues(JSON.stringify({ message: `The value "${SECRET_VALUE}" cannot be converted to an integer.`, code: 1 })),
      '{"message":"The value \\"***\\" cannot be converted to an integer.","code":1}',
    );
    assert.equal(
      maskErrorValues(JSON.stringify({ message: `The value "a" cannot be converted to ${SECRET_VALUE} "b" cannot be converted to a number.` })),
      '{"message":"The value \\"***\\" cannot be converted to a number."}',
    );
    assert.equal(
      maskErrorValues(JSON.stringify([
        { message: `The value "${SECRET_VALUE}" cannot be converted to an integer.` },
        { message: 'The value "b" cannot be converted to a number.' },
      ])),
      '[{"message":"The value \\"***\\" cannot be converted to a number."}]',
    );
    [refusal, JSON.stringify({ error: 'the date "abc" cannot be converted to a date', code: 'bad_date' })].forEach((text) => {
      assert.equal(maskErrorValues(text), text);
    });
  });

  test('keeps the frames of an error that only begins as the one of the serializer', () => {
    const stack = [
      `TypeError: The value "${SECRET_VALUE}" of the setting "theme" is unknown`,
      '    at readTheme (theme.js:7:11)',
      '    at main (app.js:1:1)',
    ].join('\n');

    assert.equal(maskErrorValues(stack), [
      'TypeError: The value "***',
      '    at readTheme (theme.js:7:11)',
      '    at main (app.js:1:1)',
    ].join('\n'));
  });

  test('masks what the database repeats as well', () => {
    assert.equal(
      maskErrorValues(`Duplicate entry '${SECRET_VALUE}' for key 'uq_users_email'`),
      "Duplicate entry '***' for key 'uq_users_email'",
    );
  });

  test('leaves any other text and a value that is not a text as they are', () => {
    assert.equal(maskErrorValues('"email" is required!'), '"email" is required!');
    assert.equal(maskErrorValues("The value of '#/properties/id' does not match schema definition."), "The value of '#/properties/id' does not match schema definition.");
    assert.equal(maskErrorValues(42), 42);
    assert.equal(maskErrorValues(null), null);
  });
});

describe('a response the serializer cannot write', () => {
  async function buildApp(t, env = {}) {
    const sink = createLogSink();
    const fastify = await buildTestApp({ env, logger: { level: 'info', stream: sink.stream } });

    t.after(() => fastify.close());
    fastify.get('/count', {
      schema: { response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { count: { type: 'integer' } } } } } } },
    }, async (request, reply) => reply.ok({ count: SECRET_VALUE }));

    return { fastify, sink };
  }

  test('logs the failure without the value of the row', async (t) => {
    const { fastify, sink } = await buildApp(t);
    const response = await fastify.inject('/count');
    const [line] = findLogLines(sink, 'Request failed');

    assert.equal(response.statusCode, 500);
    assert.equal(line.err.message, 'The value "***" cannot be converted to an integer.');
    assert.equal(JSON.stringify(sink.lines).includes(SECRET_VALUE), false);
  });

  test('tells a developer what failed in dev mode, still without the value', async (t) => {
    const { fastify } = await buildApp(t, { APP_MODE: 'dev' });
    const response = await fastify.inject('/count');

    assert.equal(response.statusCode, 500);
    assert.equal(response.json().message, 'The value "***" cannot be converted to an integer.');
    assert.equal(response.body.includes(SECRET_VALUE), false);
  });
});
