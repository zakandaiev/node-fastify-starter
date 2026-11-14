import { createLogger } from '#core/logger/index.js';
import { createLogSink, parseLogLines } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('createLogSink', () => {
  test('holds the lines of a logger as objects as soon as the log call returns', () => {
    const sink = createLogSink();
    const log = createLogger({ level: 'info', stream: sink.stream });

    log.info({ userId: 7 }, 'first');
    log.debug('below the level');
    log.warn('second');

    assert.deepEqual(sink.lines.map((line) => [line.level, line.msg, line.userId]), [
      [30, 'first', 7],
      [40, 'second', undefined],
    ]);
  });
});

describe('parseLogLines', () => {
  test('reads every line of JSON as an object and passes over the empty ones', () => {
    assert.deepEqual(parseLogLines('{"msg":"first"}\n\n{"msg":"second","level":30}\n'), [
      { msg: 'first' },
      { msg: 'second', level: 30 },
    ]);
    assert.deepEqual(parseLogLines(''), []);
  });

  test('throws on a line that is not JSON: readable logs are not parsed', () => {
    assert.throws(() => parseLogLines('{"msg":"first"}\nINFO: Server started\n'), SyntaxError);
  });
});
