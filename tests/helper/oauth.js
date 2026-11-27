import { CLIENT_AUTHENTICATION } from '#enums/client-authentication.js';
import { HEADER } from '#enums/header.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { convertStringToSeconds, nowUtc, toUnixSeconds } from '#utils/date.js';
import { decodeFormValue, encodeBase64Url } from '#utils/encoding.js';
import { sha256 } from '#utils/hash.js';
import { toMimeEssence } from '#utils/mime.js';
import { freezeDeep } from '#utils/object.js';
import { randomToken } from '#utils/random.js';
import { isArray, isNonEmptyString, isString } from '#utils/type.js';
import { once } from 'node:events';
import http from 'node:http';

const LOOPBACK = '127.0.0.1';
const AUTHORIZE_PATH = '/authorize';
const TOKEN_PATH = '/token';

// Where the auth routes are under the API prefix: a provider starts at /<id>.
const AUTH_ROUTES_PATH = '/v1/auth';

const ID_TOKEN_TTL = '10m';
const ACCESS_TOKEN_TTL = '1h';
const SUBJECT_BYTES = 16;
const TOKEN_TYPE = 'Bearer';
const ID_TOKEN_HEADER = Object.freeze({ alg: 'RS256', typ: 'JWT', kid: 'mock' });
const JWT_SEPARATOR = '.';

// Never checked: the app trusts an id_token for coming from the token endpoint.
const SIGNATURE = encodeBase64Url('mock-signature');

const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
const BASIC_REGEXP = /^Basic +(\S+)$/i;
const BASIC_SEPARATOR = ':';
const BASE64 = 'base64';
const UTF8 = 'utf8';

// RFC 7636 §4.1: what a verifier may be made of, and how long.
const VERIFIER_REGEXP = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_ENCODING = 'base64url';

const RESPONSE_TYPE = 'code';
const CHALLENGE_METHOD = 'S256';
const GRANT_TYPE = 'authorization_code';
const OPENID_SCOPE = 'openid';
const SCOPE_SEPARATOR = ' ';
const LINK_VALUE = 'true';

const OAUTH_ERROR = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  INVALID_CLIENT: 'invalid_client',
  INVALID_GRANT: 'invalid_grant',
  UNSUPPORTED_GRANT_TYPE: 'unsupported_grant_type',
});

// The text every refusal of the mock carries beside its error: a test looks for it where it must never be.
export const REFUSAL_DESCRIPTION = 'The mock provider refused this request of the test';

// A provider of the tests, never one on the network: what a test does not name.
const MOCK_FIELDS = freezeDeep({
  id: 'mock',
  name: 'Mock',
  scope: 'openid email profile',
  authorizationParams: {},
  clientAuthentication: CLIENT_AUTHENTICATION.POST,
  claims: {
    subject: 'sub',
    email: 'email',
    isEmailVerified: 'email_verified',
    firstName: ['given_name', 'name'],
    lastName: 'family_name',
  },
  clientId: 'mock-client',
  clientSecret: 'mock-secret',
});

function refuse(status, error) {
  return { status, body: { error, error_description: REFUSAL_DESCRIPTION } };
}

function toBodyText(body) {
  if (body === undefined) {
    return '';
  }

  return isString(body)
    ? body
    : JSON.stringify(body);
}

// A text body goes out as it is given, anything else as JSON; a hanging answer is never written.
function writeAnswer(response, {
  status = HTTP_STATUS.OK,
  body,
  headers = {},
  isHanging = false,
}) {
  if (isHanging) {
    return false;
  }

  const contentType = isString(body)
    ? TEXT_CONTENT_TYPE
    : MEDIA_TYPE.JSON_UTF8;

  response.writeHead(status, { [HEADER.CONTENT_TYPE]: contentType, ...headers });
  response.end(toBodyText(body));

  return true;
}

