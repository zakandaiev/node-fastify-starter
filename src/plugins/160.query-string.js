import { getPath } from '#utils/object.js';
import { isBlankNumberText } from '#utils/schema.js';
import { isArray, isObject } from '#utils/type.js';
import fp from 'fastify-plugin';

const EMPTY_VALUE = '';
const QUERY_FIELDS_PATH = Object.freeze(['querystring', 'properties']);

function isEmptyValue(field, value) {
  return value === EMPTY_VALUE || isBlankNumberText(field, value);
}

function dropEmptyItems(query, key, field) {
  const items = query[key];
  const filled = items.filter((item) => !isEmptyValue(field, item));

  if (filled.length === items.length) {
    return false;
  }

  if (filled.length === 0) {
    delete query[key];
  } else {
    query[key] = filled;
  }

  return true;
}

function dropEmptyValue(query, key, field) {
  if (isArray(query[key])) {
    return dropEmptyItems(query, key, field);
  }

  if (!isEmptyValue(field, query[key])) {
    return false;
  }

  delete query[key];

  return true;
}

// "?status=" is a filter left unused, not a value to refuse with 422.
function dropEmptyQueryValues(request, reply, done) {
  if (isObject(request.query)) {
    const fields = getPath(request.routeOptions.schema, QUERY_FIELDS_PATH);

    Object.keys(request.query).forEach((key) => {
      dropEmptyValue(request.query, key, getPath(fields, [key]));
    });
  }

  done();
}

async function useQueryString(fastify) {
  fastify.addHook('preValidation', dropEmptyQueryValues);
}

export default fp(useQueryString, { name: 'query-string' });
