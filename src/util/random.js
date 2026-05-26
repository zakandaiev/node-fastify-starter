/* eslint-disable no-bitwise */
import { getRandomValues } from 'node:crypto';

export function randomInt(min = 0, max = 100) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

export function randomFloat(min = 0, max = 100) {
  return Math.random() * (max - min) + min;
}

export function randomString(length = 16) {
  return [...getRandomValues(new Uint8Array(length))]
    .map((x) => (x % 36).toString(36))
    .join('');
}

export function randomUUIDv7(returnBytes = false) {
  const value = new Uint8Array(16);
  getRandomValues(value);

  const timestamp = BigInt(Date.now());

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
      .map((b, i) => (i === 4 || i === 6 || i === 8 || i === 10 ? '-' : '') + b.toString(16).padStart(2, '0'))
      .join('');
}
