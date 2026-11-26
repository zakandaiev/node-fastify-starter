import { writeAudit } from '#core/audit/index.js';
import { createContext, runInContext } from '#core/context/index.js';
import { migrateUp } from '#core/db/migrator.js';
import { withTransaction } from '#core/db/transaction.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { TABLE } from '#enums/table.js';
import { rejectionOf } from '#root/tests/helper/async.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { uuidv7, uuidVersion } from '#utils/id.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { inspect } from 'node:util';

const testDb = await createTestDb();

const RECORD_SQL = 'SELECT id, actor_id, action, entity_type, entity_id, meta, ip, request_id FROM audit_logs WHERE id = :id';
const COUNT_SQL = 'SELECT COUNT(*) AS total FROM audit_logs WHERE entity_id = :entityId';
const INSERT_USER_SQL = 'INSERT INTO users (id) VALUES (:id)';

const UUID_V7 = 7;
const HIDDEN = '[hidden]';

const ACTION_REFUSAL = /requires an action such as "user\.block"/;
const ENTITY_TYPE_REFUSAL = /requires entityType to be a table of src\/enums\/table\.js/;
const ENTITY_ID_REFUSAL = /requires entityId to be the UUID of a row/;
const ACTOR_ID_REFUSAL = /requires actorId to be the UUID of a user/;
const META_REFUSAL = /requires meta to be a plain object/;

const WRONG_ENTRIES = [
  [{ action: undefined }, ACTION_REFUSAL],
  [{ action: 42 }, ACTION_REFUSAL],
  [{ action: 'block' }, ACTION_REFUSAL],
  [{ action: 'User.block' }, ACTION_REFUSAL],
  [{ action: 'user.Block' }, ACTION_REFUSAL],
  [{ action: 'user-account.block' }, ACTION_REFUSAL],
  [{ action: 'user.' }, ACTION_REFUSAL],
  [{ action: '.block' }, ACTION_REFUSAL],
  [{ action: '1user.block' }, ACTION_REFUSAL],
  [{ action: 'user.block ' }, ACTION_REFUSAL],
  [{ action: `user.${'b'.repeat(60)}` }, ACTION_REFUSAL],
  [{ entityType: 'accounts' }, ENTITY_TYPE_REFUSAL],
  [{ entityType: 'USERS' }, ENTITY_TYPE_REFUSAL],
  [{ entityType: '' }, ENTITY_TYPE_REFUSAL],
  [{ entityId: 'user-1' }, ENTITY_ID_REFUSAL],
  [{ entityId: 42 }, ENTITY_ID_REFUSAL],
  [{ actorId: 'admin' }, ACTOR_ID_REFUSAL],
  [{ actorId: 1 }, ACTOR_ID_REFUSAL],
  [{ meta: 'blocked for spam' }, META_REFUSAL],
  [{ meta: ['spam'] }, META_REFUSAL],
  [{ meta: new Map([['reason', 'spam']]) }, META_REFUSAL],
];

function record(entry) {
  return testDb.run(() => withTransaction(() => writeAudit(entry)));
}

async function readRecord(id) {
  const [row] = await testDb.readRows(RECORD_SQL, { id });

  return row;
}

async function countRecords(entityId) {
  const [{ total }] = await testDb.readRows(COUNT_SQL, { entityId });

  return total;
}

async function insertUser() {
  const id = uuidv7();

  await testDb.readRows(INSERT_USER_SQL, { id });

  return id;
}

// A pool of its own that logs every statement it sends, for a test that proves none was sent.
function openWatchedPool(t) {
  const sink = createLogSink();
  const pool = testDb.open({ logger: { level: 'info', stream: sink.stream } }, t);

  function listAuditStatements() {
    return sink.lines.filter((line) => line.sql?.includes(TABLE.AUDIT_LOGS));
  }

  return { pool, listAuditStatements };
}

