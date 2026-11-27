import { createConfig } from '#config/index.js';
import { createOauthConfig, toCredentialEnvNames } from '#config/oauth.js';
import { listPictureUrls } from '#core/auth/oauth/provider.js';
import { CLIENT_AUTHENTICATION } from '#enums/client-authentication.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { createTestConfig, createTestEnv } from '#root/tests/helper/config.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { convertStringToMs, convertStringToSeconds } from '#utils/date.js';
import { freezeDeep } from '#utils/object.js';
import { isSafeRedirectPath } from '#utils/validate.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const MINUTE_SECONDS = 60;
const PICTURE_TIMEOUT_MS = 5000;

const GOOGLE_PICTURE = 'https://lh3.googleusercontent.com/a/ACg8ocJ4mVqTnXk2bW9pLr7sYd0fHe3uZa1cQo5iGj8tEw6xNy';
const TELEGRAM_PICTURE = 'https://t.me/i/userpic/320/anna_kovalenko.jpg';
const OPENID_SCOPE = 'openid';
const HTTPS_PROTOCOL = 'https:';

const GOOGLE = freezeDeep({
  id: 'google',
  name: 'Google',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: 'openid email profile',
  authorizationParams: { prompt: 'select_account' },
  clientAuthentication: 'client_secret_post',
  claims: {
    subject: 'sub',
    email: 'email',
    isEmailVerified: 'email_verified',
    firstName: ['given_name', 'name'],
    lastName: 'family_name',
    picture: 'picture',
  },
  pictureHosts: ['googleusercontent.com'],
  pictureSize: { pattern: '=s\\d+(?=(?:-[a-z0-9]+)*$)', replacement: '=s{size}' },
  clientId: null,
  clientSecret: null,
});

const TELEGRAM = freezeDeep({
  id: 'telegram',
  name: 'Telegram',
  issuers: ['https://oauth.telegram.org'],
  authorizationUrl: 'https://oauth.telegram.org/auth',
  tokenUrl: 'https://oauth.telegram.org/token',
  scope: 'openid profile',
  authorizationParams: {},
  clientAuthentication: 'client_secret_basic',
  claims: {
    subject: 'id',
    firstName: ['given_name', 'name'],
    lastName: 'family_name',
    picture: 'picture',
  },
  pictureHosts: ['t.me', 'telesco.pe'],
  clientId: null,
  clientSecret: null,
});

// Never sent anywhere: a config test only reads them.
const GOOGLE_ENV = Object.freeze({
  APP_OAUTH_GOOGLE_CLIENT_ID: 'config-google-client.apps.example.com',
  APP_OAUTH_GOOGLE_CLIENT_SECRET: 'config-google-secret',
});
const TELEGRAM_ENV = Object.freeze({
  APP_OAUTH_TELEGRAM_CLIENT_ID: '1234567890',
  APP_OAUTH_TELEGRAM_CLIENT_SECRET: 'config-telegram-secret',
});

function readProviders(env) {
  return createConfig(createTestEnv(env)).oauth.providers;
}

function isInSection(path, section) {
  return path === section || path.startsWith(`${section}/`);
}

