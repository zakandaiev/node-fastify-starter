import { ERROR_CATALOG } from '#enums/error-code.js';
import { isArray, isObject } from '#utils/type.js';

export class AppError extends Error {
  constructor(code, options = {}) {
    if (!Object.hasOwn(ERROR_CATALOG, code)) {
      throw new TypeError(`AppError(code, options) requires a code from src/enums/error-code.js, got "${code}"`);
    }

    if (!isObject(options)) {
      throw new TypeError('AppError(code, options) requires options to be a plain object');
    }

    const {
      message,
      validation,
      headers,
      cause,
    } = options;

    if (validation !== undefined && !isArray(validation)) {
      throw new TypeError('AppError(code, { validation }) requires validation to be an array');
    }

    if (headers !== undefined && !isObject(headers)) {
      throw new TypeError('AppError(code, { headers }) requires headers to be a plain object');
    }

    const entry = ERROR_CATALOG[code];

    // An options object that merely has the key gives the error an own "cause: undefined".
    super(message ?? entry.message, cause === undefined ? undefined : { cause });

    this.code = code;
    this.statusCode = entry.statusCode;

    if (validation) {
      this.validation = validation;
    }

    if (headers) {
      this.headers = headers;
    }
  }
}

// On the prototype, not on the instance: an own enumerable name is copied into every log line next to "type".
Object.defineProperty(AppError.prototype, 'name', {
  value: 'AppError',
  writable: true,
  configurable: true,
});
