/* eslint-disable no-console */
import { processArg } from '#root/core/app.js';
import { absPath, joinPath } from '#root/core/path.js';
import { toNumber } from '#src/util/misc.js';
import mysql from 'mysql2/promise';
import { readdirSync, readFileSync } from 'node:fs';

const {
  type = 'migration',
  direction,
  names,
  'names-exclude': namesExclude,
} = processArg;

const isSeed = type === 'seed'
  ? true
  : false;
const filesDirectory = isSeed
  ? absPath.seed
  : absPath.migration;
const typeName = isSeed
  ? 'Seed'
  : 'Migration';
const excludedNames = namesExclude
  ? namesExclude.split(',')
  : null;
const selectedNames = names
  ? names.split(',')
  : null;

if (!['up', 'down'].includes(direction)) {
  console.log(`❌ ${typeName} failed: direction must be "up" or "down"`);
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
  const files = readdirSync(filesDirectory)
    .filter((file) => {
      const fileNameRegex = new RegExp(`^\\d+_.+\\.${direction}\\.sql$`);
      if (!fileNameRegex.test(file)) {
        return false;
      }

      if (excludedNames && excludedNames.some((excludedName) => file.includes(`_${excludedName}.`))) {
        return false;
      }

      if (selectedNames && !selectedNames.some((selectedName) => file.includes(`_${selectedName}.`))) {
        return false;
      }

      return true;
    })
    .sort((a, b) => {
      const numA = toNumber(a.split('_')[0]);
      const numB = toNumber(b.split('_')[0]);
      return direction === 'down'
        ? numB - numA
        : numA - numB;
    });

  if (!files.length) {
    console.log(`⚠️  ${typeName} cancelled: no ${direction} ${type}s found`);
    process.exit(0);
  }

  await connection.beginTransaction();
  await files.reduce(async (prev, file) => {
    await prev;

    const filePath = joinPath(filesDirectory, file);
    const fileSql = readFileSync(filePath, 'utf8');

    console.log(`⏳ ${typeName} started: ${file}`);
    await connection.query(fileSql);
    console.log(`✅ ${typeName} finished: ${file}`);
  }, Promise.resolve());

  await connection.commit();
  await connection.end();
  console.log(`🎉 ${typeName} succeeded: ${files.length} ${direction} ${type}s done`);
  process.exit(0);
} catch (error) {
  await connection.rollback();
  console.log(`❌ ${typeName} failed: ${error.message}`);
  process.exit(1);
}
