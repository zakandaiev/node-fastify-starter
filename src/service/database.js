import { fastify } from '#core/server.js';
import { loadSchemaFiles } from '#src/service/schema.js';
import { createSqlContext, cutSelectionPartFromSqlTokens, getSubstitutedSql } from '#src/service/sql.js';
import { convertStringToSeconds, toDate } from '#src/util/datetime.js';
import { hash } from '#src/util/hash.js';
import {
  isArray,
  isBoolean,
  isFunction,
  isNumber,
  isObject,
  isString,
  isStringBoolean,
  toNumber,
  toString,
} from '#src/util/misc.js';

export const DATABASE_CACHE_PREFIX = process.env.APP_DATABASE_CACHE_PREFIX || 'database:';
export const DATABASE_CACHE_TTL_SECONDS = convertStringToSeconds(process.env.APP_DATABASE_CACHE_TTL) || 60 * 60; // 1 hour

export async function getConnection() {
  if (!isFunction(fastify.mysql?.getConnection)) {
    return null;
  }

  const connection = await fastify.mysql.getConnection();
  return connection;
}

export async function isTableExists(table) {
  if (!table) {
    return false;
  }

  const sql = 'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = :table';
  const binding = { table };

  const query = createQuery(sql, binding);
  await query.execute();

  return !!query.fetchColumn();
}

export function createCache({
  key,
  ttl,
  tables = [],
} = {}) {
  const safeTtl = isNumber(ttl)
    ? ttl
    : DATABASE_CACHE_TTL_SECONDS;

  return {
    key,
    ttl: safeTtl,
    tables,
  };
}

export function parseOptionsPayloadValues(value) {
  const rawValueList = isArray(value)
    ? value
    : [value];

  const parsedValues = rawValueList
    .filter((item) => isString(item) || isNumber(item))
    .flatMap((item) => toString(item).split(','))
    .map((item) => item.trim())
    .filter((item) => item.length);

  return [...new Set(parsedValues)];
}

