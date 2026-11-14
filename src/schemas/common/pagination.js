import { freezeDeep } from '#utils/object.js';

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
