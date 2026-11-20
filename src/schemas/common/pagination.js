import { PAGINATION } from '#config/pagination.js';
import { freezeDeep } from '#utils/object.js';

// The query fields of a list: the module is a source of createSchema() as an entity schema is.
export const properties = freezeDeep({
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: PAGINATION.maxLimit,
    default: PAGINATION.defaultLimit,
    description: 'How many rows to return',
  },
  offset: {
    type: 'integer',
    minimum: 0,
    maximum: PAGINATION.maxOffset,
    default: 0,
    description: 'How many rows to skip',
  },
});

export const example = freezeDeep({
  limit: PAGINATION.defaultLimit,
  offset: 0,
});

export const pagination = freezeDeep({
  type: 'object',
  properties: {
    total: { type: 'integer' },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
    totalPages: { type: 'integer' },
    currentPage: { type: 'integer' },
    canLoadMore: { type: 'boolean' },
  },
});
