import { SCHEMA_LIMITS } from '#config/schema.js';
import { linkProvider, signInWithProvider } from '#core/auth/account.js';
import { authenticateRequest } from '#core/auth/authenticate.js';
import { isLoopbackOnlyRequest, readClient } from '#core/auth/client.js';
import { clearAuthCookies, endAuthCookies, setAuthCookies } from '#core/auth/cookie.js';
import { signInForDev } from '#core/auth/dev-login.js';
import { setFlowCookies, takeFlowCookies, toSuccessLocation } from '#core/auth/oauth/flow.js';
import {
  createAuthorization,
  exchangeCode,
  findEnabledProvider,
  listEnabledProviders,
  readProviderProfile,
} from '#core/auth/oauth/provider.js';
import { refreshSession } from '#core/auth/refresh.js';
import { revokeSession } from '#core/auth/session.js';
import { readRefreshToken } from '#core/auth/token.js';
import { AppError } from '#core/error/index.js';
import { createSchema } from '#core/schema/create-schema.js';
import { CACHE_CONTROL } from '#enums/cache-control.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HEADER } from '#enums/header.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { SCOPE } from '#enums/scope.js';
import { email, text, uuid } from '#schemas/common/field.js';
import { timingSafeEqual } from '#utils/hash.js';
import { freezeDeep, pick } from '#utils/object.js';
import { REDIRECT_PATH_MAX_LENGTH } from '#utils/validate.js';

// The callback of a provider is the path of its start and this: index.js declares it, the start sends the flow cookies
// and the provider there.
export const CALLBACK_PATH = '/callback';

const STATE_KEYS = Object.freeze(['id', 'scopes']);
const DEV_SIGN_IN_KEYS = Object.freeze([...STATE_KEYS, 'accessToken']);

const authState = freezeDeep({
  properties: {
    id: uuid('User id'),
    scopes: { type: 'array', items: text('Scope'), description: 'What the user may do: codes of the scope catalog; * is everything, <resource>:* every action of its resource' },
  },
  example: {
    id: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b',
    scopes: [SCOPE.GROUPS_READ, SCOPE.USERS_READ],
  },
});

const devSignIn = freezeDeep({
  properties: {
    email: email('Email of the user to sign in as; a user is made for one nobody holds, with the email verified'),
    accessToken: { type: 'string', description: 'The access token of the cookie, for the header Authorization: Bearer' },
  },
  example: {
    email: 'anna@example.com',
  },
});

const providerFields = freezeDeep({
  properties: {
    id: text('Id of the provider, the segment of its sign-in routes'),
    name: text('Name of the provider, for its sign-in button'),
  },
  example: {
    id: 'google',
    name: 'Google',
  },
});

const PROVIDER_KEYS = Object.freeze(Object.keys(providerFields.properties));

const signInFields = freezeDeep({
  properties: {
    redirect: text('Path of the site the sign-in ends on; one off the site or inside the pages of signing in is left out', {
      maxLength: REDIRECT_PATH_MAX_LENGTH,
    }),
    link: { type: 'boolean', description: 'Link the account at the provider to the user who is signed in, instead of signing in' },
    code: text('Code the provider has issued', { maxLength: SCHEMA_LIMITS.authorizationCodeMaxLength }),
    state: text('State of the flow, as the provider sends it back'),
    error: text('Error the provider sends back in place of a code, such as access_denied'),
  },
});

export async function getMe(request, reply) {
  return reply.ok(request.user);
}

export const getMeSchema = createSchema(authState)
  .meta({
    tags: ['Auth'],
    summary: 'Get the state of the sign-in',
    description: 'The id and the scopes the access token carries',
  })
  .response(HTTP_STATUS.OK, { data: STATE_KEYS })
  .defaultResponses()
  .build();

export async function getProviders(request, reply) {
  const providers = listEnabledProviders(request.server.config.oauth);

  return reply.list({ data: providers.map((record) => pick(record, PROVIDER_KEYS)) });
}

