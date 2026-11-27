import { createHttpConfig } from '#config/http.js';
import { createOauthConfig } from '#config/oauth.js';
import { linkProvider } from '#core/auth/account.js';
import { copyProviderPicture } from '#core/auth/picture.js';
import { isImageQueueIdle, processImage } from '#core/image/index.js';
import { isStorageKey, toStorageKey } from '#core/storage/key.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { updateOwnProfile } from '#modules/users/users.service.js';
import { timeIt } from '#root/tests/helper/async.js';
import {
  createTestDb,
  findSessionId,
  isCommitPacket,
  killSession,
  SMALL_POOL,
} from '#root/tests/helper/db.js';
import { appErrorOf, REFUSAL, typeErrorOf } from '#root/tests/helper/error.js';
import { createLogSink, findLogLines, LOG_LEVEL } from '#root/tests/helper/log.js';
import { bindMigrator } from '#root/tests/helper/migration.js';
import {
  createImage,
  createUploadSection,
  listStored,
  removeTestUploads,
} from '#root/tests/helper/multipart.js';
import { createPictureServer } from '#root/tests/helper/oauth.js';
import { createTcpProxy, createTestRedis } from '#root/tests/helper/redis.js';
import { getServiceAddress } from '#root/tests/helper/service.js';
import {
  connectAppRedis,
  insertIdentity,
  insertUser,
  profileOf,
  runInApp,
  signInByProvider,
  TEST_REQUEST,
} from '#root/tests/helper/session.js';
import { mapSeries, sleep } from '#utils/async.js';
import { uuidv7 } from '#utils/id.js';
import { detectMime } from '#utils/mime.js';
import { freezeDeep, pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import {
  after,
  before,
  describe,
  test,
} from 'node:test';
import sharp from 'sharp';

const testRedis = await createTestRedis();
const testDb = await createTestDb();
const { up } = bindMigrator(testDb);

after(() => removeTestUploads());

const LOOPBACK = '127.0.0.1';
const LOOPBACK_NETWORK = '127.0.0.1/32';
const PROVIDER_ID = 'pictures';
const SERVICE = `picture-${PROVIDER_ID}`;

// The record of Google, its rule for the size of a picture included, with this machine for the host of its pictures.
const GOOGLE = createOauthConfig({}).providers[0];
const PROVIDER = freezeDeep({
  ...GOOGLE,
  id: PROVIDER_ID,
  name: 'Pictures',
  pictureHosts: [LOOPBACK],
});

const PICTURE_TIMEOUT = '1s';
const PICTURE_TIMEOUT_MS = 1000;

// The millisecond clock of libuv floors the moment a timer starts at: a timer may fire a millisecond early.
const TIMER_SLACK_MS = 5;
const QUICK_MS = 2000;

// Far above every picture of the tests, and a body one byte longer is cheap to send.
const MAX_BYTES = 64 * 1024;
const HTTP_DEFAULTS = createHttpConfig();

const PNG_TYPE = 'image/png';
const WEBP_TYPE = 'image/webp';
const ACCEPTED_TYPES = 'image/jpeg, image/png, image/webp';
const PICTURE = await createImage(800, 600).png().toBuffer();
const AVATAR_SIZE = Object.freeze([512, 384]);
const PICTURE_PATH = '/a/photo.png';

// A picture of 96 pixels as Google names it, and the address the rule of its record asks for first.
const CLAIM_PATH = '/a/ACg8ocJ4mVqTnXk2bW9pLr7sYd0fHe3uZa1cQo5iGj8tEw6xNy=s96-c';
const RESIZED_PATH = '/a/ACg8ocJ4mVqTnXk2bW9pLr7sYd0fHe3uZa1cQo5iGj8tEw6xNy=s512-c';
const SMALL_PICTURE = await createImage(96, 96).png().toBuffer();
const SMALL_SIZE = Object.freeze([96, 96]);

// A resized address that fails this late leaves the next one the rest of the deadline: given a timeout of its own,
// the next one would end the sign-in this much later.
const LATE_FAILURE_MS = 700;

// Each a decode of tens of milliseconds, one after another: together they hold the image queue for about a second.
const HEAVY_PICTURE = await createImage(6000, 6000).png().toBuffer();
const HEAVY_DECODES = 24;

// A name the path of a picture may carry: no line of the log may hold it.
const USER_NAME = 'anna.kovalenko';
const NOT_A_PICTURE = '<p>Not a picture</p>';

const NOT_COPIED_MESSAGE = 'The picture of a provider is not copied to the avatar';
const REQUEST_MESSAGE = 'Upstream request';
const FAILED_MESSAGE = 'Upstream request failed';

// The lock of lockUsers(), as the server lists it while it waits.
const LOCK_USERS_MARK = 'FROM users WHERE id IN';

const AVATAR_SQL = 'SELECT avatar_key FROM users WHERE id = :id';
const SET_AVATAR_SQL = 'UPDATE users SET avatar_key = :avatarKey WHERE id = :id';
const STATUS_SQL = 'UPDATE users SET status = :status WHERE id = :id';
const DELETE_SQL = 'DELETE FROM users WHERE id = :id';

// A way of failing for each first segment of the path.
const FAILURES = freezeDeep({
  missing: { status: 404, headers: { 'content-type': PNG_TYPE }, body: PICTURE },
  page: { status: 200, headers: { 'content-type': 'text/html' }, body: NOT_A_PICTURE },
  forged: { status: 200, headers: { 'content-type': PNG_TYPE }, body: NOT_A_PICTURE },
  large: { status: 200, headers: { 'content-type': PNG_TYPE }, body: 'x'.repeat(MAX_BYTES + 1) },
  away: { status: 302, headers: { location: 'http://evil.example.test/photo.png' }, body: '' },
});

const FORBIDDEN = appErrorOf(REFUSAL.FORBIDDEN);
const SIGNATURE = 'copyProviderPicture({ userId, provider, pictureUrl })';

const sink = createLogSink();
let fastify = null;
let root = null;

function buildPictureApp(env = {}) {
  return testDb.buildApp({
    env,
    db: SMALL_POOL,
    logger: { level: 'info', stream: sink.stream },
    oauth: { providers: [PROVIDER], pictureTimeout: PICTURE_TIMEOUT },
    http: { external: { ...HTTP_DEFAULTS.external, allowedPrivateNetworks: [LOOPBACK_NETWORK], maxBytes: MAX_BYTES } },
    upload: createUploadSection(),
  });
}

async function openProxiedApp(t) {
  const proxy = await createTcpProxy(t, getServiceAddress('mariadb'));
  const app = await buildPictureApp(proxy.databaseEnv);

  t.after(() => app.close());
  await connectAppRedis(app);

  return { app, proxy };
}

function signIn(profile, app = fastify) {
  return signInByProvider(app, PROVIDER_ID, profile);
}

function link(userId, profile) {
  return runInApp(fastify, () => linkProvider({
    userId,
    providerId: PROVIDER_ID,
    profile,
    request: TEST_REQUEST,
  }));
}

async function readAvatarKey(id) {
  const [row] = await testDb.readRows(AVATAR_SQL, { id });

  return row.avatar_key;
}

function watchLog() {
  const start = sink.lines.length;

  return (message) => findLogLines({ lines: sink.lines.slice(start) }, message);
}

function readWarnings(lines) {
  return lines.map((line) => [line.level, line.userId, line.providerId, line.reason]);
}

// The root holds the files of the tests before this one too.
async function watchRoot() {
  const stored = await listStored(root);

  return async () => (await listStored(root)).filter((name) => !stored.includes(name));
}

function answerPicture(request, response) {
  response.writeHead(200, { 'content-type': PNG_TYPE });
  response.end(PICTURE);
}

function writeFailure(response, { status, headers, body }) {
  response.writeHead(status, headers);
  response.end(body);
}

function answerFailure(request, response) {
  writeFailure(response, FAILURES[request.url.split('/')[1]]);
}

function answerTooLarge(request, response) {
  writeFailure(response, FAILURES.large);
}

function answerSmallPicture(request, response) {
  response.writeHead(200, { 'content-type': PNG_TYPE });
  response.end(SMALL_PICTURE);
}

function answerMissing(request, response) {
  response.writeHead(404, { 'content-type': PNG_TYPE });
  response.end();
}

async function answerMissingLate(request, response) {
  await sleep(LATE_FAILURE_MS);
  answerMissing(request, response);
}

function answerPaths(answers) {
  return (request, response) => (answers[request.url] ?? answerMissing)(request, response);
}

function toPictureUrl(server, path = PICTURE_PATH) {
  return `${server.url}${path}`;
}

function readPaths(server) {
  return server.requests.map((request) => request.path);
}

async function readStoredImage(key) {
  const { format, width, height } = await sharp(await readFile(nodePath.join(root, key))).metadata();

  return [format, width, height];
}

// The work of uploads, which a sign-in does not wait behind.
function holdImageQueue() {
  return Array.from({ length: HEAVY_DECODES }, () => runInApp(fastify, () => processImage(HEAVY_PICTURE, IMAGE_PROFILE.AVATAR)));
}

// A server that answers once the test lets it: what the test does in between happens while the picture comes.
async function createSlowServer(t) {
  const asked = Promise.withResolvers();
  const released = Promise.withResolvers();
  const server = await createPictureServer(t, async (request, response) => {
    asked.resolve();
    await released.promise;
    answerPicture(request, response);
  });

  t.after(() => released.resolve());

  return { ...server, asked: asked.promise, release: released.resolve };
}

// The second sign-in of a user without an avatar, held while the picture comes.
async function signInAgainSlowly(t, server, app = fastify) {
  const profile = profileOf();
  const { userId } = await signIn(profile, app);
  const signing = signIn({ ...profile, pictureUrl: toPictureUrl(server) }, app);

  t.after(() => Promise.allSettled([signing]));
  await Promise.race([server.asked, signing]);
  assert.equal(server.requests.length, 1, 'The sign-in has ended before it asked for the picture');

  return { userId, signing };
}

describe('copyProviderPicture: what it takes', () => {
  test('refuses a user that is no UUID, a record that names no pictureHosts and an address of a picture that is not one, before any fetch', async () => {
    const pictureUrl = 'https://lh3.googleusercontent.com/a/photo.png';
    const userId = uuidv7();
    const cases = [
      [{ userId: 'user-1', provider: GOOGLE, pictureUrl }, `${SIGNATURE} requires the UUID of a user`],
      [{ userId, provider: null, pictureUrl }, `${SIGNATURE} requires the record of a provider of config.oauth that names its pictureHosts`],
      [{ userId, provider: { ...GOOGLE, pictureHosts: undefined }, pictureUrl }, `${SIGNATURE} requires the record of a provider of config.oauth that names its pictureHosts`],
      [{ userId, provider: GOOGLE, pictureUrl: 'http://lh3.googleusercontent.com/a/photo.png' }, `${SIGNATURE} requires pictureUrl, the address of the picture a profile gives`],
      [{ userId, provider: GOOGLE }, `${SIGNATURE} requires pictureUrl, the address of the picture a profile gives`],
    ];

    await Promise.all(cases.map(([options, message]) => assert.rejects(copyProviderPicture(options), typeErrorOf(message))));
    await assert.rejects(copyProviderPicture(), typeErrorOf(`${SIGNATURE} requires the UUID of a user`));
  });
});

describe('the picture of a provider', { skip: testRedis.skip || testDb.skip }, () => {
  before(async () => {
    await up();

    fastify = await buildPictureApp();
    root = fastify.config.upload.storage.root;
    await connectAppRedis(fastify);
  });

  after(() => fastify?.close());

  describe('a copy', () => {
    test('stores the WebP of the avatar profile at a first sign-in through a provider whose profile has a picture, and writes its key to users.avatar_key', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const server = await createPictureServer(t, answerPicture);
      const issued = await signIn(profileOf({ pictureUrl: toPictureUrl(server) }));
      const key = await readAvatarKey(issued.userId);
      const stored = await readFile(nodePath.join(root, key));
      const { format, width, height } = await sharp(stored).metadata();

      assert.ok(isStorageKey(key) && key.endsWith('.webp'), String(key));
      assert.deepEqual(await listAdded(), [key]);
      assert.equal(detectMime(stored), WEBP_TYPE);
      assert.deepEqual([format, width, height], ['webp', ...AVATAR_SIZE]);
      assert.deepEqual(server.requests.map(({ method, path, headers }) => [method, path, headers.accept]), [['GET', PICTURE_PATH, ACCEPTED_TYPES]]);
      assert.deepEqual(watch(REQUEST_MESSAGE).map((line) => line.upstream.service), [SERVICE]);
      assert.deepEqual(watch(NOT_COPIED_MESSAGE), []);
    });

    test('fetches nothing at the sign-in of a user who has an avatar, and keeps it', async (t) => {
      const server = await createPictureServer(t, answerPicture);
      const ownKey = toStorageKey('webp');
      const userId = await insertUser(testDb, { avatarKey: ownKey });
      const subject = await insertIdentity(testDb, { userId, provider: PROVIDER_ID });
      const issued = await signIn(profileOf({ subject, pictureUrl: toPictureUrl(server) }));

      assert.equal(issued.userId, userId);
      assert.equal(await readAvatarKey(userId), ownKey);
      assert.deepEqual(server.requests, []);
    });

    test('copies the picture again at the next sign-in of a user who has removed the avatar, as a provider fills an empty name', async (t) => {
      const server = await createPictureServer(t, answerPicture);
      const profile = profileOf({ pictureUrl: toPictureUrl(server) });
      const { userId } = await signIn(profile);
      const first = await readAvatarKey(userId);

      await runInApp(fastify, () => updateOwnProfile({ userId, input: { avatar: null } }));

      const listAdded = await watchRoot();

      await signIn(profile);

      const second = await readAvatarKey(userId);

      assert.ok(isStorageKey(first) && isStorageKey(second), `${first}, ${second}`);
      assert.notEqual(second, first);
      assert.deepEqual(await listAdded(), [second]);
      assert.equal((await listStored(root)).includes(first), false);
      assert.equal(server.requests.length, 2);
    });

    test('copies the picture at a link to a user who has no avatar, and fetches nothing for one who has', async (t) => {
      const server = await createPictureServer(t, answerPicture);
      const ownKey = toStorageKey('webp');
      const [bareId, ownerId] = await mapSeries([null, ownKey], (avatarKey) => insertUser(testDb, { avatarKey }));
      const linked = await link(bareId, profileOf({ pictureUrl: toPictureUrl(server) }));
      const kept = await link(ownerId, profileOf({ pictureUrl: toPictureUrl(server) }));
      const key = await readAvatarKey(bareId);

      assert.ok(isStorageKey(key), String(key));
      assert.deepEqual([linked.id, linked.avatarKey], [bareId, key]);
      assert.deepEqual([kept.id, kept.avatarKey], [ownerId, ownKey]);
      assert.equal(await readAvatarKey(ownerId), ownKey);
      assert.equal(server.requests.length, 1);
    });

    test('fetches nothing for a blocked user, whose sign-in and link are refused with AUTHORIZATION_ERROR', async (t) => {
      const server = await createPictureServer(t, answerPicture);
      const profile = profileOf();
      const { userId } = await signIn(profile);

      await testDb.readRows(STATUS_SQL, { id: userId, status: USER_STATUS.BLOCKED });
      await assert.rejects(signIn({ ...profile, pictureUrl: toPictureUrl(server) }), FORBIDDEN);
      await assert.rejects(link(userId, profileOf({ pictureUrl: toPictureUrl(server) })), FORBIDDEN);

      assert.deepEqual(server.requests, []);
      assert.equal(await readAvatarKey(userId), null);
    });
  });

  describe('a copy that fails', () => {
    test('leaves the sign-in done and the avatar empty, with a warning and no file, for a 404, a page, bytes that are no image, a body over the limit and a redirect off the hosts of the record', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const server = await createPictureServer(t, answerFailure);
      const cases = [
        ['missing', 'fetch', 'status'],
        ['page', 'fetch', 'refused-type'],
        ['forged', 'image', 'image'],
        ['large', 'fetch', 'too-large'],
        ['away', 'fetch', 'refused-host'],
      ];
      const userIds = await mapSeries(cases, async ([name]) => (await signIn(profileOf({ pictureUrl: toPictureUrl(server, `/${name}/${USER_NAME}.png`) }))).userId);
      const warnings = watch(NOT_COPIED_MESSAGE);

      assert.deepEqual(await mapSeries(userIds, (userId) => readAvatarKey(userId)), userIds.map(() => null));
      assert.deepEqual(readWarnings(warnings), userIds.map((userId, index) => [LOG_LEVEL.WARN, userId, PROVIDER_ID, cases[index][1]]));
      assert.deepEqual(warnings.map((line) => line.err?.cause.reason ?? line.check), cases.map(([, , cause]) => cause));
      assert.deepEqual(server.requests.map((request) => request.path.split('/')[1]), cases.map(([name]) => name));
      assert.deepEqual(await listAdded(), []);
      assert.equal(JSON.stringify(sink.lines).includes(USER_NAME), false);
    });

    test('gives up on a picture that does not come within config.oauth.pictureTimeout, and the sign-in ends then', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const server = await createPictureServer(t, () => {});
      const { result: issued, durationMs } = await timeIt(() => signIn(profileOf({ pictureUrl: toPictureUrl(server) })));
      const warnings = watch(NOT_COPIED_MESSAGE);

      assert.ok(durationMs >= PICTURE_TIMEOUT_MS - TIMER_SLACK_MS && durationMs < PICTURE_TIMEOUT_MS + QUICK_MS, `${durationMs} ms`);
      assert.equal(await readAvatarKey(issued.userId), null);
      assert.deepEqual(readWarnings(warnings), [[LOG_LEVEL.WARN, issued.userId, PROVIDER_ID, 'fetch']]);
      assert.equal(warnings[0].err.cause.reason, 'timeout');
      assert.deepEqual(await listAdded(), []);
    });

    test('keeps an avatar written while the picture came, and removes the copy nobody took', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const server = await createSlowServer(t);
      const ownKey = toStorageKey('webp');
      const { userId, signing } = await signInAgainSlowly(t, server);

      await testDb.readRows(SET_AVATAR_SQL, { id: userId, avatarKey: ownKey });
      server.release();
      await signing;

      assert.equal(await readAvatarKey(userId), ownKey);
      assert.deepEqual(readWarnings(watch(NOT_COPIED_MESSAGE)), [[LOG_LEVEL.WARN, userId, PROVIDER_ID, 'taken']]);
      assert.deepEqual(await listAdded(), []);
    });

    test('removes the copy when its write fails after the store, and warns with the error', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const keeper = await testDb.openKeeper(t);
      const server = await createSlowServer(t);
      const { userId, signing } = await signInAgainSlowly(t, server);

      await keeper.holdRow(TABLE.USERS, userId);
      server.release();
      await killSession(testDb, await findSessionId(testDb, LOCK_USERS_MARK), { isQueryOnly: true });
      await signing;
      await keeper.release();

      const warnings = watch(NOT_COPIED_MESSAGE);

      assert.equal(await readAvatarKey(userId), null);
      assert.deepEqual(readWarnings(warnings), [[LOG_LEVEL.WARN, userId, PROVIDER_ID, 'failed']]);
      assert.ok(warnings[0].err, JSON.stringify(warnings[0]));
      assert.deepEqual(await listAdded(), []);
    });

    test('removes the copy when the connection of its write is lost before the COMMIT, which took the transaction with it', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const keeper = await testDb.openKeeper(t);
      const server = await createSlowServer(t);
      const { userId, signing } = await signInAgainSlowly(t, server);

      await keeper.holdRow(TABLE.USERS, userId);
      server.release();
      await killSession(testDb, await findSessionId(testDb, LOCK_USERS_MARK));
      await signing;
      await keeper.release();

      const warnings = watch(NOT_COPIED_MESSAGE);

      assert.equal(await readAvatarKey(userId), null);
      assert.deepEqual(readWarnings(warnings), [[LOG_LEVEL.WARN, userId, PROVIDER_ID, 'failed']]);
      assert.equal(warnings[0].err?.isFatal, true, JSON.stringify(warnings[0]));
      assert.deepEqual(await listAdded(), []);
    });

    test('keeps the copy when the COMMIT of its write lands and the answer never comes back: the row names the copy, and the warning carries the fatal error, which is not marked rolled back', async (t) => {
      const watch = watchLog();
      const { app, proxy } = await openProxiedApp(t);
      const server = await createSlowServer(t);
      const { userId, signing } = await signInAgainSlowly(t, server, app);

      proxy.cutAnswerTo(isCommitPacket);
      server.release();
      await signing;

      const key = await readAvatarKey(userId);
      const warnings = watch(NOT_COPIED_MESSAGE);

      assert.ok(isStorageKey(key), String(key));
      assert.deepEqual(await listStored(app.config.upload.storage.root), [key]);
      assert.deepEqual(readWarnings(warnings), [[LOG_LEVEL.WARN, userId, PROVIDER_ID, 'failed']]);
      assert.deepEqual(pick(warnings[0].err, ['isFatal', 'isConnectFailure', 'isRolledBack']), { isFatal: true });
    });

    test('removes the copy of a user deleted or blocked since the sign-in, and writes nothing', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const server = await createPictureServer(t, answerPicture);
      const [deletedId, blockedId] = await mapSeries(['deleted', 'blocked'], () => insertUser(testDb));

      await testDb.readRows(DELETE_SQL, { id: deletedId });
      await testDb.readRows(STATUS_SQL, { id: blockedId, status: USER_STATUS.BLOCKED });

      const copied = await mapSeries([deletedId, blockedId], (userId) => runInApp(fastify, () => copyProviderPicture({ userId, provider: PROVIDER, pictureUrl: toPictureUrl(server) })));

      assert.deepEqual(copied, [null, null]);
      assert.equal(await readAvatarKey(blockedId), null);
      assert.deepEqual(readWarnings(watch(NOT_COPIED_MESSAGE)), [deletedId, blockedId].map((userId) => [LOG_LEVEL.WARN, userId, PROVIDER_ID, 'taken']));
      assert.equal(server.requests.length, 2);
      assert.deepEqual(await listAdded(), []);
    });
  });

  describe('a picture of the size of the avatar', () => {
    test('asks for the address the rule of the record writes for the size of the avatar and stores what it gives, without asking for the address of the claim', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const server = await createPictureServer(t, answerPaths({ [RESIZED_PATH]: answerPicture, [CLAIM_PATH]: answerSmallPicture }));
      const issued = await signIn(profileOf({ pictureUrl: toPictureUrl(server, CLAIM_PATH) }));
      const key = await readAvatarKey(issued.userId);

      assert.ok(isStorageKey(key), String(key));
      assert.deepEqual(await listAdded(), [key]);
      assert.deepEqual(await readStoredImage(key), ['webp', ...AVATAR_SIZE]);
      assert.deepEqual(readPaths(server), [RESIZED_PATH]);
      assert.deepEqual(watch(NOT_COPIED_MESSAGE), []);
    });

    test('asks for the address of the claim once the resized one fails upstream, by a 404 or by a body over maxBytes, and stores its picture at its own size: the avatar is never enlarged', async (t) => {
      await mapSeries([[answerMissing, 'status'], [answerTooLarge, 'too-large']], async ([answerResized, reason]) => {
        const watch = watchLog();
        const listAdded = await watchRoot();
        const server = await createPictureServer(t, answerPaths({ [RESIZED_PATH]: answerResized, [CLAIM_PATH]: answerSmallPicture }));
        const issued = await signIn(profileOf({ pictureUrl: toPictureUrl(server, CLAIM_PATH) }));
        const key = await readAvatarKey(issued.userId);

        assert.ok(isStorageKey(key), String(key));
        assert.deepEqual(await listAdded(), [key]);
        assert.deepEqual(await readStoredImage(key), ['webp', ...SMALL_SIZE]);
        assert.deepEqual(readPaths(server), [RESIZED_PATH, CLAIM_PATH]);
        assert.deepEqual(watch(FAILED_MESSAGE).map((line) => [line.level, line.upstream.service, line.upstream.reason]), [[LOG_LEVEL.INFO, SERVICE, reason]]);
        assert.deepEqual(watch(NOT_COPIED_MESSAGE), []);
      });
    });

    test('ends the sign-in at config.oauth.pictureTimeout when the resized address does not answer, and never asks for the address of the claim', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const server = await createPictureServer(t, answerPaths({ [RESIZED_PATH]: () => {}, [CLAIM_PATH]: answerSmallPicture }));
      const { result: issued, durationMs } = await timeIt(() => signIn(profileOf({ pictureUrl: toPictureUrl(server, CLAIM_PATH) })));
      const warnings = watch(NOT_COPIED_MESSAGE);

      assert.ok(durationMs >= PICTURE_TIMEOUT_MS - TIMER_SLACK_MS && durationMs < PICTURE_TIMEOUT_MS + QUICK_MS, `${durationMs} ms`);
      assert.equal(await readAvatarKey(issued.userId), null);
      assert.deepEqual(readPaths(server), [RESIZED_PATH]);
      assert.deepEqual(readWarnings(warnings), [[LOG_LEVEL.WARN, issued.userId, PROVIDER_ID, 'fetch']]);
      assert.equal(warnings[0].err.cause.reason, 'timeout');
      assert.deepEqual(await listAdded(), []);
    });

    test('gives the address of the claim what is left of config.oauth.pictureTimeout after the resized one has failed, not a timeout of its own', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const server = await createPictureServer(t, answerPaths({ [RESIZED_PATH]: answerMissingLate, [CLAIM_PATH]: () => {} }));
      const { result: issued, durationMs } = await timeIt(() => signIn(profileOf({ pictureUrl: toPictureUrl(server, CLAIM_PATH) })));
      const warnings = watch(NOT_COPIED_MESSAGE);

      assert.ok(durationMs >= PICTURE_TIMEOUT_MS - TIMER_SLACK_MS && durationMs < PICTURE_TIMEOUT_MS + LATE_FAILURE_MS - TIMER_SLACK_MS, `${durationMs} ms`);
      assert.equal(await readAvatarKey(issued.userId), null);
      assert.deepEqual(readPaths(server), [RESIZED_PATH, CLAIM_PATH]);
      assert.deepEqual(readWarnings(warnings), [[LOG_LEVEL.WARN, issued.userId, PROVIDER_ID, 'fetch']]);
      assert.equal(warnings[0].err.cause.reason, 'timeout');
      assert.deepEqual(await listAdded(), []);
    });
  });

  // The queue is held by work that runs one after another: busy before the sign-in and after it, it was busy throughout.
  describe('a busy image queue', () => {
    test('skips the copy while the queue has work, before any fetch: a sign-in waits behind no upload', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const server = await createPictureServer(t, answerPicture);
      const decodes = holdImageQueue();

      t.after(() => Promise.allSettled(decodes));
      assert.equal(isImageQueueIdle(), false);

      const issued = await signIn(profileOf({ pictureUrl: toPictureUrl(server) }));
      const isHeld = !isImageQueueIdle();

      await Promise.all(decodes);

      assert.ok(isHeld, 'The queue ran dry before the sign-in had ended: hold it with more work');
      assert.equal(await readAvatarKey(issued.userId), null);
      assert.deepEqual(server.requests, []);
      assert.deepEqual(readWarnings(watch(NOT_COPIED_MESSAGE)), [[LOG_LEVEL.WARN, issued.userId, PROVIDER_ID, 'busy']]);
      assert.deepEqual(await listAdded(), []);
    });

    test('skips the copy when the queue has taken work while the picture came', async (t) => {
      const watch = watchLog();
      const listAdded = await watchRoot();
      const held = { decodes: [] };
      const server = await createPictureServer(t, (request, response) => {
        held.decodes = holdImageQueue();
        answerPicture(request, response);
      });

      t.after(() => Promise.allSettled(held.decodes));

      const issued = await signIn(profileOf({ pictureUrl: toPictureUrl(server) }));
      const isHeld = !isImageQueueIdle();

      await Promise.all(held.decodes);

      assert.ok(isHeld, 'The queue ran dry before the sign-in had ended: hold it with more work');
      assert.equal(server.requests.length, 1);
      assert.equal(await readAvatarKey(issued.userId), null);
      assert.deepEqual(readWarnings(watch(NOT_COPIED_MESSAGE)), [[LOG_LEVEL.WARN, issued.userId, PROVIDER_ID, 'busy']]);
      assert.deepEqual(await listAdded(), []);
    });
  });
});
