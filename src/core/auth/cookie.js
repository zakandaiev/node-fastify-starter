import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import { hasBearerScheme } from '#utils/header.js';
import { isNonEmptyString } from '#utils/type.js';

const HTTPS = 'https';
const SAME_SITE = 'lax';
const ROOT_PATH = '/';
const MARKER_VALUE = '1';

// What every cookie of the app is set with. Lax, not Strict: a sign-in comes back from its provider by a navigation
// from another site, and its cookies must ride with it.
export function readCookieBase(appConfig) {
  // The whole config passed by mistake would drop Secure without a word.
  if (!isNonEmptyString(appConfig?.protocol)) {
    throw new TypeError('readCookieBase(appConfig) requires config.app, which names the protocol of the app');
  }

  return { sameSite: SAME_SITE, secure: appConfig.protocol === HTTPS };
}

// The two markers are read by the page: they say that a token is there, and hold none.
function describeCookies({ app, auth }) {
  const shared = readCookieBase(app);

  return {
    [COOKIE.ACCESS_TOKEN]: { ...shared, httpOnly: true, path: app.apiPrefix },
    [COOKIE.REFRESH_TOKEN]: { ...shared, httpOnly: true, path: `${app.apiPrefix}${auth.refreshRoute}` },
    [COOKIE.HAS_SESSION]: { ...shared, httpOnly: false, path: ROOT_PATH },
    [COOKIE.HAS_ACCESS]: { ...shared, httpOnly: false, path: ROOT_PATH },
  };
}

// For a route, as its last step before the answer: a cookie waits on the reply for whatever is sent, so one set or
// cleared before a step that can fail would leave with the 5xx of that step.
export function setAuthCookies(reply, issued) {
  const values = {
    [COOKIE.ACCESS_TOKEN]: [issued.accessToken, issued.accessTtl],
    [COOKIE.REFRESH_TOKEN]: [issued.refreshToken, issued.refreshTtl],
    [COOKIE.HAS_SESSION]: [MARKER_VALUE, issued.refreshTtl],
    [COOKIE.HAS_ACCESS]: [MARKER_VALUE, issued.accessTtl],
  };

  Object.entries(describeCookies(reply.server.config)).forEach(([name, options]) => {
    const [value, maxAge] = values[name];

    reply.setCookie(name, value, { ...options, maxAge });
  });

  return true;
}

// With the attributes they were set with: a browser drops a cookie of the same name and path only.
export function clearAuthCookies(reply) {
  Object.entries(describeCookies(reply.server.config)).forEach(([name, options]) => reply.clearCookie(name, options));

  return true;
}

// For a request that has ended the session it came in. One made with a Bearer token leaves the cookies of the browser
// alone: they may be of another session.
export function endAuthCookies(request, reply) {
  return hasBearerScheme(request.headers[HEADER.AUTHORIZATION])
    ? false
    : clearAuthCookies(reply);
}
