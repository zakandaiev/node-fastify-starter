import { isArray, isObject } from '#utils/type.js';

const HIDDEN_PLACEHOLDER = '[hidden]';
const DEPTH_PLACEHOLDER = '[depth limit]';
const REPEAT_PLACEHOLDER = '[repeated]';
const UNREADABLE_PLACEHOLDER = '[unreadable]';

// The payload may come from a public endpoint: the ceiling and the set of visited containers
// keep the walk linear whatever the shape of the input.
const MASK_MAX_DEPTH = 12;

// Matched as substrings of the lower-cased key. No "code" and no "email" here:
// an alert has to show the error code, and "email" is also the name of a notification channel.
const SENSITIVE_KEY_FRAGMENTS = [
  'auth',
  'token',
  'pass',
  'pwd',
  'secret',
  'key',
  'jwt',
  'session',
  'cookie',
  'credential',
  'signature',
  'hash',
  'otp',
  'verifier',
  'initdata',
];

// String() throws on an object without a primitive form: a key that cannot be read counts as a secret.
export function isSensitiveKey(key) {
  try {
    const normalizedKey = String(key).toLowerCase();

    return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment));
  } catch {
    return true;
  }
}

function maskEntry(key, value, depth, seen) {
  if (!isSensitiveKey(key)) {
    return maskValue(value, depth, seen);
  }

  return value === null || value === undefined
    ? value
    : HIDDEN_PLACEHOLDER;
}

function maskContainer(container, depth, seen) {
  if (isArray(container)) {
    return container.map((item) => maskValue(item, depth, seen));
  }

  return Object.fromEntries(
    Object.entries(container).map(([key, item]) => [key, maskEntry(key, item, depth, seen)]),
  );
}

// A getter or a proxy of the payload may throw: the unreadable part is replaced, the rest survives.
function maskValue(value, depth, seen) {
  try {
    if (!isArray(value) && !isObject(value)) {
      return value;
    }

    if (depth >= MASK_MAX_DEPTH) {
      return DEPTH_PLACEHOLDER;
    }

    if (seen.has(value)) {
      return REPEAT_PLACEHOLDER;
    }

    seen.add(value);

    return maskContainer(value, depth + 1, seen);
  } catch {
    return UNREADABLE_PLACEHOLDER;
  }
}

export function maskSensitiveDeep(value) {
  return maskValue(value, 0, new WeakSet());
}
