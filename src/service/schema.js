import { absPath, resolvePath } from '#core/path.js';
import { isArray, isFunction, isObject } from '#src/util/misc.js';
import { readFileSync } from 'node:fs';

const schemaFileCache = new Map();

export function loadSchemaFiles(schemaNames) {
  const schemaNameList = isArray(schemaNames)
    ? schemaNames
    : [schemaNames];

  const example = {};
  const exampleMap = {};
  const filter = {};
  const sort = [];
  const property = {};

  schemaNameList.forEach((schemaName) => {
    const schemaPath = resolvePath(absPath.schema, `${schemaName}.json`);

    let cachedSchema = schemaFileCache.get(schemaPath);
    if (!cachedSchema) {
      cachedSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));
      schemaFileCache.set(schemaPath, cachedSchema);
    }

    const schema = structuredClone(cachedSchema);

    if (schema['#example']) {
      Object.assign(example, schema['#example']);
      exampleMap[schemaName] = schema['#example'];
      delete schema['#example'];
    }

    if (schema['#filter']) {
      Object.assign(filter, schema['#filter']);
      delete schema['#filter'];
    }

    if (schema['#sort']) {
      if (isArray(schema['#sort'])) {
        sort.push(...schema['#sort']);
      }
      delete schema['#sort'];
    }

    Object.assign(property, schema);
  });

  return {
    example,
    exampleMap,
    filter,
    sort,
    property,
  };
}

export function createPayloadObject(property, keys = [], required = []) {
  if (!keys.length) {
    return undefined;
  }

  const schema = {
    type: 'object',
    properties: {},
  };

  keys.forEach((key) => {
    if (key in property) {
      schema.properties[key] = property[key];
    }
  });

  if (required.length) {
    schema.required = required;
  }

  return schema;
}

export function createExampleFromKeys(exampleSource, keys = [], format = 'object') {
  if (!exampleSource || !keys.length) {
    return undefined;
  }

  const exampleObject = keys.reduce((acc, key) => {
    if (key in exampleSource) {
      acc[key] = exampleSource[key];
    }
    return acc;
  }, {});

  if (!Object.keys(exampleObject).length) {
    return undefined;
  }

  if (isFunction(format)) {
    return format(exampleObject);
  }

  if (format === 'array') {
    return [exampleObject];
  }

  if (format === 'string') {
    return Object.values(exampleObject).join(', ');
  }

  return exampleObject;
}

export function getBaseSuccessResponse() {
  return {
    description: 'Success response',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['success'] },
            data: { nullable: true },
            filters: { type: 'array', nullable: true },
            pagination: { type: 'object', nullable: true, additionalProperties: true },
            sort: { type: 'array', nullable: true },
          },
          example: {
            status: 'success',
          },
        },
      },
    },
  };
}

export function getBaseErrorResponse(code) {
  let description = 'Error response';

  const example = {
    status: 'error',
    message: 'Error details',
  };

  if (code === 400) {
    description = 'Validation error response';
    example.message = 'Validation error';
    example.data = 'VALIDATION_ERROR';
    example.validation = [];
  } else if (code === 401) {
    description = 'Authentication error response';
    example.message = 'Authentication error';
    example.data = 'AUTHENTICATION_ERROR';
  } else if (code === 403) {
    description = 'Authorization error response';
    example.message = 'Authorization error';
    example.data = 'AUTHORIZATION_ERROR';
  } else if (code === 429) {
    description = 'Rate limit error response';
    example.message = 'Rate limit error';
    example.data = 'RATE_LIMIT_ERROR';
  } else if (code === 500) {
    description = 'Server error response';
    example.message = 'Server error';
    example.data = 'SERVER_ERROR';
  } else if (code === 503) {
    description = 'Service unavailable response';
    example.message = 'Service unavailable';
    example.data = 'SERVICE_UNAVAILABLE_ERROR';
  }

  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['error'] },
            message: { type: 'string', nullable: true },
            data: { nullable: true },
            validation: { type: 'array', nullable: true },
          },
          example,
        },
      },
    },
  };
}

export function createSchema(...schemaNames) {
  // INIT
  const schema = {};
  const responses = {};

  // LOAD SCHEMA FILES
  const {
    property,
    example,
    exampleMap,
  } = loadSchemaFiles(schemaNames);

  // PAYLOAD
  function cookies(keys = [], required = []) {
    const s = createPayloadObject(property, keys, required);
    if (s) schema.cookies = s;
    return api;
  }

  function body(keys = [], required = []) {
    const s = createPayloadObject(property, keys, required);
    if (s) schema.body = s;
    return api;
  }

  function params(keys = [], required = []) {
    const s = createPayloadObject(property, keys, required);
    if (s) schema.params = s;
    return api;
  }

  function query(keys = [], required = []) {
    const s = createPayloadObject(property, keys, required);
    if (s) schema.querystring = s;
    return api;
  }

  // DEFAULT RESPONSES
  function defaultResponses({
    include = [200, 400, 401, 403, 429, 500, 503],
    exclude = [],
  } = {}) {
    const finalCodes = include.filter((c) => !exclude.includes(c));

    finalCodes.forEach((code) => {
      if (responses[code]) {
        return false;
      }

      if (code >= 200 && code < 300) {
        responses[code] = getBaseSuccessResponse();
      } else {
        responses[code] = getBaseErrorResponse(code);
      }
    });

    return api;
  }

  // RESPONSE
  function response(code = 200, options = {}) {
    const isSuccess = code >= 200 && code < 300;
    const responseObject = isSuccess
      ? getBaseSuccessResponse()
      : getBaseErrorResponse();

    // DESCRIPTION OVERRIDE
    if (options.description) {
      responseObject.description = options.description;
    }

    // PROPERTIES & EXAMPLES PATCH
    const schemaRef = responseObject.content['application/json'].schema;

    Object.keys(options).forEach((prop) => {
      if (!prop.includes('Example')) {
        schemaRef.properties[prop] = options[prop];
        return true;
      }

      if (prop.endsWith('ExampleKeysFormat')) {
        return false;
      }

      const propRealName = prop.replace(/Example(.+)?/, '');
      if (!isObject(schemaRef.properties[propRealName])) {
        return false;
      }

      if (!isObject(schemaRef.example)) {
        schemaRef.example = {
          status: isSuccess
            ? 'success'
            : 'error',
        };
      }

      if (prop.endsWith('Example')) {
        schemaRef.example[propRealName] = options[prop];
        return true;
      }

      if (!isArray(options[prop])) {
        return false;
      }

      const keysFormat = options[`${prop}Format`];
      const keys = options[prop][0] === '*' && isObject(exampleMap[propRealName])
        ? Object.keys(exampleMap[propRealName])
        : options[prop];
      if (!keys.length) {
        return false;
      }

      const exampleData = createExampleFromKeys(
        example,
        keys,
        keysFormat,
      );

      if (!exampleData) {
        return false;
      }

      schemaRef.example[propRealName] = exampleData;
    });

    responses[code] = responseObject;

    return api;
  }

  // META
  function meta(obj = {}) {
    Object.assign(schema, obj);
    return api;
  }

  // BUILD
  function build() {
    if (Object.keys(responses).length) {
      schema.response = responses;
    }
    return schema;
  }

  const api = {
    cookies,
    body,
    params,
    query,
    defaultResponses,
    response,
    meta,
    build,
  };

  return api;
}
