import { absPath, resolvePath } from '#config/path.js';
import { ALIAS_MAP } from '#root/eslint.config.js';
import jsconfig from '#root/jsconfig.json' with { type: 'json' };
import packageData from '#root/package.json' with { type: 'json' };
import { ESLint } from 'eslint';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The files below do not exist, and both rules read the disk: import/no-cycle crashes on a missing file.
const eslint = new ESLint({
  cwd: absPath.root,
  overrideConfig: [{ rules: { 'import/no-cycle': 0, 'import/no-unresolved': 0 } }],
});

const USE = 'export const used = value;';
const ENV_IMPORT = `import { env as value } from 'node:process';\n\n${USE}`;

const GUARD_RULES = [
  'no-restricted-syntax',
  'no-restricted-imports',
  'no-console',
  'no-await-in-loop',
  'no-undef',
  'import/enforce-node-protocol-usage',
];

// One file for each block of eslint.config.js: a block replaces the options of the blocks before it.
const BLOCK_FILES = [
  'src/app.js',
  'src/utils/sample.js',
  'src/config/sample.js',
  'src/enums/sample.js',
  'src/core/sample.js',
  'src/modules/users/users.service.js',
  'scripts/sample.js',
  'tests/unit/sample.test.js',
];

async function lint(file, code) {
  const [result] = await eslint.lintText(`${code}\n`, { filePath: resolvePath(file) });
  const ruleIds = result.messages.map((message) => message.ruleId);

  assert.equal(ruleIds.includes(null), false, `${file} does not parse: ${result.messages[0]?.message}`);

  return [...new Set(ruleIds)].filter((ruleId) => GUARD_RULES.includes(ruleId));
}

function lintAll(files, code) {
  return Promise.all(files.map((file) => lint(file, code)));
}

function importFrom(source) {
  return `import value from '${source}';\n\n${USE}`;
}

function importLazily(source) {
  return `export function load() {\n  return import('${source}');\n}`;
}

describe('eslint: process.env', () => {
  test('is forbidden in every form', async () => {
    const codes = [
      'export const mode = process.env.APP_MODE;',
      'export const mode = process[\'env\'].APP_MODE;',
      'export const mode = globalThis.process.env.APP_MODE;',
      'const { env } = process;\n\nexport const mode = env.APP_MODE;',
      'const { env } = globalThis.process;\n\nexport const mode = env.APP_MODE;',
      'export function read({ env } = process) {\n  return env.APP_MODE;\n}',
      'export function read(source) {\n  let env = source;\n\n  ({ env } = process);\n\n  return env;\n}',
      importLazily('node:process'),
    ];
    const results = await Promise.all(codes.map((code) => lint('src/core/sample.js', code)));

    assert.deepEqual(results, codes.map(() => ['no-restricted-syntax']));
  });

  test('is forbidden in every block of the config', async () => {
    const code = 'export const mode = process.env.APP_MODE;';

    assert.deepEqual(await lintAll(BLOCK_FILES, code), BLOCK_FILES.map(() => ['no-restricted-syntax']));
    assert.deepEqual(await lintAll(BLOCK_FILES, ENV_IMPORT), BLOCK_FILES.map(() => ['no-restricted-imports']));
  });

  test('cannot be imported as the default, the namespace or from the bare module', async () => {
    const codes = [
      `import value from 'node:process';\n\n${USE}`,
      `import * as value from 'node:process';\n\n${USE}`,
    ];
    const results = await Promise.all(codes.map((code) => lint('src/core/sample.js', code)));

    assert.deepEqual(results, codes.map(() => ['no-restricted-imports']));
  });

  test('is allowed in src/config/env.js, and other imports from node:process everywhere', async () => {
    assert.deepEqual(await lint('src/config/env.js', 'export const mode = process.env.APP_MODE;'), []);
    assert.deepEqual(await lint('src/config/env.js', ENV_IMPORT), []);
    assert.deepEqual(await lint('src/core/sample.js', `import { argv as value } from 'node:process';\n\n${USE}`), []);
  });
});