describe('config.oauth', () => {
  test('holds Google and Telegram as two records, each off without its credentials', () => {
    assert.deepEqual(readProviders(), [GOOGLE, TELEGRAM]);
    assert.deepEqual(createOauthConfig({}).providers, [GOOGLE, TELEGRAM]);
  });

  test('takes the credentials of a provider from APP_OAUTH_<ID>_CLIENT_ID and APP_OAUTH_<ID>_CLIENT_SECRET', () => {
    assert.deepEqual(readProviders({ ...GOOGLE_ENV, ...TELEGRAM_ENV }), [
      { ...GOOGLE, clientId: GOOGLE_ENV.APP_OAUTH_GOOGLE_CLIENT_ID, clientSecret: GOOGLE_ENV.APP_OAUTH_GOOGLE_CLIENT_SECRET },
      { ...TELEGRAM, clientId: TELEGRAM_ENV.APP_OAUTH_TELEGRAM_CLIENT_ID, clientSecret: TELEGRAM_ENV.APP_OAUTH_TELEGRAM_CLIENT_SECRET },
    ]);
  });

  test('takes the credentials of one provider without touching the other', () => {
    assert.deepEqual(readProviders(TELEGRAM_ENV)[0], GOOGLE);
    assert.deepEqual(readProviders(GOOGLE_ENV)[1], TELEGRAM);
  });

  test('takes one credential without the other as it is, and a blank one for none: the auth routes refuse half of a provider at start', () => {
    const secretOnly = { APP_OAUTH_GOOGLE_CLIENT_SECRET: GOOGLE_ENV.APP_OAUTH_GOOGLE_CLIENT_SECRET };

    assert.deepEqual(readProviders(secretOnly)[0], { ...GOOGLE, clientSecret: GOOGLE_ENV.APP_OAUTH_GOOGLE_CLIENT_SECRET });
    assert.deepEqual(readProviders({ APP_OAUTH_GOOGLE_CLIENT_ID: '  ', APP_OAUTH_GOOGLE_CLIENT_SECRET: '' })[0], GOOGLE);
  });

  test('names the variables of the credentials by the id in upper case, with an underscore for a hyphen', () => {
    assert.deepEqual(toCredentialEnvNames('google'), {
      clientId: 'APP_OAUTH_GOOGLE_CLIENT_ID',
      clientSecret: 'APP_OAUTH_GOOGLE_CLIENT_SECRET',
    });
    assert.deepEqual(toCredentialEnvNames('corp-sso-2'), {
      clientId: 'APP_OAUTH_CORP_SSO_2_CLIENT_ID',
      clientSecret: 'APP_OAUTH_CORP_SSO_2_CLIENT_SECRET',
    });
  });

  test('is frozen to its leaves, the lists and the claims of every record included', () => {
    const { oauth } = createConfig(createTestEnv(GOOGLE_ENV));

    assert.ok(isDeepFrozen(oauth));
    assert.ok(isDeepFrozen(createOauthConfig({})));
    assert.throws(() => oauth.providers[0].issuers.push('https://evil.example.com'), TypeError);
    assert.throws(() => { oauth.providers[1].claims.subject = 'sub'; }, TypeError);
  });

  test('gives a sign-in ten minutes at its provider and a call of the token endpoint a deadline', () => {
    const { oauth } = createConfig(createTestEnv());

    assert.equal(convertStringToSeconds(oauth.stateTtl), 10 * MINUTE_SECONDS);
    assert.ok(convertStringToMs(oauth.timeout) > 0, oauth.timeout);
  });

  test('gives the copy of a picture five seconds, the most a sign-in waits for it', () => {
    const { oauth } = createConfig(createTestEnv());

    assert.equal(convertStringToMs(oauth.pictureTimeout), PICTURE_TIMEOUT_MS);
  });

  test('asks Google for its picture at the size of the avatar: "=s96-c" at the end of the address becomes "=s512-c", and an address without that option stays alone', () => {
    const { oauth, upload } = createConfig(createTestEnv());
    const size = upload.image.profiles[IMAGE_PROFILE.AVATAR].maxSize;
    const [google, telegram] = oauth.providers;
    const resized = [
      [`${GOOGLE_PICTURE}=s96-c`, `${GOOGLE_PICTURE}=s512-c`],
      [`${GOOGLE_PICTURE}=s96`, `${GOOGLE_PICTURE}=s512`],
      [`${GOOGLE_PICTURE}=s96-c-k-no`, `${GOOGLE_PICTURE}=s512-c-k-no`],
    ];
    const kept = [
      GOOGLE_PICTURE,
      `${GOOGLE_PICTURE}=w96-h96`,
      'https://lh3.googleusercontent.com/-XdUIqdMkCWA/AAAAAAAAAAI/AAAAAAAAAAA/4252rscbv5M/s96-c/photo.jpg',
    ];

    resized.forEach(([pictureUrl, sized]) => assert.deepEqual(listPictureUrls(google, { pictureUrl, size }), [sized, pictureUrl], pictureUrl));
    kept.forEach((pictureUrl) => assert.deepEqual(listPictureUrls(google, { pictureUrl, size }), [pictureUrl], pictureUrl));
    assert.deepEqual(listPictureUrls(telegram, { pictureUrl: TELEGRAM_PICTURE, size }), [TELEGRAM_PICTURE]);
  });

  test('ends a sign-in on paths of the site: a failure inside the pages of signing in, a success outside them', () => {
    const { oauth } = createConfig(createTestEnv());

    assert.deepEqual([oauth.successPath, oauth.failurePath, oauth.signInSection], ['/', '/auth/login', '/auth']);
    [oauth.successPath, oauth.failurePath, oauth.signInSection].forEach((path) => assert.ok(isSafeRedirectPath(path), path));
    assert.equal(isInSection(oauth.failurePath, oauth.signInSection), true);
    assert.equal(isInSection(oauth.successPath, oauth.signInSection), false);
  });

  test('asks every provider for an OpenID Connect sign-in over https, with a way of client authentication it knows', () => {
    readProviders().forEach((provider) => {
      assert.ok(provider.scope.split(' ').includes(OPENID_SCOPE), provider.id);
      [provider.authorizationUrl, provider.tokenUrl].forEach((url) => assert.equal(new URL(url).protocol, HTTPS_PROTOCOL, url));
      assert.ok(Object.values(CLIENT_AUTHENTICATION).includes(provider.clientAuthentication), provider.id);
    });
  });

  test('takes the providers of a test as it is given them: a third provider is one record and no code', () => {
    const record = {
      ...GOOGLE,
      id: 'mock',
      name: 'Mock',
      issuers: ['http://127.0.0.1:9999'],
      clientId: 'mock-client',
      clientSecret: 'mock-secret',
    };
    const config = createTestConfig({ oauth: { providers: [record] } });

    assert.deepEqual(config.oauth.providers, [record]);
    assert.equal(config.oauth.stateTtl, createTestConfig().oauth.stateTtl);
    assert.ok(isDeepFrozen(config.oauth));
  });
});
