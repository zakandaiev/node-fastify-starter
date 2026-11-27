import { getContext } from '#core/context/index.js';
import { isOutcomeUnknown } from '#core/db/error.js';
import { getErrorStatus } from '#core/error/classify.js';
import { AppError } from '#core/error/index.js';
import { processImage } from '#core/image/index.js';
import { IMAGE_INPUT_TYPES } from '#core/image/profile.js';
import { getStorage } from '#core/storage/index.js';
import { toStorageKey } from '#core/storage/key.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { FILE_CHECK } from '#enums/file-check.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { createByteCollector } from '#utils/bytes.js';
import { detectMime, extFromMime } from '#utils/mime.js';
import { getPath } from '#utils/object.js';
import { isBlankNumberText, isNullableSchema } from '#utils/schema.js';
import { convertStringToBytes } from '#utils/string.js';
import {
  isFunction,
  isNonEmptyString,
  isObject,
  isString,
} from '#utils/type.js';
import { finished } from 'node:stream/promises';

const FILE_PART = 'file';
const NULL_TEXT = 'null';

const FORM_FIELDS_PATH = Object.freeze(['body', 'content', MEDIA_TYPE.FORM_DATA, 'schema', 'properties']);

// A part has Content-Disposition and Content-Type, and some clients add Content-Length or the obsolete
// Content-Transfer-Encoding: the parser reads no more pairs of its header than these.
const PART_HEADER_PAIRS = 4;

// The refusals the parser gives a body by itself: the parts limit, and a field named as a key of Object.prototype.
const PARSER_STATUSES = Object.freeze([HTTP_STATUS.BAD_REQUEST, HTTP_STATUS.PAYLOAD_TOO_LARGE]);

const REMOVE_FAILED_MESSAGE = 'Failed to remove an uploaded file of a failed request';

const SIGNATURE = Object.freeze({
  READ: 'readMultipartBody(request, options)',
  DRAIN: 'drainRequest(request)',
  COMMIT: 'commitUploadedFiles(request, run)',
  KEEP: 'keepUploadedFiles(request)',
  REMOVE: 'removeUploadedFiles(request)',
});

// Shaped as the end of the parts: the wait for the next part ends with it past maxBodySize.
const BODY_OVER = Object.freeze({ done: true, value: undefined });

// Where a request keeps the files it has stored until they are kept or removed; the multipart plugin decorates it.
export const UPLOAD_STATE = Symbol('upload state');

// The files the whole process reads, decodes and stores at the moment: each of them is held in memory whole.
const activeFiles = { count: 0 };

function takeUploadSlot(maxActiveFiles) {
  if (activeFiles.count >= maxActiveFiles) {
    return false;
  }

  activeFiles.count += 1;

  return true;
}

function releaseUploadSlot() {
  activeFiles.count -= 1;
}

function assertRequest(request, signature) {
  if (request === null || typeof request !== 'object') {
    throw new TypeError(`${signature} requires a request`);
  }
}

function toBodyError(error) {
  return PARSER_STATUSES.includes(getErrorStatus(error))
    ? error
    : new AppError(ERROR_CODE.BAD_REQUEST_ERROR, { cause: error });
}

// Past maxBodySize the parser is fed no more, and the rest of the body is read and dropped before the answer, as that of
// any form is. onOver is the parser's, which ends the part it was reading: no part of a body fed no more would ever end.
function meterBody(raw, maxBodySize) {
  const meter = { bytes: 0, isOver: false, onOver: null };

  meter.over = new Promise((resolve) => {
    function count(chunk) {
      meter.bytes += Buffer.byteLength(chunk);

      if (meter.bytes > maxBodySize) {
        meter.isOver = true;
        raw.removeListener('data', count);
        raw.unpipe();
        meter.onOver?.();
        resolve(BODY_OVER);
      }
    }

    raw.on('data', count);
  });

  return meter;
}

async function waitForEnd(stream) {
  try {
    await finished(stream);
  } catch {
    return false;
  }

  return true;
}

// The answer waits for the end of the body: sent before it, it is torn down with the connection, a 502 behind a proxy.
// What nobody reads, such as a tail after the closing boundary or the form of a request refused before its parse, is read
// and dropped; config.app.requestTimeout ends a body that never does. True once the body has ended, false when it broke off.
export async function drainRequest(request) {
  if (!isFunction(request?.raw?.resume)) {
    throw new TypeError(`${SIGNATURE.DRAIN} requires a request with its body`);
  }

  const { raw } = request;

  if (raw.readableEnded) {
    return true;
  }

  raw.resume();

  return waitForEnd(raw);
}

