import { createUploadConfig } from '#config/upload.js';
import { IMAGE_INPUT_TYPES } from '#core/image/profile.js';
import { withFileFields } from '#core/schema/files.js';
import { buildValidator } from '#core/schema/validator.js';
import { readFileOptions } from '#core/upload/options.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { successEnvelope } from '#schemas/common/envelope.js';
import { freezeDeep } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const UPLOAD = createUploadConfig();

const JSON_TYPE = 'application/json';
const FORM_TYPE = 'multipart/form-data';
const PDF = 'application/pdf';

const OPTIONS = readFileOptions({
  fields: {
    avatar: { maxSize: '5MB', mime: IMAGE_INPUT_TYPES, image: IMAGE_PROFILE.AVATAR },
    scans: { max: 3, maxSize: '1MB', mime: [PDF] },
  },
}, UPLOAD);

const NAME = Object.freeze({ type: 'string', maxLength: 20 });

const BODY = freezeDeep({
  type: 'object',
  properties: { name: NAME },
  required: ['name'],
  additionalProperties: false,
  examples: [{ name: 'Anna' }],
});

const RESPONSE = freezeDeep({ 200: successEnvelope({ type: 'object', properties: { id: { type: 'integer' } } }) });
const ROUTE_SCHEMA = freezeDeep({ body: BODY, response: RESPONSE, summary: 'Update an item' });

const AVATAR_JSON = Object.freeze({ type: 'null', description: 'null removes the file; a file itself is sent as multipart/form-data' });
const SCANS_JSON = Object.freeze({ type: 'null', description: 'null removes the files; a file itself is sent as multipart/form-data' });
const IN_FORM = Object.freeze({ const: null });

const AVATAR_DOCUMENTED = Object.freeze({
  type: 'string',
  format: 'binary',
  description: 'A file of image/jpeg, image/png, image/webp, of at most 5 MB; the text null removes it',
});
const SCANS_DOCUMENTED = Object.freeze({
  type: 'array',
  items: { type: 'string', format: 'binary' },
  maxItems: 3,
  description: 'Up to 3 files of application/pdf, each of at most 1 MB; the text null removes them',
});

const CONTENT_MESSAGE = '"body" of a route with "files" is the schema of its fields, not the content form: the JSON and the form of it are written from "files"';
const OBJECT_MESSAGE = '"body" of a route with "files" requires an object schema with "properties", which the file fields join';

function readMediaSchema(routeSchema, mediaType) {
  return routeSchema.body.content[mediaType].schema;
}

function withProperties(properties) {
  return { ...BODY, properties: { name: NAME, ...properties } };
}

function compileBody(routeSchema, mediaType) {
  return buildValidator()({ schema: readMediaSchema(routeSchema, mediaType), httpPart: 'body', contentType: mediaType });
}

function isValid(validate, body) {
  return validate(structuredClone(body));
}

