import { HTTP_STATUS } from '#enums/http-status.js';

const LOG_LEVEL_WARN = 'warn';
const LOG_LEVEL_ERROR = 'error';

export const ERROR_CODE = Object.freeze({
  BAD_REQUEST_ERROR: 'BAD_REQUEST_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  SESSION_REVOKED: 'SESSION_REVOKED',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  ORIGIN_ERROR: 'ORIGIN_ERROR',
  NOT_FOUND_ERROR: 'NOT_FOUND_ERROR',
  NO_CHANGES: 'NO_CHANGES',
  CONTACT_TAKEN: 'CONTACT_TAKEN',
  IDENTITY_TAKEN: 'IDENTITY_TAKEN',
  GROUP_PROTECTED: 'GROUP_PROTECTED',
  PAYLOAD_TOO_LARGE_ERROR: 'PAYLOAD_TOO_LARGE_ERROR',
  UNSUPPORTED_MEDIA_TYPE_ERROR: 'UNSUPPORTED_MEDIA_TYPE_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  SERVICE_UNAVAILABLE_ERROR: 'SERVICE_UNAVAILABLE_ERROR',
});

function defineClientError(statusCode, message) {
  return Object.freeze({
    statusCode,
    message,
    logLevel: LOG_LEVEL_WARN,
    isAlertable: false,
  });
}

function defineServerError(statusCode, message) {
  return Object.freeze({
    statusCode,
    message,
    logLevel: LOG_LEVEL_ERROR,
    isAlertable: true,
  });
}

export const ERROR_CATALOG = Object.freeze({
  [ERROR_CODE.BAD_REQUEST_ERROR]: defineClientError(HTTP_STATUS.BAD_REQUEST, 'Bad request'),
  [ERROR_CODE.AUTHENTICATION_ERROR]: defineClientError(HTTP_STATUS.UNAUTHORIZED, 'Authentication error'),
  [ERROR_CODE.SESSION_REVOKED]: defineClientError(HTTP_STATUS.UNAUTHORIZED, 'Session revoked'),
  [ERROR_CODE.AUTHORIZATION_ERROR]: defineClientError(HTTP_STATUS.FORBIDDEN, 'Authorization error'),
  [ERROR_CODE.ORIGIN_ERROR]: defineClientError(HTTP_STATUS.FORBIDDEN, 'Origin is not allowed'),
  [ERROR_CODE.NOT_FOUND_ERROR]: defineClientError(HTTP_STATUS.NOT_FOUND, 'Not found'),
  [ERROR_CODE.NO_CHANGES]: defineClientError(HTTP_STATUS.CONFLICT, 'No changes'),
  // Neither tells which contact or which account it met: the answer must not reveal who has signed up.
  [ERROR_CODE.CONTACT_TAKEN]: defineClientError(HTTP_STATUS.CONFLICT, 'Contact belongs to another account'),
  [ERROR_CODE.IDENTITY_TAKEN]: defineClientError(HTTP_STATUS.CONFLICT, 'Identity is linked to another account'),
  [ERROR_CODE.GROUP_PROTECTED]: defineClientError(HTTP_STATUS.CONFLICT, 'Group is protected'),
  [ERROR_CODE.PAYLOAD_TOO_LARGE_ERROR]: defineClientError(HTTP_STATUS.PAYLOAD_TOO_LARGE, 'Payload too large'),
  [ERROR_CODE.UNSUPPORTED_MEDIA_TYPE_ERROR]: defineClientError(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'Unsupported media type'),
  [ERROR_CODE.VALIDATION_ERROR]: defineClientError(HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Validation error'),
  [ERROR_CODE.RATE_LIMIT_ERROR]: defineClientError(HTTP_STATUS.TOO_MANY_REQUESTS, 'Rate limit exceeded'),
  [ERROR_CODE.SERVER_ERROR]: defineServerError(HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Server error'),
  [ERROR_CODE.UPSTREAM_ERROR]: defineServerError(HTTP_STATUS.BAD_GATEWAY, 'Upstream error'),
  // An overload is not a fault of the code: it is logged as a warning.
  [ERROR_CODE.SERVICE_UNAVAILABLE_ERROR]: defineClientError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'Service unavailable'),
});
