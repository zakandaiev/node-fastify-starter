import {
  isAtMaxAge,
  issueTokens,
  readAccessToken,
  readRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '#core/auth/token.js';
import { createContext, runInContext } from '#core/context/index.js';
import { COOKIE } from '#enums/cookie.js';
import { TOKEN_TYPE } from '#enums/token-type.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createTestConfig, TEST_ENV } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { runInApp, toBearer } from '#root/tests/helper/session.js';
import {
  addToDate,
  convertStringToSeconds,
  nowUtc,
  toDate,
  toTimestamp,
} from '#utils/date.js';
import { encodeBase64Url } from '#utils/encoding.js';
import { hmac } from '#utils/hash.js';
import { uuidVersion } from '#utils/id.js';
import { mapValues, omit } from '#utils/object.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

const MS_IN_SECOND = 1000;
const MINUTE_SECONDS = 60;
const DAY_SECONDS = 24 * 60 * MINUTE_SECONDS;

const LIFETIMES = Object.freeze({ accessTtl: '10m', refreshTtl: '30d', sessionMaxAge: '90d' });
const ACCESS_TTL = convertStringToSeconds(LIFETIMES.accessTtl);
const REFRESH_TTL = convertStringToSeconds(LIFETIMES.refreshTtl);

// Not a whole second: what is issued begins with the second the clock is in.
const NOW = toTimestamp('2026-11-25T10:00:00.900Z');
const ISSUED_AT = toTimestamp('2026-11-25T10:00:00.000Z') / MS_IN_SECOND;
const SIGNING_MS = 1500;

// The ages of a session around the points from which its longest life cuts the refresh token, and then the access one.
const LIVE_AGES = [
  { age: '0s', accessTtl: ACCESS_TTL, refreshTtl: REFRESH_TTL },
  { age: '60d', accessTtl: ACCESS_TTL, refreshTtl: REFRESH_TTL },
  { age: '5184001s', accessTtl: ACCESS_TTL, refreshTtl: REFRESH_TTL - 1 },
  { age: '89d', accessTtl: ACCESS_TTL, refreshTtl: DAY_SECONDS },
  { age: '7775400s', accessTtl: ACCESS_TTL, refreshTtl: ACCESS_TTL },
  { age: '7775401s', accessTtl: ACCESS_TTL - 1, refreshTtl: ACCESS_TTL - 1 },
  { age: '7775999s', accessTtl: 1, refreshTtl: 1 },
];
const DEAD_AGES = ['7775999.901s', '90d', '7776000.001s', '91d', '365d'];

const USER_ID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b';
const SID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2d';
const JTI = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2e';
const SCOPES = Object.freeze(['users:read', 'users:write']);
const MANY_SCOPES = 300;
const JTI_VERSION = 7;

const FOREIGN_SECRET = 'foreign-secret-0123456789-abcdefghij';
const PREVIOUS_ENV = Object.freeze({
  APP_JWT_ACCESS_SECRET_PREVIOUS: 'previous-access-secret-0123456789-abcdef',
  APP_JWT_REFRESH_SECRET_PREVIOUS: 'previous-refresh-secret-0123456789-abcdef',
});

const HS256 = Object.freeze({ alg: 'HS256', typ: 'JWT' });
const SHA256 = 'sha256';
const BASE64URL = 'base64url';
const HEX = 'hex';

const LINE_FEED = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xD83D);
const HOSTILE_LENGTH = 100000;
const TOKEN_TEXT = 'a.b.c';

const NO_CONTEXT_MESSAGE = /^No active context: wrap the call in runInContext\(context, fn\)$/;
const NO_JWT_MESSAGE = /^The context has no jwt: tokens are made and checked in the context of the app/;
const MAX_AGE_MESSAGE = /^issueTokens\(\{ userId, sid, scopes, startedAt \}\) requires a session that has at least a second left of config\.auth\.sessionMaxAge$/;

const FOREIGN_SIGNATURE_CODE = 'FAST_JWT_INVALID_SIGNATURE';
const OTHER_REFUSAL_CODES = [
  'FAST_JWT_INVALID_TYPE',
  'FAST_JWT_INVALID_ALGORITHM',
  'FAST_JWT_INVALID_CLAIM_TYPE',
  'FAST_JWT_INVALID_CLAIM_VALUE',
  'FAST_JWT_INVALID_PAYLOAD',
  'FAST_JWT_MALFORMED',
  'FAST_JWT_INACTIVE',
  'FAST_JWT_EXPIRED',
  'FAST_JWT_MISSING_REQUIRED_CLAIM',
  'FAST_JWT_MISSING_SIGNATURE',
  'FAST_JWT_INVALID_CRIT_HEADER',
];

const ACCESS = Object.freeze({
  type: TOKEN_TYPE.ACCESS,
  verify: verifyAccessToken,
  secret: TEST_ENV.APP_JWT_ACCESS_SECRET,
  previousSecret: PREVIOUS_ENV.APP_JWT_ACCESS_SECRET_PREVIOUS,
  ownClaims: { scopes: SCOPES },
  idClaims: ['sub', 'sid'],
  requiredClaims: ['tokenType', 'sub', 'sid', 'scopes', 'exp'],
  subject: { userId: USER_ID, sid: SID, scopes: SCOPES },
});

const REFRESH = Object.freeze({
  type: TOKEN_TYPE.REFRESH,
  verify: verifyRefreshToken,
  secret: TEST_ENV.APP_JWT_REFRESH_SECRET,
  previousSecret: PREVIOUS_ENV.APP_JWT_REFRESH_SECRET_PREVIOUS,
  ownClaims: { jti: JTI },
  idClaims: ['sub', 'sid', 'jti'],
  requiredClaims: ['tokenType', 'sub', 'sid', 'jti', 'exp'],
  subject: { userId: USER_ID, sid: SID },
});

