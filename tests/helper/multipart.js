import { createUploadConfig } from '#config/upload.js';
import { HEADER } from '#enums/header.js';
import { PROCESS_UPLOAD_ROOT } from '#root/tests/helper/config.js';
import { uuidv7 } from '#utils/id.js';
import { readdir, rm } from 'node:fs/promises';
import nodePath from 'node:path';
import sharp from 'sharp';

// A body is built by hand, byte by byte: a test controls every boundary and header the parser reads.
export const CRLF = '\r\n';
export const BOUNDARY = 'nfs-test-boundary';
export const FORM_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
export const CLOSING = `--${BOUNDARY}--${CRLF}`;

const OCTET_STREAM = 'application/octet-stream';
const DEFAULT_FILENAME = 'file.bin';

// Windows may still hold a file of the folder for a moment after the app is closed.
export const REMOVE_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
});

const IMAGE_CHANNELS = 3;
const IMAGE_COLOR = Object.freeze({ r: 30, g: 90, b: 160 });

// The magic bytes the app tells a PDF by; what follows is filler.
const PDF_SIGNATURE = Buffer.from('%PDF-1.7\n');
const PDF_FILLER = '%';

export function textPart(name, value) {
  return Buffer.from([`--${BOUNDARY}`, `Content-Disposition: form-data; name="${name}"`, '', value, ''].join(CRLF));
}

export function fileHeader(name, { filename = DEFAULT_FILENAME, type = OCTET_STREAM } = {}) {
  return Buffer.from([`--${BOUNDARY}`, `Content-Disposition: form-data; name="${name}"; filename="${filename}"`, `Content-Type: ${type}`, '', ''].join(CRLF));
}

export function filePart(name, bytes, options) {
  return Buffer.concat([fileHeader(name, options), bytes, Buffer.from(CRLF)]);
}

export function createForm(parts) {
  return Buffer.concat([...parts, Buffer.from(CLOSING)]);
}

// The request of inject() with these parts as its body.
export function withForm(request, parts) {
  return {
    ...request,
    headers: { ...request.headers, [HEADER.CONTENT_TYPE]: FORM_TYPE },
    payload: createForm(parts),
  };
}

// A root nothing has been stored in yet does not exist.
export async function listStored(root) {
  try {
    return await readdir(root);
  } catch {
    return [];
  }
}

export function createImage(width, height, { channels = IMAGE_CHANNELS, background = IMAGE_COLOR } = {}) {
  return sharp({
    create: {
      width,
      height,
      channels,
      background,
    },
  });
}

export function createPdf(size) {
  return Buffer.concat([PDF_SIGNATURE, Buffer.alloc(size - PDF_SIGNATURE.length, PDF_FILLER)]);
}

// A root of its own for the app of a test, under the one of the process that removeTestUploads() takes whole: a test
// that lists its root sees its own files only.
export function createUploadSection() {
  return { storage: { ...createUploadConfig().storage, root: nodePath.join(PROCESS_UPLOAD_ROOT, uuidv7()) } };
}

export function removeTestUploads() {
  return rm(PROCESS_UPLOAD_ROOT, REMOVE_OPTIONS);
}
