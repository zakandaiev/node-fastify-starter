import { addFiniteGuards, useFiniteKeyword } from '#core/schema/finite.js';
import { gateExpensiveKeywords } from '#core/schema/gate.js';
import { BODY_PART } from '#core/schema/walk.js';
import { MEDIA_TYPE } from '#enums/media-type.js';
import { SCHEMA_FORMAT } from '#enums/schema-format.js';
import { SCHEMA_KEYWORD } from '#enums/schema-keyword.js';
import { isUtcDateTime } from '#utils/date.js';
import { toMimeEssence } from '#utils/mime.js';
import { isFunction, isObject } from '#utils/type.js';
import { isEmail } from '#utils/validate.js';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const TEXT_PARTS = Object.freeze(['querystring', 'params', 'headers']);

// A form sends every field as text, as a query string does.
const FORM_MEDIA_TYPES = Object.freeze([MEDIA_TYPE.FORM_DATA, MEDIA_TYPE.FORM_URLENCODED]);

// The options of the compiler of Fastify, with every error of a request instead of the first one:
// the error formatter caps the list.
const TEXT_AJV_OPTIONS = Object.freeze({
  coerceTypes: 'array',
  useDefaults: true,
  removeAdditional: true,
  addUsedSchema: false,
  allErrors: true,
});

// JSON brings its own types. Coerced, null would become "" and false, and a number would pass for a string
// and be compared to a text column as a number.
const JSON_AJV_OPTIONS = Object.freeze({ ...TEXT_AJV_OPTIONS, coerceTypes: false });

// The keywords and the formats every schema of the app may use: a route that brings a validator compiler
// of its own has to give them to its instance of AJV.
export function useSchemaKeywords(ajv) {
  if (!isFunction(ajv?.addKeyword) || !isFunction(ajv?.addFormat)) {
    throw new TypeError('useSchemaKeywords(ajv) requires an instance of AJV');
  }

  useFiniteKeyword(ajv);
  ajv.addKeyword({ keyword: SCHEMA_KEYWORD.JSON, schemaType: 'boolean' });

  // In place of the formats of ajv-formats: its "email" takes ASCII only.
  ajv.addFormat(SCHEMA_FORMAT.EMAIL, isEmail);
  ajv.addFormat(SCHEMA_FORMAT.DATE_TIME_UTC, isUtcDateTime);

  return ajv;
}

// The onRoute hook sees a route schema, not what its $ref points to, and a part that carries the $id of a shared
// schema is compiled as that shared schema: so the shared ones get the gate and the guard here. Without
// a length limit a shared schema is left ungated, not refused: it may serve a response only.
function prepareSharedSchema(schema) {
  return addFiniteGuards(gateExpensiveKeywords(schema, { isStrict: false }));
}

function createAjv(options, externalSchemas) {
  const ajv = new Ajv(options);

  addFormats(ajv);
  useSchemaKeywords(ajv);
  Object.values(externalSchemas).forEach((schema) => ajv.addSchema(prepareSharedSchema(schema)));

  return ajv;
}

function isTextPart(httpPart, contentType) {
  return httpPart === BODY_PART
    ? FORM_MEDIA_TYPES.includes(toMimeEssence(contentType))
    : TEXT_PARTS.includes(httpPart);
}

// The factory Fastify calls with the shared schemas (fastify.addSchema) of a scope.
export function buildValidator(externalSchemas = {}) {
  if (!isObject(externalSchemas)) {
    throw new TypeError('buildValidator(externalSchemas) requires the shared schemas of a scope as an object');
  }

  const jsonAjv = createAjv(JSON_AJV_OPTIONS, externalSchemas);
  const textAjv = createAjv(TEXT_AJV_OPTIONS, externalSchemas);

  function compileValidator({ schema, httpPart, contentType }) {
    const ajv = isTextPart(httpPart, contentType)
      ? textAjv
      : jsonAjv;

    // AJV refuses a second schema under an $id it has compiled, so the first one is reused, as Fastify does.
    const compiled = schema?.$id === undefined ? undefined : ajv.getSchema(schema.$id);

    return compiled ?? ajv.compile(schema);
  }

  return compileValidator;
}
