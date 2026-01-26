import { isObject } from '#src/util/is-object.js';
import { getErrorSchema, getSuccessSchema } from '#src/util/response.js';

function generateSchemaFromProperties(props, options = {}, overwriteOptions = {}) {
  if (!isObject(props)) {
    return false;
  }

  // INIT
  const schema = {};

  // COOKIES
  const cookiesSchema = generatePayloadSchemaFromProperties(
    props,
    options.cookieKeys,
    options.cookieRequiredKeys,
  );
  if (cookiesSchema) {
    schema.cookies = cookiesSchema;
  }

  // BODY
  const bodySchema = generatePayloadSchemaFromProperties(
    props,
    options.bodyKeys,
    options.bodyRequiredKeys,
  );
  if (bodySchema) {
    schema.body = bodySchema;
  }

  // PARAMS
  const paramsSchema = generatePayloadSchemaFromProperties(
    props,
    options.paramKeys,
    options.paramRequiredKeys,
  );
  if (paramsSchema) {
    schema.params = paramsSchema;
  }

  // QUERY
  const querySchema = generatePayloadSchemaFromProperties(
    props,
    options.queryKeys,
    options.queryRequiredKeys,
  );
  if (querySchema) {
    schema.querystring = querySchema;
  }

  // RESPONSE
  schema.response = {
    200: getSuccessSchema(
      {
        ...options.successSchemaOptions || {},
      },
    ),
    400: getErrorSchema(
      {
        ...options.errorSchemaOptions || {},
      },
    ),
    401: getErrorSchema(
      {
        description: 'Authentication error response',
        messageExample: 'Authentication Error',
        dataExample: null,
        ...options.authenticationSchemaOptions || {},
      },
    ),
    403: getErrorSchema(
      {
        description: 'Authorization error response',
        messageExample: 'Authorization Error',
        dataExample: null,
        ...options.authorizationSchemaOptions || {},
      },
    ),
    500: getErrorSchema(
      {
        description: 'Server error response',
        messageExample: 'Server Error',
        dataExample: null,
        ...options.serverErrorSchemaOptions || {},
      },
    ),
  };

  return {
    ...schema,
    ...overwriteOptions,
  };
}

function generatePayloadSchemaFromProperties(props, keys = [], requiredKeys = []) {
  if (!isObject(props) || !keys.length) {
    return false;
  }

  const properties = {};
  const required = [];

  keys.forEach((key) => {
    if (Object.hasOwn(props, key)) {
      properties[key] = structuredClone(props[key]);
    }
  });

  requiredKeys.forEach((key) => {
    if (Object.hasOwn(props, key)) {
      required.push(key);
    }
  });

  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

export {
  generatePayloadSchemaFromProperties,
  generateSchemaFromProperties,
};
