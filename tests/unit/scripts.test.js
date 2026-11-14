import { parseEnv } from '#config/env.js';
import { resolvePath } from '#config/path.js';
import { renderApiIndex } from '#root/scripts/api-index.js';
import { TEST_ENV } from '#root/tests/helper/config.js';
import { runNode } from '#root/tests/helper/process.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    assert.ok(index.includes('## #core/context/index.js\n\n- `createContext({ config, log, db = null, redis = null, cacheRedis = null, requestId = null } = {})`\n- `getContext()`\n- `runInContext(context, fn)`\n'));
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
