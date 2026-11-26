import { Writable } from 'node:stream';

export const LOG_LEVEL = Object.freeze({
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
});

// pino writes to the stream synchronously inside the log call: the lines are there as soon as the call returns.
// Usage: buildTestApp({ logger: { level: 'info', stream: sink.stream } }) - the level of the test config is "silent".
export function createLogSink() {
  const lines = [];
  const stream = new Writable({
    write(chunk, encoding, callback) {
      lines.push(JSON.parse(chunk.toString()));
      callback();
    },
  });

  return { lines, stream };
}

// The start of an app writes lines of its own, a warning among them (no provider of the tests has credentials, nobody
// can sign in): a test that reads every line of its requests forgets them first.
export function forgetLines(sink) {
  sink.lines.length = 0;

  return sink;
}

export function findLogLines(sink, message) {
  return sink.lines.filter((line) => line.msg === message);
}

// The lines a process has printed in JSON, one object for each: a line that is not JSON throws.
export function parseLogLines(stdout) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
