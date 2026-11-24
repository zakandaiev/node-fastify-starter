import { findUpstreamError } from '#core/http/index.js';
import { HEADER } from '#enums/header.js';
import { compact } from '#utils/object.js';
import { truncate } from '#utils/string.js';
import { isNonEmptyString, isNumber } from '#utils/type.js';

export const DELIVERY_FAILURE = Object.freeze({
  UNREACHABLE: 'unreachable',
  REJECTED_TOKEN: 'rejected-token',
  REJECTED_CHAT: 'rejected-chat',
  CHAT_MIGRATED: 'chat-migrated',
  REJECTED_ADDRESS: 'rejected-address',
  REJECTED_TEXT: 'rejected-text',
  RATE_LIMITED: 'rate-limited',
  FAILED: 'failed',
});

// The same text would be refused again: its dedupe mark is kept. Any other failure may pass on the next try,
// and an unknown one counts as such: one more try costs less than an alert that is never sent.
const FINAL_FAILURES = Object.freeze([DELIVERY_FAILURE.REJECTED_TEXT]);

const DESCRIPTION_MAX_LENGTH = 200;

export function delivered() {
  return { isDelivered: true };
}

export function notDelivered(reason, {
  status,
  description,
  retryAfter,
  hint,
} = {}) {
  return compact({
    isDelivered: false,
    reason,
    isRetryable: !FINAL_FAILURES.includes(reason),
    status,
    description: isNonEmptyString(description)
      ? truncate(description, DESCRIPTION_MAX_LENGTH)
      : undefined,
    retryAfter,
    hint,
  });
}

// The way there failed: an address out of reach, the deadline, a body over its ceiling. Anything else is a bug.
export function describeUnreachable(error, hint) {
  const upstreamError = findUpstreamError(error);

  if (!upstreamError) {
    throw error;
  }

  return notDelivered(DELIVERY_FAILURE.UNREACHABLE, {
    description: [upstreamError.reason, upstreamError.code].filter(Boolean).join(' '),
    hint,
  });
}

// In seconds, as the header gives them; an HTTP date is left out.
export function readRetryAfter(headers) {
  const value = headers?.get(HEADER.RETRY_AFTER);
  const seconds = Number(value);

  return isNonEmptyString(value) && isNumber(seconds) && seconds >= 0
    ? seconds
    : undefined;
}
