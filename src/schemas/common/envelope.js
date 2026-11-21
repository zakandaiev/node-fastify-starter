import { ERROR_CODE } from '#enums/error-code.js';
import { RESPONSE_STATUS } from '#enums/response-status.js';
import { pagination } from '#schemas/common/pagination.js';
import { PRIMITIVE_TYPES, primitiveOrList, validation } from '#schemas/common/validation.js';
import { freezeDeep } from '#utils/object.js';

const meta = freezeDeep({
  type: 'object',
  properties: {
    requestId: { type: 'string' },
    stack: { type: 'string' },
  },
});

const sort = freezeDeep({
  type: 'array',
  items: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      value: { type: 'string' },
      isChecked: { type: 'boolean' },
      isDefault: { type: 'boolean' },
    },
  },
});

const filters = freezeDeep({
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      name: { type: 'string' },
      label: { type: 'string' },
      operator: { type: 'string' },
      isMultiple: { type: 'boolean' },
      isDisabled: { type: 'boolean' },
      value: primitiveOrList,
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: PRIMITIVE_TYPES },
            isChecked: { type: 'boolean' },
            isDisabled: { type: 'boolean' },
          },
        },
      },
    },
  },
});

// No "required" in any envelope: the serializer throws on a missing required field,
// and a handler that succeeded would answer 500.
export function successEnvelope(data) {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [RESPONSE_STATUS.SUCCESS] },
      message: { type: 'string' },
      data,
      meta,
    },
  };
}

export function listEnvelope(item) {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [RESPONSE_STATUS.SUCCESS] },
      message: { type: 'string' },
      data: { type: 'array', items: item },
      pagination,
      sort,
      filters,
      meta,
    },
  };
}

export const errorEnvelope = freezeDeep({
  type: 'object',
  properties: {
    status: { type: 'string', enum: [RESPONSE_STATUS.ERROR] },
    code: { type: 'string', enum: Object.values(ERROR_CODE) },
    message: { type: 'string' },
    validation,
    meta,
  },
});
