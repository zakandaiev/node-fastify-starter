import { createQuery } from '#src/util/database.js';

async function createUser(payload = {}) {
  const columns = Object.keys(payload).join(', ');
  const values = Object.keys(payload).map((v) => `:${v}`).join(', ');

  const sql = `INSERT INTO users (${columns}) VALUES (${values}) RETURNING *`;
  const binding = { ...payload };

  const query = createQuery(sql, binding);
  await query.execute();

  return query.fetch();
}

async function getUserById(id) {
  const sql = 'SELECT * FROM users WHERE id = :id LIMIT 1';
  const binding = { id };

  const query = createQuery(sql, binding);
  await query.execute();

  return query.fetch();
}

async function getUserByEmail(email) {
  const sql = 'SELECT * FROM users WHERE email = :email LIMIT 1';
  const binding = { email };

  const query = createQuery(sql, binding);
  await query.execute();

  return query.fetch();
}

async function deleteUserById(id) {
  const sql = 'DELETE FROM users WHERE id = :id';
  const binding = { id };

  const query = createQuery(sql, binding);
  await query.execute();

  return query.affectedRows();
}

async function getAllUsers(payload = {}) {
  const sql = 'SELECT * FROM users ORDER BY id DESC';
  const binding = { ...payload };

  const query = createQuery(sql, binding).paginate(payload).sort(payload);
  await query.execute();

  return query.getAll();
}

export {
  createUser,
  deleteUserById,
  getAllUsers,
  getUserByEmail,
  getUserById,
};
