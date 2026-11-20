import { freezeDeep } from '#utils/object.js';
import { isString } from '#utils/type.js';
import { MIMEType } from 'node:util';
import { isUint8Array } from 'node:util/types';

const ANY_BYTE = null;

// Bytes 4-7 of a RIFF container hold its size, and "RIFF" alone is also WAV and AVI: only "WEBP" at 8 makes it a WebP.
const RIFF_SIZE_FIELD = Object.freeze([ANY_BYTE, ANY_BYTE, ANY_BYTE, ANY_BYTE]);

function ascii(text) {
  return Array.from(text, (char) => char.charCodeAt(0));
}

const REGISTRY = freezeDeep([
  { type: 'image/jpeg', extension: 'jpg', signatures: [[0xFF, 0xD8, 0xFF]] },
  { type: 'image/png', extension: 'png', signatures: [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]] },
  { type: 'image/webp', extension: 'webp', signatures: [[...ascii('RIFF'), ...RIFF_SIZE_FIELD, ...ascii('WEBP')]] },
  { type: 'image/gif', extension: 'gif', signatures: [ascii('GIF87a'), ascii('GIF89a')] },
  { type: 'application/pdf', extension: 'pdf', signatures: [ascii('%PDF-')] },
]);

export const MIME_WHITELIST = Object.freeze(REGISTRY.map(({ type }) => type));

export const MIME_SIGNATURE_BYTES = Math.max(
  ...REGISTRY.flatMap(({ signatures }) => signatures.map((signature) => signature.length)),
);

function matchesSignature(bytes, signature) {
  return bytes.length >= signature.length
    && signature.every((byte, index) => byte === ANY_BYTE || bytes[index] === byte);
}

export function detectMime(bytes) {
  if (!isUint8Array(bytes)) {
    return null;
  }

  const format = REGISTRY.find(({ signatures }) => signatures.some((signature) => matchesSignature(bytes, signature)));

  return format?.type ?? null;
}

export function toMimeEssence(mime) {
  if (!isString(mime)) {
    return null;
  }

  try {
    return new MIMEType(mime).essence;
  } catch {
    return null;
  }
}

export function extFromMime(mime) {
  const type = toMimeEssence(mime);
  const format = REGISTRY.find((item) => item.type === type);

  return format?.extension ?? null;
}
