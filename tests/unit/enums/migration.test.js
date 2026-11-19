import { CHARSET, COLLATION } from '#enums/collation.js';
import { MIGRATION_DIRECTION } from '#enums/migration-direction.js';
import { MIGRATION_STATE } from '#enums/migration-state.js';
import { MIGRATION_TYPE } from '#enums/migration-type.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('COLLATION', () => {
  test('names the two collations a text column may have: of a machine string and of a text for a person', () => {
    assert.deepEqual(COLLATION, { MACHINE: 'utf8mb4_bin', HUMAN: 'utf8mb4_uca1400_ai_ci' });
    assert.ok(Object.isFrozen(COLLATION));
  });

  test('both belong to the one charset of every text column', () => {
    assert.equal(CHARSET, 'utf8mb4');
    Object.values(COLLATION).forEach((collation) => assert.ok(collation.startsWith(`${CHARSET}_`), collation));
  });
});

describe('MIGRATION_STATE', () => {
  test('names the states a migration is shown in, each name being its value in upper case', () => {
    assert.deepEqual(Object.values(MIGRATION_STATE), ['pending', 'applied', 'running', 'dirty', 'changed', 'missing']);
    assert.ok(Object.isFrozen(MIGRATION_STATE));
    Object.entries(MIGRATION_STATE).forEach(([name, state]) => assert.equal(name, state.toUpperCase()));
  });
});

describe('MIGRATION_TYPE', () => {
  test('names the two kinds of files the migrator runs, as the type column stores them', () => {
    assert.deepEqual(MIGRATION_TYPE, { MIGRATION: 'migration', SEED: 'seed' });
    assert.ok(Object.isFrozen(MIGRATION_TYPE));
  });
});

describe('MIGRATION_DIRECTION', () => {
  test('names what --direction takes, each name being its value in upper case', () => {
    assert.deepEqual(Object.values(MIGRATION_DIRECTION), ['up', 'down', 'status', 'make', 'verify', 'fresh']);
    assert.ok(Object.isFrozen(MIGRATION_DIRECTION));
    Object.entries(MIGRATION_DIRECTION).forEach(([name, direction]) => assert.equal(name, direction.toUpperCase()));
  });
});
