import { maskErrorValues } from '#core/error/mask.js';
import { serializeError } from '#core/logger/index.js';
import { HEADER } from '#enums/header.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import { toJsonTree } from '#utils/serialize.js';
import { cutAddressTail, truncate } from '#utils/string.js';
import { isNonEmptyString, isString } from '#utils/type.js';

export const ALERT_BLOCK = Object.freeze({
  APP: 'App',
  URL: 'Url',
  ERROR: 'Error',
  REQUEST: 'Request',
  CLIENT: 'Client',
});

const ICONS = Object.freeze({
  [THROTTLE_CLASS.FAILURE]: '🚨',
  [THROTTLE_CLASS.WARNING]: '⚠️',
  [THROTTLE_CLASS.SILENT]: '🟢',
});

const TITLE_MAX_LENGTH = 200;
const USER_AGENT_MAX_LENGTH = 256;
const URL_MAX_LENGTH = 2048;

// What a request line may name in front of the path.
const REQUEST_ORIGIN_REGEXP = /^(?:[a-z][a-z\d+.-]*:\/\/)?[^/]*/i;

const CAUSE_SEPARATOR = ':';
const UNREADABLE_CAUSE = 'unreadable';

const NO_ROUTE = '(no route)';

// The place in a dedupe key: the method and the pattern of the route, so every id and query of its path is one place.
export function readRouteName(request) {
  return `${request.method} ${request.routeOptions?.url ?? NO_ROUTE}`;
}

// The cause in a dedupe key: the type, the code and the masked text of what was thrown, so one bug is one alert
// whatever ids and values it carries. Anything can be thrown: a value without a text form, a getter that throws.
export function readErrorCause(error) {
  try {
    const text = isString(error?.message)
      ? error.message
      : String(error);

    return [error?.constructor?.name, error?.code, maskErrorValues(text)]
      .map((part) => String(part ?? ''))
      .join(CAUSE_SEPARATOR);
  } catch {
    return UNREADABLE_CAUSE;
  }
}

// The same cleaning as a line of the log: sensitive keys hidden, the values the database and the serializer repeat
// masked, an error of any depth in its plain form. The value goes out as JSON to every channel: what JSON cannot write
// must not fail a render later, when the slot of the throttle is already taken.
function cleanValue(value) {
  return toJsonTree(serializeError(value));
}

// Any process, any request: no headers, no body, no query, only what tells who it was.
export function describeRequest(request) {
  const userAgent = request.headers?.[HEADER.USER_AGENT];

  return cleanValue({
    method: request.method,
    ip: request.ip,
    userAgent: isString(userAgent)
      ? truncate(userAgent, USER_AGENT_MAX_LENGTH)
      : null,
    userId: request.user?.id ?? null,
    requestId: request.id,
  });
}

// The host is ours, not the one the request names: an admin follows this link.
function readRequestUrl(request, appConfig) {
  return `${appConfig.url}${cutAddressTail(request.url).replace(REQUEST_ORIGIN_REGEXP, '')}`;
}

// null is an alert about no address: a report of the frontend without a page must not show the address of the intake.
function readUrl({ url, request }, appConfig) {
  if (url !== undefined) {
    return isNonEmptyString(url)
      ? truncate(cutAddressTail(url), URL_MAX_LENGTH)
      : null;
  }

  return request
    ? truncate(readRequestUrl(request, appConfig), URL_MAX_LENGTH)
    : null;
}

function toBlock(name, value) {
  return value === null || value === undefined
    ? null
    : { name, value };
}

// Built once, before any channel or state is touched, and the same for every channel: the blocks and their order.
export function buildAlertMessage({
  title,
  error,
  request,
  client,
  url,
  space,
  throttleClass,
  isSilent,
}, appConfig) {
  const { name, version, mode } = appConfig;

  return {
    icon: ICONS[throttleClass],
    title: truncate(title, TITLE_MAX_LENGTH),
    space,
    throttleClass,
    isSilent,
    blocks: [
      toBlock(ALERT_BLOCK.APP, { name, version, mode }),
      toBlock(ALERT_BLOCK.URL, readUrl({ url, request }, appConfig)),
      toBlock(ALERT_BLOCK.ERROR, error === undefined ? null : cleanValue(error)),
      toBlock(ALERT_BLOCK.REQUEST, request ? describeRequest(request) : null),
      toBlock(ALERT_BLOCK.CLIENT, client === undefined ? null : cleanValue(client)),
    ].filter(Boolean),
    suppressedCount: 0,
  };
}
