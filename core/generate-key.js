/*
  Generate cryptographically-strong random secret keys.

  Usage:
    npm run generate:key                -> one 48-byte base64url key
    npm run generate:key -- --bytes=64  -> one 64-byte key
    npm run generate:key -- --count=3   -> N keys
*/

/* eslint-disable no-console */

import { processArg } from '#core/app.js';
import { randomBytes } from 'node:crypto';

export function generateKey(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}

const bytes = Number(processArg.bytes) || 48;
const count = Number(processArg.count) || 1;

for (let i = 0; i < count; i += 1) {
  console.log(`✅ Key #${i + 1}: ${generateKey(bytes)}`);
}
