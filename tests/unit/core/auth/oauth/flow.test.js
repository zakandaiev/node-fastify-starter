import {
  isAllowedTarget,
  readFlowCookies,
  setFlowCookies,
  takeFlowCookies,
  toFailureLocation,
  toSuccessLocation,
} from '#core/auth/oauth/flow.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { toDate } from '#utils/date.js';
import { encodeBase64Url } from '#utils/encoding.js';
import { uuidv7 } from '#utils/id.js';
import { REDIRECT_PATH_MAX_LENGTH } from '#utils/validate.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const CALLBACK_PATH = '/api/v1/auth/mock/callback';
const HTTP_ENV = Object.freeze({ APP_PROTOCOL: 'http' });
const HTTPS_ENV = Object.freeze({ APP_PROTOCOL: 'https' });

// What createAuthorization() gives: 32 bytes each, in base64url.
const STATE = encodeBase64Url(Buffer.alloc(32, 0x5a));
const VERIFIER = encodeBase64Url(Buffer.alloc(32, 0xa5));
const SID = uuidv7();

const LOGIN_STATE = `${STATE}.${VERIFIER}.login`;
const LINK_STATE = `${STATE}.${VERIFIER}.link.${SID}`;
const TARGET = '/settings?tab=accounts#list';

const STATE_TTL_SECONDS = 600;
const EPOCH = toDate(0);
const ATTRIBUTES = Object.freeze({ path: CALLBACK_PATH, httpOnly: true, sameSite: 'Lax' });
const CLEARED = Object.freeze({
  value: '',
  maxAge: 0,
  expires: EPOCH,
  ...ATTRIBUTES,
});

const START_QUERY = Object.freeze({
  type: 'object',
  properties: {
    redirect: { type: 'string', maxLength: REDIRECT_PATH_MAX_LENGTH },
    link: { type: 'boolean' },
  },
});

// Targets the flow refuses for being inside the pages of signing in and out, in any spelling a page reads alike.
const SECTION_TARGETS = Object.freeze([
  '/auth',
  '/auth/',
  '/auth/login',
  '/auth/logout?next=/profile',
  '/auth?x=1',
  '/auth#top',
  '/AUTH/LOGIN',
  '/Auth',
  '/%61uth/login',
  '/%41UTH',
  '/auth%2Flogin',
  '/auth%2flogout',
]);

// Targets isSafeRedirectPath() refuses, and paths whose escapes do not decode.
const UNSAFE_TARGETS = Object.freeze([
  '//evil.example.com',
  '/\\evil.example.com',
  '/.//evil.example.com',
  '/%2e/evil',
  'https://evil.example.com',
  'evil',
  '/a b',
  `/${'x'.repeat(REDIRECT_PATH_MAX_LENGTH)}`,
  '/%zz',
  '/%E2%9C',
  '',
  42,
  null,
  undefined,
]);

const ALLOWED_TARGETS = Object.freeze(['/', '/profile', TARGET, '/authors', '/a/auth', '/a/auth/login', '/%E2%9C%93']);

function readCookies(response) {
  return response.cookies.map((cookie) => ({ ...cookie }));
}

// A flow cookie as setFlowCookies() sets it over http.
function toSetCookie(name, value) {
  return {
    name,
    value,
    maxAge: STATE_TTL_SECONDS,
    ...ATTRIBUTES,
  };
}

function toCookieHeader(cookies) {
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
}

// A request as toFailureLocation() reads it: the config of its server, its cookies and its query.
function toRequest(config, { cookies = {}, query = {} } = {}) {
  return { server: { config }, headers: { cookie: toCookieHeader(cookies) }, query };
}

// Routes for the functions, outside the API prefix: a start and a callback that fail as the real ones may.
async function buildApp(t, { env = HTTP_ENV, ...sections } = {}) {
  const fastify = await buildTestApp({ ...sections, env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()), ...env } });

  t.after(() => fastify.close());

  fastify.post('/set', async (request, reply) => ({ result: setFlowCookies(reply, { path: CALLBACK_PATH, ...request.body }) }));
  fastify.get('/read', async (request) => ({ flow: readFlowCookies(request) }));
  fastify.get('/take', async (request, reply) => ({ flow: takeFlowCookies(request, reply, { path: CALLBACK_PATH }) }));
  fastify.get('/start', { config: { failureLocation: toFailureLocation }, schema: { querystring: START_QUERY } }, async () => {
    throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
  });
  fastify.get('/callback', { config: { failureLocation: toFailureLocation } }, async (request, reply) => {
    takeFlowCookies(request, reply, { path: CALLBACK_PATH });

    throw new AppError(ERROR_CODE.IDENTITY_TAKEN);
  });

  return fastify;
}

