import {
  isArray,
  isObject,
  isString,
  toString,
} from '#src/util/misc.js';

export function normalizeDataByColumns(data, columns) {
  if (!isObject(data)) {
    return data;
  }

  if (isArray(columns) && columns.length && columns[0] !== '*') {
    return columns.reduce((outputObject, columnKey) => {
      outputObject[columnKey] = data[columnKey] ?? null;
      return outputObject;
    }, {});
  }

  return data;
}

export function redirect(fastifyReply, url, code) {
  if (code) fastifyReply.code(code);
  return fastifyReply.redirect(url || '/');
}

export function reply(fastifyReply, data = null, code = 200, contentType = 'text/plain') {
  if (!data) {
    return replyEmpty(fastifyReply, code, contentType);
  }

  if (isArray(data) || isObject(data)) {
    contentType = 'application/json';
  }

  fastifyReply.code(code).type(contentType);
  return fastifyReply.send(toString(data));
}

export function replyEmpty(fastifyReply, code = 200, contentType = 'text/plain') {
  fastifyReply.code(code).type(contentType);
  return fastifyReply.send();
}

export function replySuccess(fastifyReply, overwriteOptions = {}) {
  const options = { ...overwriteOptions };

  fastifyReply.code(options.code || 200);
  delete options.code;

  return fastifyReply.send({
    status: 'success',
    data: options.data ?? null,
    ...options,
  });
}

export function replyError(fastifyReply, overwriteOptions = {}) {
  const options = { ...overwriteOptions };

  fastifyReply.code(options.code || 400);
  delete options.code;

  return fastifyReply.send({
    status: 'error',
    message: options.message || null,
    ...options,
  });
}

export function replyErrorAuthentication(fastifyReply, overwriteOptions = {}) {
  return replyError(fastifyReply, {
    code: 401,
    message: 'Authentication error',
    data: 'AUTHENTICATION_ERROR',
    ...overwriteOptions,
  });
}

export function replyErrorAuthorization(fastifyReply, overwriteOptions = {}) {
  return replyError(fastifyReply, {
    code: 403,
    message: 'Authorization error',
    data: 'AUTHORIZATION_ERROR',
    ...overwriteOptions,
  });
}

export function replyErrorNotFound(request, fastifyReply, overwriteOptions = {}) {
  return replyError(fastifyReply, {
    code: 404,
    message: `Route ${request.method} ${request.url} not found`,
    data: 'NOT_FOUND_ERROR',
    ...overwriteOptions,
  });
}

export function setNotFoundHandler(request, fastifyReply) {
  return replyErrorNotFound(request, fastifyReply);
}

export function setErrorHandler(error, request, fastifyReply) {
  const responseErrorObj = {
    code: error.statusCode || 500,
    message: 'Server error',
    data: process.env.APP_MODE === 'dev'
      ? (error.stack || error.message)
      : 'SERVER_ERROR',
  };

  // AJV validation
  if (error.validation) {
    responseErrorObj.code = 400;
    responseErrorObj.message = 'Validation error';
    responseErrorObj.data = 'VALIDATION_ERROR';
    responseErrorObj.validation = formatValidationErrors(error.validation, error.validationContext, request) || [];
  }

  // MYSQL validation
  if (['ER_DUP_ENTRY'].includes(error.code)) {
    responseErrorObj.code = 400;
    responseErrorObj.message = 'Validation error';
    responseErrorObj.data = 'VALIDATION_ERROR';
    const mysqlValidationErrors = formatMysqlValidationErrors(error, request) || [];
    responseErrorObj.validation = isArray(responseErrorObj.validation)
      ? responseErrorObj.validation.concat(mysqlValidationErrors)
      : mysqlValidationErrors;
  }

  // Rate limit
  if (error.statusCode === 429) {
    responseErrorObj.code = 429;
    responseErrorObj.message = 'Rate limit error';
    responseErrorObj.data = 'RATE_LIMIT_ERROR';
  }

  // Under pressure
  if (error.statusCode === 503) {
    responseErrorObj.code = 503;
    responseErrorObj.message = 'Service unavailable';
    responseErrorObj.data = 'SERVICE_UNAVAILABLE_ERROR';
  }

  request.server.log.error({ error });

  if (!fastifyReply.sent) {
    return replyError(fastifyReply, responseErrorObj);
  }
}

export function formatValidationErrors(errors, validationContext, request) {
  if (!isArray(errors) || !errors.length) {
    return false;
  }

  return errors.map((errorSchema) => {
    if (!errorSchema) {
      return false;
    }

    const column = errorSchema.instancePath
      ? errorSchema.instancePath.replace(/^\//, '')
      : errorSchema.params?.missingProperty || '';
    const columnValue = errorSchema.params?.missingProperty
      ? undefined
      : errorSchema.instancePath
        ?.slice(1)
        ?.split('/')
        ?.reduce(
          (o, k) => o?.[k],
          request[validationContext === 'querystring'
            ? 'query'
            : validationContext],
        );

    const operator = errorSchema.keyword || '';
    const operatorValue = errorSchema.params?.limit || null;

    return {
      column,
      columnValue,
      operator,
      operatorValue,
      ...(process.env.APP_MODE === 'dev' && { schema: { ...errorSchema } }),
    };
  });
}

export function formatMysqlValidationErrors(error) {
  if (!error || !isString(error.message)) {
    return false;
  }

  if (error.code === 'ER_DUP_ENTRY') {
    const columnMatch = error.message.match(/Duplicate entry '(.+)' for key '(.+)'/);
    return [{
      column: columnMatch ? columnMatch[2] : null,
      columnValue: columnMatch ? columnMatch[1] : null,
      operator: 'unique',
      operatorValue: null,
      schema: {
        keyword: 'unique',
        message: error.message,
      },
    }];
  }

  return false;
}
