import nodePath from 'node:path';
import { cwd } from 'node:process';

export const pathCore = './core';
export const pathNodeModules = './node_modules';
export const pathPublic = './public';
export const pathSrc = './src';
export const pathUpload = './upload';

export const absPath = {
  root: nodePath.resolve(cwd()),
  core: nodePath.resolve(cwd(), pathCore),
  nodeModules: nodePath.resolve(cwd(), pathNodeModules),
  public: nodePath.resolve(cwd(), pathPublic),
  src: nodePath.resolve(cwd(), pathSrc),
  upload: nodePath.resolve(cwd(), pathUpload),
  controller: nodePath.resolve(cwd(), pathSrc, 'controller'),
  migration: nodePath.resolve(cwd(), pathSrc, 'migration'),
  model: nodePath.resolve(cwd(), pathSrc, 'model'),
  plugin: nodePath.resolve(cwd(), pathSrc, 'plugin'),
  router: nodePath.resolve(cwd(), pathSrc, 'router'),
  schema: nodePath.resolve(cwd(), pathSrc, 'schema'),
  service: nodePath.resolve(cwd(), pathSrc, 'service'),
  seed: nodePath.resolve(cwd(), pathSrc, 'migration', 'seed'),
  util: nodePath.resolve(cwd(), pathSrc, 'util'),
};

export function joinPath(...args) {
  return nodePath.join(...args);
}

export function resolvePath(...args) {
  return nodePath.resolve(cwd(), ...args);
}
