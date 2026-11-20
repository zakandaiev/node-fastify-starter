import { freezeDeep } from '#utils/object.js';
import {
  formatSchemaPointer,
  isNumericSchema,
  mapSchema,
  readSchemaTypes,
} from '#utils/schema.js';
import Ajv from 'ajv';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function keepSchema(schema) {
  return schema;
}

function listVisits(schema) {
  const pointers = [];

  mapSchema(schema, (subschema, path) => {
    pointers.push(formatSchemaPointer(path));

    return subschema;
  });

  return pointers;
}

function markPath(schema, path) {
  return { ...schema, at: formatSchemaPointer(path) };
}

function createInteger() {
  return { type: 'integer' };
}

function createPart(name = 'limit') {
  return { type: 'object', properties: { [name]: createInteger() } };
}

function createKeywordSchema() {
  return {
    additionalItems: createInteger(),
    additionalProperties: createInteger(),
    allOf: [createInteger()],
    anyOf: [createInteger()],
    contains: createInteger(),
    else: createInteger(),
    if: createInteger(),
    items: createInteger(),
    not: createInteger(),
    oneOf: [createInteger()],
    propertyNames: { type: 'string', maxLength: 10 },
    then: createInteger(),
  };
}

function createRichSchema() {
  return {
    type: 'object',
    properties: {
      owner: { type: 'object', properties: { id: createInteger() } },
      tags: { type: 'array', items: { type: 'string' } },
    },
    allOf: [{ required: ['owner'] }],
    definitions: { count: createInteger() },
  };
}