describe('eslint: layers', () => {
  test('utils import only node:* and other utils', async () => {
    const forbidden = ['#core/context/index.js', '#config/path.js', '#enums/scope.js', '#schemas/index.js', '#modules/users/users.service.js', '#root/package.json', 'pino'];
    const allowed = ['#utils/type.js', 'node:crypto', './type.js'];

    assert.deepEqual(
      await Promise.all(forbidden.map((source) => lint('src/utils/sample.js', importFrom(source)))),
      forbidden.map(() => ['no-restricted-imports']),
    );
    assert.deepEqual(
      await Promise.all(forbidden.map((source) => lint('src/utils/sample.js', importLazily(source)))),
      forbidden.map(() => ['no-restricted-syntax']),
    );
    assert.deepEqual(
      await Promise.all(allowed.flatMap((source) => [importFrom(source), importLazily(source)]).map((code) => lint('src/utils/sample.js', code))),
      allowed.flatMap(() => [[], []]),
    );
  });

  test('core does not import modules', async () => {
    const source = '#modules/users/users.service.js';

    assert.deepEqual(await lint('src/core/db/sample.js', importFrom(source)), ['no-restricted-imports']);
    assert.deepEqual(await lint('src/core/db/sample.js', importLazily(source)), ['no-restricted-syntax']);
    assert.deepEqual(await lint('src/core/db/sample.js', importFrom('#utils/type.js')), []);
    assert.deepEqual(await lint('src/core/db/sample.js', importFrom('#config/path.js')), []);
  });

  test('config and enums do not import core or modules', async () => {
    const files = ['src/config/sample.js', 'src/config/env.js', 'src/enums/sample.js'];
    const sources = ['#core/context/index.js', '#modules/users/users.service.js'];
    const results = await Promise.all(sources.map((source) => lintAll(files, importFrom(source))));

    assert.deepEqual(results, sources.map(() => files.map(() => ['no-restricted-imports'])));
    assert.deepEqual(await lintAll(files, importFrom('#utils/type.js')), files.map(() => []));
  });

  test('modules import core, and nothing in src reaches routes through #root', async () => {
    const source = '#root/src/routes/v1/users/controller.js';

    assert.deepEqual(await lint('src/modules/users/users.service.js', importFrom('#core/context/index.js')), []);
    assert.deepEqual(await lint('src/modules/users/users.service.js', importFrom(source)), ['no-restricted-imports']);
    assert.deepEqual(await lint('src/modules/users/users.service.js', importLazily(source)), ['no-restricted-syntax']);
    assert.deepEqual(await lint('scripts/sample.js', importFrom('#root/src/app.js')), []);
    assert.deepEqual(await lint('tests/unit/sample.test.js', importFrom('#root/src/app.js')), []);
  });

  test('a parent-relative import is forbidden in every block, a sibling one is not', async () => {
    assert.deepEqual(await lintAll(BLOCK_FILES, importFrom('../sample.js')), BLOCK_FILES.map(() => ['no-restricted-imports']));
    assert.deepEqual(await lintAll(BLOCK_FILES, importLazily('../sample.js')), BLOCK_FILES.map(() => ['no-restricted-syntax']));
    assert.deepEqual(await lint('src/routes/v1/users/index.js', importFrom('./controller.js')), []);
  });
});

describe('eslint: style guards', () => {
  test('console is allowed only in scripts', async () => {
    const code = 'console.log(1);';

    assert.deepEqual(await lint('src/core/sample.js', code), ['no-console']);
    assert.deepEqual(await lint('tests/unit/sample.test.js', code), ['no-console']);
    assert.deepEqual(await lint('scripts/sample.js', code), []);
  });

  test('the airbnb loop restrictions survive the override of no-restricted-syntax in every block', async () => {
    const forOf = 'export function run(list) {\n  for (const item of list) {\n    item();\n  }\n}';
    const forIn = 'export function run(map) {\n  for (const key in map) {\n    map[key]();\n  }\n}';
    const awaitInLoop = 'export async function run(list) {\n  for (let i = 0; i < list.length; i += 1) {\n    await list[i]();\n  }\n}';
    const files = [...BLOCK_FILES, 'src/config/env.js'];

    assert.deepEqual(await lintAll(files, forOf), files.map(() => ['no-restricted-syntax']));
    assert.deepEqual(await lintAll(files, forIn), files.map(() => ['no-restricted-syntax']));
    assert.deepEqual(await lint('src/core/sample.js', awaitInLoop), ['no-await-in-loop']);
  });

  test('a built-in module needs the node: prefix', async () => {
    assert.deepEqual(
      await lintAll(['src/core/sample.js', 'scripts/sample.js', 'tests/unit/sample.test.js'], importFrom('fs')),
      [['import/enforce-node-protocol-usage'], ['import/enforce-node-protocol-usage'], ['import/enforce-node-protocol-usage']],
    );
    assert.deepEqual(await lint('src/core/sample.js', importFrom('node:fs/promises')), []);
  });

  test('CommonJS globals are undefined: every file is an ES module', async () => {
    const codes = ['export const directory = __dirname;', 'export const file = __filename;', 'module.exports = {};', 'export const load = require;'];
    const results = await Promise.all(codes.map((code) => lint('src/core/sample.js', code)));

    assert.deepEqual(results, codes.map(() => ['no-undef']));
    assert.deepEqual(await lint('src/core/sample.js', 'export const directory = import.meta.dirname;'), []);
  });
});

describe('aliases', () => {
  test('are the same in package.json, jsconfig.json and eslint.config.js', () => {
    const expected = Object.entries(packageData.imports);

    assert.deepEqual(
      Object.entries(jsconfig.compilerOptions.paths).map(([alias, [target]]) => [alias, target]),
      expected,
    );
    assert.deepEqual(
      ALIAS_MAP.map(([alias, target]) => [`${alias}/*`, `${target.replace(/\/$/, '')}/*`]),
      expected,
    );
  });

  test('jsconfig.json holds nothing but paths', () => {
    assert.deepEqual(Object.keys(jsconfig), ['compilerOptions']);
    assert.deepEqual(Object.keys(jsconfig.compilerOptions), ['paths']);
  });
});