export function createFilter(schemaNames, payload = {}, runtimeOptions = {}) {
  const { filter: filterDefinition, property: filterProperty } = loadSchemaFiles(schemaNames);
  if (!isObject(filterDefinition) || !Object.keys(filterDefinition).length) {
    return {
      sql: '',
      binding: {},
      filters: [],
    };
  }

  const conditions = [];
  const binding = {};
  const filters = [];
  const filterDefinitionKeys = Object.keys(filterDefinition);
  const filterPayload = isObject(payload)
    ? payload
    : {};

  const allowedColumnOperators = ['=', '>', '>=', '<', '<=', 'range'];
  const defaultColumnOperator = '=';

  for (let i = 0; i < filterDefinitionKeys.length; i += 1) {
    const columnName = filterDefinitionKeys[i];
    const columnDefinition = filterDefinition[columnName];
    const columnProperty = filterProperty[columnName];
    const columnType = columnDefinition.type;
    const columnLabel = columnDefinition.label ?? columnProperty?.description ?? columnName;
    const columnValue = filterPayload[columnName];
    const columnBindingKey = `filter_${columnName}`;
    const columnOperator = allowedColumnOperators.includes(columnDefinition.operator)
      ? columnDefinition.operator
      : '=';

    const group = {
      name: columnName,
      type: columnType,
      label: columnLabel,
    };

    // TEXT
    if (columnType === 'text' && isString(columnValue) && columnValue.length) {
      if (columnDefinition.isExact) {
        conditions.push(`${columnName} = :${columnBindingKey}`);
        binding[columnBindingKey] = columnValue;
      } else {
        const escapedValue = columnValue.replace(/[\\%_]/g, '\\$&');
        conditions.push(`${columnName} LIKE :${columnBindingKey}`);
        binding[columnBindingKey] = `%${escapedValue}%`;
      }

      group.value = columnValue;
    }

    // BOOLEAN
    if (columnType === 'boolean' && (isBoolean(columnValue) || isStringBoolean(columnValue))) {
      const booleanValue = isBoolean(columnValue)
        ? columnValue
        : columnValue === 'true';

      conditions.push(`${columnName} = :${columnBindingKey}`);
      binding[columnBindingKey] = booleanValue ? 1 : 0;

      group.value = booleanValue;
    }

    // NUMBER
    if (columnType === 'number' && columnOperator === 'range' && isArray(columnValue) && columnValue.length === 2 && isNumber(columnValue[0]) && isNumber(columnValue[1])) {
      const [valueFrom, valueTo] = columnValue;

      conditions.push(`${columnName} BETWEEN :${columnBindingKey}_from AND :${columnBindingKey}_to`);
      binding[`${columnBindingKey}_from`] = valueFrom;
      binding[`${columnBindingKey}_to`] = valueTo;

      group.value = columnValue;
    } else if (columnType === 'number' && isNumber(columnValue)) {
      conditions.push(`${columnName} ${defaultColumnOperator} :${columnBindingKey}`);
      binding[columnBindingKey] = columnValue;

      group.value = columnValue;
    }

    // DATE OR DATETIME
    if (['date', 'datetime'].includes(columnType) && columnOperator === 'range' && isArray(columnValue) && columnValue.length === 2 && toDate(columnValue[0]) && toDate(columnValue[1])) {
      const [valueFrom, valueTo] = columnValue;

      conditions.push(`${columnName} BETWEEN :${columnBindingKey}_from AND :${columnBindingKey}_to`);
      binding[`${columnBindingKey}_from`] = columnType === 'date' ? `${valueFrom} 00:00:00` : valueFrom;
      binding[`${columnBindingKey}_to`] = columnType === 'date' ? `${valueTo} 23:59:59` : valueTo;

      group.value = columnValue;
    } else if (columnType === 'date' && isString(columnValue) && columnValue.length && toDate(columnValue)) {
      conditions.push(`${columnName} ${defaultColumnOperator} :${columnBindingKey}`);
      binding[columnBindingKey] = columnValue;

      group.value = columnValue;
    }

    // OPTIONS
    if (columnType === 'options') {
      const isMultiple = columnDefinition.isMultiple === true;

      const schemaOptions = isArray(columnDefinition.options)
        ? columnDefinition.options
        : [];
      const columnRuntimeOptions = isObject(runtimeOptions) && isArray(runtimeOptions[columnName])
        ? runtimeOptions[columnName]
        : null;
      const columnOptions = columnRuntimeOptions ?? schemaOptions;

      const normalizedOptions = [];
      const allowedValues = new Set();

      columnOptions.forEach((option) => {
        if (!isObject(option) || option.value === undefined || option.value === null) {
          return false;
        }

        const optionValue = toString(option.value);
        if (allowedValues.has(optionValue)) {
          return false;
        }

        allowedValues.add(optionValue);
        normalizedOptions.push({
          value: option.value,
          label: option.label ?? optionValue,
        });
      });

      let checkedValues = parseOptionsPayloadValues(columnValue)
        .filter((value) => allowedValues.has(value));

      if (!isMultiple && checkedValues.length > 1) {
        checkedValues = [checkedValues[0]];
      }

      if (checkedValues.length === 1) {
        const [checkedValue] = checkedValues;

        conditions.push(`${columnName} = :${columnBindingKey}`);
        binding[columnBindingKey] = checkedValue;
      } else if (checkedValues.length > 1) {
        const placeholders = checkedValues.map((value, index) => {
          const placeholderKey = `${columnBindingKey}_${index}`;
          binding[placeholderKey] = value;
          return `:${placeholderKey}`;
        });

        conditions.push(`${columnName} IN (${placeholders.join(', ')})`);
      }

      group.isMultiple = isMultiple;
      group.options = normalizedOptions.map((option) => ({
        value: option.value,
        label: option.label,
        isChecked: checkedValues.includes(toString(option.value)),
      }));
    }

    filters.push(group);
  }

  const sql = conditions.length
    ? conditions.join(' AND ')
    : null;

  return {
    sql,
    binding,
    filters,
  };
}