const KINDS = [ACCESS, REFRESH];

// The ids go into SQL and into keys of Redis: there these would be something else than the id of one row.
const NOT_UUIDS = {
  'a list with the id': [USER_ID],
  'an object': { id: USER_ID },
  'a number': 42,
  'a boolean': true,
  null: null,
  'an empty text': '',
  'upper case': USER_ID.toUpperCase(),
  'no dashes': USER_ID.replaceAll('-', ''),
  braces: `{${USER_ID}}`,
  'a URN': `urn:uuid:${USER_ID}`,
  'a line break after the id': `${USER_ID}${LINE_FEED}`,
  'a space before the id': ` ${USER_ID}`,
  'the name of the prototype': '__proto__',
};

const NOT_SCOPES = {
  'a text': 'users:read',
  'a star': '*',
  null: null,
  'a number': 42,
  'an object like a list': { 0: 'users:read', length: 1 },
  'a list with a number': ['users:read', 42],
  'a list with null': [null],
  'a list of lists': [['users:read']],
  'a list of objects': [{ scope: 'users:read' }],
};

async function buildApp(t, { env = {}, auth = {} } = {}) {
  const fastify = await buildTestApp({
    env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()), ...env },
    auth: { ...LIFETIMES, ...auth },
  });

  t.after(() => fastify.close());

  return fastify;
}

function freezeClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
}

function issueInContext({ scopes = SCOPES, startedAt = nowUtc() } = {}) {
  return issueTokens({
    userId: USER_ID,
    sid: SID,
    scopes,
    startedAt,
  });
}

function issue(fastify, options) {
  return runInApp(fastify, () => issueInContext(options));
}

function issueAtAge(fastify, age) {
  return issue(fastify, { startedAt: addToDate(nowUtc(), `-${age}`) });
}

// By hand, not with the library that has made the token.
function decodePart(part) {
  return JSON.parse(Buffer.from(part, BASE64URL).toString());
}

function decodeToken(token) {
  const [header, claims, signature] = token.split('.');

  return {
    header: decodePart(header),
    claims: decodePart(claims),
    input: `${header}.${claims}`,
    signature,
  };
}

function encodePart(value) {
  return encodeBase64Url(JSON.stringify(value));
}

function sign(input, secret, algorithm = SHA256) {
  return hmac(input, secret, { algorithm, encoding: BASE64URL });
}

function readNowSeconds() {
  return Math.floor(nowUtc().getTime() / MS_IN_SECOND);
}

function createClaims(kind, overrides = {}) {
  const issuedAt = readNowSeconds();

  return {
    tokenType: kind.type,
    sub: USER_ID,
    sid: SID,
    ...kind.ownClaims,
    iat: issuedAt,
    exp: issuedAt + ACCESS_TTL,
    ...overrides,
  };
}

function signTexts(header, claims, secret, algorithm) {
  const input = `${encodeBase64Url(header)}.${encodeBase64Url(claims)}`;

  return `${input}.${sign(input, secret, algorithm)}`;
}

// A token the app accepts, unless a test changes a part of it.
function forge(kind, {
  claims = createClaims(kind),
  header = HS256,
  secret = kind.secret,
  algorithm = SHA256,
} = {}) {
  return signTexts(JSON.stringify(header), JSON.stringify(claims), secret, algorithm);
}

function forgeWithClaims(kind, overrides) {
  return forge(kind, { claims: createClaims(kind, overrides) });
}

function forgeWithHeader(kind, header) {
  return forge(kind, { header: { ...HS256, ...header } });
}

function forgeFromTexts(kind, { header = JSON.stringify(HS256), claims = JSON.stringify(createClaims(kind)) } = {}) {
  return signTexts(header, claims, kind.secret);
}

function forgeUnsigned(kind, header) {
  return `${encodePart({ ...HS256, ...header })}.${encodePart(createClaims(kind))}.`;
}

function verify(fastify, kind, token) {
  return runInApp(fastify, () => kind.verify(token));
}

function assertAccepted(fastify, kind, token = forge(kind)) {
  assert.deepEqual(verify(fastify, kind, token), kind.subject);
}

// Beside a list of refused tokens stands one that is accepted, or the list would prove nothing.
function assertRefused(fastify, kind, tokens) {
  assert.deepEqual(
    mapValues(tokens, (token) => verify(fastify, kind, token)),
    mapValues(tokens, () => null),
  );
}

function toNamedTokens(values, toToken) {
  return Object.fromEntries(values.map((value) => [JSON.stringify(value), toToken(value)]));
}

function runWithJwt(jwt, fn) {
  return runInContext(createContext({ config: createTestConfig({ auth: LIFETIMES }), log: {}, jwt }), fn);
}

function failWith(error) {
  return {
    verify() {
      throw error;
    },
  };
}

function createTokenError(code) {
  return Object.assign(new Error('The token is refused.'), { code });
}

function toPreviousSpace(kind) {
  return `${kind.type}Previous`;
}

