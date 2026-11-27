import { toCredentialEnvNames } from '#config/oauth.js';
import { isAllowedTarget } from '#core/auth/oauth/flow.js';
import { getContext } from '#core/context/index.js';
import { AppError } from '#core/error/index.js';
import {
  fetchUpstream,
  isSuccessStatus,
  maskUrl,
  toUpstreamAppError,
  UpstreamError,
} from '#core/http/index.js';
import { AUTH_ROUTE } from '#enums/auth-route.js';
import { CLIENT_AUTHENTICATION } from '#enums/client-authentication.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { UPSTREAM_FAILURE } from '#enums/upstream-failure.js';
import { assertDurations, fromUnixSeconds, isFuture } from '#utils/date.js';
import { decodeBase64Url, encodeFormValue, isBase64Url } from '#utils/encoding.js';
import { sha256 } from '#utils/hash.js';
import { findUnknownKey, getPath } from '#utils/object.js';
import { toValidPersonName } from '#utils/person.js';
import { randomToken } from '#utils/random.js';
import {
  isArray,
  isNonEmptyArray,
  isNonEmptyString,
  isNonNegativeInteger,
  isNumber,
  isObject,
  isPositiveInteger,
  isString,
  parseJsonObject,
} from '#utils/type.js';
import {
  isHostname,
  isLoopbackHostname,
  isSafeRedirectPath,
  isWebUrl,
  toValidEmail,
  URL_MAX_LENGTH,
} from '#utils/validate.js';

// The routes of a provider are /<id> and /<id>/callback beside these: a provider of such an id would take a route's place.
export const RESERVED_ROUTE_NAMES = Object.freeze(Object.values(AUTH_ROUTE));

// Up to the length of user_identities.provider.
const ID_REGEXP = /^[a-z][a-z0-9-]{0,31}$/;

// The flow sets them itself: given by a record, they would change what the sign-in asks for or where it comes back.
const FLOW_PARAMS = Object.freeze([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'response_mode',
  'nonce',
]);

const OPENID_SCOPE = 'openid';
const SCOPE_SEPARATOR = ' ';
const HTTPS_PROTOCOL = 'https:';

const ONE_NAME_CLAIMS = Object.freeze(['email', 'isEmailVerified', 'picture']);
const NAME_CLAIMS = Object.freeze(['firstName', 'lastName']);
const CLAIM_KEYS = Object.freeze(['subject', ...ONE_NAME_CLAIMS, ...NAME_CLAIMS]);

const PICTURE_SIZE_KEYS = Object.freeze(['pattern', 'replacement']);
const SIZE_PLACEHOLDER = '{size}';

const DURATION_KEYS = Object.freeze(['stateTtl', 'timeout', 'pictureTimeout']);
const PATH_KEYS = Object.freeze(['successPath', 'failurePath', 'signInSection']);

const RESPONSE_TYPE = 'code';
const CHALLENGE_METHOD = 'S256';
const CHALLENGE_ENCODING = 'base64url';
const GRANT_TYPE = 'authorization_code';
const INVALID_GRANT = 'invalid_grant';

const SERVICE_PREFIX = 'oauth-';
const BASIC_SCHEME = 'Basic';
const BASIC_SEPARATOR = ':';
const BASE64 = 'base64';
const UTF8 = 'utf8';

const JWT_SEPARATOR = '.';
const JWT_PART_COUNT = 3;
const JWT_PAYLOAD_INDEX = 1;

// RFC 6749 §5.2. Nothing else of an answer goes into an error: error_description and the body are the provider's text.
const OAUTH_ERROR_REGEXP = /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/;
const OAUTH_ERROR_MAX_LENGTH = 64;

// The length of user_identities.provider_user_id, and of a sub in OIDC. utf8mb4_bin is PAD SPACE: "alice " would find
// the identity of "alice", so a subject neither starts nor ends with a space.
const SUBJECT_REGEXP = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const SUBJECT_MAX_LENGTH = 255;

