import { buildApp } from '#root/src/app.js';
import { createTestConfig } from '#root/tests/helper/config.js';

export function buildTestApp(overrides) {
  return buildApp({ config: createTestConfig(overrides) });
}
