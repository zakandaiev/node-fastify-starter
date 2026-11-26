import { readEnvList } from '#config/env.js';
import { normalizeEmail } from '#utils/string.js';

export function createAuthConfig(env) {
  return Object.freeze({
    // A verified email of this list joins the group admin at its sign-in; normalized as a stored email is.
    adminEmails: Object.freeze(readEnvList(env.APP_ADMIN_EMAILS).map((email) => normalizeEmail(email))),

    accessSecret: env.APP_JWT_ACCESS_SECRET,
    refreshSecret: env.APP_JWT_REFRESH_SECRET,

    // The secret before or after the one in use while the two are being swapped, for checking only; null otherwise.
    accessSecretPrevious: env.APP_JWT_ACCESS_SECRET_PREVIOUS ?? null,
    refreshSecretPrevious: env.APP_JWT_REFRESH_SECRET_PREVIOUS ?? null,

    // Whole seconds: one number of them is the lifetime of a token, of its cookie and of its marker.
    accessTtl: '10m',
    refreshTtl: '30d',

    // However often it is refreshed, a session ends this long after the sign-in that made it.
    sessionMaxAge: '90d',

    // A browser keeps no cookie above 4096 bytes, its name and attributes included.
    accessTokenMaxBytes: 4000,

    // A sign-in above this many live sessions of a user ends the one that has been idle the longest.
    maxSessions: 5,

    // Under config.app.apiPrefix: the refresh cookie rides to this route only.
    refreshRoute: '/v1/auth/refresh',

    // How long a process takes a session it has found alive for alive without asking again.
    registryMemoryTtl: '2s',
    registryMemoryMaxEntries: 10_000,

    // Above db.connectTimeout and db.statementTimeout, so that the failure itself comes first: a connection that went
    // silent must not hold every request that waits for the same row of a session.
    readTimeout: '5s',
  });
}
