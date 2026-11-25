import { readLifetimes, TTL_MIN } from '#core/auth/settings.js';
import { getContext } from '#core/context/index.js';
import { COOKIE } from '#enums/cookie.js';
import { HEADER } from '#enums/header.js';
import { TOKEN_TYPE } from '#enums/token-type.js';
import { fromUnixSeconds, nowUtc, toUnixSeconds } from '#utils/date.js';
import { sha256 } from '#utils/hash.js';
import { hasBearerScheme, readBearerToken, readCookie } from '#utils/header.js';
import { isUuid, uuidv7 } from '#utils/id.js';
import { freezeDeep } from '#utils/object.js';
import { isArray, isNonEmptyString, isString } from '#utils/type.js';

// Named in every check and in every signature: a token never chooses the algorithm it is checked by.
const ALGORITHM = 'HS256';

const PREVIOUS_SUFFIX = 'Previous';

// Where @fastify/jwt writes the payload it has verified by itself: never into request.user, which only the guard fills.
const PAYLOAD_DECORATOR = 'jwtPayload';

const REQUIRED_CLAIMS = freezeDeep({
  [TOKEN_TYPE.ACCESS]: ['tokenType', 'sub', 'sid', 'scopes', 'exp'],
  [TOKEN_TYPE.REFRESH]: ['tokenType', 'sub', 'sid', 'jti', 'exp'],
});

const TOKEN_ERROR_PREFIX = 'FAST_JWT_';
const FOREIGN_SIGNATURE_CODE = 'FAST_JWT_INVALID_SIGNATURE';

function toPreviousSpace(type) {
  return `${type}${PREVIOUS_SUFFIX}`;
}

function describeSpace(type, secret, namespace = type) {
  return {
    namespace,
    secret,
    decoratorName: PAYLOAD_DECORATOR,
    sign: { algorithm: ALGORITHM },
    verify: { algorithms: [ALGORITHM], requiredClaims: REQUIRED_CLAIMS[type] },
  };
}

// A secret given as "public" alone checks and cannot sign.
function listPreviousSpaces(type, secret) {
  return secret === null
    ? []
    : [describeSpace(type, { public: secret }, toPreviousSpace(type))];
}

export function listJwtSpaces(authConfig) {
  return [
    describeSpace(TOKEN_TYPE.ACCESS, authConfig.accessSecret),
    describeSpace(TOKEN_TYPE.REFRESH, authConfig.refreshSecret),
    ...listPreviousSpaces(TOKEN_TYPE.ACCESS, authConfig.accessSecretPrevious),
    ...listPreviousSpaces(TOKEN_TYPE.REFRESH, authConfig.refreshSecretPrevious),
  ];
}

function getJwt() {
  const { jwt } = getContext();

  if (!jwt) {
    throw new Error('The context has no jwt: tokens are made and checked in the context of the app, or in one built with createContext({ config, log, jwt })');
  }

  return jwt;
}

// Anything but an error of the token is a bug of this code, and is not answered as a token nobody can use.
function checkIn(space, token) {
  try {
    return { claims: space.verify(token), isForeign: false };
  } catch (error) {
    if (!isString(error?.code) || !error.code.startsWith(TOKEN_ERROR_PREFIX)) {
      throw error;
    }

    return { claims: null, isForeign: error.code === FOREIGN_SIGNATURE_CODE };
  }
}

// An empty cookie is asserted on by the library, not refused: it never gets there.
function readClaims(type, token) {
  if (!isNonEmptyString(token)) {
    return null;
  }

  const jwt = getJwt();
  const previous = jwt[toPreviousSpace(type)];
  const { claims, isForeign } = checkIn(jwt[type], token);

  return isForeign && previous
    ? checkIn(previous, token).claims
    : claims;
}

// The library checks that a claim is there, not what it is. The ids go into SQL and into keys of Redis.
function hasSubject(claims, type) {
  return claims?.tokenType === type && isUuid(claims.sub) && isUuid(claims.sid);
}