// RFC 6749 §2.3.1: the id and the secret are form-encoded before they are joined.
function readBasicCredentials(authorization) {
  const [, encoded] = BASIC_REGEXP.exec(authorization ?? '') ?? [];
  const pair = encoded === undefined
    ? ''
    : Buffer.from(encoded, BASE64).toString(UTF8);
  const separatorAt = pair.indexOf(BASIC_SEPARATOR);

  return separatorAt === -1
    ? null
    : { clientId: decodeFormValue(pair.slice(0, separatorAt)), clientSecret: decodeFormValue(pair.slice(separatorAt + 1)) };
}

// One way of client authentication per request, the one of the record (RFC 6749 §2.3).
function isClientAuthenticated(record, { headers, form }) {
  if (record.clientAuthentication === CLIENT_AUTHENTICATION.BASIC) {
    const credentials = readBasicCredentials(headers[HEADER.AUTHORIZATION]);

    return form.client_secret === undefined
      && credentials?.clientId === record.clientId
      && credentials?.clientSecret === record.clientSecret;
  }

  return headers[HEADER.AUTHORIZATION] === undefined
    && form.client_id === record.clientId
    && form.client_secret === record.clientSecret;
}

// The code was issued for this redirect_uri and this challenge, and only once: PKCE S256 of the verifier is the challenge.
function isGrantValid(grant, { form }, record) {
  return grant !== undefined
    && !grant.isUsed
    && form.redirect_uri === grant.redirectUri
    && (form.client_id === undefined || form.client_id === record.clientId)
    && VERIFIER_REGEXP.test(form.code_verifier ?? '')
    && sha256(form.code_verifier, CHALLENGE_ENCODING) === grant.challenge;
}

function findRefusal(mock, received) {
  if (toMimeEssence(received.headers[HEADER.CONTENT_TYPE] ?? '') !== MEDIA_TYPE.FORM_URLENCODED) {
    return refuse(HTTP_STATUS.BAD_REQUEST, OAUTH_ERROR.INVALID_REQUEST);
  }

  if (!isClientAuthenticated(mock.record, received)) {
    return refuse(HTTP_STATUS.UNAUTHORIZED, OAUTH_ERROR.INVALID_CLIENT);
  }

  if (received.form.grant_type !== GRANT_TYPE) {
    return refuse(HTTP_STATUS.BAD_REQUEST, OAUTH_ERROR.UNSUPPORTED_GRANT_TYPE);
  }

  return isGrantValid(mock.grants.get(received.form.code), received, mock.record)
    ? null
    : refuse(HTTP_STATUS.BAD_REQUEST, OAUTH_ERROR.INVALID_GRANT);
}

// An id_token as a provider writes it, unsigned: the claims of the test go over the defaults, and one set to undefined
// is left out.
function createIdToken(mock, claims = {}) {
  const issuedAt = toUnixSeconds(nowUtc());
  const payload = {
    iss: mock.url,
    aud: mock.record.clientId,
    sub: randomToken(SUBJECT_BYTES),
    iat: issuedAt,
    exp: issuedAt + convertStringToSeconds(ID_TOKEN_TTL),
    ...claims,
  };

  return [...[ID_TOKEN_HEADER, payload].map((part) => encodeBase64Url(JSON.stringify(part))), SIGNATURE].join(JWT_SEPARATOR);
}

// The override of a code is its answer once the request has passed every check.
function answerToken(mock, received) {
  if (received.method !== HTTP_METHOD.POST || received.path !== TOKEN_PATH) {
    return { status: HTTP_STATUS.NOT_FOUND, body: { error: OAUTH_ERROR.INVALID_REQUEST } };
  }

  const refusal = findRefusal(mock, received);

  if (refusal !== null) {
    return refusal;
  }

  const grant = mock.grants.get(received.form.code);

  grant.isUsed = true;

  return grant.answer ?? {
    status: HTTP_STATUS.OK,
    body: {
      id_token: createIdToken(mock, grant.claims),
      token_type: TOKEN_TYPE,
      access_token: randomToken(),
      expires_in: convertStringToSeconds(ACCESS_TOKEN_TTL),
    },
  };
}

