import { readCookieBase } from '#core/auth/cookie.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import { convertStringToWholeSeconds } from '#utils/date.js';
import {
  decodeBase64Url,
  decodeUrlComponent,
  encodeBase64Url,
  isBase64Url,
} from '#utils/encoding.js';
import { readCookie } from '#utils/header.js';
import { isUuid } from '#utils/id.js';
import { cutAddressTail } from '#utils/string.js';
import { isNonEmptyString, isString } from '#utils/type.js';
import { isSafeRedirectPath } from '#utils/validate.js';

const MODE = Object.freeze({
  LOGIN: 'login',
  LINK: 'link',
});

// Neither base64url nor a UUID holds a dot.
const STATE_SEPARATOR = '.';
const LOGIN_PART_COUNT = 3;
const LINK_PART_COUNT = 4;

const PATH_SEPARATOR = '/';
const UTF8 = 'utf8';

// Query parameters of the page a sign-in ends on: the frontend reads them.
const AUTH_ERROR_PARAM = 'authError';
const LINKED_PARAM = 'linked';

const SET_SIGNATURE = 'setFlowCookies(reply, { path, state, verifier, sid, target })';
const SUCCESS_SIGNATURE = 'toSuccessLocation(config, { target, linkedProviderId })';

// A path as the page may read it: escapes decoded, an escaped "/" a separator too, in any case. An escape that does not
// decode makes no path of the site.
function readSegments(path) {
  const segments = cutAddressTail(path).split(PATH_SEPARATOR).map((segment) => decodeUrlComponent(segment));

  return segments.includes(null)
    ? null
    : segments.join(PATH_SEPARATOR).toLowerCase().split(PATH_SEPARATOR);
}

function isInSection(path, section) {
  const segments = readSegments(path);
  const sectionSegments = readSegments(section);

  if (segments === null || sectionSegments === null) {
    return true;
  }

  // "/auth/" names the same section as "/auth".
  const ownSegments = sectionSegments.at(-1) === ''
    ? sectionSegments.slice(0, -1)
    : sectionSegments;

  return ownSegments.every((segment, index) => segments[index] === segment);
}

// After the sign-in a target inside its own pages would end the session again or come back to the sign-in.
export function isAllowedTarget(target, config) {
  return isSafeRedirectPath(target) && !isInSection(target, config.oauth.signInSection);
}

function readCookieAttributes(config, path) {
  return { ...readCookieBase(config.app), httpOnly: true, path };
}

function writeState({ state, verifier, sid }) {
  const parts = sid === null
    ? [state, verifier, MODE.LOGIN]
    : [state, verifier, MODE.LINK, sid];

  return parts.join(STATE_SEPARATOR);
}

// For the start of a sign-in, on the path of its callback alone: a browser sends them nowhere else. Without a target that
// is allowed, the one of an earlier attempt is cleared, so that it does not outlive that attempt.
export function setFlowCookies(reply, {
  path,
  state,
  verifier,
  sid = null,
  target = null,
} = {}) {
  if (!isNonEmptyString(path) || !isBase64Url(state) || !isBase64Url(verifier) || (sid !== null && !isUuid(sid))) {
    throw new TypeError(`${SET_SIGNATURE} requires the path of the callback, a state and a verifier in base64url, and the UUID of a session or null as sid`);
  }

  const { config } = reply.server;
  const attributes = readCookieAttributes(config, path);
  const options = { ...attributes, maxAge: convertStringToWholeSeconds(config.oauth.stateTtl) };

  reply.setCookie(COOKIE.OAUTH_STATE, writeState({ state, verifier, sid }), options);

  if (isAllowedTarget(target, config)) {
    reply.setCookie(COOKIE.OAUTH_REDIRECT, encodeBase64Url(target), options);
  } else {
    reply.clearCookie(COOKIE.OAUTH_REDIRECT, attributes);
  }

  return true;
}

function readMode(parts) {
  const [, , mode, sid] = parts;

  if (parts.length === LOGIN_PART_COUNT && mode === MODE.LOGIN) {
    return { sid: null };
  }

  return parts.length === LINK_PART_COUNT && mode === MODE.LINK && isUuid(sid)
    ? { sid }
    : null;
}

function parseState(value) {
  const parts = isString(value)
    ? value.split(STATE_SEPARATOR)
    : [];
  const [state, verifier] = parts;
  const mode = readMode(parts);

  return mode !== null && isBase64Url(state) && isBase64Url(verifier)
    ? { state, verifier, sid: mode.sid }
    : null;
}

function toAllowedTarget(target, config) {
  return isAllowedTarget(target, config)
    ? target
    : null;
}

// Checked again on the way back: the cookie is the browser's to change.
function readTarget(value, config) {
  const bytes = decodeBase64Url(value);

  return bytes === null
    ? null
    : toAllowedTarget(bytes.toString(UTF8), config);
}

// Null without a flow that parses; a target that does not parse leaves the flow without one.
export function readFlowCookies(request) {
  const header = request.headers[HEADER.COOKIE];
  const flow = parseState(readCookie(header, COOKIE.OAUTH_STATE));

  return flow === null
    ? null
    : { ...flow, target: readTarget(readCookie(header, COOKIE.OAUTH_REDIRECT), request.server.config) };
}

// The flow is read once: both cookies are cleared whatever comes next, a failure included, which the cookies on the reply
// go out with.
export function takeFlowCookies(request, reply, { path } = {}) {
  if (!isNonEmptyString(path)) {
    throw new TypeError('takeFlowCookies(request, reply, { path }) requires the path of the callback the cookies were set on');
  }

  const flow = readFlowCookies(request);
  const attributes = readCookieAttributes(reply.server.config, path);

  [COOKIE.OAUTH_STATE, COOKIE.OAUTH_REDIRECT].forEach((name) => reply.clearCookie(name, attributes));

  return flow;
}

// Joined, then parsed: a path stays on the host of the app, and the URL writes what a Location header takes.
function toSiteLocation(config, path, params) {
  const url = new URL(`${config.app.url}${path}`);

  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));

  return url.href;
}

export function toSuccessLocation(config, { target = null, linkedProviderId = null } = {}) {
  if ((target !== null && !isAllowedTarget(target, config)) || (linkedProviderId !== null && !isNonEmptyString(linkedProviderId))) {
    throw new TypeError(`${SUCCESS_SIGNATURE} requires a target that isAllowedTarget() takes or null, and the id of the linked provider or null`);
  }

  const params = linkedProviderId === null
    ? {}
    : { [LINKED_PARAM]: linkedProviderId };

  return toSiteLocation(config, target ?? config.oauth.successPath, params);
}

// A link is made by a user who is signed in: its failure is told on the page it started from. The callback knows a link
// by its flow cookies, the start by its query, which the schema of that route alone turns into a boolean.
function readLinkFlow(request, config) {
  const flow = readFlowCookies(request);

  if (flow !== null) {
    return flow.sid === null
      ? null
      : flow;
  }

  return request.query?.link === true
    ? { target: toAllowedTarget(request.query.redirect, config) }
    : null;
}

// The failureLocation of the start and the callback routes: the error handler answers their failures with a redirect here.
export function toFailureLocation(code, request) {
  const { config } = request.server;
  const link = readLinkFlow(request, config);
  const path = link === null
    ? config.oauth.failurePath
    : link.target ?? config.oauth.successPath;

  return toSiteLocation(config, path, { [AUTH_ERROR_PARAM]: code });
}
