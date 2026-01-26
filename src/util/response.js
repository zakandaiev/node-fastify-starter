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
              example: options.dataExample === undefined ? 'Additional data if needed' : options.dataExample,
            },
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
              example: options.dataExample === undefined ? 'Additional data if needed' : options.dataExample,
            },
            validation: {
              type: ['array'],
              description: 'Validation data if needed',
              example: options.validationExample === undefined ? [] : options.validationExample,
            },
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
  });
}

function setErrorHandler(error, request, reply) {
  const responseErrorObj = {
    code: error.statusCode || 500,
    message: 'Server Error',
  };

  if (process.env.APP_MODE === 'dev') {
    responseErrorObj.data = error.message;
  }

  if (error.validation) {
    responseErrorObj.code = 400;
    responseErrorObj.message = 'Validation Error';
    responseErrorObj.validation = formatValidationErrors(error.validation) || [];
  }

  return replyError(reply, responseErrorObj);
}

function formatValidationErrors(errors) {
  if (!Array.isArray(errors) || !errors.length) {
    return [];
  }

  return errors.map((errorSchema) => {
    if (!errorSchema) {
      return false;
    }

    const column = errorSchema.instancePath
      ? errorSchema.instancePath.replace(/^\//, '')
      : errorSchema.params?.missingProperty || '';

    const operator = errorSchema.keyword || '';
    const operatorValue = errorSchema.params?.limit || null;

    const schema = { ...errorSchema };

    return {
      column,
      operator,
      operatorValue,
      schema,
    };
  });
}

export {
  getErrorSchema,
  getSuccessSchema,
  replyError,
  replySuccess,
  setErrorHandler,
  setNotFoundHandler,
};