describe('issueTokens: the tokens', () => {
  test('an access token names its user, session and scopes, a refresh token its user, session and an id of its own', async (t) => {
    const fastify = await buildApp(t);

    freezeClock(t);

    const { issued } = issue(fastify);
    const access = decodeToken(issued.accessToken);
    const refresh = decodeToken(issued.refreshToken);

    assert.deepEqual(access.header, HS256);
    assert.deepEqual(access.claims, {
      tokenType: 'access',
      sub: USER_ID,
      sid: SID,
      scopes: SCOPES,
      iat: ISSUED_AT,
      exp: ISSUED_AT + ACCESS_TTL,
    });
    assert.deepEqual(refresh.header, HS256);
    assert.deepEqual(omit(refresh.claims, ['jti']), {
      tokenType: 'refresh',
      sub: USER_ID,
      sid: SID,
      iat: ISSUED_AT,
      exp: ISSUED_AT + REFRESH_TTL,
    });
    assert.equal(uuidVersion(refresh.claims.jti), JTI_VERSION);
  });

  test('each token is signed with HMAC-SHA256 and the secret of its kind', async (t) => {
    const fastify = await buildApp(t);
    const { issued } = issue(fastify);
    const access = decodeToken(issued.accessToken);
    const refresh = decodeToken(issued.refreshToken);

    assert.equal(access.signature, sign(access.input, TEST_ENV.APP_JWT_ACCESS_SECRET));
    assert.equal(refresh.signature, sign(refresh.input, TEST_ENV.APP_JWT_REFRESH_SECRET));
  });

  test('each signature is asked for with its algorithm and with a life in seconds', () => {
    const asked = [];
    const space = {
      sign(claims, options) {
        asked.push(options);

        return TOKEN_TEXT;
      },
    };

    runWithJwt({ access: space, refresh: space }, () => issueInContext());

    assert.deepEqual(asked, [
      { algorithm: 'HS256', expiresIn: ACCESS_TTL },
      { algorithm: 'HS256', expiresIn: REFRESH_TTL },
    ]);
  });

  test('gives what a route needs, and beside it what the row of the session holds: the SHA-256 of the refresh token and the moment of its exp', async (t) => {
    const fastify = await buildApp(t);

    freezeClock(t);

    const result = issue(fastify);
    const { accessToken, refreshToken } = result.issued;

    assert.deepEqual(result, {
      issued: {
        userId: USER_ID,
        sid: SID,
        scopes: SCOPES,
        accessToken,
        refreshToken,
        accessTtl: ACCESS_TTL,
        refreshTtl: REFRESH_TTL,
      },
      refreshTokenHash: createHash(SHA256).update(refreshToken).digest(HEX),
      expiresAt: toDate('2026-12-25T10:00:00.000Z'),
    });
    assert.equal(decodeToken(refreshToken).claims.exp * MS_IN_SECOND, result.expiresAt.getTime());
  });

  test('both tokens are usable as soon as they are issued, each as its own kind', async (t) => {
    const fastify = await buildApp(t);
    const { issued } = issue(fastify);

    assertAccepted(fastify, ACCESS, issued.accessToken);
    assertAccepted(fastify, REFRESH, issued.refreshToken);
  });

  test('the scopes go into an access token as they are, also full access and none at all', async (t) => {
    const fastify = await buildApp(t);
    const lists = [['*'], []];
    const results = lists.map((scopes) => verify(fastify, ACCESS, issue(fastify, { scopes }).issued.accessToken));

    assert.deepEqual(results, lists.map((scopes) => ({ userId: USER_ID, sid: SID, scopes })));
  });

  test('two refresh tokens of one session issued in one second differ, and so do their hashes', async (t) => {
    const fastify = await buildApp(t);

    freezeClock(t);

    const [first, second] = [issue(fastify), issue(fastify)];
    const [firstClaims, secondClaims] = [first, second].map(({ issued }) => decodeToken(issued.refreshToken).claims);

    assert.notEqual(first.issued.refreshToken, second.issued.refreshToken);
    assert.notEqual(first.refreshTokenHash, second.refreshTokenHash);
    assert.deepEqual(omit(firstClaims, ['jti']), omit(secondClaims, ['jti']));
  });
});

describe('issueTokens: how long the tokens live', () => {
  test('a refresh token ends with the longest life of its session at the latest, and an access token with its refresh token', async (t) => {
    const fastify = await buildApp(t);

    freezeClock(t);

    const results = LIVE_AGES.map(({ age }) => {
      const { issued, expiresAt } = issueAtAge(fastify, age);
      const access = decodeToken(issued.accessToken).claims;
      const refresh = decodeToken(issued.refreshToken).claims;

      return {
        age,
        ttls: [issued.accessTtl, issued.refreshTtl],
        lifetimes: [access.exp - access.iat, refresh.exp - refresh.iat],
        begin: [access.iat, refresh.iat],
        expiresAt: expiresAt.getTime() / MS_IN_SECOND,
      };
    });

    assert.deepEqual(results, LIVE_AGES.map(({ age, accessTtl, refreshTtl }) => ({
      age,
      ttls: [accessTtl, refreshTtl],
      lifetimes: [accessTtl, refreshTtl],
      begin: [ISSUED_AT, ISSUED_AT],
      expiresAt: ISSUED_AT + refreshTtl,
    })));
  });

  test('one moment begins both tokens and the life the row is given, however long the signing takes', async (t) => {
    const fastify = await buildApp(t);

    freezeClock(t);

    function signLate(space) {
      return {
        sign(...args) {
          t.mock.timers.tick(SIGNING_MS);

          return space.sign(...args);
        },
      };
    }

    const jwt = { access: signLate(fastify.jwt.access), refresh: signLate(fastify.jwt.refresh) };
    const { issued, expiresAt } = runInContext(createContext({ ...fastify.context, jwt }), () => issueInContext());
    const access = decodeToken(issued.accessToken).claims;
    const refresh = decodeToken(issued.refreshToken).claims;

    assert.deepEqual([access.iat, refresh.iat], [ISSUED_AT, ISSUED_AT]);
    assert.deepEqual([access.exp, refresh.exp], [ISSUED_AT + ACCESS_TTL, ISSUED_AT + REFRESH_TTL]);
    assert.equal(expiresAt.getTime() / MS_IN_SECOND, ISSUED_AT + REFRESH_TTL);
  });

  test('a session 89 days old that began within a second gets whole seconds, and ends not a moment after its 90 days', async (t) => {
    const fastify = await buildApp(t);

    freezeClock(t);

    const startedAt = toDate('2026-08-28T10:00:00.437Z');
    const { issued, expiresAt } = issue(fastify, { startedAt });
    const { exp, iat } = decodeToken(issued.refreshToken).claims;

    assert.deepEqual([issued.accessTtl, issued.refreshTtl, exp - iat], [ACCESS_TTL, DAY_SECONDS, DAY_SECONDS]);
    assert.deepEqual(expiresAt, toDate('2026-11-26T10:00:00.000Z'));
    assert.equal(exp * MS_IN_SECOND, expiresAt.getTime());
    assert.ok(expiresAt <= addToDate(startedAt, LIFETIMES.sessionMaxAge));
  });

  test('a session whose start is ahead of the clock of the app gets no longer life than a new one', async (t) => {
    const fastify = await buildApp(t);
    const { issued } = issue(fastify, { startedAt: addToDate(nowUtc(), '1h') });

    assert.deepEqual([issued.accessTtl, issued.refreshTtl], [ACCESS_TTL, REFRESH_TTL]);
  });

  test('a session with less than a second left of its longest life gets no tokens but a RangeError', async (t) => {
    const fastify = await buildApp(t);

    freezeClock(t);

    DEAD_AGES.forEach((age) => {
      assert.throws(() => issueAtAge(fastify, age), { name: 'RangeError', message: MAX_AGE_MESSAGE }, age);
    });
  });

  test('a longest life that a release has lowered ends the sessions that are older', async (t) => {
    const fastify = await buildApp(t, { auth: { sessionMaxAge: '30d' } });

    freezeClock(t);

    assert.equal(issueAtAge(fastify, '29d').issued.refreshTtl, DAY_SECONDS);
    assert.throws(() => issueAtAge(fastify, '45d'), { name: 'RangeError', message: MAX_AGE_MESSAGE });
  });
});

