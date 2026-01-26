/* eslint-disable no-console */
import { processArg } from '#root/core/app.js';
import { absPath, resolvePath } from '#root/core/path.js';
import mysql from 'mysql2/promise';
import { readdirSync, readFileSync } from 'node:fs';

const { direction } = processArg;

if (!['up', 'down'].includes(direction)) {
  console.log('❌ Migration failed: direction must be "up" or "down"');
  process.exit(1);
}

const connection = await mysql.createConnection({
  host: process.env.APP_DATABASE_HOST,
  database: process.env.APP_DATABASE_NAME,
  user: process.env.APP_DATABASE_USER,
  password: process.env.APP_DATABASE_PASSWORD,
  multipleStatements: true,
  namedPlaceholders: true,
});

try {
  const files = readdirSync(absPath.migration)
    .filter((file) => file.endsWith(`.${direction}.sql`))
    .sort();

  if (!files.length) {
    console.log(`⚠️ Migration finished: no ${direction} migrations found`);
    process.exit(0);
  }

  await connection.beginTransaction();

  await files.reduce(async (prev, file) => {
    await prev;

    const filePath = resolvePath(absPath.migration, file);
    const fileSql = readFileSync(filePath, 'utf8');

    console.log(`⏳ Migration started: ${file}`);

    await connection.query(fileSql);

    console.log(`✅ Migration finished: ${file}`);
  }, Promise.resolve());

  await connection.commit();

  console.log(`🎉 Migration succeeded: ${files.length} ${direction} migrations done`);
  process.exit(0);
} catch (error) {
  await connection.rollback();

  console.log(`❌ Migration failed: ${error.message}`);
  process.exit(1);
} finally {
  await connection.end();
}
