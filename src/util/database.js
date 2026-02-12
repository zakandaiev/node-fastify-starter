import { fastify } from '#core/server.js';

const COLUMNS_KEY = '{columns}';
const CONDITIONS_KEY = '{conditions}';
const RETURNING_KEY = '{returning}';
const VALUES_KEY = '{values}';
const PAGINATION_KEY = '{pagination}';
const PAGINATION_DEFAULT_LIMIT = process.env.APP_PAGINATION_LIMIT;
const PAGINATION_DEFAULT_OFFSET = 0;

function normalizeColumns(columns, split = ',') {
  return Array.isArray(columns) && columns.length && columns[0] !== '*'
    ? columns.join(` ${split} `)
    : '*';
}

function normalizeConditions(conditions, split = 'AND') {
  return Array.isArray(conditions) && conditions.length
    ? conditions.map((c) => `${c} = :${c}`).join(` ${split} `)
    : 'TRUE';
}

function normalizeValues(values, split = ',') {
  return Array.isArray(values) && values.length
    ? values.map((v) => `:${v}`).join(` ${split} `)
    : [];
}

function normalizePagination(limit, offset) {
  return {
    limit: typeof limit === 'number'
      ? limit
      : PAGINATION_DEFAULT_LIMIT,
    offset: typeof offset === 'number'
      ? offset
      : PAGINATION_DEFAULT_OFFSET,
  };
}

function formatSql(originalSql, options = {}) {
  if (typeof originalSql !== 'string' || !originalSql.length) {
    return false;
  }

  let sql = originalSql;
  const sqlData = Object.fromEntries(Object.entries(options).map(([k, v]) => [k, v || null]));

  // COLUMNS
  if (originalSql.includes(COLUMNS_KEY)) {
    sql = sql.replaceAll(COLUMNS_KEY, normalizeColumns(options.columns, options.columnsSplit));
    delete sqlData.columns;
  }

  // CONDITIONS
  if (originalSql.includes(CONDITIONS_KEY)) {
    sql = sql.replaceAll(CONDITIONS_KEY, normalizeConditions(options.conditions, options.conditionsSplit));
    delete sqlData.conditions;
  }

  // RETURNING
  if (originalSql.includes(RETURNING_KEY)) {
    sql = sql.replaceAll(RETURNING_KEY, normalizeColumns(options.returning, options.returningSplit));
    delete sqlData.returning;
  }

  // VALUES
  if (originalSql.includes(VALUES_KEY)) {
    sql = sql.replaceAll(VALUES_KEY, normalizeValues(options.values, options.valuesSplit));
    delete sqlData.values;
  }

  // PAGINATION
  if (originalSql.includes(PAGINATION_KEY)) {
    const pagination = normalizePagination(options.limit, options.offset);
    sqlData.limit = pagination.limit;
    sqlData.offset = pagination.offset;
    sql = sql.replaceAll(PAGINATION_KEY, 'LIMIT :limit OFFSET :offset');
  }

  return {
    sql,
    sqlData,
  };
}

async function executeSql(originalSql, options = {}) {
  const { sql, sqlData } = formatSql(originalSql, options);

  fastify.log.info({ sql, sqlData }, 'database debug');

  const connection = await fastify.mysql.getConnection();
  const [rows] = await connection.execute(sql, sqlData);
  connection.release();

  return rows;
}

export {
  executeSql,
  formatSql,
  normalizeColumns,
  normalizeConditions,
  normalizePagination,
  normalizeValues,
};
