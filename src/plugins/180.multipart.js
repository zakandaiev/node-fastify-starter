import { createContext } from '#core/context/index.js';
import { AppError } from '#core/error/index.js';
import { FILES_DECORATOR } from '#core/schema/route.js';
import { createStorage } from '#core/storage/index.js';
import {
  drainRequest,
  readMultipartBody,
  removeUploadedFiles,
  UPLOAD_STATE,
} from '#core/upload/index.js';
import { assertUploadConfig, FILE_OPTIONS } from '#core/upload/options.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { toMimeEssence } from '#utils/mime.js';
import fastifyMultipart from '@fastify/multipart';
import fp from 'fastify-plugin';

const STORAGE_MESSAGE = 'Uploaded files are stored';

// Multipart is taken on a route with "files" alone, as a form of a webhook is on the route of that webhook.
async function readForm(request) {
  const options = request.routeOptions.config[FILE_OPTIONS];

  if (options === undefined) {
    throw new AppError(ERROR_CODE.UNSUPPORTED_MEDIA_TYPE_ERROR);
  }

  return readMultipartBody(request, options);
}

// Global, so before the hooks of the route, which see the parsed body. The hooks here are callbacks that give a promise
// only when they have work: an async one would put off every request of the app by a turn, and in onSend let a handler
// that throws after reply.send() answer a second time.
function readFiles(request, reply, done) {
  if (request.isMultipart() && !request.is404) {
    return readForm(request);
  }

  done();
}

function isFailedUpload(request, reply) {
  return request[UPLOAD_STATE] !== null && reply.statusCode >= HTTP_STATUS.BAD_REQUEST;
}

// By the header: isMultipart() is false until the parser of the content type has run, and a refusal of onRequest, such as
// 401 of the guard or 429 of the limiter, comes before it.
function isUnreadForm(request) {
  return !request.raw.readableEnded && toMimeEssence(request.headers[HEADER.CONTENT_TYPE]) === MEDIA_TYPE.FORM_DATA;
}

async function settleRequest(request, reply, payload) {
  if (isUnreadForm(request)) {
    await drainRequest(request);
  }

  if (isFailedUpload(request, reply)) {
    await removeUploadedFiles(request);
  }

  return payload;
}

// Before the answer goes: the client never sees a failure whose files are still there, nor an answer to a form whose body
// is still coming, which the connection would tear down with it.
function holdAnswer(request, reply, payload, done) {
  if (isUnreadForm(request) || isFailedUpload(request, reply)) {
    return settleRequest(request, reply, payload);
  }

  done(null, payload);
}

// For an answer the error handler writes past the onSend hooks. No listener of a closed connection: a handler may still
// commit after the client has gone.
function removeAfterFailure(request, reply, done) {
  if (isFailedUpload(request, reply)) {
    return removeUploadedFiles(request);
  }

  done();
}

async function useMultipart(fastify) {
  const { app, upload } = fastify.config;

  assertUploadConfig(upload);

  const storage = createStorage(upload.storage, { baseUrl: app.url });

  fastify.decorate('storage', storage);
  fastify.context = createContext({ ...fastify.context, storage });
  fastify.decorateRequest('uploadedFiles', null);
  fastify.decorateRequest(FILES_DECORATOR, null);
  fastify.decorateRequest(UPLOAD_STATE, null);

  await fastify.register(fastifyMultipart, { limits: { parts: upload.maxParts }, throwFileSizeLimit: false });

  fastify.addHook('preValidation', readFiles);
  fastify.addHook('onSend', holdAnswer);
  fastify.addHook('onResponse', removeAfterFailure);
  fastify.log.info({ storage: { driver: upload.storage.driver, publicPath: upload.storage.publicPath } }, STORAGE_MESSAGE);
}

export default fp(useMultipart, { name: 'multipart' });
