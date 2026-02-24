import { fastify } from '#core/server.js';
import {
  isArray,
  isFunction,
  isObject,
  isString,
  toNumber,
} from '#src/util/misc.js';
import {
  createSqlContext,
  cutSelectionPartFromSqlTokens,
  getSubstitutedSql,
  normalizeOrderBy,
} from '#src/util/sql.js';

async function getConnection() {
  if (!isFunction(fastify.mysql?.getConnection)) {
    return null;
  }
  const connection = await fastify.mysql.getConnection();
  return connection;
}

async function isTableExists(table) {
  const connection = await getConnection();
  if (!connection) {
    return false;
  }

  try {
    await connection.query(`SELECT 1 FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

function createPagination(
  {
    limit,
    offset = 0,
    total = 0,
  } = {},
  {
    maxLimit,
  } = {},
) {
  const envLimit = toNumber(process.env.APP_PAGINATION_LIMIT) ?? 10;
  const envMaxLimit = toNumber(process.env.APP_PAGINATION_MAX_LIMIT) ?? 100;
  const requestedLimit = toNumber(limit) ?? envLimit;

  const safeLimit = Math.min(requestedLimit, maxLimit ?? envMaxLimit);
  const safeOffset = Math.max(0, toNumber(offset) ?? 0);
  const safeTotal = Math.max(0, toNumber(total) ?? 0);

  const totalPages = safeTotal > 0
    ? Math.ceil(safeTotal / safeLimit)
    : 0;

  const currentPage = totalPages === 0
    ? 0
    : Math.min(Math.floor(safeOffset / safeLimit) + 1, totalPages);

  const canLoadMore = currentPage < totalPages;

  return {
    limit: safeLimit,
    offset: safeOffset,
    total: safeTotal,
    totalPages,
    currentPage,
    canLoadMore,
  };
}

function createSort({
  sort,
  sortAllowedColumns = [],
} = {}) {
  const normalized = normalizeOrderBy(sort, sortAllowedColumns);
  const safeSort = isString(normalized) && normalized.trim()
    ? normalized
    : null;

  return {
    sort: safeSort,
    sortAllowedColumns,
  };
}

function createQuery(initialSql = '', initialBinding = {}) {
  // INIT
  let sql = initialSql.trim();
  const binding = structuredClone(initialBinding);

  const sqlContext = createSqlContext(sql);
  const isSelect = /^SELECT/i.test(sql);

  let cacheData = null;
  let filterData = null;
  let paginationData = null;
  let sortData = null;

  let result = null;
  let isResultFetched = false;

  // MUTATIONS
  function cache() {
    if (!isSelect) {
      return api;
    }
    cacheData = 'TODO';
    return api;
  }

  function filter() {
    if (!isSelect) {
      return api;
    }

    filterData = 'TODO';

    return api;
  }

  function paginate(payload = {}) {
    if (!isSelect) {
      return api;
    }

    paginationData = createPagination(payload);

    sql = sqlContext
      .replacePagination('LIMIT :limit OFFSET :offset')
      .getSql();

    binding.limit = paginationData.limit;
    binding.offset = paginationData.offset;

    return api;
  }

  function sort(payload = {}) {
    if (!isSelect) {
      return api;
    }

    sortData = createSort(payload);
    if (!isString(sortData.sort) || !sortData.sort.length) {
      return api;
    }

    sql = sqlContext
      .replaceOrderBy(`ORDER BY ${sortData.sort}`)
      .getSql();

    return api;
  }

  // EXECUTE
  async function execute() {
    if (cacheData) {
      return api;
    }

    await updatePaginationTotal();
    normalizeBindValues();
    await runQuery();

    return api;
  }

  function normalizeBindValues() {
    if (!binding || !Object.keys(binding).length) {
      return false;
    }

    const matches = [...sql.matchAll(/:(\w+)/gmi)];
    const allowedKeys = Object.fromEntries(matches.map((m) => [m[1], true]));

    Object.keys(binding).forEach((key) => {
      const value = binding[key];

      if (key in allowedKeys === false) {
        delete binding[key];
      } else if (isArray(value) || isObject(value)) {
        binding[key] = JSON.stringify(value);
      } else if (value === undefined) {
        binding[key] = null;
      }
    });

    return true;
  }

  async function runQuery() {
    const connection = await getConnection();
    if (!connection) {
      throw new Error('Database connection error');
    }

    try {
      const startTime = performance.now();
      const [rows] = await connection.execute(sql, binding);
      const endTime = performance.now();

      connection.release();

      fastify.log.info({
        substitutedSql: getSubstitutedSql(sql, binding),
        sql,
        binding,
        resultTime: endTime - startTime,
      }, 'database query');

      result = rows;
    } catch (error) {
      throw new Error(error.message);
    }

    return true;
  }

  async function updatePaginationTotal() {
    if (!paginationData || paginationData.total) {
      return false;
    }

    let totalSql = cutSelectionPartFromSqlTokens(
      sqlContext.getSql(),
      sqlContext.getTokens(),
    );

    totalSql = `SELECT COUNT(*) as total FROM ${totalSql}`;

    totalSql = createSqlContext(totalSql)
      .replacePagination('')
      .getSql();

    const totalSqlQuery = createQuery(totalSql, binding);
    await totalSqlQuery.execute();

    paginationData.total = totalSqlQuery.fetchColumn();
    paginationData = createPagination(paginationData);

    return true;
  }

  // FETCH
  function fetch() {
    return handleFetch('fetch');
  }

  function fetchAll() {
    return handleFetch('fetchAll');
  }

  function fetchColumn(column) {
    return handleFetch('fetchColumn', column);
  }

  function affectedRows() {
    return handleFetch('affectedRows');
  }

  function insertId() {
    return handleFetch('insertId');
  }

  function handleFetch(type, data) {
    if (isResultFetched) {
      return result;
    }

    if (cacheData) {
      return 'TODO';
    }

    if (type === 'affectedRows') {
      result = result?.affectedRows ?? null;
    } else if (type === 'insertId') {
      result = result?.insertId ?? null;
    } else if (!Array.isArray(result)) {
      result = null;
    } else if (type === 'fetch') {
      result = result[0] ?? null;
    } else if (type === 'fetchColumn') {
      const row = result[0];
      const values = Object.values(row);
      result = values[data ?? 0] ?? null;
    }

    isResultFetched = true;

    return result;
  }

  // GETTERS
  function getFilters() {
    return filterData;
  }

  function getPagination() {
    return paginationData;
  }

  function getSort() {
    return sortData?.sort || null;
  }

  function getAll() {
    return {
      data: fetchAll(),
      filters: getFilters(),
      pagination: getPagination(),
      sort: getSort(),
    };
  }

  const api = {
    cache,
    filter,
    paginate,
    sort,
    execute,
    fetch,
    fetchAll,
    fetchColumn,
    affectedRows,
    insertId,
    getFilters,
    getPagination,
    getSort,
    getAll,
  };

  return api;
}

export {
  createPagination,
  createQuery,
  createSort,
  getConnection,
  isTableExists,
};
