import { createLogger } from '#core/logger/index.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('createLogger', () => {
  test('requires a level', () => {
    assert.throws(() => createLogger(), /requires a log level/);
    assert.throws(() => createLogger({}), /requires a log level/);
  });

  test('rejects a level pino does not know', () => {
    assert.throws(() => createLogger({ level: 'loud' }));
  });

  test('creates a pino logger with the given level', () => {
    const logger = createLogger({ level: 'warn' });

    assert.equal(logger.level, 'warn');
    assert.equal(logger.isLevelEnabled('info'), false);
    assert.equal(logger.isLevelEnabled('error'), true);
    assert.equal(typeof logger.child, 'function');
  });

  test('creates separate instances', () => {
    assert.notEqual(createLogger({ level: 'silent' }), createLogger({ level: 'silent' }));
  });
});
