import { PAGINATION } from '#config/pagination.js';
import { isNonNegativeInteger, isNumberInRange, isObject } from '#utils/type.js';

const FIRST_PAGE = 1;

const LIMIT = Object.freeze({
  name: 'limit',
  min: 1,
  max: PAGINATION.maxLimit,
  fallback: PAGINATION.defaultLimit,
});
const OFFSET = Object.freeze({
  name: 'offset',
  min: 0,
  max: PAGINATION.maxOffset,
  fallback: 0,
});

function assertBound(value, bound, signature) {
  if (!Number.isSafeInteger(value) || !isNumberInRange(value, bound.min, bound.max)) {
    throw new TypeError(`${signature} requires ${bound.name} to be an integer from ${bound.min} to ${bound.max}: give the route the query fields of #schemas/common/pagination.js, which keep a client inside these bounds`);
  }

  return value;
}

function readBound(value, bound, signature) {
  return value === undefined
    ? bound.fallback
    : assertBound(value, bound, signature);
}

// Only limit and offset: the total is counted by the server, a client never gives it.
export function readPage(payload = {}) {
  const signature = 'readPage(payload)';

  if (!isObject(payload)) {
    throw new TypeError(`${signature} requires a plain object, such as request.query`);
  }

  return {
    limit: readBound(payload.limit, LIMIT, signature),
    offset: readBound(payload.offset, OFFSET, signature),
  };
}

// Pages past maxOffset are not counted: a client cannot ask for them.
export function buildPagination({ limit, offset, total } = {}) {
  const signature = 'buildPagination({ limit, offset, total })';

  assertBound(limit, LIMIT, signature);
  assertBound(offset, OFFSET, signature);

  if (!isNonNegativeInteger(total)) {
    throw new TypeError(`${signature} requires total to be an integer that is not negative`);
  }

  const nextOffset = offset + limit;

  return {
    total,
    limit,
    offset,
    totalPages: Math.min(Math.ceil(total / limit), Math.floor(PAGINATION.maxOffset / limit) + FIRST_PAGE),
    currentPage: Math.floor(offset / limit) + FIRST_PAGE,
    canLoadMore: nextOffset < total && nextOffset <= PAGINATION.maxOffset,
  };
}
