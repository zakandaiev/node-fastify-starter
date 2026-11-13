import { randomBytes } from 'node:crypto';

const KEY_BYTES = 48;

console.log(randomBytes(KEY_BYTES).toString('base64url'));
