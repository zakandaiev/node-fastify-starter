import { absPath, resolvePath } from '#config/path.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import nodePath from 'node:path';
import { describe, test } from 'node:test';

describe('absPath', () => {
  test('is frozen and points at the project root, whatever the working directory', () => {
    assert.ok(Object.isFrozen(absPath));
    assert.ok(nodePath.isAbsolute(absPath.root));
    assert.ok(existsSync(nodePath.join(absPath.root, 'package.json')));
  });

  test('names the folders of the source tree', () => {
    assert.equal(absPath.src, nodePath.join(absPath.root, 'src'));
    assert.equal(absPath.core, nodePath.join(absPath.root, 'src', 'core'));
    assert.equal(absPath.util, nodePath.join(absPath.root, 'src', 'utils'));
    assert.equal(absPath.schema, nodePath.join(absPath.root, 'src', 'schemas'));
    assert.equal(absPath.plugin, nodePath.join(absPath.root, 'src', 'plugins'));
    assert.equal(absPath.route, nodePath.join(absPath.root, 'src', 'routes'));
    assert.equal(absPath.migration, nodePath.join(absPath.root, 'migrations'));
    assert.equal(absPath.upload, nodePath.join(absPath.root, 'upload'));
  });
});

describe('resolvePath', () => {
  test('resolves segments from the project root', () => {
    assert.equal(resolvePath(), absPath.root);
    assert.equal(resolvePath('src', 'app.js'), nodePath.join(absPath.root, 'src', 'app.js'));
    assert.equal(resolvePath('src/app.js'), nodePath.join(absPath.root, 'src', 'app.js'));
  });
});
