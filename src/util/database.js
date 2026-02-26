import { fastify } from '#core/server.js';
import { convertStringToSeconds } from '#src/util/datetime.js';
import {
  isFunction,
  isNumber,
  isObject,
  isString,
  toNumber,
  toString,
} from '#src/util/misc.js';
import {
  createSqlContext,
  cutSelectionPartFromSqlTokens,
  getSubstitutedSql,
  normalizeOrderBy,
} from '#src/util/sql.js';
import { createHash } from 'node:crypto';

async function getConnection() {
  if (!isFunction(fastify.mysql?.getConnection)) {
    return null;
  }
  const connection = await fastify.mysql.getConnection();
  return connection;
}

async function isTableExists(table) {
  if (!table) {
    return false;
  }

  const sql = 'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = :table';
  const binding = { table };

  const query = createQuery(sql, binding);
  await query.execute();

  return !!query.fetchColumn();
}

function createCache({
  key,
  ttl,
  tables = [],
} = {}) {
  const envTtl = process.env.APP_DATABASE_CACHE_TTL || '1h';
  const rawTtl = ttl ?? envTtl;

  const safeTtl = isNumber(rawTtl)
    ? rawTtl
    : convertStringToSeconds(envTtl);

  return {
    key,
    ttl: safeTtl,
    tables,
  };
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
  function cache(payload = {}) {
    cacheData = createCache(payload);
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
  async function execute(skipCache = false) {
    if (cacheData && skipCache !== true) {
      await runCacheExtract();
      return api;
    }

    normalizeBindValues();
    await runQuery();
    await updateCacheTableVersions();
    await updatePaginationTotal();

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
      } else if (value === null || value === undefined) {
        binding[key] = null;
      } else {
        binding[key] = toString(value);
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

      fastify.log.info({
        substitutedSql: getSubstitutedSql(sql, binding),
        sql,
        binding,
        resultTime: endTime - startTime,
      }, 'database query');

      result = rows;
    } catch (error) {
      throw new Error(error.message);
    } finally {
      if (isFunction(connection.release)) {
        await connection.release();
      }
    }

    return true;
  }

  async function runCacheExtract() {
    if (!isSelect || !cacheData || !cacheData.ttl || !fastify.isRedisReady) {
      await execute(true);
      return false;
    }

    if (!cacheData.key) {
      const tables = cacheData.tables || [];
      const tablePromises = tables.map((table) => fastify.redis.get(`table_version:${table}`));
      const tableRawList = await Promise.all(tablePromises);
      const tableVersions = tableRawList.map((version, index) => `${tables[index]}:${version ?? 0}`);

      const hash = createHash('sha256')
        .update(JSON.stringify({
          sql,
          binding,
          filterData,
          paginationData,
          sortData,
          tableVersions,
        }))
        .digest('hex');

      cacheData.key = `db_query:${hash}`;
    }

    const dataFromCacheRaw = await fastify.redis.get(cacheData.key);
    if (dataFromCacheRaw) {
      const dataFromCache = JSON.parse(dataFromCacheRaw) || {};
      cacheData = dataFromCache.cacheData;
      filterData = dataFromCache.filterData;
      paginationData = dataFromCache.paginationData;
      sortData = dataFromCache.sortData;
      result = dataFromCache.result;
      isResultFetched = true;
      return true;
    }

    await execute(true);

    const dataToCache = {
      cacheData,
      filterData,
      paginationData,
      sortData,
      result,
    };

    await fastify.redis.set(
      cacheData.key,
      JSON.stringify(dataToCache),
      'EX',
      cacheData.ttl,
    );
  }

  async function updateCacheTableVersions() {
    if (isSelect || !cacheData || !fastify.isRedisReady) {
      return false;
    }

    const tables = cacheData.tables || [];
    if (!tables.length) {
      return false;
    }

    const updatePromises = tables.map((table) => fastify.redis.set(`table_version:${table}`, Date.now()));
    await Promise.all(updatePromises);

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
      const values = isObject(row) ? Object.values(row) : {};
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
  createCache,
  createPagination,
  createQuery,
  createSort,
  getConnection,
  isTableExists,
};