function setFlow(fastify, body) {
  return fastify.inject({ method: 'POST', url: '/set', payload: { state: STATE, verifier: VERIFIER, ...body } });
}

async function readFlow(fastify, cookies) {
  const response = await fastify.inject({ url: '/read', cookies });

  return response.json().flow;
}

describe('setFlowCookies', () => {
  test('sets the state as state.verifier.login and the target in base64url, out of reach of scripts, on the path of the callback alone, for stateTtl', async (t) => {
    const fastify = await buildApp(t);
    const response = await setFlow(fastify, { target: TARGET });

    assert.deepEqual(response.json(), { result: true });
    assert.deepEqual(readCookies(response), [toSetCookie('oauthState', LOGIN_STATE), toSetCookie('oauthRedirect', encodeBase64Url(TARGET))]);
  });

  test('writes a link as state.verifier.link.<sid>, and clears the target of an earlier attempt when it has none', async (t) => {
    const fastify = await buildApp(t);
    const response = await setFlow(fastify, { sid: SID });

    assert.deepEqual(readCookies(response), [toSetCookie('oauthState', LINK_STATE), { name: 'oauthRedirect', ...CLEARED }]);
  });

  test('clears the target of an earlier attempt for a target it does not allow, instead of keeping it', async (t) => {
    const fastify = await buildApp(t);
    const targets = [...SECTION_TARGETS, ...UNSAFE_TARGETS.filter((target) => target !== undefined)];
    const responses = await Promise.all(targets.map((target) => setFlow(fastify, { target })));

    responses.forEach((response, index) => {
      const [state, redirect] = readCookies(response);

      assert.equal(state.value, LOGIN_STATE, String(targets[index]));
      assert.deepEqual(redirect, { name: 'oauthRedirect', ...CLEARED }, String(targets[index]));
    });
  });

  test('adds Secure to both over https, and lives as long as config.oauth.stateTtl', async (t) => {
    const fastify = await buildApp(t, { env: HTTPS_ENV, oauth: { stateTtl: '90s' } });
    const set = readCookies(await setFlow(fastify, { target: TARGET }));
    const cleared = readCookies(await setFlow(fastify, {}));

    assert.deepEqual(set.map(({ secure, maxAge }) => ({ secure, maxAge })), [{ secure: true, maxAge: 90 }, { secure: true, maxAge: 90 }]);
    assert.equal(cleared[1].secure, true);
  });

  test('requires the path of the callback, a state and a verifier in base64url, and the UUID of a session or null as sid', () => {
    const refused = [
      { path: '' },
      { path: undefined },
      { state: `${STATE}.x` },
      { state: `${STATE}=` },
      { state: '' },
      { verifier: undefined },
      { verifier: 'a b' },
      { sid: 'not-a-uuid' },
      { sid: SID.toUpperCase() },
    ];

    refused.forEach((options) => {
      assert.throws(() => setFlowCookies({}, {
        path: CALLBACK_PATH,
        state: STATE,
        verifier: VERIFIER,
        ...options,
      }), { name: 'TypeError', message: /^setFlowCookies\(reply, \{ path, state, verifier, sid, target \}\) requires/ }, JSON.stringify(options));
    });
  });
});

