import { MEDIA_TYPE } from '#enums/media-type.js';
import { formatBytes } from '#utils/string.js';
import { isArray, isObject } from '#utils/type.js';

const OBJECT_TYPE = 'object';
const NULL_TEXT = 'null';

const DEFAULT_BODY = Object.freeze({ type: OBJECT_TYPE, properties: {}, additionalProperties: false });

const SIGNATURE = 'withFileFields(routeSchema, fileOptions, { isDocumented })';

const TYPE_SEPARATOR = ', ';

function describeFile(field) {
  const types = field.mime.join(TYPE_SEPARATOR);
  const size = formatBytes(field.maxSize);

  return field.max > 1
    ? `Up to ${field.max} files of ${types}, each of at most ${size}; the text ${NULL_TEXT} removes them`
    : `A file of ${types}, of at most ${size}; the text ${NULL_TEXT} removes it`;
}

// A string in its place would let a client name a file of somebody else: JSON only removes.
function toJsonField(field) {
  return {
    type: 'null',
    description: `${NULL_TEXT} removes the ${field.max > 1 ? 'files' : 'file'}; a file itself is sent as ${MEDIA_TYPE.FORM_DATA}`,
  };
}

// Only the text "null", which the parser turns into null, passes: under coercion type "null" would take "" too.
function toFormField() {
  return { const: null };
}

// What Swagger UI shows a file picker for.
function toDocumentedField(field) {
  const file = { type: 'string', format: 'binary' };

  return field.max > 1
    ? {
      type: 'array',
      items: file,
      maxItems: field.max,
      description: describeFile(field),
    }
    : { ...file, description: describeFile(field) };
}

function readBody(routeSchema) {
  const body = routeSchema.body === undefined
    ? DEFAULT_BODY
    : routeSchema.body;

  if (isObject(body?.content)) {
    throw new TypeError('"body" of a route with "files" is the schema of its fields, not the content form: the JSON and the form of it are written from "files"');
  }

  if (!isObject(body) || body.type !== OBJECT_TYPE || !isObject(body.properties)) {
    throw new TypeError('"body" of a route with "files" requires an object schema with "properties", which the file fields join');
  }

  return body;
}

function assertOwnNames(body, fields) {
  const named = [...Object.keys(body.properties), ...(isArray(body.required) ? body.required : [])];
  const taken = fields.find((field) => named.includes(field.name));

  if (taken !== undefined) {
    throw new TypeError(`"body" names "${taken.name}", a field of "files": a file field is described by "files" alone`);
  }
}

function addFields(body, fields, toField) {
  return {
    ...body,
    properties: {
      ...body.properties,
      ...Object.fromEntries(fields.map((field) => [field.name, toField(field)])),
    },
  };
}

// The body of the route, the default one included, in both forms a client may send it in: the files ride in the form
// alone. The documented form names each file as binary; the validated one takes only null in its place.
export function withFileFields(routeSchema, fileOptions, { isDocumented = false } = {}) {
  if (!isObject(routeSchema) || !isObject(fileOptions?.fields)) {
    throw new TypeError(`${SIGNATURE} requires the schema object of a route and the result of readFileOptions()`);
  }

  const body = readBody(routeSchema);
  const fields = Object.values(fileOptions.fields);

  assertOwnNames(body, fields);

  return {
    ...routeSchema,
    body: {
      content: {
        [MEDIA_TYPE.JSON]: { schema: addFields(body, fields, toJsonField) },
        [MEDIA_TYPE.FORM_DATA]: {
          schema: addFields(body, fields, isDocumented
            ? toDocumentedField
            : toFormField),
        },
      },
    },
  };
}
