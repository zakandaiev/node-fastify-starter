import { isPositiveInteger } from '#utils/type.js';

const INITIAL_SIZE = 16 * 1024;
const GROWTH = 2;

function grow(state, size, maxBytes) {
  const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(INITIAL_SIZE, size, state.buffer.length * GROWTH)));

  buffer.set(state.buffer.subarray(0, state.size));
  state.buffer = buffer;
}

// Bytes that come in chunks, up to a ceiling, copied into one buffer: a chunk kept as it came costs objects of its
// own, and a body sent byte by byte would take hundreds of times its size. add() is false when a chunk does not fit.
export function createByteCollector(maxBytes) {
  if (!isPositiveInteger(maxBytes)) {
    throw new TypeError('createByteCollector(maxBytes) requires a positive integer');
  }

  const state = { buffer: Buffer.alloc(0), size: 0 };

  function add(chunk) {
    const size = state.size + chunk.byteLength;

    if (size > maxBytes) {
      return false;
    }

    if (size > state.buffer.length) {
      grow(state, size, maxBytes);
    }

    state.buffer.set(chunk, state.size);
    state.size = size;

    return true;
  }

  function read() {
    return state.buffer.subarray(0, state.size);
  }

  return { add, read };
}
