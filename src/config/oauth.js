import { CLIENT_AUTHENTICATION } from '#enums/client-authentication.js';
import { freezeDeep } from '#utils/object.js';

const CREDENTIAL_PREFIX = 'APP_OAUTH_';

// What sets one provider apart from another lives in its record: a third provider is one more record, and the code
// that signs in through them does not change. A record is on when env gives both of its credentials.
const PROVIDERS = freezeDeep([
  {
    id: 'google',
    name: 'Google',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    authorizationParams: { prompt: 'select_account' },
    clientAuthentication: CLIENT_AUTHENTICATION.POST,
    claims: {
      subject: 'sub',
      email: 'email',
      isEmailVerified: 'email_verified',
      firstName: ['given_name', 'name'],
      lastName: 'family_name',
    },
  },
  {
    id: 'telegram',
    name: 'Telegram',
    issuers: ['https://oauth.telegram.org'],
    authorizationUrl: 'https://oauth.telegram.org/auth',
    tokenUrl: 'https://oauth.telegram.org/token',
    scope: 'openid profile',
    authorizationParams: {},
    clientAuthentication: CLIENT_AUTHENTICATION.BASIC,
    // Its sub is not the id of the Telegram account, and a sign-in through a Mini App knows that id alone: both ways
    // must find one identity.
    claims: {
      subject: 'id',
      firstName: ['given_name', 'name'],
      lastName: 'family_name',
    },
  },
]);

// APP_OAUTH_<ID>_CLIENT_ID and APP_OAUTH_<ID>_CLIENT_SECRET, with the id in upper case and "_" in place of "-".
export function toCredentialEnvNames(id) {
  const prefix = `${CREDENTIAL_PREFIX}${id.toUpperCase().replaceAll('-', '_')}`;

  return {
    clientId: `${prefix}_CLIENT_ID`,
    clientSecret: `${prefix}_CLIENT_SECRET`,
  };
}

function withCredentials(provider, env) {
  const names = toCredentialEnvNames(provider.id);

  return {
    ...provider,
    clientId: env[names.clientId] ?? null,
    clientSecret: env[names.clientSecret] ?? null,
  };
}

export function createOauthConfig(env) {
  return freezeDeep({
    providers: PROVIDERS.map((provider) => withCredentials(provider, env)),

    // How long the cookies of one sign-in live: the time a user has at the provider.
    stateTtl: '10m',

    // A call of the token endpoint, which the browser waits for on the callback.
    timeout: '10s',

    // Paths of the site: where a sign-in ends without a target of its own, and where a failed one is told of.
    successPath: '/',
    failurePath: '/auth/login',

    // The pages of signing in and out: a target inside them is refused, since after the sign-in it would end it or loop.
    signInSection: '/auth',
  });
}
