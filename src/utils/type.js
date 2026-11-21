const NUMERIC_REGEXP = /^-?\d+(\.\d+)?$/;

export function isArray(value) {
  return Array.isArray(value);
}

// By prototype, not by value.constructor: a parsed body {"constructor": 1} is still an object.
// One link to null is allowed, not Object.prototype by identity: request.query and request.params of Fastify
// are built on a prototype of their own that has no prototype itself.
export function isObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

export function isString(value) {
  return typeof value === 'string';
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

export function isBlankString(value) {
  return isString(value) && value.trim() === '';
}

export function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

export function isNonEmptyObject(value) {
  return isObject(value) && Object.keys(value).length > 0;
}

export function isNumber(value) {
  return Number.isFinite(value);
}

export function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isBoolean(value) {
  return typeof value === 'boolean';
}

export function isStringBoolean(value) {
  return value === 'true' || value === 'false';
}

export function isFunction(value) {
  return typeof value === 'function';
}

export function isNumberInRange(value, min, max) {
  return isNumber(value) && value >= min && value <= max;
}

export function toNumber(value) {
  if (isNumber(value)) {
    return value;
  }

  if (!isString(value) || !NUMERIC_REGEXP.test(value)) {
    return null;
  }

  const number = Number(value);

  return isNumber(number)
    ? number
    : null;
}

export function isNumeric(value) {
  return toNumber(value) !== null;
}

export function isStringValidJson(value) {
  if (!isString(value)) {
    return false;
  }

  try {
    const parsed = JSON.parse(value);

    return isArray(parsed) || isObject(parsed);
  } catch {
    return false;
  }
}

export function toString(value) {
  if (isString(value)) {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  try {
    return isArray(value) || isObject(value)
      ? JSON.stringify(value) ?? ''
      : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
