import { SCHEMA_LIMITS } from '#config/schema.js';
import { alert } from '#core/alert/index.js';
import { AppError } from '#core/error/index.js';
import { maskErrorValues } from '#core/error/mask.js';
import { createSchema } from '#core/schema/create-schema.js';
import { ALERT_SPACE } from '#enums/alert-space.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { text } from '#schemas/common/field.js';
import { timingSafeEqual } from '#utils/hash.js';
import { readBearerToken, readOriginHost } from '#utils/header.js';
import { freezeDeep, pick } from '#utils/object.js';
import { cutAddressTail, cutAddressTails, truncate } from '#utils/string.js';
import { isString } from '#utils/type.js';

const FRONTEND_ERROR_TITLE = 'Frontend error';
const DEDUPE_PREFIX = 'frontend';
const KEY_SEPARATOR = ':';

const ERROR_KEYS = Object.freeze(['name', 'message', 'stack', 'source', 'line', 'column']);
const CLIENT_KEYS = Object.freeze(['release', 'language', 'timezone', 'viewport', 'isOnline']);

const POSITION = Object.freeze({ type: 'integer', minimum: 0, maximum: 2 ** 31 - 1 });

const MESSAGE_MAX_LENGTH = 1024;
const STACK_MAX_LENGTH = 4096;
const SOURCE_MAX_LENGTH = 2048;

// The limit of the raw text is that of the body: on an OAuth callback every frame of a stack repeats the address of the
// page, and a lower one would refuse the very reports the cut is for.
const RAW_MAX_LENGTH = SCHEMA_LIMITS.reportMaxLength;

function optionalText(description, maxLength) {
  return text(description, { minLength: 0, maxLength });
}

// Every field is named: the report is built anew from these, a field outside them (a dump of storage, a title,
// a block of its own) never reaches an alert.
const fields = freezeDeep({
  url: optionalText('Address of the page; the server drops its query and fragment', RAW_MAX_LENGTH),
  error: {
    type: 'object',
    description: 'The error as the page caught it',
    properties: {
      name: optionalText('Type of the error, such as TypeError', 100),
      message: text('Message of the error; the server drops the query and the fragment of its addresses, then cuts it', { maxLength: RAW_MAX_LENGTH }),
      stack: optionalText('Stack of the error, treated as the message is', RAW_MAX_LENGTH),
      source: optionalText('Address of the script the error comes from; the server drops its query and fragment', RAW_MAX_LENGTH),
      line: POSITION,
      column: POSITION,
    },
    required: ['message'],
    additionalProperties: false,
  },
  client: {
    type: 'object',
    description: 'Where the page runs',
    properties: {
      release: optionalText('Build of the frontend', 64),
      language: optionalText('Language of the browser, as a BCP 47 tag', 35),
      timezone: optionalText('IANA time zone of the browser', 64),
      viewport: optionalText('Size of the window, such as 1280x720', 32),
      isOnline: { type: 'boolean', description: 'Whether the browser was online' },
    },
    additionalProperties: false,
  },
  isDeduped: { type: 'boolean', description: 'The same report came within the dedupe window: nothing was sent' },
  isThrottled: { type: 'boolean', description: 'The window of reports had sent its message: this one is counted into the next' },
});

function isApiKey(request) {
  const { logApiKey } = request.server.config.alert;
  const token = readBearerToken(request.headers[HEADER.AUTHORIZATION]);

  return logApiKey !== null && token !== null && timingSafeEqual(token, logApiKey);
}

// Before the body is read: a browser of an allowed host, or another app or an SSR server with the key of logs.
// A foreign Origin is refused even with the key: a server that sends one is not the client it claims to be.
export async function checkSource(request) {
  const host = readOriginHost(request.headers);

  if (host !== null && !request.server.config.app.allowedHosts.includes(host)) {
    throw new AppError(ERROR_CODE.ORIGIN_ERROR);
  }

  if (host === null && !isApiKey(request)) {
    throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
  }

  return true;
}

// The values an error of the server repeats are masked before the cut, which could leave half of one.
function cutText(value, cut, maxLength) {
  return isString(value)
    ? truncate(maskErrorValues(cut(value)), maxLength)
    : undefined;
}

// A browser writes the address of the page into the frames of an inline script, and an OAuth callback carries its
// code there: the addresses in url, source, stack and message lose their query and fragment.
function readReport(body) {
  const error = pick(body.error, ERROR_KEYS);

  return {
    error: {
      ...error,
      message: cutText(error.message, cutAddressTails, MESSAGE_MAX_LENGTH),
      stack: cutText(error.stack, cutAddressTails, STACK_MAX_LENGTH),
      source: cutText(error.source, cutAddressTail, SOURCE_MAX_LENGTH),
    },
    client: body.client === undefined
      ? undefined
      : pick(body.client, CLIENT_KEYS),
  };
}

// The title is the server's, the space is the public one, and the answer neither waits for the channels nor says what
// they did: a page must not see that one of them hangs or fails.
export async function postError(request, reply) {
  const { error, client } = readReport(request.body);
  const result = await alert({
    title: FRONTEND_ERROR_TITLE,
    dedupeKey: [DEDUPE_PREFIX, error.name, error.message, error.source, error.line, error.column].join(KEY_SEPARATOR),
    error,
    client,
    url: request.body.url ?? null,
    request,
    space: ALERT_SPACE.PUBLIC,
    isDetached: true,
  });

  return reply.ok({ isDeduped: result.isDeduped, isThrottled: result.isThrottled });
}

export const postErrorSchema = createSchema({ properties: fields })
  .meta({ tags: ['Log'], summary: 'Report an error of the frontend to the admins' })
  .body(['url', 'error', 'client'], { required: ['error'] })
  .response(200, { data: ['isDeduped', 'isThrottled'] })
  .defaultResponses()
  .build();
