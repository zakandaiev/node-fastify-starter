import { fastify } from '#core/server.js';

const COLUMNS_KEY = '{columns}';
const CONDITIONS_KEY = '{conditions}';
const VALUES_KEY = '{values}';
const PAGINATION_KEY = '{pagination}';
const PAGINATION_DEFAULT_LIMIT = process.env.APP_PAGINATION_LIMIT;
const PAGINATION_DEFAULT_OFFSET = 0;

function normalizeColumns(columns, defaultColumns = []) {
  return Array.isArray(columns) && columns.length
    ? columns
    : defaultColumns;
}

function normalizeConditions(conditions) {
  return Array.isArray(conditions) && conditions.length
    ? conditions.map((c) => `${c} = :${c}`)
    : [];
}

function normalizeValues(values) {
  return Array.isArray(values) && values.length
    ? values.map((v) => `:${v}`)
    : [];
}

function normalizePagination(limit, offset) {
  return {
    limit: typeof limit === 'number' ? limit : PAGINATION_DEFAULT_LIMIT,
    offset: typeof offset === 'number' ? offset : PAGINATION_DEFAULT_OFFSET,
  };
}

function formatSql(originalSql, opt = {}) {
  if (typeof originalSql !== 'string' || !originalSql.length) {
    return false;
  }

  let sql = originalSql;
  const sqlData = {};

  // COLUMNS
  const columns = normalizeColumns(opt.columns, opt.defaultColumns);
  if (originalSql.includes(COLUMNS_KEY)) {
    sql = sql.replaceAll(COLUMNS_KEY, columns.length ? columns.join(', ') : '*');
  }

  // CONDITIONS
  const conditions = normalizeConditions(opt.conditions);
  if (originalSql.includes(CONDITIONS_KEY)) {
    sql = sql.replaceAll(CONDITIONS_KEY, conditions.length ? conditions.join(` ${opt.condition || 'AND'} `) : 'TRUE');
    opt.conditions?.forEach((c) => {
      sqlData[c] = opt[c] || null;
    });
  }

  // VALUES
  const values = normalizeValues(opt.values);
  if (originalSql.includes(VALUES_KEY)) {
    sql = sql.replaceAll(VALUES_KEY, values.join(', '));
    opt.values?.forEach((v) => {
      sqlData[v] = opt[v] || null;
    });
  }

  // PAGINATION
  const pagination = normalizePagination(opt.limit, opt.offset);
  if (originalSql.includes(PAGINATION_KEY)) {
    sql = sql.replaceAll(PAGINATION_KEY, 'LIMIT :limit OFFSET :offset');
    sqlData.limit = pagination.limit;
    sqlData.offset = pagination.offset;
  }

  return {
    sql,
    sqlData,
  };
}

async function executeSql(originalSql, opt = {}) {
  const { sql, sqlData } = formatSql(originalSql, opt);

  if (process.env.APP_MODE === 'dev') {
    fastify.log.info({ sql, sqlData }, 'database debug');
  }

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
