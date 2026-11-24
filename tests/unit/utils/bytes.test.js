import { createByteCollector } from '#utils/bytes.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SMALL = 8;
// Above the room a collector starts with, so the buffer has to grow.
const LARGE = 100 * 1024;
const CEILING = 5 * 1024 * 1024;
const START_SIZE = 16 * 1024;
// A list of the chunks of LARGE bytes holds about 12 MiB.
const HELD_MAX_BYTES = 2 * 1024 * 1024;
const TIME_LIMIT_MS = 1000;

function collect(chunks, maxBytes) {
  const collector = createByteCollector(maxBytes);

  return { added: chunks.map((chunk) => collector.add(chunk)), bytes: collector.read() };
}

describe('createByteCollector', () => {
  test('gives the bytes of its chunks in order, as many as came', () => {
    const { added, bytes } = collect([Buffer.from('ab'), Uint8Array.from([99]), Buffer.alloc(0), Buffer.from('de')], SMALL);

    assert.deepEqual(added, [true, true, true, true]);
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.toString(), 'abcde');
    assert.equal(createByteCollector(SMALL).read().length, 0);
  });

  test('takes bytes up to its ceiling, and refuses a chunk that does not fit without taking a part of it', () => {
    const { added, bytes } = collect([Buffer.alloc(SMALL, 'a'), Buffer.from('b')], SMALL);

    assert.deepEqual(added, [true, false]);
    assert.equal(bytes.toString(), 'a'.repeat(SMALL));
    assert.deepEqual(collect([Buffer.alloc(SMALL + 1)], SMALL).added, [false]);
  });

  test('grows as the chunks need: a chunk above the room it starts with, then one more', () => {
    const { added, bytes } = collect([Buffer.alloc(LARGE, 'a'), Buffer.alloc(LARGE, 'b')], LARGE * 2);

    assert.deepEqual(added, [true, true]);
    assert.equal(bytes.toString(), `${'a'.repeat(LARGE)}${'b'.repeat(LARGE)}`);
    assert.equal(collect([Buffer.alloc(LARGE), Buffer.alloc(SMALL)], LARGE + SMALL).bytes.buffer.byteLength, LARGE + SMALL);
  });

  test('keeps the memory of a body that comes byte by byte near its size, and takes none for what has not come', () => {
    const byte = Buffer.from('x');
    const collector = createByteCollector(CEILING);
    const startedAt = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let index = 0; index < LARGE; index += 1) {
      collector.add(byte);
    }

    const heldBytes = process.memoryUsage().heapUsed - heapBefore;

    assert.equal(collector.read().length, LARGE);
    assert.ok(heldBytes < HELD_MAX_BYTES, `${heldBytes} bytes held for ${LARGE}`);
    assert.ok(performance.now() - startedAt < TIME_LIMIT_MS);

    const small = createByteCollector(CEILING);

    small.add(Buffer.alloc(SMALL));

    assert.equal(small.read().buffer.byteLength, START_SIZE);
  });

  test('copies a chunk: a buffer the stream uses again does not change what was collected', () => {
    const chunk = Buffer.from('ab');
    const collector = createByteCollector(SMALL);

    collector.add(chunk);
    chunk.fill('z');

    assert.equal(collector.read().toString(), 'ab');
  });

  test('requires a positive integer', () => {
    [0, -1, 1.5, '8', null, undefined, Number.NaN].forEach((maxBytes) => {
      assert.throws(() => createByteCollector(maxBytes), { name: 'TypeError', message: 'createByteCollector(maxBytes) requires a positive integer' });
    });
  });
});