describe('isAtMaxAge', () => {
  test('is false for every session issueTokens() gives tokens to, and true for one it refuses', async (t) => {
    const fastify = await buildApp(t);

    freezeClock(t);

    function check(age) {
      return runInApp(fastify, () => isAtMaxAge(addToDate(nowUtc(), `-${age}`)));
    }

    assert.deepEqual(LIVE_AGES.map(({ age }) => check(age)), LIVE_AGES.map(() => false));
    assert.deepEqual(DEAD_AGES.map((age) => check(age)), DEAD_AGES.map(() => true));
  });
});

describe('issueTokens: the size of an access token', () => {
  test('a token of exactly accessTokenMaxBytes is issued, and one of a byte more is an error that names the groups', async (t) => {
    const fastify = await buildApp(t);
    const bytes = Buffer.byteLength(issue(fastify).issued.accessToken);

    function issueWithin(accessTokenMaxBytes) {
      const config = { ...fastify.config, auth: { ...fastify.config.auth, accessTokenMaxBytes } };

      return runInContext(createContext({ ...fastify.context, config }), () => issueInContext());
    }

    assert.equal(Buffer.byteLength(issueWithin(bytes).issued.accessToken), bytes);
    assert.throws(() => issueWithin(bytes - 1), {
      name: 'Error',
      message: `The access token takes ${bytes} bytes, above the ${bytes - 1} a cookie may hold: the groups of the user grant too many scopes`,
    });
  });

  test('the groups of a user with hundreds of scopes are above the ceiling of the config', async (t) => {
    const fastify = await buildApp(t);
    const scopes = Array.from({ length: MANY_SCOPES }, (unused, index) => `resource-${index}:read`);

    assert.throws(() => issue(fastify, { scopes }), {
      name: 'Error',
      message: new RegExp(`^The access token takes \\d+ bytes, above the ${fastify.config.auth.accessTokenMaxBytes} a cookie may hold`),
    });
  });
});

describe('verifyAccessToken and verifyRefreshToken: what they accept', () => {
  test('give the user and the session of a token made by hand with the secret of its kind, and the scopes of an access token', async (t) => {
    const fastify = await buildApp(t);

    KINDS.forEach((kind) => assertAccepted(fastify, kind));
  });

  test('give nothing else of the claims, whatever else a token says', async (t) => {
    const fastify = await buildApp(t);
    const extra = {
      ...ACCESS.ownClaims,
      ...REFRESH.ownClaims,
      userId: JTI,
      isSuperadmin: true,
    };

    KINDS.forEach((kind) => assertAccepted(fastify, kind, forgeWithClaims(kind, extra)));
  });

  test('accept an access token with an empty list of scopes', async (t) => {
    const fastify = await buildApp(t);

    assert.deepEqual(verify(fastify, ACCESS, forgeWithClaims(ACCESS, { scopes: [] })), { ...ACCESS.subject, scopes: [] });
  });

  test('accept an issued token to the last millisecond of its life, and not a millisecond after it', async (t) => {
    const fastify = await buildApp(t);

    freezeClock(t);

    const { issued } = issue(fastify);
    const cases = [
      [ACCESS, issued.accessToken, ISSUED_AT + ACCESS_TTL],
      [REFRESH, issued.refreshToken, ISSUED_AT + REFRESH_TTL],
    ];

    cases.forEach(([kind, token, exp]) => {
      t.mock.timers.setTime(exp * MS_IN_SECOND - 1);
      assertAccepted(fastify, kind, token);
      t.mock.timers.setTime(exp * MS_IN_SECOND + 1);
      assertRefused(fastify, kind, { expired: token });
    });
  });
});

