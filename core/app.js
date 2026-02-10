import packageData from '#root/package.json' with { type: 'json' };
import dotenv from 'dotenv';
import minimist from 'minimist';
import { argv, env } from 'node:process';

dotenv.config({
  path: ['.env', '.env.local'],
  override: true,
  quiet: true,
});

const processArg = minimist(argv.slice(2));

const appData = {
  APP_MODE: 'local',

  APP_NAME: packageData.name,
  APP_NAME_FORMATTED: packageData.name.replace(/[^a-z]+/gi, ' ').replace(/(^\w|\s\w)/g, (m) => m.toUpperCase()),

  APP_VERSION: packageData.version,
  APP_AUTHOR: packageData.author,
  APP_AUTHOR_URL: packageData.authorUrl,
  APP_REPOSITORY: packageData.repository?.url,

  APP_DESCRIPTION: packageData.description,
  APP_KEYWORDS: packageData.keywords,
};

const envData = {};
Object.keys(env).forEach((key) => {
  if (key.startsWith('APP_')) {
    envData[key] = env[key];
  }
});

const replaceData = {
  ...appData,
  ...envData,
};

export {
  appData,
  envData,
  packageData,
  processArg,
  replaceData,
};
