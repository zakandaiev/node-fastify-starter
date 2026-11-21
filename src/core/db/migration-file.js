import { absPath } from '#config/path.js';
import {
  isWord,
  readStatements,
  TOKEN_TYPE,
  tokenizeSql,
} from '#core/db/lexer.js';
import { MIGRATION_DIRECTION } from '#enums/migration-direction.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { groupBy, sortBy } from '#utils/array.js';
import { mapSeries } from '#utils/async.js';
import { sha256 } from '#utils/hash.js';
import {
  isArray,
  isBlankString,
  isBoolean,
  isString,
} from '#utils/type.js';
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import nodePath from 'node:path';

const DIALECT_DIRECTORY = 'mariadb';
const SEED_DIRECTORY = 'seed';
const SQL_EXTENSION = '.sql';
const ENCODING = 'utf8';
const MISSING_DIRECTORY_CODE = 'ENOENT';
const NEW_FILE_FLAG = 'wx';

const { UP, DOWN } = MIGRATION_DIRECTION;
const TYPES = Object.freeze(Object.values(MIGRATION_TYPE));

const VERSION_WIDTH = 4;
const VERSION_MAX_DIGITS = 15;
const FIRST_VERSION = 1;

export const MIGRATION_NAME_MAX_LENGTH = 100;

const NAME_PATTERN = `[a-z0-9_]{1,${MIGRATION_NAME_MAX_LENGTH}}`;
const NAME_REGEXP = new RegExp(`^${NAME_PATTERN}$`);
const FILE_REGEXP = new RegExp(`^(\\d{1,${VERSION_MAX_DIGITS}})_(${NAME_PATTERN})\\.(${UP}|${DOWN})\\${SQL_EXTENSION}$`);
const FILE_FORMAT = `<version>_<name>.<${UP}|${DOWN}>${SQL_EXTENSION}`;

const LINE_BREAK = '\n';
const LINE_BREAK_REGEXP = /\r\n?/g;

const NAME_QUOTE = '`';
const NAME_SEPARATOR = '.';
const SEPARATOR_AHEAD_REGEXP = /\s*\./y;
const BLANK = ' ';
const USE_WORD = 'USE';
const SHOW_WORD = 'SHOW';
const OR_WORD = 'OR';
const ALTER_WORD = 'ALTER';
const TABLE_WORD = 'TABLE';
const ALTER_TABLE_PASSED_WORDS = Object.freeze(['ONLINE', 'IGNORE']);
const DATABASE_WORDS = Object.freeze(['DATABASE', 'SCHEMA']);
const DEFINING_WORDS = Object.freeze(['CREATE', 'DROP', 'ALTER']);
const DEFINITION_WORDS = Object.freeze([...DEFINING_WORDS, 'RENAME', 'TRUNCATE']);
const PASSED_WORDS = Object.freeze([OR_WORD, 'REPLACE']);
const DIGIT_LED_REGEXP = /^[0-9]+[^0-9]/;
const NAME_CHARACTERS = 'A-Za-z0-9_$';

export const MIGRATION_DIRECTORY = nodePath.join(absPath.migration, DIALECT_DIRECTORY);

export function assertMigrationType(type, signature) {
  if (!TYPES.includes(type)) {
    throw new TypeError(`${signature} requires type to be one of: ${TYPES.join(', ')}`);
  }
}

// Where the files of a type lie: the seeds in a directory of their own inside the one of the migrations.
export function resolveMigrationDirectory(directory, type) {
  return type === MIGRATION_TYPE.SEED
    ? nodePath.join(directory, SEED_DIRECTORY)
    : directory;
}

// One spelling of a migration wherever it is named: a file may write its version as "1" or as "0001",
// and a row of the table keeps the number only.
export function formatMigrationId(version, name) {
  return `${String(version).padStart(VERSION_WIDTH, '0')}_${name}`;
}

// A directory that is not there holds no migrations: a project may have no seeds at all. A link counts as
// a file: a volume of a container gives every file as one, and a file passed over is a migration never run.
async function readSqlFileNames(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });

    return entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(SQL_EXTENSION))
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === MISSING_DIRECTORY_CODE) {
      return [];
    }

    throw error;
  }
}

