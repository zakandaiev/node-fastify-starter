import { listPictureUrls, toValidPictureUrl } from '#core/auth/oauth/provider.js';
import { SESSION_TRANSACTION } from '#core/auth/session.js';
import { lockUsers } from '#core/auth/user.js';
import { getContext } from '#core/context/index.js';
import { isOutcomeUnknown } from '#core/db/error.js';
import { updateReturning } from '#core/db/index.js';
import { withTransaction } from '#core/db/transaction.js';
import { fetchExternal } from '#core/http/external.js';
import { findUpstreamError } from '#core/http/index.js';
import { isImageQueueIdle, processImage } from '#core/image/index.js';
import { IMAGE_INPUT_TYPES } from '#core/image/profile.js';
import { getStorage } from '#core/storage/index.js';
import { toStorageKey } from '#core/storage/key.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { TABLE } from '#enums/table.js';
import { USER_STATUS } from '#enums/user-status.js';
import { convertMsToString, convertStringToMs } from '#utils/date.js';
import { assertUuid } from '#utils/id.js';
import { compact } from '#utils/object.js';
import { isNonEmptyArray, isNonEmptyString, isObject } from '#utils/type.js';

const SIGNATURE = 'copyProviderPicture({ userId, provider, pictureUrl })';
const SERVICE_PREFIX = 'picture-';
const AVATAR_FIELDS = Object.freeze(['avatarKey']);

const NOT_COPIED_MESSAGE = 'The picture of a provider is not copied to the avatar';
const REMOVE_FAILED_MESSAGE = 'Failed to remove a copy of the picture of a provider';

const REASON = Object.freeze({
  BUSY: 'busy',
  FETCH: 'fetch',
  IMAGE: 'image',
  TAKEN: 'taken',
  FAILED: 'failed',
});

function assertCopy({ userId, provider, pictureUrl }) {
  assertUuid(userId, SIGNATURE, 'a user');

  if (!isObject(provider) || !isNonEmptyString(provider.id) || !isNonEmptyArray(provider.pictureHosts)) {
    throw new TypeError(`${SIGNATURE} requires the record of a provider of config.oauth that names its pictureHosts`);
  }

  if (toValidPictureUrl(pictureUrl) === null) {
    throw new TypeError(`${SIGNATURE} requires pictureUrl, the address of the picture a profile gives`);
  }
}

function warnNotCopied(copy, reason, details = {}) {
  getContext().log.warn(compact({
    ...details,
    userId: copy.userId,
    providerId: copy.provider.id,
    reason,
  }), NOT_COPIED_MESSAGE);

  return null;
}

async function removeCopy(key) {
  try {
    await getStorage().delete(key);
  } catch (error) {
    getContext().log.warn({ err: error }, REMOVE_FAILED_MESSAGE);

    return false;
  }

  return true;
}

// Written only while the avatar is empty: one the user has set while the picture came stays, and a user blocked or
// deleted meanwhile gets none.
function takeCopy(userId, key) {
  return withTransaction(async () => {
    const [user = null] = await lockUsers([userId]);

    if (user?.status !== USER_STATUS.ACTIVE || user.avatarKey !== null) {
      return false;
    }

    await updateReturning(TABLE.USERS, { avatarKey: key }, { where: { id: userId }, returning: AVATAR_FIELDS });

    return true;
  }, SESSION_TRANSACTION);
}

// A write whose connection was lost may have committed: an orphan file is cheaper than a key that names a removed one.
async function landCopy(copy, key) {
  try {
    return await takeCopy(copy.userId, key);
  } catch (error) {
    if (!isOutcomeUnknown(error)) {
      await removeCopy(key);
    }

    throw error;
  }
}

// A copy no row names is removed, whatever kept it off the row.
async function storeAvatar(copy, image) {
  const key = toStorageKey(image.extension);

  await getStorage().put(key, image.bytes);

  if (await landCopy(copy, key)) {
    return key;
  }

  await removeCopy(key);

  return warnNotCopied(copy, REASON.TAKEN);
}

// pictureTimeout is the most a sign-in waits, whatever the addresses it tries: the next one gets what is left of it,
// and only after the upstream has failed the one before.
async function fetchFirst(copy, [url, ...rest], deadline) {
  try {
    return await fetchExternal(url, {
      service: `${SERVICE_PREFIX}${copy.provider.id}`,
      allowedHosts: copy.provider.pictureHosts,
      allowedTypes: IMAGE_INPUT_TYPES,
      timeout: deadline.timeout,
    });
  } catch (error) {
    const msLeft = Math.floor(deadline.endsAt - performance.now());

    if (!rest.length || !findUpstreamError(error) || msLeft <= 0) {
      throw error;
    }

    return fetchFirst(copy, rest, { endsAt: deadline.endsAt, timeout: convertMsToString(msLeft) });
  }
}

function fetchPicture(copy) {
  const { config } = getContext();
  const { pictureTimeout } = config.oauth;
  const urls = listPictureUrls(copy.provider, {
    pictureUrl: copy.pictureUrl,
    size: config.upload.image.profiles[IMAGE_PROFILE.AVATAR].maxSize,
  });

  return fetchFirst(copy, urls, { timeout: pictureTimeout, endsAt: performance.now() + convertStringToMs(pictureTimeout) });
}

// A sign-in never waits behind the uploads: a queue that has work, before the fetch or once the picture has come,
// leaves the avatar to the next sign-in.
async function copyPicture(copy) {
  if (!isImageQueueIdle()) {
    return warnNotCopied(copy, REASON.BUSY);
  }

  const { bytes } = await fetchPicture(copy);

  if (!isImageQueueIdle()) {
    return warnNotCopied(copy, REASON.BUSY);
  }

  const { image, refusal } = await processImage(bytes, IMAGE_PROFILE.AVATAR);

  return refusal
    ? warnNotCopied(copy, REASON.IMAGE, { check: refusal.operator })
    : storeAvatar(copy, image);
}

// A copy that fails is a warning alone: the sign-in it follows has succeeded already.
export async function copyProviderPicture({ userId, provider, pictureUrl } = {}) {
  const copy = { userId, provider, pictureUrl };

  assertCopy(copy);

  try {
    return await copyPicture(copy);
  } catch (error) {
    const reason = findUpstreamError(error)
      ? REASON.FETCH
      : REASON.FAILED;

    return warnNotCopied(copy, reason, { err: error });
  }
}