function handleRequests(mock) {
  function handleRequest(request, response) {
    const chunks = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString(UTF8);
      const received = {
        method: request.method,
        path: request.url,
        headers: request.headers,
        body,
        form: Object.fromEntries(new URLSearchParams(body)),
      };

      mock.requests.push(received);
      writeAnswer(response, answerToken(mock, received));
    });
  }

  return handleRequest;
}

async function listen(t, handleRequest) {
  const sockets = new Set();
  const server = http.createServer(handleRequest);

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  t.after(() => {
    sockets.forEach((socket) => socket.destroy());
    server.close();
  });

  server.listen(0, LOOPBACK);
  await once(server, 'listening');

  return `http://${LOOPBACK}:${server.address().port}`;
}

function issueCode(mock, {
  claims = {},
  challenge = null,
  redirectUri = null,
  answer = null,
} = {}) {
  const code = randomToken();

  mock.grants.set(code, {
    claims,
    challenge,
    redirectUri,
    answer,
    isUsed: false,
  });

  return code;
}

function toEndpoint(url) {
  return `${url.origin}${url.pathname}`;
}

function isAuthorizationUrl(mock, location) {
  return isString(location) && URL.canParse(location) && toEndpoint(new URL(location)) === mock.record.authorizationUrl;
}

// What a provider refuses with a page of its own: the test fails here with the list of what is missing.
function readAuthorizationRequest(mock, location) {
  const { record } = mock;
  const params = isAuthorizationUrl(mock, location)
    ? Object.fromEntries(new URL(location).searchParams)
    : {};
  const requirements = [
    [isAuthorizationUrl(mock, location), 'the address of the authorization endpoint'],
    [params.response_type === RESPONSE_TYPE, 'response_type=code'],
    [params.client_id === record.clientId, 'the client_id of the record'],
    [URL.canParse(params.redirect_uri ?? ''), 'a redirect_uri'],
    [(params.scope ?? '').split(SCOPE_SEPARATOR).includes(OPENID_SCOPE), 'a scope with openid'],
    [isNonEmptyString(params.state), 'a state'],
    [isNonEmptyString(params.code_challenge), 'a code_challenge'],
    [params.code_challenge_method === CHALLENGE_METHOD, 'code_challenge_method=S256'],
    ...Object.entries(record.authorizationParams).map(([name, value]) => [params[name] === value, `${name}=${value}`]),
  ];
  const missing = requirements.filter(([isMet]) => !isMet).map(([, what]) => what);

  if (missing.length) {
    throw new Error(`The mock provider refuses the authorization request: it needs ${missing.join(', ')}`);
  }

  return params;
}

// The consent of the user: the code it issues is bound to the challenge and the redirect_uri of the request, and the
// browser is sent back to the callback with it, or with the error of a sign-in the user did not finish.
function authorize(mock, location, { claims = {}, answer = null, error = null } = {}) {
  const params = readAuthorizationRequest(mock, location);
  const code = error === null
    ? issueCode(mock, {
      claims,
      challenge: params.code_challenge,
      redirectUri: params.redirect_uri,
      answer,
    })
    : null;
  const callback = new URL(params.redirect_uri);
  const answered = code === null
    ? { error, state: params.state }
    : { code, state: params.state };

  Object.entries(answered).forEach(([name, value]) => callback.searchParams.set(name, value));

  return { code, state: params.state, location: callback.href };
}