// A file whose name does not fit is refused, not passed over: a migration that is silently never run
// is worse than a run that stops.
function parseFileName(fileName) {
  const match = FILE_REGEXP.exec(fileName);

  if (!match) {
    throw new Error(`Migration file "${fileName}" must be named ${FILE_FORMAT}: the version in 1 to ${VERSION_MAX_DIGITS} digits, the name in 1 to ${MIGRATION_NAME_MAX_LENGTH} lowercase letters, digits and underscores`);
  }

  const [, digits, name, direction] = match;

  return {
    version: Number(digits),
    name,
    direction,
    fileName,
  };
}

function findFile(files, direction) {
  return files.find((file) => file.direction === direction) ?? null;
}

// "0001" and "1" are one version, so the files are told apart by the number, not by the text of the prefix.
function toMigration(files, { type, directory }) {
  const [{ version, name }] = files;
  const up = findFile(files, UP);
  const down = findFile(files, DOWN);
  const isOneMigration = files.every((file) => file.name === name) && files.length === [up, down].filter(Boolean).length;

  if (!isOneMigration) {
    throw new Error(`Migration files ${files.map((file) => file.fileName).join(', ')} share the version ${version}: a version belongs to one migration`);
  }

  if (!up) {
    throw new Error(`Migration file "${down.fileName}" has no ${UP} file beside it`);
  }

  return {
    type,
    version,
    name,
    id: formatMigrationId(version, name),
    upPath: nodePath.join(directory, up.fileName),
    downPath: down && nodePath.join(directory, down.fileName),
  };
}

function assertUniqueNames(migrations) {
  const repeated = Object.values(groupBy(migrations, 'name')).find((sameName) => sameName.length > 1);

  if (repeated) {
    throw new Error(`Migrations ${repeated.map((migration) => migration.id).join(' and ')} have one name: --names tells migrations apart by it`);
  }
}

// Reads the names only, never the files: this is also what a health check calls on every poll.
export async function listMigrations({ directory = MIGRATION_DIRECTORY, type = MIGRATION_TYPE.MIGRATION } = {}) {
  assertMigrationType(type, 'listMigrations({ directory, type })');

  const typeDirectory = resolveMigrationDirectory(directory, type);
  const files = (await readSqlFileNames(typeDirectory)).map((fileName) => parseFileName(fileName));
  const migrations = sortBy(
    Object.values(groupBy(files, 'version')).map((sameVersion) => toMigration(sameVersion, { type, directory: typeDirectory })),
    'version',
  );

  assertUniqueNames(migrations);

  return migrations;
}

