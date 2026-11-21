import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { pick } from '#utils/object.js';
import { isNonEmptyArray, isNonEmptyString, isObject } from '#utils/type.js';

const SIGNATURE = 'buildPatch(body, { allowed })';

function assertAllowed(allowed) {
  if (!isNonEmptyArray(allowed) || !allowed.every((field) => isNonEmptyString(field)) || new Set(allowed).size !== allowed.length) {
    throw new TypeError(`${SIGNATURE} requires "allowed" to be a non-empty array of distinct field names`);
  }

  return true;
}

// A key that is missing or undefined leaves its column alone, null writes NULL: JSON has no undefined, but code
// that builds the body may put one there.
export function buildPatch(body, { allowed } = {}) {
  if (!isObject(body)) {
    throw new TypeError(`${SIGNATURE} requires body to be a plain object`);
  }

  assertAllowed(allowed);

  const patch = Object.fromEntries(Object.entries(pick(body, allowed)).filter(([, value]) => value !== undefined));

  if (!Object.keys(patch).length) {
    throw new AppError(ERROR_CODE.NO_CHANGES);
  }

  return patch;
}
