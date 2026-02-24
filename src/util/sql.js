import { isNumber, isString, toString } from '#src/util/misc.js';

/* eslint-disable no-continue */

function getSubstitutedSql(sql, binding = {}) {
  return sql.replace(/:\w+/g, (match) => {
    const key = match.slice(1);
    const value = binding[key];

    if (isNumber(value)) {
      return value;
    }

    if (isString(value)) {
      return `'${value}'`;
    }

    return toString(value);
  });
}

function normalizeOrderBy(orderBy, allowedColumns = []) {
  if (!isString(orderBy)) {
    return false;
  }

  const parts = orderBy.split(',');
  const result = [];

  for (let i = 0; i < parts.length; i += 1) {
    const value = parts[i];

    const [column, directionRaw = 'ASC'] = value.trim().split(' ');
    let direction = directionRaw.toUpperCase();

    if (!allowedColumns.includes(column)) {
      continue;
    }

    if (!['ASC', 'DESC'].includes(direction)) {
      direction = 'ASC';
    }

    result.push(`${column} ${direction}`);
  }

  return result.length ? result.join(', ') : false;
}

function tokenizeSql(sql) {
  const tokens = [];
  const len = sql.length;

  let i = 0;
  let depth = 0;

  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  const keywords = new Set([
    'SELECT',
    'FROM',
    'WHERE',
    'ORDER',
    'BY',
    'LIMIT',
    'OFFSET',
    'GROUP',
    'HAVING',
    'UNION',
    'ALL',
    'WITH',
  ]);

  const wordStartRe = /[a-zA-Z_]/;
  const wordCharRe = /[a-zA-Z0-9_$]/;

  while (i < len) {
    const c = sql[i];
    const next = sql[i + 1];

    // COMMENTS
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else i += 1;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick) {
      if (c === '-' && next === '-') {
        inLineComment = true;
        i += 2;
        continue;
      }
      if (c === '#') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (c === '/' && next === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
    }

    // STRINGS
    if (!inDouble && !inBacktick && c === "'" && !inSingle) {
      inSingle = true;
      i += 1;
      continue;
    } else if (inSingle && c === "'" && sql[i - 1] !== '\\') {
      inSingle = false;
      i += 1;
      continue;
    }

    if (!inSingle && !inBacktick && c === '"' && !inDouble) {
      inDouble = true;
      i += 1;
      continue;
    } else if (inDouble && c === '"' && sql[i - 1] !== '\\') {
      inDouble = false;
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && c === '`') {
      inBacktick = !inBacktick;
      i += 1;
      continue;
    }

    if (inSingle || inDouble || inBacktick) {
      i += 1;
      continue;
    }

    // DEPTH
    if (c === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ')') {
      depth -= 1;
      i += 1;
      continue;
    }

    // PLACEHOLDER
    if (c === ':' && wordStartRe.test(next)) {
      let j = i + 2;

      while (j < len && wordCharRe.test(sql[j])) j += 1;

      tokens.push({
        type: 'placeholder',
        upper: null,
        start: i,
        end: j,
        depth,
      });

      i = j;
      continue;
    }

    if (c === '?') {
      tokens.push({
        type: 'placeholder',
        upper: null,
        start: i,
        end: i + 1,
        depth,
      });

      i += 1;
      continue;
    }

    // WORD
    if (wordStartRe.test(c)) {
      let j = i + 1;
      while (j < len && wordCharRe.test(sql[j])) j += 1;

      const value = sql.slice(i, j);
      const upper = value.toUpperCase();

      tokens.push({
        type: keywords.has(upper) ? 'keyword' : 'identifier',
        upper,
        start: i,
        end: j,
        depth,
      });

      i = j;
      continue;
    }

    i += 1;
  }

  return tokens;
}

function cutSelectionPartFromSqlTokens(sql, tokens) {
  let selectFound = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (t.depth !== 0 || t.type !== 'keyword') {
      continue;
    }

    if (t.upper === 'SELECT') {
      selectFound = true;
    }

    if (t.upper === 'FROM' && selectFound) {
      return sql.slice(t.end).trim();
    }
  }

  return sql;
}

function replaceOrderByFromSqlTokens(sql, tokens, newOrderBy) {
  let orderStart = -1;
  let orderEnd = -1;
  let limitStart = -1;
  let lastUnionIndex = -1;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (t.depth === 0 && t.type === 'keyword' && t.upper === 'UNION') {
      lastUnionIndex = i;
    }
  }

  const startIndex = lastUnionIndex !== -1 ? lastUnionIndex + 1 : 0;

  for (let i = startIndex; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (t.depth !== 0 || t.type !== 'keyword') {
      continue;
    }

    if (
      t.upper === 'ORDER'
      && i + 1 < tokens.length
      && tokens[i + 1].upper === 'BY'
      && tokens[i + 1].depth === 0
    ) {
      orderStart = t.start;

      for (let j = i + 2; j < tokens.length; j += 1) {
        const n = tokens[j];

        if (
          n.depth === 0
          && n.type === 'keyword'
          && (n.upper === 'LIMIT')
        ) {
          orderEnd = n.start;
          break;
        }
      }

      if (orderEnd === -1) {
        orderEnd = sql.length;
      }

      break;
    }

    if (t.upper === 'LIMIT' && limitStart === -1) {
      limitStart = t.start;
    }
  }

  if (orderStart !== -1) {
    const before = sql.slice(0, orderStart).trimEnd();
    const after = sql.slice(orderEnd);

    return `${before} ${newOrderBy} ${after}`;
  }

  if (limitStart !== -1) {
    const before = sql.slice(0, limitStart).trimEnd();
    const after = sql.slice(limitStart);

    return `${before} ${newOrderBy} ${after}`;
  }

  return `${sql.trimEnd()} ${newOrderBy}`;
}

function replacePaginationFromSqlTokens(sql, tokens, newPagination) {
  let limitStart = -1;
  let lastUnionIndex = -1;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (t.depth === 0 && t.type === 'keyword' && t.upper === 'UNION') {
      lastUnionIndex = i;
    }
  }

  const startIndex = lastUnionIndex !== -1 ? lastUnionIndex + 1 : 0;

  for (let i = startIndex; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (t.depth !== 0 || t.type !== 'keyword') {
      continue;
    }

    if (t.upper === 'LIMIT') {
      limitStart = t.start;
      break;
    }
  }

  if (limitStart !== -1) {
    const before = sql.slice(0, limitStart).trimEnd();
    const after = sql.slice(sql.length);

    return newPagination
      ? `${before} ${newPagination} ${after}`
      : `${before} ${after}`;
  }

  if (!newPagination) {
    return sql.trim();
  }

  return `${sql.trimEnd()} ${newPagination}`;
}

function createSqlContext(sql) {
  let currentSql = sql;
  let currentTokens = tokenizeSql(sql);

  const context = {
    getSql() {
      return currentSql;
    },

    getTokens() {
      return currentTokens;
    },

    replaceOrderBy(newOrderBy) {
      currentSql = replaceOrderByFromSqlTokens(currentSql, currentTokens, newOrderBy);
      currentTokens = tokenizeSql(currentSql);
      return context;
    },

    replacePagination(newPagination) {
      currentSql = replacePaginationFromSqlTokens(currentSql, currentTokens, newPagination);
      currentTokens = tokenizeSql(currentSql);
      return context;
    },
  };

  return context;
}

export {
  createSqlContext,
  cutSelectionPartFromSqlTokens,
  getSubstitutedSql,
  normalizeOrderBy,
  replaceOrderByFromSqlTokens,
  replacePaginationFromSqlTokens,
  tokenizeSql,
};