// A part never read to its end stalls the parser, and the rest of the body with it. A destroyed stream settles at once.
function drainFile(file) {
  file.resume();

  return waitForEnd(file);
}

// Into one buffer, up to the size of its field: past it the rest is read and dropped. The parser itself cuts a file at the
// largest size of the route and marks it truncated. An error of the stream is one of the body the client sent.
async function readFileBytes(file, maxSize) {
  const collector = createByteCollector(maxSize);
  const reading = { isOver: false };

  file.on('data', (chunk) => {
    reading.isOver = reading.isOver || !collector.add(chunk);
  });

  try {
    await finished(file);
  } catch (error) {
    throw toBodyError(error);
  }

  return reading.isOver || file.truncated
    ? null
    : collector.read();
}

function findFileField(options, name) {
  return isString(name) && Object.hasOwn(options.fields, name)
    ? options.fields[name]
    : null;
}

// One entry for a check of a field: the next file it refuses there says nothing new.
function addEntry(state, field, operator, operatorValue) {
  const isListed = state.validation.some((entry) => entry.column === field.name && entry.operator === operator);

  if (!isListed) {
    state.validation.push({
      column: field.name,
      columnValue: null,
      operator,
      operatorValue,
    });
  }

  return false;
}

// A text value of a file field counts as one of its files: "null" beside a file in a field of one file is two of them.
function countFieldPart(state, field) {
  const count = (state.counts.get(field.name) ?? 0) + 1;

  state.counts.set(field.name, count);

  return count <= field.max || addEntry(state, field, FILE_CHECK.MAX_FILES, field.max);
}

function countFile(state, field) {
  if (!countFieldPart(state, field)) {
    return false;
  }

  state.fileCount += 1;

  return state.fileCount <= state.options.maxFiles || addEntry(state, field, FILE_CHECK.MAX_FILES, state.options.maxFiles);
}

function measureName(name) {
  return isString(name)
    ? Buffer.byteLength(name)
    : 0;
}

// A part the content type of JSON gives the parser comes parsed: it is counted as the JSON it was.
function measureText(value) {
  return Buffer.byteLength(isString(value)
    ? value
    : JSON.stringify(value));
}

// The text of a form is held as a JSON body is, within the bodyLimit of the route as a whole. The names count too, those of
// the file parts and of the nameless ones as well: the parser keeps every part it gives beside the others.
function countText(state, bytes, isCut = false) {
  state.textSize += bytes;
  state.isTextOver = state.isTextOver || isCut || state.textSize > state.bodyLimit;

  return !state.isTextOver;
}

function takeText(part, state) {
  const { fieldname: name, value } = part;

  if (!countText(state, measureName(name) + measureText(value), part.valueTruncated) || !isNonEmptyString(name)) {
    return false;
  }

  const field = findFileField(state.options, name);

  if (field !== null && !countFieldPart(state, field)) {
    return false;
  }

  state.values.set(name, [...(state.values.get(name) ?? []), value]);

  return true;
}

function describeStored(key, prepared, storage) {
  const { width, height } = prepared;

  return {
    key,
    url: storage.url(key),
    mime: prepared.mime,
    size: prepared.bytes.length,
    ...(width !== undefined && { width, height }),
  };
}

// Recorded as soon as it is stored: whatever fails after this, the file is known to be removed.
async function saveFile(prepared, field, state) {
  const { request, storage } = state;
  const key = toStorageKey(prepared.extension);

  await storage.put(key, prepared.bytes);
  request[UPLOAD_STATE].keys.push(key);

  const file = describeStored(key, prepared, storage);

  request.uploadedFiles[field.name] = field.max === 1
    ? file
    : [...(request.uploadedFiles[field.name] ?? []), file];

  return true;
}

// The parser gives text parts with no backpressure, and keeps each until the request ends: a body read on while a file is
// decoded and stored would pile them up. The pipe resumes the body when the parser drains, so the hold pauses it again.
async function holdBody(raw, run) {
  function pause() {
    raw.pause();
  }

  pause();
  raw.on('resume', pause);

  try {
    return await run();
  } finally {
    raw.removeListener('resume', pause);
    raw.resume();
  }
}

