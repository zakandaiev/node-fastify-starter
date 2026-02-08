import { executeSql } from '#src/util/database.js';
import { randomUUID } from 'node:crypto';

async function createUser(payload = {}, options = {}) {
  // ID
  if (!payload.id) {
    payload.id = randomUUID();
  }

  // COLUMNS
  const columns = Object.keys(payload);
  const values = columns;

  // SQL
  const sql = 'INSERT INTO user ({columns}) VALUES ({values}) RETURNING {returning}';
  const rows = await executeSql(sql, {
    ...payload,
    ...options,
    columns,
    values,
  });

  return rows[0] || null;
}

async function getUserByConditions(payload = {}, options = {}) {
  const sql = 'SELECT {columns} FROM user WHERE {conditions} LIMIT 1';

  const rows = await executeSql(sql, {
    ...payload,
    ...options,
  });

  return rows[0] || null;
}

async function deleteUserByConditions(payload = {}, options = {}) {
  const sql = 'DELETE FROM user WHERE {conditions}';

  const result = await executeSql(sql, {
    ...payload,
    ...options,
  });

  return !!result.affectedRows;
}

async function getAllUsers(payload = {}, options = {}) {
  if (!payload.orderBy) {
    payload.orderBy = 'dateCreated DESC';
  }

  const sql = `
    SELECT {columns}
    FROM user
    ORDER BY :orderBy
    {pagination}
  `;

  const rows = await executeSql(sql, {
    ...payload,
    ...options,
  });

  return rows;
}

export {
  createUser,
  deleteUserByConditions,
  getAllUsers,
  getUserByConditions,
};
