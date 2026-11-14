import { isArray, isObject } from '#utils/type.js';

const HIDDEN_PLACEHOLDER = '[hidden]';
const DEPTH_PLACEHOLDER = '[depth limit]';
const REPEAT_PLACEHOLDER = '[repeated]';
export const UNREADABLE_PLACEHOLDER = '[unreadable]';

export const OMIT_VALUE = Symbol('omit value');

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

function maskEntry(key, value, depth, walk) {
  if (!isSensitiveKey(key)) {
    return maskValue(value, key, depth, walk);
  }

  return value === null || value === undefined
    ? value
    : HIDDEN_PLACEHOLDER;
}

// An item of an array keeps the key of the array: that is the name its values go under.
function maskItem(item, key, depth, walk) {
  const masked = maskValue(item, key, depth, walk);

  return masked === OMIT_VALUE
    ? undefined
    : masked;
}

function maskContainer(container, key, depth, walk) {
  if (isArray(container)) {
    return container.map((item) => maskItem(item, key, depth, walk));
  }

  return Object.fromEntries(
    Object.entries(container)
      .map(([name, item]) => [name, maskEntry(name, item, depth, walk)])
      .filter(([, item]) => item !== OMIT_VALUE),
  );
}

// A value cut here is remembered apart from the visited ones: nearer to the root it is still written whole,
// and at the ceiling replace() is not asked again for every holder of one large value.
function maskAtCeiling(value, key, depth, walk) {
  if (walk.cut.has(value)) {
    return DEPTH_PLACEHOLDER;
  }

  const container = walk.replace(value, key, depth);

  if (!isArray(container) && !isObject(container)) {
    return container;
  }

  if (value !== null && typeof value === 'object') {
    walk.cut.add(value);
  }

  return DEPTH_PLACEHOLDER;
}

// A getter or a proxy of the payload may throw: the unreadable part is replaced, the rest survives.
// The visit is recorded on the value itself, not on what replace() made of it: a value that holds itself
// would otherwise be rebuilt on every level down to the ceiling.
function maskValue(value, key, depth, walk) {
  try {
    const isReference = value !== null && typeof value === 'object';

    if (isReference && walk.seen.has(value)) {
      return REPEAT_PLACEHOLDER;
    }

    if (depth >= MASK_MAX_DEPTH) {
      return maskAtCeiling(value, key, depth, walk);
    }

    const container = walk.replace(value, key, depth);

    if (!isArray(container) && !isObject(container)) {
      return container;
    }

    if (isReference) {
      walk.seen.add(value);
    }

    return maskContainer(container, key, depth + 1, walk);
  } catch {
    return UNREADABLE_PLACEHOLDER;
  }
}

function keepValue(value) {
  return value;
}

// replace(value, key, depth) sees every value before it is walked and returns what to walk instead: the plain
// form of a class instance, a masked text, or OMIT_VALUE to leave the entry out. The root has depth 0 and no key.
// Only plain objects and arrays are walked.
export function maskSensitiveDeep(value, { replace = keepValue } = {}) {
  const masked = maskValue(value, undefined, 0, { replace, seen: new WeakSet(), cut: new WeakSet() });

  return masked === OMIT_VALUE
    ? undefined
    : masked;
}
