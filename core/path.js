import nodePath from 'node:path';
import { cwd } from 'node:process';

const pathCore = './core';
const pathNodeModules = './node_modules';
const pathPublic = './public';
const pathSrc = './src';

const absPath = {
  root: nodePath.resolve(cwd()),
  core: nodePath.resolve(cwd(), pathCore),
  nodeModules: nodePath.resolve(cwd(), pathNodeModules),
  public: nodePath.resolve(cwd(), pathPublic),
  src: nodePath.resolve(cwd(), pathSrc),
  controller: nodePath.resolve(cwd(), pathSrc, 'controller'),
  migration: nodePath.resolve(cwd(), pathSrc, 'migration'),
  model: nodePath.resolve(cwd(), pathSrc, 'model'),
  plugin: nodePath.resolve(cwd(), pathSrc, 'plugin'),
  router: nodePath.resolve(cwd(), pathSrc, 'router'),
  schema: nodePath.resolve(cwd(), pathSrc, 'schema'),
  seed: nodePath.resolve(cwd(), pathSrc, 'migration', 'seed'),
  util: nodePath.resolve(cwd(), pathSrc, 'util'),
};

function joinPath(...args) {
  return nodePath.join(...args);
}

function resolvePath(...args) {
  return nodePath.resolve(cwd(), ...args);
}

export {
  absPath,
  joinPath,
  pathCore,
  pathNodeModules,
  pathPublic,
  pathSrc,
  resolvePath,
};