async function prepareFile(bytes, mime, field) {
  if (!IMAGE_INPUT_TYPES.includes(mime)) {
    return { file: { bytes, mime, extension: extFromMime(mime) } };
  }

  const { image, refusal } = await processImage(bytes, field.profile);

  return refusal
    ? { refusal }
    : { file: image };
}

// The type is told by the bytes, never by the name or the header the client gave the file.
async function storeFile(part, field, state) {
  const bytes = await readFileBytes(part.file, field.maxSize);

  if (bytes === null) {
    return addEntry(state, field, FILE_CHECK.MAX_SIZE, field.maxSize);
  }

  state.totalSize += bytes.length;

  if (state.totalSize > state.options.totalMaxSize) {
    return addEntry(state, field, FILE_CHECK.TOTAL_MAX_SIZE, state.options.totalMaxSize);
  }

  const mime = detectMime(bytes);

  if (!field.mime.includes(mime)) {
    return addEntry(state, field, FILE_CHECK.MIME, field.mime);
  }

  return holdBody(state.request.raw, async () => {
    const { file, refusal } = await prepareFile(bytes, mime, field);

    return refusal
      ? addEntry(state, field, refusal.operator, refusal.operatorValue)
      : saveFile(file, field, state);
  });
}

// A file without a name is an empty file input, and a field the route does not name is ignored: both are only read.
// A body that is answered 503 anyway is only read from then on. A name that takes the text past its limit stops the parse.
async function takeFile(part, state) {
  if (!countText(state, measureName(part.fieldname))) {
    return false;
  }

  const field = findFileField(state.options, part.fieldname);

  if (field === null || !part.filename || !countFile(state, field) || state.isBusy) {
    return drainFile(part.file);
  }

  if (!takeUploadSlot(state.upload.maxActiveFiles)) {
    state.isBusy = true;

    return drainFile(part.file);
  }

  try {
    return await storeFile(part, field, state);
  } finally {
    releaseUploadSlot();
  }
}

// A failure stops the work, never the reading: the rest of the body is read, and the failure is thrown after it. The
// first failure stays: an error of a part that the limit of the body has ended is that limit.
async function takePart(part, state) {
  const isFile = part.type === FILE_PART;

  state.file = isFile
    ? part.file
    : null;

  if (state.failure === null) {
    try {
      return isFile
        ? await takeFile(part, state)
        : takeText(part, state);
    } catch (error) {
      state.failure ??= error;
    }
  }

  return isFile
    ? drainFile(part.file)
    : false;
}

function isStopped(state) {
  return state.isTextOver || state.meter.isOver;
}

// One part after another, each read to its end before the next comes. A body over a limit stops the parse: the parser keeps
// every field it parses, and once it is fed no more it never gives the next part, so the wait for one gives way.
async function readEachPart(parts, state) {
  if (isStopped(state)) {
    return false;
  }

  const next = await Promise.race([parts.next(), state.meter.over]);

  if (next.done || isStopped(state)) {
    return true;
  }

  await takePart(next.value, state);

  return readEachPart(parts, state);
}

function stopAtBodyLimit(state) {
  state.failure ??= new AppError(ERROR_CODE.PAYLOAD_TOO_LARGE_ERROR);
  state.file?.destroy();
}

// Only the parser throws here: a part keeps what fails on it for later. Its errors are those of the body the client sent.
// What the parser was not fed is read after it.
async function readParts(request, state) {
  const parts = request.parts({
    limits: {
      fileSize: state.options.maxFileSize,
      fieldSize: state.bodyLimit,
      parts: state.upload.maxParts,
      headerSize: convertStringToBytes(state.upload.maxPartHeaderSize),
      headerPairs: PART_HEADER_PAIRS,
    },
    throwFileSizeLimit: false,
  });

  state.meter.onOver = () => stopAtBodyLimit(state);

  try {
    await readEachPart(parts, state);
  } catch (error) {
    state.failure ??= toBodyError(error);
  }

  request.raw.unpipe();
  await drainRequest(request);
}

