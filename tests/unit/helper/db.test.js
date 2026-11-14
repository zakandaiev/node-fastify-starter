import { DbError } from '#core/db/error.js';
import { createDatabaseName, createDownDb, createDownEnv } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { createWorkDir, runNode } from '#root/tests/helper/process.js';
import { isPortOpen } from '#root/tests/helper/service.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const RUN_DATABASE_SUITE = 'tests/fixture/run-database-suite.js';

describe('createDatabaseName', () => {
  test('is the prefix of the tests and a UUIDv7 with underscores', () => {
    const name = createDatabaseName('019a0000-0000-7000-8000-000000000001');

    assert.equal(name, 'nfs_test_019a0000_0000_7000_8000_000000000001');
    assert.match(createDatabaseName(), /^nfs_test_[0-9a-f]{8}_[0-9a-f]{4}_7[0-9a-f]{3}_[0-9a-f]{4}_[0-9a-f]{12}$/);
    assert.notEqual(createDatabaseName(), createDatabaseName());
  });
});

describe('createDownEnv', () => {
  test('is the address of a port on loopback that nothing listens on', async () => {
    const env = await createDownEnv();

    assert.deepEqual(Object.keys(env), ['APP_DATABASE_HOST', 'APP_DATABASE_PORT']);
    assert.equal(env.APP_DATABASE_HOST, '127.0.0.1');
    assert.equal(await isPortOpen({ host: env.APP_DATABASE_HOST, port: Number(env.APP_DATABASE_PORT) }), false);
  });
});

describe('createDownDb', () => {
  test('gives a pool whose statements fail with the error of the connection, and the context to run them in', async (t) => {
    const down = await createDownDb(t);

    await assert.rejects(
      down.run(() => down.db.query('SELECT 1')),
      (error) => error instanceof DbError && error.code === 'ECONNREFUSED',
    );
    assert.equal(down.context.db, down.db);
    assert.equal(down.config.logger.level, 'silent');
  });

  test('takes the sections of the config: the size of the pool, a log sink', async (t) => {
    const sink = createLogSink();
    const down = await createDownDb(t, { db: { connectionLimit: 1 }, logger: { level: 'info', stream: sink.stream } });

    down.context.log.info('written');

    assert.equal(down.db.getStats().connectionLimit, 1);
    assert.deepEqual(sink.lines.map((line) => line.msg), ['written']);
  });
});

describe('createTestDb without MariaDB', () => {
  test('skips the suites of the file and shows the skip in the totals of the run; in CI the file fails instead', async (t) => {
    const cwd = await createWorkDir(t);
    const env = await createDownEnv();
    const [inCi, locally] = await Promise.all(
      ['true', ''].map((CI) => runNode(RUN_DATABASE_SUITE, { cwd, env: { ...env, CI } })),
    );

    assert.equal(inCi.code, 1);
    assert.match(`${inCi.stdout}${inCi.stderr}`, /must not be skipped here, but mariadb not reachable/);
    assert.equal(locally.code, 0);
    assert.match(locally.stdout, /mariadb not reachable: start the local services/);
    assert.match(locally.stdout, /^ℹ skipped 1$/m);
    assert.match(locally.stdout, /^ℹ fail 0$/m);
  });
});
