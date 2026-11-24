import { parseEnv } from '#config/env.js';
import { resolvePath } from '#config/path.js';
import { runAlertTest } from '#root/scripts/alert-test.js';
import { renderApiIndex } from '#root/scripts/api-index.js';
import { runMigrate } from '#root/scripts/migrate.js';
import { accept, createAlertReceiver, readBlock } from '#root/tests/helper/alert.js';
import { createTestConfig, TEST_ENV } from '#root/tests/helper/config.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { createMigrationDir, describeTarget } from '#root/tests/helper/migration.js';
import { createWorkDir, runNode } from '#root/tests/helper/process.js';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { describe, test } from 'node:test';

const FIXTURE_SOURCES = [{ alias: '#fixture', directory: resolvePath('tests/fixture/api-index') }];

const FIXTURE_SECTION = [
  '## #fixture/sample.js',
  '',
  '- `LIMIT`',
  '- `class Sample`',
  '- `format(value, { prefix = \'(\', suffix = \')\' } = {})`',
  '- `async load({ id, isActive = true } = {}, ...rest)`',
  '- `async *stream(source)`',
  '- `*walk(items)`',
  '',
].join('\n');

const ALERT_TEST = 'scripts/alert-test.js';
const ALERT_TEST_MESSAGE = 'A manual test (npm run alert:test): this process reaches the channels of alerts';
const ALERT_TEST_START_LINE = '⏳ Alert test sends to: webhook (APP_MODE=prod)';

describe('keygen', () => {
  test('prints a new secret that env accepts', async () => {
    const [first, second] = await Promise.all([runNode('scripts/keygen.js'), runNode('scripts/keygen.js')]);
    const secret = first.stdout.trim();

    assert.equal(first.code, 0);
    assert.match(secret, /^[A-Za-z0-9_-]{64}$/);
    assert.notEqual(secret, second.stdout.trim());
    assert.equal(parseEnv({ ...TEST_ENV, APP_JWT_ACCESS_SECRET: secret }).APP_JWT_ACCESS_SECRET, secret);
  });
});

