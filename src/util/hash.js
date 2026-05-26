/* eslint-disable no-bitwise */
import { isString } from '#src/util/misc.js';

function hashFnv32(input, seed = 0x811c9dc5) {
  const str = isString(input)
    ? input
    : JSON.stringify(input);

  let h = seed;

  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }

  return h >>> 0;
}

function hash(input, length = 16) {
  const str = isString(input)
    ? input
    : JSON.stringify(input);

  let result = '';
  let seed;

  while (result.length < length) {
    seed = hashFnv32(str, seed);
    result += seed.toString(36);
  }

  return result.slice(0, length);
}

export {
  hash,
  hashFnv32,
};
