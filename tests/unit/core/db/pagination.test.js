import { PAGINATION } from '#config/pagination.js';
import { buildPagination, readPage } from '#core/db/pagination.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const LIMIT_REFUSAL = /readPage\(payload\) requires limit to be an integer from 1 to 100: give the route the query fields of #schemas\/common\/pagination\.js/;
const OFFSET_REFUSAL = /readPage\(payload\) requires offset to be an integer from 0 to 10000/;
const TOTAL_REFUSAL = /buildPagination\(\{ limit, offset, total \}\) requires total to be an integer that is not negative/;

const MANY_ROWS = 1_000_000;

describe('readPage', () => {
  test('reads the bounds this test is written for', () => {
    assert.deepEqual(PAGINATION, { defaultLimit: 20, maxLimit: 100, maxOffset: 10_000 });
  });

  test('gives the default limit and the first row without a limit and an offset', () => {
    assert.deepEqual(readPage(), { limit: 20, offset: 0 });
    assert.deepEqual(readPage({}), { limit: 20, offset: 0 });
    assert.deepEqual(readPage({ limit: 5 }), { limit: 5, offset: 0 });
    assert.deepEqual(readPage({ offset: 40 }), { limit: 20, offset: 40 });
  });

  test('takes every limit from 1 to maxLimit and every offset from 0 to maxOffset', () => {
    assert.deepEqual(readPage({ limit: 1, offset: 0 }), { limit: 1, offset: 0 });
    assert.deepEqual(readPage({ limit: 100, offset: 10_000 }), { limit: 100, offset: 10_000 });
  });

  test('reads limit and offset only: a total a client sends is ignored', () => {
    const payload = {
      limit: 10,
      offset: 20,
      total: 5,
      sort: 'newest',
    };

    assert.deepEqual(readPage(payload), { limit: 10, offset: 20 });
  });

  test('takes request.query as it is, an object without a prototype', () => {
    assert.deepEqual(readPage(Object.assign(Object.create(null), { limit: 3, offset: 6 })), { limit: 3, offset: 6 });
  });

  test('refuses a limit or an offset outside the bounds or not an integer: the query schema of the list keeps a client inside them', () => {
    [0, 101, 1.5, -1, '20', null, Number.NaN, Infinity, 2 ** 53].forEach((limit) => {
      assert.throws(() => readPage({ limit }), LIMIT_REFUSAL, String(limit));
    });
    [-1, 10_001, 0.5, '0', null, Number.NaN].forEach((offset) => {
      assert.throws(() => readPage({ offset }), OFFSET_REFUSAL, String(offset));
    });
  });

  test('requires a plain object', () => {
    [null, 'limit=1', [], new Map()].forEach((payload) => {
      assert.throws(() => readPage(payload), /readPage\(payload\) requires a plain object, such as request\.query/);
    });
  });
});

describe('buildPagination', () => {
  test('tells the page and whether another one follows', () => {
    assert.deepEqual(buildPagination({ limit: 20, offset: 0, total: 45 }), {
      total: 45,
      limit: 20,
      offset: 0,
      totalPages: 3,
      currentPage: 1,
      canLoadMore: true,
    });
    assert.deepEqual(buildPagination({ limit: 20, offset: 40, total: 45 }), {
      total: 45,
      limit: 20,
      offset: 40,
      totalPages: 3,
      currentPage: 3,
      canLoadMore: false,
    });
  });

  test('loads no more when the next page would start at the total, and counts no page for no rows', () => {
    assert.equal(buildPagination({ limit: 20, offset: 20, total: 40 }).canLoadMore, false);
    assert.deepEqual(buildPagination({ limit: 20, offset: 0, total: 0 }), {
      total: 0,
      limit: 20,
      offset: 0,
      totalPages: 0,
      currentPage: 1,
      canLoadMore: false,
    });
  });

  test('puts an offset between pages on the page it falls in', () => {
    const pagination = buildPagination({ limit: 20, offset: 30, total: 100 });

    assert.equal(pagination.currentPage, 2);
    assert.equal(pagination.canLoadMore, true);
  });

  test('counts only the pages a client can still ask for: the last has an offset readPage takes, the one after it has none', () => {
    [1, 7, 20, 30, 100].forEach((limit) => {
      const { totalPages } = buildPagination({ limit, offset: 0, total: MANY_ROWS });
      const lastOffset = (totalPages - 1) * limit;
      const last = buildPagination({ limit, offset: lastOffset, total: MANY_ROWS });
      const beforeLast = buildPagination({ limit, offset: lastOffset - limit, total: MANY_ROWS });

      assert.ok(totalPages < MANY_ROWS / limit, String(limit));
      assert.deepEqual(readPage({ limit, offset: lastOffset }), { limit, offset: lastOffset });
      assert.throws(() => readPage({ limit, offset: lastOffset + limit }), OFFSET_REFUSAL);
      assert.deepEqual([last.currentPage, last.canLoadMore], [totalPages, false], String(limit));
      assert.equal(beforeLast.canLoadMore, true, String(limit));
    });
  });

  test('counts every page while they all fit under maxOffset', () => {
    assert.equal(buildPagination({ limit: 100, offset: 0, total: 10_100 }).totalPages, 101);
    assert.equal(buildPagination({ limit: 100, offset: 0, total: 10_101 }).totalPages, 101);
    assert.equal(buildPagination({ limit: 100, offset: 0, total: 9_950 }).totalPages, 100);
  });

  test('refuses a total that is not an integer of zero or more', () => {
    [-1, 1.5, '10', null, undefined, Number.NaN, 10n].forEach((total) => {
      assert.throws(() => buildPagination({ limit: 20, offset: 0, total }), TOTAL_REFUSAL, String(total));
    });
  });

  test('refuses a limit and an offset that readPage would not give', () => {
    assert.throws(() => buildPagination({ limit: 0, offset: 0, total: 1 }), /buildPagination\(\{ limit, offset, total \}\) requires limit to be an integer from 1 to 100/);
    assert.throws(() => buildPagination({ limit: 20, offset: 10_001, total: 1 }), /requires offset to be an integer from 0 to 10000/);
    assert.throws(() => buildPagination({ total: 1 }), TypeError);
    assert.throws(() => buildPagination(), TypeError);
  });
});