// What an UpstreamError of the token endpoint names as the check its answer failed.
const CHECK = Object.freeze({
  JSON: 'json',
  ERROR: 'error',
  ID_TOKEN: 'id_token',
  ISSUER: 'iss',
  AUDIENCE: 'aud',
  AUTHORIZED_PARTY: 'azp',
  EXPIRY: 'exp',
  SUBJECT: 'subject',
});

const AUTHORIZATION_SIGNATURE = 'createAuthorization(provider, { redirectUri })';
const EXCHANGE_SIGNATURE = 'exchangeCode(provider, { code, verifier, redirectUri })';
const PICTURE_URLS_SIGNATURE = 'listPictureUrls(provider, { pictureUrl, size })';

function describeProvider(provider, index) {
  return isString(provider?.id)
    ? `config.oauth provider "${provider.id}"`
    : `config.oauth provider #${index}`;
}

function assertId(id, label) {
  if (!isString(id) || !ID_REGEXP.test(id)) {
    throw new TypeError(`${label} requires an id of lower-case letters, digits and "-" that starts with a letter, up to 32 characters`);
  }

  if (RESERVED_ROUTE_NAMES.includes(id)) {
    throw new TypeError(`${label} requires an id that is not the name of an auth route: ${RESERVED_ROUTE_NAMES.join(', ')}`);
  }
}

// The id_token is trusted for coming from the token endpoint over TLS, and the picture is copied from what its address
// gives: plain http is for a provider on this machine.
function isTrustedEndpoint(value) {
  if (!isWebUrl(value)) {
    return false;
  }

  const { protocol, hostname } = new URL(value);

  return protocol === HTTPS_PROTOCOL || isLoopbackHostname(hostname);
}

function assertEndpoints(provider, label) {
  const key = ['authorizationUrl', 'tokenUrl'].find((name) => !isTrustedEndpoint(provider[name]));

  if (key !== undefined) {
    throw new TypeError(`${label} requires ${key} to be an https URL without credentials, http only on a loopback host`);
  }
}

function isNameClaims(value) {
  return isNonEmptyString(value) || (isNonEmptyArray(value) && value.every((name) => isNonEmptyString(name)));
}

function isOptional(value, isValid) {
  return value === undefined || isValid(value);
}

// A key of another name would be a typo, and its claim would be left unread without a word.
function assertClaims(claims, label) {
  const isValid = isObject(claims)
    && Object.keys(claims).every((key) => CLAIM_KEYS.includes(key))
    && isNonEmptyString(claims.subject)
    && ONE_NAME_CLAIMS.every((key) => isOptional(claims[key], isNonEmptyString))
    && NAME_CLAIMS.every((key) => isOptional(claims[key], isNameClaims));

  if (!isValid) {
    throw new TypeError(`${label} requires claims of the keys ${CLAIM_KEYS.join(', ')}: subject, email, isEmailVerified and picture each the name of one claim, firstName and lastName a name or a list of names`);
  }
}

// The address of the picture comes from the provider: it and each of its redirects must stay on these hosts.
function assertPictureHosts({ claims, pictureHosts }, label) {
  const isPictureRead = claims.picture !== undefined;

  if (!isPictureRead && pictureHosts !== undefined) {
    throw new TypeError(`${label} names pictureHosts without claims.picture: no picture would be fetched from them`);
  }

  if (isPictureRead && !(isNonEmptyArray(pictureHosts) && pictureHosts.every((host) => isHostname(host)))) {
    throw new TypeError(`${label} requires pictureHosts beside claims.picture: a list of the hosts its picture may come from, each in lower case and without a port`);
  }
}