describe('mapSchema', () => {
  test('visits every subschema bottom up, each with its path, and the root last', () => {
    const schema = { type: 'array', items: { type: 'object', properties: { owner: createPart('id') } } };

    assert.deepEqual(listVisits(schema), ['#/items/properties/owner/properties/id', '#/items/properties/owner', '#/items', '#']);
    assert.deepEqual(listVisits(createRichSchema()).sort(), [
      '#',
      '#/allOf/0',
      '#/definitions/count',
      '#/properties/owner',
      '#/properties/owner/properties/id',
      '#/properties/tags',
      '#/properties/tags/items',
    ]);
  });

  test('hands the visitor a copy whose subschemas are already replaced', () => {
    const seen = [];

    mapSchema({ type: 'object', properties: { id: createInteger() } }, (subschema, path) => {
      seen.push(structuredClone(subschema));

      return markPath(subschema, path);
    });

    assert.deepEqual(seen, [
      { type: 'integer' },
      { type: 'object', properties: { id: { type: 'integer', at: '#/properties/id' } } },
    ]);
  });

  test('puts what the visitor returns in the place of the subschema', () => {
    const mapped = mapSchema(
      { type: 'object', properties: { id: createInteger(), name: { type: 'string' } } },
      (subschema) => (subschema.type === 'integer' ? true : subschema),
    );

    assert.deepEqual(mapped, { type: 'object', properties: { id: true, name: { type: 'string' } } });
  });

  test('walks every keyword that holds a subschema, propertyNames included', () => {
    assert.deepEqual(listVisits(createKeywordSchema()).sort(), [
      '#',
      '#/additionalItems',
      '#/additionalProperties',
      '#/allOf/0',
      '#/anyOf/0',
      '#/contains',
      '#/else',
      '#/if',
      '#/items',
      '#/not',
      '#/oneOf/0',
      '#/propertyNames',
      '#/then',
    ]);
  });

  test('walks the tuple form of items and a list of branches item by item, with the index in the path', () => {
    const schema = {
      type: 'array',
      items: [{ type: 'string' }, createInteger()],
      allOf: [{ minItems: 1 }, { maxItems: 3 }],
    };

    assert.deepEqual(listVisits(schema).sort(), ['#', '#/allOf/0', '#/allOf/1', '#/items/0', '#/items/1']);
  });

  test('walks the maps of subschemas: properties, patternProperties, dependencies, definitions and $defs', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      patternProperties: { '^price_': { type: 'number' } },
      dependencies: { name: { required: ['surname'] } },
      definitions: { count: createInteger() },
      $defs: { label: { type: 'string' } },
    };

    assert.deepEqual(listVisits(schema).sort(), [
      '#',
      '#/$defs/label',
      '#/definitions/count',
      '#/dependencies/name',
      '#/patternProperties/^price_',
      '#/properties/name',
    ]);
  });

  test('takes a key of a map for a name, even one spelled like a keyword', () => {
    const schema = {
      type: 'object',
      properties: {
        items: createInteger(),
        not: { type: 'string' },
        properties: createInteger(),
      },
      definitions: { if: createInteger() },
    };

    assert.deepEqual(listVisits(schema).sort(), [
      '#',
      '#/definitions/if',
      '#/properties/items',
      '#/properties/not',
      '#/properties/properties',
    ]);
  });

  test('walks the schema form of dependencies and keeps a list of names as it is', () => {
    const schema = {
      type: 'object',
      dependencies: {
        card: ['cvv', 'expiry'],
        amount: { type: 'object', properties: { fee: { type: 'number' } } },
      },
    };

    assert.deepEqual(listVisits(schema), ['#/dependencies/amount/properties/fee', '#/dependencies/amount', '#']);
    assert.deepEqual(mapSchema(schema, keepSchema), schema);
  });

  test('does not walk the values of enum, const, default and examples', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { enum: [{ type: 'integer' }, 'auto'] },
        fixed: { const: { type: 'number', not: {} } },
      },
      default: { type: 'integer' },
      examples: [{ type: 'number' }],
    };
    const mapped = mapSchema(schema, keepSchema);

    assert.deepEqual(listVisits(schema).sort(), ['#', '#/properties/fixed', '#/properties/mode']);
    assert.equal(mapped.properties.mode.enum, schema.properties.mode.enum);
    assert.equal(mapped.properties.fixed.const, schema.properties.fixed.const);
    assert.equal(mapped.default, schema.default);
    assert.equal(mapped.examples, schema.examples);
  });

  test('does not follow a $ref', () => {
    const schema = {
      type: 'object',
      properties: { owner: { $ref: '#/definitions/user' } },
      definitions: { user: createPart('id') },
    };

    assert.deepEqual(listVisits(schema).sort(), ['#', '#/definitions/user', '#/definitions/user/properties/id', '#/properties/owner']);
  });

  test('keeps a boolean in the place of a subschema and does not visit it', () => {
    const schema = {
      type: 'object',
      properties: { any: true, none: false },
      additionalProperties: false,
      items: true,
    };

    assert.deepEqual(listVisits(schema), ['#']);
    assert.deepEqual(mapSchema(schema, keepSchema), schema);
  });

  test('leaves a map keyword alone when its value is not a plain object', () => {
    const list = [createInteger()];
    const schema = { properties: list, patternProperties: null };
    const mapped = mapSchema(schema, keepSchema);

    assert.deepEqual(listVisits(schema), ['#']);
    assert.equal(mapped.properties, list);
    assert.equal(mapped.patternProperties, null);
  });

  test('returns what is not a schema object as it is, without a visit', () => {
    const visits = [];

    ['text', '', true, false, null, undefined, 5].forEach((value) => {
      assert.equal(mapSchema(value, (subschema) => visits.push(subschema)), value);
    });
    assert.deepEqual(visits, []);
  });

  test('returns a new object at every level it walks, also when the visitor returns what it got', () => {
    const schema = createRichSchema();
    const mapped = mapSchema(schema, keepSchema);

    assert.deepEqual(mapped, schema);
    assert.notEqual(mapped, schema);
    assert.notEqual(mapped.properties, schema.properties);
    assert.notEqual(mapped.properties.owner, schema.properties.owner);
    assert.notEqual(mapped.allOf, schema.allOf);
    assert.notEqual(mapped.definitions, schema.definitions);
  });

  test('never writes to its input: a deep-frozen schema gives a copy that can be written to', () => {
    const frozen = freezeDeep(createRichSchema());
    const mapped = mapSchema(frozen, markPath);

    assert.deepEqual(frozen, createRichSchema());
    assert.equal(Object.isFrozen(mapped), false);
    assert.deepEqual(mapped, {
      type: 'object',
      properties: {
        owner: { type: 'object', properties: { id: { type: 'integer', at: '#/properties/owner/properties/id' } }, at: '#/properties/owner' },
        tags: { type: 'array', items: { type: 'string', at: '#/properties/tags/items' }, at: '#/properties/tags' },
      },
      allOf: [{ required: ['owner'], at: '#/allOf/0' }],
      definitions: { count: { type: 'integer', at: '#/definitions/count' } },
      at: '#',
    });
  });

  test('requires a function for the visitor', () => {
    [undefined, null, 'visit', {}].forEach((visit) => {
      assert.throws(() => mapSchema({ type: 'string' }, visit), { name: 'TypeError', message: /requires a function/ });
    });
  });
});