export const getProvidersSchema = createSchema(providerFields)
  .meta({
    tags: ['Auth'],
    summary: 'List the providers a user can sign in with',
    description: 'Those with both of their credentials, in the order of the config: the buttons of the sign-in page',
  })
  .response(HTTP_STATUS.OK, { data: PROVIDER_KEYS, format: 'array' })
  .defaultResponses()
  .build();

// A redirect of a sign-in carries its cookies: a cache that kept it would hand them to another browser.
function redirectUnstored(reply, location) {
  return reply
    .header(HEADER.CACHE_CONTROL, CACHE_CONTROL.NO_STORE)
    .redirect(location, HTTP_STATUS.FOUND);
}

function readProvider(request) {
  return findEnabledProvider(request.server.config.oauth, request.routeOptions.config.providerId);
}

function toRedirectUri(config, callbackPath) {
  return `${config.app.url}${callbackPath}`;
}

// A link is asked for by a user who is signed in: its flow carries the session it starts under.
async function readLinkSession(request) {
  if (request.query.link !== true) {
    return null;
  }

  const { session } = await authenticateRequest(request);

  return session.id;
}

export async function getSignIn(request, reply) {
  const { config } = request.server;
  const callbackPath = `${request.routeOptions.url}${CALLBACK_PATH}`;
  const sid = await readLinkSession(request);
  const { url, state, verifier } = createAuthorization(readProvider(request), { redirectUri: toRedirectUri(config, callbackPath) });

  setFlowCookies(reply, {
    path: callbackPath,
    state,
    verifier,
    sid,
    target: request.query.redirect ?? null,
  });

  return redirectUnstored(reply, url);
}

export const getSignInSchema = createSchema(signInFields)
  .meta({
    tags: ['Auth'],
    summary: 'Start a sign-in through the provider',
    description: 'A navigation of the browser, not a call: it is sent to the provider, with the cookies of the flow on the path of the callback. A failure sends it to the sign-in page with authError=<code>; a failed link sends it to its redirect with authError=<code>',
  })
  .query(['redirect', 'link'])
  .response(HTTP_STATUS.FOUND, { description: 'To the provider, or to the page that tells of the failure' })
  .build();

// The location first: nothing is written for a sign-in whose answer could not be sent.
async function finishSignIn(request, reply, flow) {
  const location = toSuccessLocation(request.server.config, { target: flow.started.target });
  const issued = await signInWithProvider({
    providerId: flow.record.id,
    profile: flow.profile,
    client: flow.client,
    request,
  });

  setAuthCookies(reply, issued);

  return redirectUnstored(reply, location);
}

// Finished under the session it was started under alone, and before the code is spent: the browser may have changed
// its user in between.
async function readLinkUser(request, sid) {
  const { user, session } = await authenticateRequest(request);

  if (!timingSafeEqual(session.id, sid)) {
    throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
  }

  return user.id;
}

async function finishLink(request, reply, flow) {
  const location = toSuccessLocation(request.server.config, { target: flow.started.target, linkedProviderId: flow.record.id });

  await linkProvider({
    userId: flow.userId,
    providerId: flow.record.id,
    profile: flow.profile,
    request,
  });

  return redirectUnstored(reply, location);
}

// The state of the query is that of the cookie in the browser that started the flow alone: the callback URL of
// another flow, sent to a victim, signs nobody in.
export async function getSignInCallback(request, reply) {
  const client = readClient(request);
  const { config } = request.server;
  const callbackPath = request.routeOptions.url;
  const started = takeFlowCookies(request, reply, { path: callbackPath });
  const { code, state, error } = request.query;

  if (started === null || error !== undefined || code === undefined || !timingSafeEqual(started.state, state)) {
    throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
  }

  const userId = started.sid === null
    ? null
    : await readLinkUser(request, started.sid);
  const record = readProvider(request);
  const claims = await exchangeCode(record, { code, verifier: started.verifier, redirectUri: toRedirectUri(config, callbackPath) });
  const flow = { record, profile: readProviderProfile(record, claims), started };

  return userId === null
    ? finishSignIn(request, reply, { ...flow, client })
    : finishLink(request, reply, { ...flow, userId });
}

