import { createConfig } from '#config/index.js';
import { createTestConfig, createTestEnv } from '#root/tests/helper/config.js';
import { isDeepFrozen } from '#root/tests/helper/object.js';
import { convertStringToSeconds } from '#utils/date.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const DURATION_KEYS = [
  'connectTimeout',
  'statementTimeout',
  'slowQueryThreshold',
  'migrationLockTimeout',
  'migrationTableLockTimeout',
  'migrationIdleTimeout',
];

describe('config.db', () => {
  test('takes where the database is and who connects from env', () => {
    const config = createConfig(createTestEnv({
      APP_DATABASE_HOST: 'db.internal',
      APP_DATABASE_PORT: '3310',
      APP_DATABASE_NAME: 'app',
      APP_DATABASE_USER: 'app_user',
      APP_DATABASE_PASSWORD: 'app-password',
    }));

    assert.equal(config.db.host, 'db.internal');
    assert.equal(config.db.port, 3310);
    assert.equal(config.db.database, 'app');
    assert.equal(config.db.user, 'app_user');
    assert.equal(config.db.password, 'app-password');
  });

  test('keeps the sizes of the pool and the durations in the code, the durations as text with a unit', () => {
    const { db } = createConfig(createTestEnv());

    assert.ok(Number.isInteger(db.connectionLimit) && db.connectionLimit > 0);
    assert.ok(Number.isInteger(db.queueLimit) && db.queueLimit > 0);
    DURATION_KEYS.forEach((key) => assert.ok(convertStringToSeconds(db[key]) > 0, key));
    assert.ok(convertStringToSeconds(db.slowQueryThreshold) < convertStringToSeconds(db.statementTimeout));
  });

  test('is one flat frozen section: a test replaces a single value of it', () => {
    const { db } = createConfig(createTestEnv());
    const overridden = createTestConfig({ db: { connectionLimit: 1 } });

    assert.ok(isDeepFrozen(db));
    assert.equal(Object.values(db).every((value) => typeof value !== 'object'), true);
    assert.equal(overridden.db.connectionLimit, 1);
    assert.equal(overridden.db.queueLimit, db.queueLimit);
    assert.equal(overridden.db.statementTimeout, db.statementTimeout);
  });
});
