export function isArray(value) {
  return (!!value) && (value.constructor === Array);
}

export function isObject(value) {
  return (!!value) && (value.constructor === Object);
}

export function isBoolean(value) {
  return value === true || value === false ? true : false;
}

export function isFunction(value) {
  return typeof value === 'function';
}

export function isNumber(value) {
  return typeof value === 'number' && !Number.isNaN(value);
}

export function isNumeric(value) {
  return /^-?\d+(\.\d+)?$/.test(value);
}

export function isNumberInRange(number, min, max) {
  return number >= min && number < max;
}

export function isString(value) {
  return typeof value === 'string';
}

export function isStringBoolean(value) {
  if (!isString(value)) {
    return false;
  }
  return value === 'true' || value === 'false' ? true : false;
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

export function toNumber(value) {
  if (isNumber(value)) {
    return value;
  }

  if (!isString(value)) {
    return null;
  }

  const number = parseFloat(value.trim());
  return Number.isNaN(number) ? null : number;
}

export function toString(value) {
  if (isString(value)) {
    return value;
  }

  if (isArray(value) || isObject(value)) {
    return JSON.stringify(value);
  }

  return String(value);
}