function compilePattern(source) {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function assertSizeRule(rule, label) {
  if (!isObject(rule)) {
    throw new TypeError(`${label} requires pictureSize to be a plain object of ${PICTURE_SIZE_KEYS.join(' and ')}`);
  }

  const unknownKey = findUnknownKey(rule, PICTURE_SIZE_KEYS);

  if (unknownKey !== undefined) {
    throw new TypeError(`${label} names "${unknownKey}" in pictureSize, which nothing reads: it takes ${PICTURE_SIZE_KEYS.join(', ')}`);
  }

  if (!isNonEmptyString(rule.pattern) || compilePattern(rule.pattern) === null) {
    throw new TypeError(`${label} requires pictureSize.pattern to be the source of a RegExp: a text that compiles, not empty`);
  }

  if (!isString(rule.replacement) || !rule.replacement.includes(SIZE_PLACEHOLDER)) {
    throw new TypeError(`${label} requires pictureSize.replacement to be a text with "${SIZE_PLACEHOLDER}" where the size goes`);
  }
}

function assertPictureSize({ claims, pictureSize }, label) {
  if (pictureSize !== undefined && claims.picture === undefined) {
    throw new TypeError(`${label} names pictureSize without claims.picture: there is no address of a picture to resize`);
  }

  if (pictureSize !== undefined) {
    assertSizeRule(pictureSize, label);
  }
}

function assertAuthorizationParams({ authorizationParams, authorizationUrl }, label) {
  if (!isObject(authorizationParams) || !Object.values(authorizationParams).every((value) => isString(value))) {
    throw new TypeError(`${label} requires authorizationParams to be a plain object of string values`);
  }

  const names = [...Object.keys(authorizationParams), ...new URL(authorizationUrl).searchParams.keys()];
  const name = names.find((key) => FLOW_PARAMS.includes(key));

  if (name !== undefined) {
    throw new TypeError(`${label} names "${name}" in authorizationParams or in the query of authorizationUrl: the flow sets it itself`);
  }
}

function isSet(value) {
  return value !== undefined && value !== null;
}

function assertCredentials({ id, clientId, clientSecret }, label) {
  const names = toCredentialEnvNames(id);

  if (isSet(clientId) !== isSet(clientSecret)) {
    throw new TypeError(`${label} has one credential without the other: set both ${names.clientId} and ${names.clientSecret}, or neither`);
  }

  if (isSet(clientId) && !(isNonEmptyString(clientId) && isNonEmptyString(clientSecret))) {
    throw new TypeError(`${label} requires ${names.clientId} and ${names.clientSecret} to be non-empty strings`);
  }
}

function assertProvider(provider, label) {
  if (!isObject(provider)) {
    throw new TypeError(`${label} requires a record`);
  }

  assertId(provider.id, label);

  if (!isNonEmptyString(provider.name)) {
    throw new TypeError(`${label} requires a name, which the sign-in button shows`);
  }

  if (!isNonEmptyArray(provider.issuers) || !provider.issuers.every((issuer) => isNonEmptyString(issuer))) {
    throw new TypeError(`${label} requires issuers, a list of the values its id_token may give in "iss"`);
  }

  assertEndpoints(provider, label);

  if (!isString(provider.scope) || !provider.scope.split(SCOPE_SEPARATOR).includes(OPENID_SCOPE)) {
    throw new TypeError(`${label} requires a scope that holds "${OPENID_SCOPE}": without it there is no id_token`);
  }

  if (!Object.values(CLIENT_AUTHENTICATION).includes(provider.clientAuthentication)) {
    throw new TypeError(`${label} requires clientAuthentication to be one of: ${Object.values(CLIENT_AUTHENTICATION).join(', ')}`);
  }

  assertClaims(provider.claims, label);
  assertPictureHosts(provider, label);
  assertPictureSize(provider, label);
  assertAuthorizationParams(provider, label);
  assertCredentials(provider, label);
}

function assertUniqueIds(providers) {
  const ids = providers.map((provider) => provider.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);

  if (repeated !== undefined) {
    throw new TypeError(`config.oauth holds two providers of the id "${repeated}"`);
  }
}

// A success path inside the pages of signing in and out would end every sign-in on one of them, a sign-out included.
function assertPaths(oauthConfig) {
  const key = PATH_KEYS.find((name) => !isSafeRedirectPath(oauthConfig[name]));

  if (key !== undefined) {
    throw new TypeError(`config.oauth requires ${key} to be a path of the site that isSafeRedirectPath() takes`);
  }

  if (!isAllowedTarget(oauthConfig.successPath, { oauth: oauthConfig })) {
    throw new TypeError('config.oauth requires successPath outside signInSection');
  }
}

// At the start of the auth routes: a provider set up wrong would show itself only to the first user it fails.
export function assertOauthConfig(oauthConfig) {
  if (!isObject(oauthConfig) || !isArray(oauthConfig.providers)) {
    throw new TypeError('assertOauthConfig(oauthConfig) requires config.oauth with its list of providers');
  }

  assertDurations(oauthConfig, DURATION_KEYS, 'config.oauth');
  assertPaths(oauthConfig);
  oauthConfig.providers.forEach((provider, index) => assertProvider(provider, describeProvider(provider, index)));
  assertUniqueIds(oauthConfig.providers);

  return true;
}

function isEnabled(provider) {
  return isNonEmptyString(provider?.clientId) && isNonEmptyString(provider?.clientSecret);
}

export function listEnabledProviders(oauthConfig) {
  return oauthConfig.providers.filter((provider) => isEnabled(provider));
}

export function findEnabledProvider(oauthConfig, id) {
  return listEnabledProviders(oauthConfig).find((provider) => provider.id === id) ?? null;
}

function assertEnabledProvider(provider, signature) {
  if (!isObject(provider) || !isEnabled(provider)) {
    throw new TypeError(`${signature} requires the record of a provider with both credentials`);
  }

  return true;
}

// The parameters of the flow go last and replace any of the same name: RFC 7636 S256, a verifier of 43 characters.
export function createAuthorization(provider, { redirectUri } = {}) {
  assertEnabledProvider(provider, AUTHORIZATION_SIGNATURE);

  if (!isWebUrl(redirectUri)) {
    throw new TypeError(`${AUTHORIZATION_SIGNATURE} requires redirectUri, the address of its callback`);
  }

  const state = randomToken();
  const verifier = randomToken();
  const url = new URL(provider.authorizationUrl);
  const params = {
    ...provider.authorizationParams,
    response_type: RESPONSE_TYPE,
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    scope: provider.scope,
    state,
    code_challenge: sha256(verifier, CHALLENGE_ENCODING),
    code_challenge_method: CHALLENGE_METHOD,
  };

  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));

  return { url: url.href, state, verifier };
}

