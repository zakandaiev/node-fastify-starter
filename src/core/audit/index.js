import { findContext } from '#core/context/index.js';
import { insertReturning } from '#core/db/index.js';
import { isInTransaction } from '#core/db/transaction.js';
import { TABLE } from '#enums/table.js';
import { isUuid, uuidv7 } from '#utils/id.js';
import { maskSensitiveDeep } from '#utils/sensitive.js';
import { toJsonTree } from '#utils/serialize.js';
import { isObject, isString } from '#utils/type.js';
import { toIpAddress } from '#utils/validate.js';

const SIGNATURE = 'writeAudit({ action, entityType, entityId, actorId, meta, request })';

// <entity>.<verb>, as the columns of audit_logs hold them.
const ACTION_REGEXP = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const ACTION_MAX_LENGTH = 64;

function assertOptional(value, isValid, message) {
  if (value !== undefined && value !== null && !isValid(value)) {
    throw new TypeError(`${SIGNATURE} requires ${message}`);
  }
}

function assertEntry({
  action,
  entityType,
  entityId,
  actorId,
  meta,
}) {
  if (!isString(action) || action.length > ACTION_MAX_LENGTH || !ACTION_REGEXP.test(action)) {
    throw new TypeError(`${SIGNATURE} requires an action such as "user.block": an entity and a verb in snake_case, up to ${ACTION_MAX_LENGTH} characters`);
  }

  assertOptional(entityType, (value) => Object.values(TABLE).includes(value), 'entityType to be a table of src/enums/table.js');
  assertOptional(entityId, isUuid, 'entityId to be the UUID of a row');
  assertOptional(actorId, isUuid, 'actorId to be the UUID of a user');
  assertOptional(meta, isObject, 'meta to be a plain object');
}

// The mask walks plain objects and lists, and takes what it meets twice for a cycle: it gets the tree JSON makes of
// meta, in which an instance and a toJSON() are plain, an error keeps its own fields only and nothing is shared.
function readMeta(meta) {
  return isObject(meta)
    ? JSON.stringify(maskSensitiveDeep(toJsonTree(meta)))
    : null;
}

// A sensitive action and its record commit together or not at all: outside withTransaction() the action could stay
// without its record, and so it would inside one whose fn swallows a failure of this call.
export async function writeAudit(entry = {}) {
  assertEntry(entry);

  if (!isInTransaction()) {
    throw new Error(`${SIGNATURE} runs inside withTransaction(), with the action it records`);
  }

  const { request } = entry;
  const id = uuidv7();

  await insertReturning(TABLE.AUDIT_LOGS, {
    id,
    actorId: entry.actorId === undefined
      ? request?.user?.id ?? null
      : entry.actorId,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    meta: readMeta(entry.meta),
    ip: toIpAddress(request?.ip),
    requestId: request?.id ?? findContext()?.requestId ?? null,
  }, { returning: ['id'] });

  return id;
}