describe('verifyAccessToken and verifyRefreshToken: what is not a token', () => {
  test('give null for what is not a text and for an empty text, also outside any context', async (t) => {
    const fastify = await buildApp(t);

    KINDS.forEach((kind) => {
      const token = forge(kind);
      const values = [
        undefined, null, '', 0, 42, Number.NaN, 42n, true, Symbol('token'), {}, { token }, [], [token], () => token,
        Buffer.from(token), Object(token),
      ];
      const nulls = values.map(() => null);

      assertAccepted(fastify, kind, token);
      assert.deepEqual(values.map((value) => verify(fastify, kind, value)), nulls);
      assert.deepEqual(values.map((value) => kind.verify(value)), nulls);
    });
  });

  test('give null for garbage, and for a token with anything around it', async (t) => {
    const fastify = await buildApp(t);

    KINDS.forEach((kind) => {
      const token = forge(kind);
      const [header, claims, signature] = token.split('.');

      assertAccepted(fastify, kind, token);
      assertRefused(fastify, kind, {
        'a word': 'garbage',
        'a space': ' ',
        'one dot': '.',
        'two dots': '..',
        'three dots': '...',
        'three letters': TOKEN_TEXT,
        'two parts': `${header}.${claims}`,
        'four parts': `${token}.${signature}`,
        'an empty header': `.${claims}.${signature}`,
        'no claims': `${header}..${signature}`,
        'parts in another order': `${claims}.${header}.${signature}`,
        'a space after it': `${token} `,
        'a line break after it': `${token}${LINE_FEED}`,
        'a padding': `${token}=`,
        quotes: `"${token}"`,
        'the scheme of a header': `Bearer ${token}`,
        'a zero byte': `${token}${NUL}`,
        'a lone surrogate': LONE_SURROGATE,
        'another script': 'токен.токен.токен',
        'a long text': 'a'.repeat(HOSTILE_LENGTH),
        'a lot of dots': '.'.repeat(HOSTILE_LENGTH),
      });
    });
  });

  test('give null for a signed header or payload that is not a JSON object', async (t) => {
    const fastify = await buildApp(t);
    const texts = ['', 'null', 'true', '42', '"text"', '[]', '[{}]', '{', 'not json'];

    KINDS.forEach((kind) => {
      assertAccepted(fastify, kind, forgeFromTexts(kind));
      assertRefused(fastify, kind, toNamedTokens(texts, (header) => forgeFromTexts(kind, { header })));
      assertRefused(fastify, kind, toNamedTokens(texts, (claims) => forgeFromTexts(kind, { claims })));
    });
  });

  test('give null for a token that is cut anywhere, or changed by one character', async (t) => {
    const fastify = await buildApp(t);

    KINDS.forEach((kind) => {
      const token = forge(kind);
      // Not the last character: it holds two spare bits, so four spellings of it are one signature.
      const places = Array.from({ length: token.length - 1 }, (unused, index) => index);
      const cut = places.map((place) => token.slice(0, place));
      const changed = places.map((place) => `${token.slice(0, place)}${token[place] === 'A' ? 'B' : 'A'}${token.slice(place + 1)}`);
      const accepted = [...cut, ...changed].filter((text) => verify(fastify, kind, text) !== null);

      assertAccepted(fastify, kind, token);
      assert.deepEqual(accepted, []);
    });
  });
});

describe('verifyAccessToken and verifyRefreshToken: who has signed', () => {
  test('refuse a token without a signature, whatever algorithm it names', async (t) => {
    const fastify = await buildApp(t);
    const algorithms = ['none', 'None', 'NONE', 'HS256', ''];

    KINDS.forEach((kind) => {
      assertAccepted(fastify, kind);
      assertRefused(fastify, kind, toNamedTokens(algorithms, (alg) => forgeUnsigned(kind, { alg })));
    });
  });

  test('refuse an algorithm that is not HS256, signed as it says with the very secret of the app', async (t) => {
    const fastify = await buildApp(t);

    KINDS.forEach((kind) => {
      assertAccepted(fastify, kind);
      assertRefused(fastify, kind, {
        HS384: forge(kind, { header: { ...HS256, alg: 'HS384' }, algorithm: 'sha384' }),
        HS512: forge(kind, { header: { ...HS256, alg: 'HS512' }, algorithm: 'sha512' }),
      });
    });
  });

  test('refuse a header that names another algorithm or none, over an HMAC-SHA256 of the secret', async (t) => {
    const fastify = await buildApp(t);
    const algorithms = ['none', 'None', 'RS256', 'PS256', 'ES256', 'EdDSA', 'HS384', 'HS512', 'hs256', '', null, 256, true, ['HS256'], { alg: 'HS256' }];

    KINDS.forEach((kind) => {
      assertAccepted(fastify, kind);
      assertRefused(fastify, kind, {
        ...toNamedTokens(algorithms, (alg) => forgeWithHeader(kind, { alg })),
        'no alg': forge(kind, { header: { typ: 'JWT' } }),
      });
    });
  });

  test('refuse a token of a foreign secret, and claims under the signature of other claims', async (t) => {
    const fastify = await buildApp(t);

    KINDS.forEach((kind) => {
      const [header, , signature] = forge(kind).split('.');
      const otherClaims = encodePart(createClaims(kind, { sub: JTI }));

      assertAccepted(fastify, kind);
      assertRefused(fastify, kind, {
        'a foreign secret': forge(kind, { secret: FOREIGN_SECRET }),
        'a secret of one letter more': forge(kind, { secret: `${kind.secret}x` }),
        'the claims of somebody else': `${header}.${otherClaims}.${signature}`,
      });
    });
  });

  test('refuse a header that says a part of it must be understood', async (t) => {
    const fastify = await buildApp(t);

    KINDS.forEach((kind) => {
      assertAccepted(fastify, kind);
      assertRefused(fastify, kind, {
        'a name nobody knows': forgeWithHeader(kind, { crit: ['policy'], policy: 'strict' }),
        'an unencoded payload': forgeWithHeader(kind, { crit: ['b64'], b64: false }),
        'a claim': forgeWithHeader(kind, { crit: ['exp'], exp: 1 }),
        'a registered name': forgeWithHeader(kind, { crit: ['alg'] }),
        'an empty list': forgeWithHeader(kind, { crit: [] }),
        'a text': forgeWithHeader(kind, { crit: 'exp' }),
      });
    });
  });
});