describe('writeAudit', { skip: testDb.skip }, () => {
  before(() => testDb.run(() => migrateUp()));

  test('writes one row inside withTransaction() and returns its UUIDv7 id: the actor, the ip and the id of the request, and meta with a secret hidden', async () => {
    const actorId = await insertUser();
    const entityId = uuidv7();
    const request = { ip: '203.0.113.7', id: uuidv7(), user: { id: actorId } };
    const id = await record({
      action: 'user.block',
      entityType: TABLE.USERS,
      entityId,
      meta: { reason: 'spam', password: 'hunter2', target: { apiToken: 'token-value', name: 'Anna' } },
      request,
    });

    assert.equal(uuidVersion(id), UUID_V7);
    assert.equal(await countRecords(entityId), 1);
    assert.deepEqual(await readRecord(id), {
      id,
      actor_id: actorId,
      action: 'user.block',
      entity_type: TABLE.USERS,
      entity_id: entityId,
      meta: { reason: 'spam', password: HIDDEN, target: { apiToken: HIDDEN, name: 'Anna' } },
      ip: request.ip,
      request_id: request.id,
    });
  });

  test('hides a secret of meta wherever it is: in an instance, in what a toJSON() gives, in an error and in a list of them', async () => {
    class Account {
      constructor() {
        this.name = 'Anna';
        this.apiToken = 'instance-secret';
      }
    }

    const failure = new AppError(ERROR_CODE.SERVER_ERROR, { headers: { 'set-cookie': 'sid=cookie-secret' } });
    const id = await record({
      action: 'user.update',
      meta: {
        account: new Account(),
        accounts: [new Account()],
        own: { toJSON: () => ({ refreshToken: 'json-secret' }) },
        failure,
      },
    });
    const { meta } = await readRecord(id);

    assert.deepEqual([meta.account, meta.accounts, meta.own], [
      { name: 'Anna', apiToken: HIDDEN },
      [{ name: 'Anna', apiToken: HIDDEN }],
      { refreshToken: HIDDEN },
    ]);
    assert.equal(meta.failure.code, ERROR_CODE.SERVER_ERROR);
    assert.equal(/instance-secret|json-secret|cookie-secret/.test(JSON.stringify(meta)), false);
  });

  test('stores what two parts of meta share in both of them: a row before a change and the row made of it', async () => {
    const row = { name: 'Editors', scopes: ['users:read', 'groups:manage'], profile: { city: 'Kyiv' } };
    const meta = { before: row, after: { ...row, name: 'Writers' }, requested: row.scopes };
    const id = await record({ action: 'group.update', meta });

    assert.deepEqual((await readRecord(id)).meta, JSON.parse(JSON.stringify(meta)));
  });

  test('stores half of an emoji with the replacement character and a bigint as its text: neither fails the action', async () => {
    const half = String.fromCharCode(0xD83D);
    const replacement = String.fromCharCode(0xFFFD);
    const id = await record({ action: 'user.rename', meta: { name: `Anna ${half}`, total: 10n, requested: { [half]: 1 } } });

    assert.deepEqual((await readRecord(id)).meta, { name: `Anna ${replacement}`, total: '10', requested: { [replacement]: 1 } });
  });

  test('stores a meta nested deeper than it walks cut, as the body of a client may be: the action goes on', async () => {
    const id = await record({ action: 'user.update', meta: { requested: Array.from({ length: 5000 }).reduce((inner) => [inner], 'bottom') } });

    assert.match(JSON.stringify((await readRecord(id)).meta), /^\{"requested":\[+"\[depth limit\]"\]+\}$/);
  });

  test('takes an actorId of null for the system, also when the request has a user', async () => {
    const requestUserId = await insertUser();
    const id = await record({
      action: 'user.group_grant',
      entityType: TABLE.USERS,
      entityId: uuidv7(),
      actorId: null,
      request: { ip: '::1', id: uuidv7(), user: { id: requestUserId } },
    });

    assert.equal((await readRecord(id)).actor_id, null);
  });

  test('takes an actorId it is given over the user of the request', async () => {
    const [requestUserId, actorId] = await Promise.all([insertUser(), insertUser()]);
    const id = await record({
      action: 'group.grant',
      entityType: TABLE.GROUPS,
      entityId: uuidv7(),
      actorId,
      request: { ip: '::1', id: uuidv7(), user: { id: requestUserId } },
    });

    assert.equal((await readRecord(id)).actor_id, actorId);
  });

  test('takes an action of snake_case parts with digits, up to 64 characters', async () => {
    const actions = ['user_group.grant_scope', 'oauth2.link', `user.${'b'.repeat(59)}`];
    const ids = await testDb.run(() => withTransaction(() => Promise.all(actions.map((action) => writeAudit({ action })))));
    const rows = await Promise.all(ids.map((id) => readRecord(id)));

    assert.deepEqual(rows.map((row) => row.action), actions);
  });

  test('leaves no record behind when the transaction rolls back', async () => {
    const entityId = uuidv7();
    const failure = new Error('The action failed after its record');
    const error = await rejectionOf(testDb.run(() => withTransaction(async () => {
      await writeAudit({ action: 'user.block', entityType: TABLE.USERS, entityId });

      throw failure;
    })));

    assert.equal(error, failure);
    assert.equal(await countRecords(entityId), 0);
  });

  test('goes with a nested withTransaction() that fails, while the record of the outer one is committed', async () => {
    const outerEntityId = uuidv7();
    const innerEntityId = uuidv7();
    const failure = new Error('The nested action failed after its record');

    await testDb.run(() => withTransaction(async () => {
      await writeAudit({ action: 'group.update', entityType: TABLE.GROUPS, entityId: outerEntityId });

      const error = await rejectionOf(withTransaction(async () => {
        await writeAudit({ action: 'group.delete', entityType: TABLE.GROUPS, entityId: innerEntityId });

        throw failure;
      }));

      assert.equal(error, failure);
    }));

    assert.equal(await countRecords(outerEntityId), 1);
    assert.equal(await countRecords(innerEntityId), 0);
  });

  test('rejects outside a transaction and sends nothing', async (t) => {
    const { pool, listAuditStatements } = openWatchedPool(t);
    const entityId = uuidv7();
    const error = await rejectionOf(pool.run(() => writeAudit({ action: 'user.block', entityType: TABLE.USERS, entityId })));

    assert.equal(error.constructor, Error);
    assert.match(error.message, /runs inside withTransaction\(\)/);
    assert.deepEqual(listAuditStatements(), []);
    assert.equal(await countRecords(entityId), 0);
  });

  test('refuses a wrong entry with a TypeError before it sends any statement', async (t) => {
    const { pool, listAuditStatements } = openWatchedPool(t);
    const entityId = uuidv7();
    const entry = { action: 'user.block', entityType: TABLE.USERS, entityId };

    await pool.run(() => withTransaction(async () => {
      await Promise.all(WRONG_ENTRIES.map(([wrong, refusal]) => assert.rejects(
        writeAudit({ ...entry, ...wrong }),
        (error) => error instanceof TypeError && refusal.test(error.message),
        `${inspect(wrong)} is not refused for its own reason`,
      )));
      await writeAudit(entry);
    }));

    assert.equal(listAuditStatements().length, 1);
    assert.equal(await countRecords(entityId), 1);
    await assert.rejects(writeAudit(), (error) => error instanceof TypeError && ACTION_REFUSAL.test(error.message));
  });

  test('stores NULL for an ip that is not an IP address or does not fit its column', async () => {
    // node:net takes an IPv6 address with a zone of any length; this one is longer than the 45 characters of the column.
    const longScopedIp = `fe80::1%${'a'.repeat(40)}`;
    const ips = ['203.0.113.7', '2001:db8::1', 'not-an-ip', '', '999.0.0.1', longScopedIp, 42, undefined];
    const ids = await testDb.run(() => withTransaction(() => Promise.all(ips.map((ip) => writeAudit({ action: 'user.sign_in', request: { ip } })))));
    const rows = await Promise.all(ids.map((id) => readRecord(id)));

    assert.deepEqual(rows.map((row) => row.ip), ['203.0.113.7', '2001:db8::1', null, null, null, null, null, null]);
  });

  test('takes the request id of the context outside a request, and stores NULL for what it is not given', async () => {
    const requestId = uuidv7();
    const fromContext = await runInContext(
      createContext({ ...testDb.context, requestId }),
      () => withTransaction(() => writeAudit({ action: 'job.run' })),
    );
    const withoutRequest = await record({
      action: 'job.run',
      entityType: null,
      entityId: null,
      actorId: null,
      meta: null,
    });

    assert.equal((await readRecord(fromContext)).request_id, requestId);
    assert.deepEqual(await readRecord(withoutRequest), {
      id: withoutRequest,
      actor_id: null,
      action: 'job.run',
      entity_type: null,
      entity_id: null,
      meta: null,
      ip: null,
      request_id: null,
    });
  });
});
