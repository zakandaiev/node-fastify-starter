import { absPath } from '#config/path.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { isFunction, isString } from '#utils/type.js';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import nodePath from 'node:path';
import { before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

// What fastify-plugin leaves on the function it is given.
const META_KEY = Symbol.for('plugin-meta');
const SKIP_OVERRIDE_KEY = Symbol.for('skip-override');

// The name fastify-plugin makes up for a plugin that is given none.
const MADE_UP_NAME_REGEXP = /-auto-\d+$/;
const NAME_REGEXP = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const PLUGIN_EXTENSION = '.js';
const IGNORED_PREFIX = '_';

function isLoaded(file) {
  return file.endsWith(PLUGIN_EXTENSION)
    && !file.split(nodePath.sep).some((segment) => segment.startsWith(IGNORED_PREFIX));
}

async function readPlugin(file) {
  const { default: plugin } = await import(pathToFileURL(nodePath.join(absPath.plugin, file)).href);

  return { file, plugin, name: plugin?.[META_KEY]?.name };
}

// The files autoload takes: it leaves out every path with an entry that starts with "_".
async function readPlugins() {
  const files = await readdir(absPath.plugin, { recursive: true });

  return Promise.all(files.filter((file) => isLoaded(file)).map((file) => readPlugin(file)));
}

function hasOwnName({ name }) {
  return isString(name) && NAME_REGEXP.test(name) && !MADE_UP_NAME_REGEXP.test(name);
}

function listFiles(plugins) {
  return plugins.map(({ file }) => file);
}

describe('every file of src/plugins', () => {
  let plugins;

  before(async () => {
    plugins = await readPlugins();
  });

  test('exports a function that fastify-plugin has wrapped and left open: its decorators and hooks reach the app', () => {
    assert.ok(plugins.length > 0);
    assert.deepEqual(listFiles(plugins.filter(({ plugin }) => !isFunction(plugin) || plugin[SKIP_OVERRIDE_KEY] !== true)), []);
  });

  test('gives its plugin a name, not one fastify-plugin makes up', () => {
    assert.deepEqual(listFiles(plugins.filter((plugin) => !hasOwnName(plugin))), []);
  });

  // Autoload keeps the plugins in a map by name: of two that share one the app loads a single one, without a word.
  test('gives its plugin a name that no other has', () => {
    const shared = Object.entries(Object.groupBy(plugins, ({ name }) => name))
      .filter(([, sharing]) => sharing.length > 1)
      .map(([name, sharing]) => [name, listFiles(sharing)]);

    assert.deepEqual(shared, []);
  });

  test('is loaded into the app under that name', async (t) => {
    const fastify = await buildTestApp();

    t.after(() => fastify.close());

    assert.deepEqual(listFiles(plugins.filter(({ name }) => !fastify.hasPlugin(name))), []);
  });
});