// A provider on 127.0.0.1:0 for the token endpoint, and its record with credentials: createTestConfig({ oauth:
// { providers: [mock.record] } }) is the third provider of the config. The options name fields of the record.
export async function createMockProvider(t, fields = {}) {
  const mock = { requests: [], grants: new Map() };

  mock.url = await listen(t, handleRequests(mock));
  mock.record = freezeDeep({
    ...MOCK_FIELDS,
    issuers: [mock.url],
    authorizationUrl: `${mock.url}${AUTHORIZE_PATH}`,
    tokenUrl: `${mock.url}${TOKEN_PATH}`,
    ...fields,
  });

  return {
    url: mock.url,
    record: mock.record,
    requests: mock.requests,
    issueCode: (grant) => issueCode(mock, grant),
    authorize: (location, consent) => authorize(mock, location, consent),
    createIdToken: (claims) => createIdToken(mock, claims),
    isAuthorizationUrl: (location) => isAuthorizationUrl(mock, location),
  };
}

// The host of the pictures of a provider, on 127.0.0.1:0: "answer" writes each response, and every request is recorded
// as it comes. The fetch reaches it when the record names 127.0.0.1 among its pictureHosts and the app lets it through
// config.http.external.allowedPrivateNetworks.
export async function createPictureServer(t, answer) {
  const requests = [];
  const url = await listen(t, (request, response) => {
    requests.push({ method: request.method, path: request.url, headers: request.headers });
    request.resume();
    answer(request, response);
  });

  return { url, requests };
}

function toStartUrl(fastify, mock, { redirect, link }) {
  const query = new URLSearchParams();

  if (redirect !== undefined) {
    query.set('redirect', redirect);
  }

  if (link) {
    query.set('link', LINK_VALUE);
  }

  const search = query.size
    ? `?${query}`
    : '';

  return `${fastify.config.app.apiPrefix}${AUTH_ROUTES_PATH}/${mock.record.id}${search}`;
}

// Null or undefined takes the parameter away.
function withQuery(url, overrides) {
  Object.entries(overrides).forEach(([name, value]) => {
    if (value === null || value === undefined) {
      url.searchParams.delete(name);
    } else {
      url.searchParams.set(name, value);
    }
  });

  return url;
}

// Undefined for none: inject() writes an empty Cookie header for an empty list.
function toCookieList(cookies, ...more) {
  const list = [
    ...(isArray(cookies) ? cookies : Object.entries(cookies).map(([name, value]) => ({ name, value }))),
    ...more,
  ];

  return list.length
    ? list
    : undefined;
}

// With their paths: inject() sends a cookie only to a path it matches, as a browser does (RFC 6265 §5.1.4).
function readSetCookies(response) {
  return response.cookies
    .filter((cookie) => cookie.maxAge === undefined || cookie.maxAge > 0)
    .map(({ name, value, path }) => ({ name, value, path }));
}

// Start, consent and callback as a browser goes through them: the start sets the flow cookies and sends the browser to
// the provider, which sends it to the callback with a code. A start that does not lead to the provider ends the walk.
export async function signInThroughProvider(fastify, mock, {
  claims,
  answer,
  error,
  redirect,
  link = false,
  cookies = {},
  callbackCookies = cookies,
  callbackQuery = {},
  headers = {},
} = {}) {
  const start = await fastify.inject({
    method: HTTP_METHOD.GET,
    url: toStartUrl(fastify, mock, { redirect, link }),
    headers,
    cookies: toCookieList(cookies),
  });
  const startLocation = start.headers[HEADER.LOCATION] ?? null;

  if (!mock.isAuthorizationUrl(startLocation)) {
    return {
      start,
      authorization: null,
      callback: null,
      location: startLocation,
    };
  }

  const authorization = mock.authorize(startLocation, { claims, answer, error });
  const callbackUrl = withQuery(new URL(authorization.location), callbackQuery);
  const callback = await fastify.inject({
    method: HTTP_METHOD.GET,
    url: `${callbackUrl.pathname}${callbackUrl.search}`,
    headers,
    cookies: toCookieList(callbackCookies, ...readSetCookies(start)),
  });

  return {
    start,
    authorization,
    callback,
    location: callback.headers[HEADER.LOCATION] ?? null,
  };
}