// Null for whatever is not a live access token of this app: total for any text a client sends.
export function verifyAccessToken(token) {
  const claims = readClaims(TOKEN_TYPE.ACCESS, token);

  return hasSubject(claims, TOKEN_TYPE.ACCESS) && isArray(claims.scopes) && claims.scopes.every((scope) => isString(scope))
    ? { userId: claims.sub, sid: claims.sid, scopes: claims.scopes }
    : null;
}

export function verifyRefreshToken(token) {
  const claims = readClaims(TOKEN_TYPE.REFRESH, token);

  return hasSubject(claims, TOKEN_TYPE.REFRESH) && isUuid(claims.jti)
    ? { userId: claims.sub, sid: claims.sid }
    : null;
}

// The one place a request gives its access token, for the guard and for the limiter. A Bearer header is the token of
// its request, also when nobody can use it: the cookie is not read then. A header of another scheme is not for us,
// such as the Basic one of a proxy before a stage.
export function readAccessToken(request) {
  const authorization = request.headers[HEADER.AUTHORIZATION];

  return hasBearerScheme(authorization)
    ? readBearerToken(authorization)
    : readCookie(request.headers[HEADER.COOKIE], COOKIE.ACCESS_TOKEN);
}

// The cookie alone: a refresh token is taken from no header and no body.
export function readRefreshToken(request) {
  return readCookie(request.headers[HEADER.COOKIE], COOKIE.REFRESH_TOKEN);
}

function readTtls(startedAt, issuedAt) {
  const { accessTtl, refreshTtl, sessionMaxAge } = readLifetimes(getContext().config.auth);
  const ownRefreshTtl = Math.min(refreshTtl, toUnixSeconds(startedAt) + sessionMaxAge - issuedAt);

  return { accessTtl: Math.min(accessTtl, ownRefreshTtl), refreshTtl: ownRefreshTtl };
}

// Less than a second left of the longest life a session may have: a token of it would be born dead.
export function isAtMaxAge(startedAt) {
  return readTtls(startedAt, toUnixSeconds(nowUtc())).refreshTtl < TTL_MIN;
}

function sign(type, claims, { issuedAt, ttl }) {
  return getJwt()[type].sign({ tokenType: type, ...claims, iat: issuedAt }, { algorithm: ALGORITHM, expiresIn: ttl });
}

function assertFitsCookie(accessToken, maxBytes) {
  const bytes = Buffer.byteLength(accessToken);

  if (bytes > maxBytes) {
    throw new Error(`The access token takes ${bytes} bytes, above the ${maxBytes} a cookie may hold: the groups of the user grant too many scopes`);
  }

  return true;
}

// One moment in whole seconds is the start of both tokens, so the exp of the refresh token and expiresAt are the same
// moment, and the cookies live as long as their tokens. The jti makes two refresh tokens of one second differ.
export function issueTokens({
  userId,
  sid,
  scopes,
  startedAt,
}) {
  const issuedAt = toUnixSeconds(nowUtc());
  const ttls = readTtls(startedAt, issuedAt);

  if (ttls.refreshTtl < TTL_MIN) {
    throw new RangeError('issueTokens({ userId, sid, scopes, startedAt }) requires a session that has at least a second left of config.auth.sessionMaxAge');
  }

  const accessToken = sign(TOKEN_TYPE.ACCESS, { sub: userId, sid, scopes }, { issuedAt, ttl: ttls.accessTtl });
  const refreshToken = sign(TOKEN_TYPE.REFRESH, { sub: userId, sid, jti: uuidv7() }, { issuedAt, ttl: ttls.refreshTtl });

  assertFitsCookie(accessToken, getContext().config.auth.accessTokenMaxBytes);

  return {
    issued: {
      userId,
      sid,
      scopes,
      accessToken,
      refreshToken,
      ...ttls,
    },
    refreshTokenHash: sha256(refreshToken),
    expiresAt: fromUnixSeconds(issuedAt + ttls.refreshTtl),
  };
}
