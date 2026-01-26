import { executeSql } from '#src/util/database.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_COLUMNS = ['id', 'email', 'name', 'phone'];

async function createUser(opt = {}) {
  const { email, password, name } = opt;

  if (!email || !password || !name) {
    return false;
  }

  const columns = opt.columns || ['id', 'email', 'password', 'name'];
  if (!columns.includes('id')) {
    columns.push('id');
  }

  const sql = 'INSERT INTO user ({columns}) VALUES ({values})';
  const rows = await executeSql(sql, {
    ...opt,
    id: randomUUID(),
    columns,
    values: columns,
  });

  return rows[0] || null;
}

async function getUserById(opt = {}) {
  if (!opt.id) {
    return false;
  }

  const sql = 'SELECT {columns} FROM user WHERE {conditions} LIMIT 1';
  const rows = await executeSql(sql, {
    ...opt,
    conditions: ['id'],
    defaultColumns: DEFAULT_COLUMNS,
  });

  return rows[0] || null;
}

async function getUserByEmail(opt = {}) {
  if (!opt.email) {
    return false;
  }

  const sql = 'SELECT {columns} FROM user WHERE {conditions} LIMIT 1';
  const rows = await executeSql(sql, {
    ...opt,
    conditions: ['email'],
    defaultColumns: DEFAULT_COLUMNS,
  });

  return rows[0] || null;
}

async function getUserByPhone(opt = {}) {
  if (!opt.phone) {
    return false;
  }

  const sql = 'SELECT {columns} FROM user WHERE {conditions} LIMIT 1';
  const rows = await executeSql(sql, {
    ...opt,
    conditions: ['phone'],
    defaultColumns: DEFAULT_COLUMNS,
  });

  return rows[0] || null;
}

async function getUserByConditions(opt = {}) {
  if (!opt.conditions) {
    return false;
  }

  const sql = 'SELECT {columns} FROM user WHERE {conditions} LIMIT 1';
  const rows = await executeSql(sql, {
    ...opt,
    defaultColumns: DEFAULT_COLUMNS,
  });

  return rows[0] || null;
}

async function getAllUsers(opt = {}) {
  const sql = 'SELECT {columns} FROM user {pagination}';
  const rows = await executeSql(sql, {
    ...opt,
    defaultColumns: DEFAULT_COLUMNS,
  });

  return rows;
}

export {
  createUser,
  getAllUsers,
  getUserByConditions,
  getUserByEmail,
  getUserById,
  getUserByPhone,
};
