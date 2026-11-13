import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import globals from 'globals';
import nodePath from 'node:path';

const ROOT = import.meta.dirname;

const compat = new FlatCompat({
  baseDirectory: ROOT,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

const JS_FILES = '*.{js,cjs,mjs}';

export const ALIAS_MAP = [
  ['#root', './'],
  ['#config', './src/config'],
  ['#core', './src/core'],
  ['#enums', './src/enums'],
  ['#modules', './src/modules'],
  ['#schemas', './src/schemas'],
  ['#utils', './src/utils'],
];

const COMMONJS_GLOBALS = Object.fromEntries(
  ['require', 'module', 'exports', '__dirname', '__filename'].map((name) => [name, 'off']),
);

const ENV_MESSAGE = 'process.env belongs to src/config/env.js only: read values from config (fastify.config or the context).';

const AIRBNB_RESTRICTED_SYNTAX = [
  {
    selector: 'ForInStatement',
    message: 'for..in loops iterate over the entire prototype chain, which is virtually never what you want. Use Object.{keys,values,entries}, and iterate over the resulting array.',
  },
  {
    selector: 'ForOfStatement',
    message: 'iterators/generators require regenerator-runtime, which is too heavyweight for this guide to allow them. Separately, loops should be avoided in favor of array iterations.',
  },
  {
    selector: 'LabeledStatement',
    message: 'Labels are a form of GOTO; using them makes code confusing and hard to maintain and understand.',
  },
  {
    selector: 'WithStatement',
    message: '`with` is disallowed in strict mode because it makes code impossible to predict and optimize.',
  },
];

const ENV_RESTRICTED_SYNTAX = [
  'MemberExpression[object.name="process"][property.name="env"]',
  'MemberExpression[object.name="process"][property.value="env"]',
  'MemberExpression[object.property.name="process"][property.name="env"]',
  'VariableDeclarator[init.name="process"] > ObjectPattern > Property[key.name="env"]',
  'VariableDeclarator[init.property.name="process"] > ObjectPattern > Property[key.name="env"]',
  'AssignmentPattern[right.name="process"] > ObjectPattern > Property[key.name="env"]',
  'AssignmentExpression[right.name="process"] > ObjectPattern > Property[key.name="env"]',
  'ImportExpression[source.value=/^(node:)?process$/]',
].map((selector) => ({ selector, message: ENV_MESSAGE }));

const ENV_RESTRICTED_IMPORTS = ['node:process', 'process'].map((name) => ({
  name,
  importNames: ['env', 'default'],
  message: ENV_MESSAGE,
}));

const PARENT_IMPORT = {
  regex: '^\\.\\./',
  message: 'Import through an alias (#core/, #utils/, ...) instead of a parent-relative path.',
};

const ROOT_IMPORT = {
  regex: '^#root/',
  message: '#root/ is for scripts/ and tests/ only.',
};

const UTILS_LAYER = {
  regex: '^(?!node:|\\.{1,2}/|#utils/)',
  message: 'utils import only node:* and other utils.',
};

const CONFIG_LAYER = {
  regex: '^#(core|modules)/',
  message: 'config and enums sit below core: they must not import core or modules.',
};

const CORE_LAYER = {
  regex: '^#modules/',
  message: 'core must not import modules.',
};

function toDynamicImport({ regex, message }) {
  return {
    selector: `ImportExpression[source.value=/${regex.replaceAll('/', '\\x2F')}/]`,
    message,
  };
}

function restrictImports(patterns = [], options = {}) {
  const { syntax = [...AIRBNB_RESTRICTED_SYNTAX, ...ENV_RESTRICTED_SYNTAX], paths = ENV_RESTRICTED_IMPORTS } = options;
  const allPatterns = [PARENT_IMPORT, ...patterns];

  return {
    'no-restricted-imports': ['error', { paths, patterns: allPatterns }],
    'no-restricted-syntax': ['error', ...syntax, ...allPatterns.map(toDynamicImport)],
  };
}

export default [
  {
    ignores: [
      'coverage',
      'node_modules',
      'public',
      'upload',
    ],
  },
  ...compat.extends('airbnb-base'),
  {
    files: [`**/${JS_FILES}`],

    languageOptions: {
      globals: {
        ...globals.node,
        ...COMMONJS_GLOBALS,
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },

    settings: {
      'import/resolver': {
        alias: {
          map: ALIAS_MAP.map(([alias, target]) => [alias, nodePath.resolve(ROOT, target)]),
        },
      },
    },

    rules: {
      'consistent-return': 0,
      'import/extensions': 0,
      'import/no-extraneous-dependencies': 0,
      'import/order': 0,
      'import/prefer-default-export': 0,
      'max-len': 0,
      'no-param-reassign': 0,
      'no-unneeded-ternary': 0,
      'no-use-before-define': 0,

      'import/enforce-node-protocol-usage': ['error', 'always'],
      'no-console': 'error',
      ...restrictImports(),
    },
  },
  {
    files: [`src/**/${JS_FILES}`],
    rules: restrictImports([ROOT_IMPORT]),
  },
  {
    files: [`src/utils/**/${JS_FILES}`],
    rules: restrictImports([UTILS_LAYER]),
  },
  {
    files: [`src/{config,enums}/**/${JS_FILES}`],
    rules: restrictImports([ROOT_IMPORT, CONFIG_LAYER]),
  },
  {
    files: [`src/core/**/${JS_FILES}`],
    rules: restrictImports([ROOT_IMPORT, CORE_LAYER]),
  },
  {
    files: ['src/config/env.js'],
    rules: restrictImports([ROOT_IMPORT, CONFIG_LAYER], { syntax: AIRBNB_RESTRICTED_SYNTAX, paths: [] }),
  },
  {
    files: [`scripts/**/${JS_FILES}`],
    rules: {
      'no-console': 0,
    },
  },
];
