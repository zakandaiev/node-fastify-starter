import { freezeDeep } from '#utils/object.js';

export const PRIMITIVE_TYPES = Object.freeze(['string', 'number', 'boolean', 'null']);

// "array" goes first: the serializer tries the types in this order, and its test for a string
// accepts an array, which would go out joined with commas.
export const primitiveOrList = freezeDeep({
  type: ['array', ...PRIMITIVE_TYPES],
  items: { type: PRIMITIVE_TYPES },
});

// Describes what the error handler builds; the handler sends a string, so this schema documents the body
// and never serializes it.
export const validation = freezeDeep({
  type: 'array',
  items: {
    type: 'object',
    properties: {
      column: { type: ['string', 'null'] },
      columnValue: { type: PRIMITIVE_TYPES },
      operator: { type: ['string', 'null'] },
      operatorValue: primitiveOrList,
      schema: { type: 'object', additionalProperties: true },
    },
  },
});