describe('verifyAccessToken and verifyRefreshToken: the kind of a token', () => {
  test('refuse a token of the other kind', async (t) => {
    const fastify = await buildApp(t);
    const { issued } = issue(fastify);

    assertAccepted(fastify, ACCESS, issued.accessToken);
    assertAccepted(fastify, REFRESH, issued.refreshToken);
    assertRefused(fastify, ACCESS, { refresh: issued.refreshToken });
    assertRefused(fastify, REFRESH, { access: issued.accessToken });
  });

  test('refuse a token of the other kind also when one secret signs both', async (t) => {
    const fastify = await buildApp(t, { env: { APP_JWT_REFRESH_SECRET: TEST_ENV.APP_JWT_ACCESS_SECRET } });
    const { issued } = issue(fastify);

    assertAccepted(fastify, ACCESS, issued.accessToken);
    assertAccepted(fastify, REFRESH, issued.refreshToken);
    assertRefused(fastify, ACCESS, { refresh: issued.refreshToken });
    assertRefused(fastify, REFRESH, { access: issued.accessToken });
  });

  test('tell the kinds apart by tokenType when a token of the right secret has the claims of both', async (t) => {
    const fastify = await buildApp(t);
    const bothClaims = { ...ACCESS.ownClaims, ...REFRESH.ownClaims };

    KINDS.forEach((kind) => {
      const types = [...Object.values(TOKEN_TYPE).filter((type) => type !== kind.type), kind.type.toUpperCase(), '', null, true, [kind.type]];

      assertAccepted(fastify, kind, forgeWithClaims(kind, bothClaims));
      assertRefused(fastify, kind, toNamedTokens(types, (tokenType) => forgeWithClaims(kind, { ...bothClaims, tokenType })));
    });
  });
});

describe('verifyAccessToken and verifyRefreshToken: the claims', () => {
  test('refuse a token that lacks one of them', async (t) => {
    const fastify = await buildApp(t);

    KINDS.forEach((kind) => {
      assertAccepted(fastify, kind);
      assertRefused(fastify, kind, toNamedTokens(kind.requiredClaims, (claim) => forge(kind, { claims: omit(createClaims(kind), [claim]) })));
    });
  });

  test('take none of them from a key that names the prototype', async (t) => {
    const fastify = await buildApp(t);

    KINDS.forEach((kind) => {
      const claims = JSON.stringify(createClaims(kind));

      assertAccepted(fastify, kind, forgeFromTexts(kind, { claims }));
      assertRefused(fastify, kind, { nested: forgeFromTexts(kind, { claims: `{"__proto__":${claims}}` }) });
    });
  });

  test('refuse a token that has ended, has not begun, or names its end as anything but a number', async (t) => {
    const fastify = await buildApp(t);
    const now = readNowSeconds();
    const ends = [now - 1, now - DAY_SECONDS, 1, 0, -1, String(now + ACCESS_TTL), '', null, true, {}, [now + ACCESS_TTL]];

    KINDS.forEach((kind) => {
      assertAccepted(fastify, kind);
      assertRefused(fastify, kind, toNamedTokens(ends, (exp) => forgeWithClaims(kind, { exp })));
      assertRefused(fastify, kind, { 'begins in a minute': forgeWithClaims(kind, { nbf: now + MINUTE_SECONDS }) });
    });
  });

  test('refuse an id of the user, of the session or of the refresh token that is not a canonical UUID', async (t) => {
    const fastify = await buildApp(t);

    KINDS.forEach((kind) => kind.idClaims.forEach((claim) => {
      assertAccepted(fastify, kind);
      assertRefused(fastify, kind, mapValues(NOT_UUIDS, (value) => forgeWithClaims(kind, { [claim]: value })));
    }));
  });

  test('refuse scopes that are not a list of texts', async (t) => {
    const fastify = await buildApp(t);

    assertAccepted(fastify, ACCESS);
    assertRefused(fastify, ACCESS, mapValues(NOT_SCOPES, (scopes) => forgeWithClaims(ACCESS, { scopes })));
  });
});