export function createPagination(
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

export function createSort(schemaNames, payload = {}) {
  const { sort: sortDefinition } = loadSchemaFiles(schemaNames);
  if (!isArray(sortDefinition) || !sortDefinition.length) {
    return {
      sql: null,
      sort: [],
    };
  }

  const allowedDirections = ['ASC', 'DESC'];
  const defaultDirection = 'ASC';

  const optionList = [];
  const allowedValues = new Set();

  sortDefinition.forEach((option) => {
    if (!isObject(option) || !isString(option.value) || !option.value.length || allowedValues.has(option.value)) {
      return false;
    }

    allowedValues.add(option.value);
    optionList.push({
      value: option.value,
      label: option.label ?? option.value,
      isDefaultChecked: option.isChecked === true,
    });
  });

  if (!optionList.length) {
    return {
      sql: null,
      sort: [],
    };
  }

  const sortPayload = isObject(payload)
    ? payload
    : {};

  let appliedValues = parseOptionsPayloadValues(sortPayload.sort)
    .filter((value) => allowedValues.has(value));

  if (!appliedValues.length) {
    appliedValues = optionList
      .filter((option) => option.isDefaultChecked)
      .map((option) => option.value);
  }

  const sort = optionList.map((option) => {
    const appliedOrder = appliedValues.indexOf(option.value);

    const responseOption = {
      value: option.value,
      label: option.label,
      isChecked: appliedOrder !== -1,
    };

    if (appliedOrder !== -1) {
      responseOption.order = appliedOrder + 1;
    }

    return responseOption;
  });

  const orderByParts = [];
  const orderByColumns = new Set();

  appliedValues.forEach((value) => {
    const [column, directionRaw = ''] = value.split(':');
    if (orderByColumns.has(column)) {
      return false;
    }

    const directionUpper = directionRaw.toUpperCase();
    const direction = allowedDirections.includes(directionUpper)
      ? directionUpper
      : defaultDirection;

    orderByColumns.add(column);
    orderByParts.push(`${column} ${direction}`);
  });

  const sql = orderByParts.length
    ? orderByParts.join(', ')
    : null;

  return {
    sql,
    sort,
  };
}

export function createQuery(initialSql = '', initialBinding = {}) {
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

  function filter(schemaNames, payload = {}, runtimeOptions = {}) {
    if (!isSelect) {
      return api;
    }

    filterData = createFilter(schemaNames, payload, runtimeOptions);
    if (!isString(filterData.sql) || !filterData.sql.length) {
      return api;
    }

    sql = sqlContext
      .appendToWhere(filterData.sql)
      .getSql();

    Object.assign(binding, filterData.binding);

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

  function sort(schemaNames, payload = {}) {
    if (!isSelect) {
      return api;
    }

    sortData = createSort(schemaNames, payload);
    if (!isString(sortData.sql) || !sortData.sql.length) {
      return api;
    }

    sql = sqlContext
      .replaceOrderBy(`ORDER BY ${sortData.sql}`)
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
        rowsCount: rows.length,
        resultTime: endTime - startTime,
      }, 'Database query');

      result = rows;
    } catch (error) {
      const queryError = new Error(error.message);
      queryError.code = error.code;
      throw queryError;
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
      const tablePromises = tables.map((table) => fastify.redis.get(`table-version:${table}`));
      const tableRawList = await Promise.all(tablePromises);
      const tableVersions = tableRawList.map((version, index) => `${tables[index]}:${version ?? 0}`);

      const queryHash = hash({
        sql,
        binding,
        filterData,
        paginationData,
        sortData,
        tableVersions,
      });

      cacheData.key = `${DATABASE_CACHE_PREFIX}db-query:${queryHash}`;
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

    const updatePromises = tables.map((table) => fastify.redis.set(`${DATABASE_CACHE_PREFIX}table-version:${table}`, Date.now()));
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
      .replaceOrderBy('')
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
    } else if (!isArray(result)) {
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
    return filterData?.filters || [];
  }

  function getPagination() {
    return paginationData;
  }

  function getSort() {
    return sortData?.sort || [];
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