describe('readFlowCookies', () => {
  test('reads back what setFlowCookies() wrote: a sign-in with its target and a link without one', async (t) => {
    const fastify = await buildApp(t);
    const [login, link] = await Promise.all([setFlow(fastify, { target: TARGET }), setFlow(fastify, { sid: SID })]);

    function toJar(response) {
      return Object.fromEntries(readCookies(response).filter((cookie) => cookie.maxAge > 0).map((cookie) => [cookie.name, cookie.value]));
    }

    assert.deepEqual(await readFlow(fastify, toJar(login)), {
      state: STATE,
      verifier: VERIFIER,
      sid: null,
      target: TARGET,
    });
    assert.deepEqual(await readFlow(fastify, toJar(link)), {
      state: STATE,
      verifier: VERIFIER,
      sid: SID,
      target: null,
    });
  });

  test('reads no flow from a state cookie that is not three parts of a sign-in or four of a link, exactly', async (t) => {
    const fastify = await buildApp(t);
    const values = [
      '',
      STATE,
      `${STATE}.${VERIFIER}`,
      `${STATE}.${VERIFIER}.login.${SID}`,
      `${STATE}.${VERIFIER}.login.`,
      `${STATE}.${VERIFIER}.link`,
      `${STATE}.${VERIFIER}.link.not-a-uuid`,
      `${STATE}.${VERIFIER}.link.${SID.toUpperCase()}`,
      `${STATE}.${VERIFIER}.link.${SID}.login`,
      `${STATE}.${VERIFIER}.LOGIN`,
      `${STATE}.${VERIFIER}.signup`,
      `.${VERIFIER}.login`,
      `${STATE}..login`,
      `${STATE}=.${VERIFIER}.login`,
      `${STATE}.${VERIFIER}+.login`,
      `${STATE} .${VERIFIER}.login`,
    ];
    const flows = await Promise.all(values.map((value) => readFlow(fastify, { oauthState: value })));

    assert.deepEqual(flows, values.map(() => null));
    assert.equal(await readFlow(fastify, { oauthRedirect: encodeBase64Url(TARGET) }), null);
    assert.equal(await readFlow(fastify, {}), null);
  });

  test('keeps the flow without a target when the target cookie does not decode or holds a target the flow does not allow', async (t) => {
    const fastify = await buildApp(t);
    const values = [
      'not base64url!',
      `${encodeBase64Url('/profile')}=`,
      encodeBase64Url(Buffer.from([0xff, 0xfe, 0x2f])),
      encodeBase64Url('/auth/logout'),
      encodeBase64Url('//evil.example.com'),
      encodeBase64Url('/.//evil.example.com'),
      '',
    ];
    const flows = await Promise.all(values.map((value) => readFlow(fastify, { oauthState: LOGIN_STATE, oauthRedirect: value })));

    flows.forEach((flow, index) => assert.deepEqual(flow, {
      state: STATE,
      verifier: VERIFIER,
      sid: null,
      target: null,
    }, values[index]));
  });
});

describe('takeFlowCookies', () => {
  test('gives the flow and clears both cookies on the path of the callback, so that it is read once', async (t) => {
    const fastify = await buildApp(t);
    const response = await fastify.inject({ url: '/take', cookies: { oauthState: LINK_STATE, oauthRedirect: encodeBase64Url(TARGET) } });

    assert.deepEqual(response.json().flow, {
      state: STATE,
      verifier: VERIFIER,
      sid: SID,
      target: TARGET,
    });
    assert.deepEqual(readCookies(response), [{ name: 'oauthState', ...CLEARED }, { name: 'oauthRedirect', ...CLEARED }]);
  });

  test('clears both also for a flow that does not parse and for a request without one', async (t) => {
    const fastify = await buildApp(t);
    const responses = await Promise.all([
      fastify.inject({ url: '/take', cookies: { oauthState: 'forged', oauthRedirect: encodeBase64Url(TARGET) } }),
      fastify.inject({ url: '/take' }),
    ]);

    responses.forEach((response) => {
      assert.equal(response.json().flow, null);
      assert.deepEqual(readCookies(response), [{ name: 'oauthState', ...CLEARED }, { name: 'oauthRedirect', ...CLEARED }]);
    });
  });

  test('requires the path of the callback', () => {
    [undefined, ''].forEach((path) => {
      assert.throws(() => takeFlowCookies({}, {}, { path }), { name: 'TypeError', message: /^takeFlowCookies\(request, reply, \{ path \}\) requires/ });
    });
  });
});

describe('isAllowedTarget', () => {
  const config = createTestConfig();

  test('takes a safe path of the site outside the pages of signing in and out', () => {
    ALLOWED_TARGETS.forEach((target) => assert.equal(isAllowedTarget(target, config), true, target));
  });

  test('refuses the sign-in section and every path under it, in any case and with any of its letters escaped', () => {
    SECTION_TARGETS.forEach((target) => assert.equal(isAllowedTarget(target, config), false, target));
  });

  test('refuses what isSafeRedirectPath() refuses, "/.//evil.example.com" among them, and a path whose escapes do not decode', () => {
    UNSAFE_TARGETS.forEach((target) => assert.equal(isAllowedTarget(target, config), false, String(target)));
  });

  test('reads the section from the config, also one written with a trailing slash', () => {
    const accountConfig = createTestConfig({ oauth: { signInSection: '/account/' } });

    ['/account', '/account/', '/account/login', '/ACCOUNT'].forEach((target) => assert.equal(isAllowedTarget(target, accountConfig), false, target));
    ['/auth/logout', '/accounts', '/'].forEach((target) => assert.equal(isAllowedTarget(target, accountConfig), true, target));
  });
});

