import { initEnv, isCi, readSystemEnv } from '#config/env.js';
import { stdout } from 'node:process';

stdout.write(JSON.stringify({
  env: initEnv(),
  systemKeys: Object.keys(readSystemEnv()),
  isCi: isCi(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}));
