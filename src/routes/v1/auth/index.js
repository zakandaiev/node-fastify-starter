import { toFailureLocation } from '#core/auth/oauth/flow.js';
import { assertOauthConfig, listEnabledProviders } from '#core/auth/oauth/provider.js';
import { AUTH_ROUTE } from '#enums/auth-route.js';
import {
  CALLBACK_PATH,
  getMe,
  getMeSchema,
  getProviders,
  getProvidersSchema,
  getSignIn,
  getSignInCallback,
  getSignInCallbackSchema,
  getSignInSchema,
  hideOffLoopback,
  postLoginDev,
  postLoginDevSchema,
  postLogout,
  postLogoutSchema,
  postRefresh,
  postRefreshSchema,
} from './controller.js';

const SIGN_IN_MESSAGE = 'Sign-in is set up';
const NOBODY_MESSAGE = 'Nobody can sign in: no provider has both of its credentials (APP_OAUTH_<ID>_CLIENT_ID, APP_OAUTH_<ID>_CLIENT_SECRET), and the dev sign-in is there in dev mode alone';

function logSignIn(fastify, providers) {
  const { isDev } = fastify.config.app;

  fastify.log.info({ signIn: { providers: providers.map((provider) => provider.id), isDevSignInOn: isDev } }, SIGN_IN_MESSAGE);

  if (!providers.length && !isDev) {
    fastify.log.warn(NOBODY_MESSAGE);
  }
}

// A provider without both of its credentials has no routes: its start and its callback are the 404 of an unknown path.
// No HEAD twin: it would run the handler of the GET.
function useProviderRoutes(fastify, provider) {
  const path = `/${provider.id}`;
  const options = {
    security: { auth: false },
    exposeHeadRoute: false,
    config: { providerId: provider.id, failureLocation: toFailureLocation },
  };

  fastify.get(path, { ...options, schema: getSignInSchema }, getSignIn);
  fastify.get(`${path}${CALLBACK_PATH}`, { ...options, schema: getSignInCallbackSchema }, getSignInCallback);
}

export default async function useAuthRoutes(fastify) {
  const { app, oauth } = fastify.config;

  assertOauthConfig(oauth);

  const providers = listEnabledProviders(oauth);

  fastify.get(`/${AUTH_ROUTE.ME}`, {
    schema: getMeSchema,
    security: { auth: true },
  }, getMe);

  fastify.get(`/${AUTH_ROUTE.PROVIDERS}`, {
    schema: getProvidersSchema,
    security: { auth: false },
  }, getProviders);

  fastify.post(`/${AUTH_ROUTE.REFRESH}`, {
    schema: postRefreshSchema,
    security: { auth: false },
  }, postRefresh);

  fastify.post(`/${AUTH_ROUTE.LOGOUT}`, {
    schema: postLogoutSchema,
    security: { auth: true },
  }, postLogout);

  providers.forEach((provider) => useProviderRoutes(fastify, provider));

  if (app.isDev) {
    fastify.post(`/${AUTH_ROUTE.LOGIN_DEV}`, {
      schema: postLoginDevSchema,
      security: { auth: false },
      onRequest: hideOffLoopback,
    }, postLoginDev);
  }

  logSignIn(fastify, providers);
}
