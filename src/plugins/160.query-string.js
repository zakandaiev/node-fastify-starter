import { getPath } from '#utils/object.js';
import { isNumericSchema } from '#utils/schema.js';
import { isArray, isBlankString, isObject } from '#utils/type.js';
import fp from 'fastify-plugin';

const EMPTY_VALUE = '';
const QUERY_FIELDS_PATH = Object.freeze(['querystring', 'properties']);

function isEmptyValue(value) {
  return value === EMPTY_VALUE;
}

function takesNumbers(field) {
  return isObject(field)
    && (isNumericSchema(field) || (isObject(field.items) && isNumericSchema(field.items)));
}

function dropEmptyItems(query, key, isEmpty) {
  const items = query[key];
  const filled = items.filter((item) => !isEmpty(item));

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

function dropEmptyValue(query, key, isEmpty) {
  if (isArray(query[key])) {
    return dropEmptyItems(query, key, isEmpty);
  }

  if (!isEmpty(query[key])) {
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
      // AJV coerces a string of white space to 0 for a number or an integer; isBlankString() trims the same
      // characters ToNumber skips, a no-break space and a line break included.
      const isEmpty = takesNumbers(getPath(fields, [key]))
        ? isBlankString
        : isEmptyValue;

      dropEmptyValue(request.query, key, isEmpty);
    });
  }

  done();
}

async function useQueryString(fastify) {
  fastify.addHook('preValidation', dropEmptyQueryValues);
}

export default fp(useQueryString, { name: 'query-string' });