describe('toSuccessLocation', () => {
  const config = createTestConfig();

  test('sends the browser to the target on the host of the app, or to successPath without one', () => {
    assert.equal(toSuccessLocation(config), 'https://app.test/');
    assert.equal(toSuccessLocation(config, { target: TARGET }), `https://app.test${TARGET}`);
    assert.equal(toSuccessLocation(createTestConfig({ oauth: { successPath: '/home' } }), {}), 'https://app.test/home');
  });

  test('adds linked=<id> to the query of a link, before the fragment and in place of one the target had', () => {
    assert.equal(toSuccessLocation(config, { linkedProviderId: 'mock' }), 'https://app.test/?linked=mock');
    assert.equal(toSuccessLocation(config, { target: TARGET, linkedProviderId: 'mock' }), 'https://app.test/settings?tab=accounts&linked=mock#list');
    assert.equal(toSuccessLocation(config, { target: '/settings?linked=old', linkedProviderId: 'mock' }), 'https://app.test/settings?linked=mock');
  });

  test('requires a target isAllowedTarget() takes, or null, and the id of the linked provider or null', () => {
    [{ target: '/auth/logout' }, { target: '//evil.example.com' }, { linkedProviderId: '' }, { linkedProviderId: 42 }].forEach((options) => {
      assert.throws(() => toSuccessLocation(config, options), { name: 'TypeError', message: /^toSuccessLocation\(config, \{ target, linkedProviderId \}\) requires/ }, JSON.stringify(options));
    });
  });
});

describe('toFailureLocation', () => {
  const config = createTestConfig();

  test('sends a failed sign-in to failurePath with authError=<code>, whatever target its flow had', () => {
    const requests = [
      toRequest(config),
      toRequest(config, { cookies: { oauthState: LOGIN_STATE, oauthRedirect: encodeBase64Url(TARGET) } }),
      toRequest(config, { cookies: { oauthState: 'forged' } }),
      toRequest(config, { query: { link: false, redirect: TARGET } }),
    ];

    requests.forEach((request) => {
      assert.equal(toFailureLocation('AUTHENTICATION_ERROR', request), 'https://app.test/auth/login?authError=AUTHENTICATION_ERROR');
    });
  });

  test('tells the failure of a link on the page it started from, by the flow cookies of the callback', () => {
    const withTarget = toRequest(config, { cookies: { oauthState: LINK_STATE, oauthRedirect: encodeBase64Url(TARGET) } });
    const withoutTarget = toRequest(config, { cookies: { oauthState: LINK_STATE, oauthRedirect: encodeBase64Url('/auth/logout') } });

    assert.equal(toFailureLocation('IDENTITY_TAKEN', withTarget), 'https://app.test/settings?tab=accounts&authError=IDENTITY_TAKEN#list');
    assert.equal(toFailureLocation('IDENTITY_TAKEN', withoutTarget), 'https://app.test/?authError=IDENTITY_TAKEN');
  });

  test('tells the failure of a link on the page it started from, by the query of the start, which its schema has made a boolean', () => {
    const cases = [
      [{ link: true, redirect: '/settings' }, 'https://app.test/settings?authError=AUTHENTICATION_ERROR'],
      [{ link: true, redirect: '/auth/logout' }, 'https://app.test/?authError=AUTHENTICATION_ERROR'],
      [{ link: true }, 'https://app.test/?authError=AUTHENTICATION_ERROR'],
      [{ link: 'true', redirect: '/settings' }, 'https://app.test/auth/login?authError=AUTHENTICATION_ERROR'],
    ];

    cases.forEach(([query, location]) => assert.equal(toFailureLocation('AUTHENTICATION_ERROR', toRequest(config, { query })), location, JSON.stringify(query)));
  });

  test('is the failureLocation the error handler answers a start and a callback with: a 302, with the flow cookies the callback took cleared', async (t) => {
    const fastify = await buildApp(t);
    const callback = await fastify.inject({ url: '/callback', cookies: { oauthState: LINK_STATE, oauthRedirect: encodeBase64Url(TARGET) } });
    const starts = await Promise.all(['/start?link=true&redirect=/settings', '/start?redirect=/settings'].map((url) => fastify.inject(url)));

    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, 'http://app.test/settings?tab=accounts&authError=IDENTITY_TAKEN#list');
    assert.equal(callback.headers['cache-control'], 'no-store');
    assert.deepEqual(readCookies(callback), [{ name: 'oauthState', ...CLEARED }, { name: 'oauthRedirect', ...CLEARED }]);
    assert.deepEqual(starts.map((response) => [response.statusCode, response.headers.location]), [
      [302, 'http://app.test/settings?authError=AUTHENTICATION_ERROR'],
      [302, 'http://app.test/auth/login?authError=AUTHENTICATION_ERROR'],
    ]);
  });
});
