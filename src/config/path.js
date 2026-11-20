import nodePath from 'node:path';

const ROOT = nodePath.resolve(import.meta.dirname, '../..');

export const absPath = Object.freeze({
  root: ROOT,
  src: nodePath.join(ROOT, 'src'),
  core: nodePath.join(ROOT, 'src/core'),
  util: nodePath.join(ROOT, 'src/utils'),
  schema: nodePath.join(ROOT, 'src/schemas'),
  plugin: nodePath.join(ROOT, 'src/plugins'),
  route: nodePath.join(ROOT, 'src/routes'),
  migration: nodePath.join(ROOT, 'migrations'),
  upload: nodePath.join(ROOT, 'upload'),
  openapi: nodePath.join(ROOT, 'openapi.json'),
});

export function resolvePath(...segments) {
  return nodePath.resolve(ROOT, ...segments);
}
