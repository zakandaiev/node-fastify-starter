import { readArgs } from '#config/arg.js';
import { initEnv } from '#config/env.js';
import { createConfig } from '#config/index.js';
import { absPath } from '#config/path.js';
import { createContext, runInContext } from '#core/context/index.js';
import { findDbError } from '#core/db/error.js';
import { createDb } from '#core/db/index.js';
import { makeMigrations, MIGRATION_DIRECTORY } from '#core/db/migration-file.js';
import {
  getMigrationStatus,
  migrateDown,
  migrateFresh,
  migrateUp,
  verifyMigrations,
} from '#core/db/migrator.js';
import { createLogger } from '#core/logger/index.js';
import { MIGRATION_DIRECTION } from '#enums/migration-direction.js';
import { MIGRATION_STATE } from '#enums/migration-state.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import { toUtcIso } from '#utils/date.js';
import nodePath from 'node:path';
import { argv } from 'node:process';

const {
  UP,
  DOWN,
  STATUS,
  MAKE,
  VERIFY,
  FRESH,
} = MIGRATION_DIRECTION;

const ARG_NAMES = Object.freeze(['direction', 'type', 'names', 'names-exclude', 'dry-run']);

// What a direction takes besides itself: an argument that would do nothing is refused, not passed over.
const DIRECTION_ARGS = Object.freeze({
  [UP]: ['type', 'names', 'names-exclude', 'dry-run'],
  [DOWN]: ['type', 'names', 'names-exclude', 'dry-run'],
  [STATUS]: ['type'],
  [MAKE]: ['type', 'names', 'dry-run'],
  [VERIFY]: [],
  [FRESH]: ['dry-run'],
});

const TYPE_LABELS = Object.freeze({
  [MIGRATION_TYPE.MIGRATION]: 'Migration',
  [MIGRATION_TYPE.SEED]: 'Seed',
});
const DIRECTION_LABELS = Object.freeze({ [VERIFY]: 'Verify', [FRESH]: 'Fresh' });

const STATE_MARKS = Object.freeze({
  [MIGRATION_STATE.PENDING]: '⏳',
  [MIGRATION_STATE.APPLIED]: '✅',
  [MIGRATION_STATE.RUNNING]: '⏳',
  [MIGRATION_STATE.DIRTY]: '❌',
  [MIGRATION_STATE.CHANGED]: '⚠️',
  [MIGRATION_STATE.MISSING]: '⚠️',
});
const STATE_TEXTS = Object.freeze({
  [MIGRATION_STATE.PENDING]: 'pending',
  [MIGRATION_STATE.APPLIED]: 'applied',
  [MIGRATION_STATE.RUNNING]: 'running now',
  [MIGRATION_STATE.DIRTY]: 'dirty, its run failed or was cut short',
  [MIGRATION_STATE.CHANGED]: 'changed after it was applied',
  [MIGRATION_STATE.MISSING]: 'applied, not known to this build',
});

// The lines of the migrator are the output: a query of the pool is not logged beside them, a warning is.
const LOG_LEVEL = 'warn';

const ARG_ERROR_PREFIX = 'ERR_PARSE_ARGS';
const LINE_BREAK = '\n';
const LINE_BREAKS_REGEXP = /\s*\n\s*/g;

const EXIT_OK = 0;
const EXIT_FAILED = 1;

function readOptions(args) {
  const values = readArgs(ARG_NAMES, args);
  const { direction } = values;

  if (!direction) {
    throw new Error(`--direction is required: one of ${Object.values(MIGRATION_DIRECTION).join(', ')}`);
  }

  const refused = Object.keys(values).find((name) => name !== 'direction' && !DIRECTION_ARGS[direction].includes(name));

  if (refused) {
    throw new Error(`--${refused} does not go with --direction=${direction}`);
  }

  return {
    direction,
    type: values.type ?? MIGRATION_TYPE.MIGRATION,
    names: values.names,
    namesExclude: values['names-exclude'],
    isDryRun: values['dry-run'] ?? false,
  };
}

function readLabel({ direction, type }) {
  return DIRECTION_LABELS[direction] ?? TYPE_LABELS[type];
}

function count(total, noun) {
  return `${total} ${noun}${total === 1 ? '' : 's'}`;
}

function countFiles(files, direction, type) {
  return count(files.length, `${direction} ${type}`);
}

function createEvents({ label, print }) {
  return {
    onLockWait: () => print(`⏳ ${label} waiting: another migrator holds the lock of the database`),
    onFileStart: (file) => print(`⏳ ${label} started: ${file}`),
    onFileFinish: (file, durationMs) => print(`✅ ${label} finished: ${file} (${durationMs} ms)`),
  };
}

function printAhead({ label, print, options }, ahead) {
  if (ahead.length) {
    print(`⚠️ ${label} ahead: the database holds ${count(ahead.length, options.type)} this build does not know: ${ahead.join(', ')}`);
  }
}

function printRun(job, { files, isDryRun, ahead = [] }, direction) {
  const { label, print } = job;
  const total = countFiles(files, direction, job.options.type);

  printAhead(job, ahead);

  if (!files.length) {
    print(`⚠️ ${label} cancelled: nothing to do`);
  } else if (isDryRun) {
    files.forEach((file) => print(`⏳ ${label} would run: ${file}`));
    print(`🎉 ${label} dry run: ${total} would run`);
  } else {
    print(`🎉 ${label} succeeded: ${total} done`);
  }

  return EXIT_OK;
}