function toServiceName(provider) {
  return `${SERVICE_PREFIX}${provider.id}`;
}

function describeCall(provider) {
  return {
    service: toServiceName(provider),
    method: HTTP_METHOD.POST,
    url: maskUrl(provider.tokenUrl),
  };
}

// RFC 6749 §2.3.1: each part is form-encoded first, so a ":" of the id cannot end it.
function toBasicCredentials({ clientId, clientSecret }) {
  const pair = `${encodeFormValue(clientId)}${BASIC_SEPARATOR}${encodeFormValue(clientSecret)}`;

  return `${BASIC_SCHEME} ${Buffer.from(pair, UTF8).toString(BASE64)}`;
}

function readTokenHeaders(provider) {
  return {
    [HEADER.ACCEPT]: MEDIA_TYPE.JSON,
    [HEADER.CONTENT_TYPE]: MEDIA_TYPE.FORM_URLENCODED,
    ...(provider.clientAuthentication === CLIENT_AUTHENTICATION.BASIC && { [HEADER.AUTHORIZATION]: toBasicCredentials(provider) }),
  };
}

function writeTokenForm(provider, { code, verifier, redirectUri }) {
  return new URLSearchParams({
    grant_type: GRANT_TYPE,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: provider.clientId,
    ...(provider.clientAuthentication === CLIENT_AUTHENTICATION.POST && { client_secret: provider.clientSecret }),
  }).toString();
}