describe('a previous secret', () => {
  test('is accepted beside the current one, each for its own kind', async (t) => {
    const fastify = await buildApp(t, { env: PREVIOUS_ENV });

    KINDS.forEach((kind) => {
      const other = KINDS.find(({ type }) => type !== kind.type);

      assertAccepted(fastify, kind);
      assertAccepted(fastify, kind, forge(kind, { secret: kind.previousSecret }));
      assertRefused(fastify, kind, { 'of the other kind': forge(kind, { secret: other.previousSecret }) });
    });
  });

  test('is refused where it is not configured, also when the one of the other kind is', async (t) => {
    const none = await buildApp(t);
    const accessOnly = await buildApp(t, { env: { APP_JWT_ACCESS_SECRET_PREVIOUS: ACCESS.previousSecret } });
    const refreshOnly = await buildApp(t, { env: { APP_JWT_REFRESH_SECRET_PREVIOUS: REFRESH.previousSecret } });
    const [access, refresh] = KINDS.map((kind) => forge(kind, { secret: kind.previousSecret }));

    assertRefused(none, ACCESS, { access });
    assertRefused(none, REFRESH, { refresh });
    assertAccepted(accessOnly, ACCESS, access);
    assertRefused(accessOnly, REFRESH, { refresh });
    assertAccepted(refreshOnly, REFRESH, refresh);
    assertRefused(refreshOnly, ACCESS, { access });
  });

  test('checks a token as strictly as the current one does', async (t) => {
    const fastify = await buildApp(t, { env: PREVIOUS_ENV });
    const now = readNowSeconds();

    KINDS.forEach((kind) => {
      const other = KINDS.find(({ type }) => type !== kind.type);
      const secret = kind.previousSecret;

      assertAccepted(fastify, kind, forge(kind, { secret }));
      assertRefused(fastify, kind, {
        expired: forge(kind, { secret, claims: createClaims(kind, { exp: now - 1 }) }),
        'without its end': forge(kind, { secret, claims: omit(createClaims(kind), ['exp']) }),
        'of the other kind': forge(kind, { secret, claims: createClaims(other, kind.ownClaims) }),
        'of a user without a canonical id': forge(kind, { secret, claims: createClaims(kind, { sub: [USER_ID] }) }),
        HS512: forge(kind, { secret, header: { ...HS256, alg: 'HS512' }, algorithm: 'sha512' }),
        none: forge(kind, { secret, header: { ...HS256, alg: 'none' } }),
        crit: forge(kind, { secret, header: { ...HS256, crit: ['exp'], exp: 1 } }),
        'of a third secret': forge(kind, { secret: FOREIGN_SECRET }),
      });
    });
  });

  test('signs nothing: tokens are issued with the current one', async (t) => {
    const fastify = await buildApp(t, { env: PREVIOUS_ENV });
    const onPrevious = await buildApp(t, {
      env: { APP_JWT_ACCESS_SECRET: ACCESS.previousSecret, APP_JWT_REFRESH_SECRET: REFRESH.previousSecret },
    });
    const { issued } = issue(fastify);
    const access = decodeToken(issued.accessToken);
    const refresh = decodeToken(issued.refreshToken);

    assert.equal(access.signature, sign(access.input, ACCESS.secret));
    assert.equal(refresh.signature, sign(refresh.input, REFRESH.secret));
    assertRefused(onPrevious, ACCESS, { issued: issued.accessToken });
    assertRefused(onPrevious, REFRESH, { issued: issued.refreshToken });
  });

  test('lets two processes in the middle of a swap take the tokens of each other', async (t) => {
    const before = await buildApp(t, { env: PREVIOUS_ENV });
    const after = await buildApp(t, {
      env: {
        APP_JWT_ACCESS_SECRET: ACCESS.previousSecret,
        APP_JWT_ACCESS_SECRET_PREVIOUS: ACCESS.secret,
        APP_JWT_REFRESH_SECRET: REFRESH.previousSecret,
        APP_JWT_REFRESH_SECRET_PREVIOUS: REFRESH.secret,
      },
    });

    [[before, after], [after, before]].forEach(([issuer, checker]) => {
      const { issued } = issue(issuer);

      assertAccepted(checker, ACCESS, issued.accessToken);
      assertAccepted(checker, REFRESH, issued.refreshToken);
    });
  });

  test('is asked about a foreign signature alone, not about a token the current one refuses for anything else', () => {
    const codes = [FOREIGN_SIGNATURE_CODE, ...OTHER_REFUSAL_CODES];

    KINDS.forEach((kind) => {
      const asked = [];

      function createJwt(code) {
        return {
          [kind.type]: failWith(createTokenError(code)),
          [toPreviousSpace(kind)]: {
            verify() {
              asked.push(code);

              return createClaims(kind);
            },
          },
        };
      }

      const results = codes.map((code) => runWithJwt(createJwt(code), () => kind.verify(TOKEN_TEXT)));

      assert.deepEqual(results, [kind.subject, ...OTHER_REFUSAL_CODES.map(() => null)]);
      assert.deepEqual(asked, [FOREIGN_SIGNATURE_CODE]);
    });
  });
});

