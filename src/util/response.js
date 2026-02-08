function normalizeDataByColumns(data, columns) {
  if (Array.isArray(columns) && columns.length && columns[0] !== '*') {
    return columns.reduce((outputObject, columnKey) => {
      outputObject[columnKey] = data[columnKey] || null;
      return outputObject;
    }, {});
  }

  return structuredClone(data);
}

function replySuccess(reply, overwriteOptions = {}) {
  reply.code(overwriteOptions.code || 200);
  delete overwriteOptions.code;

  return reply.send({
    status: 'success',
    data: overwriteOptions.data || null,
    ...overwriteOptions,
  });
}

function replyError(reply, overwriteOptions = {}) {
  reply.code(overwriteOptions.code || 400);
  delete overwriteOptions.code;

  return reply.send({
    status: 'error',
    message: overwriteOptions.message || null,
    ...overwriteOptions,
  });
}

function replyErrorAuthentication(reply, overwriteOptions = {}) {
  return replyError(reply, {
    code: 401,
    message: 'Authentication error',
    data: 'AUTHENTICATION',
    ...overwriteOptions,
  });
}

function replyErrorAuthorization(reply, overwriteOptions = {}) {
  return replyError(reply, {
    code: 403,
    message: 'Authorization error',
    data: 'AUTHORIZATION',
    ...overwriteOptions,
  });
}

function getSuccessSchema(options = {}, overwriteOptions = {}) {
  return {
    description: options.description || 'Success response',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['status', 'data'],
          properties: {
            status: {
              type: 'string',
              enum: ['success'],
              description: 'Response status',
            },
            data: {
              schema: options.dataSchema || undefined,
              description: options.dataDescription || 'Additional data if needed',
              example: options.dataExample === undefined
                ? 'Additional data if needed'
                : options.dataExample,
            },
            ...options.properties || {},
          },
        },
      },
    },
    ...overwriteOptions,
  };
}

function getErrorSchema(options = {}, overwriteOptions = {}) {
  return {
    description: options.description || 'Error response',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['status', 'message'],
          properties: {
            status: {
              type: 'string',
              enum: ['error'],
              description: 'Response status',
            },
            message: {
              type: ['string', 'null'],
              description: options.messageDescription || 'Error details message',
              example: options.messageExample || undefined,
            },
            data: {
              schema: options.dataSchema || undefined,
              description: options.dataDescription || 'Additional data if needed',
              example: options.dataExample === undefined
                ? 'Additional data if needed'
                : options.dataExample,
            },
            ...options.properties || {},
          },
        },
      },
    },
    ...overwriteOptions,
  };
}

function setNotFoundHandler(request, reply) {
  return replyError(reply, {
    code: 404,
    message: `Route ${request.method} ${request.url} not found`,
    data: 'ROUTE_NOT_FOUND',
  });
}

function setErrorHandler(error, request, reply) {
  const responseErrorObj = {
    code: error.statusCode || 500,
    message: 'Server error',
    data: error.message,
  };

  // AJV validation
  if (error.validation) {
    responseErrorObj.code = 400;
    responseErrorObj.message = 'Validation Error';
    responseErrorObj.validation = formatValidationErrors(error.validation, error.validationContext, request) || [];
  }

  // MYSQL validation
  if (['ER_DUP_ENTRY'].includes(error.code)) {
    responseErrorObj.code = 400;
    responseErrorObj.message = 'Validation Error';
    const mysqlValidationErrors = formatMysqlValidationErrors(error, request) || [];
    responseErrorObj.validation = Array.isArray(responseErrorObj.validation)
      ? responseErrorObj.validation.concat(mysqlValidationErrors)
      : mysqlValidationErrors;
  }

  return replyError(reply, responseErrorObj);
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
  if (typeof error !== 'object') {
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
  getErrorSchema,
  getSuccessSchema,
  normalizeDataByColumns,
  replyError,
  replyErrorAuthentication,
  replyErrorAuthorization,
  replySuccess,
  setErrorHandler,
  setNotFoundHandler,
};
