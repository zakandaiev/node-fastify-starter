import { readArgs } from '#config/arg.js';
import { initEnv, MODE } from '#config/env.js';
import { createConfig } from '#config/index.js';
import { absPath, resolvePath } from '#config/path.js';
import { buildApp } from '#root/src/app.js';
import { writeFile } from 'node:fs/promises';
import nodePath from 'node:path';

const JSON_INDENT = 2;

// The lines of the plugins at start would only clutter the output of the script.
const LOG_LEVEL = 'warn';

// The docs exist in dev mode only, whatever the mode of the environment: the spec is built from a dev config.
// buildApp() opens no connection, so no service has to be up.
export async function renderOpenapi(env) {
  const config = createConfig({ ...env, APP_MODE: MODE.DEV });
  const fastify = await buildApp({ config: { ...config, logger: { ...config.logger, level: LOG_LEVEL } } });

  try {
    await fastify.ready();

    return `${JSON.stringify(fastify.swagger(), null, JSON_INDENT)}\n`;
  } finally {
    await fastify.close();
  }
}

export function resolveOutputPath(output = absPath.openapi) {
  return resolvePath(output);
}

if (import.meta.main) {
  const path = resolveOutputPath(readArgs(['output']).output);

  await writeFile(path, await renderOpenapi(initEnv()));

  console.log(`✅ ${nodePath.relative(absPath.root, path)} is written`);
}
