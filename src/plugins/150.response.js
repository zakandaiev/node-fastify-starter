import { createEnvelope } from '#core/response/index.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { pick } from '#utils/object.js';
import { isArray, isFunction, isObject } from '#utils/type.js';
import fp from 'fastify-plugin';

const STATUS_CLASS_SIZE = 100;

const LIST_SECTIONS = Object.freeze(['data', 'pagination', 'sort', 'filters']);

// By the media type the reply carries, as Fastify picks it: under another JSON type than the one declared
// Fastify finds no serializer and writes the body as it is.
function findSerializer(reply, statusCode) {
  const entry = reply.getSerializationFunction(statusCode)
    ?? reply.getSerializationFunction(`${Math.trunc(statusCode / STATUS_CLASS_SIZE)}xx`);

  return isObject(entry)
    ? entry[reply.mediaType || MEDIA_TYPE.JSON] ?? entry[MEDIA_TYPE.ANY]
    : entry;
}

// The startup contract proves that the route has a typed schema for some 2xx status, not for the one that
// is being sent: without a serializer for it Fastify writes the body as it is, every field of the row included.
function assertSerializer(reply, statusCode) {
  if (!isObject(reply.request.routeOptions.schema?.response) || isFunction(findSerializer(reply, statusCode))) {
    return true;
  }

  throw new TypeError(`The route answers ${statusCode}, and its response schema has no JSON entry for that status: declare it, or the fields of "data" go out unfiltered`);
}

function sendSuccess(reply, statusCode, sections) {
  assertSerializer(reply, statusCode);

  return reply
    .code(statusCode)
    .send(createEnvelope({ ...sections, requestId: reply.request.id }));
}

function ok(data) {
  return sendSuccess(this, HTTP_STATUS.OK, { data });
}

function created(data) {
  return sendSuccess(this, HTTP_STATUS.CREATED, { data });
}

function list(result) {
  if (!isObject(result) || !isArray(result.data)) {
    throw new TypeError('reply.list(result) requires the result of query.getAll(): an object with an array in "data"');
  }

  return sendSuccess(this, HTTP_STATUS.OK, pick(result, LIST_SECTIONS));
}

function noContent() {
  return this
    .code(HTTP_STATUS.NO_CONTENT)
    .send();
}

// Throws instead of calling reply.send(error): an async handler that forgets to return the call would answer a second
// time while a hook keeps the first answer waiting, and nobody may hold what that fails with. A throw works only on the
// stack of a handler or a hook: in a callback of a stream, a timer or an emitter the error goes to reply.send(error).
function fail(error) {
  if (!(error instanceof Error)) {
    throw new TypeError('reply.fail(error) requires an Error: reply.fail(new AppError(code))');
  }

  throw error;
}

async function useResponse(fastify) {
  fastify.decorateReply('ok', ok);
  fastify.decorateReply('list', list);
  fastify.decorateReply('created', created);
  fastify.decorateReply('noContent', noContent);
  fastify.decorateReply('fail', fail);
}

export default fp(useResponse, { name: 'response' });