export const getSignInCallbackSchema = createSchema(signInFields)
  .meta({
    tags: ['Auth'],
    summary: 'Finish a sign-in through the provider',
    description: 'Where the provider sends the browser back; it answers with a redirect alone. A sign-in sets the cookies of its session and ends on the redirect of its start, a link adds linked=<id>. A failure ends on the sign-in page with authError=<code>, a failed link on its redirect. The cookies of the flow are cleared once they are read, whatever comes next',
  })
  .query(['code', 'state', 'error'])
  .response(HTTP_STATUS.FOUND, { description: 'To the page the sign-in ends on, or to the page that tells of the failure' })
  .build();

// reply.raw tells of a client that has gone: request.raw is destroyed after every POST read to its end.
async function rotate(request, reply) {
  try {
    return await refreshSession({
      token: readRefreshToken(request),
      request,
      isAbandoned: () => reply.raw.destroyed,
    });
  } catch (error) {
    if (error?.code === ERROR_CODE.SESSION_REVOKED) {
      clearAuthCookies(reply);
    }

    throw error;
  }
}

export async function postRefresh(request, reply) {
  const issued = await rotate(request, reply);

  setAuthCookies(reply, issued);

  return reply.ok({ id: issued.userId, scopes: issued.scopes });
}

export const postRefreshSchema = createSchema(authState)
  .meta({
    tags: ['Auth'],
    summary: 'Rotate the tokens',
    description: 'Takes the refresh token from its cookie only and sets new cookies. SESSION_REVOKED: the session is over, also because the token had been replaced before; the cookies are cleared. AUTHENTICATION_ERROR: there is no usable token, or the session has changed since it was read (another request has just rotated the token, or the session has ended); the cookies stay. 503: nothing was rotated, try again',
  })
  .response(HTTP_STATUS.OK, { data: STATE_KEYS })
  .defaultResponses()
  .build();

export async function postLogout(request, reply) {
  await revokeSession({ sid: request.session.id, userId: request.user.id });
  endAuthCookies(request, reply);

  return reply.noContent();
}

export const postLogoutSchema = createSchema(authState)
  .meta({ tags: ['Auth'], summary: 'End the current session' })
  .response(HTTP_STATUS.NO_CONTENT)
  .defaultResponses()
  .build();

// Before the body is read: a client that is not on this machine meets a route that is not there, whatever it sends.
export async function hideOffLoopback(request, reply) {
  if (isLoopbackOnlyRequest(request)) {
    return true;
  }

  reply.callNotFound();

  // The reply, not a value: the hooks wait until it is sent and never go on to the body and the handler.
  return reply;
}

export async function postLoginDev(request, reply) {
  const issued = await signInForDev({ email: request.body.email, client: readClient(request), request });

  setAuthCookies(reply, issued);
  reply.header(HEADER.CACHE_CONTROL, CACHE_CONTROL.NO_STORE);

  return reply.ok({ id: issued.userId, scopes: issued.scopes, accessToken: issued.accessToken });
}

export const postLoginDevSchema = createSchema(authState, devSignIn)
  .meta({
    tags: ['Auth'],
    summary: 'Sign in by an email alone, in dev mode',
    description: 'There in dev mode only, and for a request of this machine only: a client of another address, or one through a proxy that is not on this machine, gets 404. A session of dev mode; the body carries the access token for Authorization: Bearer beside the cookies',
  })
  .body(['email'], { required: ['email'] })
  .response(HTTP_STATUS.OK, { data: DEV_SIGN_IN_KEYS })
  .defaultResponses()
  .build();
