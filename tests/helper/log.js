import { Writable } from 'node:stream';

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

// The lines a process has printed in JSON, one object for each: a line that is not JSON throws.
export function parseLogLines(stdout) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