function startUpload(request, options) {
  const { upload } = getContext().config;
  const { bodyLimit, schema } = request.routeOptions;
  const maxBodySize = convertStringToBytes(upload.maxBodySize);

  request.uploadedFiles = {};
  request[UPLOAD_STATE] = { storage: getStorage(), keys: [], isKept: false };

  return {
    request,
    options,
    upload,
    storage: request[UPLOAD_STATE].storage,
    bodyLimit,
    formFields: getPath(schema, FORM_FIELDS_PATH, {}),
    meter: meterBody(request.raw, maxBodySize),
    values: new Map(),
    counts: new Map(),
    fileCount: 0,
    totalSize: 0,
    textSize: 0,
    isTextOver: false,
    isBusy: false,
    file: null,
    validation: [],
    failure: null,
  };
}

function assertParsed(state) {
  if (state.failure !== null) {
    throw state.failure;
  }

  if (state.isBusy) {
    throw new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR);
  }

  if (state.isTextOver) {
    throw new AppError(ERROR_CODE.PAYLOAD_TOO_LARGE_ERROR);
  }

  if (state.validation.length > 0) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, { validation: state.validation });
  }

  return true;
}

// Where the form takes null, as a file field and a nullable one do, "null" is null. Anywhere else it is the text "null",
// which validation refuses for a number as it refuses null: coerced, null would pass for 0, false or "". Null of a part of
// JSON is null, as in a JSON body.
function readNull(value, isNullable) {
  return value === NULL_TEXT && isNullable
    ? null
    : value;
}

// Blank text of a field of numbers is no value, as in a query: coerced, it would pass for 0. A name repeated is the list
// of its values, whose items are read by the schema of an item.
function toFieldValue(list, field) {
  const values = list.filter((value) => !isBlankNumberText(field, value));

  if (values.length > 1) {
    return values.map((value) => readNull(value, isNullableSchema(field?.items)));
  }

  return values.length === 1
    ? readNull(values[0], isNullableSchema(field) || isNullableSchema(field?.items))
    : undefined;
}

function toFields(values, formFields) {
  return Object.fromEntries(Array.from(values)
    .map(([name, list]) => [name, toFieldValue(list, getPath(formFields, [name]))])
    .filter(([, value]) => value !== undefined));
}

// Before validation, which reads the text of the form as the body by the form schema of the route. The files go to
// request.uploadedFiles, each stored as soon as it is read; those of a body refused here are removed here, since no
// handler will ever hold them.
export async function readMultipartBody(request, options) {
  if (!isFunction(request?.parts) || !isObject(options?.fields)) {
    throw new TypeError(`${SIGNATURE.READ} requires a request of the multipart plugin and the result of readFileOptions()`);
  }

  const state = startUpload(request, options);

  await readParts(request, state);

  try {
    assertParsed(state);
  } catch (error) {
    await removeUploadedFiles(request);

    throw error;
  }

  request.body = toFields(state.values, state.formFields);

  return true;
}

// Once the service has committed: the files belong to its rows now, and a failure after that, of the serializer, keeps
// them.
export function keepUploadedFiles(request) {
  assertRequest(request, SIGNATURE.KEEP);

  const state = request[UPLOAD_STATE];

  if (!state) {
    return false;
  }

  state.isKept = true;

  return true;
}

// The service that writes the keys of the files into its rows: they are kept once it has committed, and also when its
// connection was lost on the way, which may have carried the COMMIT: an orphan file costs less than a row that names a
// removed one.
export async function commitUploadedFiles(request, run) {
  assertRequest(request, SIGNATURE.COMMIT);

  if (!isFunction(run)) {
    throw new TypeError(`${SIGNATURE.COMMIT} requires a function that runs the service`);
  }

  try {
    const result = await run();

    keepUploadedFiles(request);

    return result;
  } catch (error) {
    if (isOutcomeUnknown(error)) {
      keepUploadedFiles(request);
    }

    throw error;
  }
}

// Once for a request, whoever asks first: the parser that refuses the body, or the answer of a failed request. A file that
// fails to go is a line of the log, never a second failure of the request.
export async function removeUploadedFiles(request) {
  assertRequest(request, SIGNATURE.REMOVE);

  const state = request[UPLOAD_STATE];

  if (!state || state.isKept || state.keys.length === 0) {
    return false;
  }

  const results = await Promise.allSettled(state.keys.splice(0).map((key) => state.storage.delete(key)));

  results
    .filter((result) => result.status === 'rejected')
    .forEach(({ reason }) => request.log.error({ err: reason }, REMOVE_FAILED_MESSAGE));

  return true;
}