describe('api-index', () => {
  test('lists the exports of core with their signatures', async () => {
    const index = await renderApiIndex();

    assert.match(index, /^# Core API\n/);
    assert.ok(index.includes('## #core/context/index.js\n\n- `createContext({ config, log, db = null, redis = null, cacheRedis = null, requestId = null, transaction = null } = {})`\n- `findContext()`\n- `getContext()`\n- `runInContext(context, fn)`\n- `runOutsideContext(fn)`\n'));
    assert.ok(index.includes('## #core/logger/index.js\n\n- `createLogger({ level, isPretty = false, stream } = {})`\n- `serializeError(error)`\n'));
  });

  test('describes constants, classes, async functions and generators, and skips a module without exports', async () => {
    const index = await renderApiIndex(FIXTURE_SOURCES);

    assert.ok(index.endsWith(`\n\n${FIXTURE_SECTION}`));
    assert.equal(index.includes('#fixture/empty.js'), false);
  });

  test('matches docs/CORE-API.md: run "npm run api:index" after changing an export', async () => {
    assert.equal(await renderApiIndex(), await readFile(resolvePath('docs/CORE-API.md'), 'utf8'));
  });
});

describe('migrate: what needs no database', () => {
  // The lines the script prints and the code it would exit with; "env" puts the database out of reach.
  async function migrate(args, { directory, env = {} } = {}) {
    const lines = [];
    const code = await runMigrate({
      readConfig: () => createTestConfig({ env }),
      args,
      directory,
      print: (line) => lines.push(line),
    });

    return { code, lines };
  }

  test('refuses a run without a direction, with an unknown one or with an argument it does not know, in one line', async () => {
    assert.deepEqual(await migrate([]), {
      code: 1,
      lines: ['❌ Migration failed: --direction is required: one of up, down, status, make, verify, fresh'],
    });
    assert.deepEqual(await migrate(['--direction=sideways']), {
      code: 1,
      lines: ['❌ Migration failed: --direction must be one of: up, down, status, make, verify, fresh'],
    });
    assert.deepEqual(await migrate(['--direction=up', '--force']), {
      code: 1,
      lines: ["❌ Migration failed: Unknown option '--force'"],
    });
    assert.deepEqual(await migrate(['--direction=up', '--names', '--dry-run']), {
      code: 1,
      lines: ["❌ Migration failed: Option '--names' argument is ambiguous."],
    });
    assert.deepEqual(await migrate(['--direction=status', '--direction=down']), {
      code: 1,
      lines: ['❌ Migration failed: --direction is given twice: status, down'],
    });
  });

  test('refuses an argument that would do nothing for the direction, instead of passing it over', async () => {
    const cases = [
      [['--direction=status', '--dry-run'], '--dry-run does not go with --direction=status'],
      [['--direction=status', '--names=users'], '--names does not go with --direction=status'],
      [['--direction=verify', '--type=seed'], '--type does not go with --direction=verify'],
      [['--direction=verify', '--dry-run'], '--dry-run does not go with --direction=verify'],
      [['--direction=fresh', '--names=users'], '--names does not go with --direction=fresh'],
      [['--direction=fresh', '--type=seed'], '--type does not go with --direction=fresh'],
      [['--direction=make', '--names=users', '--names-exclude=groups'], '--names-exclude does not go with --direction=make'],
    ];
    const results = await Promise.all(cases.map(([args]) => migrate(args)));

    assert.deepEqual(results, cases.map(([, message]) => ({ code: 1, lines: [`❌ Migration failed: ${message}`] })));
  });

  test('makes a pair of empty files for every name and tells where they are', async (t) => {
    const directory = await createMigrationDir(t);
    const made = await migrate(['--direction=make', '--names=users,sessions'], { directory });
    const seeded = await migrate(['--direction=make', '--type=seed', '--names', 'groups'], { directory });

    assert.equal(made.code, 0);
    assert.deepEqual(made.lines.map((line) => line.replace(/created: .*\//, 'created: ')), [
      '✅ Migration created: 0001_users.up.sql',
      '✅ Migration created: 0001_users.down.sql',
      '✅ Migration created: 0002_sessions.up.sql',
      '✅ Migration created: 0002_sessions.down.sql',
    ]);
    assert.deepEqual(seeded.lines.map((line) => line.replace(/created: .*\//, 'created: ')), [
      '✅ Seed created: 0001_groups.up.sql',
      '✅ Seed created: 0001_groups.down.sql',
    ]);
    assert.deepEqual((await readdir(directory)).toSorted(), [
      '0001_users.down.sql',
      '0001_users.up.sql',
      '0002_sessions.down.sql',
      '0002_sessions.up.sql',
      'seed',
    ]);
    assert.deepEqual(await readdir(nodePath.join(directory, 'seed')), ['0001_groups.down.sql', '0001_groups.up.sql']);
  });

  test('names the files it would make on a dry run, and refuses to make without a name or with a taken one', async (t) => {
    const directory = await createMigrationDir(t, { '0001_users.up.sql': '' });
    const dry = await migrate(['--direction=make', '--names=sessions', '--dry-run'], { directory });

    assert.equal(dry.code, 0);
    assert.deepEqual(dry.lines.map((line) => line.replace(/would create: .*\//, 'would create: ')), [
      '✅ Migration would create: 0002_sessions.up.sql',
      '✅ Migration would create: 0002_sessions.down.sql',
    ]);
    assert.deepEqual(await migrate(['--direction=make'], { directory }), {
      code: 1,
      lines: ['❌ Migration failed: --names is required with --direction=make: the names of the files to create'],
    });
    assert.deepEqual(await migrate(['--direction=make', '--names=users'], { directory }), {
      code: 1,
      lines: ['❌ Migration failed: A migration named "users" exists already: --names tells migrations apart by it'],
    });
    assert.deepEqual(await readdir(directory), ['0001_users.up.sql']);
  });

  test('makes a migration without the config: a clone that has no .env yet can make one', async () => {
    const lines = [];
    const code = await runMigrate({
      readConfig: () => assert.fail('The config must not be read to make a file'),
      args: ['--direction=make', '--names=never_made_by_this_test', '--dry-run'],
      print: (line) => lines.push(line),
    });

    assert.equal(code, 0);
    assert.match(lines[0], /^✅ Migration would create: migrations\/mariadb\/\d{4}_never_made_by_this_test\.up\.sql$/);
  });

  test('says where it is going before anything else, then refuses "fresh" outside dev mode without looking for the database', async (t) => {
    const directory = await createMigrationDir(t);
    const env = await createDownEnv();
    const { code, lines } = await migrate(['--direction=fresh'], { directory, env });

    assert.equal(code, 1);
    assert.deepEqual(lines, [
      describeTarget('Fresh', createTestConfig({ env })),
      '❌ Fresh failed: "fresh" drops the database "nfs_test" with everything in it: it runs only when APP_MODE=dev',
    ]);
  });

  test('fails with the error of the connection, and with the code 1, when the database is out of reach', async (t) => {
    const directory = await createMigrationDir(t, { '0001_users.up.sql': 'CREATE TABLE users (id INT);\n' });
    const env = await createDownEnv();
    const dev = { ...env, APP_MODE: 'dev' };
    const runs = [
      { label: 'Migration', args: ['--direction=up'], env },
      { label: 'Migration', args: ['--direction=status'], env },
      { label: 'Verify', args: ['--direction=verify'], env },
      { label: 'Fresh', args: ['--direction=fresh'], env: dev },
    ];
    const results = await Promise.all(runs.map((run) => migrate(run.args, { directory, env: run.env })));

    assert.deepEqual(results, runs.map((run) => ({
      code: 1,
      lines: [
        describeTarget(run.label, createTestConfig({ env: run.env })),
        `❌ ${run.label} failed: connect ECONNREFUSED 127.0.0.1:${env.APP_DATABASE_PORT}`,
      ],
    })));
  });

  test('fails with one line when the config cannot be read', async () => {
    const lines = [];
    const code = await runMigrate({
      readConfig: () => {
        throw new Error('Invalid environment variables');
      },
      args: ['--direction=status'],
      print: (line) => lines.push(line),
    });

    assert.deepEqual([code, lines], [1, ['❌ Migration failed: Invalid environment variables']]);
  });
});

// The context of the script has no Redis: its throttle lives in the memory of the process, and a second message
// of this process within the silent window is held back. A test that sends again starts a process of its own.
describe('alert-test', () => {
  async function alertTest(readConfig) {
    const lines = [];
    const code = await runAlertTest({ readConfig, print: (line) => lines.push(line) });

    return { code, lines };
  }

  async function runAlertTestProcess(t, receiver, env = receiver.env.webhook) {
    const cwd = await createWorkDir(t, { ...TEST_ENV, ...env });
    const { code, stdout, stderr } = await runNode(ALERT_TEST, { cwd });
    const lines = stdout.split('\n').filter(Boolean);

    return {
      code,
      stderr,
      stdout,
      printed: lines.filter((line) => !line.startsWith('{')),
      logged: lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)),
    };
  }

  test('fails with one line and the code 1 when no channel has its settings', async () => {
    assert.deepEqual(await alertTest(() => createTestConfig()), {
      code: 1,
      lines: ['❌ Alert test failed: no channel has its settings, set one of the APP_ALERT_* variables'],
    });
  });

  test('sends one silent message titled "Alert test" to the webhook and resolves 0 once it is delivered', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const result = await alertTest(() => createTestConfig({ env: receiver.env.webhook }));

    assert.deepEqual(result, { code: 0, lines: [ALERT_TEST_START_LINE, '✅ Alert test: webhook delivered'] });
    assert.equal(receiver.requests.length, 1);

    const [{ method, path, body }] = receiver.requests;

    assert.equal(method, 'POST');
    assert.equal(path, receiver.paths.webhook);
    assert.equal(body.title, 'Alert test');
    assert.equal(body.isSilent, true);
    assert.equal(body.throttleClass, 'silent');
    assert.equal(body.space, 'internal');
    assert.deepEqual(readBlock(body, 'Error'), { message: ALERT_TEST_MESSAGE });
  });

  test('fails with one line and the code 1 when the config cannot be read', async () => {
    const result = await alertTest(() => {
      throw new Error('Invalid environment variables');
    });

    assert.deepEqual(result, { code: 1, lines: ['❌ Alert test failed: Invalid environment variables'] });
  });

  test('as a process: reads the .env of its directory, sends, and exits with 0 once the webhook has the message', async (t) => {
    const receiver = await createAlertReceiver(t, accept);
    const result = await runAlertTestProcess(t, receiver);

    assert.deepEqual([result.code, result.printed, result.logged, result.stderr], [
      0,
      [ALERT_TEST_START_LINE, '✅ Alert test: webhook delivered'],
      [],
      '',
    ]);
    assert.deepEqual(receiver.requests.map((request) => [request.body.title, request.body.isSilent]), [['Alert test', true]]);
  });

  test('as a process: exits with 1 and a "not delivered (failed)" line when the receiver answers 500, and logs why without the secret path', async (t) => {
    const receiver = await createAlertReceiver(t, () => ({ status: 500 }));
    const result = await runAlertTestProcess(t, receiver);
    const [notDelivered] = result.logged.filter((line) => line.msg === 'Alert not delivered');

    assert.equal(result.code, 1);
    assert.deepEqual(result.printed, [ALERT_TEST_START_LINE, '❌ Alert test: webhook not delivered (failed)']);
    assert.equal(receiver.requests.length, 1);
    assert.equal(notDelivered.alert.channel, 'webhook');
    assert.equal(notDelivered.alert.reason, 'failed');
    assert.equal(notDelivered.alert.status, 500);
    assert.equal(result.stdout.includes(receiver.paths.webhook), false);
    assert.equal(result.stderr, '');
  });

  test('as a process: prints a verdict for every channel, and exits with 1 when one of them was not delivered', async (t) => {
    const receiver = await createAlertReceiver(t, (request) => (request.path === receiver.paths.slack
      ? { status: 500 }
      : { status: 204 }));
    const result = await runAlertTestProcess(t, receiver, { ...receiver.env.webhook, ...receiver.env.slack });

    assert.equal(result.code, 1);
    assert.deepEqual(result.printed, [
      '⏳ Alert test sends to: webhook, slack (APP_MODE=prod)',
      '✅ Alert test: webhook delivered',
      '❌ Alert test: slack not delivered (failed)',
    ]);
    assert.deepEqual(receiver.requests.map((request) => request.path).toSorted(), [receiver.paths.slack, receiver.paths.webhook].toSorted());
  });
});
