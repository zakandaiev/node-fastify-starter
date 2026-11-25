import { SCHEMA_LIMITS } from '#config/schema.js';
import { HEADER } from '#enums/header.js';
import { truncate } from '#utils/string.js';
import { isNonEmptyString } from '#utils/type.js';
import { toIpAddress } from '#utils/validate.js';

const NO_SUFFIX = '';

// Where a session is used from, within its columns: a longer text would fail the sign-in and every refresh after it.
export function readClient(request) {
  const userAgent = truncate(request.headers[HEADER.USER_AGENT], SCHEMA_LIMITS.userAgentMaxLength, NO_SUFFIX);

  return {
    userAgent: isNonEmptyString(userAgent)
      ? userAgent
      : null,
    ip: toIpAddress(request.ip),
  };
}