describe('formatSchemaPointer', () => {
  test('writes the root as "#"', () => {
    assert.equal(formatSchemaPointer([]), '#');
  });

  test('joins the path as AJV writes a schemaPath', () => {
    assert.equal(formatSchemaPointer(['properties', 'email']), '#/properties/email');
    assert.equal(formatSchemaPointer(['allOf', '0', 'then']), '#/allOf/0/then');
  });

  test('escapes "~" and "/" in a name, "~" first', () => {
    assert.equal(formatSchemaPointer(['properties', 'a/b']), '#/properties/a~1b');
    assert.equal(formatSchemaPointer(['properties', 'a~b']), '#/properties/a~0b');
    assert.equal(formatSchemaPointer(['properties', '~1']), '#/properties/~01');
    assert.equal(formatSchemaPointer(['patternProperties', '^a/b~$']), '#/patternProperties/^a~1b~0$');
  });

  test('gives the pointer AJV gives in schemaPath for the same subschema', () => {
    const name = 'a/b~c';
    const validate = new Ajv({ allErrors: true }).compile({ type: 'object', properties: { [name]: createInteger() } });

    validate({ [name]: 'text' });

    assert.equal(validate.errors[0].schemaPath, `${formatSchemaPointer(['properties', name])}/type`);
  });
});

describe('readSchemaTypes', () => {
  test('returns the types of a schema as a list, whichever way it names them', () => {
    assert.deepEqual(readSchemaTypes({ type: 'integer' }), ['integer']);
    assert.deepEqual(readSchemaTypes({ type: ['integer', 'null'] }), ['integer', 'null']);
    assert.deepEqual(readSchemaTypes({ properties: {} }), []);
    assert.deepEqual(readSchemaTypes({ type: null }), []);
  });

  test('does not hand out the list of the schema itself', () => {
    const schema = Object.freeze({ type: Object.freeze(['integer', 'null']) });

    assert.notEqual(readSchemaTypes(schema), schema.type);
  });

  test('requires a schema object', () => {
    [undefined, null, true, 'integer', [{ type: 'integer' }]].forEach((schema) => {
      assert.throws(() => readSchemaTypes(schema), { name: 'TypeError', message: /requires a schema object/ });
    });
  });
});

describe('isNumericSchema', () => {
  test('says whether a schema takes a number or an integer, among other types too', () => {
    [{ type: 'number' }, { type: 'integer' }, { type: ['integer', 'null'] }, { type: ['string', 'number'] }].forEach((schema) => {
      assert.equal(isNumericSchema(schema), true, JSON.stringify(schema));
    });
    [{ type: 'string' }, { type: ['string', 'null'] }, { minimum: 0 }, {}].forEach((schema) => {
      assert.equal(isNumericSchema(schema), false, JSON.stringify(schema));
    });
  });

  test('requires a schema object', () => {
    assert.throws(() => isNumericSchema(null), { name: 'TypeError', message: /requires a schema object/ });
  });
});