async function runUp(job) {
  return printRun(job, await migrateUp({ ...job.selection, ...createEvents(job) }), UP);
}

async function runDown(job) {
  return printRun(job, await migrateDown({ ...job.selection, ...createEvents(job) }), DOWN);
}

// What "fresh" has dropped is said whatever follows: a database that was emptied must never read as
// "cancelled: nothing to do".
async function runFresh(job) {
  const { label, print } = job;
  const { directory, isDryRun } = job.selection;
  const { files, database } = await migrateFresh({ directory, isDryRun, ...createEvents(job) });
  const total = countFiles(files, UP, MIGRATION_TYPE.MIGRATION);

  if (isDryRun) {
    print(`⏳ ${label} would drop: the database "${database}" with everything in it`);
    files.forEach((file) => print(`⏳ ${label} would run: ${file}`));
    print(`🎉 ${label} dry run: the database would be dropped and ${total} would run`);
  } else {
    print(`🎉 ${label} succeeded: the database "${database}" was dropped and ${total} done; seeds are applied apart`);
  }

  return EXIT_OK;
}

function formatStatus(item) {
  const details = [
    STATE_TEXTS[item.state],
    item.batch !== null && `batch ${item.batch}`,
    item.batch !== null && toUtcIso(item.appliedAt),
    item.durationMs !== null && `${item.durationMs} ms`,
  ];

  return `${STATE_MARKS[item.state]} ${item.id}: ${details.filter(Boolean).join(', ')}`;
}

async function runStatus({ selection, label, print }) {
  const items = await getMigrationStatus({ directory: selection.directory, type: selection.type });

  if (!items.length) {
    print(`⚠️ ${label} status: nothing to show`);
  }

  items.forEach((item) => print(formatStatus(item)));

  return EXIT_OK;
}

async function runVerify(job) {
  const { label, print } = job;
  const {
    database, tableCount, differences, notes,
  } = await verifyMigrations({ directory: job.selection.directory, ...createEvents(job) });

  notes.forEach((note) => print(`⚠️ ${label} note: ${note}`));

  if (!differences.length) {
    print(`🎉 ${label} succeeded: "${database}" matches its migrations (${count(tableCount, 'table')})`);

    return EXIT_OK;
  }

  print(`❌ ${label} failed: "${database}" differs from its migrations`);
  differences.forEach((difference) => print(`   - ${difference}`));

  return EXIT_FAILED;
}

const COMMANDS = Object.freeze({
  [UP]: runUp,
  [DOWN]: runDown,
  [STATUS]: runStatus,
  [VERIFY]: runVerify,
  [FRESH]: runFresh,
});

function toProjectPath(path) {
  return nodePath.relative(absPath.root, path).split(nodePath.sep).join('/');
}

// Needs neither a database nor the environment: a clone without .env can make a migration.
async function runMake({ selection, label, print }) {
  const {
    names, type, directory, isDryRun,
  } = selection;

  if (!names) {
    throw new Error(`--names is required with --direction=${MAKE}: the names of the files to create`);
  }

  const paths = await makeMigrations({
    names, type, directory, isDryRun,
  });
  const verb = isDryRun
    ? 'would create'
    : 'created';

  paths.forEach((path) => print(`✅ ${label} ${verb}: ${toProjectPath(path)}`));

  return EXIT_OK;
}

// Where the run is going is said first: an environment may point at another server than the one meant.
function printTarget({ label, print }, config) {
  const {
    user, host, port, database,
  } = config.db;

  print(`⏳ ${label} target: ${user}@${host}:${port}/${database} (APP_MODE=${config.app.mode})`);
}

// The server is checked before anything is read or written on it; "fresh" may be refused before the database
// is looked for, and what it runs afterwards goes through connections that are each checked.
async function runCommand(job, config) {
  const db = createDb(config.db);
  const context = createContext({ config, log: createLogger({ level: LOG_LEVEL }), db });
  const { direction } = job.options;

  printTarget(job, config);

  try {
    if (direction !== FRESH) {
      await db.verify();
    }

    return await runInContext(context, () => COMMANDS[direction](job));
  } finally {
    await db.close();
  }
}

// The words of the database behind a 503 that a request would be answered with, in one line: of an error of
// the arguments, which Node writes in several, the first; of any other the whole, since the server and the
// lexer quote a piece of the file with its line breaks.
function describeError(error) {
  const text = findDbError(error)?.message ?? error.message;

  return String(error.code).startsWith(ARG_ERROR_PREFIX)
    ? text.split(LINE_BREAK)[0]
    : text.replaceAll(LINE_BREAKS_REGEXP, ' ').trim();
}

// Resolves with the exit code and never rejects: whatever went wrong is the last line it prints.
export async function runMigrate({
  readConfig,
  args = argv.slice(2),
  directory = MIGRATION_DIRECTORY,
  print = console.log,
} = {}) {
  let label = TYPE_LABELS[MIGRATION_TYPE.MIGRATION];

  try {
    const options = readOptions(args);
    const { direction, ...selection } = options;
    const job = {
      options,
      selection: { ...selection, directory },
      label: readLabel(options),
      print,
    };

    label = job.label;

    return direction === MAKE
      ? await runMake(job)
      : await runCommand(job, readConfig());
  } catch (error) {
    print(`❌ ${label} failed: ${describeError(error)}`);

    return EXIT_FAILED;
  }
}

if (import.meta.main) {
  process.exitCode = await runMigrate({ readConfig: () => createConfig(initEnv()) });
}