// A file in another encoding is refused: read leniently, its bytes would reach the tables as replacement
// characters. The decoder also drops a byte order mark, which the server takes for a syntax error.
function decodeSql(bytes, path) {
  try {
    return new TextDecoder(ENCODING, { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`Migration file "${nodePath.basename(path)}" is not valid UTF-8: save it as UTF-8`, { cause });
  }
}

// The same text on every system, and what is run is what is hashed: a checkout with CRLF must give the checksum
// of the one with LF, and a line break inside a literal must reach the table as the same character.
export async function readMigrationFile(path) {
  const sql = decodeSql(await readFile(path), path).replace(LINE_BREAK_REGEXP, LINE_BREAK);

  return { sql, checksum: sha256(sql) };
}

function isFollowedBySeparator(sql, token) {
  SEPARATOR_AHEAD_REGEXP.lastIndex = token.end;

  return SEPARATOR_AHEAD_REGEXP.test(sql);
}

function readName(token) {
  if (token.type === TOKEN_TYPE.WORD) {
    return token.value.toLowerCase();
  }

  return token.type === TOKEN_TYPE.QUOTED && token.value.startsWith(NAME_QUOTE)
    ? token.value.slice(1, -1).replaceAll(`${NAME_QUOTE}${NAME_QUOTE}`, NAME_QUOTE).toLowerCase()
    : null;
}

// "app.users" is one word for the lexer; `app`.`users`, app.`users` and "app . users" are a name with a dot after it.
function isQualifiedBy(sql, token, database) {
  const name = readName(token);

  if (name === null) {
    return false;
  }

  return (token.type === TOKEN_TYPE.WORD && name.startsWith(`${database}${NAME_SEPARATOR}`))
    || (name === database && isFollowedBySeparator(sql, token));
}

// The word after a verb, past the words that may stand between the two.
function findObject(statement, index, passedWords) {
  return statement
    .slice(index + 1, index + 2 + passedWords.length)
    .find((token) => !isWord(token, passedWords));
}

function findAlterTable(statement) {
  return statement.findIndex((token, index) => isWord(token, [ALTER_WORD])
    && isWord(findObject(statement, index, ALTER_TABLE_PASSED_WORDS), [TABLE_WORD]));
}

// The verb with its object, wherever it stands: inside a block the first statement follows no semicolon.
// "SHOW CREATE DATABASE" only reads; between the verb and the object stands "OR REPLACE" at most.
function isDatabaseDefinition(statement, index) {
  return isWord(statement[index], DEFINING_WORDS)
    && !isWord(statement[index - 1], [SHOW_WORD])
    && isWord(findObject(statement, index, PASSED_WORDS), DATABASE_WORDS);
}

// What follows ALTER TABLE in its statement are clauses about columns, and a column may be named "schema"
// or "database" unquoted: "ALTER TABLE forms DROP schema" drops a column.
function definesDatabase(statement) {
  const alterTable = findAlterTable(statement);
  const end = alterTable === -1
    ? statement.length
    : alterTable;

  return statement.slice(0, end).some((token, index) => isDatabaseDefinition(statement, index));
}

// The server reads "app /* x */ .users" as a name with a dot after it: the comments are turned into blanks
// of their own length, so that the place of every token stays.
function blankComments(sql) {
  const comments = tokenizeSql(sql).filter((token) => token.type === TOKEN_TYPE.COMMENT);
  const pieces = comments.flatMap((comment, index) => [
    sql.slice(comments[index - 1]?.end ?? 0, comment.start),
    BLANK.repeat(comment.end - comment.start),
  ]);

  return `${pieces.join('')}${sql.slice(comments.at(-1)?.end ?? 0)}`;
}

// The lexer passes over a name that begins with a digit ("5app.users" gives no token at all), so a database
// of such a name is looked for in what stands between the tokens. A name of digits alone is not looked for:
// unquoted it is a number, and "2026.5" would be taken for it.
function findSkippedName(text, tokens, database) {
  const starts = [...tokens.map((token) => token.start), text.length];
  const ends = [0, ...tokens.map((token) => token.end)];
  const nameRegexp = new RegExp(`(?<![${NAME_CHARACTERS}])${RegExp.escape(database)}\\s*\\.`, 'i');

  return starts.some((start, index) => nameRegexp.test(text.slice(ends[index], start)))
    ? database
    : null;
}

function findQualifiedName(sql, statements, database) {
  const text = blankComments(sql);
  const tokens = statements.flat();
  const qualified = tokens.find((token) => isQualifiedBy(text, token, database));

  if (qualified || !DIGIT_LED_REGEXP.test(database)) {
    return qualified?.value ?? null;
  }

  return findSkippedName(text, tokens, database);
}

// How a script names a database, or null when it names none: by USE, by a statement that creates, drops or
// alters one, or by the name of the given database in front of a table. "USE INDEX" stands inside a statement
// and is not taken for it: only the first word of a statement is looked at.
export function findDatabaseName(sql, database) {
  if (!isString(sql) || !isString(database)) {
    throw new TypeError('findDatabaseName(sql, database) requires the text of a script and the name of a database');
  }

  const statements = readStatements(sql);
  const qualified = findQualifiedName(sql, statements, database.toLowerCase());

  if (statements.some((statement) => isWord(statement[0], [USE_WORD]))) {
    return `a ${USE_WORD} statement`;
  }

  if (statements.some((statement) => definesDatabase(statement))) {
    return 'a statement that creates, drops or alters a database';
  }

  return qualified
    ? `the name of the database in front of a table (${qualified}; a table or an alias of that name reads the same and needs another alias)`
    : null;
}

// Whether a script begins with one statement that defines something (CREATE, ALTER, DROP, RENAME, TRUNCATE).
// Such a statement takes its locks before it changes anything, so one that gave up on a lock has left nothing.
// A block, a call and CREATE OR REPLACE, which drops what it replaces first, may have done a part of their work.
export function startsWithDefinition(sql) {
  if (!isString(sql)) {
    throw new TypeError('startsWithDefinition(sql) requires the text of a script');
  }

  const [first = []] = readStatements(sql);

  return isWord(first[0], DEFINITION_WORDS) && !isWord(first[1], [OR_WORD]);
}

// A text the lexer cannot read may name a database unseen: the server runs what an executable comment holds.
function findRefusal(fileName, sql, database) {
  try {
    return findDatabaseName(sql, database);
  } catch (cause) {
    throw new Error(`${fileName} cannot be read as SQL, and what cannot be read is not sent: ${cause.message}`, { cause });
  }
}

// Not empty: an empty file is one that "make" created and nobody wrote, and recorded as applied it would never
// run again. And it names no database: "verify" runs every up file once more in a database of its own,
// and a statement that names the live one would be done there a second time.
export function assertRunnable({ path, sql, database }) {
  const fileName = nodePath.basename(path);

  if (isBlankString(sql)) {
    throw new Error(`${fileName} is empty: write its statements, or a comment if there is nothing to do`);
  }

  const reason = findRefusal(fileName, sql, database);

  if (reason) {
    throw new Error(`${fileName} holds ${reason}: a migration file works in the database it is applied to and never names one`);
  }
}

// A name that does not fit is what a person typed, not a fault of the calling code: it is told by name.
function assertNewNames(names, { existing, type, signature }) {
  if (!isArray(names) || names.length === 0 || !names.every((name) => isString(name))) {
    throw new TypeError(`${signature} requires a list of names`);
  }

  const unfit = names.find((name) => !NAME_REGEXP.test(name));
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  const taken = names.find((name) => existing.some((migration) => migration.name === name));

  if (unfit !== undefined) {
    throw new Error(`"${unfit}" is not a name of a ${type}: a name is 1 to ${MIGRATION_NAME_MAX_LENGTH} lowercase letters, digits and underscores, such as add_users`);
  }

  if (repeated !== undefined) {
    throw new Error(`The name "${repeated}" is given twice: --names tells ${type}s apart by it`);
  }

  if (taken !== undefined) {
    throw new Error(`A ${type} named "${taken}" exists already: --names tells ${type}s apart by it`);
  }
}

// The files are created empty, and an empty up file is refused by the runner: a migration that was made
// and never written must not be recorded as applied.
export async function makeMigrations({
  names,
  type = MIGRATION_TYPE.MIGRATION,
  directory = MIGRATION_DIRECTORY,
  isDryRun = false,
} = {}) {
  const signature = 'makeMigrations({ names, type, directory, isDryRun })';

  assertMigrationType(type, signature);

  if (!isBoolean(isDryRun)) {
    throw new TypeError(`${signature} requires isDryRun to be a boolean`);
  }

  const existing = await listMigrations({ directory, type });

  assertNewNames(names, { existing, type, signature });

  const typeDirectory = resolveMigrationDirectory(directory, type);
  const nextVersion = Math.max(FIRST_VERSION - 1, ...existing.map((migration) => migration.version)) + 1;
  const paths = names.flatMap((name, index) => [UP, DOWN].map(
    (direction) => nodePath.join(typeDirectory, `${formatMigrationId(nextVersion + index, name)}.${direction}${SQL_EXTENSION}`),
  ));

  if (!isDryRun) {
    await mkdir(typeDirectory, { recursive: true });
    await mapSeries(paths, (path) => writeFile(path, '', { flag: NEW_FILE_FLAG }));
  }

  return paths;
}
