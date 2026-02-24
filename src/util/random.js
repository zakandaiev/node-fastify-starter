import { toNumber } from '#src/util/misc.js';
import { getRandomValues } from 'node:crypto';

function randomInt(mi, ma) {
  const min = toNumber(mi);
  const max = toNumber(ma);
  return Math.floor(Math.random() * (max - min + 1) + min);
}

function randomFloat(mi, ma) {
  const min = toNumber(mi);
  const max = toNumber(ma);
  return Math.random() * (max - min) + min;
}

function randomString() {
  return Math.random().toString(32).replace('0.', '');
}

function randomUUIDv7(returnBytes = false) {
  const value = new Uint8Array(16);
  getRandomValues(value);

  const timestamp = BigInt(Date.now());

  /* eslint-disable no-bitwise */
  value[0] = Number((timestamp >> 40n) & 0xffn);
  value[1] = Number((timestamp >> 32n) & 0xffn);
  value[2] = Number((timestamp >> 24n) & 0xffn);
  value[3] = Number((timestamp >> 16n) & 0xffn);
  value[4] = Number((timestamp >> 8n) & 0xffn);
  value[5] = Number(timestamp & 0xffn);

  value[6] = (value[6] & 0x0f) | 0x70;
  value[8] = (value[8] & 0x3f) | 0x80;

  return returnBytes
    ? value
    : Array.from(value)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
}

export {
  randomFloat,
  randomInt,
  randomString,
  randomUUIDv7,
};
