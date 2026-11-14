import { RESPONSE_STATUS } from '#enums/response-status.js';
import {
  isNonEmptyArray,
  isNonEmptyObject,
  isNonEmptyString,
  isObject,
} from '#utils/type.js';

// A success always carries data, even when it is null: the client reads the same key after every 2xx.
function createDataSection(data, isError) {
  if (data === undefined) {
    return isError
      ? {}
      : { data: null };
  }

  return { data };
}

// The single builder of the response body: reply.*, the error handler and its raw fallback all go through it,
// so the shape cannot drift between them.
export function createEnvelope({
  code,
  message,
  data,
  pagination,
  sort,
  filters,
  validation,
  requestId,
  stack,
} = {}) {
  const isError = isNonEmptyString(code);
  const meta = {
    ...(isNonEmptyString(requestId) && { requestId }),
    ...(isNonEmptyString(stack) && { stack }),
  };

  return {
    status: isError
      ? RESPONSE_STATUS.ERROR
      : RESPONSE_STATUS.SUCCESS,
    ...(isError && { code }),
    ...(isNonEmptyString(message) && { message }),
    ...createDataSection(data, isError),
    ...(isObject(pagination) && { pagination }),
    ...(isNonEmptyArray(sort) && { sort }),
    ...(isNonEmptyArray(filters) && { filters }),
    ...(isNonEmptyArray(validation) && { validation }),
    ...(isNonEmptyObject(meta) && { meta }),
  };
}