describe('an error of the check', () => {
  test('is null when it is of the token, with a previous secret and without one', () => {
    const codes = [FOREIGN_SIGNATURE_CODE, ...OTHER_REFUSAL_CODES];

    KINDS.forEach((kind) => codes.forEach((code) => {
      const refusal = failWith(createTokenError(code));

      assert.equal(runWithJwt({ [kind.type]: refusal }, () => kind.verify(TOKEN_TEXT)), null, code);
      assert.equal(runWithJwt({ [kind.type]: refusal, [toPreviousSpace(kind)]: refusal }, () => kind.verify(TOKEN_TEXT)), null, code);
    }));
  });

  test('is thrown as it is when it is not of the token: a bug is not answered as a token nobody can use', () => {
    const foreign = failWith(createTokenError(FOREIGN_SIGNATURE_CODE));
    const bugs = [
      new TypeError('a bug of this code'),
      new RangeError('Invalid time value'),
      Object.assign(new Error('an assertion of the plugin'), { code: 'ERR_ASSERTION' }),
      Object.assign(new Error('an error of the plugin'), { code: 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED' }),
      Object.assign(new Error('a code with the prefix inside'), { code: 'ERR_FAST_JWT_EXPIRED' }),
      Object.assign(new Error('a code that is not a text'), { code: 401 }),
    ];

    KINDS.forEach((kind) => bugs.forEach((bug) => {
      const broken = failWith(bug);

      assert.throws(() => runWithJwt({ [kind.type]: broken }, () => kind.verify(TOKEN_TEXT)), (error) => error === bug);
      assert.throws(
        () => runWithJwt({ [kind.type]: foreign, [toPreviousSpace(kind)]: broken }, () => kind.verify(TOKEN_TEXT)),
        (error) => error === bug,
      );
    }));
  });
});

describe('the context of the tokens', () => {
  test('is asked for with a clear error outside any context', () => {
    KINDS.forEach((kind) => assert.throws(() => kind.verify(forge(kind)), { name: 'Error', message: NO_CONTEXT_MESSAGE }));
    assert.throws(() => issueInContext(), { name: 'Error', message: NO_CONTEXT_MESSAGE });
    assert.throws(() => isAtMaxAge(nowUtc()), { name: 'Error', message: NO_CONTEXT_MESSAGE });
  });

  test('holds jwt, or a token is neither made nor checked: the error says where it is', () => {
    KINDS.forEach((kind) => {
      assert.throws(() => runWithJwt(undefined, () => kind.verify(forge(kind))), { name: 'Error', message: NO_JWT_MESSAGE });
    });
    assert.throws(() => runWithJwt(undefined, () => issueInContext()), { name: 'Error', message: NO_JWT_MESSAGE });
  });
});

describe('readAccessToken', () => {
  const REFRESH_COOKIE = `${COOKIE.REFRESH_TOKEN}=refresh-token`;
  const COOKIES = `${REFRESH_COOKIE}; ${COOKIE.ACCESS_TOKEN}=token-of-the-cookie`;

  function read(authorization, cookie = COOKIES) {
    return readAccessToken({ headers: { authorization, cookie } });
  }

  test('takes the token of a Bearer header, also when there is a cookie', () => {
    ['Bearer token-of-the-header', 'bearer token-of-the-header', 'BEARER  token-of-the-header '].forEach((authorization) => {
      assert.equal(read(authorization), 'token-of-the-header', authorization);
      assert.equal(read(authorization, ''), 'token-of-the-header', authorization);
    });
  });

  test('gives null for a Bearer header without a token or with several, and does not fall back to the cookie', () => {
    ['Bearer', 'Bearer ', 'bearer\t', 'Bearer one two', 'Bearer one, Basic two'].forEach((authorization) => {
      assert.equal(read(authorization), null, JSON.stringify(authorization));
    });
  });

  test('ignores a header of another scheme, such as the Basic one of a proxy, and reads the cookie', () => {
    [undefined, '', 'Basic dXNlcjpwYXNzd29yZA==', 'Digest username="user"', 'Bearertoken', 'Token token-of-the-header'].forEach((authorization) => {
      assert.equal(read(authorization), 'token-of-the-cookie', String(authorization));
    });
  });

  test('gives null without the cookie of an access token', () => {
    ['', REFRESH_COOKIE, `x${COOKIE.ACCESS_TOKEN}=other`].forEach((cookie) => {
      assert.equal(read(undefined, cookie), null, cookie);
    });
    assert.equal(readAccessToken({ headers: {} }), null);
  });

  test('of a request over HTTP takes the Bearer token first, and no cookie in place of one nobody can use', async (t) => {
    const fastify = await buildApp(t);
    const ofHeader = forge(ACCESS);
    const ofCookie = forgeWithClaims(ACCESS, { sid: JTI });
    const accessCookie = { [COOKIE.ACCESS_TOKEN]: ofCookie };

    fastify.get('/token', (request) => {
      const token = readAccessToken(request);

      return { token, claims: verifyAccessToken(token) };
    });

    const requests = [
      { headers: toBearer(ofHeader), cookies: accessCookie },
      { cookies: accessCookie },
      { headers: { authorization: 'Basic dXNlcjpwYXNzd29yZA==' }, cookies: accessCookie },
      { headers: { authorization: 'Bearer' }, cookies: accessCookie },
      { headers: toBearer('garbage'), cookies: accessCookie },
      { headers: { cookie: `${COOKIE.ACCESS_TOKEN}=` } },
      { cookies: { [COOKIE.REFRESH_TOKEN]: ofCookie } },
      {},
    ];
    const responses = await Promise.all(requests.map((request) => fastify.inject({ url: '/token', ...request })));

    assert.deepEqual(responses.map((response) => response.json()), [
      { token: ofHeader, claims: ACCESS.subject },
      { token: ofCookie, claims: { ...ACCESS.subject, sid: JTI } },
      { token: ofCookie, claims: { ...ACCESS.subject, sid: JTI } },
      { token: null, claims: null },
      { token: 'garbage', claims: null },
      { token: '', claims: null },
      { token: null, claims: null },
      { token: null, claims: null },
    ]);
  });
});

describe('readRefreshToken', () => {
  test('gives the token of its cookie, and null without it', () => {
    const accessCookie = `${COOKIE.ACCESS_TOKEN}=access-token`;

    assert.equal(readRefreshToken({ headers: { cookie: `${accessCookie}; ${COOKIE.REFRESH_TOKEN}=token-of-the-cookie` } }), 'token-of-the-cookie');
    [undefined, '', accessCookie].forEach((cookie) => {
      assert.equal(readRefreshToken({ headers: { cookie } }), null, String(cookie));
    });
  });

  test('takes no token from a header, from the body or from the query of a request', async (t) => {
    const fastify = await buildApp(t);
    const request = {
      method: 'POST',
      url: `/token?${COOKIE.REFRESH_TOKEN}=token-of-the-query`,
      headers: { ...toBearer('token-of-the-header'), [COOKIE.REFRESH_TOKEN]: 'token-of-the-header' },
      payload: { [COOKIE.REFRESH_TOKEN]: 'token-of-the-body' },
    };
    const refreshCookies = ['token-of-the-cookie', ''].map((token) => ({ [COOKIE.REFRESH_TOKEN]: token }));

    fastify.post('/token', (received) => ({ token: readRefreshToken(received) }));

    const responses = await Promise.all([undefined, ...refreshCookies].map((cookies) => fastify.inject({ ...request, cookies })));

    assert.deepEqual(responses.map((response) => response.json().token), [null, 'token-of-the-cookie', '']);
  });
});