// Its key holds no "auth": a key with it is hidden in every log line and alert.
function readProviderError(value) {
  return isString(value) && value.length <= OAUTH_ERROR_MAX_LENGTH && OAUTH_ERROR_REGEXP.test(value)
    ? value
    : undefined;
}

function hasErrorMember(answer) {
  return answer !== null && answer.error !== undefined && answer.error !== null;
}

function toInvalidAnswer(details, check) {
  return toUpstreamAppError(new UpstreamError(UPSTREAM_FAILURE.INVALID_ANSWER, { ...details, check }));
}

// A token endpoint may refuse with a 200 and an "error" member (Telegram does).
function toRefusal(details) {
  return isSuccessStatus(details.status)
    ? new UpstreamError(UPSTREAM_FAILURE.INVALID_ANSWER, { ...details, check: CHECK.ERROR })
    : new UpstreamError(UPSTREAM_FAILURE.STATUS, details);
}

function readTokenAnswer(call, { status, text, durationMs }) {
  const answer = parseJsonObject(text);
  const details = {
    ...call,
    status,
    durationMs,
    providerError: readProviderError(answer?.error),
  };

  // The code is spent, expired or not ours: the user signs in again, and the failure is no fault to alert on.
  if (answer?.error === INVALID_GRANT) {
    throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR, { cause: toRefusal(details) });
  }

  if (!isSuccessStatus(status) || hasErrorMember(answer)) {
    throw toUpstreamAppError(toRefusal(details));
  }

  if (answer === null) {
    throw toInvalidAnswer(details, CHECK.JSON);
  }

  return { answer, details };
}

function readJwtClaims(token) {
  const parts = isString(token)
    ? token.split(JWT_SEPARATOR)
    : [];

  return parts.length === JWT_PART_COUNT && parts.every((part) => isBase64Url(part))
    ? parseJsonObject(decodeBase64Url(parts[JWT_PAYLOAD_INDEX]).toString(UTF8))
    : null;
}

// Telegram writes the id of its bot, the audience, as a number.
function toClaimText(value) {
  return isString(value) || isNumber(value)
    ? String(value)
    : null;
}

// A list may name other audiences only for a token issued to this client, which azp says (OIDC Core 3.1.3.7).
function isAudience({ aud, azp }, clientId) {
  if (!isArray(aud)) {
    return toClaimText(aud) === clientId;
  }

  const audiences = aud.map((item) => toClaimText(item));

  return audiences.includes(clientId) && (audiences.every((item) => item === clientId) || toClaimText(azp) === clientId);
}

function isAuthorizedParty(azp, clientId) {
  return azp === undefined || toClaimText(azp) === clientId;
}

function findFailedCheck(provider, claims) {
  if (claims === null) {
    return CHECK.ID_TOKEN;
  }

  if (!provider.issuers.includes(claims.iss)) {
    return CHECK.ISSUER;
  }

  if (!isAudience(claims, provider.clientId)) {
    return CHECK.AUDIENCE;
  }

  if (!isAuthorizedParty(claims.azp, provider.clientId)) {
    return CHECK.AUTHORIZED_PARTY;
  }

  return isFuture(fromUnixSeconds(claims.exp))
    ? null
    : CHECK.EXPIRY;
}

// No signature and no nonce: the id_token comes straight from the token endpoint over TLS (OIDC Core 3.1.3.7).
function readIdTokenClaims(provider, { answer, details }) {
  const claims = readJwtClaims(answer.id_token);
  const failedCheck = findFailedCheck(provider, claims);

  if (failedCheck !== null) {
    throw toInvalidAnswer(details, failedCheck);
  }

  return claims;
}

