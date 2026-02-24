import { isArray, isObject, toString } from '#src/util/misc.js';

function normalizeDataByColumns(data, columns) {
  if (!isObject(data)) {
    return data;
  }

  if (Array.isArray(columns) && columns.length && columns[0] !== '*') {
    return columns.reduce((outputObject, columnKey) => {
      outputObject[columnKey] = data[columnKey] || null;
      return outputObject;
    }, {});
  }

  return structuredClone(data);
}

function redirect(fastifyReply, url, code) {
  if (code) fastifyReply.code(code);
  return fastifyReply.redirect(url || '/');
}

function reply(fastifyReply, data = null, code = 200, contentType = 'text/plain') {
  if (!data) {
    return replyEmpty(fastifyReply, code, contentType);
  }

  if (isArray(data) || isObject(data)) {
    contentType = 'application/json';
  }

  fastifyReply.code(code).type(contentType);
  return fastifyReply.send(toString(data));
}

function replyEmpty(fastifyReply, code = 200, contentType = 'text/plain') {
  fastifyReply.code(code).type(contentType);
  return fastifyReply.send();
}

function replySuccess(fastifyReply, overwriteOptions = {}) {
  fastifyReply.code(overwriteOptions.code || 200);
  delete overwriteOptions.code;

  return fastifyReply.send({
    status: 'success',
    data: overwriteOptions.data || null,
    ...overwriteOptions,
  });
}

function replyError(fastifyReply, overwriteOptions = {}) {
  fastifyReply.code(overwriteOptions.code || 400);
  delete overwriteOptions.code;

  return fastifyReply.send({
    status: 'error',
    message: overwriteOptions.message || null,
    ...overwriteOptions,
  });
}

function replyErrorAuthentication(fastifyReply, overwriteOptions = {}) {
  return replyError(fastifyReply, {
    code: 401,
    message: 'Authentication error',
    data: 'AUTHENTICATION_ERROR',
    ...overwriteOptions,
  });
}

function replyErrorAuthorization(fastifyReply, overwriteOptions = {}) {
  return replyError(fastifyReply, {
    code: 403,
    message: 'Authorization error',
    data: 'AUTHORIZATION_ERROR',
    ...overwriteOptions,
  });
}

function replyErrorNotFound(request, fastifyReply, overwriteOptions = {}) {
  return replyError(fastifyReply, {
    code: 404,
    message: `Route ${request.method} ${request.url} not found`,
    data: 'NOT_FOUND_ERROR',
    ...overwriteOptions,
  });
}

function setNotFoundHandler(request, fastifyReply) {
  return replyErrorNotFound(request, fastifyReply);
}

function setErrorHandler(error, request, fastifyReply) {
  const responseErrorObj = {
    code: error.statusCode || 500,
    message: 'Server error',
    data: process.env.APP_MODE === 'dev'
      ? error.message
      : 'SERVER_ERROR',
  };

  // AJV validation
  if (error.validation) {
    responseErrorObj.code = 400;
    responseErrorObj.message = 'Validation Error';
    responseErrorObj.data = 'VALIDATION_ERROR';
    responseErrorObj.validation = formatValidationErrors(error.validation, error.validationContext, request) || [];
  }

  // MYSQL validation
  if (['ER_DUP_ENTRY'].includes(error.code)) {
    responseErrorObj.code = 400;
    responseErrorObj.message = 'Validation Error';
    responseErrorObj.data = 'VALIDATION_ERROR';
    const mysqlValidationErrors = formatMysqlValidationErrors(error, request) || [];
    responseErrorObj.validation = Array.isArray(responseErrorObj.validation)
      ? responseErrorObj.validation.concat(mysqlValidationErrors)
      : mysqlValidationErrors;
  }

  return replyError(fastifyReply, responseErrorObj);
}

function formatValidationErrors(errors, validationContext, request) {
  if (!Array.isArray(errors) || !errors.length) {
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

    const schema = { ...errorSchema };

    return {
      column,
      columnValue,
      operator,
      operatorValue,
      schema,
    };
  });
}

function formatMysqlValidationErrors(error) {
  if (!isObject(error)) {
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

export {
  normalizeDataByColumns,
  redirect,
  reply,
  replyEmpty,
  replyError,
  replyErrorAuthentication,
  replyErrorAuthorization,
  replyErrorNotFound,
  replySuccess,
  setErrorHandler,
  setNotFoundHandler,
};