describe('withFileFields', () => {
  test('gives the body in both forms a client sends it in, each with the fields of its author and a field of each file, and keeps the rest of the route schema', () => {
    const routeSchema = withFileFields(ROUTE_SCHEMA, OPTIONS);

    assert.deepEqual(Object.keys(routeSchema.body), ['content']);
    assert.deepEqual(Object.keys(routeSchema.body.content), [JSON_TYPE, FORM_TYPE]);
    assert.deepEqual(readMediaSchema(routeSchema, JSON_TYPE), withProperties({ avatar: AVATAR_JSON, scans: SCANS_JSON }));
    assert.deepEqual(readMediaSchema(routeSchema, FORM_TYPE), withProperties({ avatar: IN_FORM, scans: IN_FORM }));
    assert.equal(routeSchema.response, RESPONSE);
    assert.equal(routeSchema.summary, ROUTE_SCHEMA.summary);
    assert.equal(Object.isFrozen(routeSchema), false);
  });

  test('documents each file as binary, a field of several files as a list of at most max of them, for the file picker of Swagger UI', () => {
    const routeSchema = withFileFields(ROUTE_SCHEMA, OPTIONS, { isDocumented: true });

    assert.deepEqual(readMediaSchema(routeSchema, FORM_TYPE), withProperties({ avatar: AVATAR_DOCUMENTED, scans: SCANS_DOCUMENTED }));
    assert.deepEqual(readMediaSchema(routeSchema, JSON_TYPE), readMediaSchema(withFileFields(ROUTE_SCHEMA, OPTIONS), JSON_TYPE));
  });

  test('gives a route without a body one of the files alone, closed to any other field', () => {
    const routeSchema = withFileFields({ response: RESPONSE }, OPTIONS);
    const closed = { type: 'object', additionalProperties: false };

    assert.deepEqual(readMediaSchema(routeSchema, JSON_TYPE), { ...closed, properties: { avatar: AVATAR_JSON, scans: SCANS_JSON } });
    assert.deepEqual(readMediaSchema(routeSchema, FORM_TYPE), { ...closed, properties: { avatar: IN_FORM, scans: IN_FORM } });
    assert.deepEqual(withFileFields({}, OPTIONS).body, routeSchema.body);
  });

  test('changes nothing of what it was given', () => {
    const routeSchema = structuredClone(ROUTE_SCHEMA);

    withFileFields(routeSchema, OPTIONS);
    withFileFields(routeSchema, OPTIONS, { isDocumented: true });

    assert.deepEqual(routeSchema, ROUTE_SCHEMA);
  });

  test('takes in JSON only null in place of a file, never a string that could name a file of somebody else', () => {
    const validate = compileBody(withFileFields(ROUTE_SCHEMA, OPTIONS), JSON_TYPE);

    assert.equal(isValid(validate, { name: 'Anna', avatar: null, scans: null }), true);
    assert.equal(isValid(validate, { name: 'Anna' }), true);
    ['', 'null', 'other.webp', 0, false, {}, []].forEach((avatar) => {
      assert.equal(isValid(validate, { name: 'Anna', avatar }), false, JSON.stringify(avatar));
    });
  });

  test('takes in the form only the null the parser makes of the text "null": under the coercion of a form type "null" would take "" too', () => {
    const validate = compileBody(withFileFields(ROUTE_SCHEMA, OPTIONS), FORM_TYPE);

    assert.equal(isValid(validate, { name: 'Anna', avatar: null }), true);
    assert.equal(isValid(validate, { name: 'Anna' }), true);
    ['', 'null', '0', 'false', 'other.webp', [null, null]].forEach((avatar) => {
      assert.equal(isValid(validate, { name: 'Anna', avatar }), false, JSON.stringify(avatar));
    });
  });

  test('refuses a body already in the content form', () => {
    const body = { content: { [JSON_TYPE]: { schema: BODY } } };

    assert.throws(() => withFileFields({ body }, OPTIONS), { name: 'TypeError', message: CONTENT_MESSAGE });
  });

  test('refuses a body that is not an object schema with properties for the file fields to join', () => {
    [
      { $ref: 'item#' },
      { type: 'array', items: NAME },
      { type: 'object' },
      { type: ['object', 'null'], properties: { name: NAME } },
      { properties: { name: NAME } },
      null,
      'body',
    ].forEach((body) => {
      assert.throws(() => withFileFields({ body }, OPTIONS), { name: 'TypeError', message: OBJECT_MESSAGE }, JSON.stringify(body));
    });
  });

  test('refuses a body that names a file field itself, as a property or as a required field', () => {
    [withProperties({ avatar: { type: 'string', maxLength: 64 } }), { ...BODY, required: ['name', 'scans'] }].forEach((body) => {
      assert.throws(() => withFileFields({ body }, OPTIONS), {
        name: 'TypeError',
        message: /^"body" names "(avatar|scans)", a field of "files": a file field is described by "files" alone$/,
      });
    });
  });

  test('requires the schema object of a route and the options of readFileOptions()', () => {
    [[undefined, OPTIONS], [null, OPTIONS], [ROUTE_SCHEMA, undefined], [ROUTE_SCHEMA, {}], [ROUTE_SCHEMA, { fields: [] }]].forEach(([routeSchema, options]) => {
      assert.throws(() => withFileFields(routeSchema, options), {
        name: 'TypeError',
        message: 'withFileFields(routeSchema, fileOptions, { isDocumented }) requires the schema object of a route and the result of readFileOptions()',
      });
    });
  });
});