// Resolves with the claims of the id_token. invalid_grant in any status is AUTHENTICATION_ERROR; any other refusal and an
// answer that fails a check is UPSTREAM_ERROR with an UpstreamError that names the call, its status and the check.
export async function exchangeCode(provider, { code, verifier, redirectUri } = {}) {
  assertEnabledProvider(provider, EXCHANGE_SIGNATURE);

  if (![code, verifier, redirectUri].every((value) => isNonEmptyString(value))) {
    throw new TypeError(`${EXCHANGE_SIGNATURE} requires the code of the callback, the verifier of its flow and the redirectUri of its authorization`);
  }

  const { config } = getContext();
  const result = await fetchUpstream(provider.tokenUrl, {
    service: toServiceName(provider),
    method: HTTP_METHOD.POST,
    headers: readTokenHeaders(provider),
    body: writeTokenForm(provider, { code, verifier, redirectUri }),
    timeout: config.oauth.timeout,
    secrets: [provider.clientSecret, code, verifier],
  });

  return readIdTokenClaims(provider, readTokenAnswer(describeCall(provider), result));
}

function readClaim(claims, name) {
  return name === undefined
    ? undefined
    : getPath(claims, [name]);
}

function readSubject(provider, value) {
  if (isNonNegativeInteger(value)) {
    return String(value);
  }

  if (isString(value) && value.length <= SUBJECT_MAX_LENGTH && SUBJECT_REGEXP.test(value)) {
    return value;
  }

  throw toInvalidAnswer(describeCall(provider), CHECK.SUBJECT);
}

// The first listed claim that gives a name wins: Google may give a given_name of emoji beside a usable name.
function readName(claims, names) {
  const list = names === undefined
    ? []
    : [names].flat();

  return list
    .map((name) => toValidPersonName(readClaim(claims, name)))
    .find((name) => name !== null) ?? null;
}

export function toValidPictureUrl(value) {
  return isString(value) && value.length <= URL_MAX_LENGTH && isTrustedEndpoint(value)
    ? value
    : null;
}

export function listPictureUrls(provider, { pictureUrl, size } = {}) {
  if (!isObject(provider) || toValidPictureUrl(pictureUrl) === null || !isPositiveInteger(size)) {
    throw new TypeError(`${PICTURE_URLS_SIGNATURE} requires the record of a provider, the address of the picture its profile gives and the size in pixels`);
  }

  if (provider.pictureSize === undefined) {
    return [pictureUrl];
  }

  const { pattern, replacement } = provider.pictureSize;
  const sizedReplacement = replacement.replaceAll(SIZE_PLACEHOLDER, String(size));

  // A function, not the text: "$&" or "$1" in a text given to replace() is a pattern.
  const resized = pictureUrl.replace(new RegExp(pattern), () => sizedReplacement);

  return resized === pictureUrl || toValidPictureUrl(resized) === null
    ? [pictureUrl]
    : [resized, pictureUrl];
}

// The claims are kept as they came, for the profile of the identity.
export function readProviderProfile(provider, claims) {
  if (!isObject(provider?.claims) || !isObject(claims)) {
    throw new TypeError('readProviderProfile(provider, claims) requires the record of a provider and the claims exchangeCode() gave');
  }

  const email = toValidEmail(readClaim(claims, provider.claims.email));
  const isVerified = readClaim(claims, provider.claims.isEmailVerified);

  return {
    subject: readSubject(provider, readClaim(claims, provider.claims.subject)),
    email,
    isEmailVerified: email !== null && (isVerified === true || isVerified === 'true'),
    firstName: readName(claims, provider.claims.firstName),
    lastName: readName(claims, provider.claims.lastName),
    pictureUrl: toValidPictureUrl(readClaim(claims, provider.claims.picture)),
    claims,
  };
}
