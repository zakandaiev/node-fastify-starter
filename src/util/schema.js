import { absPath, resolvePath } from '#root/core/path.js';
import { isObject } from '#src/util/is-object.js';
import { getErrorSchema, getSuccessSchema } from '#src/util/response.js';
import { readFileSync } from 'node:fs';

function generateSchema(schemaName, options = {}) {
  const properties = generateSchemaProperties(schemaName);
  if (!properties) {
    return false;
  }

  const schema = {};

  const payload = generateSchemaPayloadFromProperties(properties, options);
  if (payload) {
    Object.assign(schema, payload);
  }

  const response = generateSchemaResponseFromProperties(properties, options);
  if (payload) {
    schema.response = response;
  }

  return {
    ...schema,
    ...options.overwrite || {},
  };
}

function generateSchemaProperties(schemaName) {
  const schemaNameList = Array.isArray(schemaName)
    ? [...schemaName]
    : [schemaName];

  if (!schemaNameList.length) {
    return false;
  }

  const properties = {};
  try {
    schemaNameList.forEach((sName) => {
      const sPath = resolvePath(absPath.schema, `${sName}.json`);
      const sText = readFileSync(sPath, 'utf8');
      const sProps = JSON.parse(sText);
      Object.keys(sProps).forEach((sProp) => {
        if (sProp.startsWith('#') && sProp in properties) {
          return Object.assign(properties[sProp], sProps[sProp]);
        }
        properties[sProp] = sProps[sProp];
      });
    });
  } catch {
    return false;
  }

  if (!Object.keys(properties).length) {
    return false;
  }

  return properties;
}

function generateSchemaPayloadFromProperties(properties, options = {}) {
  if (!isObject(properties)) {
    return false;
  }

  const payload = {};
  const payloadList = ['cookie', 'body', 'param', 'query'];

  payloadList.forEach((payloadKey) => {
    const payloadKeys = options[`${payloadKey}Keys`] || [];
    const payloadRequiredKeys = options[`${payloadKey}RequiredKeys`] || [];
    if (!payloadKeys.length) {
      return false;
    }

    const payloadSchema = {
      type: 'object',
      properties: {},
      required: [...payloadRequiredKeys],
    };
    payloadKeys.forEach((pKey) => {
      if (pKey in properties) {
        payloadSchema.properties[pKey] = structuredClone(properties[pKey]);
      }
    });

    if (payloadKey === 'cookie') {
      payload.cookies = payloadSchema;
    } else if (payloadKey === 'body') {
      payload.body = payloadSchema;
    } else if (payloadKey === 'param') {
      payload.params = payloadSchema;
    } else if (payloadKey === 'query') {
      payload.querystring = payloadSchema;
    }
  });

  return payload;
}

function generateSchemaResponseFromProperties(properties, options = {}) {
  if (!isObject(properties) || options.responseCodeKeys === false || options.responseCodeKeys === null) {
    return false;
  }

  const response = {};
  const responseList = Array.isArray(options.responseCodeKeys) && options.responseCodeKeys.length
    ? [...options.responseCodeKeys]
    : [200, 400, 401, 403, 500];

  responseList.forEach((responseKey) => {
    const responseDefaultBody = {};
    const responseGeneratorFunction = responseKey === 200
      ? getSuccessSchema
      : getErrorSchema;
    const responseOverwrite = 'responseCodeOverwrite' in options && responseKey in options.responseCodeOverwrite
      ? options.responseCodeOverwrite[responseKey]
      : {};
    const responseOverwriteFull = 'responseCodeOverwriteFull' in options && responseKey in options.responseCodeOverwriteFull
      ? options.responseCodeOverwriteFull[responseKey]
      : {};

    if (responseKey === 200) {
      const exampleProperties = properties['#example'];
      const dataExampleKeys = options.responseSuccessDataExample;
      const dataExampleFormat = options.responseSuccessDataExampleFormat || 'object';
      const isWildcard = Array.isArray(dataExampleKeys) && dataExampleKeys.length && dataExampleKeys[0] !== '*' ? false : true;

      /* eslint-disable no-nested-ternary */
      const dateExampleObject = exampleProperties && dataExampleKeys
        ? isWildcard
          ? structuredClone(exampleProperties)
          : Array.isArray(dataExampleKeys)
            ? dataExampleKeys.reduce((acc, key) => {
              acc[key] = exampleProperties[key];
              return acc;
            }, {})
            : null
        : null;

      let responseSuccessDataExample = dateExampleObject;
      if (typeof dataExampleFormat === 'function') {
        responseSuccessDataExample = dataExampleFormat(dateExampleObject);
      } else if (dataExampleFormat === 'array') {
        responseSuccessDataExample = [dateExampleObject];
      } else if (dataExampleFormat === 'string') {
        responseSuccessDataExample = Object.values(dateExampleObject || {}).join(', ');
      }

      if (responseSuccessDataExample) {
        responseDefaultBody.dataExample = responseSuccessDataExample;
      }
    } else if (responseKey === 400) {
      responseDefaultBody.properties = {
        validation: {
          type: ['array'],
          description: 'Validation data if needed',
          example: responseOverwrite.validationExample === undefined
            ? []
            : responseOverwrite.validationExample,
        },
      };
    } else if (responseKey === 401) {
      responseDefaultBody.description = 'Authentication error response';
      responseDefaultBody.messageExample = 'Authentication Error';
      responseDefaultBody.dataExample = 'AUTHENTICATION';
    } else if (responseKey === 403) {
      responseDefaultBody.description = 'Authorization error response';
      responseDefaultBody.messageExample = 'Authorization Error';
      responseDefaultBody.dataExample = 'AUTHORIZATION';
    } else if (responseKey === 500) {
      responseDefaultBody.description = 'Server error response';
      responseDefaultBody.messageExample = 'Server Error';
      responseDefaultBody.dataExample = 'SERVER';
    }

    response[responseKey] = responseGeneratorFunction(
      {
        ...responseDefaultBody,
        ...responseOverwrite,
      },
      responseOverwriteFull,
    );
  });

  return response;
}

export {
  generateSchema,
  generateSchemaPayloadFromProperties,
  generateSchemaProperties,
  generateSchemaResponseFromProperties,
};
